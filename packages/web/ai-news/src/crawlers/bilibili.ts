/**
 * Bilibili crawler: the public WBI-signed video search API, no login. Fresh
 * buvid cookies come from `/x/frontend/finger/spi`, the rotating wbi keys
 * from `/x/web-interface/nav`; each AI search keyword runs one signed query
 * sorted by publish date.
 * @module @deepseek-ai/dsh-ai-news/crawlers/bilibili
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import type { NewsItem } from '../types.ts'
import { keyFromIconUrl, signWbi } from '../wbi.ts'
import { withinDays, type CrawlContext, type PlatformCrawler } from './context.ts'

/** Search keywords; each becomes one signed query. */
const SEARCH_KEYWORDS: readonly string[] = ['AI大模型', '人工智能', 'DeepSeek', 'OpenAI']

/** Videos admitted per keyword query. */
const MAX_PER_KEYWORD = 12

const SEARCH_API = 'https://api.bilibili.com/x/web-interface/wbi/search/type'
const REFERER = 'https://www.bilibili.com/'

interface Buvid {
  buvid3: string
  buvid4: string
}

async function fetchBuvid(ctx: CrawlContext): Promise<Buvid | undefined> {
  try {
    const response = await ctx.fetchSmart('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'user-agent': CRAWL_USER_AGENT },
      timeoutMs: 15_000,
    })
    if (response.status !== 200) return undefined
    const parsed = JSON.parse(response.text()) as { data?: { b_3?: string; b_4?: string } }
    if (parsed.data?.b_3 === undefined || parsed.data.b_4 === undefined) return undefined
    return { buvid3: parsed.data.b_3, buvid4: parsed.data.b_4 }
  } catch {
    return undefined
  }
}

async function fetchWbiKeys(ctx: CrawlContext): Promise<{ imgKey: string; subKey: string } | undefined> {
  try {
    const response = await ctx.fetchSmart('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': CRAWL_USER_AGENT, referer: REFERER },
      timeoutMs: 15_000,
    })
    if (response.status !== 200) return undefined
    const parsed = JSON.parse(response.text()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
    const imgUrl = parsed.data?.wbi_img?.img_url
    const subUrl = parsed.data?.wbi_img?.sub_url
    if (imgUrl === undefined || subUrl === undefined) return undefined
    return { imgKey: keyFromIconUrl(imgUrl), subKey: keyFromIconUrl(subUrl) }
  } catch {
    return undefined
  }
}

interface BiliSearchResult {
  bvid?: string
  title?: string
  pic?: string
  author?: string
  description?: string
  pubdate?: number
  play?: number
}

/** Strip the `<em class="keyword">` highlight tags from search titles. */
export function cleanBiliTitle(raw: string): string {
  return raw.replace(/<\/?em[^>]*>/gu, '').trim()
}

/** Normalize one `//host/path` or absolute pic URL to https. */
export function normalizeBiliPic(pic: string): string {
  if (pic.startsWith('//')) return `https:${pic}`
  return pic
}

async function searchKeyword(ctx: CrawlContext, keyword: string, keys: { imgKey: string; subKey: string }, buvid: Buvid | undefined): Promise<NewsItem[]> {
  const query = signWbi({ keyword, order: 'pubdate', page: 1, search_type: 'video' }, keys.imgKey, keys.subKey)
  const response = await ctx.fetchSmart(`${SEARCH_API}?${query}`, {
    headers: {
      'user-agent': CRAWL_USER_AGENT,
      referer: REFERER,
      ...(buvid === undefined ? {} : { cookie: `buvid3=${buvid.buvid3}; buvid4=${buvid.buvid4}` }),
    },
    timeoutMs: 20_000,
  })
  if (response.status !== 200) return []
  const parsed = JSON.parse(response.text()) as { code?: number; data?: { result?: BiliSearchResult[] } }
  if (parsed.code !== 0 || parsed.data?.result === undefined) return []
  const now = Date.now()
  const items: NewsItem[] = []
  for (const video of parsed.data.result.slice(0, MAX_PER_KEYWORD)) {
    if (video.bvid === undefined || video.title === undefined || video.bvid === '') continue
    const publishedAt = (video.pubdate ?? 0) * 1000
    if (!withinDays(publishedAt, ctx.config.maxAgeDays, now)) continue
    const title = cleanBiliTitle(video.title)
    const summary = (video.description ?? '').replace(/\s+/gu, ' ').trim().slice(0, 200)
    const pic = video.pic === undefined || video.pic === '' ? undefined : normalizeBiliPic(video.pic)
    items.push({
      id: `bilibili:${video.bvid}`,
      platform: 'bilibili',
      title,
      summary: summary === '' ? `UP主：${video.author ?? '未知'}` : summary,
      ...(pic === undefined ? {} : { image: pic, remoteImage: pic }),
      link: `https://www.bilibili.com/video/${video.bvid}`,
      ...(video.author === undefined ? {} : { author: video.author }),
      publishedAt: publishedAt === 0 ? now : publishedAt,
      crawledAt: now,
      aiScore: ctx.score(title, summary),
    })
  }
  return items
}

/** The bilibili platform adapter. */
export const bilibiliCrawler: PlatformCrawler = {
  platform: 'bilibili',
  label: 'B站',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const [buvid, keys] = await Promise.all([fetchBuvid(ctx), fetchWbiKeys(ctx)])
    if (keys === undefined) throw new Error('bilibili: wbi keys unavailable')
    const perKeyword = await Promise.all(SEARCH_KEYWORDS.map(keyword => searchKeyword(ctx, keyword, keys, buvid)))
    const byId = new Map<string, NewsItem>()
    for (const items of perKeyword) {
      for (const item of items) {
        const existing = byId.get(item.id)
        if (existing === undefined || item.aiScore > existing.aiScore) byId.set(item.id, item)
      }
    }
    return [...byId.values()]
  },
}
