/** Studio store persistence, event log, file listing, and safety bounds. */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultDataDir, normalizeCreateRequest, StudioStore, StudioStoreError } from '../src/store.ts'

describe('normalizeCreateRequest', () => {
  it('requires a non-empty requirement', () => {
    expect(() => normalizeCreateRequest({})).toThrow(StudioStoreError)
    expect(() => normalizeCreateRequest({ requirement: '   ' })).toThrow('non-empty')
    expect(() => normalizeCreateRequest('nope')).toThrow(StudioStoreError)
  })

  it('caps the requirement length', () => {
    expect(() => normalizeCreateRequest({ requirement: 'x'.repeat(4001) })).toThrow('characters')
  })

  it('derives the name from the requirement and defaults the type', () => {
    const request = normalizeCreateRequest({ requirement: '  做一个记账软件 ' })
    expect(request.requirement).toBe('做一个记账软件')
    expect(request.name).toBe('做一个记账软件')
    expect(request.projectType).toBe('software')
    expect(request.stageModels).toEqual({})
  })

  it('keeps only well-formed stage model routes', () => {
    const request = normalizeCreateRequest({
      requirement: 'demo',
      projectType: 'webpage',
      stageModels: {
        requirements: { provider: 'deepseek', model: 'deepseek-chat' },
        design: { provider: '', model: 'x' },
        testing: 'nonsense',
      },
    })
    expect(request.projectType).toBe('webpage')
    expect(request.stageModels).toEqual({ requirements: { provider: 'deepseek', model: 'deepseek-chat' } })
  })
})

