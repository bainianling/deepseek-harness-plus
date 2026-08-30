/**
 * Project persistence for the collaboration studio: one directory per project
 * under the studio root holding `studio.json` (the record), `events.jsonl`
 * (the append-only event log), and the deliverable files the role agents
 * write with their own tools.
 * @module @deepseek-ai/dsh-collab-studio/store
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { CreateProjectRequest, ProjectRecord, ProjectSummary, ProjectType, StudioEvent } from './types.ts'

const PROJECT_TYPES: readonly ProjectType[] = ['software', 'webpage', 'document', 'research', 'other']
const PROJECT_NAME_FILE = 'studio.json'
const EVENT_LOG_FILE = 'events.jsonl'
/** Studio-owned entries never listed as deliverables. */
const STUDIO_FILES = new Set([PROJECT_NAME_FILE, EVENT_LOG_FILE])
/** Directory names never walked when listing deliverables. */
const SKIPPED_DIRS = new Set(['.git', '.dsh', 'node_modules', '.venv', '__pycache__'])
const MAX_LISTED_FILES = 500
const MAX_REQUIREMENT_CHARS = 4_000
const MAX_NAME_CHARS = 80

/** Error carrying one stable studio rejection code. */
export class StudioStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID' | 'LIMIT' | 'IO',
  ) {
    super(message)
  }
}

/** The default studio root: `$DSH_HOME` (or `~/.dsh`) plus `collab-studio`. */
export function defaultDataDir(): string {
  const envHome = process.env.DSH_HOME
  const home = envHome !== undefined && envHome.trim() !== '' ? envHome.trim() : join(homedir(), '.dsh')
  return resolve(home, 'collab-studio')
}

/** Validate and normalize one creation request. */
export function normalizeCreateRequest(raw: unknown): CreateProjectRequest {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const requirement = typeof source.requirement === 'string' ? source.requirement.trim() : ''
  if (requirement.length === 0) throw new StudioStoreError('requirement must be a non-empty string', 'INVALID')
  if (requirement.length > MAX_REQUIREMENT_CHARS) throw new StudioStoreError(`requirement exceeds ${String(MAX_REQUIREMENT_CHARS)} characters`, 'INVALID')
  const name = typeof source.name === 'string' && source.name.trim() !== ''
    ? source.name.trim().slice(0, MAX_NAME_CHARS)
    : requirement.slice(0, 30)
  const projectType = typeof source.projectType === 'string' && (PROJECT_TYPES as readonly string[]).includes(source.projectType)
    ? source.projectType as ProjectType
    : 'software'
  const stageModels: ProjectRecord['stageModels'] = {}
  if (source.stageModels !== null && typeof source.stageModels === 'object') {
    for (const [stageId, route] of Object.entries(source.stageModels as Record<string, unknown>)) {
      if (route === null || typeof route !== 'object') continue
      const { provider, model } = route as Record<string, unknown>
      if (typeof provider === 'string' && provider.trim() !== '' && typeof model === 'string' && model.trim() !== '') {
        stageModels[stageId] = { provider: provider.trim(), model: model.trim() }
      }
    }
  }
  return {
    requirement,
    name,
    projectType,
    stageModels,
    start: source.start === true,
  }
}

/** Persistent studio store over one root directory. */
export class StudioStore {
  /** In-memory event sequence counters keyed by project id. */
  private readonly seqByProject = new Map<string, number>()

  /** @param root - absolute studio root directory. */
  constructor(readonly root: string) {}

  /** Absolute directory of one project. */
  projectDir(projectId: string): string {
    return join(this.root, projectId)
  }

  /** Create one durable project record and its directory. */
  async create(request: CreateProjectRequest, maxProjects: number): Promise<ProjectRecord> {
    await mkdir(this.root, { recursive: true })
    const existing = await readdir(this.root).catch(() => [] as string[])
    if (existing.length >= maxProjects) {
      throw new StudioStoreError(`project limit ${String(maxProjects)} reached`, 'LIMIT')
    }
    const id = `proj-${new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)}-${randomUUID().slice(0, 8)}`
    const record: ProjectRecord = {
      id,
      name: request.name ?? request.requirement.slice(0, 30),
      requirement: request.requirement,
      projectType: request.projectType ?? 'software',
      createdAt: Date.now(),
      status: 'draft',
      stageModels: request.stageModels ?? {},
      stageStatus: {},
      deliverables: [],
    }
    await mkdir(this.projectDir(id), { recursive: true })
    await this.save(record)
    await writeFile(join(this.projectDir(id), EVENT_LOG_FILE), '', 'utf8')
    this.seqByProject.set(id, 0)
    return record
  }

