/**
 * @deepseek-ai/dsh-model-bench — the model testing bench plugin. One host
 * row over the web surface: it registers the /api/bench routes on the shared
 * webServer, keeps round directories under $DSH_HOME/model-bench, authors
 * category questions (coding / document / vision / paper) through a generator
 * agent, fans each question out to a user-chosen set of models concurrently
 * (every model is its own full harness agent on the same default preset, so
 * all contestants share one identical tool environment), times every run,
 * and has a judge agent grade each submission pass/fail.
 * @module @deepseek-ai/dsh-model-bench
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { ensureSeedImages, isSeedImageName } from './assets.ts'
import { AgentSlotDriver, BenchAbortedError } from './driver.ts'
import { assignContestants, generateQuestion, runContestPhase } from './engine.ts'
import { CATEGORIES } from './prompts.ts'
import { BenchStore, BenchStoreError, defaultDataDir, normalizeCreateRequest, normalizeStartRequest } from './store.ts'
import type { BenchAgentsLike, BenchDefaultModelLike, BenchLlmLike, BenchPresetsLike, ResolvedBenchConfig, RoundRecord } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'model-bench'

/** The web surface must already carry the HTTP carrier. */
export const inject = ['webServer']

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelBench: ModelBenchService
  }
}

/** The `modelBench` service surface other rows may use. */
export interface ModelBenchService {
  listRounds(): Promise<unknown>
  createRound(request: unknown): Promise<RoundRecord>
  getRound(roundId: string): Promise<unknown>
  generateRound(roundId: string): Promise<{ started: boolean; reason?: string }>
  startRound(roundId: string, request: unknown): Promise<{ started: boolean; reason?: string }>
  stopRound(roundId: string): Promise<{ stopped: boolean }>
  deleteRound(roundId: string): Promise<{ deleted: boolean }>
  events(roundId: string, after: number, limit: number): Promise<{ events: unknown[]; total: number }>
  files(roundId: string): Promise<string[]>
  readFile(roundId: string, path: string): Promise<{ text: string; truncated: boolean }>
  isRunning(roundId: string): boolean
}

/** No trailing slash: the webServer matches `prefix` and `prefix/<anything>`. */
const ROUNDS_PREFIX = '/api/bench/rounds'
const DEFAULT_MAX_ROUNDS = 64
const DEFAULT_MAX_EVENT_TAIL = 2000
const DEFAULT_MAX_CONTESTANTS = 12
const DEFAULT_CONTESTANT_TIMEOUT_MS = 20 * 60_000
const DEFAULT_GENERATE_TIMEOUT_MS = 10 * 60_000
const DEFAULT_JUDGE_TIMEOUT_MS = 15 * 60_000
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
export function resolveBenchConfig(raw: unknown): ResolvedBenchConfig {
  const source = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    dataDir: typeof source.dataDir === 'string' && source.dataDir.trim() !== ''
      ? resolve(source.dataDir.trim())
      : defaultDataDir(),
    maxRounds: positive(source.maxRounds, DEFAULT_MAX_ROUNDS),
    maxEventTail: positive(source.maxEventTail, DEFAULT_MAX_EVENT_TAIL),
    maxContestantsPerRound: positive(source.maxContestantsPerRound, DEFAULT_MAX_CONTESTANTS),
    contestantTimeoutMs: positive(source.contestantTimeoutMs, DEFAULT_CONTESTANT_TIMEOUT_MS),
    generateTimeoutMs: positive(source.generateTimeoutMs, DEFAULT_GENERATE_TIMEOUT_MS),
    judgeTimeoutMs: positive(source.judgeTimeoutMs, DEFAULT_JUDGE_TIMEOUT_MS),
  }
}

/** Map one store error to its HTTP status. */
function storeErrorStatus(error: BenchStoreError): number {
  switch (error.code) {
    case 'NOT_FOUND': return 404
    case 'INVALID': return 400
    case 'LIMIT': return 409
    default: return 500
  }
}

/** One live round run (generation or contest phase) and its cancellation handle. */
interface RunEntry {
  readonly controller: AbortController
  readonly done: Promise<void>
}

/**
 * Mount the model bench: store, seed images, run registry, routes, and the
 * `modelBench` service. Disposal stops every run and unregisters routes.
 * @param ctx - plugin context carrying the webServer service.
 * @param rawConfig - the composition row config (coerced defensively).
 */
