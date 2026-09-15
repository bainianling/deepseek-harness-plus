/**
 * Domain types of the multi-AI collaboration studio. A project is one
 * requirement sentence driven through a company-style pipeline (CEO / CTO /
 * product / programmer / tester / documentation); every pipeline stage holds
 * one consensus meeting (Atomic-Chat) between full harness agents before its
 * producer role delivers files into the project directory.
 * @module @deepseek-ai/dsh-collab-studio/types
 */

/** One company role taking part in the collaboration. */
export type RoleId = 'ceo' | 'cto' | 'pm' | 'dev' | 'qa' | 'doc'

/** Kind of project the pipeline produces (tunes stage prompts only). */
export type ProjectType = 'software' | 'webpage' | 'document' | 'research' | 'other'

/** Whole-project lifecycle. */
export type ProjectStatus = 'draft' | 'running' | 'done' | 'failed' | 'stopped'

/** One pipeline stage lifecycle. */
export type StageStatus = 'pending' | 'meeting' | 'producing' | 'reviewing' | 'done' | 'failed' | 'skipped'

/** Explicit model route selected for one stage ('default' keeps the deployment default). */
export interface ModelRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Static definition of one role in the company template. */
export interface RoleSpec {
  readonly id: RoleId
  /** Human-readable role title, e.g. "产品经理". */
  readonly title: string
  /** Persona instruction line embedded in every prompt for this role. */
  readonly persona: string
}

/** Consensus meeting attached to one stage. */
export interface MeetingSpec {
  /** Speaking participants in seating order (the first seat facilitates). */
  readonly participants: readonly RoleId[]
  /** Maximum discussion rounds before the facilitator decides anyway. */
  readonly maxRounds: number
}

/** Review-and-fix loop following production. */
export interface ReviewSpec {
  /** Role judging the deliverable. */
  readonly reviewer: RoleId
  /** Role fixing the issues the reviewer reports. */
  readonly fixer: RoleId
  /** Maximum fix rounds before the stage proceeds anyway. */
  readonly maxFixRounds: number
}

/** Static definition of one pipeline stage. */
export interface StageSpec {
  readonly id: string
  /** Meeting topic shown to every participant. */
  readonly topic: string
  /** Optional consensus meeting held before production. */
  readonly meeting?: MeetingSpec
  /** Role producing the stage deliverable (every stage has one). */
  readonly producer: RoleId
  /** What the producer must deliver; also the deliverable file hint. */
  readonly deliverable: string
  /** Optional review-and-fix loop after production. */
  readonly review?: ReviewSpec
}

/** One utterance recorded in a stage meeting. */
export interface MeetingTurn {
  readonly round: number
  readonly role: RoleId
  readonly text: string
  readonly vote: 'approve' | 'object' | 'unknown'
}

/** Durable project record persisted as `studio.json`. */
export interface ProjectRecord {
  readonly id: string
  readonly name: string
  readonly requirement: string
  readonly projectType: ProjectType
  readonly createdAt: number
  status: ProjectStatus
  /** Per-stage model selection; absent stages run on the deployment default. */
  readonly stageModels: Record<string, ModelRoute>
  stageStatus: Record<string, StageStatus>
  currentStage?: string
  /** Project-directory-relative deliverable paths observed so far. */
  deliverables: string[]
  error?: string
  finishedAt?: number
}

/** One append-only studio event line (`events.jsonl`). */
export interface StudioEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: Record<string, unknown>
}

/** Project summary returned by the list route. */
export interface ProjectSummary {
  readonly id: string
  readonly name: string
  readonly requirement: string
  readonly projectType: ProjectType
  readonly createdAt: number
  readonly status: ProjectStatus
  readonly currentStage?: string
  readonly finishedAt?: number
}

/** Creation request accepted by the create route. */
export interface CreateProjectRequest {
  readonly requirement: string
  readonly name?: string
  readonly projectType?: ProjectType
  readonly stageModels?: Record<string, ModelRoute>
  /** Start the pipeline immediately after creation. */
  readonly start?: boolean
}

/** Structural agent surface the studio drives (mirrors @deepseek-ai/dsh-agent). */
export interface StudioAgentLike {
  readonly id: string
  readonly status: 'idle' | 'running'
  readonly session: {
    readonly id: string
    /** Current Session API: read the append-only log through seq/snapshotEvents. */
    readonly seq: number
    /** Append one durable session event (used to pin the role's approval policy). */
    append(type: string, data: unknown): unknown
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
export interface StudioAgentsLike {
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly origin?: string }
    readonly agentOptions?: { readonly provider?: string; readonly model?: string }
    readonly setup?: (agentCtx: unknown, agent: StudioAgentLike) => Promise<void> | void
  }): Promise<{ readonly agent: StudioAgentLike; dispose(): Promise<void> }>
}

/** Structural agent-preset surface (mirrors @deepseek-ai/dsh-agent-presets). */
export interface StudioPresetsLike {
  resolve(presetId: string | undefined): Promise<{ readonly id: string }>
  mount(agentCtx: unknown, presetId: string): Promise<void> | void
}

/** Structural llm surface (mirrors the llm service route listing). */
export interface StudioLlmLike {
  listProviders(): readonly { readonly id: string; readonly name: string }[]
}

/** Structural default-model surface (mirrors agentDefaultModel). */
export interface StudioDefaultModelLike {
  /**
   * Read the current deployment default selection.
   *
   * `reasoningEffort` is carried through when present: the model-selection
   * coupling treats an absent effort as "clear any inherited effort and use the
   * provider default", so dropping a configured effort here would silently run
   * every role at lower reasoning than the deployment selected.
   */
  currentSelection(): {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort?: string
  }
}

/** One role driver the engine speaks through (real agents in production). */
export interface RoleDriver {
  /** Create (or reuse) the live agent for one role with the project cwd. */
  ensureRole(role: RoleSpec, cwd: string): Promise<void>
  /** Set the model route the role uses for subsequent turns (undefined = default). */
  setRoute(role: RoleId, route: ModelRoute | undefined): void
  /** Run one role turn and return the assistant's reply text. */
  speak(role: RoleId, prompt: string, signal: AbortSignal): Promise<string>
  /** Dispose every live role agent. */
  disposeAll(): Promise<void>
}

/** Deployment limits accepted by the plugin row config. */
export interface StudioConfig {
  /** Enable the collaboration studio routes and service. */
  readonly enabled?: boolean
  /** Absolute data directory for persisted projects. */
  readonly dataDir?: string
  /** Maximum number of persisted projects. */
  readonly maxProjects?: number
  /** Maximum number of retained events returned per project. */
  readonly maxEventTail?: number
  /** Maximum consensus rounds per meeting. */
  readonly maxMeetingRounds?: number
  /** Maximum bytes readable from one generated project file. */
  readonly maxFileReadBytes?: number
}

/** Fully resolved plugin configuration. */
export interface ResolvedStudioConfig {
  readonly enabled: boolean
  readonly dataDir: string
  readonly maxProjects: number
  readonly maxEventTail: number
  readonly maxMeetingRounds: number
  readonly maxFileReadBytes: number
}
