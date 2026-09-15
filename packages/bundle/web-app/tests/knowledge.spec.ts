/** Hindsight projection and manual lifecycle routes used by the Web knowledge center. */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { HindsightLifecycle } from '../src/hindsight.ts'
import { registerKnowledgeRoutes, type KnowledgeSourceConfig } from '../src/knowledge.ts'

interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

type RequestRejection = (req: IncomingMessage) => 401 | 403 | undefined
type LocalControlRequest = (req: IncomingMessage) => boolean

const config: KnowledgeSourceConfig = {
  hindsightUrl: 'http://127.0.0.1:9077',
  hindsightBankId: 'coding-agent::deepseek-harness',
  knowledgeTimeoutMs: 5000,
  hindsightProfile: 'dsh-local',
  hindsightCommand: 'hindsight-embed',
  hindsightStartTimeoutMs: 30_000,
}

function install(
  requestRejection: RequestRejection = () => undefined,
  isLocalControlRequest: LocalControlRequest = () => true,
): { ctx: Context; routes: CapturedRoute[] } {
  const ctx = new Context()
  const routes: CapturedRoute[] = []
  ctx.provide('webServer', {
    register: (route: CapturedRoute) => {
      routes.push(route)
      return () => {}
    },
  } as never)
  registerKnowledgeRoutes(ctx, config, isLocalControlRequest, requestRejection)
  return { ctx, routes }
}

