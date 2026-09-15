/**
 * Domain types of the model testing bench. One round belongs to exactly one
 * question category (coding / document / vision / paper): an AI generator
 * agent writes the question, a user-chosen set of models (any count) answers
 * it concurrently — each model is its own full harness agent mounting the
 * same default preset, so every contestant shares one identical tool
 * environment while only the model route differs — and a judge agent grades
 * every answer pass/fail with a numeric score.
 * @module @deepseek-ai/dsh-model-bench/types
 */

/** Question category; each round tests exactly one category. */
export type BenchCategory = 'coding' | 'document' | 'vision' | 'paper'

/** User-selected question difficulty. */
export type BenchDifficulty = 'easy' | 'medium' | 'hard'

/** Round lifecycle: draft → generating → ready → running → judging → done. */
export type RoundStatus =
  | 'draft'
  | 'generating'
  | 'ready'
  | 'running'
  | 'judging'
  | 'done'
  | 'failed'
  | 'stopped'

/** One contestant run lifecycle. */
export type ContestantStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'skipped'

/** Explicit model route ('default' keeps the deployment default). */
export interface ModelRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Parsed generator metadata (defensively read from `meta.json`). */
export interface QuestionMeta {
  readonly title: string
  readonly difficulty: 'easy' | 'medium' | 'hard' | 'unknown'
  /** Minimum judge score (0–10) required to pass; default 6. */
  readonly passThreshold: number
  /** Extra grading guidance embedded in the judge prompt. */
  readonly judgeNotes: string
}

/** Judge outcome for one contestant. */
export interface JudgeVerdict {
  readonly pass: boolean
  /** Numeric score on a 0–10 scale (null when the judge gave none). */
  readonly score: number | null
  /** Judge comment text (trimmed reply). */
  readonly comment: string
}

/** One contestant's durable state inside the round record. */
export interface ContestantRecord {
  /** Stable per-round slug derived from the model route. */
  readonly slug: string
  readonly provider: string
  readonly model: string
  status: ContestantStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  /** Tail of the contestant's final reply text (bounded). */
  replyTail?: string
  verdict?: JudgeVerdict
  error?: string
}

/** Durable round record persisted as `round.json`. */
export interface RoundRecord {
  readonly id: string
  readonly name: string
  readonly category: BenchCategory
  /** Requested difficulty, fixed before the generator runs. */
  readonly difficulty: BenchDifficulty
  readonly createdAt: number
  status: RoundStatus
  /** Generator model route; absent means the deployment default. */
  generator?: ModelRoute
  /** Judge model route; absent means the deployment default. */
  judge?: ModelRoute
  /** Selected contestant routes (fixed at start time). */
  readonly models: readonly ModelRoute[]
  question?: {
    readonly title: string
    readonly difficulty: string
    readonly passThreshold: number
    /** Vision rounds: the seed image file name inside the materials. */
    readonly image?: string
  }
  /** Contestant state keyed by slug. */
  contestants: Record<string, ContestantRecord>
  stats?: {
    readonly total: number
    readonly passed: number
    readonly judged: number
    readonly avgDurationMs: number
    readonly minDurationMs: number
    readonly maxDurationMs: number
  }
  error?: string
  finishedAt?: number
}

/** Round summary returned by the list route. */
export interface RoundSummary {
  readonly id: string
  readonly name: string
  readonly category: BenchCategory
  readonly difficulty: BenchDifficulty
  readonly createdAt: number
  readonly status: RoundStatus
  readonly modelCount: number
  readonly questionTitle?: string
  readonly stats?: RoundRecord['stats']
  readonly finishedAt?: number
}

/** Creation request accepted by the create route. */
export interface CreateRoundRequest {
  readonly category: BenchCategory
  /** Defaults to medium for backward-compatible callers. */
  readonly difficulty?: BenchDifficulty
  readonly name?: string
  readonly generator?: ModelRoute
  readonly judge?: ModelRoute
  /** Start question generation immediately after creation. */
  readonly start?: boolean
}

/** Start request: the contestant roster plus optional judge override. */
export interface StartRoundRequest {
  readonly models: readonly ModelRoute[]
  readonly judge?: ModelRoute
}

/** One append-only bench event line (`events.jsonl`). */
export interface BenchEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Structural agent surface the bench drives (mirrors @deepseek-ai/dsh-agent). */
export interface BenchAgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly id: string
    /** Current Session API: read the append-only log through seq/snapshotEvents. */
    readonly seq: number
    snapshotEvents(
      fromSeq?: number,
      toSeqExclusive?: number,
    ): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
    readonly header: { readonly seedLength?: number }
  }
  followup(message: unknown): void
  cancel(cause: { readonly kind: string; readonly reason?: string }, options?: { readonly keepInbox?: boolean }): void
  whenIdle(): Promise<void>
}

/** Structural agent-registry surface (mirrors AgentRegistry.create). */
export interface BenchAgentsLike {
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly origin?: string }
    readonly agentOptions?: { readonly provider?: string; readonly model?: string }
    readonly setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<{ readonly agent: BenchAgentLike; dispose(): Promise<void> }>
}

/** Structural agent-preset surface (mirrors @deepseek-ai/dsh-agent-presets). */
export interface BenchPresetsLike {
  resolve(presetId: string | undefined): Promise<{ readonly id: string }>
  mount(agentCtx: unknown, presetId: string): Promise<void> | void
}

/** Structural llm surface (provider listing plus per-provider model listing). */
export interface BenchLlmLike {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name?: string }[]>
}

/** Structural default-model surface (mirrors agentDefaultModel). */
export interface BenchDefaultModelLike {
  currentSelection(): { readonly provider: string; readonly model: string }
}

/** One slot driver the engine speaks through (real agents in production). */
export interface BenchSlotDriver {
  /** Create (or reuse) the live agent for one slot with its working dir. */
  ensureSlot(slot: string, cwd: string): Promise<void>
  /** Set the model route the slot uses for subsequent turns (undefined = default). */
  setRoute(slot: string, route: ModelRoute | undefined): void
  /** Run one slot turn and return the assistant's reply text. */
  run(slot: string, prompt: string, signal: AbortSignal): Promise<string>
  /** Dispose every live slot agent. */
  disposeAll(): Promise<void>
}

/** Deployment limits accepted by the plugin row config. */
export interface BenchConfig {
  /** Enable the model benchmark routes and service. */
  readonly enabled?: boolean
  /** Absolute data directory for persisted rounds. */
  readonly dataDir?: string
  /** Maximum number of persisted rounds. */
  readonly maxRounds?: number
  /** Maximum number of retained events returned per round. */
  readonly maxEventTail?: number
  /** Maximum contestants permitted in one round. */
  readonly maxContestantsPerRound?: number
  /** Per-contestant execution timeout in milliseconds. */
  readonly contestantTimeoutMs?: number
  /** Question-generation timeout in milliseconds. */
  readonly generateTimeoutMs?: number
  /** Judge-agent timeout in milliseconds. */
  readonly judgeTimeoutMs?: number
}

/** Fully resolved plugin configuration. */
export interface ResolvedBenchConfig {
  readonly enabled: boolean
  readonly dataDir: string
  readonly maxRounds: number
  readonly maxEventTail: number
  readonly maxContestantsPerRound: number
  readonly contestantTimeoutMs: number
  readonly generateTimeoutMs: number
  readonly judgeTimeoutMs: number
}
