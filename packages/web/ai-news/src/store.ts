/**
 * The persistent news store: one `feed.json` under the data directory plus a
 * `media/` cover cache beside it. Merges dedupe by item id, keep the highest
 * relevance and the freshest crawl metadata, and cap the total item count.
 * @module @deepseek-ai/dsh-ai-news/store
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAiRelevant } from './relevance.ts'
import type { NewsItem } from './types.ts'

/** Shape persisted in feed.json. */
export interface StoreSnapshot {
  updatedAt: number
  items: NewsItem[]
}

const EMPTY: StoreSnapshot = { updatedAt: 0, items: [] }

/** Filesystem-backed feed store with id-dedupe merges and a hard item cap. */
export class NewsStore {
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly dir: string,
    private readonly maxItems: number,
  ) {}

  /** The cover-image cache directory beside the feed file. */
  get mediaDir(): string {
    return join(this.dir, 'media')
  }

  private get feedPath(): string {
    return join(this.dir, 'feed.json')
  }

  /** Ensure the directory tree exists (idempotent). */
  async init(): Promise<void> {
    await mkdir(this.mediaDir, { recursive: true })
  }

  /** Read the current snapshot; a missing or corrupt file reads as empty. */
  async load(): Promise<StoreSnapshot> {
    try {
      const raw = await readFile(this.feedPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StoreSnapshot>
      const items = Array.isArray(parsed.items)
        ? parsed.items.filter((item): item is NewsItem => isNewsItem(item) && isAiRelevant(item.aiScore))
        : []
      const updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
      return { updatedAt, items }
    } catch {
      return { ...EMPTY, items: [] }
    }
  }

  /**
   * Merge incoming items into the store and persist.
   * @param incoming - freshly crawled items.
   * @param updatedAt - completion timestamp recorded for this crawl.
   * @returns the merged snapshot.
   */
  async merge(incoming: readonly NewsItem[], updatedAt: number): Promise<StoreSnapshot> {
    const current = await this.load()
    const byId = new Map<string, NewsItem>()
    for (const item of current.items) {
      if (isAiRelevant(item.aiScore)) byId.set(item.id, item)
    }
    for (const item of incoming) {
      if (!isAiRelevant(item.aiScore)) continue
      const existing = byId.get(item.id)
      if (existing === undefined) {
        byId.set(item.id, item)
        continue
      }
      byId.set(item.id, {
        ...item,
        ...(item.image === undefined && existing.image !== undefined ? { image: existing.image } : {}),
        ...(item.translatedTitle === undefined && existing.translatedTitle !== undefined ? { translatedTitle: existing.translatedTitle } : {}),
        ...(item.translatedSummary === undefined && existing.translatedSummary !== undefined ? { translatedSummary: existing.translatedSummary } : {}),
        crawledAt: existing.crawledAt,
        aiScore: Math.max(item.aiScore, existing.aiScore),
      })
    }
    const items = [...byId.values()]
      .sort((left, right) => right.aiScore - left.aiScore || right.publishedAt - left.publishedAt)
      .slice(0, this.maxItems)
    const snapshot: StoreSnapshot = { updatedAt, items }
    await this.save(snapshot)
    return snapshot
  }

  /** Serialize the crawl state to disk behind a one-writer queue. */
  async save(snapshot: StoreSnapshot): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = `${this.feedPath}.tmp-${String(Date.now())}`
      await writeFile(temp, JSON.stringify(snapshot), 'utf8')
      await rename(temp, this.feedPath)
    })
    // A failed write must not poison later saves.
    this.writeChain = write.catch(() => undefined)
    await write
  }

  /** Delete cached media files no retained item references anymore. */
  async pruneMedia(): Promise<void> {
    const snapshot = await this.load()
    const referenced = new Set<string>()
    const prefix = '/api/ai-news/media/'
    for (const item of snapshot.items) {
      if (item.image !== undefined && item.image.startsWith(prefix)) {
        referenced.add(item.image.slice(prefix.length))
      }
    }
    let entries: string[]
    try {
      entries = await readdir(this.mediaDir)
    } catch {
      return
    }
    await Promise.all(entries.map(async (entry) => {
      if (referenced.has(entry)) return
      await rm(join(this.mediaDir, entry), { force: true })
    }))
  }
}

/** Minimal structural guard for items read back from disk. */
function isNewsItem(value: unknown): value is NewsItem {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.id === 'string'
    && typeof candidate.platform === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.link === 'string'
    && typeof candidate.publishedAt === 'number'
}
