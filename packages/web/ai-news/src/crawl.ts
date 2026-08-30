/**
 * Crawl orchestrator: runs every enabled platform adapter, caches covers,
 * merges the store, and exposes the crawl state to the HTTP routes. One crawl
 * at a time; a shared AbortController bounds the run to the configured wall
 * budget and cancels it on plugin disposal.
 * @module @deepseek-ai/dsh-ai-news/crawl
 */

import { aiScoreOf, isAiRelevant } from './relevance.ts'
import type { FetchOptions, HttpResponse, ProxyEndpoint } from './http.ts'
import { smartFetch } from './http.ts'
import type { MediaCache } from './media.ts'
import type { NewsStore } from './store.ts'
import { Translator, type TranslationRuntime } from './translate.ts'
import { NEWS_PLATFORMS, type NewsFeed, type NewsItem, type NewsPlatform, type PlatformStatus, type ResolvedConfig } from './types.ts'
import { bilibiliCrawler } from './crawlers/bilibili.ts'
import type { CrawlContext, PlatformCrawler } from './crawlers/context.ts'
import { douyinCrawler } from './crawlers/douyin.ts'
import { rssCrawler } from './crawlers/rssfeeds.ts'
import { twitterCrawler } from './crawlers/twitter.ts'
import { xiaohongshuCrawler } from './crawlers/xiaohongshu.ts'

/** Every known adapter, keyed by platform id. */
const CRAWLERS: Record<NewsPlatform, PlatformCrawler> = {
  bilibili: bilibiliCrawler,
  douyin: douyinCrawler,
  xiaohongshu: xiaohongshuCrawler,
  x: twitterCrawler,
  rss: rssCrawler,
}

/** Concurrent cover downloads per crawl. */
const IMAGE_CONCURRENCY = 4

/** Minimal logger shape (the cordis context logger satisfies it). */
export interface NewsLogger {
  info(message: string): void
  warn(error: Error): void
}

/** The crawl run state machine shared by the scheduler and the HTTP routes. */
export class NewsCrawler {
  private crawling = false
  private abortController: AbortController | undefined
  private lastStatuses: PlatformStatus[] = []
  private readonly translator: Translator

  constructor(
    private readonly store: NewsStore,
    private readonly media: MediaCache,
    private readonly config: ResolvedConfig,
    private readonly proxy: ProxyEndpoint | undefined,
    private readonly logger: NewsLogger,
    translationRuntime: TranslationRuntime = {},
  ) {
    this.translator = new Translator(config, logger, translationRuntime)
  }

  /** True while a crawl is in flight. */
  get isCrawling(): boolean {
    return this.crawling
  }

  /** The most recent crawl outcome per platform. */
  get statuses(): PlatformStatus[] {
    return this.lastStatuses
  }

  /** Assemble the feed snapshot served at `/api/ai-news/feed`. */
  async feedSnapshot(): Promise<NewsFeed> {
    const snapshot = await this.store.load()
    return {
      updatedAt: snapshot.updatedAt,
      crawling: this.crawling,
      platforms: this.lastStatuses.length > 0 ? this.lastStatuses : NEWS_PLATFORMS.map(id => ({ id, label: CRAWLERS[id].label, ok: snapshot.updatedAt > 0, count: snapshot.items.filter(item => item.platform === id).length })),
      items: snapshot.items,
    }
  }

