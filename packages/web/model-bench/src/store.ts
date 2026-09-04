/**
 * Round persistence for the model testing bench: one directory per round
 * under the bench root holding `round.json` (the record), `events.jsonl`
 * (the append-only event log), `question/` (the generator agent's output),
 * `runs/<slug>/` (one working directory per contestant model), and
 * `judgements/` (judge notes). Seed images for vision rounds live in the
 * shared `assets/images/` directory next to the rounds.
 * @module @deepseek-ai/dsh-model-bench/store
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { isSeedImageName } from './assets.ts'
import type { BenchCategory, BenchDifficulty, CreateRoundRequest, ModelRoute, RoundRecord, RoundSummary, StartRoundRequest } from './types.ts'

const CATEGORIES: readonly BenchCategory[] = ['coding', 'document', 'vision', 'paper']
const DIFFICULTIES: readonly BenchDifficulty[] = ['easy', 'medium', 'hard']
const RECORD_FILE = 'round.json'
const EVENT_LOG_FILE = 'events.jsonl'
/** Bench-owned entries at the round root never listed as deliverables. */
const BENCH_ROOT_FILES = new Set([RECORD_FILE, EVENT_LOG_FILE])
/** Directory names never walked when listing files. */
const SKIPPED_DIRS = new Set(['.git', '.dsh', 'node_modules', '.venv', '__pycache__'])
const MAX_LISTED_FILES = 800
const MAX_NAME_CHARS = 80
const MAX_REPLY_TAIL = 1200

/** Error carrying one stable bench rejection code. */
export class BenchStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID' | 'LIMIT' | 'IO',
  ) {
    super(message)
  }
}

/** The default bench root: `$DSH_HOME` (or `~/.dsh`) plus `model-bench`. */
export function defaultDataDir(): string {
  const envHome = process.env.DSH_HOME
  const home = envHome !== undefined && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return resolve(home, 'model-bench')
}

/** Validate one model route object; null when malformed. */
export function parseModelRoute(raw: unknown): ModelRoute | null {
  if (raw === null || typeof raw !== 'object') return null
  const { provider, model } = raw as Record<string, unknown>
  if (typeof provider !== 'string' || provider.trim() === '') return null
  if (typeof model !== 'string' || model.trim() === '') return null
  return { provider: provider.trim(), model: model.trim() }
}

/** Validate and normalize one creation request. */
export function normalizeCreateRequest(raw: unknown): CreateRoundRequest {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const category = typeof source.category === 'string' && (CATEGORIES as readonly string[]).includes(source.category)
    ? source.category as BenchCategory
    : undefined
  if (category === undefined) throw new BenchStoreError(`category must be one of ${CATEGORIES.join(', ')}`, 'INVALID')
  const difficulty = source.difficulty === undefined
    ? 'medium'
    : typeof source.difficulty === 'string' && (DIFFICULTIES as readonly string[]).includes(source.difficulty)
      ? source.difficulty as BenchDifficulty
      : undefined
  if (difficulty === undefined) throw new BenchStoreError(`difficulty must be one of ${DIFFICULTIES.join(', ')}`, 'INVALID')
  const name = typeof source.name === 'string' && source.name.trim() !== ''
    ? source.name.trim().slice(0, MAX_NAME_CHARS)
    : undefined
  let generator: ModelRoute | undefined
  if (source.generator !== undefined) {
    const parsed = parseModelRoute(source.generator)
    if (parsed === null) throw new BenchStoreError('generator must be {provider, model}', 'INVALID')
    generator = parsed
  }
  let judge: ModelRoute | undefined
  if (source.judge !== undefined) {
    const parsed = parseModelRoute(source.judge)
    if (parsed === null) throw new BenchStoreError('judge must be {provider, model}', 'INVALID')
    judge = parsed
  }
  return {
    category,
    difficulty,
    ...name === undefined ? {} : { name },
    ...generator === undefined ? {} : { generator },
    ...judge === undefined ? {} : { judge },
    start: source.start === true,
  }
}

