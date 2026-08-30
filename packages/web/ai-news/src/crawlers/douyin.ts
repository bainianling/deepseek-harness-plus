/**
 * Douyin crawler: the public hot-search list API (no signing, no login).
 * Douyin's web search wall blocks unauthenticated rendering, so the daily
 * crawl reads the official hot board, keeps the AI-relevant words on top,
 * and carries the board's word covers as card images.
 * @module @deepseek-ai/dsh-ai-news/crawlers/douyin
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import type { NewsItem } from '../types.ts'
import { withinDays, type CrawlContext, type PlatformCrawler } from './context.ts'

/** Admitted hot words per crawl (AI-scored ones sort first downstream). */
const MAX_ITEMS = 15

const HOT_LIST_API = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'

interface DouyinWordCover {
  url_list?: string[]
}

interface DouyinWord {
  word?: string
  hot_value?: number
  event_time?: number
  sentence_id?: string
  position?: number
  word_cover?: DouyinWordCover
}

/** Parse one hot-list payload (tolerant of both `data.word_list` and top-level). */
export function parseDouyinHotList(json: unknown): DouyinWord[] {
  if (json === null || typeof json !== 'object') return []
  const root = json as { data?: { word_list?: DouyinWord[] }; word_list?: DouyinWord[] }
  const list = root.data?.word_list ?? root.word_list
  return Array.isArray(list) ? list : []
}

/** Format a hot metric like 12105961 into 1210.6万. */
export function formatHotValue(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}

/** The douyin platform adapter. */
export const douyinCrawler: PlatformCrawler = {
  platform: 'douyin',
  label: '抖音',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const response = await ctx.fetchSmart(HOT_LIST_API, {
      headers: { 'user-agent': CRAWL_USER_AGENT, referer: 'https://www.douyin.com/' },
      timeoutMs: 20_000,
    })
    if (response.status !== 200) throw new Error(`douyin: hot list http ${String(response.status)}`)
    const words = parseDouyinHotList(JSON.parse(response.text()))
    if (words.length === 0) throw new Error('douyin: empty hot list')
    const now = Date.now()
    const items: NewsItem[] = []
    for (const word of words.slice(0, MAX_ITEMS)) {
      if (word.word === undefined || word.word.trim() === '') continue
      const publishedAt = (word.event_time ?? 0) * 1000
      if (!withinDays(publishedAt, ctx.config.maxAgeDays, now)) continue
      const title = word.word.trim()
      const summary = `抖音热搜榜 第${String(word.position ?? items.length + 1)}位 · 热度 ${formatHotValue(word.hot_value ?? 0)}`
      const cover = word.word_cover?.url_list?.find(url => /^https?:\/\//u.test(url))
      const score = ctx.score(title, '')
      items.push({
        id: `douyin:${word.sentence_id ?? title}`,
        platform: 'douyin',
        title,
        summary,
        ...(cover === undefined ? {} : { image: cover, remoteImage: cover }),
        link: `https://www.douyin.com/search/${encodeURIComponent(title)}`,
        publishedAt: publishedAt === 0 ? now : publishedAt,
        crawledAt: now,
        aiScore: score,
        ...(score === 0 ? { hot: true } : {}),
      })
    }
    return items
  },
}
