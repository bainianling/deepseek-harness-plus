/**
 * Automatic English→Chinese translation for crawled items, over any
 * OpenAI-compatible chat completions endpoint (DashScope by default, key
 * read from the configured environment variable). Batched JSON prompting:
 * one request carries up to fifteen items and returns an indexed array, so
 * a crawl pays only a handful of round trips. Failures never fail the
 * crawl — untranslated items simply keep their original text and are
 * retried on the next run.
 * @module @deepseek-ai/dsh-ai-news/translate
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { fetchDirect } from './http.ts'
import type { ResolvedConfig } from './types.ts'
import type { NewsItem } from './types.ts'

/** Items sent per translation request. */
export const TRANSLATE_BATCH_SIZE = 15

/** Input truncation limits (keeps prompts small; cards clip anyway). */
const TITLE_LIMIT = 160
const SUMMARY_LIMIT = 400

/** Minimal logger shape (the crawl orchestrator provides it). */
export interface TranslateLogger {
  info(message: string): void
  warn(error: Error): void
}

/**
 * Whether a text is English-enough to deserve translation: mostly Latin
 * letters and almost no CJK ideographs.
 */
export function needsTranslation(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  let latin = 0
  let cjk = 0
  let other = 0
  for (const char of trimmed) {
    if (/[A-Za-z]/u.test(char)) latin += 1
    else if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(char)) cjk += 1
    else other += 1
  }
  const significant = latin + cjk
  if (significant === 0) return false
  if (cjk > 0 && cjk / significant >= 0.2) return false
  return latin / significant >= 0.6 && latin + other >= 8
}

/** Whether an item still needs a translation pass. */
export function itemNeedsTranslation(item: NewsItem): boolean {
  const titleMissing = needsTranslation(item.title)
    && (item.translatedTitle === undefined || item.translatedTitle === '')
  const summaryMissing = needsTranslation(item.summary)
    && (item.translatedSummary === undefined || item.translatedSummary === '')
  return titleMissing || summaryMissing
}

/** One entry in the translation prompt/answer arrays. */
export interface TranslateEntry {
  i: number
  title: string
  summary: string
}

/** Build the chat prompt for one batch. */
export function buildTranslatePrompt(entries: readonly TranslateEntry[]): string {
  return '你是专业翻译引擎。下面 JSON 数组里每条包含英文的 title 和 summary，请把两者翻译成简体中文。'
    + '要求：保持编号 i 不变；语义准确流畅；产品名、公司名、人名、模型名等专有名词可保留英文；不要添加解释。'
    + `只输出一个 JSON 数组，格式为 [{"i":0,"title":"...","summary":"..."}]。输入：\n${JSON.stringify(entries)}`
}

