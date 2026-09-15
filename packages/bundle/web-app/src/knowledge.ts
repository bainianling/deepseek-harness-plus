/**
 * Read-only Hindsight adapter for the Web knowledge center. The browser reads
 * one DSH-owned projection instead of depending on Hindsight's internal API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { HindsightLifecycle, type HindsightLifecycleSnapshot } from './hindsight.ts'

/** Configuration required by the Hindsight knowledge projection. */
export interface KnowledgeSourceConfig {
  /** Base URL of the local Hindsight API. */
  hindsightUrl: string
  /** Hindsight bank projected into this Web GUI. */
  hindsightBankId: string
  /** Maximum duration of one upstream request. */
  knowledgeTimeoutMs: number
  /** Local Hindsight profile passed to the fixed daemon command. */
  hindsightProfile: string
  /** Trusted executable name or absolute path for manual daemon startup. */
  hindsightCommand: string
  /** Bounded wait for the daemon to become healthy after a manual start. */
  hindsightStartTimeoutMs: number
}

interface HindsightFolderNode {
  id: string
  kind: 'folder'
  name: string
  managed?: boolean
  timestamp?: string
  children?: HindsightNode[]
}

interface HindsightPageNode {
  id: string
  kind: 'page'
  name: string
  parent_id?: string
  mental_model_id?: string
  managed?: boolean
  description?: string
  tags?: string[]
  timestamp?: string
  is_stale?: boolean
  children?: HindsightNode[]
}

type HindsightNode = HindsightFolderNode | HindsightPageNode

interface HindsightTree {
  roots?: HindsightNode[]
}

interface HindsightStats {
  total_nodes?: number
  total_links?: number
  total_documents?: number
  total_observations?: number
  pending_operations?: number
  failed_operations?: number
  pending_consolidation?: number
  failed_consolidation?: number
  last_consolidated_at?: string
  last_memory_write_at?: string
  nodes_by_fact_type?: Record<string, number>
  operations_by_status?: Record<string, number>
}

interface HindsightTags {
  items?: { tag: string; count: number }[]
}

interface KnowledgeFolder {
  id: string
  name: string
  parentId: string | null
  depth: number
  path: string[]
  pageCount: number
}

interface KnowledgePageSummary {
  id: string
  name: string
  description: string
  folderId: string | null
  folderPath: string[]
  tags: string[]
  updatedAt: string | null
  stale: boolean
  managed: boolean
}

interface FlatTree {
  folders: KnowledgeFolder[]
  pages: KnowledgePageSummary[]
}

const PAGE_ID = /^kp-[a-f0-9]+$/u

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

type KnowledgeRequestRejection = 401 | 403 | undefined

type RequestRejection = (req: IncomingMessage) => KnowledgeRequestRejection

const REQUEST_BODY_TIMEOUT_MS = 5_000
const REQUEST_BODY_DRAIN_MAX_BYTES = 64 * 1024
const REQUEST_STREAM_CLEANUP_GRACE_MS = 1_000

function chunkByteLength(chunk: unknown): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk)
  if (Buffer.isBuffer(chunk)) return chunk.byteLength
  if (chunk instanceof Uint8Array) return chunk.byteLength
  return 0
}

function destroyRequest(req: IncomingMessage): void {
  try { req.destroy() } catch { /* best effort after an oversized or stalled body */ }
}

function lifecyclePayload(config: KnowledgeSourceConfig, state: HindsightLifecycleSnapshot): Record<string, unknown> {
  return {
    ...state,
    error: state.message,
    source: {
      kind: 'hindsight',
      status: state.status,
      bankId: config.hindsightBankId,
      readOnly: true,
    },
  }
}

function rejectRequest(req: IncomingMessage, res: ServerResponse, requestRejection: RequestRejection): boolean {
  const rejection = requestRejection(req)
  if (rejection === undefined) return false
  drainRequest(req)
  res.writeHead(rejection)
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}

