/** Per-session controller for the optional dual-model role selection. */
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  readModelRolesProjection,
  selectModelRolesOf,
  type ModelRoles,
  type SelectModelRolesRequest,
} from './model-roles.ts'
import type { ModelDirectory } from './directory.ts'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Observable state of one session's dual-model roles. */
export interface ModelRolesState {
  readonly available: boolean
  readonly value: ModelRoles | null
  readonly status: 'idle' | 'loading' | 'saving' | 'ready' | 'error'
  readonly error: string | null
}

const initialState: ModelRolesState = {
  available: false,
  value: null,
  status: 'idle',
  error: null,
}

/** Shared per-session role state, backed by the Host projection when present. */
export class ModelRolesDirectory {
  readonly store: SnapshotStore<ModelRolesState> = createSnapshotStore(initialState)
  private disposed = false
  private generation = 0
  private readonly unsubscribe: () => void
  private readonly selectModelRoles: ReturnType<typeof selectModelRolesOf>

  constructor(
    remoteSession: unknown,
    private readonly sessionId: SessionId,
    private readonly catalog: ModelCatalogDirectory,
    private readonly modelDirectory: ModelDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    available: boolean,
  ) {
    this.selectModelRoles = selectModelRolesOf(remoteSession)
    this.store.set({ ...initialState, available: available && this.selectModelRoles !== undefined })
    this.unsubscribe = projected.subscribe(() => { this.syncProjection() })
    this.syncProjection()
  }

  /** Whether this session can submit role selections at all. */
  get supported(): boolean {
    return this.store.getSnapshot().available
  }

  /** Ensure the shared catalog is loaded and seed defaults when the Host has none. */
  async load(): Promise<void> {
    if (!this.supported) return
    if (this.store.getSnapshot().status === 'idle') {
      this.store.set({ ...this.store.getSnapshot(), status: 'loading', error: null })
    }
    await this.catalog.load().catch(() => { /* surfaced on the shared catalog store */ })
    this.syncProjection()
    if (this.store.getSnapshot().value === null) {
      const current = this.modelDirectory.store.getSnapshot().current
      const fallback = current ?? this.catalog.store.getSnapshot().value?.default
      if (fallback !== undefined) {
        this.store.set({
          ...this.store.getSnapshot(),
          value: { enabled: false, thinking: fallback, worker: fallback },
          status: 'ready',
        })
      }
    }
  }

  /**
   * Submit a complete roles configuration to the Host.
   * @param value - enabled flag plus both exact routes.
   * @returns whether the Host accepted the configuration.
   */
  async select(value: ModelRoles): Promise<boolean> {
    if (!this.supported || this.selectModelRoles === undefined) return false
    const generation = ++this.generation
    const previous = this.store.getSnapshot().value
    this.store.set({ ...this.store.getSnapshot(), status: 'saving', error: null, value })
    try {
      const request: SelectModelRolesRequest = { sessionId: this.sessionId, ...value }
      const result = await this.selectModelRoles(request)
      if (this.disposed || generation !== this.generation) return result.ok
      if (!result.ok) {
        this.store.set({
          ...this.store.getSnapshot(),
          status: 'error',
          error: `${result.error.code}: ${result.error.message}`,
          value: previous,
        })
        return false
      }
      this.store.set({ ...this.store.getSnapshot(), status: 'ready', error: null })
      this.syncProjection()
      return true
    } catch (error: unknown) {
      if (generation !== this.generation || this.disposed) return false
      this.store.set({
        ...this.store.getSnapshot(),
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        value: previous,
      })
      return false
    }
  }

  /** Release the projection subscription; the scope disposer deletes the entry. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  private syncProjection(): void {
    if (this.disposed) return
    const value = readModelRolesProjection(this.projected.getSnapshot())
    if (value === undefined) {
      const state = this.store.getSnapshot()
      if (state.status === 'loading' || state.status === 'saving') return
      if (state.value !== null) return
      this.store.set({ ...state, status: 'idle' })
      return
    }
    this.store.set({ ...this.store.getSnapshot(), value, status: 'ready', error: null })
  }
}
