/**
 * Browser-facing vocabulary for the optional session dual-model mode.
 *
 * The Host owns the wire contract. This local declaration deliberately keeps
 * the UI package buildable while that future remote is being introduced.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'

/** Durable thinking/worker model role configuration. */
export interface ModelRoles {
  readonly enabled: boolean
  readonly thinking: ModelSelection
  readonly worker: ModelSelection
}

/** Projection value published by the Session Controller. */
export type ModelRolesProjection = ModelRoles

/** Future Session Remote method, declared locally until generated types land. */
export interface SelectModelRolesRequest extends ModelRoles {
  readonly sessionId: SessionId
}

export interface SelectModelRolesValue {
  readonly accepted: true
}

export interface SelectModelRolesRemote {
  selectModelRoles(
    request: SelectModelRolesRequest,
  ): Promise<RemoteResult<SelectModelRolesValue>>
}

/** Structural view of the generated session remote with the optional future method. */
export type SessionRemoteWithModelRoles = {
  readonly selectModelRoles?: SelectModelRolesRemote['selectModelRoles']
}

/** Runtime narrowing for optional future remote support, preserving its receiver. */
export function selectModelRolesOf(value: unknown): SelectModelRolesRemote['selectModelRoles'] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const method = (value as { selectModelRoles?: unknown }).selectModelRoles
  if (typeof method !== 'function') return undefined
  return (request) => (method as SelectModelRolesRemote['selectModelRoles']).call(value, request)
}

// The projection table is owned by the Session Controller; its types.ts
// already declares `modelRoles: ModelRoles | null` in the projection maps,
// so this package intentionally adds no competing module merge here.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/** Read only a validated projection shape; malformed/absent frames remain unavailable. */
export function readModelRolesProjection(value: unknown): ModelRoles | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined
  if (!isRecord(value.thinking) || typeof value.thinking.provider !== 'string'
    || typeof value.thinking.model !== 'string') return undefined
  if (!isRecord(value.worker) || typeof value.worker.provider !== 'string'
    || typeof value.worker.model !== 'string') return undefined
  const selection = (source: Record<string, unknown>): ModelSelection => ({
    provider: source.provider as string,
    model: source.model as string,
    ...(typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}),
  })
  return {
    enabled: value.enabled,
    thinking: selection(value.thinking),
    worker: selection(value.worker),
  }
}