function drainRequest(req: IncomingMessage): void {
  if (typeof req.resume !== 'function' || req.readableEnded) return
  let settled = false
  let bytes = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cleanupGraceTimer: ReturnType<typeof setTimeout> | undefined
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    if (cleanupGraceTimer !== undefined) clearTimeout(cleanupGraceTimer)
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('aborted', onAborted)
    req.off('close', onClose)
    req.off('error', onError)
  }
  const finish = (destroy = false, waitForClose = false): void => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    req.off('data', onData)
    req.off('end', onEnd)
    req.off('aborted', onAborted)
    // Arm the bounded fallback before destroy: some stream implementations emit
    // `close` synchronously from destroy(), and that close must be able to clear
    // the fallback rather than leaving a timer behind.
    if (waitForClose) cleanupGraceTimer = setTimeout(cleanup, REQUEST_STREAM_CLEANUP_GRACE_MS)
    if (destroy) destroyRequest(req)
    // Keep both close and error listeners until the stream closes. This covers
    // a late socket error after an early rejection or forced body destruction.
    if (!waitForClose) cleanup()
  }
  const onData = (chunk: unknown): void => {
    bytes += chunkByteLength(chunk)
    if (bytes > REQUEST_BODY_DRAIN_MAX_BYTES) finish(true, true)
  }
  const onEnd = (): void => { finish(false, true) }
  const onAborted = (): void => { finish(false, true) }
  const onClose = (): void => {
    if (settled) cleanup()
    else finish(false)
  }
  const onError = (): void => { finish(false, true) }
  req.on('data', onData)
  req.once('end', onEnd)
  req.once('aborted', onAborted)
  req.once('close', onClose)
  req.on('error', onError)
  timer = setTimeout(() => { finish(true, true) }, REQUEST_BODY_TIMEOUT_MS)
  try { req.resume() } catch { onError() }
}

/** Resolve only after the request stream proves that no body bytes arrived. */
function requestBodyIsEmpty(req: IncomingMessage): Promise<boolean> {
  const transferEncoding = req.headers['transfer-encoding']
  if (transferEncoding !== undefined) {
    drainRequest(req)
    return Promise.resolve(false)
  }
  const contentLength = req.headers['content-length']
  if (contentLength !== undefined) {
    if (Array.isArray(contentLength) || !/^\d+$/u.test(contentLength) || Number(contentLength) !== 0) {
      drainRequest(req)
      return Promise.resolve(false)
    }
    return Promise.resolve(true)
  }
  if (req.readableEnded) return Promise.resolve(true)
  return new Promise(resolve => {
    let hasData = false
    let bytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cleanupGraceTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (cleanupGraceTimer !== undefined) clearTimeout(cleanupGraceTimer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('close', onClose)
      req.off('error', onError)
    }
    const finish = (empty: boolean, destroy = false, waitForClose = false): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      // Arm the bounded fallback before destroy: some stream implementations emit
      // `close` synchronously from destroy(), and that close must be able to clear
      // the fallback rather than leaving a timer behind.
      if (waitForClose) cleanupGraceTimer = setTimeout(cleanup, REQUEST_STREAM_CLEANUP_GRACE_MS)
      if (destroy) destroyRequest(req)
      // Resolve immediately, but keep cleanup listeners until close when the
      // stream was aborted/destroyed so late errors remain handled.
      if (!waitForClose) cleanup()
      resolve(empty)
    }
    const onData = (chunk: unknown): void => {
      hasData = true
      bytes += chunkByteLength(chunk)
      if (bytes > REQUEST_BODY_DRAIN_MAX_BYTES) finish(false, true, true)
    }
    const onEnd = (): void => { finish(!hasData, false, true) }
    const onAborted = (): void => { finish(false, false, true) }
    const onClose = (): void => {
      if (settled) cleanup()
      else finish(false)
    }
    const onError = (): void => { finish(false, false, true) }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('close', onClose)
    req.on('error', onError)
    timer = setTimeout(() => { finish(false, true, true) }, REQUEST_BODY_TIMEOUT_MS)
    try { req.resume() } catch { onError() }
  })
}

function sourceUrl(config: KnowledgeSourceConfig, path: string): URL {
  const base = config.hindsightUrl.endsWith('/') ? config.hindsightUrl : `${config.hindsightUrl}/`
  const bank = encodeURIComponent(config.hindsightBankId)
  return new URL(`v1/default/banks/${bank}/${path}`, base)
}

async function releaseResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A body may already be consumed or aborted; this is best-effort cleanup.
  }
}

async function readHindsight<T>(config: KnowledgeSourceConfig, path: string): Promise<T> {
  const response = await fetch(sourceUrl(config, path), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.knowledgeTimeoutMs),
  })
  if (!response.ok) {
    await releaseResponseBody(response)
    throw new Error(`Hindsight ${response.status} ${response.statusText}`)
  }
  try {
    return await response.json() as T
  } finally {
    await releaseResponseBody(response)
  }
}

function flattenTree(tree: HindsightTree): FlatTree {
  const folders: KnowledgeFolder[] = []
  const pages: KnowledgePageSummary[] = []

  const visit = (node: HindsightNode, parentId: string | null, path: string[]): number => {
    if (node.kind === 'page') {
      pages.push({
        id: node.id,
        name: node.name,
        description: node.description ?? '',
        folderId: parentId,
        folderPath: path,
        tags: node.tags ?? [],
        updatedAt: node.timestamp ?? null,
        stale: node.is_stale ?? false,
        managed: node.managed ?? false,
      })
      return 1
    }

    const nextPath = [...path, node.name]
    let pageCount = 0
    for (const child of node.children ?? []) pageCount += visit(child, node.id, nextPath)
    folders.push({
      id: node.id,
      name: node.name,
      parentId,
      depth: path.length,
      path: nextPath,
      pageCount,
    })
    return pageCount
  }

  for (const root of tree.roots ?? []) visit(root, null, [])
  folders.sort((left, right) => left.path.join('/').localeCompare(right.path.join('/')))
  pages.sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''))
  return { folders, pages }
}

