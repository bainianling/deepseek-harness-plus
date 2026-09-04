/** Store merge, dedupe, cap, and media pruning semantics. */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NewsStore } from '../src/store.ts'
import type { NewsItem } from '../src/types.ts'

function item(overrides: Partial<NewsItem> & Pick<NewsItem, 'id' | 'platform'>): NewsItem {
  return {
    title: 't',
    summary: 's',
    link: 'https://example.com/',
    publishedAt: 1_000,
    crawledAt: 1_000,
    aiScore: 3,
    ...overrides,
  }
}

describe('NewsStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ai-news-store-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads an empty snapshot before any write', async () => {
    const store = new NewsStore(dir, 10)
    const snapshot = await store.load()
    expect(snapshot.updatedAt).toBe(0)
    expect(snapshot.items).toEqual([])
  })

  it('merges, dedupes by id, and persists', async () => {
    const store = new NewsStore(dir, 10)
    await store.init()
    await store.merge([item({ id: 'bilibili:BV1', platform: 'bilibili', aiScore: 5 }), item({ id: 'douyin:w1', platform: 'douyin' })], 111)
    const second = await store.merge([item({ id: 'bilibili:BV1', platform: 'bilibili', aiScore: 3, image: '/api/ai-news/media/aaaaaaaaaaaaaaaa.jpg' })], 222)
    expect(second.updatedAt).toBe(222)
    expect(second.items).toHaveLength(2)
    const kept = second.items.find(entry => entry.id === 'bilibili:BV1')
    expect(kept?.aiScore).toBe(5) // max of old and new
    expect(kept?.image).toBe('/api/ai-news/media/aaaaaaaaaaaaaaaa.jpg') // new wins when present
    const onDisk = JSON.parse(await readFile(join(dir, 'feed.json'), 'utf8')) as { items: unknown[] }
    expect(onDisk.items).toHaveLength(2)
  })

  it('keeps the existing image when a re-crawl has none', async () => {
    const store = new NewsStore(dir, 10)
    await store.init()
    await store.merge([item({ id: 'x:1', platform: 'x', image: '/api/ai-news/media/bbbbbbbbbbbbbbbb.png' })], 1)
    const merged = await store.merge([item({ id: 'x:1', platform: 'x' })], 2)
    expect(merged.items[0]?.image).toBe('/api/ai-news/media/bbbbbbbbbbbbbbbb.png')
  })

  it('caps the item count keeping highest scores first', async () => {
    const store = new NewsStore(dir, 3)
    await store.init()
    const many = [3, 4, 5, 6, 7].map(n => item({ id: `rss:f:${String(n)}`, platform: 'rss', aiScore: n, publishedAt: n * 1000 }))
    const merged = await store.merge(many, 1)
    expect(merged.items).toHaveLength(3)
    expect(merged.items.map(entry => entry.aiScore)).toEqual([7, 6, 5])
  })

  it('rejects non-AI rows during merge and load', async () => {
    const store = new NewsStore(dir, 10)
    await store.init()
    await store.merge([
      item({ id: 'x:ai', platform: 'x', aiScore: 3 }),
      item({ id: 'x:noise', platform: 'x', aiScore: 0 }),
      item({ id: 'x:body-only', platform: 'x', aiScore: 1 }),
    ], 1)
    const snapshot = await store.load()
    expect(snapshot.items.map(entry => entry.id)).toEqual(['x:ai'])
  })

  it('rejects structurally broken rows on load', async () => {
    const store = new NewsStore(dir, 3)
    await store.init()
    await store.save({ updatedAt: 5, items: [{ broken: true } as unknown as NewsItem, item({ id: 'x:9', platform: 'x' })] })
    const snapshot = await store.load()
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]?.id).toBe('x:9')
  })
})
