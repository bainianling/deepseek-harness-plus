/** Row-config coercion. */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('fills every default from an empty config', () => {
    const config = resolveConfig({})
    expect(config.enabled).toBe(true)
    expect(config.intervalHours).toBe(24)
    expect(config.maxItems).toBe(400)
    expect(config.platforms).toEqual(['bilibili', 'douyin', 'xiaohongshu', 'x', 'rss'])
    expect(config.xAccounts).toContain('OpenAI')
    expect(config.proxy).toBe('')
    expect(config.dataDir.endsWith('ai-news')).toBe(true)
    expect(config.translateEnabled).toBe(true)
    expect(config.translateApiKeyEnv).toBe('DASHSCOPE_API_KEY')
    expect(config.translateBaseUrl).toContain('dashscope')
    expect(config.translateModel).toBe('qwen-turbo')
    expect(config.translateMaxPerCrawl).toBe(80)
  })

  it('accepts explicit overrides', () => {
    const config = resolveConfig({ enabled: false, intervalHours: 6, maxItems: 10, proxy: 'http://127.0.0.1:7897', platforms: ['bilibili'] })
    expect(config.enabled).toBe(false)
    expect(config.intervalHours).toBe(6)
    expect(config.maxItems).toBe(10)
    expect(config.proxy).toBe('http://127.0.0.1:7897')
    expect(config.platforms).toEqual(['bilibili'])
  })

  it('coerces the translation overrides', () => {
    const config = resolveConfig({
      translateEnabled: false,
      translateApiKeyEnv: 'MY_KEY',
      translateBaseUrl: 'https://example.com/v1/chat/completions',
      translateModel: 'qwen-plus',
      translateMaxPerCrawl: 5,
    })
    expect(config.translateEnabled).toBe(false)
    expect(config.translateApiKeyEnv).toBe('MY_KEY')
    expect(config.translateBaseUrl).toBe('https://example.com/v1/chat/completions')
    expect(config.translateModel).toBe('qwen-plus')
    expect(config.translateMaxPerCrawl).toBe(5)
    // invalid baseUrl falls back to the default
    expect(resolveConfig({ translateBaseUrl: 'not-a-url' }).translateBaseUrl).toContain('dashscope')
  })

  it('treats proxy=none as disabled and unknown platforms as all', () => {
    const config = resolveConfig({ proxy: 'none', platforms: ['myspace'] })
    expect(config.proxy).toBe('none')
    expect(config.platforms).toHaveLength(5)
  })

  it('survives non-object input', () => {
    const config = resolveConfig(undefined)
    expect(config.enabled).toBe(true)
    expect(resolveConfig('nonsense').maxItems).toBe(400)
  })

  it('rejects non-positive numbers in favor of defaults', () => {
    const config = resolveConfig({ intervalHours: -3, maxItems: 0, crawlTimeoutMs: Number.NaN })
    expect(config.intervalHours).toBe(24)
    expect(config.maxItems).toBe(400)
    expect(config.crawlTimeoutMs).toBe(300_000)
  })
})
