/** Driver pure helpers: message shape, reply extraction, and turn-failure surfacing. */

import { describe, expect, it } from 'vitest'
import {
  AgentRoleDriver, describeTurnFailure, extractReplyText, makeUserMessage,
} from '../src/driver.ts'
import type { RoleSpec, StudioAgentLike, StudioAgentsLike, StudioDefaultModelLike, StudioPresetsLike } from '../src/types.ts'

describe('makeUserMessage', () => {
  it('builds one frozen harness-shaped user message', () => {
    const message = makeUserMessage('你好') as {
      id: string
      role: string
      content: { type: string; text: string }[]
      source: { kind: string }
    }
    expect(message.role).toBe('user')
    expect(message.source.kind).toBe('user')
    expect(message.content).toEqual([{ type: 'text', text: '你好' }])
    expect(message.id).not.toBe('')
    expect(Object.isFrozen(message)).toBe(true)
    expect(Object.isFrozen(message.content)).toBe(true)
    // Two messages never share identity.
    const other = makeUserMessage('你好') as { id: string }
    expect(other.id).not.toBe(message.id)
  })
})

describe('extractReplyText', () => {
  const assistant = (text: string) => ({
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text }] } },
  })

  it('returns the last assistant message text after the boundary', () => {
    const events = [
      assistant('先做的思考'),
      { type: 'user/message', data: {} },
      assistant('第一步'),
      { type: 'tool/call', data: {} },
      assistant('最终汇报'),
    ]
    expect(extractReplyText(events, 2)).toBe('最终汇报')
  })

  it('ignores empty assistant messages and non-text blocks', () => {
    const events = [
      { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call' }] } } },
      assistant('有内容'),
    ]
    expect(extractReplyText(events, 0)).toBe('有内容')
    expect(extractReplyText(events.slice(0, 1), 0)).toBe('')
  })

  it('returns empty without assistant events after the boundary', () => {
    expect(extractReplyText([assistant('旧消息')], 1)).toBe('')
  })
})

describe('describeTurnFailure', () => {
  it('reports the structured error of a failed turn', () => {
    const events = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      {
        type: 'turn/end',
        data: {
          turn: 1,
          reason: {
            kind: 'error',
            error: {
              message: 'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")',
              code: 'UNKNOWN',
            },
          },
        },
      },
    ]
    expect(describeTurnFailure(events)).toBe(
      'prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix") [UNKNOWN]',
    )
  })

  it('uses the last turn/end and tolerates a missing code', () => {
    const events = [
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
      { type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'route unauthorized' } } } },
    ]
    expect(describeTurnFailure(events)).toBe('route unauthorized')
  })

  it('names a non-error non-completed termination', () => {
    expect(describeTurnFailure([{ type: 'turn/end', data: { reason: { kind: 'max-tokens' } } }]))
      .toBe('turn ended with reason "max-tokens"')
  })

  it('returns undefined for a completed or absent turn end', () => {
    expect(describeTurnFailure([{ type: 'turn/end', data: { reason: { kind: 'completed' } } }])).toBeUndefined()
    expect(describeTurnFailure([
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '正常回复' }] } } },
    ])).toBeUndefined()
    expect(describeTurnFailure([])).toBeUndefined()
  })
})

/** A minimal live role agent whose log is scripted per turn. */
function fakeAgent(turns: readonly (readonly { type: string; seq: number; data: unknown }[])[], startSeq = 0): StudioAgentLike {
  let seq = startSeq
  let turn = 0
  const log: { type: string; seq: number; data: unknown }[] = []
  return {
    id: 'agent',
    status: 'idle',
    session: {
      id: 'session',
      get seq() { return seq },
      append(type: string, data: unknown) { log.push({ type, seq: seq++, data }) },
      snapshotEvents(fromSeq = 0) { return log.filter(event => event.seq >= fromSeq) },
      header: {},
    },
    followup() {
      const scripted = turns[turn] ?? []
      turn += 1
      for (const event of scripted) log.push({ ...event, seq: seq++ })
    },
    cancel() {},
    whenIdle: () => Promise.resolve(),
  }
}

/** The role every driver test ensures before speaking. */
const ROLE: RoleSpec = { id: 'ceo', title: 'CEO', persona: '决策者' }

