/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-browser-panel`.
 * @module @deepseek-ai/dsh-client-ui-browser-panel/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-browser-panel'

/** Cordis companion plugin name. */
export const name = 'client-ui-browser-panel-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the host half is a loopback RPC over the existing
 * browser service (no new cross-plugin events), and the client half renders
 * into its own DOM container — no shared slot rows to police.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
