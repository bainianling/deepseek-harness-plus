/** Read-only Hindsight projection used by the Web knowledge center. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { registerKnowledgeRoutes, type KnowledgeSourceConfig } from '../src/knowledge.ts'

interface CapturedRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

const config: KnowledgeSourceConfig = {
  hindsightUrl: 'http://127.0.0.1:9077',
  hindsightBankId: 'coding-agent::deepseek-harness',
  knowledgeTimeoutMs: 5000,
}

function install(): { ctx: Context; routes: CapturedRoute[] } {
  const ctx = new Context()
  const routes: CapturedRoute[] = []
  ctx.provide('webServer', {
    register: (route: CapturedRoute) => {
      routes.push(route)
      return () => {}
    },
  } as never)
  registerKnowledgeRoutes(ctx, config)
  return { ctx, routes }
}

async function run(route: CapturedRoute, url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0
  let text = ''
  let finish: (() => void) | undefined
  const done = new Promise<void>((resolve) => { finish = resolve })
  const response = {
    writeHead: (next: number) => { status = next },
    end: (payload?: string) => { text = payload ?? ''; finish?.() },
  } as unknown as ServerResponse
  void route.handler({ method: 'GET', url } as IncomingMessage, response)
  await done
  return { status, body: JSON.parse(text) as Record<string, unknown> }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('knowledge projection', () => {
  it('flattens the Hindsight tree and projects health metadata', async () => {
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
      return { ok: true, json: async () => body }
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
    await ctx.fiber.dispose()
  })

  it('returns a structured offline response when Hindsight cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const { ctx, routes } = install()
    await Promise.resolve()
    const route = routes.find(entry => entry.path === '/api/knowledge/snapshot')
    if (route === undefined) throw new Error('snapshot route missing')
    const response = await run(route, '/api/knowledge/snapshot')

    expect(response).toEqual({
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

    expect(response).toEqual({ status: 400, body: { error: 'invalid page id' } })
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