/** Build a driver over one scripted agent plus its captured create options. */
function harness(options: {
  turns: readonly (readonly { type: string; seq: number; data: unknown }[])[]
  defaultModel?: StudioDefaultModelLike
  presets?: StudioPresetsLike
}) {
  let agent = fakeAgent(options.turns)
  const created: Parameters<StudioAgentsLike['create']>[0][] = []
  const agents: StudioAgentsLike = {
    create: async (createOptions) => {
      created.push(createOptions)
      return { agent, dispose: async () => {} }
    },
  }
  const driver = new AgentRoleDriver(
    agents,
    options.presets,
    options.defaultModel,
  )
  return { driver, created, agentRef: () => agent, setAgent: (next: StudioAgentLike) => { agent = next } }
}
describe('AgentRoleDriver.speak', () => {
  it('reports the real turn failure instead of a bare "no reply"', async () => {
    const { driver } = harness({
      turns: [[
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        {
          type: 'turn/end',
          seq: 2,
          data: {
            turn: 1,
            reason: { kind: 'error', error: { message: 'provider unreachable', code: 'ECONNREFUSED' } },
          },
        },
      ]],
    })
    await driver.ensureRole(ROLE, '/work')
    await expect(driver.speak('ceo', 'prompt', new AbortController().signal))
      .rejects.toThrow('role "ceo" turn failed: provider unreachable [ECONNREFUSED]')
  })

  it('keeps the original message when a turn completes without emitting text', async () => {
    const { driver } = harness({
      turns: [[{ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } }]],
    })
    await driver.ensureRole(ROLE, '/work')
    await expect(driver.speak('ceo', 'prompt', new AbortController().signal))
      .rejects.toThrow('role "ceo" finished its turn without a reply')
  })

  it('returns the assistant text of a successful turn', async () => {
    const { driver } = harness({
      turns: [[
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: '我同意' }] } } },
        { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      ]],
    })
    await driver.ensureRole(ROLE, '/work')
    await expect(driver.speak('ceo', 'prompt', new AbortController().signal)).resolves.toBe('我同意')
  })

  it('installs a model selection on the role agent before any turn', async () => {
    // Without this coupling a preset persona referencing {{model}} cannot
    // assemble and every turn dies — the defect this suite pins.
    const { driver, created } = harness({
      turns: [[
        { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      ]],
    })
    await driver.ensureRole(ROLE, '/work')
    expect(created).toHaveLength(1)
    // The setup must be a function the registry awaits; it registers the
    // prompt-variable/request coupling on the agent's scoped context.
    expect(typeof created[0]?.setup).toBe('function')
    const registered: string[] = []
    await created[0]?.setup?.({
      on: (event: string) => { registered.push(event); return () => {} },
    }, fakeAgent([]))
    expect(registered).toContain('system-prompt/assemble')
    expect(registered).toContain('agent/request')
    expect(registered).toContain('agent/pre-step')
  })

  it('mounts the resolved preset inside the same setup', async () => {
    const mounted: string[] = []
    const presets: StudioPresetsLike = {
      resolve: () => Promise.resolve({ id: 'zh' }),
      mount: (_ctx, presetId) => { mounted.push(presetId) },
    }
    const { driver, created } = harness({
      turns: [[
        { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      ]],
      presets,
    })
    await driver.ensureRole(ROLE, '/work')
    await created[0]?.setup?.({ on: () => () => {} }, fakeAgent([]))
    expect(mounted).toEqual(['zh'])
  })

  it('pins approval/policy never so an unattended role cannot deadlock on a prompt', async () => {
    // The composed approval answerer is a CLIENT waterfall: with no page
    // attached its promise never settles, so an escalation would hang the whole
    // project forever. The role must instead decide in-process (rejected).
    const { driver, created } = harness({
      turns: [[
        { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      ]],
    })
    await driver.ensureRole(ROLE, '/work')
    const agent = fakeAgent([])
    await created[0]?.setup?.({ on: () => () => {} }, agent)
    expect(agent.session.snapshotEvents()).toMatchObject([
      { type: 'approval/policy', data: { policy: 'never' } },
    ])
  })

  it('carries the default selection reasoning effort into the request', async () => {
    // The coupling reads an absent effort as "clear any inherited effort", so a
    // dropped effort silently demotes every role's reasoning. The deployment
    // default here is effort=max; the request must carry it.
    const defaultModel: StudioDefaultModelLike = {
      currentSelection: () => ({ provider: 'codebuddy-local', model: 'deepseek-v4.1-flash', reasoningEffort: 'max' }),
    }
    const { driver, created } = harness({
      turns: [[
        { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
      ]],
      defaultModel,
    })
    await driver.ensureRole(ROLE, '/work')

    // speak() publishes the resolved selection as `current` before the turn.
    await driver.speak('ceo', 'prompt', new AbortController().signal)

    // Drive the real coupling listeners with recording contexts. `agent/request`
    // reads the selection captured at prompt assembly, so assembly runs first.
    type Handler = (...args: never[]) => Promise<unknown>
    const handlers = new Map<string, Handler>()
    await created[0]?.setup?.({
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler)
        return () => {}
      },
    }, fakeAgent([]))
    const assembly = { variables: {} }
    await handlers.get('system-prompt/assemble')?.(
      assembly as never,
      {} as never,
      (() => Promise.resolve(assembly)) as never,
    )

    const request = { provider: 'inherited-provider', model: 'inherited-model', reasoningEffort: 'low' }
    const routed = await handlers.get('agent/request')?.({} as never, (() => Promise.resolve(request)) as never)

    expect(routed).toMatchObject({
      provider: 'codebuddy-local',
      model: 'deepseek-v4.1-flash',
      reasoningEffort: 'max',
    })
  })
})
