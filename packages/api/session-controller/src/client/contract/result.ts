/** Client operation results spanning the Session and subagent Remote calls. */

import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionError } from '../../types.ts'

/** Failure surfaced by the Client Session object layer. */
export type ClientFailure = RemoteFailure | SessionError

/** Success or failure returned by a Client Session operation. */
export type ClientResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ClientFailure }

/**
 * Fold a rejected carrier operation into the Client Session failure vocabulary.
 * @param error - rejection from a Remote or local carrier call.
 * @returns the failure branch of a Client Session result.
 */
export function transportResult<T>(error: unknown): ClientResult<T> {
  return {
    ok: false,
    error: {
      code: 'internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}
