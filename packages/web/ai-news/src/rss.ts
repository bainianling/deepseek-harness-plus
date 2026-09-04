/**
 * Minimal tolerant RSS 2.0 / Atom parser for editorial AI feeds. Regex-based
 * on purpose: feeds ship malformed entities, CDATA, and namespace soup that a
 * strict parser rejects; the news panel only needs title/link/date/text/image.
 * @module @deepseek-ai/dsh-ai-news/rss
 */

/** One parsed feed entry before platform mapping. */
export interface ParsedFeedEntry {
  title: string
  link: string
  /** Epoch milliseconds, or 0 when the feed gives no parsable date. */
  publishedAt: number
  summary: string
  image?: string
}

/** Decode XML character references and strip remaining tags. */
export function stripMarkup(input: string): string {
  return input
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#0?39;/gu, '\'')
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/\s+/gu, ' ')
    .trim()
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/** First match of a tag's inner content (handles attributes and CDATA). */
function tagValue(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'iu').exec(block)
  return match?.[1]?.trim()
}

/** Attribute-style link (Atom `<link href="...">`) fallback. */
function atomLink(block: string): string | undefined {
  const alternate = /<link[^>]*\brel="alternate"[^>]*\bhref="([^"]+)"/iu.exec(block)
  if (alternate !== null) return alternate[1]
  const plain = /<link[^>]*\bhref="([^"]+)"/iu.exec(block)
  if (plain !== null) return plain[1]
  return undefined
}

/** First image URL in a content block (media tags first, then inline img). */
function findImage(block: string): string | undefined {
  const mediaContent = /<media:content[^>]*\burl="([^"]+)"/iu.exec(block)
  if (mediaContent !== null) return mediaContent[1]
  const enclosure = /<enclosure[^>]*\burl="([^"]+)"[^>]*\btype="image\/[^"]+"/iu.exec(block)
    ?? /<enclosure[^>]*\btype="image\/[^"]+"[^>]*\burl="([^"]+)"/iu.exec(block)
  if (enclosure !== null) return enclosure[1]
  const mediaThumbnail = /<media:thumbnail[^>]*\burl="([^"]+)"/iu.exec(block)
  if (mediaThumbnail !== null) return mediaThumbnail[1]
  const inlineImg = /<img[^>]*\bsrc="([^"]+)"/iu.exec(block)
  if (inlineImg !== null) return inlineImg[1]
  return undefined
}

/** Parse one pubDate/published string to epoch milliseconds (0 on failure). */
export function parseFeedDate(value: string | undefined): number {
  if (value === undefined || value === '') return 0
  const timestamp = Date.parse(stripMarkup(value))
  return Number.isNaN(timestamp) ? 0 : timestamp
}

/** Parse one RSS/Atom document into entries (empty array when nothing parses). */
export function parseFeed(xml: string, maxEntries: number): ParsedFeedEntry[] {
  const itemBlocks = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/giu) ?? []
  const entryBlocks = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/giu) ?? []
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks
  const isAtom = itemBlocks.length === 0 && entryBlocks.length > 0
  const entries: ParsedFeedEntry[] = []
  for (const block of blocks) {
    if (entries.length >= maxEntries) break
    const rawTitle = tagValue(block, 'title')
    const title = rawTitle === undefined ? '' : stripMarkup(rawTitle)
    let link = tagValue(block, 'link')
    if (link !== undefined && /^<|^$/u.test(link.trim())) link = undefined
    if ((link === undefined || link === '') && isAtom) link = atomLink(block)
    if (link !== undefined) link = stripMarkup(link)
    if (title === '' || link === undefined || link === '' || !/^https?:\/\//u.test(link)) continue
    const dateSource = tagValue(block, 'pubDate') ?? tagValue(block, 'published') ?? tagValue(block, 'updated') ?? tagValue(block, 'dc:date')
    const summarySource = tagValue(block, 'description')
      ?? tagValue(block, 'content:encoded')
      ?? tagValue(block, 'content')
      ?? tagValue(block, 'summary')
      ?? ''
    const image = findImage(block)
    entries.push({
      title,
      link,
      publishedAt: parseFeedDate(dateSource),
      summary: stripMarkup(summarySource).slice(0, 300),
      ...(image === undefined ? {} : { image }),
    })
  }
  return entries
}
