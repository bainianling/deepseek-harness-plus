/**
 * 「对话创造」 real-execution engine (browser half).
 *
 * Creating a conversation MUST be the same act as a user typing in the normal
 * composer: a real Host Session, real persisted events, real model turns. This
 * module therefore drives exactly the canonical path the composer drives:
 *
 *   sessions.create({ workspaceId })  →  sessions.open(id)
 *     →  binding(id).session  →  beginSubmission()  →  prompt()
 *
 * Nothing here synthesizes content: every durable event is produced by the
 * Host, and every assistant message carries the model's own
 * `source.kind === 'model'` provenance. Failures raise
 * {@link ConversationCreateError} carrying the failing stage, the real cause,
 * and (once the Session exists) its id, so a partial creation is diagnosable
 * and never presented as a success.
 */
import type {
  ISessions, SessionEventSource, SessionFace,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { PlannedTurn } from './conversation-create.ts'

/**
 * Stage that failed, so the UI can say exactly where the chain stopped.
 * `compose` is the between-create-and-prompt window in which the chosen agent
 * preset and model route are committed to the new Session.
 */
export type CreateStage = 'validate' | 'create' | 'bind' | 'compose' | 'prompt' | 'turn'

/**
 * A real creation failure. `stage` locates it, `sessionId` is present as soon
 * as the Host created the Session, and `detail` keeps the original error text —
 * nothing is swallowed or replaced with a friendly-but-uninformative message.
 */
export class ConversationCreateError extends Error {
  override readonly name = 'ConversationCreateError'

  /**
   * @param stage - failing stage of the creation chain.
   * @param detail - original failure text (never paraphrased away).
   * @param sessionId - the created Session, when creation had already succeeded.
   * @param turn - one-based turn number, when the failure happened mid-conversation.
   */
  constructor(
    readonly stage: CreateStage,
    readonly detail: string,
    readonly sessionId?: SessionId,
    readonly turn?: number,
  ) {
    super(`conversation create failed at ${stage}: ${detail}`)
  }
}

/** Progress report for one created conversation. */
export interface CreateProgress {
  /** The real Session identity. */
  readonly sessionId: SessionId
  /** Completed real turns so far. */
  readonly completed: number
  /** Total real turns the draft plans to execute. */
  readonly total: number
}

/** Options accepted by {@link ConversationCreator.create}. */
export interface CreateConversationRequest {
  /** Explicit group (Workspace) chosen by the user at creation time. */
  readonly workspaceId: WorkspaceId
  /** Real turns to execute, in order. */
  readonly turns: readonly PlannedTurn[]
  /** Region title applied to the created Session; absent leaves the Host default. */
  readonly title?: string
  /** Composition choices applied to the Session before its first turn. */
  readonly composition?: ConversationCompositionRequest
  /** Progress callback fired after each real turn completes. */
  readonly onProgress?: (progress: CreateProgress) => void
  /** Cancellation for the whole multi-turn run. */
  readonly signal?: AbortSignal
}

/**
 * The composition the user chose for the Session about to be created.
 *
 * Both fields are optional and both are applied through the real Host routes by
 * {@link ConversationComposition} — never written locally. Absent means "leave
 * whatever the deployment resolves", which is a real deployment default rather
 * than a silent client-side decision.
 */
export interface ConversationCompositionRequest {
  /** Agent preset id, absent to keep the deployment default. */
  readonly agentPreset?: string
  /** Exact model route, absent to keep the deployment default. */
  readonly model?: ModelRoute
}

/** One exact model route the Host can serve. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * Composition ports applied to the Session after it exists and before its first
 * real turn.
 *
 * The client creation call carries neither choice — `sessions.create` accepts
 * only a workspace (or cwd) and an optional id — so both are committed through
 * the SAME Host routes the ordinary session surfaces use:
 * `agentPresets.select` (the header picker's between-turns swap) and
 * `session.selectModel` (the model seat). Each returns the refusal message so
 * the caller can report it, or undefined once the choice landed.
 */
export interface ConversationComposition {
  /**
   * Apply the chosen agent preset to the created Session.
   * @param sessionId - the Session just created (still blank, so selectable).
   * @param agentPreset - preset id the user chose.
   * @returns the refusal message, or undefined once the choice landed.
   */
  selectPreset(sessionId: SessionId, agentPreset: string): Promise<string | undefined>
  /**
   * Apply the chosen model route to the created Session.
   * @param sessionId - the Session just created.
   * @param model - exact provider/model route plus an optional reasoning effort.
   * @returns the refusal message, or undefined once the choice landed.
   */
  selectModel(sessionId: SessionId, model: ModelRoute): Promise<string | undefined>
}

/**
 * The real-execution half: everything that must run through the live Session
 * and Workspace Controllers. {@link createConversationCreator} builds exactly
 * this, holding no React state and no Host remote access of its own.
 */
export interface ConversationRunner {
  /**
   * Execute one draft as a real, continuable conversation.
   * @param request - chosen group plus the planned real turns.
   * @returns the created Session id.
   * @throws {ConversationCreateError} located at the failing stage.
   */
  create(request: CreateConversationRequest): Promise<SessionId>
}

/**
 * The browser-facing creation capability the pane receives as a plain callback:
 * the runner plus the roster/catalog reads the creation form needs.
 */
export interface ConversationCreator extends ConversationRunner {
  /**
   * Read the composition choices the Host actually offers.
   *
   * Read through the same routes the ordinary surfaces use, so what the pane
   * lists is what a session can really run. Broken preset rows are dropped and
   * failed provider catalogs are reported rather than presented as absence.
   * @returns the selectable presets and model routes.
   */
  listOptions(): Promise<CreationOptions>
}

/**
 * The composition choices the Host actually offers, read from the same routes
 * the ordinary session surfaces read.
 *
 * Both lists are advisory and may legitimately be empty (a deployment can
 * compose no preset, or a provider's catalog lookup can fail): an empty list
 * means "only the deployment default is available", which the pane states
 * rather than inventing an option.
 */
export interface CreationOptions {
  /** Selectable agent presets, broken rows excluded. */
  readonly presets: readonly AgentPresetOption[]
  /** Selectable provider groups and their models. */
  readonly providers: readonly ProviderOption[]
  /** Provider ids currently able to serve a request, as the Host reports. */
  readonly routableProviders: readonly string[]
  /** The deployment default route, used when the user picks nothing. */
  readonly defaultModel?: ModelRoute
  /** Provider catalogs that failed to load, reported rather than hidden. */
  readonly failures: readonly string[]
}

/** One selectable agent preset. */
export interface AgentPresetOption {
  readonly id: string
  /** Display name, falling back to the id exactly as the roster does. */
  readonly label: string
  /** Whether the deployment composes this preset when none is named. */
  readonly isDefault: boolean
}

/** One provider and the models it advertises. */
export interface ProviderOption {
  readonly id: string
  readonly label: string
  readonly models: readonly ModelOption[]
}

/** One selectable model inside its provider. */
export interface ModelOption {
  readonly id: string
  readonly label: string
}

/** True for a durable `turn/end` closing `turn`. */
function isTurnEnd(event: SessionEvent, turn: number): boolean {
  return event.type === 'turn/end' && event.data.turn === turn
}

/**
 * Describe a completed turn's terminal reason, or `undefined` when the turn
 * really completed. A non-completing reason is reported verbatim — it is never
 * mapped onto a friendlier outcome that hides the failure.
 */
function describeTurnEnd(event: SessionEvent): string | undefined {
  if (event.type !== 'turn/end') return undefined
  const reason = event.data.reason
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'error':
      return `${reason.error.code}: ${reason.error.message}`
    case 'aborted':
      return `aborted by ${reason.reason.kind}`
    case 'max-tokens':
      return 'the turn hit its output-token ceiling before finishing'
    case 'blocked':
      return 'the turn was blocked'
    case 'interrupted':
      return 'the turn was interrupted by a crash'
    default: {
      /* v8 ignore next 3 -- a plugin-declared terminal reason is reported by
       * name rather than mapped to an invented outcome. */
      const unknown: { kind: string } = reason
      return `the turn ended with "${unknown.kind}"`
    }
  }
}

