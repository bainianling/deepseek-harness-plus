/** Douyin hot-list parsing, formatting, and login-search item shaping. */

import { describe, expect, it } from 'vitest'
import { douyinIdFromUrl, formatHotValue, itemFromSearchHit, parseDouyinHotList, parseWordBillboard } from '../src/crawlers/douyin.ts'
import type { CrawlContext } from '../src/crawlers/context.ts'
import { resolveConfig } from '../src/config.ts'

describe('parseDouyinHotList', () => {
  it('reads data.word_list', () => {
    const words = parseDouyinHotList({ data: { word_list: [{ word: 'AI 峰会', hot_value: 123 }] } })
    expect(words).toHaveLength(1)
    expect(words[0]?.word).toBe('AI 峰会')
  })

  it('falls back to a top-level word_list', () => {
    const words = parseDouyinHotList({ word_list: [{ word: 'x' }] })
    expect(words).toHaveLength(1)
  })

  it('returns empty for unexpected payloads', () => {
    expect(parseDouyinHotList(null)).toEqual([])
    expect(parseDouyinHotList({ data: {} })).toEqual([])
    expect(parseDouyinHotList('html')).toEqual([])
  })
})

describe('parseWordBillboard', () => {
  it('reads the legacy top-level word_list', () => {
    const words = parseWordBillboard({ status_code: 0, word_list: [{ word: 'AI 眼镜', hot_value: 5 }] })
    expect(words).toHaveLength(1)
    expect(words[0]?.word).toBe('AI 眼镜')
  })

  it('returns empty for unexpected payloads', () => {
    expect(parseWordBillboard(null)).toEqual([])
    expect(parseWordBillboard({ status_code: 1 })).toEqual([])
  })
})

describe('formatHotValue', () => {
  it('formats into wan/yi units', () => {
    expect(formatHotValue(12_105_961)).toBe('1210.6万')
    expect(formatHotValue(150_000_000)).toBe('1.5亿')
    expect(formatHotValue(999)).toBe('999')
  })
})

describe('douyinIdFromUrl', () => {
  it('extracts video and note ids', () => {
    expect(douyinIdFromUrl('https://www.douyin.com/video/7399123456789012345')).toBe('7399123456789012345')
    expect(douyinIdFromUrl('https://www.douyin.com/note/7399abcdef')).toBe('7399abcdef')
  })

  it('returns undefined for non-video urls', () => {
    expect(douyinIdFromUrl('https://www.douyin.com/search/AI')).toBeUndefined()
    expect(douyinIdFromUrl('https://www.douyin.com/user/abc')).toBeUndefined()
  })
})

describe('itemFromSearchHit', () => {
  const config = resolveConfig({})
  const ctx = {
    config,
    proxy: undefined,
    signal: new AbortController().signal,
    fetchSmart: async () => { throw new Error('unused') },
    score: (title: string) => (title.includes('AI') ? 3 : 0),
  } as unknown as CrawlContext

  it('maps a video hit into a news item', () => {
    const item = itemFromSearchHit({
      url: 'https://www.douyin.com/video/7399123456789012345',
      title: 'AI 大模型最新进展',
      snippet: '一段关于大模型的解读',
    }, 'AI', ctx, 1_700_000_000_000)
    expect(item?.id).toBe('douyin:v:7399123456789012345')
    expect(item?.title).toBe('AI 大模型最新进展')
    expect(item?.aiScore).toBe(3)
    expect(item?.summary).toContain('抖音「AI」搜索')
  })

  it('drops empty hits', () => {
    expect(itemFromSearchHit({ url: '', title: '' }, 'AI', ctx, 1)).toBeUndefined()
    expect(itemFromSearchHit({ url: 'https://x', title: '   ' }, 'AI', ctx, 1)).toBeUndefined()
  })
})