/** Validate and normalize one start request (contestant roster + judge). */
export function normalizeStartRequest(raw: unknown, maxContestants: number): StartRoundRequest {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const rawModels = Array.isArray(source.models) ? source.models : []
  if (rawModels.length === 0) throw new BenchStoreError('models must list at least one {provider, model}', 'INVALID')
  if (rawModels.length > maxContestants) throw new BenchStoreError(`models exceeds the ${String(maxContestants)} contestant limit`, 'INVALID')
  const seen = new Set<string>()
  const models: ModelRoute[] = []
  for (const entry of rawModels) {
    const route = parseModelRoute(entry)
    if (route === null) throw new BenchStoreError('every model entry needs non-empty provider and model', 'INVALID')
    const key = `${route.provider}/${route.model}`
    if (seen.has(key)) continue
    seen.add(key)
    models.push(route)
  }
  if (models.length === 0) throw new BenchStoreError('models must list at least one {provider, model}', 'INVALID')
  let judge: ModelRoute | undefined
  if (source.judge !== undefined) {
    const parsed = parseModelRoute(source.judge)
    if (parsed === null) throw new BenchStoreError('judge must be {provider, model}', 'INVALID')
    judge = parsed
  }
  return { models, ...judge === undefined ? {} : { judge } }
}

/** Stable filesystem slug for one model route (unique within one roster). */
export function routeSlug(route: ModelRoute, taken: Set<string>): string {
  const base = `${route.provider}--${route.model}`.replace(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 80)
  let slug = base
  let suffix = 2
  while (taken.has(slug)) {
    slug = `${base}-${String(suffix)}`
    suffix += 1
  }
  taken.add(slug)
  return slug
}

/** Persistent bench store over one root directory. */
export class BenchStore {
  /** In-memory event sequence counters keyed by round id. */
  private readonly seqByRound = new Map<string, number>()
  /** Per-round serialization chain: concurrent saves/appends never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>()

  /** @param root - absolute bench root directory. */
  constructor(readonly root: string) {}

  /** Run one task behind the round's serialization chain. */
  private enqueue<T>(roundId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(roundId) ?? Promise.resolve()
    const run = previous.then(task, task)
    this.locks.set(roundId, run.catch(() => undefined))
    return run
  }

  /** Absolute directory of one round. */
  roundDir(roundId: string): string {
    return join(this.root, roundId)
  }

  /** Absolute generator working directory of one round. */
  questionDir(roundId: string): string {
    return join(this.roundDir(roundId), 'question')
  }

  /** Absolute materials directory the generator fills. */
  materialsDir(roundId: string): string {
    return join(this.questionDir(roundId), 'materials')
  }

  /** Absolute contestant run directory of one slug. */
  runDir(roundId: string, slug: string): string {
    return join(this.roundDir(roundId), 'runs', slug)
  }

  /** Absolute judge-notes directory. */
  judgementsDir(roundId: string): string {
    return join(this.roundDir(roundId), 'judgements')
  }

  /** Shared seed-image directory for vision rounds. */
  assetsImagesDir(): string {
    return join(this.root, 'assets', 'images')
  }

  /** Create one durable round record and its directory tree. */
  async create(request: CreateRoundRequest, maxRounds: number): Promise<RoundRecord> {
    await mkdir(this.root, { recursive: true })
    const existing = (await readdir(this.root).catch(() => [] as string[]))
      .filter(entry => entry !== 'assets')
    if (existing.length >= maxRounds) {
      throw new BenchStoreError(`round limit ${String(maxRounds)} reached`, 'LIMIT')
    }
    const id = `round-${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`
    const record: RoundRecord = {
      id,
      name: request.name ?? `${request.category} 测试`,
      category: request.category,
      difficulty: request.difficulty ?? 'medium',
      createdAt: Date.now(),
      status: 'draft',
      ...request.generator === undefined ? {} : { generator: request.generator },
      ...request.judge === undefined ? {} : { judge: request.judge },
      models: [],
      contestants: {},
    }
    await mkdir(this.roundDir(id), { recursive: true })
    await mkdir(this.questionDir(id), { recursive: true })
    await mkdir(this.runsRootDir(id), { recursive: true })
    await mkdir(this.judgementsDir(id), { recursive: true })
    await this.save(record)
    await writeFile(join(this.roundDir(id), EVENT_LOG_FILE), '', 'utf8')
    this.seqByRound.set(id, 0)
    return record
  }

