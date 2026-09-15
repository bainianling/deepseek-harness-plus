/** Agent activation, composition, and model-selection policy owned by API Session. */

import { mkdir } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type {
  Agent, AgentOptions, AgentSetup, ModelSelection as AgentModelSelection, ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { BlockAssembler, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, LlmResolvedModelInfo, Message, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-typert-registry'
import {
  DEFAULT_MODEL_ENVIRONMENT_POLICY,
  ModelEnvironmentError,
  resolveModelEnvironment,
} from './environment.ts'
import type {
  DualModelPlanSkipReason, ModelEnvironmentPlan, ModelEnvironmentPolicy, ModelRoles, ModelSelection,
} from './types.ts'

/** Cold Session identity absent from persistence. */
export class ApiSessionNotFound extends Error {}

/** Session identity whose lifecycle belongs to subagent routing. */
export class ApiSessionSubagentOwnership extends Error {
  /** @param sessionId - identity reserved to subagent routing. */
  constructor(readonly sessionId: SessionId) {
    super(`session "${sessionId}" is a subagent session; use subagent delivery`)
  }
}

/** Explicit-id creation attempted to adopt a Session under another cwd. */
export class ApiSessionCwdConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedCwd: string,
    readonly existingCwd: string | undefined,
  ) {
    super(
      existingCwd === undefined
        ? `session "${sessionId}" records no cwd and cannot be adopted for "${requestedCwd}"`
        : `session "${sessionId}" belongs to "${existingCwd}", not "${requestedCwd}"`,
    )
  }
}

/** Explicit-id creation attempted to adopt a Session under another preset. */
export class ApiSessionPresetConflict extends Error {
  constructor(
    readonly sessionId: SessionId,
    readonly requestedPreset: string,
    readonly existingPreset: string | undefined,
  ) {
    super(
      existingPreset === undefined
        ? `session "${sessionId}" records no agent preset and cannot be adopted under "${requestedPreset}"`
        : `session "${sessionId}" runs agent preset "${existingPreset}", not "${requestedPreset}"`,
    )
  }
}

/** Failures produced while resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentError = RemoteError<'session/not-found' | 'session/agent-busy' | 'gateway/internal'>

/** Result of resolving one ordinary Session identity to its live Agent. */
export type ApiSessionAgentResult =
  | { readonly agent: Agent }
  | { readonly error: ApiSessionAgentError }

type InstalledSelection = ModelSelectionRef & {
  current: AgentModelSelection
  consume(provider: string, model: string, reasoningEffort: string | undefined): boolean
}

/** Per-Agent dual-model role state installed beside the ordinary selection. */
interface InstalledRoles {
  /** Roles captured by the latest prompt assembly, consumed per step. */
  active: ModelRoles | undefined
}

/** Upper bound for one thinking-model plan injected into the worker request. */
const PLAN_MAX_CHARS = 24_000
/** Wall-clock budget for one thinking-model planning call. */
const PLAN_CALL_TIMEOUT_MS = 180_000
/** Worker-facing framing for one thinking-model plan. */
const PLAN_FRAME: string = [
  '<dual-model-plan>',
  'A planning model produced the plan below for the current user request.',
  'Follow it to complete the task; it is advisory and may be corrected by newer evidence.',
  '</dual-model-plan>',
].join('\n')

/** Structured skip classification for the durable record. */
type PlanSkipCode = DualModelPlanSkipReason

/** Human-readable reason text for one finish kind (merge-extensible vocabulary). */
function describeFinishReason(finish: string): string {
  switch (finish) {
    case 'max-tokens': return 'the planning output exhausted its token budget'
    case 'aborted': return 'the planning call was aborted'
    case 'error': return 'the model stream reported an error'
    case 'tool-calls': return 'the planning model produced tool calls instead of a plan'
    default: return 'the planning stream ended unusually'
  }
}

/**
 * Test whether generic Session routing must leave an identity to subagent routing.
 * @param ctx - Host context carrying the Agent ownership registry.
 * @param session - attached or live Session whose ownership is tested.
 * @param agent - live Agent when one exists for the Session.
 * @returns whether subagent routing owns the Session identity.
 */
