/**
 * @deepseek-ai/dsh-collab-studio — the multi-AI collaboration studio plugin.
 * A virtual software company (CEO / CTO / product / programmer / tester /
 * documentation) drives one requirement sentence through consensus meetings
 * (Atomic-Chat) between full harness agents, stage by stage, into a complete
 * project directory. The GUI collaboration section talks to the `/api/collab`
 * routes registered on the shared webServer.
 * @module @deepseek-ai/dsh-collab-studio
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AgentRoleDriver } from './driver.ts'
import { StudioAbortedError } from './driver.ts'
import { runProject } from './engine.ts'
import { DEFAULT_STAGES, ROLES } from './prompts.ts'
import { defaultDataDir, normalizeCreateRequest, StudioStore, StudioStoreError } from './store.ts'
import type { ProjectRecord, ResolvedStudioConfig, StageSpec, StudioAgentsLike, StudioConfig, StudioDefaultModelLike, StudioLlmLike, StudioPresetsLike } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'collab-studio'

/** The web surface must already carry the HTTP carrier. */
export const inject = ['webServer']

declare module '@deepseek-ai/cordis' {
  interface Context {
    collabStudio: CollabStudioService
  }
}

/** The `collabStudio` service surface other rows may use. */
export interface CollabStudioService {
  /**
   * List persisted collaboration projects.
   * @returns persisted project records.
   */
  listProjects(): Promise<unknown>
  /**
   * Create one collaboration project from a user request.
   * @param request - untrusted project creation input.
   * @returns the created project record.
   */
  createProject(request: unknown): Promise<ProjectRecord>
  /**
   * Read one project together with its role and stage metadata.
   * @param projectId - persisted project identifier.
   * @returns project detail data.
   */
  getProject(projectId: string): Promise<unknown>
  /**
   * Start one project pipeline.
   * @param projectId - persisted project identifier.
   * @returns whether the pipeline was started.
   */
  startProject(projectId: string): Promise<{ started: boolean; reason?: string }>
  /**
   * Stop one running project pipeline.
   * @param projectId - persisted project identifier.
   * @returns whether an active pipeline was stopped.
   */
  stopProject(projectId: string): Promise<{ stopped: boolean }>
  /**
   * Delete one project after stopping any active run.
   * @param projectId - persisted project identifier.
   * @returns whether the project was deleted.
   */
  deleteProject(projectId: string): Promise<{ deleted: boolean }>
  /**
   * Read a bounded project event page.
   * @param projectId - persisted project identifier.
   * @param after - exclusive event cursor.
   * @param limit - maximum number of events.
   * @returns the event page and total count.
   */
  events(projectId: string, after: number, limit: number): Promise<{ events: unknown[]; total: number }>
  /**
   * List files generated for one project.
   * @param projectId - persisted project identifier.
   * @returns project-relative file paths.
   */
  files(projectId: string): Promise<string[]>
  /**
   * Read one bounded generated project file.
   * @param projectId - persisted project identifier.
   * @param path - project-relative file path.
   * @returns file text and truncation status.
   */
  readFile(projectId: string, path: string): Promise<{ text: string; truncated: boolean }>
  /**
   * Report whether one project pipeline is active.
   * @param projectId - persisted project identifier.
   * @returns whether the project has an active pipeline.
   */
  isRunning(projectId: string): boolean
}

const PROJECT_TYPES = ['software', 'webpage', 'document', 'research', 'other'] as const
/** No trailing slash: the webServer matches `prefix` and `prefix/<anything>`. */
const PROJECTS_PREFIX = '/api/collab/projects'
const DEFAULT_MAX_PROJECTS = 32
const DEFAULT_MAX_EVENT_TAIL = 2000
const DEFAULT_MAX_MEETING_ROUNDS = 4
const DEFAULT_MAX_FILE_READ_BYTES = 262_144
const BODY_LIMIT = 32_768

/** Structural webServer surface this plugin registers against. */
interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

