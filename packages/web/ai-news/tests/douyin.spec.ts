/** Douyin hot-list parsing and formatting. */

import { describe, expect, it } from 'vitest'
import { formatHotValue, parseDouyinHotList } from '../src/crawlers/douyin.ts'

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

describe('formatHotValue', () => {
  it('formats into wan/yi units', () => {
    expect(formatHotValue(12_105_961)).toBe('1210.6万')
    expect(formatHotValue(150_000_000)).toBe('1.5亿')
    expect(formatHotValue(999)).toBe('999')
  })
})
