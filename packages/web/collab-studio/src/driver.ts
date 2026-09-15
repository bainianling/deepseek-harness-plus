/**
 * Role driver: one live harness Agent per company role. Each agent mounts the
 * deployment's default agent preset, so every role commands the complete tool
 * surface; a per-role `agent/request` waterfall swaps the model route whenever
 * the active stage configures one.
 *
 * Every role also installs the same model-selection coupling the
 * session/headless entry points use. This is REQUIRED, not an optimization:
 * prompt assembly resolves `{{provider}}`/`{{model}}` strictly and a preset
 * persona that references them (the shipped `zh`/`standard` presets do) fails
 * the whole turn when the agent carries no selection. The coupling also keeps
 * the persona's model name truthful when a stage overrides the route.
 * @module @deepseek-ai/dsh-collab-studio/driver
 */

import { randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ModelRoute, RoleDriver, RoleId, RoleSpec, StudioAgentLike, StudioAgentsLike, StudioDefaultModelLike, StudioPresetsLike } from './types.ts'

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

/**
 * Describe why a turn produced no reply, using the log's own terminal reason.
 *
 * A turn that ends in `turn/end{reason:{kind:'error'}}` writes no
 * `assistant/message`, so a bare "finished its turn without a reply" hides the
 * actual cause (an unresolvable prompt variable, an unauthorized route, a
 * provider failure). The infrastructure facts live in the log, so surface them
 * instead of discarding them.
 *
 * @param events - events appended after the turn boundary.
 * @returns the failure detail, or undefined when the turn simply emitted no text.
 */
export function describeTurnFailure(
  events: readonly { readonly type: string; readonly data: unknown }[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.type !== 'turn/end') continue
    const data = event.data as {
      readonly reason?: { readonly kind?: string; readonly error?: { readonly message?: string; readonly code?: string } }
    } | undefined
    const reason = data?.reason
    if (reason?.kind === undefined || reason.kind === 'completed') return undefined
    if (reason.kind === 'error') {
      const message = reason.error?.message ?? 'unknown error'
      const code = reason.error?.code
      return code === undefined ? message : `${message} [${code}]`
    }
    return `turn ended with reason "${reason.kind}"`
  }
  return undefined
}

/** One live role agent and its owning handle. */
interface RoleEntry {
  readonly agent: StudioAgentLike
  readonly dispose: () => Promise<void>
  /** Model selection coupled to this agent's prompt assembly and request routing. */
  readonly modelRef: ModelSelectionRef
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
   * @param defaultModel - optional deployment default selection used when a role has no explicit route.
   */
  constructor(
    private readonly agents: StudioAgentsLike,
    private readonly presets: StudioPresetsLike | undefined,
    private readonly defaultModel?: StudioDefaultModelLike,
  ) {}

  /**
   * Resolve the model selection one role should use right now.
   *
   * A role with no explicit stage route falls back to the deployment default,
   * INCLUDING its reasoning effort: the coupling reads an absent effort as
   * "clear the inherited one", so dropping a configured effort would silently
   * demote every role's reasoning. A missing selection is NOT silently
   * tolerated downstream either: prompt assembly refuses a persona referencing
   * `{{model}}`, so an unresolved route surfaces as a turn failure rather than a
   * fabricated answer.
   *
   * @param role - role whose route to resolve.
   * @returns the selection to install, or undefined when none is available.
   */
  private resolveSelection(role: RoleId): ModelSelection | undefined {
    const route = this.routes.get(role)
    if (route !== undefined) return { provider: route.provider, model: route.model }
    try {
      const selection = this.defaultModel?.currentSelection()
      if (selection !== undefined && selection.provider !== '' && selection.model !== '') {
        return {
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
        }
      }
    } catch {
      // A failing default lookup falls through to "no selection"; the turn then
      // fails loudly in prompt assembly instead of running on a guessed route.
    }
    return undefined
  }

  /** Create (or reuse) the live agent for one role with the project cwd. */
  async ensureRole(role: RoleSpec, cwd: string): Promise<void> {
    if (this.roles.has(role.id)) return
    // The same model-selection coupling the session/headless entry points use:
    // prompt assembly snapshots `current`, and agent/request applies it. Without
    // it a persona referencing {{model}} cannot assemble and every turn dies.
    const modelRef: ModelSelectionRef = { current: undefined, assembled: undefined }
    const handle = await this.agents.create({
      sessionId: `collab-${role.id}-${randomUUID()}`,
      meta: { cwd },
      setup: async (agentCtx: unknown, agent: StudioAgentLike) => {
        // Pin the role's approval policy BEFORE any turn. These agents run
        // unattended — nobody is watching this session's UI — and the composed
        // approval answerer is a CLIENT waterfall: with no page attached the
        // request never settles and the whole project deadlocks forever on one
        // escalation. `never` makes the policy decidable in-process (rejected,
        // so the tool call fails loudly) instead of hanging on a missing human.
        // Delegated subagents pin exactly this policy for the same reason.
        agent.session.append('approval/policy', { policy: 'never' })
        installModelSelection(agentCtx as never, modelRef)
        if (this.presets !== undefined) {
          const resolved = await this.presets.resolve(undefined)
          await this.presets.mount(agentCtx, resolved.id)
        }
      },
    })
    this.roles.set(role.id, {
      agent: handle.agent,
      dispose: () => handle.dispose(),
      modelRef,
    })
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
    // Refresh the live selection so the next prompt assembly snapshots it.
    entry.modelRef.current = this.resolveSelection(role)
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
    if (signal.aborted) throw new StudioAbortedError()
    const appended = entry.agent.session.snapshotEvents(before)
    const text = extractReplyText(appended, 0)
    if (text === '') {
      // Surface the log's own terminal reason instead of a bare "no reply":
      // a failed turn and an empty-but-completed turn are different defects.
      const failure = describeTurnFailure(appended)
      throw new Error(
        failure === undefined
          ? `role "${role}" finished its turn without a reply`
          : `role "${role}" turn failed: ${failure}`,
      )
    }
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
