/**
 * Read-only public developer-tool catalog for the Web skill market.
 *
 * The market deliberately returns metadata and install commands only. It never
 * installs, imports, or executes a discovered artifact. Upstream failures are
 * isolated and the small first-party baseline keeps the UI useful offline.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export type MarketKind = 'skill' | 'mcp' | 'dsh-plugin'
export type MarketCategory = 'all' | MarketKind
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown'

export interface MarketRisk {
  level: RiskLevel
  confidence: 'declared' | 'metadata' | 'static' | 'insufficient'
  rationale: string
  signals: string[]
}

export interface MarketItem {
  id: string
  kind: MarketKind
  name: string
  publisher: string
  description: string
  originalDescription?: string
  sourceUrl: string
  codeUrl: string
  registry: string
  publishedAt: string | null
  updatedAt: string | null
  stars: number | null
  language: string | null
  license: string | null
  install: string
  risk: MarketRisk
  tags: string[]
}

export interface MarketTranslationStatus {
  /** 'model' = 已用当前 DSH 模型路由翻译；'none' = 无可用模型，仅词典归一化。 */
  engine: 'model' | 'none'
  /** Items whose description reads as Chinese (native or translated). */
  translated: number
  /** Items whose original English summary is still untranslated. */
  pending: number
}

export interface MarketCatalog {
  items: MarketItem[]
  sources: Array<{ id: string; label: string; url: string; status: 'online' | 'offline'; count: number; error?: string }>
  fetchedAt: string
  cached: boolean
  translation: MarketTranslationStatus
}

/** Minimal Harness LLM runtime surface used for catalog translation. */
export interface MarketLlm { stream(options: GenerateOptions): AsyncIterable<StreamChunk> }
/** Current default model selection supplied by the host. */
export interface MarketModelSelection { provider: string; model: string }

interface GithubRepository {
  full_name?: unknown
  html_url?: unknown
  description?: unknown
  owner?: { login?: unknown }
  created_at?: unknown
  updated_at?: unknown
  pushed_at?: unknown
  stargazers_count?: unknown
  language?: unknown
  license?: { spdx_id?: unknown; name?: unknown } | null
  topics?: unknown
  default_branch?: unknown
  archived?: unknown
}

interface GithubSearchResponse { items?: GithubRepository[] }
interface RegistryServerInfo {
  name?: unknown
  title?: unknown
  description?: unknown
  version?: unknown
  websiteUrl?: unknown
  repository?: { url?: unknown; source?: unknown } | null
  packages?: Array<{ registryType?: unknown; identifier?: unknown; version?: unknown; transport?: unknown }>
  remotes?: Array<{ type?: unknown; url?: unknown }>
}
interface RegistryEntry {
  server?: RegistryServerInfo
  _meta?: { 'io.modelcontextprotocol.registry/official'?: { publishedAt?: unknown; updatedAt?: unknown; isLatest?: unknown } }
}
interface RegistryResponse { servers?: RegistryEntry[] }
interface RegistryPage extends RegistryResponse { metadata?: { nextCursor?: unknown } }
interface NpmSearchResponse { objects?: Array<{ package?: { name?: unknown; description?: unknown; version?: unknown; date?: unknown; links?: { npm?: unknown; homepage?: unknown; repository?: unknown } } }> }

/** One GitHub topic search feeding the catalog. */
interface GithubQuery { q: string; kind: MarketKind; label: string }

/**
 * The GitHub topic queries behind the market. Each returns up to 100 of the
 * most recently updated repositories, so the catalog tracks the live edges
 * of every ecosystem instead of a single narrow topic.
 */
const GITHUB_QUERIES: readonly GithubQuery[] = [
  { q: 'topic:agent-skills', kind: 'skill', label: 'GitHub / Agent Skills' },
  { q: 'topic:claude-skills', kind: 'skill', label: 'GitHub / Claude Skills' },
  { q: 'topic:codex-skills', kind: 'skill', label: 'GitHub / Codex Skills' },
  { q: 'topic:dsh-plugin', kind: 'dsh-plugin', label: 'GitHub / DSH Plugins' },
  { q: 'topic:deepseek-harness', kind: 'dsh-plugin', label: 'GitHub / DeepSeek Harness' },
  { q: 'topic:mcp-server', kind: 'mcp', label: 'GitHub / MCP Servers' },
]