  /** Absolute runs root of one round. */
  runsRootDir(roundId: string): string {
    return join(this.roundDir(roundId), 'runs')
  }

  /** Write one record near-atomically (tmp file + rename), serialized per round. */
  async save(record: RoundRecord): Promise<void> {
    return this.enqueue(record.id, () => this.saveNow(record))
  }

  /** The unsynchronized record write. */
  private async saveNow(record: RoundRecord): Promise<void> {
    const dir = this.roundDir(record.id)
    await mkdir(dir, { recursive: true })
    const target = join(dir, RECORD_FILE)
    const tmp = join(dir, `.${RECORD_FILE}.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  }

  /** Load one record without mutating its status. */
  async load(roundId: string): Promise<RoundRecord> {
    const path = join(this.roundDir(roundId), RECORD_FILE)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw new BenchStoreError(`round "${roundId}" not found`, 'NOT_FOUND')
    }
    const parsed = JSON.parse(raw) as Omit<RoundRecord, 'difficulty'> & { difficulty?: unknown }
    const stored = parsed.difficulty ?? parsed.question?.difficulty
    const difficulty = typeof stored === 'string' && (DIFFICULTIES as readonly string[]).includes(stored)
      ? stored as BenchDifficulty
      : 'medium'
    return { ...parsed, difficulty }
  }

  /**
   * Settle records a process restart left mid-flight. This startup-only scan is
   * deliberately separate from load(): ordinary API reads must stay pure or a
   * polling client would stop a live generation/run/judgement phase.
   */
  async settleInterruptedRounds(): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return 0
    }
    let settled = 0
    for (const entry of entries) {
      if (entry === 'assets') continue
      try {
        const record = await this.load(entry)
        if (record.status !== 'generating' && record.status !== 'running' && record.status !== 'judging') continue
        record.status = 'stopped'
        record.error = '进程重启，测试中断；可重新开始'
        await this.save(record)
        settled += 1
      } catch {
        // A half-written round directory never blocks recovery of the rest.
      }
    }
    return settled
  }

  /** Every round summary in creation order (oldest first). */
  async list(): Promise<RoundSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const summaries: RoundSummary[] = []
    for (const entry of entries) {
      if (entry === 'assets') continue
      try {
        const record = await this.load(entry)
        summaries.push({
          id: record.id,
          name: record.name,
          category: record.category,
          difficulty: record.difficulty,
          createdAt: record.createdAt,
          status: record.status,
          modelCount: record.models.length,
          ...record.question === undefined ? {} : { questionTitle: record.question.title },
          ...record.stats === undefined ? {} : { stats: record.stats },
          ...record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt },
        })
      } catch {
        // A half-written directory never blocks the list.
      }
    }
    summaries.sort((a, b) => a.createdAt - b.createdAt)
    return summaries
  }

  /** Remove one round directory entirely. */
  async delete(roundId: string): Promise<void> {
    this.seqByRound.delete(roundId)
    await rm(this.roundDir(roundId), { recursive: true, force: true })
  }

  /** Append one event line and return it with its sequence number (serialized). */
  async appendEvent(roundId: string, type: string, data: Record<string, unknown>): Promise<{ seq: number }> {
    return this.enqueue(roundId, () => this.appendEventNow(roundId, type, data))
  }

  /** The unsynchronized event append. */
  private async appendEventNow(roundId: string, type: string, data: Record<string, unknown>): Promise<{ seq: number }> {
    const seq = (this.seqByRound.get(roundId) ?? await this.countEvents(roundId)) + 1
    this.seqByRound.set(roundId, seq)
    const event = { seq, time: Date.now(), type, data }
    const path = join(this.roundDir(roundId), EVENT_LOG_FILE)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
    return { seq }
  }

  /** Count event lines without keeping them in memory. */
  private async countEvents(roundId: string): Promise<number> {
    try {
      const raw = await readFile(join(this.roundDir(roundId), EVENT_LOG_FILE), 'utf8')
      return raw.split('\n').filter(line => line.trim() !== '').length
    } catch {
      return 0
    }
  }

  /**
   * Read the event tail after one sequence number.
   * @param roundId - round whose log is read.
   * @param after - exclusive lower sequence bound (0 reads from the start).
   * @param limit - maximum events returned.
   * @returns events in log order plus the current total count.
   */
  async readEvents(roundId: string, after: number, limit: number): Promise<{ events: { seq: number; time: number; type: string; data: Record<string, unknown> }[]; total: number }> {
    let raw: string
    try {
      raw = await readFile(join(this.roundDir(roundId), EVENT_LOG_FILE), 'utf8')
    } catch {
      throw new BenchStoreError(`round "${roundId}" not found`, 'NOT_FOUND')
    }
    const events: { seq: number; time: number; type: string; data: Record<string, unknown> }[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line) as { seq: number; time: number; type: string; data: Record<string, unknown> }
        if (event.seq > after) events.push(event)
      } catch {
        // A torn tail line never blocks earlier events.
      }
    }
    const total = events.length === 0
      ? after
      : Math.max(after, events[events.length - 1]?.seq ?? after)
    return { events: events.slice(-limit), total }
  }

  /**
   * List round files recursively (bench-owned root entries excluded), capped
   * for transport. Paths are round-relative; the seed-image asset directory
   * is never listed (it is internal bench state).
   * @param roundId - round whose directory is walked.
   * @returns round-relative paths in walk order (sorted).
   */
  async listFiles(roundId: string): Promise<string[]> {
    const base = this.roundDir(roundId)
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      if (out.length >= MAX_LISTED_FILES) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (out.length >= MAX_LISTED_FILES) return
        const absolute = join(dir, entry.name)
        const relative = absolute.slice(base.length + 1).split(sep).join('/')
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) await walk(absolute)
          continue
        }
        if (!entry.isFile()) continue
        if (dir === base && BENCH_ROOT_FILES.has(entry.name)) continue
        // Seed images are generated material, not a deliverable worth listing.
        if (isSeedImageName(entry.name) && relative.includes('/question/materials/')) continue
        out.push(relative)
      }
    }
    await walk(base)
    out.sort((a, b) => a.localeCompare(b))
    return out
  }

  /**
   * Read one round file safely.
   * @param roundId - round owning the file.
   * @param relativePath - round-relative path from the file listing.
   * @param maxBytes - transport cap on the returned text.
   * @returns the decoded UTF-8 text (truncated flag set when capped).
   */
  async readFile(roundId: string, relativePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const base = resolve(this.roundDir(roundId))
    const target = resolve(base, relativePath)
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new BenchStoreError('path escapes the round directory', 'INVALID')
    }
    let info
    try {
      info = await stat(target)
    } catch {
      throw new BenchStoreError(`file "${relativePath}" not found`, 'NOT_FOUND')
    }
    if (!info.isFile()) throw new BenchStoreError(`"${relativePath}" is not a file`, 'INVALID')
    const buffer = await readFile(target)
    const truncated = buffer.byteLength > maxBytes
    const text = buffer.subarray(0, Math.min(buffer.byteLength, maxBytes)).toString('utf8')
    return { text, truncated }
  }

  /** Read one UTF-8 file inside one round directory ('' when missing). */
  async readRoundFile(roundId: string, relativePath: string, maxChars = 200_000): Promise<string> {
    try {
      const raw = await readFile(join(this.roundDir(roundId), relativePath), 'utf8')
      return raw.length > maxChars ? raw.slice(0, maxChars) : raw
    } catch {
      return ''
    }
  }

  /** Write one UTF-8 file inside one round directory (parents created). */
  async writeRoundFile(roundId: string, relativePath: string, content: string): Promise<void> {
    const target = join(this.roundDir(roundId), relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }

  /** Reply-tail bound shared with the record writer. */
  get maxReplyTail(): number {
    return MAX_REPLY_TAIL
  }
}
