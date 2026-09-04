/**
 * Shared crawl context passed to every platform adapter.
 * @module @deepseek-ai/dsh-ai-news/crawlers/context
 */

import type { FetchOptions, HttpResponse, ProxyEndpoint } from '../http.ts'
import type { NewsItem, ResolvedConfig } from '../types.ts'

/** One login-based Douyin search hit (rendered by the built-in browser). */
export interface DouyinSearchHit {
  url: string
  title: string
  snippet?: string
}

/** Capabilities and limits one crawler receives. */
export interface CrawlContext {
  config: ResolvedConfig
  proxy: ProxyEndpoint | undefined
  /** Abort signal for the whole crawl run. */
  signal: AbortSignal
  /** Fetch honoring the crawl proxy policy. */
  fetchSmart(url: string, options?: FetchOptions): Promise<HttpResponse>
  /** Extra AI keywords for relevance scoring. */
  score(title: string, body: string): number
  /** Login-based Douyin keyword search; absent without a browser session. */
  douyinSearch?: (keyword: string) => Promise<DouyinSearchHit[]>
}

/** One platform adapter. */
export interface PlatformCrawler {
  readonly platform: NewsItem['platform']
  readonly label: string
  crawl(ctx: CrawlContext): Promise<NewsItem[]>
}

/** True when the timestamp is within `days` of now (0 = unknown, admit it). */
export function withinDays(timestampMs: number, days: number, now: number = Date.now()): boolean {
  if (timestampMs === 0) return true
  return now - timestampMs <= days * 86_400_000 && timestampMs <= now + 86_400_000
}