/** npm searches behind the DSH plugin column. */
const NPM_QUERIES: ReadonlyArray<{ text: string; size: number; label: string }> = [
  { text: '@deepseek-ai/dsh', size: 50, label: 'npm / 官方包' },
  { text: 'dsh-plugin', size: 100, label: 'npm / 社区包' },
]

const FETCH_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 10 * 60_000
/** Background re-crawl cadence: the catalog stays fresh without user action. */
const AUTO_REFRESH_MS = 30 * 60_000
const TRANSLATE_BATCH_SIZE = 15
const TRANSLATE_MAX_PER_BUILD = 900
const TRANSLATION_STORE_MAX = 4000
/** Placeholder shown until an English summary is machine-translated. */
const FALLBACK_UNTRANSLATED = '该项目的英文摘要暂未完成翻译，请打开原项目地址查看详细说明。'
let cache: { at: number; catalog: MarketCatalog } | undefined
let marketCtx: Context | undefined
let translationStore: Map<string, string> | undefined
let refreshing = false
let building: Promise<MarketCatalog> | undefined

const BASELINE: MarketItem[] = [
  {
    id: 'skill:vercel-labs/skills/find-skills', kind: 'skill', name: 'find-skills', publisher: 'vercel-labs',
    description: '帮助 Agent 搜索、比较和安装可用技能，适合作为技能市场的入口工具。',
    sourceUrl: 'https://skills.sh/vercel-labs/skills/find-skills', codeUrl: 'https://github.com/vercel-labs/skills/tree/main/skills/find-skills',
    registry: 'skills.sh', publishedAt: null, updatedAt: null, stars: null, language: null, license: null,
    install: 'npx skills add vercel-labs/skills@find-skills', risk: { level: 'low', confidence: 'declared', rationale: '目录型提示词技能，未声明宿主命令、凭据读取或任意网络能力。', signals: ['纯提示词 / 文档'] },
    tags: ['discovery', 'workflow'],
  },
  {
    id: 'skill:anthropics/skills/frontend-design', kind: 'skill', name: 'frontend-design', publisher: 'anthropics',
    description: '为 Agent 提供前端界面设计与实现指导，覆盖布局、视觉层级和交互质量。',
    sourceUrl: 'https://skills.sh/anthropics/skills/frontend-design', codeUrl: 'https://github.com/anthropics/skills/tree/main/skills/frontend-design',
    registry: 'skills.sh', publishedAt: null, updatedAt: null, stars: null, language: null, license: null,
    install: 'npx skills add anthropics/skills@frontend-design', risk: { level: 'low', confidence: 'declared', rationale: '以指导文本为主，能力边界取决于宿主 Agent 实际授予的工具。', signals: ['纯提示词 / 文档'] },
    tags: ['frontend', 'design'],
  },
  {
    id: 'mcp:io.modelcontextprotocol.registry/filesystem', kind: 'mcp', name: 'Filesystem MCP', publisher: 'Model Context Protocol',
    description: '通过 MCP 暴露受限文件系统操作。使用前应核对允许的根目录和读写工具集合。',
    sourceUrl: 'https://registry.modelcontextprotocol.io/', codeUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    registry: 'MCP Registry', publishedAt: null, updatedAt: null, stars: null, language: 'TypeScript', license: 'MIT',
    install: 'npx -y @modelcontextprotocol/server-filesystem <allowed-directory>', risk: { level: 'medium', confidence: 'metadata', rationale: '安装后可读写用户指定目录，影响范围由启动参数决定。', signals: ['工作区文件读写', '需明确根目录'] },
    tags: ['filesystem', 'official'],
  },
  {
    id: 'mcp:io.modelcontextprotocol.registry/fetch', kind: 'mcp', name: 'Fetch MCP', publisher: 'Model Context Protocol',
    description: '读取网页并转换为适合语言模型处理的内容，适合文档检索和只读研究。',
    sourceUrl: 'https://registry.modelcontextprotocol.io/', codeUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    registry: 'MCP Registry', publishedAt: null, updatedAt: null, stars: null, language: 'Python', license: 'MIT',
    install: 'uvx mcp-server-fetch', risk: { level: 'medium', confidence: 'metadata', rationale: '会发起网络请求；应核对是否允许任意 URL、是否会上传本地内容。', signals: ['网络访问', '目标域名需审查'] },
    tags: ['web', 'research', 'official'],
  },
  {
    id: 'dsh:deepseek-ai/deepseek-harness', kind: 'dsh-plugin', name: 'DeepSeek Harness', publisher: 'deepseek-ai',
    description: 'DSH 官方插件化 Agent 运行时与 Web GUI，提供 Cordis 组合、会话、工具和安全边界。',
    sourceUrl: 'https://github.com/deepseek-ai/deepseek-harness', codeUrl: 'https://github.com/deepseek-ai/deepseek-harness',
    registry: 'GitHub dsh-plugin', publishedAt: null, updatedAt: null, stars: 203742, language: 'TypeScript', license: 'MIT',
    install: 'git clone https://github.com/deepseek-ai/deepseek-harness.git', risk: { level: 'high', confidence: 'static', rationale: '宿主级运行时会组合并执行工具和插件代码，不应按普通 UI 插件处理。', signals: ['宿主代码执行', '工具组合', '可访问本地运行时'] },
    tags: ['runtime', 'official', 'cordis'],
  },
]

