/**
 * Configuration normalization for the ai-news plugin. The row config arrives
 * as raw YAML-decoded JSON; this module coerces it defensively so a partial
 * or malformed override never blocks activation.
 * @module @deepseek-ai/dsh-ai-news/config
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { NEWS_PLATFORMS, type NewsPlatform, type ResolvedConfig } from './types.ts'

/** Built-in AI relevance keywords (ASCII words match on word boundaries). */
export const BUILTIN_AI_KEYWORDS: readonly string[] = [
  'AI', 'AGI', 'AIGC', 'LLM', 'GPT', 'ChatGPT', 'Claude', 'Gemini', 'DeepSeek', 'OpenAI', 'Anthropic',
  'Midjourney', 'Sora', 'Transformer', 'Copilot', 'Diffusion', 'Stable Diffusion',
  '人工智能', '大模型', '机器学习', '深度学习', '神经网络', '智能体', '多模态', '生成式',
  '扩散模型', '具身智能', '世界模型', '推理模型', '开源模型', '算力', '机器人', '自动驾驶',
  '微调', '提示词', '豆包', '通义', '文心', '智谱', 'GLM', 'Kimi', '混元', '盘古',
]

/** Default X accounts followed through the syndication timeline endpoint. */
export const DEFAULT_X_ACCOUNTS: readonly string[] = [
  'OpenAI', 'AnthropicAI', 'GoogleDeepMind', 'xai', 'karpathy', 'sama', 'DeepSeek_AI', 'MistralAI',
]

const DEFAULT_INTERVAL_HOURS = 24
const DEFAULT_MAX_ITEMS = 400
const DEFAULT_CRAWL_TIMEOUT_MS = 300_000
const DEFAULT_MAX_IMAGE_BYTES = 1_572_864
const DEFAULT_MAX_AGE_DAYS = 7
const DEFAULT_TRANSLATE_API_KEY_ENV = 'DASHSCOPE_API_KEY'
const DEFAULT_TRANSLATE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
const DEFAULT_TRANSLATE_MODEL = 'qwen-turbo'
const DEFAULT_TRANSLATE_MAX_PER_CRAWL = 80

/** The default store root: `$DSH_HOME` (or `~/.dsh`) plus `data/ai-news`. */
export function defaultDataDir(): string {
  const envHome = process.env.DSH_HOME
  const home = envHome !== undefined && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return resolve(home, 'data', 'ai-news')
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(entry.trim())
  }
  return out
}

function asPlatforms(value: unknown): NewsPlatform[] {
  const list = asStringArray(value)
  if (list === undefined) return [...NEWS_PLATFORMS]
  const selected = list.filter((entry): entry is NewsPlatform => (NEWS_PLATFORMS as readonly string[]).includes(entry))
  return selected.length > 0 ? selected : [...NEWS_PLATFORMS]
}

/**
 * Coerce a raw row config into a fully-populated {@link ResolvedConfig}.
 * @param raw - the unvalidated config object from the composition row.
 * @returns normalized configuration with every field present.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const proxyRaw = typeof source.proxy === 'string' ? source.proxy.trim() : ''
  return {
    enabled: asBoolean(source.enabled, true),
    intervalHours: asPositiveNumber(source.intervalHours, DEFAULT_INTERVAL_HOURS),
    maxItems: Math.floor(asPositiveNumber(source.maxItems, DEFAULT_MAX_ITEMS)),
    dataDir: typeof source.dataDir === 'string' && source.dataDir.trim() !== ''
      ? resolve(source.dataDir.trim())
      : defaultDataDir(),
    proxy: proxyRaw.toLowerCase() === 'none' ? 'none' : proxyRaw,
    platforms: asPlatforms(source.platforms),
    xAccounts: asStringArray(source.xAccounts) ?? [...DEFAULT_X_ACCOUNTS],
    keywords: asStringArray(source.keywords) ?? [],
    crawlTimeoutMs: Math.floor(asPositiveNumber(source.crawlTimeoutMs, DEFAULT_CRAWL_TIMEOUT_MS)),
    maxImageBytes: Math.floor(asPositiveNumber(source.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)),
    maxAgeDays: asPositiveNumber(source.maxAgeDays, DEFAULT_MAX_AGE_DAYS),
    translateEnabled: asBoolean(source.translateEnabled, true),
    translateApiKeyEnv: typeof source.translateApiKeyEnv === 'string' && source.translateApiKeyEnv.trim() !== ''
      ? source.translateApiKeyEnv.trim()
      : DEFAULT_TRANSLATE_API_KEY_ENV,
    translateBaseUrl: typeof source.translateBaseUrl === 'string' && /^https?:\/\//u.test(source.translateBaseUrl)
      ? source.translateBaseUrl.trim()
      : DEFAULT_TRANSLATE_BASE_URL,
    translateModel: typeof source.translateModel === 'string' && source.translateModel.trim() !== ''
      ? source.translateModel.trim()
      : DEFAULT_TRANSLATE_MODEL,
    translateMaxPerCrawl: Math.floor(asPositiveNumber(source.translateMaxPerCrawl, DEFAULT_TRANSLATE_MAX_PER_CRAWL)),
  }
}
