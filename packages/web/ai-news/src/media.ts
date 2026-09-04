/**
 * Cover-image cache: downloads remote covers into `media/<sha1(url)[:16]>.<ext>`
 * and hands back the served path. Failures are silent — the item keeps its
 * remote URL and renders best-effort.
 * @module @deepseek-ai/dsh-ai-news/media
 */

import { createHash } from 'node:crypto'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { CRAWL_USER_AGENT, type FetchOptions, type ProxyEndpoint, smartFetch } from './http.ts'

/** The URL prefix the media route serves. */
export const MEDIA_ROUTE_PREFIX = '/api/ai-news/media'

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
}

/** Valid cached file names (content-addressed, never user-supplied). */
export const MEDIA_FILE_PATTERN = /^[a-f0-9]{16}\.(?:jpe?g|png|webp|gif|avif|bmp)$/u

/** Downloads and caches cover images for crawled items. */
export class MediaCache {
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
    private readonly proxy: ProxyEndpoint | undefined,
  ) {}

  /**
   * Ensure one remote cover is cached locally.
   * @param remoteUrl - the cover URL.
   * @param referer - platform referer some CDNs check.
   * @param options - abort signal and timeout plumbing.
   * @returns the served `/api/ai-news/media/<file>` path, or undefined on failure.
   */
  async ensure(remoteUrl: string, referer: string | undefined, options: FetchOptions = {}): Promise<string | undefined> {
    if (!/^https?:\/\//u.test(remoteUrl)) return undefined
    const hash = createHash('sha1').update(remoteUrl).digest('hex').slice(0, 16)
    const existing = await this.findCached(hash)
    if (existing !== undefined) return `${MEDIA_ROUTE_PREFIX}/${existing}`
    try {
      const response = await smartFetch(remoteUrl, this.proxy, {
        ...options,
        timeoutMs: options.timeoutMs ?? 20_000,
        headers: {
          'user-agent': CRAWL_USER_AGENT,
          accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8',
          ...(referer === undefined ? {} : { referer }),
        },
      })
      if (response.status !== 200) return undefined
      const body = response.buffer()
      if (body.byteLength === 0 || body.byteLength > this.maxBytes) return undefined
      const contentType = response.header('content-type') ?? ''
      const declared = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
      if (declared !== '' && EXTENSION_BY_TYPE[declared] === undefined && !declared.startsWith('image/')) return undefined
      const extension = EXTENSION_BY_TYPE[declared] ?? extensionFromUrl(remoteUrl) ?? '.jpg'
      const finalName = hash + extension
      await mkdir(this.dir, { recursive: true })
      await writeFile(join(this.dir, finalName), body)
      return `${MEDIA_ROUTE_PREFIX}/${finalName}`
    } catch {
      return undefined
    }
  }

  /** Locate an already-cached file for one content hash (any extension). */
  private async findCached(hash: string): Promise<string | undefined> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch {
      return undefined
    }
    return entries.find(entry => entry.startsWith(`${hash}.`) && MEDIA_FILE_PATTERN.test(entry))
  }
}

/** Best-effort extension from a URL path when the CDN declares no type. */
function extensionFromUrl(remoteUrl: string): string | undefined {
  try {
    const path = new URL(remoteUrl).pathname
    const ext = extname(path).toLowerCase()
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.bmp'].includes(ext) ? ext : undefined
  } catch {
    return undefined
  }
}
