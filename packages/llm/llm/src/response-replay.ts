/** Provider-neutral durable lifecycle for Responses-style model output. */

import { HarnessError } from './error.ts'
import type { ProviderResponseId } from './brand.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { LlmFailure, LlmModelState } from './types.ts'

/** Exact route bound to one provider response lifecycle. */
export interface LlmResponseRoute {
  /** Registered provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Durable opening record for one Responses-style request. */
export interface LlmResponseOpened {
  /** Exact provider/model route that owns this response. */
  readonly route: LlmResponseRoute
  /** Provider response id, absent for client-replay-only responses. */
  readonly responseId?: ProviderResponseId
  /** State strategy used by the prepared adapter call. */
  readonly state: LlmModelState
}

/** Model-visible item categories accepted in a Responses replay log. */
export type LlmResponseItemKind = 'message' | 'reasoning' | 'tool-call' | 'tool-result'

/** Durable model-visible item from one provider response. */
export interface LlmResponseItem {
  /** Exact route bound to the response. */
  readonly route: LlmResponseRoute
  /** Response id that produced this item, when the response has one. */
  readonly responseId?: ProviderResponseId
  /** Zero-based position in the response item sequence. */
  readonly itemIndex: number
  /** Provider-neutral classification used by replay consumers. */
  readonly kind: LlmResponseItemKind
  /** Adapter-validated, credential-free provider item. */
  readonly payload: JsonValue
}

/** Terminal status recorded when one Responses-style request stops. */
export type LlmResponseTerminalStatus = 'completed' | 'incomplete' | 'failed' | 'cancelled'

/** Durable terminal record for one provider response lifecycle. */
export interface LlmResponseClosed {
  /** Exact route bound to the response. */
  readonly route: LlmResponseRoute
  /** Response id that ended, when the response has one. */
  readonly responseId?: ProviderResponseId
  /** Provider-neutral terminal classification. */
  readonly status: LlmResponseTerminalStatus
  /** Structured failure for failed or cancelled responses, when available. */
  readonly failure?: LlmFailure
}

/** Complete response lifecycle emitted by an adapter at stream termination. */
export interface LlmResponseLifecycle {
  /** Opening route and continuation identity. */
  readonly opened: LlmResponseOpened
  /** Ordered, credential-free model-visible response items. */
  readonly items: readonly LlmResponseItem[]
  /** Terminal status for the response. */
  readonly closed: LlmResponseClosed
}

/** State produced by folding the latest Responses replay lifecycle. */
export interface LlmResponseReplayState {
  /** Current response, or `null` after its terminal event. */
  readonly opened: LlmResponseOpened | null
  /** Items accepted for the current or most recently closed response. */
  readonly items: readonly LlmResponseItem[]
  /** Terminal record for the most recently closed response. */
  readonly closed: LlmResponseClosed | null
}

/** Initial state for a Responses replay projection. */
export const EMPTY_LLM_RESPONSE_REPLAY: LlmResponseReplayState = Object.freeze({
  opened: null,
  items: Object.freeze([]),
  closed: null,
})

/** One payload event accepted by the Responses replay reducer. */
export type LlmResponseReplayEvent =
  | { readonly type: 'llm/response-opened'; readonly data: LlmResponseOpened }
  | { readonly type: 'llm/response-item'; readonly data: LlmResponseItem }
  | { readonly type: 'llm/response-closed'; readonly data: LlmResponseClosed }

function invalidReplay(message: string): never {
  throw new HarnessError(`invalid Responses replay state: ${message}`, 'INVALID_REPLAY_STATE')
}

function sameRoute(left: LlmResponseRoute, right: LlmResponseRoute): boolean {
  return left.provider === right.provider && left.model === right.model
}

function sameResponseId(left: ProviderResponseId | undefined, right: ProviderResponseId | undefined): boolean {
  return left === right
}

function assertBound(
  opened: LlmResponseOpened,
  route: LlmResponseRoute,
  responseId: ProviderResponseId | undefined,
): void {
  if (!sameRoute(opened.route, route)) {
    invalidReplay(`route changed from "${opened.route.provider}/${opened.route.model}" to "${route.provider}/${route.model}"`)
  }
  if (!sameResponseId(opened.responseId, responseId)) {
    invalidReplay('response id does not match the opened response')
  }
}

/**
 * Fold one Responses replay event while rejecting route, response-id, order,
 * and lifecycle violations. The returned state is detached from the input
 * arrays, so a caller cannot mutate the reducer's prior state through an event.
 * @param state - current response replay state.
 * @param event - next durable response event.
 * @returns the next immutable replay state.
 */
export function applyLlmResponseReplay(
  state: LlmResponseReplayState,
  event: LlmResponseReplayEvent,
): LlmResponseReplayState {
  switch (event.type) {
    case 'llm/response-opened':
      if (state.opened !== null) invalidReplay('a response is already open')
      return Object.freeze({ opened: event.data, items: Object.freeze([]), closed: null })
    case 'llm/response-item': {
      if (state.opened === null) invalidReplay('response item has no opened response')
      assertBound(state.opened, event.data.route, event.data.responseId)
      if (!Number.isSafeInteger(event.data.itemIndex) || event.data.itemIndex < 0) {
        invalidReplay('response item index is not a non-negative safe integer')
      }
      if (event.data.itemIndex !== state.items.length) {
        invalidReplay(`response item index ${String(event.data.itemIndex)} is not ${String(state.items.length)}`)
      }
      return Object.freeze({
        opened: state.opened,
        items: Object.freeze([...state.items, event.data]),
        closed: null,
      })
    }
    case 'llm/response-closed': {
      if (state.opened === null) invalidReplay('response closed without an opened response')
      assertBound(state.opened, event.data.route, event.data.responseId)
      return Object.freeze({ opened: null, items: state.items, closed: event.data })
    }
    default: return invalidReplay(`unknown event ${(event as { type: string }).type}`)
  }
}
