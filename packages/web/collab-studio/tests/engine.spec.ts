/** Pipeline engine semantics over a scripted fake role driver. */

import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProject } from '../src/engine.ts'
import { DEFAULT_STAGES } from '../src/prompts.ts'
import { StudioStore } from '../src/store.ts'
import type { ModelRoute, ProjectRecord, RoleDriver, RoleId, RoleSpec } from '../src/types.ts'

interface SpeakCall {
  readonly role: RoleId
  readonly prompt: string
}

/** Scripted role driver: records every turn and answers from one behavior. */
class FakeDriver implements RoleDriver {
  readonly calls: SpeakCall[] = []
  /** The route observed at each speak, in call order. */
  readonly observedRoutes: (ModelRoute | undefined)[] = []
  readonly routes = new Map<RoleId, ModelRoute | undefined>()
  readonly ensured: RoleId[] = []
  cwd = ''

  constructor(private readonly behavior: (call: SpeakCall & { index: number }) => string) {}

  async ensureRole(role: RoleSpec, cwd: string): Promise<void> {
    this.cwd = cwd
    if (!this.ensured.includes(role.id)) this.ensured.push(role.id)
  }

  setRoute(role: RoleId, route: ModelRoute | undefined): void {
    this.routes.set(role, route)
  }

  async speak(role: RoleId, prompt: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('aborted')
    const call: SpeakCall & { index: number } = { role, prompt, index: this.calls.length }
    this.calls.push({ role, prompt })
    this.observedRoutes.push(this.routes.get(role))
    return this.behavior(call)
  }

  async disposeAll(): Promise<void> {}

  /** Every recorded call whose prompt matches one substring. */
  callsContaining(text: string): SpeakCall[] {
    return this.calls.filter(call => call.prompt.includes(text))
  }
}

/** A fresh draft record for one test run. */
function draftRecord(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: 'demo',
    requirement: '做一个待办事项网页',
    projectType: 'webpage',
    createdAt: Date.now(),
    status: 'running',
    stageModels: {},
    stageStatus: {},
    deliverables: [],
    ...overrides,
  }
}

