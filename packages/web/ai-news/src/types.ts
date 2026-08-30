/**
 * Shared wire and store types for the AI realtime news aggregator.
 * @module @deepseek-ai/dsh-ai-news/types
 */

/** One crawl source. The rss platform aggregates several editorial feeds. */
export type NewsPlatform = 'bilibili' | 'douyin' | 'xiaohongshu' | 'x' | 'rss'

/** Every platform the crawlers know, in feed-presentation order. */
export const NEWS_PLATFORMS: readonly NewsPlatform[] = ['bilibili', 'douyin', 'xiaohongshu', 'x', 'rss']

/** One aggregated news card. */
export interface NewsItem {
  /** Stable dedupe key: `${platform}:${nativeId}`. */
  id: string
  platform: NewsPlatform
  title: string
  /** Short display text under the image (description or hot metric). */
  summary: string
  /**
   * Display image: a served local path `/api/ai-news/media/<file>` once the
   * cover was cached, otherwise the remote URL (best effort, may expire).
   */
  image?: string
  /** Original cover URL kept for re-download attempts and attribution. */
  remoteImage?: string
  /** Source page the card links out to. */
  link: string
  /** Uploader / account / feed display name. */
  author?: string
  /** Epoch milliseconds the item was published (crawl time when unknown). */
  publishedAt: number
  /** Epoch milliseconds the item entered this store. */
  crawledAt: number
  /** AI-keyword relevance score; 0 marks general hot content. */
  aiScore: number
  /** True for hot-list items with no AI relevance. */
  hot?: boolean
  /** Chinese translation of `title` (auto-translated from English). */
  translatedTitle?: string
  /** Chinese translation of `summary` (auto-translated from English). */
  translatedSummary?: string
}

/** Per-platform outcome of the most recent crawl. */
export interface PlatformStatus {
  id: NewsPlatform
  /** Human label (Chinese) for UI chips. */
  label: string
  ok: boolean
  count: number
  error?: string
}

/** The `/api/ai-news/feed` response body. */
export interface NewsFeed {
  /** Epoch milliseconds of the last completed crawl (0 when never). */
  updatedAt: number
  /** A crawl is in flight right now. */
  crawling: boolean
  platforms: PlatformStatus[]
  items: NewsItem[]
}

/** Normalized plugin configuration (see config.ts for defaults). */
export interface ResolvedConfig {
  enabled: boolean
  /** Re-crawl when the store is older than this many hours. */
  intervalHours: number
  /** Item cap kept in feed.json. */
  maxItems: number
  /** Absolute data directory (default `$DSH_HOME/data/ai-news`). */
  dataDir: string
  /** Explicit proxy URL, `''` = auto-detect, `none` = disabled. */
  proxy: string
  platforms: NewsPlatform[]
  /** X accounts read through the syndication timeline endpoint. */
  xAccounts: string[]
  /** Extra AI relevance keywords appended to the built-in list. */
  keywords: string[]
  /** Whole-crawl wall budget in milliseconds. */
  crawlTimeoutMs: number
  /** Per-image download cap in bytes. */
  maxImageBytes: number
  /** Items older than this many days are not admitted. */
  maxAgeDays: number
  /** Auto-translate English titles/summaries into Chinese. */
  translateEnabled: boolean
  /** Environment variable holding the translation API key. */
  translateApiKeyEnv: string
  /** OpenAI-compatible chat completions endpoint. */
  translateBaseUrl: string
  /** Chat model used for translation. */
  translateModel: string
  /** Max items translated per crawl run. */
  translateMaxPerCrawl: number
}