export function hasApiSessionSubagentOwner(
  ctx: Context,
  session: Pick<Session, 'header'>,
  agent: Agent | undefined,
): boolean {
  if (session.header.origin === 'subagent') return true
  const parentId = session.header.parentSession
  if (parentId === undefined || agent === undefined) return false
  const parent = ctx.agents.get(parentId)
  return parent !== undefined && ctx.agents.isOwnedBy(agent.id, parent)
}

/**
 * Build the stable caller-facing subagent ownership rejection.
 * @param sessionId - Session identity owned by subagent routing.
 * @returns a stable Session-domain failure.
 */
export function apiSessionSubagentOwnershipError(sessionId: SessionId): ApiSessionAgentError {
  return new RemoteError(
    'session/agent-busy',
    `session "${sessionId}" is owned by subagent routing`,
    { reason: 'use subagent delivery for this child session' },
  )
}

/**
 * Inspect one cold Session without repairing, resuming, or publishing it.
 * @param ctx - Host context carrying Session persistence.
 * @param sessionId - durable Session identity.
 * @param signal - optional cancellation for persistence reads.
 * @returns the persisted header and complete event prefix.
 */
export async function inspectApiSession(
  ctx: Context,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<SessionInspection> {
  try {
    using observation = await ctx.sessionQuery.observeSession(sessionId, {
      ...(signal === undefined ? {} : { signal }),
      projectionMode: 'none',
    })
    if (observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    return {
      meta: observation.header,
      inheritedEventCount: observation.inheritedEventCount,
      events: [...observation.events],
    }
  } catch (error: unknown) {
    if (error instanceof SessionQueryError
      && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    throw error
  }
}

/** Owns every operation that may create, resume, or configure a Web Agent. */
export class ApiSessionAgentController {
  private readonly resumes = new Map<SessionId, Promise<Agent>>()
  private readonly creations = new Map<SessionId, Promise<Agent>>()
  private readonly selections = new WeakMap<Agent, InstalledSelection>()
  private readonly roles = new WeakMap<Agent, InstalledRoles>()
  private readonly imageAdmissionChains = new WeakMap<Agent, Promise<void>>()

  /** @param ctx - Host context carrying Agent, model, persistence, and Typert services. */
  constructor(
    private readonly ctx: Context,
    private readonly environmentPolicy: ModelEnvironmentPolicy = DEFAULT_MODEL_ENVIRONMENT_POLICY,
  ) {
    ctx.typert.lookups.configure('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent
    })
    ctx.typert.lookups.configure('session', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.session
    })
    ctx.typert.contexts.configureHost('agent', async (sessionId: SessionId) => {
      const found = await this.resolveAgent(sessionId)
      if ('error' in found) throw found.error
      return found.agent.ctx
    })
  }

  /**
   * Resolve or resume one ordinary Session, deduplicating concurrent resumes.
   * @param sessionId - ordinary Session identity.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveAgent(sessionId: SessionId): Promise<ApiSessionAgentResult> {
    return this.resolve(sessionId)
  }

  /**
   * Resolve one ordinary Session from an already-retained exact observation.
   * @param observation - Host-owned observation whose preparation stays pinned through setup.
   * @returns the live Agent or a stable Session-domain failure.
   */
  async resolveObservedAgent(observation: SessionObservation): Promise<ApiSessionAgentResult> {
    return this.resolve(observation.header.id, observation)
  }

  private async resolve(
    sessionId: SessionId,
    observation?: SessionObservation,
  ): Promise<ApiSessionAgentResult> {
    const live = this.liveAgent(sessionId)
    if (live !== undefined) return live
    const attached = this.ctx.sessions.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
      return { error: apiSessionSubagentOwnershipError(sessionId) }
    }

    let resume = this.resumes.get(sessionId)
    if (resume === undefined) {
      resume = this.resume(sessionId, observation).finally(() => { this.resumes.delete(sessionId) })
      this.resumes.set(sessionId, resume)
    }
    try {
      return { agent: await resume }
    } catch (error: unknown) {
      if (error instanceof ApiSessionNotFound) {
        return { error: new RemoteError('session/not-found', error.message, { sessionId }) }
      }
      if (error instanceof ApiSessionSubagentOwnership) {
        return { error: apiSessionSubagentOwnershipError(error.sessionId) }
      }
      const raced = this.liveAgent(sessionId)
      if (raced !== undefined) return raced
      const racedSession = this.ctx.sessions.get(sessionId)
      if (racedSession !== undefined && hasApiSessionSubagentOwner(this.ctx, racedSession, undefined)) {
        return { error: apiSessionSubagentOwnershipError(sessionId) }
      }
      return {
        error: new RemoteError(
          'gateway/internal',
          `resume failed for session "${sessionId}": ${String(error)}`,
          {},
        ),
      }
    }
  }

  /**
   * Resolve one requested identity, creating or resuming it once.
   * @param sessionId - requested Session identity.
   * @param cwd - directory the Session must own.
   * @param checkPersistedIdentity - whether to inspect a cold identity before creation.
   * @param presetId - optional Agent preset the Session must own.
   * @returns the matching live ordinary Agent.
   */
  async ensureSession(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId?: string,
  ): Promise<Agent> {
    let creation = this.creations.get(sessionId)
    if (creation === undefined) {
      creation = this.createOrAdopt(sessionId, cwd, checkPersistedIdentity, presetId)
        .catch((error: unknown) => {
          const live = this.ctx.agents.get(sessionId)
          if (live !== undefined) {
            if (hasApiSessionSubagentOwner(this.ctx, live.session, live)) {
              throw new ApiSessionSubagentOwnership(sessionId)
            }
            return live
          }
          const attached = this.ctx.sessions.get(sessionId)
          if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, undefined)) {
            throw new ApiSessionSubagentOwnership(sessionId)
          }
          throw error
        })
        .finally(() => { this.creations.delete(sessionId) })
      this.creations.set(sessionId, creation)
    }
    const agent = await creation
    if (hasApiSessionSubagentOwner(this.ctx, agent.session, agent)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (presetId !== undefined) {
      this.assertPresetUnchanged(sessionId, presetId, this.presetForSession(agent.session))
    }
    if (agent.session.header.cwd !== cwd) {
      throw new ApiSessionCwdConflict(sessionId, cwd, agent.session.header.cwd)
    }
    return agent
  }

  /**
   * Install or return the Session-local model selection used by prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @returns the installed mutable selection reference.
   */
  selectionFor(agent: Agent): InstalledSelection {
    const installed = this.selections.get(agent)
    if (installed !== undefined) return installed
    const projectionState = this.ctx.sessionProjections.stateOf(agent.session, 'modelSelection')
    if (projectionState === undefined) {
      throw new Error('api-session: required modelSelection projection is not registered')
    }
    let picked = projectionState.pending === null
      ? undefined
      : agentModelSelection(projectionState.pending)
    const defaultModel = this.ctx.agentDefaultModel
    const selection: InstalledSelection = {
      get current(): AgentModelSelection {
        if (picked !== undefined) return picked
        const loggedHeader = agent.session.requestHeader()
        if (loggedHeader === undefined) return defaultModel.currentSelection()
        const logged = loggedHeader.config
        return {
          provider: logged.provider,
          model: logged.model,
          // An effort the adapter defaulted is not a conversation choice: restoring
          // it as one would make an unchanged default read as a request change.
          ...(logged.reasoningEffort === undefined
            || loggedHeader.adapterDefaults?.reasoningEffort === true
            ? {}
            : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: AgentModelSelection) {
        picked = next
      },
      consume(provider: string, model: string, reasoningEffort: string | undefined): boolean {
        if (picked?.provider !== provider
          || picked.model !== model
          || picked.reasoningEffort !== reasoningEffort) return false
        picked = undefined
        return true
      },
      assembled: undefined,
    }
    // Roles listeners must wrap the selection listeners: registering first
    // makes the roles request replacement the outer layer, so the worker
    // route wins over the ordinary selection route for the same step.
    this.rolesFor(agent)
    installModelSelection(agent.ctx, selection)
    this.selections.set(agent, selection)
    return selection
  }

  /**
   * Commit and cache one validated selection for the next prompt assembly.
   * @param agent - live Agent that owns the selection.
   * @param selection - validated selection to record and apply.
   */
  selectForNextRequest(agent: Agent, selection: AgentModelSelection): void {
    agent.session.append('model/selection', selection)
    this.selectionFor(agent).current = selection
  }

  /**
   * Append the immutable environment selected for a later model request.
   * @param agent - live Agent that owns the Session log.
   * @param plan - detached plan already validated against the exact route.
   */
  selectEnvironmentForNextRequest(agent: Agent, plan: ModelEnvironmentPlan): void {
    agent.session.append('model/environment', plan)
  }

  /**
   * Install or return the Session-local dual-model roles used by pre-step
   * planning and request routing.
   * @param agent - live Agent that owns the roles.
   * @returns the installed per-agent roles state.
   */
  rolesFor(agent: Agent): InstalledRoles {
    const installed = this.roles.get(agent)
    if (installed !== undefined) return installed
    const created: InstalledRoles = { active: undefined }
    this.roles.set(agent, created)
    this.installDualModelRoles(agent)
    return created
  }

  /**
   * Couple durable model roles to the Agent-scoped loop extension points.
   * `system-prompt/assemble` snapshots the durable roles for every step, and
   * the request listener applies the worker route from that snapshot —
   * mirroring how {@link installModelSelection} couples the ordinary
   * selection. The request listener runs OUTSIDE the model-selection
   * listener (registered after it on the same agent context), so its
   * replacement wins for the worker route. Planning happens at the first
   * step of each turn: the thinking model sees the durable history plus the
   * claimed batch, and its plan enters the step as a durable plugin-sourced
   * user message that the loop appends with the decision.
   * @param agent - live Agent whose loop is being configured.
   */
  private installDualModelRoles(agent: Agent): void {
    // Per-step role snapshot: assemble runs before request for each step, so
    // the worker route and the planner see the same roles value.
    agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      const state = this.roles.get(agent)
      if (state === undefined) return assembled
      const current = this.ctx.sessionProjections.stateOf(agent.session, 'modelRoles')
      state.active = current ?? undefined
      return assembled
    })
    // Request routing: replace the resolved config with the worker route while
    // roles are enabled. Registered after the model-selection request listener
    // (rolesFor() runs inside selectionFor()), so this replacement applies last.
    agent.ctx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const roles = this.roles.get(agent)?.active
      if (roles === undefined || !roles.enabled) return resolved
      const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: roles.worker.provider,
        model: roles.worker.model,
        ...roles.worker.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(roles.worker.reasoningEffort) },
      }
    })
    // Planning + step message injection at the first step of every turn.
    agent.ctx.on('agent/pre-step', async ({ agent: subject, step, turn, signal }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const state = this.roles.get(subject)
      const roles = state?.active
      if (state === undefined || roles === undefined || !roles.enabled) return decision
      // Only the first step of a turn plans; tool-continuation steps reuse the
      // existing plan instead of recursing.
      if (step !== 1) return decision
      if (decision.messages.length === 0) return decision
      // Re-read durable roles right before calling: a concurrent disable must
      // not trigger a planning call.
      const current = this.ctx.sessionProjections.stateOf(subject.session, 'modelRoles')
      if (current === null || current === undefined || !current.enabled) return decision
      const plan = await this.runThinkingModel(subject, current, decision.messages, turn, signal)
      if (plan === undefined) return decision
      return { ...decision, messages: [...decision.messages, plan] }
    })
  }

  /**
   * Run one bounded thinking-model call over the durable history plus the
   * claimed step messages and frame its text output as worker context.
   * @param agent - live Agent whose session history and route feed the call.
   * @param roles - validated roles carrying the thinking route.
   * @param claimed - user messages claimed for this step.
   * @param turn - the turn whose first step owns the call.
   * @param signal - the active turn's cancellation signal.
   * @returns the framed plan message, or undefined when planning failed or produced nothing.
   */
  private async runThinkingModel(
    agent: Agent,
    roles: ModelRoles,
    claimed: readonly UserMessage[],
    turn: number,
    signal: AbortSignal,
  ): Promise<UserMessage | undefined> {
    const thinking = roles.thinking
    const started = performance.now()
    const recordSkip = (reason: PlanSkipCode, outcome?: { finish?: string; detail?: string }): void => {
      try {
        agent.session.append('dual-model/plan-skipped', {
          turn,
          thinking: { provider: thinking.provider, model: thinking.model, ...thinking.reasoningEffort === undefined ? {} : { reasoningEffort: thinking.reasoningEffort } },
          reason,
          ...(outcome?.finish === undefined ? {} : { finish: outcome.finish }),
          ...(outcome?.detail === undefined ? {} : { detail: outcome.detail }),
          durationMs: Math.max(0, Math.round(performance.now() - started)),
        })
      } catch (recordError: unknown) {
        this.ctx.logger.warn('dual-model: plan-skip record failed: %s', String(recordError))
      }
    }
    if (claimed.length === 0) return undefined
    let resolved: LlmCallConfig
    try {
      resolved = await this.ctx.llm.resolveCallConfig({
        provider: thinking.provider,
        model: thinking.model,
        ...(thinking.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(thinking.reasoningEffort) }),
      }, signal)
    } catch (error: unknown) {
      this.ctx.logger.warn('dual-model: thinking route %s/%s unavailable: %s', thinking.provider, thinking.model, String(error))
      recordSkip('route-resolve-failed', { detail: String(error) })
      return undefined
    }
    const history = agent.session.deriveMessages()
    const promptMessages: Message[] = [
      ...history,
      ...claimed.map(message => message),
    ]
    const options: GenerateOptions = {
      provider: resolved.provider,
      model: resolved.model,
      ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
      messages: promptMessages,
      system: PLAN_SYSTEM_PROMPT,
      maxTokens: PLAN_MAX_TOKENS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(PLAN_CALL_TIMEOUT_MS)]),
    }
    const assembler = new BlockAssembler()
    const collectText = (): string => assembler.blocks()
      .filter((block): block is Extract<(typeof block), { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('')
      .trim()
    try {
      for await (const chunk of this.ctx.llm.stream(options)) {
        options.signal?.throwIfAborted()
        assembler.push(chunk)
      }
    } catch (error: unknown) {
      if (signal.aborted) throw error
      this.ctx.logger.warn('dual-model: planning call failed: %s', String(error))
      recordSkip('call-failed', { detail: String(error) })
      return undefined
    }
    // The stream ended without throwing: carry a usable plan out of the
    // terminal state. `stop` and `max-tokens` keep their assembled text
    // (a truncated plan still directs the worker); error/aborted and other
    // finish kinds are unusable and skip the injection. An empty extraction
    // skips too — commonly the budget was consumed by reasoning alone.
    const finishKind = assembler.finish.kind
    if (finishKind !== 'stop' && finishKind !== 'max-tokens') {
      this.ctx.logger.warn('dual-model: planning finished with %s', finishKind)
      recordSkip('finish-not-usable', { finish: finishKind, detail: describeFinishReason(finishKind) })
      return undefined
    }
    const text = collectText()
    if (text.length === 0) {
      recordSkip('empty-output', { finish: finishKind, detail: 'the planning call completed without any text output' })
      return undefined
    }
    if (finishKind === 'max-tokens') {
      this.ctx.logger.warn('dual-model: planning hit its token budget; injecting the truncated plan')
    }
    const bounded = text.length > PLAN_MAX_CHARS ? `${text.slice(0, PLAN_MAX_CHARS - 1)}…` : text
    return createUserMessage({
      content: [{ type: 'text', text: `${PLAN_FRAME}\n${bounded}` }],
      source: {
        kind: 'plugin',
        plugin: 'dual-model',
        form: 'snapshot',
        sections: [{ name: 'dual-model plan', text: bounded }],
      },
    })
  }

  /**
   * Read the environment currently recorded for one Session.
   * @param session - Session whose projection is available.
   * @returns the latest environment plan, or undefined for older Sessions.
   */
  environmentForSession(session: Session): ModelEnvironmentPlan | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'modelEnvironment') ?? undefined
  }

  /**
   * Resolve one exact route for Session lifecycle binding.
   * @param provider - exact provider route.
   * @param model - provider-owned model id.
   * @param preset - preset mounted by the Agent.
   * @returns the immutable route environment plan, or undefined when the test
   * context has no exact-model resolver.
   */
  async resolveEnvironmentPlan(
    provider: string,
    model: string,
    preset: string,
  ): Promise<ModelEnvironmentPlan | undefined> {
    const llm = this.ctx.get('llm') as unknown as {
      resolveModelInfo?: (provider: string, model: string) => Promise<LlmResolvedModelInfo>
    } | undefined
    if (llm?.resolveModelInfo === undefined) return undefined
    let resolved: LlmResolvedModelInfo
    try {
      resolved = await llm.resolveModelInfo(provider, model)
    } catch {
      throw new ModelEnvironmentError(
        'model-environment/route-unavailable',
        `model environment route "${provider}/${model}" is unavailable`,
        { provider, model },
      )
    }
    const presets = this.ctx.get('agentPresets')
    const availablePresets = presets === undefined
      ? undefined
      : (await presets.list()).map(item => item.id)
    return resolveModelEnvironment({
      provider,
      model,
      preset,
      policy: this.environmentPolicy,
      ...(resolved.capabilities === undefined ? {} : { capabilities: resolved.capabilities }),
      ...(availablePresets === undefined ? {} : { availablePresets }),
    })
  }

  /**
   * Let a matching durable request header retire the execution cache.
   * @param agent - live Agent whose request was recorded.
   * @param provider - provider route used by the request.
   * @param model - provider-owned model used by the request.
   * @param reasoningEffort - adapter-owned effort used by the request.
   * @returns whether the pending selection was consumed.
   */
  consumeSelection(
    agent: Agent,
    provider: string,
    model: string,
    reasoningEffort: string | undefined,
  ): boolean {
    return this.selections.get(agent)?.consume(provider, model, reasoningEffort) ?? false
  }

  /**
   * Read the current Agent preset from the Session projection.
   * @param session - live Session whose projection state is available.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForSession(session: Session): string | undefined {
    return this.ctx.sessionProjections.stateOf(session, 'agentPreset') ?? undefined
  }

  /**
   * Serialize image admission and model selection for one Agent.
   * @param agent - live Agent that owns the serialization chain.
   * @param operation - asynchronous operation admitted after prior work settles.
   * @returns the operation result or rejection.
   */
  serializeImageAdmission<Value>(agent: Agent, operation: () => Promise<Value>): Promise<Value> {
    const result = (this.imageAdmissionChains.get(agent) ?? Promise.resolve()).then(operation)
    this.imageAdmissionChains.set(agent, result.then(() => undefined, () => undefined))
    return result
  }

  /**
   * Resolve the preset id and pre-publication Agent setup for a create or resume.
   * @param presetId - requested preset or the configured default when omitted.
   * @returns the resolved preset identity and Agent setup callback.
   */
  async composeAgent(presetId: string | undefined): Promise<{
    readonly agentPreset?: string
    readonly setup: AgentSetup
  }> {
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) {
      return { setup: (_agentCtx, agent) => { this.installSelection(agent) } }
    }
    const resolvedId = (await presets.resolve(presetId)).id
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agent)
        await presets.mount(agentCtx, resolvedId)
      },
    }
  }

  private liveAgent(sessionId: SessionId): ApiSessionAgentResult | undefined {
    const agent = this.ctx.agents.get(sessionId)
    if (agent === undefined) return undefined
    return hasApiSessionSubagentOwner(this.ctx, agent.session, agent)
      ? { error: apiSessionSubagentOwnershipError(sessionId) }
      : { agent }
  }

  private async resume(sessionId: SessionId, supplied?: SessionObservation): Promise<Agent> {
    if (supplied !== undefined) return this.resumeObserved(sessionId, supplied)
    try {
      using observation = await this.ctx.sessionQuery.observeSession(sessionId)
      return await this.resumeObserved(sessionId, observation)
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw new ApiSessionNotFound(`session "${sessionId}" not found`)
      }
      throw error
    }
  }

  private async resumeObserved(
    sessionId: SessionId,
    observation: SessionObservation,
  ): Promise<Agent> {
    if (observation.header.id !== sessionId || observation.header.cwd === undefined) {
      throw new ApiSessionNotFound(`session "${sessionId}" not found`)
    }
    if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    const composition = await this.composeAgent(this.presetForObservation(observation))
    const published = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (published !== undefined && hasApiSessionSubagentOwner(this.ctx, published, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    return (await this.ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    })).agent
  }

  private async createOrAdopt(
    sessionId: SessionId,
    cwd: string,
    checkPersistedIdentity: boolean,
    presetId: string | undefined,
  ): Promise<Agent> {
    const attached = this.ctx.sessions.get(sessionId)
    const live = this.ctx.agents.get(sessionId)
    if (attached !== undefined && hasApiSessionSubagentOwner(this.ctx, attached, live)) {
      throw new ApiSessionSubagentOwnership(sessionId)
    }
    if (live !== undefined) return live

    if (checkPersistedIdentity) {
      try {
        using observation = await this.ctx.sessionQuery.observeSession(sessionId)
        if (hasApiSessionSubagentOwner(this.ctx, { header: observation.header }, undefined)) {
          throw new ApiSessionSubagentOwnership(sessionId)
        }
        if (observation.header.cwd !== cwd) {
          throw new ApiSessionCwdConflict(sessionId, cwd, observation.header.cwd)
        }
        const storedPreset = this.presetForObservation(observation)
        this.assertPresetUnchanged(sessionId, presetId, storedPreset)
        const composition = await this.composeAgent(storedPreset)
        return (await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions(),
          setup: composition.setup,
        })).agent
      } catch (error: unknown) {
        if (!(error instanceof SessionQueryError)
          || error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
      }
    }

    try {
      await mkdir(cwd, { recursive: true })
    } catch (error: unknown) {
      throw new Error(`failed to ensure project directory "${cwd}": ${String(error)}`, { cause: error })
    }
    const composition = await this.composeAgent(presetId)
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const environment = await this.resolveEnvironmentPlan(
      selection.provider,
      selection.model,
      composition.agentPreset ?? 'default',
    )
    return (await this.ctx.agents.create({
      sessionId,
      agentOptions: { provider: selection.provider, model: selection.model },
      meta: {
        cwd,
        ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
      },
      setup: async (agentCtx, scopedAgent) => {
        const commit = await composition.setup(agentCtx, scopedAgent)
        if (environment !== undefined) {
          if (scopedAgent === undefined) throw new Error('api-session: Agent setup has no scoped Agent')
          scopedAgent.session.append('model/environment', environment)
        }
        return commit
      },
    })).agent
  }

  private agentOptions(): AgentOptions {
    const { provider, model } = this.ctx.agentDefaultModel.currentSelection()
    return { provider, model }
  }

  private installSelection(agent: Agent): void {
    this.selectionFor(agent)
  }

  /**
   * Read the current Agent preset from an all-projections observation.
   * @param observation - exact Session observation carrying its projection snapshot.
   * @returns the current preset, or undefined when the capability is absent.
   */
  presetForObservation(observation: SessionObservation): string | undefined {
    if (observation.projections === undefined) {
      throw new Error('api-session: Agent activation requires a projected Session observation')
    }
    return observation.projections.values.agentPreset ?? undefined
  }

  private assertPresetUnchanged(
    sessionId: SessionId,
    requested: string | undefined,
    existing: string | undefined,
  ): void {
    if (requested === undefined || requested === existing) return
    throw new ApiSessionPresetConflict(sessionId, requested, existing)
  }
}

function agentModelSelection(selection: ModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }),
  }
}

/** Planning-model system prompt: produce an executable plan, nothing else. */
const PLAN_SYSTEM_PROMPT = [
  'You are the planning model in a two-model pipeline. An executor model will',
  'carry out the user request using its own tools; it will only see your plan,',
  'not this conversation. Write the plan the executor needs:',
  '1. Restate the concrete objective in one line.',
  '2. Break the work into ordered, verifiable steps.',
  '3. Note constraints, risks, and acceptance criteria.',
  'Do not execute anything. Do not converse. Return only the plan text.',
].join('\n')

/** Planning output budget; shared by reasoning and answer on single-cap routes. */
const PLAN_MAX_TOKENS = 8_192
