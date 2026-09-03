/** Bench engine semantics over a scripted fake slot driver. */

import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assignContestants, generateQuestion, judgeSubmissions, resetContestantDirs, runContestants, runContestPhase, BenchTimeoutError, scaleTimeout } from '../src/engine.ts'
import { BenchStore } from '../src/store.ts'
import type { BenchSlotDriver, ModelRoute, RoundRecord } from '../src/types.ts'

describe('scaleTimeout', () => {
  it('gives harder rounds larger phase budgets', () => {
    expect(scaleTimeout(60_000, 'easy')).toBe(60_000)
    expect(scaleTimeout(60_000, 'medium')).toBe(90_000)
    expect(scaleTimeout(60_000, 'hard')).toBe(150_000)
  })
})

interface RunCall {
  readonly slot: string
  readonly prompt: string
}

/** Scripted slot driver: records every turn and answers from one behavior. */
class FakeSlotDriver implements BenchSlotDriver {
  readonly calls: RunCall[] = []
  readonly cwds = new Map<string, string>()
  readonly routes = new Map<string, ModelRoute | undefined>()

  constructor(
    private readonly behavior: (slot: string, prompt: string, cwd: string) => string | Promise<string>,
  ) {}

  async ensureSlot(slot: string, cwd: string): Promise<void> {
    this.cwds.set(slot, cwd)
  }

  setRoute(slot: string, route: ModelRoute | undefined): void {
    this.routes.set(slot, route)
  }

  async run(slot: string, prompt: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('aborted')
    this.calls.push({ slot, prompt })
    const reply = await this.behavior(slot, prompt, this.cwds.get(slot) ?? '')
    // Mirror the real driver: a fired signal (stop or timeout) cancels the turn.
    if (signal.aborted) throw new Error('aborted')
    return reply
  }

  async disposeAll(): Promise<void> {}
}

/** Generator behavior writing the mandated files into its cwd. */
function generatorBehavior(meta: Record<string, unknown>): (slot: string, prompt: string, cwd: string) => Promise<string> {
  return async (slot, _prompt, cwd) => {
    if (slot !== 'gen') return 'not the generator'
    await writeFile(join(cwd, 'question.md'), '请实现一个函数，返回两数之和。\n', 'utf8')
    await writeFile(join(cwd, 'answer.md'), '参考答案：def add(a,b): return a+b\n', 'utf8')
    await writeFile(join(cwd, 'meta.json'), JSON.stringify(meta), 'utf8')
    return '出题完成：两数之和'
  }
}

