/**
 * Package-owned invariant companion for `dsh-session-manager`.
 * @module dsh-session-manager/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-session-manager'

/** Cordis companion plugin name. */
export const name = 'dsh-session-manager-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this is a browser-side surface plugin whose node half
 * owns no event stream or mutable runtime data; session deletion is a host
 * contract (persistence + agent teardown) covered by the host-side packages.
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