describe('StudioStore', () => {
  let root: string
  let store: StudioStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'collab-studio-store-'))
    store = new StudioStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('defaults the data directory under $DSH_HOME/collab-studio', () => {
    expect(defaultDataDir().endsWith('collab-studio')).toBe(true)
  })

  it('creates one durable project with its directory and empty log', async () => {
    const record = await store.create({ requirement: '做一个待办网页' }, 10)
    expect(record.id).toMatch(/^proj-/)
    expect(record.status).toBe('draft')
    const onDisk = JSON.parse(await readFile(join(root, record.id, 'studio.json'), 'utf8')) as { id: string }
    expect(onDisk.id).toBe(record.id)
    expect(await readFile(join(root, record.id, 'events.jsonl'), 'utf8')).toBe('')
  })

  it('enforces the project limit', async () => {
    await store.create({ requirement: 'one' }, 1)
    await expect(store.create({ requirement: 'two' }, 1)).rejects.toMatchObject({ code: 'LIMIT' })
  })

  it('lists created projects oldest first and skips torn directories', async () => {
    const first = await store.create({ requirement: 'first' }, 10)
    const second = await store.create({ requirement: 'second' }, 10)
    await mkdir(join(root, 'broken-dir'), { recursive: true })
    const summaries = await store.list()
    expect(summaries.map(summary => summary.id)).toEqual([first.id, second.id])
  })

  it('settles a restart-interrupted running project as stopped on load', async () => {
    const record = await store.create({ requirement: 'running one' }, 10)
    record.status = 'running'
    await store.save(record)
    const loaded = await store.load(record.id)
    expect(loaded.status).toBe('stopped')
    expect(loaded.error).toContain('重启')
  })

  it('leaves a live running project untouched so a status read is not a false crash', async () => {
    // Reading a project whose run this process still owns must not rewrite it:
    // the old behavior reported "进程重启" for a healthy run and raced the
    // engine's own saves.
    const record = await store.create({ requirement: 'live one' }, 10)
    record.status = 'running'
    record.currentStage = 'requirements'
    await store.save(record)

    const loaded = await store.load(record.id, id => id === record.id)
    expect(loaded.status).toBe('running')
    expect(loaded.error).toBeUndefined()
    // The record on disk is unchanged too, not just the returned copy.
    const onDisk = JSON.parse(await readFile(join(root, record.id, 'studio.json'), 'utf8')) as {
      status: string
      error?: string
    }
    expect(onDisk.status).toBe('running')
    expect(onDisk.error).toBeUndefined()
  })

  it('still reconciles a running project whose run this process does not own', async () => {
    const record = await store.create({ requirement: 'orphan one' }, 10)
    record.status = 'running'
    await store.save(record)
    // The predicate answers false for every project: nothing is live here.
    const loaded = await store.load(record.id, () => false)
    expect(loaded.status).toBe('stopped')
    expect(loaded.error).toContain('重启')
  })

  it('forwards run liveness through list()', async () => {
    const live = await store.create({ requirement: 'live list' }, 10)
    live.status = 'running'
    await store.save(live)
    const dead = await store.create({ requirement: 'dead list' }, 10)
    dead.status = 'running'
    await store.save(dead)

    const summaries = await store.list(id => id === live.id)
    const byId = new Map(summaries.map(summary => [summary.id, summary]))
    expect(byId.get(live.id)?.status).toBe('running')
    expect(byId.get(dead.id)?.status).toBe('stopped')
  })

  it('rejects loading an unknown project', async () => {
    await expect(store.load('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('assigns monotonically increasing event sequence numbers', async () => {
    const record = await store.create({ requirement: 'events' }, 10)
    const one = await store.appendEvent(record.id, 'project/started', {})
    const two = await store.appendEvent(record.id, 'meeting/speak', { role: 'ceo' })
    expect(one.seq).toBe(1)
    expect(two.seq).toBe(2)
    // A fresh store instance continues from the persisted log.
    const reopened = new StudioStore(root)
    const three = await reopened.appendEvent(record.id, 'stage/completed', {})
    expect(three.seq).toBe(3)
  })

  it('reads the event tail after one sequence bound', async () => {
    const record = await store.create({ requirement: 'tail' }, 10)
    for (let index = 1; index <= 5; index += 1) await store.appendEvent(record.id, 'meeting/speak', { index })
    const tail = await store.readEvents(record.id, 3, 100)
    expect(tail.events.map(event => event.seq)).toEqual([4, 5])
    expect(tail.total).toBe(5)
    const capped = await store.readEvents(record.id, 0, 2)
    expect(capped.events).toHaveLength(2)
    expect(capped.events.map(event => event.seq)).toEqual([4, 5])
  })

  it('lists deliverable files without studio-owned or vendored entries', async () => {
    const record = await store.create({ requirement: 'files' }, 10)
    const dir = store.projectDir(record.id)
    await writeFile(join(dir, 'index.html'), '<html></html>')
    await writeFile(join(dir, 'README.md'), '# readme')
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'app.js'), '1')
    await mkdir(join(dir, 'node_modules', 'dep'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'dep', 'index.js'), '1')
    await mkdir(join(dir, '.git'), { recursive: true })
    await writeFile(join(dir, '.git', 'HEAD'), 'ref')
    const files = await store.listFiles(record.id)
    expect(files).toEqual(['index.html', 'README.md', 'src/app.js'])
  })

  it('reads file content with a byte cap', async () => {
    const record = await store.create({ requirement: 'read' }, 10)
    await writeFile(join(store.projectDir(record.id), 'big.md'), 'abcdefghij')
    const whole = await store.readFile(record.id, 'big.md', 100)
    expect(whole).toEqual({ text: 'abcdefghij', truncated: false })
    const capped = await store.readFile(record.id, 'big.md', 4)
    expect(capped).toEqual({ text: 'abcd', truncated: true })
  })

  it('refuses paths escaping the project directory', async () => {
    const record = await store.create({ requirement: 'escape' }, 10)
    await expect(store.readFile(record.id, '../studio.json', 100)).rejects.toMatchObject({ code: 'INVALID' })
    await expect(store.readFile(record.id, 'missing.txt', 100)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('deletes the whole project directory', async () => {
    const record = await store.create({ requirement: 'gone' }, 10)
    await store.delete(record.id)
    await expect(store.load(record.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