function text(value: unknown): string { return typeof value === 'string' ? value : '' }
function integer(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null }
function iso(value: unknown): string | null {
  const raw = text(value)
  if (raw === '') return null
  const time = Date.parse(raw)
  return Number.isNaN(time) ? null : new Date(time).toISOString()
}
function safeUrl(value: unknown, fallback: string): string { const raw = text(value); return /^https?:\/\//u.test(raw) ? raw : fallback }
function slug(value: string): string { return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') }
function repoName(repo: GithubRepository): string { return text(repo.full_name).split('/').at(-1) ?? 'unknown-project' }
function repoPublisher(repo: GithubRepository): string { return text(repo.owner?.login) || text(repo.full_name).split('/')[0] || 'unknown' }
function repoLicense(repo: GithubRepository): string | null { return text(repo.license?.spdx_id) || text(repo.license?.name) || null }
function repoTopics(repo: GithubRepository): string[] { return Array.isArray(repo.topics) ? repo.topics.filter((v): v is string => typeof v === 'string').slice(0, 12) : [] }

/**
 * Translate the compact, recurring vocabulary found in public registries.
 * Long prose is kept verbatim with an explicit marker instead of pretending
 * that a dictionary translation is authoritative.
 */
function translateDescription(value: string): { description: string; originalDescription?: string } {
  if (/[A-Za-z]/u.test(value)) {
    const replacements: Array<[RegExp, string]> = [
      [/\bAI agent skills?\b/giu, 'AI 智能体技能'], [/\bskills?\b/giu, '技能'], [/\bMCP server\b/giu, 'MCP 服务'], [/\bserver\b/giu, '服务'], [/\btools?\b/giu, '工具'], [/\bsearch\b/giu, '搜索'], [/\bworkflow\b/giu, '工作流'], [/\bfrontend\b/giu, '前端'], [/\bdesign\b/giu, '设计'], [/\btesting\b/giu, '测试'], [/\bopen source\b/giu, '开源'], [/\bdeveloper\b/giu, '开发者'], [/\bAI\b/gu, '人工智能'],
    ]
    let translated = value
    for (const [pattern, replacement] of replacements) translated = translated.replace(pattern, replacement)
    return translated === value
      ? { description: FALLBACK_UNTRANSLATED, originalDescription: value }
      : { description: translated, originalDescription: value }
  }
  return { description: value }
}

/** Whether a text is Latin-script enough to deserve a Chinese translation. */
export function needsTranslation(value: string): boolean {
  const trimmed = value.trim()
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

function truncateText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function translationDir(): string {
  const envHome = process.env.DSH_HOME
  const home = envHome !== undefined && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return resolve(home, 'data', 'market')
}

/** Lazily load the persisted original-text → Chinese translation cache. */
function translations(): Map<string, string> {
  if (translationStore !== undefined) return translationStore
  translationStore = new Map()
  try {
    const raw = JSON.parse(readFileSync(join(translationDir(), 'translations.json'), 'utf8')) as Record<string, string>
    const entries = Object.entries(raw).filter(([, value]) => typeof value === 'string').slice(-TRANSLATION_STORE_MAX)
    for (const [key, value] of entries) translationStore.set(key, value)
  } catch { /* first run or unreadable — start empty */ }
  return translationStore
}

function saveTranslations(store: Map<string, string>): void {
  try {
    mkdirSync(translationDir(), { recursive: true })
    const entries = [...store.entries()].slice(-TRANSLATION_STORE_MAX)
    writeFileSync(join(translationDir(), 'translations.json'), JSON.stringify(Object.fromEntries(entries)))
  } catch { /* best-effort persistence */ }
}

function buildMarketTranslatePrompt(entries: ReadonlyArray<{ i: number; d: string }>): string {
  return '你是专业翻译引擎。下面 JSON 数组每条包含开发者工具的英文简介 d，请翻译成简体中文。'
    + '要求：保持编号 i 不变；准确概括核心功能，简洁流畅，每条不超过 120 字；产品名、公司名、模型名等专有名词可保留英文；不要添加解释。'
    + `只输出一个 JSON 数组，格式为 [{"i":0,"d":"..."}]。输入：\n${JSON.stringify(entries)}`
}

/** Extract the translated JSON array from a model answer (tolerates code fences). */
export function parseMarketTranslateResponse(content: string): Array<{ i: number; d: string }> {
  const cleaned = content.replace(/```(?:json)?/gu, '').trim()
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('market translate: no JSON array in model response')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown
  if (!Array.isArray(parsed)) throw new Error('market translate: model response is not an array')
  const answers: Array<{ i: number; d: string }> = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object') continue
    const candidate = row as Record<string, unknown>
    if (typeof candidate.i !== 'number' || typeof candidate.d !== 'string') continue
    const d = candidate.d.trim()
    if (d !== '') answers.push({ i: candidate.i, d })
  }
  return answers
}

async function translateBatchWithModel(batch: MarketItem[], llm: MarketLlm, model: MarketModelSelection): Promise<Array<{ i: number; d: string }>> {
  const entries = batch.map((item, index) => ({ i: index, d: truncateText(item.originalDescription ?? item.description, 400) }))
  const options: GenerateOptions = {
    provider: model.provider,
    model: model.model,
    system: '你是一名严谨的英中科技翻译。只输出请求要求的 JSON。',
    messages: [createUserMessage({
      content: [{ type: 'text', text: buildMarketTranslatePrompt(entries) }],
      source: { kind: 'plugin', plugin: 'dsh-web-app' },
    })],
    temperature: 0.2,
    maxTokens: 4_096,
    signal: AbortSignal.timeout(90_000),
  }
  let content = ''
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'text-delta') content += chunk.text
    if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      throw new Error(`market translate: Harness model ${chunk.reason.kind}`)
    }
  }
  if (content.trim() === '') throw new Error('market translate: Harness model returned no text')
  return parseMarketTranslateResponse(content)
}

/** Resolve the current model route lazily so plugin boot order never matters. */
function resolveTranslationRuntime(): { llm: MarketLlm | undefined; model: MarketModelSelection | undefined } {
  const llm = marketCtx?.get('llm') as MarketLlm | undefined
  const modelService = marketCtx?.get('agentDefaultModel') as { currentSelection?(): MarketModelSelection } | undefined
  let model: MarketModelSelection | undefined
  try { model = modelService?.currentSelection?.() } catch { model = undefined }
  return { llm, model }
}

/** One-by-one translation for items a batch could not deliver. */
async function translateSolo(item: MarketItem, llm: MarketLlm, model: MarketModelSelection, store: Map<string, string>): Promise<void> {
  if (item.originalDescription === undefined) return
  try {
    const solo = await translateBatchWithModel([item], llm, model)
    const answer = solo.find(entry => entry.i === 0)
    if (answer !== undefined && !needsTranslation(answer.d)) {
      item.description = answer.d
      store.set(item.originalDescription, answer.d)
    }
  } catch { /* keep fallback text; retried on the next refresh */ }
}

/** Whether an item still needs a translation pass after batch processing. */
function stillUntranslated(item: MarketItem): boolean {
  return item.description === FALLBACK_UNTRANSLATED || needsTranslation(item.description)
}

/**
 * Translate every still-English description through the cached translation
 * store first, then the current DSH model route in batches. Failures never
 * fail the catalog build — untranslated items keep their fallback text.
 */
export async function applyModelTranslations(items: MarketItem[]): Promise<MarketTranslationStatus> {
  const store = translations()
  const runtime = resolveTranslationRuntime()
  const hasModel = runtime.llm !== undefined && runtime.model !== undefined
  // Gate on the ORIGINAL text: the dictionary pass may have mixed a few
  // Chinese words into an English sentence, which must still be translated.
  const candidates = items.filter(item => item.originalDescription !== undefined && needsTranslation(item.originalDescription)).slice(0, TRANSLATE_MAX_PER_BUILD)
  if (hasModel) {
    const uncached: MarketItem[] = []
    for (const item of candidates) {
      const cached = store.get(item.originalDescription!)
      if (cached !== undefined && cached !== '' && !needsTranslation(cached)) item.description = cached
      else uncached.push(item)
    }
    for (let start = 0; start < uncached.length; start += TRANSLATE_BATCH_SIZE) {
      const batch = uncached.slice(start, start + TRANSLATE_BATCH_SIZE)
      // One immediate retry absorbs transient model hiccups; a second failure
      // leaves the fallback text and the next auto-refresh tries again.
      let answers: Array<{ i: number; d: string }> | undefined
      for (let attempt = 0; attempt < 2 && answers === undefined; attempt++) {
        try {
          answers = await translateBatchWithModel(batch, runtime.llm!, runtime.model!)
        } catch {
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 1_500))
        }
      }
      if (answers === undefined) {
        // A poisoned item (odd characters breaking the JSON answer) would fail
        // its whole batch forever; fall back to one-by-one so only the truly
        // untranslatable item keeps the placeholder.
        for (const item of batch) await translateSolo(item, runtime.llm!, runtime.model!, store)
        continue
      }
      for (const answer of answers) {
        const item = batch[answer.i]
        if (item?.originalDescription === undefined) continue
        if (needsTranslation(answer.d)) continue // the answer must actually be Chinese
        item.description = answer.d
        store.set(item.originalDescription, answer.d)
      }
      // The model sometimes skips or answers English for single rows inside a
      // big batch; give those one quiet second chance each.
      for (const item of batch) {
        if (stillUntranslated(item)) await translateSolo(item, runtime.llm!, runtime.model!, store)
      }
    }
    saveTranslations(store)
  }
  const pending = items.filter(item => item.originalDescription !== undefined && stillUntranslated(item)).length
  return { engine: hasModel ? 'model' : 'none', translated: items.length - pending, pending }
}

function assess(kind: MarketKind, description: string, install: string, topics: string[], repo?: GithubRepository): MarketRisk {
  const haystack = `${description} ${install} ${topics.join(' ')}`.toLocaleLowerCase()
  const signals: string[] = kind === 'dsh-plugin' ? ['宿主插件代码执行'] : []
  if (/(shell|command|subprocess|powershell|terminal|exec|child_process|任意代码|代码执行)/u.test(haystack)) signals.push('宿主命令或代码执行')
  if (/(credential|secret|token|cookie|\.env|ssh|凭据|密钥|会话)/u.test(haystack)) signals.push('凭据或会话访问')
  if (/(filesystem|file system|文件|workspace|工作区|write|delete|写入|删除)/u.test(haystack)) signals.push('文件系统读写')
  if (/(http|network|web|url|网络|网页|remote|远程)/u.test(haystack)) signals.push('网络访问')
  if (/(install|postinstall|preinstall|binary|native|download|安装脚本|二进制)/u.test(haystack)) signals.push('安装脚本或可执行依赖')
  const archived = repo?.archived === true
  if (archived) signals.push('仓库已归档')
  if (signals.some(signal => signal === '宿主插件代码执行' || signal === '宿主命令或代码执行' || signal === '凭据或会话访问' || signal === '安装脚本或可执行依赖')) {
    return { level: 'high', confidence: repo === undefined ? 'declared' : 'static', rationale: '检测到可能改变宿主环境或接触敏感数据的能力，默认不自动安装。', signals }
  }
  if (signals.length === 0 && kind === 'skill') return { level: 'low', confidence: 'declared', rationale: '未发现宿主代码执行、凭据访问或任意网络能力，仍需核对精确版本。', signals: ['提示词 / 文档'] }
  if (signals.length === 0 && repo !== undefined && repoLicense(repo) !== null) return { level: 'low', confidence: 'metadata', rationale: '公开仓库有可审计源码和许可证，当前元数据未暴露高影响能力。', signals: ['公开源码', '许可证已声明'] }
  if (signals.length > 0) return { level: 'medium', confidence: repo === undefined ? 'declared' : 'metadata', rationale: '安装后具有限定的网络或文件能力，继续前请核对作用域和工具实现。', signals }
  return { level: 'unknown', confidence: 'insufficient', rationale: '缺少足够源码、版本或权限证据，不能完成低风险判断。', signals: ['证据不足'] }
}

function githubItem(repo: GithubRepository, kind: MarketKind, registry: string): MarketItem | null {
  const fullName = text(repo.full_name)
  const sourceUrl = safeUrl(repo.html_url, `https://github.com/${fullName}`)
  if (fullName === '' || !sourceUrl) return null
  const rawDescription = text(repo.description) || '该项目未提供公开摘要，请在安装前阅读原仓库文档。'
  const localized = translateDescription(rawDescription)
  const description = localized.description
  const topics = repoTopics(repo)
  const install = kind === 'dsh-plugin'
    ? `git clone ${sourceUrl}.git`
    : kind === 'skill'
      ? `npx skills add ${fullName}`
      : `git clone ${sourceUrl}.git`
  return {
    id: `${kind}:${fullName}`, kind, name: repoName(repo), publisher: repoPublisher(repo), description,
    sourceUrl, codeUrl: sourceUrl, registry, publishedAt: iso(repo.created_at), updatedAt: iso(repo.updated_at ?? repo.pushed_at),
    stars: integer(repo.stargazers_count), language: text(repo.language) || null, license: repoLicense(repo), install,
    ...(localized.originalDescription === undefined ? {} : { originalDescription: localized.originalDescription }),
    risk: assess(kind, description, install, topics, repo), tags: topics,
  }
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/vnd.github+json, application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return await response.json() as T
}

async function fetchGithub(url: string, kind: MarketKind, label: string): Promise<{ items: MarketItem[]; source: MarketCatalog['sources'][number] }> {
  const result = await readJson<GithubSearchResponse>(url)
  const items = (result.items ?? []).map(repo => githubItem(repo, kind, label)).filter((item): item is MarketItem => item !== null)
  return { items, source: { id: label, label, url, status: 'online', count: items.length } }
}

/** Normalize one MCP Registry page (nested `server` + `_meta` rows) into market items. */
function parseRegistryEntries(result: RegistryResponse): MarketItem[] {
  const items: MarketItem[] = []
  for (const entry of result.servers ?? []) {
    // Registry entries wrap the server document: `{ server: {...}, _meta: {...} }`,
    // one row per published VERSION; keep only the latest of each name.
    const server = entry.server
    const official = entry._meta?.['io.modelcontextprotocol.registry/official']
    if (official?.isLatest === false) continue
    const name = text(server?.title) || text(server?.name)
    if (name === '') continue
    const packageInfo = server?.packages?.[0]
    const repository = safeUrl(server?.repository?.url, 'https://github.com/modelcontextprotocol/registry')
    const remote = safeUrl(server?.remotes?.[0]?.url, '')
    const install = text(packageInfo?.identifier) !== ''
      ? `npx -y ${text(packageInfo?.identifier)}`
      : remote !== '' ? `连接 ${remote}` : '请查看 Registry 中的安装配置'
    const rawDescription = text(server?.description) || 'MCP 服务，安装前请检查工具、网络域名和凭据要求。'
    const localized = translateDescription(rawDescription)
    const description = localized.description
    const tags = [text(packageInfo?.registryType), text(server?.remotes?.[0]?.type)].filter(Boolean)
    items.push({
      id: `mcp:${text(server?.name) || slug(name)}:${text(server?.version)}`, kind: 'mcp', name, publisher: 'MCP Registry', description,
      sourceUrl: safeUrl(server?.websiteUrl, 'https://registry.modelcontextprotocol.io/'), codeUrl: repository, registry: 'MCP Registry',
      publishedAt: iso(official?.publishedAt), updatedAt: iso(official?.updatedAt),
      stars: null, language: null, license: null, install, ...(localized.originalDescription === undefined ? {} : { originalDescription: localized.originalDescription }), risk: assess('mcp', description, install, tags), tags,
    })
  }
  return items
}

/** How many MCP Registry pages to walk (100 servers each). */
const REGISTRY_MAX_PAGES = 4

async function fetchRegistry(): Promise<{ items: MarketItem[]; source: MarketCatalog['sources'][number] }> {
  const base = 'https://registry.modelcontextprotocol.io/v0/servers'
  const items: MarketItem[] = []
  let url: string | undefined = `${base}?limit=100`
  for (let page = 0; url !== undefined && page < REGISTRY_MAX_PAGES; page++) {
    const result = await readJson<RegistryPage>(url)
    items.push(...parseRegistryEntries(result))
    const next = text(result.metadata?.nextCursor)
    url = next !== '' ? `${base}?limit=100&cursor=${encodeURIComponent(next)}` : undefined
  }
  return { items, source: { id: 'mcp-registry', label: 'MCP Registry', url: base, status: 'online', count: items.length } }
}

async function fetchNpm(): Promise<{ items: MarketItem[]; source: MarketCatalog['sources'][number] }> {
  const items: MarketItem[] = []
  let fetched = 0
  for (const query of NPM_QUERIES) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query.text)}&size=${String(query.size)}`
    const result = await readJson<NpmSearchResponse>(url)
    fetched += 1
    for (const entry of result.objects ?? []) {
      const pkg = entry.package
      const name = text(pkg?.name)
      if (name === '' || !name.includes('dsh')) continue
      const repository = safeUrl(pkg?.links?.repository, 'https://github.com/deepseek-ai/deepseek-harness')
      const homepage = safeUrl(pkg?.links?.homepage, repository)
      const rawDescription = text(pkg?.description) || 'DeepSeek Harness npm 包。请先阅读包文档和依赖生命周期脚本。'
      const localized = translateDescription(rawDescription)
      const description = localized.description
      const install = `pnpm add ${name}`
      items.push({ id: `dsh-npm:${name}`, kind: 'dsh-plugin', name, publisher: 'npm', description, sourceUrl: homepage, codeUrl: repository, registry: 'npm', publishedAt: iso(pkg?.date), updatedAt: iso(pkg?.date), stars: null, language: 'TypeScript', license: null, install, ...(localized.originalDescription === undefined ? {} : { originalDescription: localized.originalDescription }), risk: assess('dsh-plugin', description, install, [name]), tags: ['npm', 'dsh'] })
    }
  }
  return { items, source: { id: 'npm', label: `npm（${String(fetched)} 组搜索）`, url: 'https://www.npmjs.com/search?q=dsh-plugin', status: 'online', count: items.length } }
}

type GithubFetchResult = { items: MarketItem[]; source: MarketCatalog['sources'][number] }

/**
 * Run the GitHub topic searches SEQUENTIALLY with a small stagger and one
 * delayed retry: the unauthenticated Search API allows ~10 requests/minute,
 * so a parallel burst of six can drop two of them. Registry and npm run in
 * parallel beside this loop.
 */
async function fetchAllGithub(): Promise<Array<PromiseSettledResult<GithubFetchResult>>> {
  const results: Array<PromiseSettledResult<GithubFetchResult>> = []
  for (const query of GITHUB_QUERIES) {
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query.q)}&sort=updated&order=desc&per_page=100`
    try {
      results.push({ status: 'fulfilled', value: await fetchGithub(url, query.kind, query.label) })
    } catch (firstError) {
      try {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        results.push({ status: 'fulfilled', value: await fetchGithub(url, query.kind, query.label) })
      } catch (retryError) {
        results.push({ status: 'rejected', reason: retryError ?? firstError })
      }
    }
    await new Promise(resolve => setTimeout(resolve, 2_500))
  }
  return results
}

async function buildCatalog(): Promise<MarketCatalog> {
  const [githubJobs, otherJobs] = await Promise.all([
    fetchAllGithub(),
    Promise.allSettled([fetchRegistry(), fetchNpm()]),
  ])
  const items = [...BASELINE]
  const sources: MarketCatalog['sources'] = [{ id: 'baseline', label: 'DSH 审计基线', url: 'https://github.com/deepseek-ai/deepseek-harness', status: 'online', count: BASELINE.length }]
  const jobs = [...githubJobs, ...otherJobs]
  let failed = 0
  for (const job of jobs) {
    if (job.status === 'fulfilled') { items.push(...job.value.items); sources.push(job.value.source) }
    else {
      failed += 1
      sources.push({ id: `source-failed-${String(failed)}`, label: `来源离线 ${String(failed)}`, url: '', status: 'offline', count: 0, error: job.reason instanceof Error ? job.reason.message : String(job.reason) })
    }
  }
  const unique = new Map<string, MarketItem>()
  for (const item of items) unique.set(item.id, item)
  const all = [...unique.values()]
  const translation = await applyModelTranslations(all)
  return { items: all, sources, fetchedAt: new Date().toISOString(), cached: false, translation }
}

/** One shared in-flight build: concurrent requests and the background refresh
 *  all await the same crawl + translation pass instead of duplicating it. */
function buildCatalogOnce(): Promise<MarketCatalog> {
  if (building === undefined) {
    building = buildCatalog().then(catalog => {
      cache = { at: Date.now(), catalog }
      return catalog
    }, error => { throw error }).finally(() => { building = undefined })
  }
  return building
}

/** Background refresh: rebuild the catalog and swap the cache atomically. */
async function refreshCatalog(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    await buildCatalogOnce()
  } catch { /* keep the previous cache */ } finally {
    refreshing = false
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(payload)) })
  res.end(payload)
}