/** Extract the translated JSON array from a model answer (tolerates code fences). */
export function parseTranslateResponse(text: string): TranslateEntry[] {
  const cleaned = text.replace(/```(?:json)?/gu, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('translate: no JSON array in model response')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
  if (!Array.isArray(parsed)) throw new Error('translate: model response is not an array')
  const entries: TranslateEntry[] = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue
    const candidate = row as Record<string, unknown>
    if (typeof candidate.i !== 'number') continue
    entries.push({
      i: candidate.i,
      title: typeof candidate.title === 'string' ? candidate.title.trim() : '',
      summary: typeof candidate.summary === 'string' ? candidate.summary.trim() : '',
    })
  }
  return entries
}

interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

interface ChatChoice {
  message?: { content?: string }
}

interface ChatResponse {
  choices?: ChatChoice[]
}

/** Minimal Harness LLM runtime used by the translator. */
export interface TranslationLlm {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

/** Current default model selection supplied by the host. */
export interface TranslationModelSelection {
  provider: string
  model: string
}

/** Optional Harness model route; undefined keeps the direct API fallback. */
export interface TranslationRuntime {
  llm?: TranslationLlm
  model?: TranslationModelSelection
}

/** Applies translations to crawl items in batches. */
export class Translator {
  /** Set once the configured env var is observed to be empty. */
  private keyMissingLogged = false

  constructor(
    private readonly config: ResolvedConfig,
    private readonly logger: TranslateLogger,
    private readonly runtime: TranslationRuntime = {},
  ) {}

  /**
   * Translate every eligible item (mutates their translated* fields).
   * @param items - the full store slice eligible for translation.
   * @param signal - crawl abort signal.
   * @returns how many items received a translation in this pass.
   */
  async translate(
    items: NewsItem[],
    signal: AbortSignal,
    onProgress?: () => Promise<void>,
  ): Promise<number> {
    if (!this.config.translateEnabled) return 0
    const candidates = items.filter(itemNeedsTranslation).slice(0, this.config.translateMaxPerCrawl)
    if (candidates.length === 0) return 0
    const apiKey = process.env[this.config.translateApiKeyEnv]?.trim()
    const hasHarnessRoute = this.runtime.llm !== undefined && this.runtime.model !== undefined
    if (!hasHarnessRoute && (apiKey === undefined || apiKey === '')) {
      if (!this.keyMissingLogged) {
        this.keyMissingLogged = true
        this.logger.info(`ai-news: translation skipped — no Harness model route and env ${this.config.translateApiKeyEnv} is not set`)
      }
      return 0
    }
    let translated = 0
    for (let start = 0; start < candidates.length; start += TRANSLATE_BATCH_SIZE) {
      if (signal.aborted) break
      const batch = candidates.slice(start, start + TRANSLATE_BATCH_SIZE)
      try {
        const applied = hasHarnessRoute
          ? await this.translateBatchWithHarness(batch, signal)
          : await this.translateBatchWithApi(batch, apiKey ?? '', signal)
        translated += applied
        if (applied > 0) await onProgress?.()
      } catch (error) {
        this.logger.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (translated > 0) this.logger.info(`ai-news: translated ${String(translated)}/${String(candidates.length)} item(s) into Chinese`)
    return translated
  }

  private entriesOf(batch: NewsItem[]): TranslateEntry[] {
    return batch.map((item, index) => ({
      i: index,
      title: truncate(item.title, TITLE_LIMIT),
      summary: truncate(item.summary, SUMMARY_LIMIT),
    }))
  }

  private async translateBatchWithHarness(batch: NewsItem[], signal: AbortSignal): Promise<number> {
    const llm = this.runtime.llm
    const model = this.runtime.model
    if (llm === undefined || model === undefined) throw new Error('translate: Harness model route unavailable')
    const prompt = buildTranslatePrompt(this.entriesOf(batch))
    const options: GenerateOptions = {
      provider: model.provider,
      model: model.model,
      system: '你是一名严谨的英中科技新闻翻译。只输出请求要求的 JSON。',
      messages: [createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'dsh-ai-news' },
      })],
      temperature: 0.2,
      maxTokens: 4_096,
      signal,
    }
    let content = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') content += chunk.text
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new Error(`translate: Harness model ${chunk.reason.kind}: ${chunk.reason.failure.message}`)
      }
    }
    if (content.trim() === '') throw new Error('translate: Harness model returned no text')
    return this.applyAnswers(batch, parseTranslateResponse(content))
  }

  private async translateBatchWithApi(batch: NewsItem[], apiKey: string, signal: AbortSignal): Promise<number> {
    const body = JSON.stringify({
      model: this.config.translateModel,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是一名严谨的英中科技新闻翻译。' } satisfies ChatMessage,
        { role: 'user', content: buildTranslatePrompt(this.entriesOf(batch)) } satisfies ChatMessage,
      ],
    })
    const response = await fetchDirect(this.config.translateBaseUrl, {
      timeoutMs: 90_000,
      signal,
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
    })
    if (response.status !== 200) {
      throw new Error(`translate: chat completions http ${String(response.status)} (${response.text().slice(0, 160)})`)
    }
    const parsed = JSON.parse(response.text()) as ChatResponse
    const content = parsed.choices?.[0]?.message?.content
    if (content === undefined || content === '') throw new Error('translate: empty model content')
    return this.applyAnswers(batch, parseTranslateResponse(content))
  }

  private applyAnswers(batch: NewsItem[], answers: readonly TranslateEntry[]): number {
    let applied = 0
    for (const answer of answers) {
      const item = batch[answer.i]
      if (item === undefined) continue
      const beforeTitle = item.translatedTitle
      const beforeSummary = item.translatedSummary
      if (answer.title !== '' && needsTranslation(item.title)) item.translatedTitle = answer.title
      if (answer.summary !== '' && needsTranslation(item.summary)) item.translatedSummary = answer.summary
      if (item.translatedTitle !== beforeTitle || item.translatedSummary !== beforeSummary) applied += 1
    }
    return applied
  }
}

/** Truncate one text with an ellipsis marker. */
export function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
