/** Translation heuristics and response parsing. */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { buildTranslatePrompt, itemNeedsTranslation, needsTranslation, parseTranslateResponse, Translator, truncate } from '../src/translate.ts'
import type { NewsItem } from '../src/types.ts'

function itemOf(overrides: Partial<NewsItem>): NewsItem {
  return {
    id: 'x:1',
    platform: 'x',
    title: 't',
    summary: 's',
    link: 'https://example.com/',
    publishedAt: 1,
    crawledAt: 1,
    aiScore: 0,
    ...overrides,
  }
}

describe('needsTranslation', () => {
  it('flags plain English text', () => {
    expect(needsTranslation('OpenAI releases a new model today')).toBe(true)
    expect(needsTranslation('Claude can reliably fix measurable misalignment.')).toBe(true)
  })

  it('rejects Chinese text', () => {
    expect(needsTranslation('国产大模型集体上新')).toBe(false)
    expect(needsTranslation('AI 改变世界')).toBe(false) // CJK ratio above threshold
  })

  it('rejects empty, numeric, and short-noise text', () => {
    expect(needsTranslation('')).toBe(false)
    expect(needsTranslation('   ')).toBe(false)
    expect(needsTranslation('12345 67890')).toBe(false)
    expect(needsTranslation('ok hi')).toBe(false)
  })

  it('accepts mixed text that is dominantly English', () => {
    expect(needsTranslation('DeepSeek 新模型 released with 1M context')).toBe(true)
  })
})

describe('itemNeedsTranslation', () => {
  it('continues when the title is translated but the English summary is not', () => {
    expect(itemNeedsTranslation(itemOf({
      title: 'English title here',
      summary: 'English summary remains here',
      translatedTitle: '英文标题',
    }))).toBe(true)
    expect(itemNeedsTranslation(itemOf({
      title: 'English title here',
      summary: 'English summary remains here',
      translatedTitle: '英文标题',
      translatedSummary: '英文摘要',
    }))).toBe(false)
  })

  it('selects English items without translations', () => {
    expect(itemNeedsTranslation(itemOf({ title: 'English title here', summary: '' }))).toBe(true)
    expect(itemNeedsTranslation(itemOf({ title: '中文标题党', summary: '中文摘要内容' }))).toBe(false)
  })
})

describe('buildTranslatePrompt', () => {
  it('embeds the batch JSON with indices', () => {
    const prompt = buildTranslatePrompt([{ i: 0, title: 'Hello', summary: 'World' }])
    expect(prompt).toContain('[{"i":0,"title":"Hello","summary":"World"}]')
    expect(prompt).toContain('JSON 数组')
  })
})

describe('parseTranslateResponse', () => {
  it('parses a clean array', () => {
    const entries = parseTranslateResponse('[{"i":0,"title":"你好","summary":"世界"}]')
    expect(entries).toEqual([{ i: 0, title: '你好', summary: '世界' }])
  })

  it('tolerates code fences and surrounding prose', () => {
    const entries = parseTranslateResponse('好的，翻译如下：\n```json\n[{"i":0,"title":"你好","summary":"世界"}]\n```\n以上。')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.title).toBe('你好')
  })

  it('drops rows without an index and keeps valid ones', () => {
    const entries = parseTranslateResponse('[{"title":"孤儿"},{"i":1,"title":"有效"},{"i":"x","title":"坏索引"}]')
    expect(entries).toEqual([{ i: 1, title: '有效', summary: '' }])
  })

  it('throws on non-array output', () => {
    expect(() => parseTranslateResponse('我没有输出')).toThrow()
    expect(() => parseTranslateResponse('{"i":0}')).toThrow()
  })
})

describe('Translator', () => {
  it('uses the Harness default model route without an environment API key', async () => {
    const requests: GenerateOptions[] = []
    const llm = {
      async *stream(options: GenerateOptions) {
        requests.push(options)
        yield { type: 'text-delta' as const, index: 0, text: '[{"i":0,"title":"OpenAI 发布新模型","summary":"该模型提升了推理能力"}]' }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    }
    const logger = { info: vi.fn(), warn: vi.fn() }
    const translator = new Translator(resolveConfig({}), logger, {
      llm,
      model: { provider: 'configured-provider', model: 'configured-model' },
    })
    const news = itemOf({
      title: 'OpenAI releases a new model',
      summary: 'The model improves reasoning capabilities.',
    })
    const persisted = vi.fn(() => Promise.resolve())
    const translated = await translator.translate([news], new AbortController().signal, persisted)

    expect(translated).toBe(1)
    expect(news.translatedTitle).toBe('OpenAI 发布新模型')
    expect(news.translatedSummary).toBe('该模型提升了推理能力')
    expect(requests[0]).toMatchObject({ provider: 'configured-provider', model: 'configured-model' })
    expect(persisted).toHaveBeenCalledOnce()
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('truncate', () => {
  it('cuts long text with an ellipsis', () => {
    expect(truncate('x'.repeat(200), 160)).toHaveLength(161)
    expect(truncate('short', 160)).toBe('short')
  })
})
