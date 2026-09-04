/** RSS/Atom parsing over representative feed fragments. */

import { describe, expect, it } from 'vitest'
import { parseFeed, parseFeedDate, stripMarkup } from '../src/rss.ts'

const RSS_SAMPLE = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>量子位</title>
    <item>
      <title><![CDATA[DeepSeek 发布新模型]]></title>
      <link>https://www.qbitai.com/2026/08/1.html</link>
      <pubDate>Sat, 29 Aug 2026 10:00:00 +0000</pubDate>
      <description>&lt;p&gt;今天 &amp; 明天，模型能力大幅提升。&lt;/p&gt;</description>
      <media:content url="https://img.example.com/a.jpg" medium="image"/>
    </item>
    <item>
      <title>No image item</title>
      <link>https://www.qbitai.com/2026/08/2.html</link>
      <pubDate>Fri, 28 Aug 2026 09:00:00 +0000</pubDate>
      <description>plain text</description>
    </item>
    <item>
      <title>Broken entry without link</title>
      <pubDate>Thu, 27 Aug 2026 09:00:00 +0000</pubDate>
    </item>
  </channel>
</rss>`

const ATOM_SAMPLE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>An atom entry</title>
    <link rel="alternate" href="https://example.com/atom-1"/>
    <published>2026-08-29T08:00:00Z</published>
    <summary>atom summary &amp; more</summary>
  </entry>
</feed>`

describe('parseFeed', () => {
  it('parses RSS items with CDATA titles, entities, and media images', () => {
    const entries = parseFeed(RSS_SAMPLE, 10)
    expect(entries).toHaveLength(2) // the link-less item is dropped
    const first = entries[0]!
    expect(first.title).toBe('DeepSeek 发布新模型')
    expect(first.link).toBe('https://www.qbitai.com/2026/08/1.html')
    expect(first.summary).toContain('今天 & 明天')
    expect(first.image).toBe('https://img.example.com/a.jpg')
    expect(first.publishedAt).toBeGreaterThan(0)
  })

  it('parses Atom entries with attribute links', () => {
    const entries = parseFeed(ATOM_SAMPLE, 10)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.link).toBe('https://example.com/atom-1')
    expect(entries[0]!.summary).toContain('& more')
  })

  it('honors the entry cap', () => {
    expect(parseFeed(RSS_SAMPLE, 1)).toHaveLength(1)
  })

  it('returns empty for non-feed documents', () => {
    expect(parseFeed('<html><body>not a feed</body></html>', 10)).toEqual([])
  })
})

describe('parseFeedDate', () => {
  it('parses rfc822 and iso dates', () => {
    expect(parseFeedDate('Sat, 29 Aug 2026 10:00:00 +0000')).toBe(Date.parse('2026-08-29T10:00:00Z'))
    expect(parseFeedDate('2026-08-29T08:00:00Z')).toBe(Date.parse('2026-08-29T08:00:00Z'))
  })

  it('returns 0 for missing or garbage dates', () => {
    expect(parseFeedDate(undefined)).toBe(0)
    expect(parseFeedDate('not a date')).toBe(0)
  })
})

describe('stripMarkup', () => {
  it('strips tags, cdata wrappers, and decodes entities', () => {
    expect(stripMarkup('<p>Hello&nbsp;&amp; <b>world</b></p>')).toBe('Hello & world')
    expect(stripMarkup('<![CDATA[DeepSeek 发布]]>')).toBe('DeepSeek 发布')
    expect(stripMarkup('&#x4f60;&#22909;')).toBe('你好')
  })
})