describe('runProject', () => {
  let root: string
  let store: StudioStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'collab-studio-engine-'))
    store = new StudioStore(root)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  /** Run one stage-less minimal pipeline helper with an emitting recorder. */
  async function run(
    record: ProjectRecord,
    driver: FakeDriver,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<{ events: { type: string; data: Record<string, unknown> }[] }> {
    const events: { type: string; data: Record<string, unknown> }[] = []
    await runProject(record, {
      store,
      driver,
      stages: DEFAULT_STAGES,
      signal,
      maxMeetingRounds: 4,
      emit: async (type, data) => {
        events.push({ type, data })
        await store.appendEvent(record.id, type, data)
      },
    })
    return { events }
  }

  it('runs the whole company pipeline to done with consensus meetings', async () => {
    const record = draftRecord('proj-ok')
    await store.save(record)
    let produced = 0
    const driver = new FakeDriver(({ role, prompt }) => {
      if (prompt.includes('【本阶段任务】')) {
        produced += 1
        // The producer role delivers one real file per stage.
        writeFileSync(join(driver.cwd, `out-${String(produced)}.md`), 'deliverable')
        return '已完成，创建了文件。'
      }
      if (prompt.includes('正在评审本阶段成果')) return '检查过了。\n[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '## 会议决议\n按共识执行。'
      return `${role} 发言要点。\n[态度: 同意]`
    })
    const { events } = await run(record, driver)
    expect(record.status).toBe('running') // the caller owns the terminal flip
    for (const stage of DEFAULT_STAGES) expect(record.stageStatus[stage.id]).toBe('done')
    expect(events.some(event => event.type === 'stage/completed' && event.data.stage === 'acceptance')).toBe(true)
    // Every meeting stage held one unanimous first round.
    const speakEvents = events.filter(event => event.type === 'meeting/speak')
    const requirementsSpeaks = speakEvents.filter(event => event.data.stage === 'requirements')
    expect(requirementsSpeaks).toHaveLength(3)
    expect(events.filter(event => event.type === 'meeting/consensus').every(event => event.data.consensus === true)).toBe(true)
    // Deliverables observed from the real directory.
    expect(record.deliverables.length).toBeGreaterThanOrEqual(6)
    expect(record.deliverables).toContain('out-1.md')
  })

  it('keeps discussing until a round reaches unanimous consent', async () => {
    const record = draftRecord('proj-objection')
    await store.save(record)
    const seen = new Map<string, number>()
    const driver = new FakeDriver(({ role, prompt }) => {
      if (prompt.includes('【本阶段任务】')) return '完成。'
      if (prompt.includes('正在评审本阶段成果')) return '[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '决议。'
      const round = Number(prompt.match(/第 (\d+) 轮讨论/u)?.[1] ?? '1')
      seen.set(`${role}:${String(round)}`, 1)
      // The CEO objects during the first requirements round only.
      if (prompt.includes('议题：需求澄清') && role === 'ceo' && round === 1) return '范围太大。\n[态度: 反对]'
      return '同意。\n[态度: 同意]'
    })
    const { events } = await run(record, driver)
    const requirementsConsensus = events.find(event => event.type === 'meeting/consensus' && event.data.stage === 'requirements')
    expect(requirementsConsensus?.data).toMatchObject({ consensus: true, rounds: 2 })
    expect(seen.has('ceo:2')).toBe(true)
  })

  it('lets the facilitator decide when maxRounds elapse without consensus', async () => {
    const record = draftRecord('proj-forced')
    await store.save(record)
    const driver = new FakeDriver(({ role, prompt }) => {
      if (prompt.includes('【本阶段任务】')) return '完成。'
      if (prompt.includes('正在评审本阶段成果')) return '[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '拍板决议。'
      // The product manager never agrees during the requirements meeting.
      if (prompt.includes('议题：需求澄清') && role === 'pm') return '保留意见。\n[态度: 反对]'
      return '同意。\n[态度: 同意]'
    })
    const { events } = await run(record, driver)
    const requirementsConsensus = events.find(event => event.type === 'meeting/consensus' && event.data.stage === 'requirements')
    expect(requirementsConsensus?.data).toMatchObject({ consensus: false, rounds: 3 })
    const resolutionCalls = driver.calls.filter(call => call.prompt.includes('担任会议主持人') && call.prompt.includes('议题：需求澄清'))
    expect(resolutionCalls[0]?.prompt).toContain('拍板')
  })

  it('runs the review-and-fix loop until the reviewer passes', async () => {
    const record = draftRecord('proj-review')
    await store.save(record)
    let implementationVerdicts = 0
    const driver = new FakeDriver(({ prompt }) => {
      if (prompt.includes('【本阶段任务】')) {
        writeFileSync(join(driver.cwd, 'app.js'), 'v1')
        return '完成。'
      }
      if (prompt.includes('正在评审本阶段成果')) {
        if (prompt.includes('按 DESIGN.md 实现完整可运行的项目代码')) {
          implementationVerdicts += 1
          if (implementationVerdicts === 1) return '缺少入口文件。\n[结论: 不通过]'
          return '已修复。\n[结论: 通过]'
        }
        return '[结论: 通过]'
      }
      if (prompt.includes('逐条修复当前目录中的成果')) {
        writeFileSync(join(driver.cwd, 'index.html'), '<html></html>')
        return '修复完成。'
      }
      if (prompt.includes('担任会议主持人')) return '决议。'
      return '同意。\n[态度: 同意]'
    })
    const { events } = await run(record, driver)
    const verdicts = events.filter(event => event.type === 'review/verdict' && event.data.stage === 'implementation')
    expect(verdicts.map(event => event.data.verdict)).toEqual(['fail', 'pass'])
    expect(record.deliverables).toContain('index.html')
    // The fixer ran exactly once for the failing verdict.
    expect(driver.calls.filter(call => call.prompt.includes('逐条修复当前目录中的成果'))).toHaveLength(1)
  })

  it('applies the deployment meeting-round cap over stage configuration', async () => {
    const record = draftRecord('proj-cap')
    await store.save(record)
    const driver = new FakeDriver(({ role, prompt }) => {
      if (prompt.includes('【本阶段任务】')) return '完成。'
      if (prompt.includes('正在评审本阶段成果')) return '[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '决议。'
      if (prompt.includes('议题：需求澄清') && role === 'pm') return '反对。\n[态度: 反对]'
      return '同意。\n[态度: 同意]'
    })
    const events: { type: string; data: Record<string, unknown> }[] = []
    await runProject(record, {
      store,
      driver,
      stages: DEFAULT_STAGES,
      signal: new AbortController().signal,
      maxMeetingRounds: 1,
      emit: async (type, data) => { events.push({ type, data }) },
    })
    const consensus = events.find(event => event.type === 'meeting/consensus' && event.data.stage === 'requirements')
    expect(consensus?.data).toMatchObject({ consensus: false, rounds: 1 })
  })

  it('stops at the abort signal between role turns', async () => {
    const record = draftRecord('proj-abort')
    await store.save(record)
    const controller = new AbortController()
    let speaks = 0
    const driver = new FakeDriver(({ prompt }) => {
      speaks += 1
      if (speaks === 2) controller.abort()
      if (prompt.includes('【本阶段任务】')) return '完成。'
      return '同意。\n[态度: 同意]'
    })
    await expect(run(record, driver, controller.signal)).rejects.toThrow()
    // Later stages never started.
    expect(record.stageStatus['design']).toBeUndefined()
  })

  it('hands each stage its configured model route to every involved role', async () => {
    const route = { provider: 'deepseek', model: 'deepseek-chat' }
    const record = draftRecord('proj-routes', { stageModels: { requirements: route } })
    await store.save(record)
    const driver = new FakeDriver(({ prompt }) => {
      if (prompt.includes('【本阶段任务】')) return '完成。'
      if (prompt.includes('正在评审本阶段成果')) return '[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '决议。'
      return '同意。\n[态度: 同意]'
    })
    await run(record, driver)
    // Speaker turns are unambiguous stage markers: requirements speakers
    // observed the configured route; later stages without configuration fall
    // back to the default (undefined).
    const speakers = driver.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.prompt.includes('轮讨论'))
    expect(speakers.length).toBeGreaterThan(0)
    for (const { call, index } of speakers) {
      // The meeting topic header never appears in the material block, so it
      // identifies the owning stage unambiguously.
      const inRequirements = call.prompt.includes('议题：需求澄清')
      expect(driver.observedRoutes[index]).toEqual(inRequirements ? route : undefined)
    }
    expect(driver.ensured).toEqual(expect.arrayContaining(['ceo', 'cto', 'pm', 'dev', 'qa', 'doc']))
  })

  it('persists the event log through the store', async () => {
    const record = draftRecord('proj-log')
    await store.save(record)
    const driver = new FakeDriver(({ prompt }) => {
      if (prompt.includes('【本阶段任务】')) return '完成。'
      if (prompt.includes('正在评审本阶段成果')) return '[结论: 通过]'
      if (prompt.includes('担任会议主持人')) return '决议。'
      return '同意。\n[态度: 同意]'
    })
    await run(record, driver)
    const raw = await readFile(join(root, 'proj-log', 'events.jsonl'), 'utf8')
    expect(raw).toContain('meeting/speak')
    expect(raw).toContain('stage/completed')
  })
})
