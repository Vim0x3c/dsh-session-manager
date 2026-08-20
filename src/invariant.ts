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
 * The Host half owns a transport route and a short-lived per-id operation map,
 * but no durable state of its own. Persistence and registry consistency are
 * checked at each deletion boundary instead of by a background invariant.
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
