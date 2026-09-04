/**
 * Slot driver: one live harness agent per bench slot (generator / judge /
 * one per contestant model). Every agent mounts the deployment's default
 * agent preset, so all participants share one identical tool environment;
 * each agent also installs one agent-scoped model selection (the same
 * installModelSelection coupling the session/headless entry points use) that
 * resolves the slot's explicit route or falls back to the deployment default
 * model. Slots are independent agents, so contestant turns run concurrently.
 * @module @deepseek-ai/dsh-model-bench/driver
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { BenchAgentLike, BenchAgentsLike, BenchDefaultModelLike, BenchPresetsLike, BenchSlotDriver, ModelRoute } from './types.ts'

/** Structural content block (the text slice the bench reads). */
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

/** One live slot agent, its owning handle, and its mutable model selection. */
interface SlotEntry {
  readonly agent: BenchAgentLike
  readonly dispose: () => Promise<void>
  readonly modelRef: ModelSelectionRef
}

/** Error raised when the bench cancels a slot turn. */
export class BenchAbortedError extends Error {
  constructor() {
    super('model bench run was stopped')
  }
}

/**
 * Drive bench slots through real harness agents. The engine talks to this
 * class only through {@link BenchSlotDriver}, so tests can substitute a fake.
 */
export class AgentSlotDriver implements BenchSlotDriver {
  private readonly slots = new Map<string, SlotEntry>()
  private readonly routes = new Map<string, ModelRoute | undefined>()

  /**
   * @param agents - structural agent registry (the live `ctx.agents`).
   * @param presets - optional structural preset service; absent means agents mount no preset.
   * @param defaultModel - optional deployment default selection used when a slot has no explicit route.
   */
  constructor(
    private readonly agents: BenchAgentsLike,
    private readonly presets: BenchPresetsLike | undefined,
    private readonly defaultModel?: BenchDefaultModelLike,
  ) {}

  /** Resolve the model selection one slot should use right now. */
  private resolveSelection(slot: string): { provider: string; model: string } | undefined {
    const route = this.routes.get(slot)
    if (route !== undefined) return { provider: route.provider, model: route.model }
    try {
      const selection = this.defaultModel?.currentSelection()
      if (selection !== undefined && selection.provider !== '' && selection.model !== '') {
        return { provider: selection.provider, model: selection.model }
      }
    } catch {
      // A failing default lookup falls through to "no selection".
    }
    return undefined
  }

  /** Create (or reuse) the live agent for one slot with its working dir. */
  async ensureSlot(slot: string, cwd: string): Promise<void> {
    if (this.slots.has(slot)) return
    // The same model-selection coupling the session/headless entry points use:
    // prompt assembly snapshots `current`, and agent/request applies it, so a
    // slot without an explicit route still resolves the deployment default.
    const modelRef: ModelSelectionRef = { current: undefined, assembled: undefined }
    const handle = await this.agents.create({
      sessionId: `bench-${slot}-${randomUUID()}`,
      meta: { cwd },
      setup: async (agentCtx: unknown) => {
        installModelSelection(agentCtx as never, modelRef)
        if (this.presets !== undefined) {
          const resolved = await this.presets.resolve(undefined)
          await this.presets.mount(agentCtx, resolved.id)
        }
      },
    })
    this.slots.set(slot, { agent: handle.agent, dispose: () => handle.dispose(), modelRef })
  }

  /** Set the model route the slot uses for subsequent turns (undefined = default). */
  setRoute(slot: string, route: ModelRoute | undefined): void {
    this.routes.set(slot, route)
  }

  /** Run one slot turn and return the assistant's reply text. */
  async run(slot: string, prompt: string, signal: AbortSignal): Promise<string> {
    const entry = this.slots.get(slot)
    if (entry === undefined) throw new Error(`slot "${slot}" was not ensured before running`)
    signal.throwIfAborted()
    // Refresh the live selection so the next prompt assembly snapshots it.
    entry.modelRef.current = this.resolveSelection(slot)
    const before = entry.agent.session.seq
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
    if (signal.aborted) throw new BenchAbortedError()
    return extractReplyText(entry.agent.session.snapshotEvents(before), 0)
  }

  /** Dispose every live slot agent, containing individual failures. */
  async disposeAll(): Promise<void> {
    const failures: unknown[] = []
    for (const [slot, entry] of this.slots) {
      try {
        await entry.dispose()
      } catch (error) {
        failures.push(error)
      } finally {
        this.slots.delete(slot)
      }
    }
    this.routes.clear()
    if (failures.length > 0) throw new AggregateError(failures, 'disposing slot agents failed')
  }
}
