/**
 * @deepseek-ai/dsh-ai-news — the AI realtime news aggregator plugin. Daily
 * multi-platform crawl (Bilibili WBI search, Douyin hot board, Xiaohongshu
 * explore SSR, X syndication timelines, AI RSS feeds), a content-addressed
 * cover cache under `$DSH_HOME/data/ai-news/media`, and three webServer
 * routes for the GUI news panel: `GET /api/ai-news/feed`,
 * `POST /api/ai-news/refresh` (loopback control), and the
 * `/api/ai-news/media/<file>` static prefix.
 * @module @deepseek-ai/dsh-ai-news
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import { NewsCrawler, type NewsLogger } from './crawl.ts'
import { detectSystemProxy, parseProxy } from './http.ts'
import { MediaCache, MEDIA_ROUTE_PREFIX } from './media.ts'
import { NewsStore } from './store.ts'
import type { TranslationLlm, TranslationModelSelection } from './translate.ts'
import { MEDIA_FILE_PATTERN } from './media.ts'

/** Stable Cordis plugin name. */
export const name = 'ai-news'

/** The web surface must already carry the HTTP carrier. */
export const inject = ['webServer']

/** Structural webServer surface this plugin registers against. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Structural default-model service used without a hard plugin dependency. */
interface DefaultModelLike {
  currentSelection(): TranslationModelSelection
}

/** The `aiNews` service surface other rows may use. */
export interface AiNewsService {
  refresh(force: boolean): Promise<boolean>
  feed(): Promise<unknown>
  isCrawling(): boolean
}

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/** Loopback-only control requests must stay same-origin with the local GUI. */
function isLocalControlRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Read one bounded JSON body (refresh accepts an empty body too). */
function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > limit) {
        rejectPromise(new Error('body too large'))
        req.destroy()
      }
    })
    req.once('end', () => {
      if (body.trim() === '') {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(body) as Record<string, unknown>)
      } catch {
        rejectPromise(new Error('invalid json'))
      }
    })
    req.once('error', rejectPromise)
  })
}

/**
 * Mount the news aggregator: store + crawler, the three routes, the stale
 * checker, and the `aiNews` service. Disposal aborts an in-flight crawl and
 * unregisters every route.
 * @param ctx - plugin context carrying the webServer service.
 * @param rawConfig - the composition row config (coerced defensively).
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn(new Error('ai-news: webServer service unavailable; routes not registered'))
    return
  }

  const logger: NewsLogger = {
    info: message => { ctx.logger.info(message) },
    warn: error => { ctx.logger.warn(error) },
  }
  const llm = ctx.get('llm') as TranslationLlm | undefined
  const defaultModel = ctx.get('agentDefaultModel') as DefaultModelLike | undefined
  const store = new NewsStore(config.dataDir, config.maxItems)
  let crawler: NewsCrawler | undefined
  let disposed = false

  const boot = (async (): Promise<void> => {
    await store.init()
    const filteredSnapshot = await store.load()
    await store.save(filteredSnapshot)
    const proxy = config.proxy === 'none'
      ? undefined
      : config.proxy !== ''
        ? parseProxy(config.proxy)
        : await detectSystemProxy()
    const media = new MediaCache(store.mediaDir, config.maxImageBytes, proxy)
    const model = defaultModel?.currentSelection()
    crawler = new NewsCrawler(store, media, config, proxy, logger, {
      ...(llm === undefined ? {} : { llm }),
      ...(model === undefined ? {} : { model }),
    })
    ctx.logger.info(`ai-news: ready at ${config.dataDir}${proxy === undefined ? ' (no proxy)' : ` (proxy ${proxy.host}:${String(proxy.port)})`}`)
    // Initial crawl when stale, then a half-hourly staleness check: a long
    // sleep timer would drift with suspend/hibernate, short checks are cheap.
    void crawler.refreshIfStale().catch((error: unknown) => {
      logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  })().catch((error: unknown) => {
    logger.warn(error instanceof Error ? error : new Error(String(error)))
  })

  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed || crawler === undefined) return
      void crawler.refreshIfStale().catch((error: unknown) => {
        logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    }, 1_800_000)
    return () => {
      clearInterval(timer)
      disposed = true
      crawler?.abort()
    }
  }, 'ai-news: schedule')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/ai-news/feed',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      void boot.then(async () => {
        const snapshot = await (crawler?.feedSnapshot() ?? store.load())
        writeJson(res, 200, snapshot)
      }).catch(() => {
        writeJson(res, 500, { error: 'feed unavailable' })
      })
    },
  }), 'ai-news: feed route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/ai-news/refresh',
    handler: (req, res) => {
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      void readJsonBody(req, 4096).then(async () => {
        await boot
        if (crawler === undefined) {
          writeJson(res, 503, { error: 'crawler unavailable' })
          return
        }
        if (crawler.isCrawling) {
          writeJson(res, 409, { crawling: true })
          return
        }
        writeJson(res, 202, { started: true })
        void crawler.refresh(true).catch((error: unknown) => {
          logger.warn(error instanceof Error ? error : new Error(String(error)))
        })
      }).catch(() => {
        writeJson(res, 400, { error: 'invalid request' })
      })
    },
  }), 'ai-news: refresh route')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: MEDIA_ROUTE_PREFIX,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const prefix = `${MEDIA_ROUTE_PREFIX}/`
      if (!rawPath.startsWith(prefix)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const requested = rawPath.slice(prefix.length)
      // basename defeats any traversal; the pattern pins content-addressed names.
      const fileName = basename(requested)
      if (fileName !== requested || !MEDIA_FILE_PATTERN.test(fileName)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const full = join(store.mediaDir, fileName)
      if (!existsSync(full)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
      res.writeHead(200, {
        'content-type': CONTENT_TYPE_BY_EXTENSION[extension] ?? 'application/octet-stream',
        'content-length': String(statSync(full).size),
        'cache-control': 'public, max-age=86400',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      const stream = createReadStream(full)
      stream.pipe(res)
      stream.once('error', () => { res.destroy() })
    },
  }), 'ai-news: media route')

  ctx.provide('aiNews', {
    refresh: async (force: boolean) => {
      await boot
      return crawler === undefined ? false : crawler.refresh(force)
    },
    feed: async () => {
      await boot
      return crawler === undefined ? store.load() : crawler.feedSnapshot()
    },
    isCrawling: () => crawler?.isCrawling ?? false,
  } satisfies AiNewsService)
}