  /**
   * Run one full crawl. Concurrent callers get `false` without side effects.
   * @param force - ignored by this method; staleness is the scheduler's job.
   */
  async refresh(force = false): Promise<boolean> {
    void force
    if (this.crawling) return false
    this.crawling = true
    this.abortController = new AbortController()
    const startedAt = Date.now()
    const timeout = setTimeout(() => { this.abortController?.abort() }, this.config.crawlTimeoutMs)
    try {
      const ctx = this.makeContext(this.abortController.signal)
      const enabled = this.config.platforms
      const outcomes = await Promise.all(enabled.map(async (platform): Promise<{ platform: NewsPlatform; items: NewsItem[]; error?: string }> => {
        try {
          const items = (await CRAWLERS[platform].crawl(ctx)).filter(item => isAiRelevant(item.aiScore))
          return { platform, items }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { platform, items: [], error: message }
        }
      }))
      this.lastStatuses = NEWS_PLATFORMS.map((platform) => {
        if (!enabled.includes(platform)) return { id: platform, label: CRAWLERS[platform].label, ok: false, count: 0, error: '未启用' }
        const outcome = outcomes.find(entry => entry.platform === platform)
        const errorMessage = outcome?.error
        return {
          id: platform,
          label: CRAWLERS[platform].label,
          ok: outcome !== undefined && errorMessage === undefined,
          count: outcome?.items.length ?? 0,
          ...(errorMessage === undefined ? {} : { error: errorMessage }),
        }
      })
      const items = outcomes.flatMap(outcome => outcome.items)
      await this.cacheImages(items, ctx.signal)
      await this.store.merge(items, Date.now())
      await this.translateStored(this.abortController.signal)
      await this.store.pruneMedia()
      const failed = this.lastStatuses.filter(status => !status.ok && status.error !== '未启用')
      this.logger.info(`ai-news: crawl finished in ${String(Math.round((Date.now() - startedAt) / 1000))}s — ${String(items.length)} items, ${String(failed.length)} platform(s) degraded`)
      return true
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
      return false
    } finally {
      clearTimeout(timeout)
      this.crawling = false
      this.abortController = undefined
    }
  }

  /** Crawl when stale; otherwise translate any retained English backlog. */
  async refreshIfStale(): Promise<void> {
    if (this.crawling) return
    const snapshot = await this.store.load()
    const staleMs = this.config.intervalHours * 3_600_000
    if (snapshot.updatedAt !== 0 && snapshot.items.length > 0 && Date.now() - snapshot.updatedAt < staleMs) {
      await this.translatePending()
      return
    }
    await this.refresh(true)
  }

  /** Translate retained English items without recrawling the source platforms. */
  async translatePending(): Promise<void> {
    if (this.crawling) return
    this.crawling = true
    this.abortController = new AbortController()
    try {
      await this.translateStored(this.abortController.signal)
    } finally {
      this.crawling = false
      this.abortController = undefined
    }
  }

  /** Abort any in-flight crawl (plugin disposal). */
  abort(): void {
    this.abortController?.abort()
  }

  /** Translate store items whose English text still lacks a Chinese version. */
  private async translateStored(signal: AbortSignal): Promise<void> {
    try {
      const snapshot = await this.store.load()
      await this.translator.translate(snapshot.items, signal, async () => {
        await this.store.save(snapshot)
      })
    } catch (error) {
      this.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private makeContext(signal: AbortSignal): CrawlContext {
    const config = this.config
    const proxy = this.proxy
    return {
      config,
      proxy,
      signal,
      fetchSmart: (url: string, options: FetchOptions = {}): Promise<HttpResponse> =>
        smartFetch(url, proxy, { ...options, signal: options.signal ?? signal }),
      score: (title: string, body: string): number => aiScoreOf(title, body, config.keywords),
    }
  }

  /** Download covers for items that lack a local cache entry (bounded concurrency). */
  private async cacheImages(items: NewsItem[], signal: AbortSignal): Promise<void> {
    const pending = items.filter(item => item.remoteImage !== undefined)
    let cursor = 0
    const workers = Array.from({ length: IMAGE_CONCURRENCY }, async () => {
      while (cursor < pending.length) {
        if (signal.aborted) return
        const index = cursor
        cursor += 1
        const item = pending[index]
        if (item === undefined || item.remoteImage === undefined) continue
        const cached = await this.media.ensure(item.remoteImage, refererFor(item.platform), { signal })
        if (cached !== undefined) item.image = cached
      }
    })
    await Promise.all(workers)
  }
}

/** Referer header some CDNs check when serving covers. */
function refererFor(platform: NewsPlatform): string | undefined {
  switch (platform) {
    case 'bilibili':
      return 'https://www.bilibili.com/'
    case 'douyin':
      return 'https://www.douyin.com/'
    case 'xiaohongshu':
      return 'https://www.xiaohongshu.com/'
    case 'x':
      return 'https://x.com/'
    case 'rss':
      return undefined
    /* v8 ignore next -- the switch is exhaustive over the platform union */
    default:
      return undefined
  }
}
