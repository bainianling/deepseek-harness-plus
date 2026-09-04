/** WBI signing vectors pinned from a live bilibili session (2026-08-29). */

import { describe, expect, it } from 'vitest'
import { keyFromIconUrl, mixinKeyOf, signWbi } from '../src/wbi.ts'

const IMG_KEY = '7cd084941338484aae1ad9425b84077c'
const SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45'
const MIXIN_KEY = 'ea1db124af3c7062474693fa704f4ff8'

describe('wbi signing', () => {
  it('derives key names from the icon urls', () => {
    expect(keyFromIconUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(IMG_KEY)
    expect(keyFromIconUrl('https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png')).toBe(SUB_KEY)
  })

  it('mixes the key pair through the fixed table', () => {
    expect(mixinKeyOf(IMG_KEY, SUB_KEY)).toBe(MIXIN_KEY)
  })

  it('reproduces the pinned signed query', () => {
    const signed = signWbi(
      { keyword: 'AI大模型', order: 'pubdate', page: 1, search_type: 'video' },
      IMG_KEY,
      SUB_KEY,
      1788000000,
    )
    expect(signed).toBe('keyword=AI%E5%A4%A7%E6%A8%A1%E5%9E%8B&order=pubdate&page=1&search_type=video&wts=1788000000&w_rid=dc9127e93d50e772a7f34f7101cd7155')
  })

  it('sorts parameters before signing', () => {
    const signed = signWbi({ b: 2, a: 1 }, IMG_KEY, SUB_KEY, 1788000000)
    expect(signed.startsWith('a=1&b=2&wts=1788000000&w_rid=')).toBe(true)
  })
})
