/** X syndication page parsing and tweet shaping. */

import { describe, expect, it } from 'vitest'
import { parseSyndicationPage, parseTweetDate, tweetTitle } from '../src/crawlers/twitter.ts'

const NEXT_DATA_PAGE = `<html><body>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"timeline":{"entries":[
  {"content":{"tweet":{"id_str":"1","full_text":"Announcing our new model\\nMore details soon","created_at":"Sat Aug 29 10:00:00 +0000 2026","entities":{"media":[{"media_url_https":"https://pbs.twimg.com/media/a.jpg"}]},"user":{"name":"OpenAI","screen_name":"OpenAI"}}}},
  {"content":{"tweet":{"id_str":"2","full_text":"@someone a reply","created_at":"Sat Aug 29 09:00:00 +0000 2026","entities":{},"user":{"name":"OpenAI","screen_name":"OpenAI"}}}},
  {"content":{"tweet":{"id_str":"3","full_text":"Old tweet","created_at":"Mon Aug 01 09:00:00 +0000 2026","entities":{},"user":{"name":"OpenAI","screen_name":"OpenAI"}}}}
]}}}}</script>
</body></html>`

describe('parseSyndicationPage', () => {
  it('extracts timeline entries from __NEXT_DATA__', () => {
    const data = parseSyndicationPage(NEXT_DATA_PAGE)
    expect(data?.props?.pageProps?.timeline?.entries).toHaveLength(3)
  })

  it('returns undefined without the data script', () => {
    expect(parseSyndicationPage('<html></html>')).toBeUndefined()
  })

  it('returns undefined for broken json', () => {
    expect(parseSyndicationPage('<script id="__NEXT_DATA__" type="application/json">{broken</script>')).toBeUndefined()
  })
})

describe('parseTweetDate', () => {
  it('parses the twitter date format', () => {
    expect(parseTweetDate('Sat Aug 29 10:00:00 +0000 2026')).toBe(Date.parse('2026-08-29T10:00:00Z'))
    expect(parseTweetDate(undefined)).toBe(0)
    expect(parseTweetDate('garbage')).toBe(0)
  })
})

describe('tweetTitle', () => {
  it('takes the first line and truncates long ones', () => {
    expect(tweetTitle('First line\nSecond line')).toBe('First line')
    expect(tweetTitle('x'.repeat(120))).toHaveLength(81)
    expect(tweetTitle('x'.repeat(120)).endsWith('…')).toBe(true)
  })
})