function upstreamError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'Hindsight request timed out'
  return error instanceof Error ? error.message : String(error)
}

/** Register the DSH-owned read projection and local lifecycle controls. */
export function registerKnowledgeRoutes(
  ctx: Context,
  config: KnowledgeSourceConfig,
  isLocalControlRequest: (req: IncomingMessage) => boolean,
  requestRejection: RequestRejection,
): void {
  const lifecycle = new HindsightLifecycle(config)
  const webServer = ctx.webServer
  ctx.effect(() => () => { lifecycle.dispose() }, 'web-app: hindsight lifecycle')

  const guarded = (handler: (req: IncomingMessage, res: ServerResponse) => void): ((req: IncomingMessage, res: ServerResponse) => void) => {
    return (req, res) => {
      if (rejectRequest(req, res, requestRejection)) return
      handler(req, res)
    }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/knowledge/status',
    handler: guarded((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      void lifecycle.status().then((state) => {
        writeJson(res, 200, lifecyclePayload(config, state))
      })
    }),
  }), 'web-app: knowledge status route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/knowledge/start',
    handler: guarded((req, res) => {
      if (req.method !== 'POST' || !isLocalControlRequest(req)) {
        // Finish consuming an otherwise rejected request so a keep-alive
        // connection cannot carry unread bytes into the next route.
        drainRequest(req)
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      void requestBodyIsEmpty(req).then(empty => {
        if (!empty) {
          writeJson(res, 400, { error: 'request body must be empty' })
          return
        }
        const state: HindsightLifecycleSnapshot = lifecycle.requestStart()
        writeJson(res, state.status === 'starting' ? 202 : state.status === 'online' ? 200 : 503, lifecyclePayload(config, state))
      }).catch(() => {
        writeJson(res, 400, { error: 'invalid request body' })
      })
    }),
  }), 'web-app: knowledge start route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/knowledge/snapshot',
    handler: guarded((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      void Promise.all([
        readHindsight<HindsightTree>(config, 'knowledge-base/tree'),
        readHindsight<HindsightStats>(config, 'stats'),
        readHindsight<HindsightTags>(config, 'tags'),
      ]).then(([tree, stats, tags]) => {
        const flat = flattenTree(tree)
        writeJson(res, 200, {
          source: {
            kind: 'hindsight',
            status: 'online',
            bankId: config.hindsightBankId,
            readOnly: true,
            syncedAt: new Date().toISOString(),
          },
          ...flat,
          stats: {
            facts: stats.total_nodes ?? 0,
            links: stats.total_links ?? 0,
            documents: stats.total_documents ?? 0,
            observations: stats.total_observations ?? 0,
            pendingOperations: stats.pending_operations ?? 0,
            failedOperations: stats.failed_operations ?? 0,
            pendingConsolidation: stats.pending_consolidation ?? 0,
            failedConsolidation: stats.failed_consolidation ?? 0,
            lastConsolidatedAt: stats.last_consolidated_at ?? null,
            lastMemoryWriteAt: stats.last_memory_write_at ?? null,
            factsByType: stats.nodes_by_fact_type ?? {},
            operationsByStatus: stats.operations_by_status ?? {},
          },
          tags: tags.items ?? [],
        })
      }).catch((error: unknown) => {
        writeJson(res, 503, {
          error: upstreamError(error),
          source: { kind: 'hindsight', status: 'offline', bankId: config.hindsightBankId, readOnly: true },
        })
      })
    }),
  }), 'web-app: knowledge snapshot route')

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: '/api/knowledge/pages',
    handler: guarded((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: 'method not allowed' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const prefix = '/api/knowledge/pages/'
      if (!pathname.startsWith(prefix)) {
        writeJson(res, 404, { error: 'not found' })
        return
      }
      let pageId: string
      try {
        pageId = decodeURIComponent(pathname.slice(prefix.length))
      } catch {
        writeJson(res, 400, { error: 'invalid page id' })
        return
      }
      if (!PAGE_ID.test(pageId)) {
        writeJson(res, 400, { error: 'invalid page id' })
        return
      }
      void readHindsight<Record<string, unknown>>(config, `knowledge-base/pages/${pageId}`)
        .then((page) => { writeJson(res, 200, { page }) })
        .catch((error: unknown) => {
          writeJson(res, 503, { error: upstreamError(error) })
        })
    }),
  }), 'web-app: knowledge page route')
}
