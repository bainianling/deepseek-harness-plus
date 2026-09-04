/**
 * Read-only Hindsight adapter for the Web knowledge center. The browser reads
 * one DSH-owned projection instead of depending on Hindsight's internal API.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'

/** Configuration required by the Hindsight knowledge projection. */
export interface KnowledgeSourceConfig {
  /** Base URL of the local Hindsight API. */
  hindsightUrl: string
  /** Hindsight bank projected into this Web GUI. */
  hindsightBankId: string
  /** Maximum duration of one upstream request. */
  knowledgeTimeoutMs: number
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

function sourceUrl(config: KnowledgeSourceConfig, path: string): URL {
  const base = config.hindsightUrl.endsWith('/') ? config.hindsightUrl : `${config.hindsightUrl}/`
  const bank = encodeURIComponent(config.hindsightBankId)
  return new URL(`v1/default/banks/${bank}/${path}`, base)
}

async function readHindsight<T>(config: KnowledgeSourceConfig, path: string): Promise<T> {
  const response = await fetch(sourceUrl(config, path), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(config.knowledgeTimeoutMs),
  })
  if (!response.ok) throw new Error(`Hindsight ${response.status} ${response.statusText}`)
  return await response.json() as T
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

/** Register the DSH-owned read projection consumed by the knowledge center. */
export function registerKnowledgeRoutes(ctx: Context, config: KnowledgeSourceConfig): void {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/knowledge/snapshot',
    handler: (req, res) => {
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
    },
  }), 'web-app: knowledge snapshot route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/api/knowledge/pages',
    handler: (req: IncomingMessage, res: ServerResponse) => {
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
    },
  }), 'web-app: knowledge page route')
}
