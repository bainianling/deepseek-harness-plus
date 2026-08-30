/** Public tool-market catalog normalization, filtering, and risk policy. */
import { describe, expect, it } from 'vitest'
import type { MarketCatalog, MarketItem } from '../src/market.ts'
import { internals } from '../src/market.ts'

function item(overrides: Partial<MarketItem>): MarketItem {
  return {
    id: 'skill:test', kind: 'skill', name: 'Test Skill', publisher: 'tester', description: 'Testing helper',
    sourceUrl: 'https://example.com/project', codeUrl: 'https://github.com/example/project', registry: 'test',
    publishedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', stars: 1,
    language: 'TypeScript', license: 'MIT', install: 'npx skills add example/project',
    risk: { level: 'low', confidence: 'metadata', rationale: 'public source', signals: ['公开源码'] }, tags: ['testing'],
    ...overrides,
  }
}

function catalog(items: MarketItem[]): MarketCatalog {
  return { items, sources: [], fetchedAt: '2026-01-03T00:00:00.000Z', cached: false, translation: { engine: 'none', translated: items.length, pending: 0 } }
}

describe('skill market policy', () => {
  it('treats DSH plugins as high-impact host code even when metadata looks benign', () => {
    const risk = internals.assess('dsh-plugin', 'A compact UI extension', 'pnpm add @example/dsh-ui', ['ui'])
    expect(risk.level).toBe('high')
    expect(risk.signals).toContain('宿主插件代码执行')
  })

  it('marks credential or shell capabilities as high risk', () => {
    const risk = internals.assess('mcp', 'Reads SSH credentials and executes shell commands', 'npx server', [])
    expect(risk.level).toBe('high')
    expect(risk.signals).toEqual(expect.arrayContaining(['宿主命令或代码执行', '凭据或会话访问']))
  })

  it('sorts by latest update by default and supports category plus search filtering', () => {
    const older = item({ id: 'skill:older', name: 'Docs helper', updatedAt: '2026-01-05T00:00:00.000Z' })
    const newer = item({ id: 'mcp:newer', kind: 'mcp', name: 'Database MCP', description: 'Read PostgreSQL schemas', updatedAt: '2026-04-05T00:00:00.000Z' })
    const plugin = item({ id: 'dsh:plugin', kind: 'dsh-plugin', name: 'DSH Vision', updatedAt: '2026-03-05T00:00:00.000Z', risk: { level: 'high', confidence: 'static', rationale: 'host code', signals: ['宿主插件代码执行'] } })

    expect(internals.filterCatalog(catalog([older, newer, plugin]), '', 'all', '', 'date').items.map(entry => entry.id))
      .toEqual(['mcp:newer', 'dsh:plugin', 'skill:older'])
    expect(internals.filterCatalog(catalog([older, newer, plugin]), 'postgresql', 'mcp', '', 'date').items.map(entry => entry.id))
      .toEqual(['mcp:newer'])
    expect(internals.filterCatalog(catalog([older, newer, plugin]), '', 'all', 'high', 'date').items.map(entry => entry.id))
      .toEqual(['dsh:plugin'])
  })

  it('parses the nested MCP Registry entry shape and keeps only the latest version', () => {
    const items = internals.parseRegistryEntries({
      servers: [
        {
          server: { name: 'ac.inference.sh/mcp', title: 'inference.sh', version: '1.0.0', description: 'Run AI apps.', remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }] },
          _meta: { 'io.modelcontextprotocol.registry/official': { publishedAt: '2026-04-13T17:32:20Z', updatedAt: '2026-04-13T17:32:20Z', isLatest: false } },
        },
        {
          server: { name: 'ac.inference.sh/mcp', title: 'inference.sh', version: '2.0.0', description: 'Run AI apps.', remotes: [{ type: 'streamable-http', url: 'https://api.inference.sh/mcp' }] },
          _meta: { 'io.modelcontextprotocol.registry/official': { publishedAt: '2026-07-20T18:02:33Z', updatedAt: '2026-07-20T18:02:33Z', isLatest: true } },
        },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mcp', name: 'inference.sh', install: '连接 https://api.inference.sh/mcp', updatedAt: '2026-07-20T18:02:33.000Z' })
  })

  it('detects Latin-script summaries that need translation and keeps Chinese text untouched', () => {
    expect(internals.needsTranslation('Read-only MCP server for local file search and indexing.')).toBe(true)
    expect(internals.needsTranslation('读取本地文件并提供搜索能力的 MCP 服务。')).toBe(false)
    expect(internals.needsTranslation('MCP 服务 for local search 工具')).toBe(true)
    expect(internals.needsTranslation('这是一个 MCP 服务，用于本地搜索 tools')).toBe(false)
    expect(internals.needsTranslation('')).toBe(false)
  })

  it('parses model translation answers, tolerating code fences and dropping malformed rows', () => {
    const answers = internals.parseMarketTranslateResponse('```json\n[{"i":0,"d":"读取 GitHub 仓库的只读工具。"},{"i":1,"d":""},{"bad":true},{"i":2,"d":"管理本地任务板。"}]\n```')
    expect(answers).toEqual([{ i: 0, d: '读取 GitHub 仓库的只读工具。' }, { i: 2, d: '管理本地任务板。' }])
    expect(() => internals.parseMarketTranslateResponse('no json here')).toThrow()
  })
})
