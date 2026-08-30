/**
 * Role driver: one live harness Agent per company role. Each agent mounts the
 * deployment's default agent preset, so every role commands the complete tool
 * surface; a per-role `agent/request` waterfall swaps the model route whenever
 * the active stage configures one.
 * @module @deepseek-ai/dsh-collab-studio/driver
 */

import { randomUUID } from 'node:crypto'
import type { ModelRoute, RoleDriver, RoleId, RoleSpec, StudioAgentLike, StudioAgentsLike, StudioPresetsLike } from './types.ts'

/** Structural agent-scoped context surface (event registration only). */
interface ScopedCtxLike {
  on(event: 'agent/request', handler: (
    payload: { agent: unknown; turn: number; step: number; signal: AbortSignal },
    next: () => Promise<{ provider?: string; model?: string } & Record<string, unknown>>,
  ) => Promise<{ provider?: string; model?: string } & Record<string, unknown>>): () => void
}

/** Structural content block (the text slice the studio reads and writes). */
interface TextBlock {
  readonly type: string
  readonly text?: string
}

/** Deep-freeze a value the way harness message publication expects. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<string | symbol, unknown>)[key])
    Object.freeze(value)
  }
  return value
}

/** Build one immutable user message carrying plain text (harness wire shape). */
export function makeUserMessage(text: string): unknown {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** Extract the assistant reply text from session events appended after one index. */
export function extractReplyText(events: readonly { readonly type: string; readonly data: unknown }[], afterIndex: number): string {
  let text = ''
  for (let index = afterIndex; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'assistant/message') continue
    const data = event.data as { readonly message?: { readonly content?: readonly TextBlock[] } } | undefined
    const blocks = data?.message?.content ?? []
    const parts: string[] = []
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
    }
    if (parts.length > 0) text = parts.join('\n')
  }
  return text
}

/** One live role agent and its owning handle. */
interface RoleEntry {
  readonly agent: StudioAgentLike
  readonly dispose: () => Promise<void>
}

/** Error raised when the studio cancels a role turn. */
export class StudioAbortedError extends Error {
  constructor() {
    super('collab studio run was stopped')
  }
}

/**
 * Drive company roles through real harness agents. The engine talks to this
 * class only through {@link RoleDriver}, so tests can substitute a fake.
 */
export class AgentRoleDriver implements RoleDriver {
  private readonly roles = new Map<RoleId, RoleEntry>()
  private readonly routes = new Map<RoleId, ModelRoute | undefined>()

  /**
   * @param agents - structural agent registry (the live `ctx.agents`).
   * @param presets - optional structural preset service; absent means agents mount no preset.
   */
  constructor(
    private readonly agents: StudioAgentsLike,
    private readonly presets: StudioPresetsLike | undefined,
  ) {}

  /** Create (or reuse) the live agent for one role with the project cwd. */
  async ensureRole(role: RoleSpec, cwd: string): Promise<void> {
    if (this.roles.has(role.id)) return
    const driver = this
    const handle = await this.agents.create({
      sessionId: `collab-${role.id}-${randomUUID()}`,
      meta: { cwd },
      setup: async (agentCtx: unknown) => {
        const scoped = agentCtx as ScopedCtxLike
        scoped.on('agent/request', async (_payload, next) => {
          const config = await next()
          const route = driver.routes.get(role.id)
          if (route === undefined) return config
          return { ...config, provider: route.provider, model: route.model }
        })
        if (driver.presets !== undefined) {
          const resolved = await driver.presets.resolve(undefined)
          await driver.presets.mount(agentCtx, resolved.id)
        }
      },
    })
    this.roles.set(role.id, { agent: handle.agent, dispose: () => handle.dispose() })
  }

  /** Set the model route the role uses for subsequent turns (undefined = default). */
  setRoute(role: RoleId, route: ModelRoute | undefined): void {
    this.routes.set(role, route)
  }

  /** Run one role turn and return the assistant's reply text. */
  async speak(role: RoleId, prompt: string, signal: AbortSignal): Promise<string> {
    const entry = this.roles.get(role)
    if (entry === undefined) throw new Error(`role "${role}" was not ensured before speaking`)
    signal.throwIfAborted()
    const before = entry.agent.session.events.length
    const onAbort = (): void => {
      entry.agent.cancel({ kind: 'user' }, { keepInbox: true })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      entry.agent.followup(makeUserMessage(prompt))
      await entry.agent.whenIdle()
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) throw new StudioAbortedError()
    const text = extractReplyText(entry.agent.session.events, before)
    if (text === '') throw new Error(`role "${role}" finished its turn without a reply`)
    return text
  }

  /** Dispose every live role agent, containing individual failures. */
  async disposeAll(): Promise<void> {
    const failures: unknown[] = []
    for (const [roleId, entry] of this.roles) {
      try {
        await entry.dispose()
      } catch (error) {
        failures.push(error)
      } finally {
        this.roles.delete(roleId)
      }
    }
    this.routes.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'disposing role agents failed')
  }
}
