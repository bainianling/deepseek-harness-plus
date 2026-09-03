/**
 * X (Twitter) crawler: syndication timeline endpoint for a curated list of AI
 * accounts. Works without login through the CDN embed endpoint, but the host
 * is unreachable from networks that block Twitter — those need the crawl
 * proxy (auto-detected on Windows, or explicit in the row config).
 * @module @deepseek-ai/dsh-ai-news/crawlers/twitter
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import type { NewsItem } from '../types.ts'
import { withinDays, type CrawlContext, type PlatformCrawler } from './context.ts'

/** Tweets admitted per account. */
const MAX_PER_ACCOUNT = 5

/** Timeline freshness window (days). */
const WINDOW_DAYS = 5

/** Embed timeline host. */
const SYNDICATION_BASE = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/'

interface TweetMedia {
  media_url_https?: string
}

interface TweetUser {
  name?: string
  screen_name?: string
}

interface Tweet {
  id_str?: string
  full_text?: string
  created_at?: string
  entities?: { media?: TweetMedia[] }
  user?: TweetUser
}

interface TimelineEntry {
  content?: { tweet?: Tweet }
}

interface SyndicationData {
  props?: {
    pageProps?: {
      timeline?: { entries?: TimelineEntry[] }
    }
  }
}

/** Extract and parse the `__NEXT_DATA__` JSON from one timeline page. */
export function parseSyndicationPage(html: string): SyndicationData | undefined {
  const match = /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/u.exec(html)
  if (match === null || match[1] === undefined) return undefined
  try {
    return JSON.parse(match[1]) as SyndicationData
  } catch {
    return undefined
  }
}

/** First-line title for a tweet body. */
export function tweetTitle(text: string): string {
  const firstLine = text.split(/\r?\n/u)[0] ?? ''
  const trimmed = firstLine.trim()
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
}

async function crawlAccount(ctx: CrawlContext, account: string): Promise<NewsItem[]> {
  const response = await ctx.fetchSmart(`${SYNDICATION_BASE}${encodeURIComponent(account)}`, {
    headers: { 'user-agent': CRAWL_USER_AGENT, accept: 'text/html' },
    timeoutMs: 25_000,
    preferProxy: true,
  })
  if (response.status === 429) throw new Error('x: syndication rate limited (429)')
  if (response.status !== 200) throw new Error(`x: syndication http ${String(response.status)} for @${account}`)
  const data = parseSyndicationPage(response.text())
  const entries = data?.props?.pageProps?.timeline?.entries ?? []
  if (entries.length === 0) return []
  const now = Date.now()
  const items: NewsItem[] = []
  for (const entry of entries) {
    if (items.length >= MAX_PER_ACCOUNT) break
    const tweet = entry.content?.tweet
    if (tweet?.id_str === undefined || tweet.full_text === undefined) continue
    const publishedAt = parseTweetDate(tweet.created_at)
    if (!withinDays(publishedAt, WINDOW_DAYS, now)) continue
    const text = tweet.full_text.trim()
    if (text.startsWith('@')) continue // skip replies: weak standalone context
    const screenName = tweet.user?.screen_name ?? account
    const media = tweet.entities?.media?.find(m => m.media_url_https !== undefined)?.media_url_https
    const title = tweetTitle(text)
    items.push({
      id: `x:${tweet.id_str}`,
      platform: 'x',
      title,
      summary: text.length > 300 ? `${text.slice(0, 300)}…` : text,
      ...(media === undefined ? {} : { image: media, remoteImage: media }),
      link: `https://x.com/${screenName}/status/${tweet.id_str}`,
      author: tweet.user?.name === undefined ? `@${screenName}` : `${tweet.user.name} @${screenName}`,
      publishedAt: publishedAt === 0 ? now : publishedAt,
      crawledAt: now,
      aiScore: ctx.score(title, text),
    })
  }
  return items
}

/** Parse Twitter's `Sat Aug 29 12:00:00 +0000 2026` date format. */
export function parseTweetDate(value: string | undefined): number {
  if (value === undefined) return 0
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

/** Syndication timelines are rate-limited; fetch accounts in a small pool. */
const ACCOUNT_CONCURRENCY = 4

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** The X platform adapter. */
export const twitterCrawler: PlatformCrawler = {
  platform: 'x',
  label: 'X',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const accounts = ctx.config.xAccounts.slice(0, 16)
    const results: PromiseSettledResult<NewsItem[]>[] = new Array(accounts.length)
    let cursor = 0
    const workers = Array.from({ length: ACCOUNT_CONCURRENCY }, async () => {
      while (cursor < accounts.length) {
        const index = cursor
        cursor += 1
        const account = accounts[index]
        if (account === undefined) continue
        results[index] = await Promise.allSettled([crawlAccount(ctx, account)]).then(settled => settled[0]!)
        await sleep(250)
      }
    })
    await Promise.all(workers)
    const items: NewsItem[] = []
    let lastError: string | undefined
    let succeeded = 0
    for (const result of results) {
      if (result === undefined) continue
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