export function apply(ctx: Context, rawConfig: unknown): void {
  const config = resolveBenchConfig(rawConfig)
  if (!config.enabled) return
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) {
    ctx.logger.warn(new Error('model-bench: webServer service unavailable; routes not registered'))
    return
  }
  const agents = ctx.get('agents') as BenchAgentsLike | undefined
  if (agents === undefined) {
    ctx.logger.warn(new Error('model-bench: agents service unavailable; bench disabled'))
    return
  }
  const presets = ctx.get('agentPresets') as BenchPresetsLike | undefined
  const llm = ctx.get('llm') as BenchLlmLike | undefined
  const defaultModel = ctx.get('agentDefaultModel') as BenchDefaultModelLike | undefined

  const store = new BenchStore(config.dataDir)
  const storageReady = store.settleInterruptedRounds()
    .then((settled) => {
      if (settled > 0) ctx.logger.info(`model-bench: settled ${String(settled)} interrupted round(s)`)
    })
    .catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })
  const runs = new Map<string, RunEntry>()
  /** Guards the async window between the run check and the runs.set commit. */
  const starting = new Set<string>()
  let disposed = false

  // Seed images for vision rounds are maintained best-effort at startup.
  void ensureSeedImages(store.assetsImagesDir())
    .then(names => { ctx.logger.info(`model-bench: ${String(names.length)} seed images ready`) })
    .catch((error: unknown) => {
      ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    })

  const listVisionImages = async (): Promise<string[]> => {
    try {
      return (await readdir(store.assetsImagesDir())).filter(name => isSeedImageName(name)).sort()
    } catch {
      return []
    }
  }

  const emitFor = (roundId: string) =>
    async (type: string, data: Record<string, unknown>): Promise<void> => {
      await store.appendEvent(roundId, type, data)
    }

  /** Shared runner: registers one phase execution under the run registry. */
  const launch = async (
    roundId: string,
    phase: (driver: AgentSlotDriver, controller: AbortController, emit: (type: string, data: Record<string, unknown>) => Promise<void>) => Promise<void>,
    onDone: (record: RoundRecord) => Promise<void>,
    onAbort: (record: RoundRecord) => Promise<void>,
    onFailed: (record: RoundRecord, message: string) => Promise<void>,
  ): Promise<{ started: boolean; reason?: string }> => {
    await storageReady
    if (disposed) return { started: false, reason: 'bench is shutting down' }
    if (runs.has(roundId) || starting.has(roundId)) return { started: false, reason: 'already running' }
    starting.add(roundId)
    try {
      const record = await store.load(roundId)
      const driver = new AgentSlotDriver(agents, presets, defaultModel)
      const controller = new AbortController()
      const emit = emitFor(roundId)
      const done = (async (): Promise<void> => {
        try {
          await phase(driver, controller, emit)
          await onDone(record)
        } catch (error) {
          if (controller.signal.aborted || error instanceof BenchAbortedError) {
            await onAbort(record)
          } else {
            const message = error instanceof Error ? error.message : String(error)
            await onFailed(record, message)
            ctx.logger.warn(new Error(`model-bench: round "${roundId}" failed: ${message}`))
          }
        } finally {
          try {
            await driver.disposeAll()
          } catch (error) {
            ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
          }
          runs.delete(roundId)
        }
      })()
      runs.set(roundId, { controller, done })
      return { started: true }
    } finally {
      starting.delete(roundId)
    }
  }

  const generateRound = async (roundId: string): Promise<{ started: boolean; reason?: string }> => {
    await storageReady
    const record = await store.load(roundId)
    const canGenerate = record.question === undefined
      && ['draft', 'failed', 'stopped'].includes(record.status)
    if (!canGenerate) return { started: false, reason: `cannot generate from status "${record.status}"` }
    return launch(
      roundId,
      async (driver, controller, emit) => {
        const visionImages = record.category === 'vision' ? await listVisionImages() : []
        await generateQuestion(record, {
          store,
          driver,
          signal: controller.signal,
          timeouts: {
            generateMs: config.generateTimeoutMs,
            contestantMs: config.contestantTimeoutMs,
            judgeMs: config.judgeTimeoutMs,
          },
          visionImages,
          emit,
        })
      },
      async () => { /* the engine already settled the record to ready */ },
      async (fresh) => {
        fresh.status = 'stopped'
        delete fresh.error
        await store.save(fresh)
        await emitFor(roundId)('round/stopped', { phase: 'generate' })
      },
      async (fresh, message) => {
        fresh.status = 'failed'
        fresh.error = message
        await store.save(fresh)
        await emitFor(roundId)('round/generate-failed', { error: message })
      },
    )
  }

  const startRound = async (roundId: string, request: unknown): Promise<{ started: boolean; reason?: string }> => {
    await storageReady
    const record = await store.load(roundId)
    if (record.question === undefined) return { started: false, reason: 'question not generated yet' }
    if (!['ready', 'stopped', 'failed', 'done'].includes(record.status)) {
      return { started: false, reason: `cannot start from status "${record.status}"` }
    }
    const normalized = normalizeStartRequest(request, config.maxContestantsPerRound)
    assignContestants(record, normalized.models, normalized.judge)
    await store.save(record)
    await emitFor(roundId)('round/starting', {
      models: normalized.models.map(route => `${route.provider}/${route.model}`),
    })
    return launch(
      roundId,
      async (driver, controller, emit) => {
        await runContestPhase(record, {
          store,
          driver,
          signal: controller.signal,
          timeouts: {
            generateMs: config.generateTimeoutMs,
            contestantMs: config.contestantTimeoutMs,
            judgeMs: config.judgeTimeoutMs,
          },
          visionImages: [],
          emit,
        })
      },
      async () => { /* the engine already settled the record to done */ },
      async (fresh) => {
        fresh.status = 'stopped'
        fresh.finishedAt = Date.now()
        delete fresh.error
        await store.save(fresh)
        await emitFor(roundId)('round/stopped', { phase: 'contest' })
      },
      async (fresh, message) => {
        fresh.status = 'failed'
        fresh.finishedAt = Date.now()
        fresh.error = message
        await store.save(fresh)
        await emitFor(roundId)('round/failed', { error: message })
      },
    )
  }

  const stopRound = async (roundId: string): Promise<{ stopped: boolean }> => {
    const run = runs.get(roundId)
    if (run === undefined) return { stopped: false }
    run.controller.abort()
    await run.done.catch(() => undefined)
    return { stopped: true }
  }

  /** Round detail view: record + question material (answer included). */
  const roundDetail = async (roundId: string): Promise<Record<string, unknown>> => {
    await storageReady
    const record = await store.load(roundId)
    let question: Record<string, unknown> | null = null
    if (record.question !== undefined) {
      const text = await store.readRoundFile(roundId, 'question/question.md')
      const answer = await store.readRoundFile(roundId, 'question/answer.md')
      let materials: string[] = []
      try {
        materials = (await readdir(store.materialsDir(roundId))).sort()
      } catch { /* no materials written yet */ }
      question = {
        text,
        answer,
        materials,
        title: record.question.title,
        difficulty: record.question.difficulty,
        passThreshold: record.question.passThreshold,
        ...record.question.image === undefined ? {} : { image: record.question.image },
      }
    }
    return { record, question }
  }

  const service: ModelBenchService = {
    listRounds: async () => {
      await storageReady
      return store.list()
    },
    createRound: async (request: unknown) => {
      await storageReady
      const normalized = normalizeCreateRequest(request)
      const record = await store.create(normalized, config.maxRounds)
      await store.appendEvent(record.id, 'round/created', {
        category: record.category,
        difficulty: record.difficulty,
        name: record.name,
      })
      if (normalized.start) void generateRound(record.id).catch(() => undefined)
      return record
    },
    getRound: roundDetail,
    generateRound,
    startRound,
    stopRound,
    deleteRound: async (roundId: string) => {
      await storageReady
      await stopRound(roundId)
      await store.delete(roundId)
      return { deleted: true }
    },
    events: async (roundId: string, after: number, limit: number) => {
      await storageReady
      const bounded = Math.max(1, Math.min(limit, config.maxEventTail))
      const { events, total } = await store.readEvents(roundId, after, bounded)
      return { events, total }
    },
    files: async (roundId: string) => {
      await storageReady
      return store.listFiles(roundId)
    },
    readFile: async (roundId: string, path: string) => {
      await storageReady
      await store.load(roundId)
      return store.readFile(roundId, path, DEFAULT_MAX_FILE_READ_BYTES)
    },
    isRunning: (roundId: string) => runs.has(roundId),
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/bench/meta',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      writeJson(res, 200, {
        categories: CATEGORIES.map(spec => ({ id: spec.id, title: spec.title, description: spec.description })),
        limits: {
          maxContestantsPerRound: config.maxContestantsPerRound,
          contestantTimeoutMs: config.contestantTimeoutMs,
          generateTimeoutMs: config.generateTimeoutMs,
          judgeTimeoutMs: config.judgeTimeoutMs,
        },
      })
    },
  }), 'model-bench: meta route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/bench/models',
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      void (async () => {
        let selection: { provider: string; model: string } | null = null
        try {
          selection = defaultModel === undefined ? null : { ...defaultModel.currentSelection() }
        } catch {
          selection = null
        }
        const providers: { id: string; name: string; models: { id: string; name: string }[] }[] = []
        if (llm !== undefined) {
          for (const provider of llm.listProviders()) {
            try {
              const models = await llm.listModels(provider.id)
              providers.push({
                id: provider.id,
                name: provider.name,
                models: models.map(model => ({ id: model.id, name: model.name ?? model.id })),
              })
            } catch {
              // One unreadable provider never blocks the catalog.
            }
          }
        }
        writeJson(res, 200, { default: selection, providers })
      })().catch(() => { writeJson(res, 500, { error: 'model catalog failed' }) })
    },
  }), 'model-bench: models route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/bench/rounds',
    handler: (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        void service.listRounds()
          .then(rounds => { writeJson(res, 200, { rounds }) })
          .catch(() => { writeJson(res, 500, { error: 'listing rounds failed' }) })
        return
      }
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      void readJsonBody(req, BODY_LIMIT)
        .then(async (body) => {
          const record = await service.createRound(body)
          writeJson(res, 201, { record })
        })
        .catch((error: unknown) => {
          if (error instanceof BenchStoreError) writeJson(res, storeErrorStatus(error), { error: error.message })
          else writeJson(res, 400, { error: 'invalid request' })
        })
    },
  }), 'model-bench: rounds route')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUNDS_PREFIX,
    handler: (req, res) => {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      if (rawPath !== ROUNDS_PREFIX && !rawPath.startsWith(`${ROUNDS_PREFIX}/`)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      const rest = rawPath.slice(ROUNDS_PREFIX.length).replace(/^\//u, '')
      const slash = rest.indexOf('/')
      const roundId = slash === -1 ? rest : rest.slice(0, slash)
      const suffix = slash === -1 ? '' : rest.slice(slash)
      if (roundId === '' || roundId.includes('..') || roundId.includes('\\') || roundId === 'assets') {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      void handleRoundRoute(req, res, roundId, suffix).catch((error: unknown) => {
        if (error instanceof BenchStoreError) writeJson(res, storeErrorStatus(error), { error: error.message })
        else writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    },
  }), 'model-bench: round routes')

  const handleRoundRoute = async (
    req: IncomingMessage,
    res: ServerResponse,
    roundId: string,
    suffix: string,
  ): Promise<void> => {
    const method = req.method ?? 'GET'
    if (suffix === '') {
      if (method === 'GET' || method === 'HEAD') {
        writeJson(res, 200, await service.getRound(roundId))
        return
      }
      if (method === 'DELETE') {
        if (!isLocalControlRequest(req)) {
          writeJson(res, 403, { error: 'forbidden' })
          return
        }
        writeJson(res, 200, await service.deleteRound(roundId))
        return
      }
      writeJson(res, 405, { error: 'method not allowed' })
      return
    }
    if (suffix === '/events' && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(req.url ?? '/', 'http://x')
      const after = Number(url.searchParams.get('after') ?? '0')
      const limit = Number(url.searchParams.get('limit') ?? '300')
      const result = await service.events(roundId, Number.isFinite(after) && after > 0 ? Math.floor(after) : 0, Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 300)
      writeJson(res, 200, result)
      return
    }
    if (suffix === '/generate' && method === 'POST') {
      if (!isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      await readJsonBody(req, 4096).catch(() => ({}))
      const result = await generateRound(roundId)
      writeJson(res, result.started ? 202 : 409, result)
      return
    }
    if (suffix === '/start' && method === 'POST') {
      if (!isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      const body = await readJsonBody(req, BODY_LIMIT).catch(() => ({}))
      try {
        const result = await startRound(roundId, body)
        writeJson(res, result.started ? 202 : 409, result)
      } catch (error) {
        if (error instanceof BenchStoreError) writeJson(res, storeErrorStatus(error), { error: error.message })
        else writeJson(res, 400, { error: 'invalid request' })
      }
      return
    }
    if (suffix === '/stop' && method === 'POST') {
      if (!isLocalControlRequest(req)) {
        writeJson(res, 403, { error: 'forbidden' })
        return
      }
      await readJsonBody(req, 4096).catch(() => ({}))
      writeJson(res, 200, await stopRound(roundId))
      return
    }
    if (suffix === '/files' && (method === 'GET' || method === 'HEAD')) {
      await store.load(roundId)
      writeJson(res, 200, { files: await store.listFiles(roundId) })
      return
    }
    if (suffix === '/file' && (method === 'GET' || method === 'HEAD')) {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.searchParams.get('path') ?? ''
      if (path === '') {
        writeJson(res, 400, { error: 'path query parameter required' })
        return
      }
      const result = await service.readFile(roundId, path)
      writeJson(res, 200, { path, ...result })
      return
    }
    writeJson(res, 404, { error: 'not found' })
  }

  ctx.provide('modelBench', service)

  ctx.effect(() => () => {
    disposed = true
    const pending = [...runs.values()]
    for (const run of pending) run.controller.abort()
    return Promise.race([
      Promise.allSettled(pending.map(run => run.done)),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 10_000)
        if (typeof timer.unref === 'function') timer.unref()
      }),
    ]).then(() => undefined)
  }, 'model-bench: run registry')

  ctx.logger.info(`model-bench: ready at ${config.dataDir}`)
}

export default apply
