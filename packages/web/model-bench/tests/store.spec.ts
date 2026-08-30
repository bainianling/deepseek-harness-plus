/** Bench store semantics: validation, persistence, events, file safety. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BenchStore, BenchStoreError, defaultDataDir, normalizeCreateRequest, normalizeStartRequest, routeSlug } from '../src/store.ts'

describe('defaultDataDir', () => {
  it('defaults under $DSH_HOME/model-bench', () => {
    expect(defaultDataDir().endsWith('model-bench')).toBe(true)
  })
})

describe('normalizeCreateRequest', () => {
  it('accepts one declared category', () => {
    const request = normalizeCreateRequest({ category: 'coding', name: ' 编程一轮 ' })
    expect(request.category).toBe('coding')
    expect(request.difficulty).toBe('medium')
    expect(request.name).toBe('编程一轮')
    expect(request.start).toBe(false)
  })

  it('rejects unknown categories and difficulties', () => {
    expect(() => normalizeCreateRequest({ category: 'math' })).toThrow(BenchStoreError)
    expect(() => normalizeCreateRequest({})).toThrow('category')
    expect(() => normalizeCreateRequest({ category: 'coding', difficulty: 'extreme' })).toThrow('difficulty')
    expect(normalizeCreateRequest({ category: 'coding', difficulty: 'hard' }).difficulty).toBe('hard')
  })

  it('parses optional generator and judge routes', () => {
    const request = normalizeCreateRequest({
      category: 'paper',
      generator: { provider: 'p', model: 'm' },
      judge: { provider: 'q', model: 'n' },
      start: true,
    })
    expect(request.generator).toEqual({ provider: 'p', model: 'm' })
    expect(request.judge).toEqual({ provider: 'q', model: 'n' })
    expect(request.start).toBe(true)
  })

  it('rejects malformed routes', () => {
    expect(() => normalizeCreateRequest({ category: 'vision', generator: { provider: 'p' } })).toThrow('generator')
  })
})

describe('normalizeStartRequest', () => {
  it('dedupes identical routes and keeps order', () => {
    const request = normalizeStartRequest({
      models: [
        { provider: 'a', model: 'x' },
        { provider: 'a', model: 'x' },
        { provider: 'b', model: 'y' },
      ],
    }, 12)
    expect(request.models).toEqual([{ provider: 'a', model: 'x' }, { provider: 'b', model: 'y' }])
  })

  it('rejects empty rosters, bad entries, and oversized rosters', () => {
    expect(() => normalizeStartRequest({ models: [] }, 12)).toThrow('at least one')
    expect(() => normalizeStartRequest({}, 12)).toThrow('at least one')
    expect(() => normalizeStartRequest({ models: [{ provider: 'a' }] }, 12)).toThrow('non-empty')
    const many = Array.from({ length: 13 }, (_unused, index) => ({ provider: 'p', model: `m${String(index)}` }))
    expect(() => normalizeStartRequest({ models: many }, 12)).toThrow('limit')
  })
})

describe('routeSlug', () => {
  it('sanitizes route characters and disambiguates duplicates', () => {
    const taken = new Set<string>()
    const first = routeSlug({ provider: 'deepseek', model: 'v3.1/x' }, taken)
    expect(first).toBe('deepseek--v3.1-x')
    const dupe = routeSlug({ provider: 'deepseek', model: 'v3.1/x' }, taken)
    expect(dupe).toBe('deepseek--v3.1-x-2')
  })
})

describe('BenchStore', () => {
  let root: string
  let store: BenchStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'model-bench-store-'))
    store = new BenchStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates the round tree and lists summaries in creation order', async () => {
    const one = await store.create({ category: 'coding' }, 8)
    const two = await store.create({ category: 'vision', name: '看图' }, 8)
    expect(one.status).toBe('draft')
    expect(one.difficulty).toBe('medium')
    expect(one.name).toBe('coding 测试')
    const summaries = await store.list()
    expect(summaries.map(summary => summary.id)).toEqual([one.id, two.id])
    expect(summaries.map(summary => summary.difficulty)).toEqual(['medium', 'medium'])
    expect(summaries[1]?.name).toBe('看图')
    // Directory tree exists.
    expect(await readFile(join(store.questionDir(one.id), '..', 'round.json'), 'utf8')).toContain(one.id)
  })

  it('enforces the round limit', async () => {
    await store.create({ category: 'coding' }, 1)
    await expect(store.create({ category: 'document' }, 1)).rejects.toThrow('limit')
  })

  it('keeps ordinary loads pure and settles mid-flight records only during startup recovery', async () => {
    const record = await store.create({ category: 'paper' }, 8)
    record.status = 'running'
    await store.save(record)
    // A fresh store instance simulates a restart, but a read alone has no side effect.
    const fresh = new BenchStore(root)
    expect((await fresh.load(record.id)).status).toBe('running')
    expect(await fresh.settleInterruptedRounds()).toBe(1)
    const settled = await fresh.load(record.id)
    expect(settled.status).toBe('stopped')
    expect(settled.error).toContain('重启')
    expect(await fresh.settleInterruptedRounds()).toBe(0)
  })

  it('loads legacy rounds with a derived difficulty without rewriting the file', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    const path = join(store.roundDir(record.id), 'round.json')
    const legacy = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    delete legacy.difficulty
    legacy.question = { title: '旧题', difficulty: 'hard', passThreshold: 6 }
    const before = `${JSON.stringify(legacy, null, 2)}\n`
    await writeFile(path, before, 'utf8')
    expect((await store.load(record.id)).difficulty).toBe('hard')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('loads reject unknown rounds', async () => {
    await expect(store.load('round-missing')).rejects.toThrow(BenchStoreError)
  })

  it('appends and tails events after one sequence', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    await store.appendEvent(record.id, 'a', { n: 1 })
    await store.appendEvent(record.id, 'b', { n: 2 })
    await store.appendEvent(record.id, 'c', { n: 3 })
    const tail = await store.readEvents(record.id, 1, 10)
    expect(tail.events.map(event => event.type)).toEqual(['b', 'c'])
    expect(tail.total).toBe(3)
    const capped = await store.readEvents(record.id, 0, 2)
    expect(capped.events.map(event => event.type)).toEqual(['b', 'c'])
  })

  it('lists round files without bench-owned entries', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    await store.writeRoundFile(record.id, 'question/question.md', '题面')
    await store.writeRoundFile(record.id, 'runs/slug-a/ANSWER.md', '答案')
    const files = await store.listFiles(record.id)
    expect(files).toContain('question/question.md')
    expect(files).toContain('runs/slug-a/ANSWER.md')
    expect(files).not.toContain('round.json')
    expect(files).not.toContain('events.jsonl')
  })

  it('reads files safely and blocks escapes', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    await store.writeRoundFile(record.id, 'question/question.md', '题面内容')
    const read = await store.readFile(record.id, 'question/question.md', 1024)
    expect(read.text).toBe('题面内容')
    expect(read.truncated).toBe(false)
    await expect(store.readFile(record.id, '../outside.txt', 1024)).rejects.toThrow('escapes')
    await expect(store.readFile(record.id, 'missing.txt', 1024)).rejects.toThrow('not found')
  })

  it('truncates oversized reads', async () => {
    const record = await store.create({ category: 'document' }, 8)
    await store.writeRoundFile(record.id, 'big.md', 'x'.repeat(100))
    const read = await store.readFile(record.id, 'big.md', 10)
    expect(read.text).toHaveLength(10)
    expect(read.truncated).toBe(true)
  })

  it('deletes one round entirely', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    await store.delete(record.id)
    await expect(store.load(record.id)).rejects.toThrow('not found')
  })

  it('readRoundFile returns empty for missing files and writeRoundFile creates parents', async () => {
    const record = await store.create({ category: 'coding' }, 8)
    expect(await store.readRoundFile(record.id, 'nope.md')).toBe('')
    await store.writeRoundFile(record.id, 'a/b/c.md', '深层')
    expect(await store.readRoundFile(record.id, 'a/b/c.md')).toBe('深层')
    await writeFile(join(store.roundDir(record.id), 'raw.txt'), '原始', 'utf8')
    expect(await store.readRoundFile(record.id, 'raw.txt')).toBe('原始')
  })
})
