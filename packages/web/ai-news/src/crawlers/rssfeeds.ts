/**
 * General AI-news RSS tier ("综合"): editorial feeds that always carry real
 * images and copy. Overseas hosts route through the proxy when one is
 * configured; every feed degrades independently.
 * @module @deepseek-ai/dsh-ai-news/crawlers/rssfeeds
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import { parseFeed } from '../rss.ts'
import type { NewsItem } from '../types.ts'
import { withinDays, type CrawlContext, type PlatformCrawler } from './context.ts'

/** Entries admitted per feed. */
const MAX_PER_FEED = 6

/** Freshness window for blog-style feeds. */
const WINDOW_DAYS = 7

/** One editorial feed definition. */
export interface FeedSpec {
  id: string
  label: string
  url: string
  /** Route through the proxy first (overseas hosts from blocked networks). */
  preferProxy: boolean
}

/** The default feed roster (verified reachable 2026-08). */
export const DEFAULT_FEEDS: readonly FeedSpec[] = [
  { id: 'qbitai', label: '量子位', url: 'https://www.qbitai.com/feed', preferProxy: false },
  { id: 'openai', label: 'OpenAI News', url: 'https://openai.com/news/rss.xml', preferProxy: true },
  { id: 'theverge-ai', label: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', preferProxy: false },
  { id: 'deepmind', label: 'DeepMind Blog', url: 'https://deepmind.google/blog/rss.xml', preferProxy: true },
  { id: 'huggingface', label: 'Hugging Face Blog', url: 'https://huggingface.co/blog/feed.xml', preferProxy: true },
  { id: 'mit-tr', label: 'MIT Tech Review AI', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed', preferProxy: true },
]

async function crawlOneFeed(ctx: CrawlContext, feed: FeedSpec): Promise<NewsItem[]> {
  const response = await ctx.fetchSmart(feed.url, {
    headers: { 'user-agent': CRAWL_USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    timeoutMs: 25_000,
    preferProxy: feed.preferProxy,
  })
  if (response.status !== 200) throw new Error(`rss[${feed.id}]: http ${String(response.status)}`)
  const entries = parseFeed(response.text(), MAX_PER_FEED)
  const now = Date.now()
  const items: NewsItem[] = []
  for (const entry of entries) {
    if (entry.publishedAt !== 0 && !withinDays(entry.publishedAt, WINDOW_DAYS, now)) continue
    const summary = entry.summary === '' ? feed.label : `${feed.label} · ${entry.summary.slice(0, 240)}`
    items.push({
      id: `rss:${feed.id}:${entry.link}`,
      platform: 'rss',
      title: entry.title,
      summary,
      ...(entry.image === undefined ? {} : { image: entry.image, remoteImage: entry.image }),
      link: entry.link,
      author: feed.label,
      publishedAt: entry.publishedAt === 0 ? now : entry.publishedAt,
      crawledAt: now,
      aiScore: ctx.score(entry.title, entry.summary),
    })
  }
  return items
}

/** The rss (综合) platform adapter. */
export const rssCrawler: PlatformCrawler = {
  platform: 'rss',
  label: '综合',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const results = await Promise.allSettled(DEFAULT_FEEDS.map(feed => crawlOneFeed(ctx, feed)))
    const items: NewsItem[] = []
    let lastError: string | undefined
    let succeeded = 0
    for (const result of results) {
      if (result.status === 'fulfilled') {
        items.push(...result.value)
        succeeded += 1
      } else {
        lastError = result.reason instanceof Error ? result.reason.message : String(result.reason)
      }
    }
    if (succeeded === 0 && lastError !== undefined) throw new Error(lastError)
    return items
  },
}