/** Wait for `turn` to close, resolving with the durable `turn/end` event. */
function awaitTurn(
  sessionId: SessionId,
  eventSource: SessionEventSource,
  turn: number,
  signal: AbortSignal | undefined,
): Promise<SessionEvent | undefined> {
  return new Promise((resolve, reject) => {
    const read = (): SessionEvent | undefined => {
      for (const entry of eventSource.getSnapshot().entries) {
        if (entry.type !== 'event') continue
        if (isTurnEnd(entry.event, turn)) return entry.event
      }
      return undefined
    }
    let done = false
    const finish = (value: SessionEvent | undefined): void => {
      if (done) return
      done = true
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const fail = (error: Error): void => {
      if (done) return
      done = true
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }
    const onAbort = (): void => {
      fail(new ConversationCreateError(
        'turn', 'cancelled while waiting for the turn to finish', sessionId, turn,
      ))
    }
    const unsubscribe = eventSource.subscribe(() => {
      const ended = read()
      if (ended !== undefined) finish(ended)
    })
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    // The turn may already have closed between prompt() resolving and this
    // subscription (a fast model replies before the RPC round-trip returns).
    const already = read()
    if (already !== undefined) finish(already)
  })
}

/** Read the original failure text without inventing a substitute. */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Build the real-conversation creator over the live Session and Workspace
 * Controllers. The result exposes one method the pane calls; it holds no
 * React state and creates no subscriptions of its own.
 * @param sessions - the real Session Controller.
 * @param workspaces - the real Workspace Controller (group validation).
 * @param composition - ports applying the chosen preset/model to the new Session.
 * @returns the creator face.
 */
export function createConversationCreator(
  sessions: ISessions,
  workspaces: IWorkspaces,
  composition: ConversationComposition,
): ConversationRunner {
  return {
    async create(request: CreateConversationRequest): Promise<SessionId> {
      if (request.turns.length === 0) {
        throw new ConversationCreateError('validate', 'the draft produced no executable turn')
      }
      // The group is validated against the real Workspace registry before
      // anything is written: an unknown group must fail here rather than
      // silently create an ungrouped Session the user did not ask for.
      const known = workspaces.list.getSnapshot().items
        .some(item => item.workspaceId === request.workspaceId)
      if (!known) {
        throw new ConversationCreateError(
          'validate',
          `workspace "${request.workspaceId}" is not in the workspace registry`,
        )
      }

      let sessionId: SessionId
      try {
        sessionId = await sessions.create({ workspaceId: request.workspaceId })
      } catch (error) {
        throw new ConversationCreateError('create', errorText(error))
      }

      // create() guarantees synchronous addressability; a missing binding is
      // still reported explicitly rather than treated as "no session".
      const binding = sessions.binding(sessionId)
      if (binding === undefined) {
        throw new ConversationCreateError(
          'bind', `session "${sessionId}" was created but is not locally addressable`, sessionId,
        )
      }
      const session: SessionFace = binding.session

      // Open it so the conversation is on stage (and keeps streaming) while the
      // turns execute — exactly what clicking the row would do.
      sessions.open(sessionId)

      // Composition lands after the Session exists and BEFORE the first turn:
      // the first real request must already run under the chosen preset and
      // model, otherwise the user's choice would silently not apply to the very
      // turn that defines the conversation. A refusal is fatal and reported
      // with its own reason — the Session itself survives, so the error carries
      // its id and the pane can still offer it.
      if (request.composition?.agentPreset !== undefined) {
        const refusal = await composition.selectPreset(sessionId, request.composition.agentPreset)
        if (refusal !== undefined) {
          throw new ConversationCreateError(
            'compose',
            `agent preset "${request.composition.agentPreset}" was refused: ${refusal}`,
            sessionId,
          )
        }
      }
      if (request.composition?.model !== undefined) {
        const refusal = await composition.selectModel(sessionId, request.composition.model)
        if (refusal !== undefined) {
          const { provider, model } = request.composition.model
          throw new ConversationCreateError(
            'compose',
            `model "${provider}/${model}" was refused: ${refusal}`,
            sessionId,
          )
        }
      }

      if (request.title !== undefined && request.title !== '') {
        // A rename failure is not fatal to the conversation, but it is reported
        // rather than swallowed: the user asked for this title.
        const renamed = await session.rename(request.title)
        if (!renamed.ok) {
          throw new ConversationCreateError(
            'create',
            `session "${sessionId}" was created but could not be titled: ${renamed.error.code}: ${renamed.error.message}`,
            sessionId,
          )
        }
      }

      for (const planned of request.turns) {
        const submission = session.beginSubmission({
          mode: 'queue',
          text: planned.prompt,
          attachments: [],
        })
        let accepted: Awaited<ReturnType<SessionFace['prompt']>>
        try {
          accepted = await session.prompt(
            [{ type: 'text', text: planned.prompt }],
            'queue',
            request.signal,
            submission.requestId,
          )
        } catch (error) {
          submission.abandon()
          throw new ConversationCreateError('prompt', errorText(error), sessionId, planned.turn)
        }
        if (!accepted.ok) {
          submission.abandon()
          const failure = accepted.error
          throw new ConversationCreateError(
            'prompt',
            `${failure.code}: ${failure.message}`,
            sessionId,
            planned.turn,
          )
        }
        const ended = await awaitTurn(sessionId, binding.eventSource, planned.turn, request.signal)
        if (ended === undefined) {
          throw new ConversationCreateError(
            'turn', `turn ${String(planned.turn)} produced no turn/end event`, sessionId, planned.turn,
          )
        }
        const failure = describeTurnEnd(ended)
        if (failure !== undefined) {
          throw new ConversationCreateError('turn', failure, sessionId, planned.turn)
        }
        request.onProgress?.({ sessionId, completed: planned.turn, total: request.turns.length })
      }
      return sessionId
    },
  }
}
