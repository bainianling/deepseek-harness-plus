/** Pure model-environment resolution for exact routes and task policies. */

import type { ModelCapabilities } from './types.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ModelEnvironmentBackground,
  ModelEnvironmentCompaction,
  ModelEnvironmentOverrides,
  ModelEnvironmentPlan,
  ModelEnvironmentPolicy,
  ModelEnvironmentReason,
} from './types.ts'

/** Conservative environment policy used when a deployment supplies no policy. */
export const DEFAULT_MODEL_ENVIRONMENT_POLICY: ModelEnvironmentPolicy = Object.freeze({
  compaction: 'basic',
  background: 'foreground',
  parallelToolCalls: false,
})

/** Stable failures produced before model I/O by environment resolution. */
export type ModelEnvironmentErrorCode =
  | 'model-environment/invalid-route'
  | 'model-environment/route-unavailable'
  | 'model-environment/preset-unavailable'
  | 'model-environment/protocol-unavailable'
  | 'model-environment/state-unavailable'
  | 'model-environment/native-compaction-unavailable'
  | 'model-environment/background-unavailable'
  | 'model-environment/parallel-tool-calls-unavailable'

/** Classified environment-resolution failure. */
export class ModelEnvironmentError<Code extends ModelEnvironmentErrorCode = ModelEnvironmentErrorCode>
  extends RemoteError<Code> {
}

/** Input accepted by the pure environment resolver. */
export interface ResolveModelEnvironmentRequest {
  /** Exact route identity. */
  readonly provider: string
  /** Exact provider-owned model id. */
  readonly model: string
  /** Route capabilities already validated by dsh-llm. */
  readonly capabilities?: ModelCapabilities
  /** Preset selected for the Agent. */
  readonly preset: string
  /** Presets currently available to the deployment, when known. */
  readonly availablePresets?: readonly string[]
  /** Task policy before explicit overrides. */
  readonly policy: ModelEnvironmentPolicy
  /** Explicit deployment or user overrides. */
  readonly overrides?: ModelEnvironmentOverrides
}

/**
 * Resolve one exact model route to an immutable, explainable environment plan.
 * The function performs no I/O, plugin mounting, credential lookup, or Session
 * mutation. Unsupported overrides fail before a caller can dispatch a model.
 *
 * @param request - route capabilities, preset, task policy, and overrides.
 * @returns detached execution plan with one reason for every selected field.
 * @throws {@link ModelEnvironmentError} when the route, preset, or override
 * cannot be represented by the installed adapter.
 */
export function resolveModelEnvironment(
  request: ResolveModelEnvironmentRequest,
): ModelEnvironmentPlan {
  assertRoute(request.provider, request.model)
  if (request.preset.length === 0
    || (request.availablePresets !== undefined && !request.availablePresets.includes(request.preset))) {
    throw new ModelEnvironmentError(
      'model-environment/preset-unavailable',
      `model environment preset "${request.preset}" is unavailable`,
      { provider: request.provider, model: request.model, preset: request.preset },
    )
  }

  const capabilities = request.capabilities
  const overrides = request.overrides
  const reasons: ModelEnvironmentReason[] = []
  const protocol = resolveProtocol(request.provider, request.model, capabilities, overrides, reasons)
  const state = resolveState(request.provider, request.model, capabilities, overrides, reasons)
  const promptCaching = capabilities?.promptCaching ?? 'none'
  reasons.push({
    field: 'promptCaching',
    source: capabilities === undefined ? 'fallback' : 'route',
    code: capabilities === undefined ? 'fallback-no-capabilities' : 'route-prompt-caching',
  })
  const compaction = resolveCompaction(request.provider, request.model, capabilities, request.policy, overrides, reasons)
  const background = resolveBackground(request.provider, request.model, capabilities, request.policy, overrides, reasons)
  const parallelToolCalls = resolveParallelToolCalls(
    request.provider,
    request.model,
    capabilities,
    request.policy,
    overrides,
    reasons,
  )
  reasons.push({ field: 'preset', source: 'preset', code: 'selected-preset' })
  return Object.freeze({
    route: Object.freeze({ provider: request.provider, model: request.model }),
    preset: request.preset,
    protocol,
    state,
    promptCaching,
    compaction,
    background,
    parallelToolCalls,
    reasons: Object.freeze(reasons.map(reason => ({ ...reason }))),
  })
}

function assertRoute(provider: string, model: string): void {
  if (provider.length === 0 || model.length === 0) {
    throw new ModelEnvironmentError(
      'model-environment/invalid-route',
      'model environment requires non-empty provider and model',
      { provider, model },
    )
  }
}