describe('bench engine', () => {
  let root: string
  let store: BenchStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'model-bench-engine-'))
    store = new BenchStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function makeRound(category: RoundRecord['category'] = 'coding'): Promise<RoundRecord> {
    return store.create({ category }, 16)
  }

  function deps(driver: FakeSlotDriver, overrides: Partial<{
    signal: AbortSignal
    visionImages: string[]
    contestantMs: number
    generateMs: number
    judgeMs: number
  }> = {}): {
    deps: Parameters<typeof generateQuestion>[1]
    events: { type: string; data: Record<string, unknown> }[]
  } {
    const events: { type: string; data: Record<string, unknown> }[] = []
    return {
      events,
      deps: {
        store,
        driver,
        signal: overrides.signal ?? new AbortController().signal,
        timeouts: {
          generateMs: overrides.generateMs ?? 60_000,
          contestantMs: overrides.contestantMs ?? 60_000,
          judgeMs: overrides.judgeMs ?? 60_000,
        },
        visionImages: overrides.visionImages ?? [],
        emit: async (type, data) => {
          events.push({ type, data })
        },
      },
    }
  }

  describe('generateQuestion', () => {
    it('authors the question at the selected difficulty and settles the round to ready', async () => {
      const record = await store.create({ category: 'coding', difficulty: 'hard' }, 16)
      const driver = new FakeSlotDriver(generatorBehavior({ title: '两数之和', difficulty: 'easy', passThreshold: 6 }))
      const { deps: engine, events } = deps(driver)
      await generateQuestion(record, engine)
      expect(record.status).toBe('ready')
      expect(record.question?.title).toBe('两数之和')
      expect(record.question?.difficulty).toBe('hard')
      expect(record.question?.passThreshold).toBe(8)
      expect(driver.calls[0]?.prompt).toContain('题目难度：【hard】')
      expect(events.map(event => event.type)).toContain('round/question-ready')
      // Generator ran in the question directory on the default route.
      expect(driver.cwds.get('gen')).toBe(store.questionDir(record.id))
      expect(driver.routes.get('gen')).toBeUndefined()
      // The question file is readable through the store.
      expect(await store.readRoundFile(record.id, 'question/question.md')).toContain('两数之和')
    })

    it('honors an explicit generator route', async () => {
      const record = await makeRound()
      record.generator = { provider: 'p', model: 'm' }
      const driver = new FakeSlotDriver(generatorBehavior({ title: 't' }))
      const { deps: engine } = deps(driver)
      await generateQuestion(record, engine)
      expect(driver.routes.get('gen')).toEqual({ provider: 'p', model: 'm' })
    })

    it('fails the round when the generator writes no question.md', async () => {
      const record = await makeRound()
      const driver = new FakeSlotDriver(() => '我没有写文件')
      const { deps: engine, events } = deps(driver)
      await expect(generateQuestion(record, engine)).rejects.toThrow('出题失败')
      expect(record.status).toBe('failed')
      expect(record.error).toContain('出题失败')
      expect(events.map(event => event.type)).toContain('round/generate-failed')
    })

    it('copies one seed image for vision rounds', async () => {
      const record = await makeRound('vision')
      await mkdir(store.assetsImagesDir(), { recursive: true })
      await writeFile(join(store.assetsImagesDir(), 'vision-v1.png'), 'fake-png', 'utf8')
      const driver = new FakeSlotDriver(generatorBehavior({ title: '数图形' }))
      const { deps: engine } = deps(driver, { visionImages: ['vision-v1.png'], signal: new AbortController().signal })
      // Deterministic pick: single candidate.
      await generateQuestion(record, engine)
      expect(record.question?.image).toBe('vision-v1.png')
      const staged = await readFile(join(store.materialsDir(record.id), 'vision-v1.png'), 'utf8')
      expect(staged).toBe('fake-png')
      expect(driver.calls[0]?.prompt).toContain('vision-v1.png')
    })

    it('rejects vision generation without seed images', async () => {
      const record = await makeRound('vision')
      const driver = new FakeSlotDriver(generatorBehavior({ title: 'x' }))
      const { deps: engine } = deps(driver, { visionImages: [] })
      await expect(generateQuestion(record, engine)).rejects.toThrow('seed images')
    })

    it('honors the generate timeout', async () => {
      const record = await makeRound()
      const driver = new FakeSlotDriver(async () => {
        await new Promise(resolve => { setTimeout(resolve, 300) })
        return 'too late'
      })
      const { deps: engine } = deps(driver, { generateMs: 50 })
      await expect(generateQuestion(record, engine)).rejects.toBeInstanceOf(BenchTimeoutError)
    })
  })

  /** Bring one round to ready with a scripted question. */
  async function readyRound(category: RoundRecord['category'] = 'coding'): Promise<RoundRecord> {
    const record = await makeRound(category)
    await store.writeRoundFile(record.id, 'question/question.md', '请实现两数之和。')
    await store.writeRoundFile(record.id, 'question/answer.md', '参考：add')
    await store.writeRoundFile(record.id, 'question/meta.json', JSON.stringify({ title: '两数之和', passThreshold: 6 }))
    record.question = { title: '两数之和', difficulty: 'medium', passThreshold: 6 }
    record.status = 'ready'
    await store.save(record)
    return record
  }

  describe('runContestants', () => {
    it('runs every selected model concurrently in isolated staged directories', async () => {
      const record = await readyRound()
      await store.writeRoundFile(record.id, 'question/materials/data.txt', '素材内容')
      assignContestants(record, [
        { provider: 'p1', model: 'm1' },
        { provider: 'p2', model: 'm2' },
      ], undefined)
      await store.save(record)
      const slugs = Object.keys(record.contestants)
      expect(slugs).toHaveLength(2)
      const running: string[] = []
      const driver = new FakeSlotDriver(async (slot, _prompt, cwd) => {
        if (!slot.startsWith('c-')) return 'no'
        running.push(slot)
        await writeFile(join(cwd, 'ANSWER.md'), `${slot} 的答案`, 'utf8')
        return `${slot} 完成`
      })
      const { deps: engine, events } = deps(driver)
      await runContestants(record, engine)
      expect(running.sort()).toEqual(slugs.map(slug => `c-${slug}`).sort())
      for (const slug of slugs) {
        const contestant = record.contestants[slug]
        expect(contestant?.status).toBe('done')
        expect(contestant?.durationMs).toBeGreaterThanOrEqual(0)
        expect(contestant?.replyTail).toContain('完成')
        // The question and the materials were staged into the run directory.
        expect(await readFile(join(store.runDir(record.id, slug), 'question.md'), 'utf8')).toContain('两数之和')
        expect(await readFile(join(store.runDir(record.id, slug), 'materials', 'data.txt'), 'utf8')).toBe('素材内容')
      }
      // Per-slot routes carried the selected models (roster order = slug order).
      expect(driver.routes.get(`c-${slugs[0]}`)).toEqual({ provider: 'p1', model: 'm1' })
      expect(driver.routes.get(`c-${slugs[1]}`)).toEqual({ provider: 'p2', model: 'm2' })
      expect(events.filter(event => event.type === 'run/started')).toHaveLength(2)
      expect(events.filter(event => event.type === 'run/finished')).toHaveLength(2)
    })

    it('contains one contestant failure without aborting the others', async () => {
      const record = await readyRound()
      assignContestants(record, [
        { provider: 'good', model: 'ok' },
        { provider: 'bad', model: 'boom' },
      ], undefined)
      await store.save(record)
      const driver = new FakeSlotDriver(async (slot, _prompt, cwd) => {
        if (slot.includes('bad--boom')) throw new Error('model exploded')
        await writeFile(join(cwd, 'ANSWER.md'), 'ok', 'utf8')
        return 'done'
      })
      const { deps: engine, events } = deps(driver)
      await runContestants(record, engine)
      const statuses = Object.values(record.contestants).map(contestant => contestant.status).sort()
      expect(statuses).toEqual(['done', 'failed'])
      expect(events.some(event => event.type === 'run/failed' && event.data.error === 'model exploded')).toBe(true)
    })

    it('marks a slow contestant as timeout', async () => {
      const record = await readyRound()
      assignContestants(record, [{ provider: 'slow', model: 'poke' }], undefined)
      await store.save(record)
      const driver = new FakeSlotDriver(async () => {
        await new Promise(resolve => { setTimeout(resolve, 400) })
        return 'late'
      })
      const { deps: engine } = deps(driver, { contestantMs: 60 })
      await runContestants(record, engine)
      const contestant = Object.values(record.contestants)[0]
      expect(contestant?.status).toBe('timeout')
      expect(contestant?.error).toBe('作答超时')
    })

    it('propagates a round stop instead of recording failures', async () => {
      const record = await readyRound()
      assignContestants(record, [{ provider: 'p', model: 'm' }], undefined)
      await store.save(record)
      const controller = new AbortController()
      controller.abort()
      const driver = new FakeSlotDriver(() => 'x')
      const { deps: engine } = deps(driver, { signal: controller.signal })
      await expect(runContestants(record, engine)).rejects.toThrow()
      expect(record.contestants[Object.keys(record.contestants)[0]!]?.status).not.toBe('failed')
    })
  })

  describe('judgeSubmissions', () => {
    it('parses judge markers into verdicts and aggregates stats', async () => {
      const record = await readyRound()
      assignContestants(record, [
        { provider: 'a', model: 'fast' },
        { provider: 'b', model: 'slow' },
      ], undefined)
      const slugs = Object.keys(record.contestants)
      for (const [index, slug] of slugs.entries()) {
        const contestant = record.contestants[slug]!
        contestant.status = 'done'
        contestant.startedAt = 1000
        contestant.finishedAt = 1000 + (index + 1) * 500
        contestant.durationMs = (index + 1) * 500
      }
      await store.save(record)
      const driver = new FakeSlotDriver((slot) => {
        if (!slot.startsWith('j-')) return 'not judge'
        return slot.endsWith(slugs[0]!)
          ? '很好。\n[BENCH_VERDICT] pass=YES score=8'
          : '差一点。\n[BENCH_VERDICT] pass=NO score=4.5'
      })
      const { deps: engine, events } = deps(driver)
      await judgeSubmissions(record, engine)
      expect(record.status).toBe('done')
      expect(record.contestants[slugs[0]!]?.verdict).toEqual(expect.objectContaining({ pass: true, score: 8 }))
      expect(record.contestants[slugs[1]!]?.verdict).toEqual(expect.objectContaining({ pass: false, score: 4.5 }))
      expect(record.stats).toEqual(expect.objectContaining({ total: 2, passed: 1, judged: 2 }))
      expect(record.stats?.minDurationMs).toBe(500)
      expect(record.stats?.maxDurationMs).toBe(1000)
      expect(record.stats?.avgDurationMs).toBe(750)
      expect(events.filter(event => event.type === 'judge/verdict')).toHaveLength(2)
      // Judge notes persisted per slug.
      expect(await store.readRoundFile(record.id, `judgements/${slugs[0]}.md`)).toContain('BENCH_VERDICT')
      // The judge worked from the round directory.
      expect(driver.cwds.get(`j-${slugs[0]}`)).toBe(store.roundDir(record.id))
    })

    it('enforces the difficulty pass line even when the judge says yes', async () => {
      const record = await readyRound()
      Object.assign(record, { difficulty: 'hard' })
      assignContestants(record, [{ provider: 'a', model: 'x' }], undefined)
      const slug = Object.keys(record.contestants)[0]!
      record.contestants[slug]!.status = 'done'
      await store.save(record)
      const driver = new FakeSlotDriver(() => '表面通过。\\n[BENCH_VERDICT] pass=YES score=7')
      const { deps: engine } = deps(driver)
      await judgeSubmissions(record, engine)
      expect(record.contestants[slug]!.verdict).toEqual(expect.objectContaining({ pass: false, score: 7 }))
      expect(record.stats?.passed).toBe(0)
    })

    it('records a non-passing verdict when the judge gives no marker', async () => {
      const record = await readyRound()
      assignContestants(record, [{ provider: 'a', model: 'x' }], undefined)
      const slug = Object.keys(record.contestants)[0]!
      record.contestants[slug]!.status = 'done'
      await store.save(record)
      const driver = new FakeSlotDriver(() => '评审意见没有标记行')
      const { deps: engine } = deps(driver)
      await judgeSubmissions(record, engine)
      const verdict = record.contestants[slug]!.verdict
      expect(verdict?.pass).toBe(false)
      expect(verdict?.score).toBeNull()
      expect(verdict?.comment).toContain('未给出有效判定')
    })

    it('fails crashed runs without consulting the judge', async () => {
      const record = await readyRound()
      assignContestants(record, [{ provider: 'a', model: 'crash' }], undefined)
      const slug = Object.keys(record.contestants)[0]!
      record.contestants[slug]!.status = 'failed'
      record.contestants[slug]!.error = 'model exploded'
      await store.save(record)
      const driver = new FakeSlotDriver(() => 'never called')
      const { deps: engine } = deps(driver)
      await judgeSubmissions(record, engine)
      expect(driver.calls).toHaveLength(0)
      expect(record.contestants[slug]!.verdict?.comment).toContain('model exploded')
      expect(record.stats?.passed).toBe(0)
    })
  })

  describe('runContestPhase', () => {
    it('wipes stale run directories before a rerun', async () => {
      const record = await readyRound()
      await store.writeRoundFile(record.id, 'runs/old-slug/stale.txt', '陈旧产物')
      await store.writeRoundFile(record.id, 'judgements/old-slug.md', '陈旧评审')
      assignContestants(record, [{ provider: 'a', model: 'fresh' }], undefined)
      await store.save(record)
      const slug = Object.keys(record.contestants)[0]!
      const driver = new FakeSlotDriver(async (slot, _prompt, cwd) => {
        if (slot === 'gen') return ''
        if (slot.startsWith('c-')) {
          await writeFile(join(cwd, 'ANSWER.md'), '答案', 'utf8')
          return '完成'
        }
        return '评审通过。\n[BENCH_VERDICT] pass=YES score=9'
      })
      const { deps: engine } = deps(driver)
      await runContestPhase(record, engine)
      expect(record.status).toBe('done')
      await expect(readFile(join(store.runDir(record.id, 'old-slug'), 'stale.txt'), 'utf8')).rejects.toThrow()
      expect(record.contestants[slug]?.verdict?.pass).toBe(true)
      expect(record.stats?.passed).toBe(1)
    })
  })

  it('resetContestantDirs recreates empty run and judgement roots', async () => {
    const record = await makeRound()
    await store.writeRoundFile(record.id, 'runs/x/f.txt', 'old')
    await resetContestantDirs(record, store)
    expect(await store.readRoundFile(record.id, 'runs/x/f.txt')).toBe('')
  })
})