/** Loopback-only control requests must stay same-origin with the local GUI. */
function isLocalControlRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress ?? ''
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

/** Read one bounded JSON body. */
function readJsonBody(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > limit) {
        rejectPromise(new Error('body too large'))
        req.destroy()
      }
    })
    req.once('end', () => {
      if (body.trim() === '') {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(body) as Record<string, unknown>)
      } catch {
        rejectPromise(new Error('invalid json'))
      }
    })
    req.once('error', rejectPromise)
  })
}

/** Coerce the raw row config into resolved deployment limits. */
export function resolveStudioConfig(raw: unknown): ResolvedStudioConfig {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    dataDir: typeof source.dataDir === 'string' && source.dataDir.trim() !== ''
      ? resolve(source.dataDir.trim())
      : defaultDataDir(),
    maxProjects: positive(source.maxProjects, DEFAULT_MAX_PROJECTS),
    maxEventTail: positive(source.maxEventTail, DEFAULT_MAX_EVENT_TAIL),
    maxMeetingRounds: positive(source.maxMeetingRounds, DEFAULT_MAX_MEETING_ROUNDS),
    maxFileReadBytes: positive(source.maxFileReadBytes, DEFAULT_MAX_FILE_READ_BYTES),
  }
}

/** Map one store error to its HTTP status. */
function storeErrorStatus(error: StudioStoreError): number {
  switch (error.code) {
    case 'NOT_FOUND': return 404
    case 'INVALID': return 400
    case 'LIMIT': return 409
    default: return 500
  }
}

/** The static template view shared by meta and detail responses. */
function stageView(stage: StageSpec, record?: ProjectRecord): Record<string, unknown> {
  return {
    id: stage.id,
    topic: stage.topic,
    producer: stage.producer,
    deliverable: stage.deliverable,
    ...stage.meeting === undefined ? {} : {
      meeting: { participants: [...stage.meeting.participants], maxRounds: stage.meeting.maxRounds },
    },
    ...stage.review === undefined ? {} : {
      review: { reviewer: stage.review.reviewer, fixer: stage.review.fixer, maxFixRounds: stage.review.maxFixRounds },
    },
    status: record?.stageStatus[stage.id] ?? 'pending',
    ...record?.stageModels[stage.id] === undefined ? {} : { model: record.stageModels[stage.id] },
  }
}

/** One live pipeline run and its cancellation handle. */
interface RunEntry {
  readonly controller: AbortController
  readonly done: Promise<void>
}

/**
 * Mount the collaboration studio: store, run registry, routes, and the
 * `collabStudio` service. Disposal stops every run and unregisters routes.
 * @param ctx - plugin context carrying the webServer service.
 * @param rawConfig - the composition row config (coerced defensively).
 */