function queryValue(req: IncomingMessage, key: string): string {
  return new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get(key)?.trim() ?? ''
}

function filterCatalog(catalog: MarketCatalog, query: string, category: MarketCategory, risk: string, sort: string): MarketCatalog {
  const needle = query.toLocaleLowerCase()
  const items = catalog.items.filter(item => {
    const haystack = [item.name, item.publisher, item.description, item.registry, item.language ?? '', ...item.tags, item.risk.rationale, ...item.risk.signals].join('\n').toLocaleLowerCase()
    return (category === 'all' || item.kind === category) && (risk === '' || item.risk.level === risk) && (needle === '' || haystack.includes(needle))
  }).sort((left, right) => {
    const leftDate = Date.parse(left.updatedAt ?? left.publishedAt ?? '') || 0
    const rightDate = Date.parse(right.updatedAt ?? right.publishedAt ?? '') || 0
    if (sort === 'name') return left.name.localeCompare(right.name)
    if (sort === 'stars') return (right.stars ?? -1) - (left.stars ?? -1)
    return rightDate - leftDate
  })
  return { ...catalog, items }
}

/** Register the read-only catalog endpoint consumed by the browser market. */
export function registerMarketRoutes(ctx: Context): void {
  marketCtx = ctx
  // Keep the catalog fresh without user action: warm up immediately, then a
  // half-hourly background re-crawl swaps the cache atomically, so requests
  // never block on a crawl and the market is "always up to date".
  void refreshCatalog()
  ctx.effect(() => {
    const timer = setInterval(() => { void refreshCatalog() }, AUTO_REFRESH_MS)
    return () => { clearInterval(timer) }
  }, 'web-app: market auto-refresh')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/market/catalog', handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { writeJson(res, 405, { error: 'method not allowed' }); return }
      const now = Date.now()
      const force = queryValue(req, 'force') === '1'
      const pending = cache !== undefined && !force && now - cache.at < CACHE_TTL_MS ? Promise.resolve({ ...cache.catalog, cached: true }) : buildCatalogOnce()
      void pending.then(catalog => writeJson(res, 200, filterCatalog(catalog, queryValue(req, 'q'), (queryValue(req, 'category') || 'all') as MarketCategory, queryValue(req, 'risk'), queryValue(req, 'sort')))).catch(error => writeJson(res, 503, { error: error instanceof Error ? error.message : String(error), items: [], sources: [] }))
    },
  }), 'web-app: market catalog route')
}

export const internals = {
  assess, filterCatalog, buildCatalog, parseRegistryEntries, parseMarketTranslateResponse,
  needsTranslation, applyModelTranslations, refreshCatalog, baseline: BASELINE,
}