  /** Write one record near-atomically (tmp file + rename). */
  async save(record: ProjectRecord): Promise<void> {
    const dir = this.projectDir(record.id)
    await mkdir(dir, { recursive: true })
    const target = join(dir, PROJECT_NAME_FILE)
    const tmp = join(dir, `.${PROJECT_NAME_FILE}.${randomUUID().slice(0, 8)}.tmp`)
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  }

  /** Load one record; a record left `running` by a restart settles as `stopped`. */
  async load(projectId: string): Promise<ProjectRecord> {
    const path = join(this.projectDir(projectId), PROJECT_NAME_FILE)
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      throw new StudioStoreError(`project "${projectId}" not found`, 'NOT_FOUND')
    }
    const record = JSON.parse(raw) as ProjectRecord
    if (record.status === 'running') {
      record.status = 'stopped'
      record.error = '进程重启，流水线中断；可重新开始'
      await this.save(record)
    }
    return record
  }

  /** Every project summary in creation order (oldest first). */
  async list(): Promise<ProjectSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(this.root)
    } catch {
      return []
    }
    const summaries: ProjectSummary[] = []
    for (const entry of entries) {
      try {
        const record = await this.load(entry)
        summaries.push({
          id: record.id,
          name: record.name,
          requirement: record.requirement,
          projectType: record.projectType,
          createdAt: record.createdAt,
          status: record.status,
          ...record.currentStage === undefined ? {} : { currentStage: record.currentStage },
          ...record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt },
        })
      } catch {
        // A half-written directory never blocks the list.
      }
    }
    summaries.sort((a, b) => a.createdAt - b.createdAt)
    return summaries
  }

  /** Remove one project directory entirely. */
  async delete(projectId: string): Promise<void> {
    this.seqByProject.delete(projectId)
    await rm(this.projectDir(projectId), { recursive: true, force: true })
  }

  /** Append one event line and return it with its sequence number. */
  async appendEvent(projectId: string, type: string, data: Record<string, unknown>): Promise<StudioEvent> {
    const seq = (this.seqByProject.get(projectId) ?? await this.countEvents(projectId)) + 1
    this.seqByProject.set(projectId, seq)
    const event: StudioEvent = { seq, time: Date.now(), type, data }
    const path = join(this.projectDir(projectId), EVENT_LOG_FILE)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8')
    return event
  }

  /** Count event lines without keeping them in memory. */
  private async countEvents(projectId: string): Promise<number> {
    try {
      const raw = await readFile(join(this.projectDir(projectId), EVENT_LOG_FILE), 'utf8')
      return raw.split('\n').filter(line => line.trim() !== '').length
    } catch {
      return 0
    }
  }

  /**
   * Read the event tail after one sequence number.
   * @param projectId - project whose log is read.
   * @param after - exclusive lower sequence bound (0 reads from the start).
   * @param limit - maximum events returned.
   * @returns events in log order plus the current total count.
   */
  async readEvents(projectId: string, after: number, limit: number): Promise<{ events: StudioEvent[]; total: number }> {
    let raw: string
    try {
      raw = await readFile(join(this.projectDir(projectId), EVENT_LOG_FILE), 'utf8')
    } catch {
      throw new StudioStoreError(`project "${projectId}" not found`, 'NOT_FOUND')
    }
    const events: StudioEvent[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line) as StudioEvent
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
   * List deliverable files recursively (studio-owned and vendored entries
   * excluded), capped for transport.
   * @param projectId - project whose directory is walked.
   * @returns project-relative paths in walk order.
   */
  async listFiles(projectId: string): Promise<string[]> {
    const base = this.projectDir(projectId)
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
        if (dir === base && STUDIO_FILES.has(entry.name)) continue
        out.push(relative)
      }
    }
    await walk(base)
    out.sort((a, b) => a.localeCompare(b))
    return out
  }

  /**
   * Read one deliverable file safely.
   * @param projectId - project owning the file.
   * @param relativePath - project-relative path from the file listing.
   * @param maxBytes - transport cap on the returned text.
   * @returns the decoded UTF-8 text (truncated flag set when capped).
   */
  async readFile(projectId: string, relativePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
    const base = resolve(this.projectDir(projectId))
    const target = resolve(base, relativePath)
    if (target !== base && !target.startsWith(`${base}${sep}`)) {
      throw new StudioStoreError('path escapes the project directory', 'INVALID')
    }
    let info
    try {
      info = await stat(target)
    } catch {
      throw new StudioStoreError(`file "${relativePath}" not found`, 'NOT_FOUND')
    }
    if (!info.isFile()) throw new StudioStoreError(`"${relativePath}" is not a file`, 'INVALID')
    const buffer = await readFile(target)
    const truncated = buffer.byteLength > maxBytes
    const text = buffer.subarray(0, Math.min(buffer.byteLength, maxBytes)).toString('utf8')
    return { text, truncated }
  }
}
