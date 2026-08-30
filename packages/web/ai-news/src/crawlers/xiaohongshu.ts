/**
 * Xiaohongshu crawler: the explore feed is server-side rendered for anonymous
 * visitors — the `window.__INITIAL_STATE__` blob carries ~30 note cards with
 * covers, titles, and authors. Web search requires login, so the daily crawl
 * reads the public explore feed and lets the AI keyword scoring rank it.
 * @module @deepseek-ai/dsh-ai-news/crawlers/xiaohongshu
 */

import { CRAWL_USER_AGENT } from '../http.ts'
import type { NewsItem } from '../types.ts'
import type { CrawlContext, PlatformCrawler } from './context.ts'

/** Admitted explore notes per crawl. */
const MAX_ITEMS = 20

const EXPLORE_URL = 'https://www.xiaohongshu.com/explore'

/** Extract the raw `__INITIAL_STATE__` object text from the explore HTML. */
export function extractInitialState(html: string): string | undefined {
  const match = /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/u.exec(html)
  return match?.[1]
}

interface XhsCover {
  urlDefault?: string
  url?: string
  urlPre?: string
  infoList?: Array<{ url?: string }>
}

/** One explore-feed note card (subset of the SSR shape). */
export interface XhsNoteCard {
  noteId?: string
  displayTitle?: string
  type?: string
  cover?: XhsCover
  user?: { nickname?: string; nickName?: string }
}

interface XhsFeedEntry {
  id?: string
  xsecToken?: string
  noteCard?: XhsNoteCard
}

/** Parse the explore HTML into feed entries (tolerant of missing shapes). */
export function parseXhsExplore(html: string): XhsFeedEntry[] {
  const raw = extractInitialState(html)
  if (raw === undefined) return []
  let state: { feed?: { feeds?: XhsFeedEntry[] } }
  try {
    state = JSON.parse(raw.replace(/undefined/gu, 'null'))
  } catch {
    return []
  }
  const feeds = state.feed?.feeds
  return Array.isArray(feeds) ? feeds : []
}

/** Resolve one note card's best cover URL (https enforced). */
export function xhsCoverUrl(card: XhsNoteCard): string | undefined {
  const cover = card.cover
  if (cover === undefined) return undefined
  const candidate = cover.urlDefault ?? cover.url ?? cover.infoList?.[0]?.url
  if (candidate === undefined || candidate === '') return undefined
  if (candidate.startsWith('//')) return `https:${candidate}`
  if (candidate.startsWith('http://')) return `https://${candidate.slice(7)}`
  return candidate
}

/** The xiaohongshu platform adapter. */
export const xiaohongshuCrawler: PlatformCrawler = {
  platform: 'xiaohongshu',
  label: '小红书',
  async crawl(ctx: CrawlContext): Promise<NewsItem[]> {
    const response = await ctx.fetchSmart(EXPLORE_URL, {
      headers: { 'user-agent': CRAWL_USER_AGENT, accept: 'text/html,application/xhtml+xml' },
      timeoutMs: 25_000,
    })
    if (response.status !== 200) throw new Error(`xiaohongshu: explore http ${String(response.status)}`)
    const entries = parseXhsExplore(response.text())
    if (entries.length === 0) throw new Error('xiaohongshu: no explore feed in INITIAL_STATE')
    const now = Date.now()
    const items: NewsItem[] = []
    for (const entry of entries) {
      if (items.length >= MAX_ITEMS) break
      const card = entry.noteCard
      const id = card?.noteId ?? entry.id
      const title = card?.displayTitle?.trim()
      if (id === undefined || id === '' || title === undefined || title === '') continue
      const cover = card === undefined ? undefined : xhsCoverUrl(card)
      const author = card?.user?.nickname ?? card?.user?.nickName
      const xsec = entry.xsecToken === undefined || entry.xsecToken === ''
        ? ''
        : `?xsec_token=${encodeURIComponent(entry.xsecToken)}&xsec_source=pc_feed`
      const score = ctx.score(title, '')
      items.push({
        id: `xiaohongshu:${id}`,
        platform: 'xiaohongshu',
        title,
        summary: author === undefined ? '小红书热门笔记' : `小红书笔记 · ${author}`,
        ...(cover === undefined ? {} : { image: cover, remoteImage: cover }),
        link: `https://www.xiaohongshu.com/explore/${id}${xsec}`,
        ...(author === undefined ? {} : { author }),
        publishedAt: now,
        crawledAt: now,
        aiScore: score,
        ...(score === 0 ? { hot: true } : {}),
      })
    }
    return items
  },
}
