/** Xiaohongshu explore SSR parsing. */

import { describe, expect, it } from 'vitest'
import { extractInitialState, parseXhsExplore, xhsCoverUrl } from '../src/crawlers/xiaohongshu.ts'

const EXPLORE_HTML = `<html><head><script>
window.__INITIAL_STATE__={"global":{},"feed":{"feeds":[{"id":"note1","xsecToken":"tok/1","noteCard":{"noteId":"note1","displayTitle":"AI 绘画教程","type":"normal","cover":{"urlDefault":"http://sns-webpic-qc.xhscdn.com/pic1"},"user":{"nickname":"画家"}}},{"id":"note2","noteCard":{"noteId":"note2","displayTitle":"周末去哪儿","type":"video","cover":{"url":"//sns-img.xhscdn.com/pic2"},"user":{"nickName":"旅行家"}}},{"id":"empty"}]}}
</script></head></html>`

describe('extractInitialState', () => {
  it('captures the state object', () => {
    expect(extractInitialState(EXPLORE_HTML)).toContain('"feed"')
    expect(extractInitialState('<html>nothing</html>')).toBeUndefined()
  })
})

describe('parseXhsExplore', () => {
  it('parses note cards from the SSR state', () => {
    const entries = parseXhsExplore(EXPLORE_HTML)
    expect(entries.length).toBe(3)
    expect(entries[0]?.noteCard?.displayTitle).toBe('AI 绘画教程')
  })

  it('survives undefined tokens in the state blob', () => {
    expect(parseXhsExplore('<html><script>window.__INITIAL_STATE__={"feed":{"feeds":undefined}}</script></html>')).toEqual([])
  })

  it('returns empty for pages without the state blob', () => {
    expect(parseXhsExplore('<html></html>')).toEqual([])
  })
})

describe('xhsCoverUrl', () => {
  it('upgrades http and protocol-relative URLs to https', () => {
    expect(xhsCoverUrl({ cover: { urlDefault: 'http://cdn/x.jpg' } })).toBe('https://cdn/x.jpg')
    expect(xhsCoverUrl({ cover: { url: '//cdn/y.jpg' } })).toBe('https://cdn/y.jpg')
  })

  it('returns undefined without a usable cover', () => {
    expect(xhsCoverUrl({})).toBeUndefined()
    expect(xhsCoverUrl({ cover: { urlDefault: '' } })).toBeUndefined()
  })
})
