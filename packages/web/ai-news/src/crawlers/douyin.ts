/**
 * Douyin crawler: public hot boards (no signing, no login) plus login-based
 * AI keyword search rendered by the built-in browser. Douyin's web search
 * wall blocks unauthenticated rendering, so search results only appear after
 * the user logs in through the news panel's 抖音登录 flow; the hot boards
 * keep working regardless.
 * @module @deepseek-ai/dsh-ai-news/crawlers/douyin
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import type { NewsItem } from '../types.ts'
import { withinDays, type CrawlContext, type DouyinSearchHit, type PlatformCrawler } from './context.ts'

/** Admitted hot words per crawl (AI-scored ones sort first downstream). */
const MAX_ITEMS = 50

/** AI keyword searches run against the logged-in Douyin session. */
export const DOUYIN_AI_KEYWORDS: readonly string[] = ['AI', '人工智能', 'AI大模型', '智能体', 'ChatGPT', 'Sora']

/** Delay between browser-rendered searches (gentle on the session). */
const SEARCH_GAP_MS = 600

const HOT_LIST_API = 'https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web'

/** Legacy word billboard: no covers, but a second pool of trending words. */
const WORD_BILLBOARD_API = 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/'

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

/** Parse the legacy word billboard payload (top-level `word_list`). */
export function parseWordBillboard(json: unknown): DouyinWord[] {
  if (json === null || typeof json !== 'object') return []
  const root = json as { word_list?: DouyinWord[] }
  return Array.isArray(root.word_list) ? root.word_list : []
}

/** Format a hot metric like 12105961 into 1210.6万. */
export function formatHotValue(value: number): string {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return String(value)
}

/** Build one item from a login-search hit (video link + title). */
export function itemFromSearchHit(hit: DouyinSearchHit, keyword: string, ctx: CrawlContext, now: number): NewsItem | undefined {
  const title = hit.title.trim()
  if (title === '' || hit.url === '') return undefined
  const videoId = douyinIdFromUrl(hit.url)
  const id = videoId !== undefined ? `douyin:v:${videoId}` : `douyin:s:${encodeURIComponent(hit.url)}`
  const snippet = (hit.snippet ?? '').trim()
  const score = ctx.score(title, snippet)
  return {
    id,
    platform: 'douyin',
    title,
    summary: snippet === '' ? `抖音「${keyword}」搜索结果` : `抖音「${keyword}」搜索 · ${snippet.slice(0, 200)}`,
    link: hit.url,
    publishedAt: now,
    crawledAt: now,
    aiScore: score,
  }
}

/** Extract a stable douyin id from a video/note URL path. */
export function douyinIdFromUrl(url: string): string | undefined {
  const match = /\/(?:video|note)\/([A-Za-z0-9_-]{6,})/u.exec(url)
  return match?.[1]
}

/** Crawl the two anonymous hot boards into items. */
async function crawlHotBoards(ctx: CrawlContext, now: number): Promise<NewsItem[]> {
  const headers = { 'user-agent': CRAWL_USER_AGENT, referer: 'https://www.douyin.com/' }
  const [hotResult, billboardResult] = await Promise.allSettled([
    ctx.fetchSmart(HOT_LIST_API, { headers, timeoutMs: 20_000 }),
    ctx.fetchSmart(WORD_BILLBOARD_API, { headers: { 'user-agent': CRAWL_USER_AGENT }, timeoutMs: 20_000 }),
  ])
  // The rich hot list is primary; the legacy billboard only adds missing words.
  const words = new Map<string, DouyinWord>()
  if (hotResult.status === 'fulfilled' && hotResult.value.status === 200) {
    for (const word of parseDouyinHotList(JSON.parse(hotResult.value.text()))) {
      if (word.word !== undefined && word.word.trim() !== '') words.set(word.word.trim(), word)
    }
  } else if (hotResult.status === 'rejected') {
    throw new Error(`douyin: hot list ${String(hotResult.reason)}`)
  } else {
    throw new Error(`douyin: hot list http ${String(hotResult.value.status)}`)
  }
  if (billboardResult.status === 'fulfilled' && billboardResult.value.status === 200) {
    for (const word of parseWordBillboard(JSON.parse(billboardResult.value.text()))) {
      if (word.word === undefined || word.word.trim() === '') continue
      const key = word.word.trim()
      if (!words.has(key)) words.set(key, word)
    }
  }
  if (words.size === 0) throw new Error('douyin: empty hot list')
  const items: NewsItem[] = []
  let position = 0
  for (const word of [...words.values()].slice(0, MAX_ITEMS * 2)) {
    position += 1
    const title = word.word?.trim()
    if (title === undefined || title === '') continue
    const publishedAt = (word.event_time ?? 0) * 1000
    if (!withinDays(publishedAt, ctx.config.maxAgeDays, now)) continue
    const summary = `抖音热搜 第${String(word.position ?? position)}位 · 热度 ${formatHotValue(word.hot_value ?? 0)}`
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
    if (items.length >= MAX_ITEMS) break
  }
  return items
}

/** Crawl AI keyword search through the logged-in browser session. */
async function crawlLoginSearch(ctx: CrawlContext, now: number): Promise<NewsItem[]> {
  const search = ctx.douyinSearch
  if (search === undefined) return []
  const items: NewsItem[] = []
  const seen = new Set<string>()
  for (const keyword of DOUYIN_AI_KEYWORDS) {
    try {
      const hits = await search(keyword)
      for (const hit of hits) {
        const item = itemFromSearchHit(hit, keyword, ctx, now)
        if (item === undefined || seen.has(item.id)) continue
        seen.add(item.id)
        items.push(item)
      }
    } catch {
      // One keyword failing never aborts the other keywords.
    }
    await new Promise(resolve => { setTimeout(resolve, SEARCH_GAP_MS) })
  }
  return items
}

/** The douyin platform adapter. */
export const douyinCrawler: PlatformCrawler = {
  platform: 'douyin',
  label: '抖音',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const now = Date.now()
    // Login-based search yields real AI videos when available; hot boards are
    // always attempted and their AI-scored words are merged underneath.
    const searchItems = await crawlLoginSearch(ctx, now)
    const hotItems = await crawlHotBoards(ctx, now)
    const byId = new Map<string, NewsItem>()
    for (const item of [...searchItems, ...hotItems]) {
      const existing = byId.get(item.id)
      if (existing === undefined || item.aiScore > existing.aiScore) byId.set(item.id, item)
    }
    return [...byId.values()]
  },
}