function resolveProtocol(
  provider: string,
  model: string,
  capabilities: ModelCapabilities | undefined,
  overrides: ModelEnvironmentOverrides | undefined,
  reasons: ModelEnvironmentReason[],
): string {
  const requested = overrides?.protocol
  if (requested !== undefined) {
    if (capabilities?.protocol !== requested) {
      throw new ModelEnvironmentError(
        'model-environment/protocol-unavailable',
        `route "${provider}/${model}" does not provide protocol "${requested}"`,
        { provider, model, requested },
      )
    }
    reasons.push({ field: 'protocol', source: 'override', code: 'override-protocol' })
    return requested
  }
  reasons.push({
    field: 'protocol',
    source: capabilities === undefined ? 'fallback' : 'route',
    code: capabilities === undefined ? 'fallback-unspecified-protocol' : 'route-protocol',
  })
  return capabilities?.protocol ?? 'unspecified'
}

function resolveState(
  provider: string,
  model: string,
  capabilities: ModelCapabilities | undefined,
  overrides: ModelEnvironmentOverrides | undefined,
  reasons: ModelEnvironmentReason[],
): 'client-replay' | 'provider-managed' {
  const requested = overrides?.state
  if (requested !== undefined) {
    if (capabilities?.state !== requested) {
      throw new ModelEnvironmentError(
        'model-environment/state-unavailable',
        `route "${provider}/${model}" does not provide state mode "${requested}"`,
        { provider, model, requested },
      )
    }
    reasons.push({ field: 'state', source: 'override', code: 'override-state' })
    return requested
  }
  reasons.push({
    field: 'state',
    source: capabilities === undefined ? 'fallback' : 'route',
    code: capabilities === undefined ? 'fallback-client-replay' : 'route-state',
  })
  return capabilities?.state ?? 'client-replay'
}

function resolveCompaction(
  provider: string,
  model: string,
  capabilities: ModelCapabilities | undefined,
  policy: ModelEnvironmentPolicy,
  overrides: ModelEnvironmentOverrides | undefined,
  reasons: ModelEnvironmentReason[],
): ModelEnvironmentCompaction {
  const value = overrides?.compaction ?? policy.compaction
  if (value === 'native' && capabilities?.nativeCompaction !== true) {
    throw new ModelEnvironmentError(
      'model-environment/native-compaction-unavailable',
      `route "${provider}/${model}" does not provide native compaction`,
      { provider, model },
    )
  }
  reasons.push({
    field: 'compaction',
    source: overrides?.compaction === undefined ? 'task' : 'override',
    code: overrides?.compaction === undefined ? 'task-compaction' : 'override-compaction',
  })
  return value
}

function resolveBackground(
  provider: string,
  model: string,
  capabilities: ModelCapabilities | undefined,
  policy: ModelEnvironmentPolicy,
  overrides: ModelEnvironmentOverrides | undefined,
  reasons: ModelEnvironmentReason[],
): ModelEnvironmentBackground {
  const value = overrides?.background ?? policy.background
  if (value === 'durable' && capabilities?.background !== true) {
    throw new ModelEnvironmentError(
      'model-environment/background-unavailable',
      `route "${provider}/${model}" does not provide durable background execution`,
      { provider, model },
    )
  }
  reasons.push({
    field: 'background',
    source: overrides?.background === undefined ? 'task' : 'override',
    code: overrides?.background === undefined ? 'task-background' : 'override-background',
  })
  return value
}

function resolveParallelToolCalls(
  provider: string,
  model: string,
  capabilities: ModelCapabilities | undefined,
  policy: ModelEnvironmentPolicy,
  overrides: ModelEnvironmentOverrides | undefined,
  reasons: ModelEnvironmentReason[],
): boolean {
  const value = overrides?.parallelToolCalls ?? policy.parallelToolCalls
  if (value && capabilities?.parallelToolCalls !== true) {
    throw new ModelEnvironmentError(
      'model-environment/parallel-tool-calls-unavailable',
      `route "${provider}/${model}" does not provide parallel tool calls`,
      { provider, model },
    )
  }
  reasons.push({
    field: 'parallelToolCalls',
    source: overrides?.parallelToolCalls === undefined ? 'task' : 'override',
    code: overrides?.parallelToolCalls === undefined ? 'task-parallel-tool-calls' : 'override-parallel-tool-calls',
  })
  return value
}