async function run(
  route: CapturedRoute,
  url: string,
  options: {
    method?: string
    headers?: Record<string, string>
    remoteAddress?: string
    host?: string
    origin?: string
    encrypted?: boolean
    readableEnded?: boolean
    bodyChunks?: string[]
    streamError?: boolean
  } = {},
): Promise<{ status: number; body: Record<string, unknown>; request: IncomingMessage }> {
  let status = 0
  let text = ''
  let finish: (() => void) | undefined
  const done = new Promise<void>((resolve) => { finish = resolve })
  const response = {
    writeHead: (next: number) => { status = next },
    end: (payload?: string) => { text = payload ?? ''; finish?.() },
  } as unknown as ServerResponse
  const request = new EventEmitter() as IncomingMessage & {
    readableEnded: boolean
    resume: () => void
    setEncoding: (encoding: BufferEncoding) => void
  }
  request.method = options.method ?? 'GET'
  request.url = url
  request.headers = {
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...options.headers,
  }
  request.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1', encrypted: options.encrypted === true } as never
  request.readableEnded = options.readableEnded ?? true
  request.setEncoding = vi.fn()
  const resume = vi.fn(() => {
    if (request.readableEnded) return
    request.readableEnded = true
    queueMicrotask(() => {
      if (options.streamError) request.emit('error', new Error('request stream failed'))
      else {
        for (const chunk of options.bodyChunks ?? []) request.emit('data', chunk)
        request.emit('end')
      }
      request.emit('close')
    })
  })
  request.resume = resume as unknown as typeof request.resume
  void route.handler(request, response)
  await done
  let body: Record<string, unknown> = {}
  if (text !== '') {
    try { body = JSON.parse(text) as Record<string, unknown> }
    catch { body = { raw: text } }
  }
  return { status, body, request }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('knowledge projection', () => {
  it('flattens the Hindsight tree and projects health metadata', async () => {
    const cancels: ReturnType<typeof vi.fn>[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
      const path = url.pathname
      const body = path.endsWith('/knowledge-base/tree')
        ? { roots: [{ id: 'kf-a', kind: 'folder', name: 'Architecture', children: [{ id: 'kp-a', kind: 'page', name: 'Boundaries', description: 'System ownership', tags: ['scope:a'], timestamp: '2026-08-30T00:00:00Z', is_stale: true }] }] }
        : path.endsWith('/stats')
          ? {
            total_nodes: 182,
            total_links: 2532,
            total_documents: 12,
            total_observations: 84,
            pending_operations: 2,
            failed_operations: 3,
          }
          : { items: [{ tag: 'scope:a', count: 4 }] }
      const cancel = vi.fn(async () => {})
      cancels.push(cancel)
      return { ok: true, body: { cancel }, json: async () => body }
    }))
    const { ctx, routes } = install()
    await Promise.resolve()
    const route = routes.find(entry => entry.path === '/api/knowledge/snapshot')
    if (route === undefined) throw new Error('snapshot route missing')
    const response = await run(route, '/api/knowledge/snapshot')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({
      source: { kind: 'hindsight', status: 'online', bankId: 'coding-agent::deepseek-harness', readOnly: true },
      folders: [{ id: 'kf-a', name: 'Architecture', pageCount: 1, path: ['Architecture'] }],
      pages: [{ id: 'kp-a', folderId: 'kf-a', folderPath: ['Architecture'], stale: true }],
      stats: { facts: 182, links: 2532, documents: 12, observations: 84, pendingOperations: 2, failedOperations: 3 },
      tags: [{ tag: 'scope:a', count: 4 }],
    })
    expect(cancels).toHaveLength(3)
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('releases an upstream error response body before returning offline', async () => {
    const cancel = vi.fn(async () => {})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      body: { cancel },
    })))
    const { ctx, routes } = install()
    await Promise.resolve()
    const route = routes.find(entry => entry.path === '/api/knowledge/snapshot')
    if (route === undefined) throw new Error('snapshot route missing')
    const response = await run(route, '/api/knowledge/snapshot')

    expect(response.status).toBe(503)
    expect(cancel).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('returns a structured offline response when Hindsight cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const { ctx, routes } = install()
    await Promise.resolve()
    const route = routes.find(entry => entry.path === '/api/knowledge/snapshot')
    if (route === undefined) throw new Error('snapshot route missing')
    const response = await run(route, '/api/knowledge/snapshot')

    expect(response).toMatchObject({
      status: 503,
      body: {
        error: 'connect ECONNREFUSED',
        source: { kind: 'hindsight', status: 'offline', bankId: 'coding-agent::deepseek-harness', readOnly: true },
      },
    })
    await ctx.fiber.dispose()
  })

  it('rejects malformed page ids before reading Hindsight', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, routes } = install()
    await Promise.resolve()
    const route = routes.find(entry => entry.path === '/api/knowledge/pages')
    if (route === undefined) throw new Error('page route missing')
    const response = await run(route, '/api/knowledge/pages/not-a-page')

    expect(response).toMatchObject({ status: 400, body: { error: 'invalid page id' } })
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('knowledge lifecycle routes', () => {
  const offline = {
    status: 'offline' as const,
    errorCode: null,
    message: null,
    startedAt: null,
  }
  const starting = {
    status: 'starting' as const,
    errorCode: null,
    message: null,
    startedAt: null,
  }

  it('returns daemon status through the Host-owned route', async () => {
    const status = vi.spyOn(HindsightLifecycle.prototype, 'status').mockResolvedValue(offline)
    const { ctx, routes } = install()
    const route = routes.find(entry => entry.path === '/api/knowledge/status')
    if (route === undefined) throw new Error('status route missing')

    const response = await run(route, '/api/knowledge/status')

    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ status: 'offline', error: null, source: { status: 'offline', bankId: config.hindsightBankId } })
    expect(status).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('authenticates every Knowledge route before reading or starting Hindsight', async () => {
    const rejection = vi.fn<RequestRejection>(() => 401)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { ctx, routes } = install(rejection)
    const statusRoute = routes.find(entry => entry.path === '/api/knowledge/status')
    const startRoute = routes.find(entry => entry.path === '/api/knowledge/start')
    if (statusRoute === undefined || startRoute === undefined) throw new Error('lifecycle route missing')

    const statusResponse = await run(statusRoute, '/api/knowledge/status', { readableEnded: false })
    const startResponse = await run(startRoute, '/api/knowledge/start', { method: 'POST', readableEnded: false })

    expect(statusResponse).toMatchObject({ status: 401, body: { raw: 'unauthorized' } })
    expect(startResponse).toMatchObject({ status: 401, body: { raw: 'unauthorized' } })
    expect(rejection).toHaveBeenCalledTimes(2)
    expect((statusResponse.request as IncomingMessage & { resume: ReturnType<typeof vi.fn> }).resume).toHaveBeenCalledOnce()
    expect((startResponse.request as IncomingMessage & { resume: ReturnType<typeof vi.fn> }).resume).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('starts only for local empty-body POST requests and rejects framed bodies', async () => {
    const start = vi.spyOn(HindsightLifecycle.prototype, 'requestStart').mockReturnValue(starting)
    const { ctx, routes } = install()
    const route = routes.find(entry => entry.path === '/api/knowledge/start')
    if (route === undefined) throw new Error('start route missing')

    const accepted = await run(route, '/api/knowledge/start', { method: 'POST' })
    expect(accepted.status).toBe(202)
    expect(accepted.body).toMatchObject({ status: 'starting', source: { status: 'starting' } })
    expect(start).toHaveBeenCalledOnce()

    const withLength = await run(route, '/api/knowledge/start', {
      method: 'POST',
      headers: { 'content-length': '1' },
      readableEnded: false,
      bodyChunks: ['x'],
    })
    expect(withLength.status).toBe(400)
    expect(withLength.body).toEqual({ error: 'request body must be empty' })

    const chunked = await run(route, '/api/knowledge/start', {
      method: 'POST',
      headers: { 'transfer-encoding': 'chunked' },
      readableEnded: false,
    })
    expect(chunked.status).toBe(400)

    const eofBody = await run(route, '/api/knowledge/start', {
      method: 'POST',
      readableEnded: false,
      bodyChunks: ['unexpected'],
    })
    expect(eofBody.status).toBe(400)

    const errored = await run(route, '/api/knowledge/start', {
      method: 'POST',
      readableEnded: false,
      streamError: true,
    })
    expect(errored.status).toBe(400)
    expect(start).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('rejects non-local start requests before lifecycle access', async () => {
    const start = vi.spyOn(HindsightLifecycle.prototype, 'requestStart')
    const { ctx, routes } = install(() => undefined, () => false)
    const route = routes.find(entry => entry.path === '/api/knowledge/start')
    if (route === undefined) throw new Error('start route missing')

    const response = await run(route, '/api/knowledge/start', { method: 'POST', readableEnded: false })

    expect(response.status).toBe(403)
    expect(start).not.toHaveBeenCalled()
    expect((response.request as IncomingMessage & { resume: ReturnType<typeof vi.fn> }).resume).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