export function apply(ctx: Context, rawConfig: StudioConfig): void {
  const config = resolveStudioConfig(rawConfig)
  if (!config.enabled) return
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn(new Error('collab-studio: webServer service unavailable; routes not registered'))
    return
  }
  const agents = ctx.get('agents') as StudioAgentsLike | undefined
  if (agents === undefined) {
    ctx.logger.warn(new Error('collab-studio: agents service unavailable; studio disabled'))
    return
  }
  const presets = ctx.get('agentPresets') as StudioPresetsLike | undefined
  const llm = ctx.get('llm') as StudioLlmLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as StudioDefaultModelLike | undefined

  const store = new StudioStore(config.dataDir)
  const runs = new Map<string, RunEntry>()
  /** Guards the async window between the run check and the runs.set commit. */
  const starting = new Set<string>()
  let disposed = false

  const emitFor = (projectId: string) =>
    async (type: string, data: Record<string, unknown>): Promise<void> => {
      await store.appendEvent(projectId, type, data)
    }

  const startProject = async (projectId: string): Promise<{ started: boolean; reason?: string }> => {
    if (disposed) return { started: false, reason: 'studio is shutting down' }
    if (runs.has(projectId) || starting.has(projectId)) return { started: false, reason: 'already running' }
    starting.add(projectId)
    try {
      const record = await store.load(projectId)
      record.status = 'running'
      delete record.error
      delete record.currentStage
      record.stageStatus = {}
      await store.save(record)
      const driver = new AgentRoleDriver(agents, presets)
      const controller = new AbortController()
      const emit = emitFor(projectId)
      const done = (async (): Promise<void> => {
        try {
          await emit('project/started', { requirement: record.requirement, projectType: record.projectType })
          await runProject(record, {
            store,
            driver,
            stages: DEFAULT_STAGES,
            signal: controller.signal,
            maxMeetingRounds: config.maxMeetingRounds,
            emit,
          })
          record.status = 'done'
          record.finishedAt = Date.now()
          await store.save(record)
          await emit('project/completed', {})
        } catch (error) {
          record.finishedAt = Date.now()
          if (controller.signal.aborted || error instanceof StudioAbortedError) {
            record.status = 'stopped'
            delete record.error
            await store.save(record)
            await emit('project/stopped', {})
          } else {
            const message = error instanceof Error ? error.message : String(error)
            record.status = 'failed'
            record.error = message
            if (record.currentStage !== undefined) record.stageStatus[record.currentStage] = 'failed'
            await store.save(record)
            await emit('project/failed', { error: message, stage: record.currentStage })
          }
          ctx.logger.warn(new Error(`collab-studio: project "${projectId}" ended as ${record.status}: ${record.error ?? ''}`))
        } finally {
          try {
            await driver.disposeAll()
          } catch (error) {
            ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          }
          runs.delete(projectId)
        }
      })()
      runs.set(projectId, { controller, done })
      return { started: true }
    } finally {
      starting.delete(projectId)
    }
  }

  const stopProject = async (projectId: string): Promise<{ stopped: boolean }> => {
    const run = runs.get(projectId)
    if (run === undefined) return { stopped: false }
    run.controller.abort()
    await run.done.catch(() => undefined)
    return { stopped: true }
  }

  const service: CollabStudioService = {
    listProjects: () => store.list(),
    createProject: async (request: unknown) => {
      const normalized = normalizeCreateRequest(request)
      const record = await store.create(normalized, config.maxProjects)
      await store.appendEvent(record.id, 'project/created', {
        requirement: record.requirement,
        name: record.name,
        projectType: record.projectType,
      })
      if (normalized.start) void startProject(record.id).catch(() => undefined)
      return record
    },
    getProject: async (projectId: string) => {
      const record = await store.load(projectId)
      return { record, roles: ROLES, stages: DEFAULT_STAGES.map(stage => stageView(stage, record)) }
    },
    startProject,
    stopProject,
    deleteProject: async (projectId: string) => {
      await stopProject(projectId)
      await store.delete(projectId)
      return { deleted: true }
    },
    events: async (projectId: string, after: number, limit: number) => {
      const bounded = Math.max(1, Math.min(limit, config.maxEventTail))
      const { events, total } = await store.readEvents(projectId, after, bounded)
      return { events, total }
    },
    files: (projectId: string) => store.listFiles(projectId),
    readFile: async (projectId: string, path: string) => {
      // A read also proves the project exists; let NOT_FOUND surface as 404.
      await store.load(projectId)
      return store.readFile(projectId, path, config.maxFileReadBytes)
    },
    isRunning: (projectId: string) => runs.has(projectId),
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/collab/meta',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      writeJson(res, 200, {
        roles: ROLES.map(role => ({ id: role.id, title: role.title, persona: role.persona })),
        stages: DEFAULT_STAGES.map(stage => stageView(stage)),
        projectTypes: [...PROJECT_TYPES],
      })
    },
  }), 'collab-studio: meta route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/collab/models',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      let selection: { provider: string; model: string } | null = null
      try {
        selection = defaultModel === undefined ? null : { ...defaultModel.currentSelection() }
      } catch {
        selection = null
      }
      const providers = llm === undefined ? [] : llm.listProviders().map(provider => ({ id: provider.id, name: provider.name }))
      writeJson(res, 200, { default: selection, providers })
    },
  }), 'collab-studio: models route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/collab/projects',
    handler: (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        void store.list()
          .then((projects) => { writeJson(res, 200, { projects }) })
          .catch(() => { writeJson(res, 500, { error: 'listing projects failed' }) })
        return
      }
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      void readJsonBody(req, BODY_LIMIT)
        .then(async (body) => {
          const record = await service.createProject(body)
          writeJson(res, 201, { record, stages: DEFAULT_STAGES.map(stage => stageView(stage, record)) })
        })
        .catch((error: unknown) => {
          if (error instanceof StudioStoreError) writeJson(res, storeErrorStatus(error), { error: error.message })
          else writeJson(res, 400, { error: 'invalid request' })
        })
    },
  }), 'collab-studio: projects route')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: PROJECTS_PREFIX,
    handler: (req, res) => {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      if (rawPath !== PROJECTS_PREFIX && !rawPath.startsWith(`${PROJECTS_PREFIX}/`)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const rest = rawPath.slice(PROJECTS_PREFIX.length).replace(/^\//u, '')
      const slash = rest.indexOf('/')
      const projectId = slash === -1 ? rest : rest.slice(0, slash)
      const suffix = slash === -1 ? '' : rest.slice(slash)
      if (projectId === '' || projectId.includes('..') || projectId.includes('\\')) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      void handleProjectRoute(req, res, projectId, suffix).catch((error: unknown) => {
        if (error instanceof StudioStoreError) writeJson(res, storeErrorStatus(error), { error: error.message })
        else writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    },
  }), 'collab-studio: project routes')

  const handleProjectRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    projectId: string,
    suffix: string,
  ): Promise<void> => {
    const method = req.method ?? 'GET'
    if (suffix === '') {
      if (method === 'GET' || method === 'HEAD') {
        writeJson(res, 200, await service.getProject(projectId))
        return
      }
      if (method === 'DELETE') {
        if (!isLocalControlRequest(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        writeJson(res, 200, await service.deleteProject(projectId))
        return
      }
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (suffix === '/events' && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(req.url ?? '/', 'http://x')
      const after = Number(url.searchParams.get('after') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '300')
      const result = await service.events(
        projectId,
        Number.isFinite(after) && after > 0 ? Math.floor(after) : 0,
        Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300,
      )
      writeJson(res, 200, result)
      return
    }
    if (suffix === '/start' && method === 'POST') {
      if (!isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      await readJsonBody(req, 4096).catch(() => ({}))
      const result = await startProject(projectId)
      writeJson(res, result.started ? 202 : 409, result)
      return
    }
    if (suffix === '/stop' && method === 'POST') {
      if (!isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      await readJsonBody(req, 4096).catch(() => ({}))
      writeJson(res, 200, await stopProject(projectId))
      return
    }
    if (suffix === '/files' && (method === 'GET' || method === 'HEAD')) {
      await store.load(projectId)
      writeJson(res, 200, { files: await store.listFiles(projectId) })
      return
    }
    if (suffix === '/file' && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.searchParams.get('path') ?? ''
      if (path === '') {
        writeJson(res, 400, { error: 'path query parameter required' })
        return
      }
      const result = await service.readFile(projectId, path)
      writeJson(res, 200, { path, ...result })
      return
    }
    writeJson(res, 404, { error: 'not found' })
  }

  ctx.provide('collabStudio', service)

  ctx.effect(() => () => {
    disposed = true
    const pending = [...runs.values()]
    for (const run of pending) run.controller.abort()
    return Promise.race([
      Promise.allSettled(pending.map(run => run.done)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ]).then(() => undefined)
  }, 'collab-studio: run registry')

  ctx.logger.info(`collab-studio: ready at ${config.dataDir}`)
}

export default apply
