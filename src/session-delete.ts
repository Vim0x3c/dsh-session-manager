/** rc.8 host compatibility implementation for permanent session deletion. */

import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

interface SessionHeaderLike {
  readonly id: string
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
}

interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
}

interface AgentLike {
  readonly id: string
}

interface PersistenceLike {
  readonly name?: string
  list(signal?: AbortSignal): Promise<SessionHeaderLike[]>
  locate(header: SessionHeaderLike): { kind: string; path: string } | undefined
  delete?: (id: string, signal?: AbortSignal) => Promise<boolean>
  deleteMany?: (ids: readonly string[], signal?: AbortSignal) => Promise<boolean>
  root?: string
  coordinator?: CoordinatorInternals
  store?: SqliteStoreInternals
}

interface CoordinatorInternals {
  serialize<T>(id: string, op: () => Promise<T> | T, signal?: AbortSignal): Promise<T>
  readonly retirements: Map<string, Promise<void>>
  readonly preparations: {
    invalidate(id: string): void
    readonly entries?: Map<string, { readonly phase?: string }>
  }
  readonly states: Map<string, unknown>
  readonly live: Map<SessionLike, unknown>
}

interface SqliteRunResult { readonly changes: number | bigint }
interface SqliteDatabaseInternals {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): SqliteRunResult }
}
interface SqliteStoreInternals {
  open(): Promise<void>
  readonly db: SqliteDatabaseInternals
}

interface AgentLoopLike {
  stop?: (id: string) => Promise<boolean>
}

interface EffectMeta { readonly label?: string }
interface EffectDisposer {
  (): void | Promise<void>
  readonly [key: symbol]: EffectMeta | undefined
}
interface FiberInternals {
  readonly _disposables?: Iterable<EffectDisposer>
}
interface RuntimeInternals { readonly fibers?: Iterable<FiberInternals> }
interface RegistryInternals { values(): Iterable<RuntimeInternals> }

export interface DeleteHostContext {
  readonly root: { readonly fiber: FiberInternals }
  readonly registry: RegistryInternals
  readonly sessions: {
    get(id: string): SessionLike | undefined
    list?: () => readonly SessionLike[]
  }
  readonly agents: { get(id: string): AgentLike | undefined }
  readonly agentLoop: AgentLoopLike
  readonly sessionPersistence: PersistenceLike
}

/** Requested identity does not exist either live or durably. */
export class SessionDeleteNotFoundError extends Error {}
/** Requested identity is owned by another lifecycle or raced back to live. */
export class SessionDeleteBusyError extends Error {}

/**
 * Every managed subagent below one session, deepest lineage first. Ordinary
 * sessions remain independent deletion targets, but they are traversal nodes:
 * Harness can publish a managed child below an ordinary fork or one-shot run.
 */
export function collectManagedDescendants(
  headers: readonly SessionHeaderLike[],
  rootId: string,
): string[] {
  const headerById = new Map(headers.map(header => [header.id, header]))
  const childrenOf = new Map<string, string[]>()
  for (const header of headers) {
    if (header.parentSession === undefined || header.id === rootId) continue
    const siblings = childrenOf.get(header.parentSession)
    if (siblings === undefined) childrenOf.set(header.parentSession, [header.id])
    else if (!siblings.includes(header.id)) siblings.push(header.id)
  }
  const ordered: string[] = []
  const visited = new Set<string>([rootId])
  const walk = (parentId: string): void => {
    for (const child of childrenOf.get(parentId) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      walk(child)
      if (headerById.get(child)?.origin === 'subagent') {
        ordered.push(child) // post-order: grandchildren land before their parent.
      }
    }
  }
  walk(rootId)
  return ordered
}

type DeleteAdapter =
  | { kind: 'native'; persistence: PersistenceLike }
  | { kind: 'jsonl'; persistence: PersistenceLike; coordinator: CoordinatorInternals }
  | { kind: 'sqlite'; persistence: PersistenceLike; coordinator: CoordinatorInternals; store: SqliteStoreInternals }

interface CascadeSnapshot {
  readonly ids: string[]
  readonly headers: ReadonlyMap<string, SessionHeaderLike>
  readonly liveIds: ReadonlySet<string>
}

interface DeleteTarget {
  readonly id: string
  readonly header: SessionHeaderLike
  readonly durable: boolean
  readonly live: boolean
}

const EFFECT_SYMBOL = Symbol.for('cordis.effect')
const MAX_CASCADE_STABILIZE_ATTEMPTS = 3

/**
 * Stop a live lifecycle and erase the matching durable artifact.
 *
 * Deleting a session also deletes its whole managed subagent family: every
 * durable `origin: 'subagent'` descendant is stopped and erased deepest-first
 * before the target. Direct requests for a managed child remain refused while
 * its parent exists; an orphaned managed child can be cleaned up directly.
 */
export class SessionDeleteService {
  private readonly inFlight = new Map<string, Promise<boolean>>()

  constructor(private readonly ctx: Context & DeleteHostContext) {}

  delete(id: string): Promise<boolean> {
    const existing = this.inFlight.get(id)
    if (existing !== undefined) return existing
    const operation = this.deleteCore(id).finally(() => {
      if (this.inFlight.get(id) === operation) this.inFlight.delete(id)
    })
    this.inFlight.set(id, operation)
    return operation
  }

  /**
   * Delete several independent sessions. Each id goes through its own full
   * lifecycle cascade (stop + preflight + erase) exactly as a single delete
   * would, so managed-child ownership rules and loopback enforcement are
   * unchanged for every member. Members are independent deletion targets, so a
   * failed member does not roll the already-deleted ones back: the result lists
   * which ids were removed and why each failure happened.
   */
  async deleteMany(ids: readonly string[]): Promise<{
    deleted: string[]
    failed: Array<{ id: string; message: string }>
  }> {
    const deleted: string[] = []
    const failed: Array<{ id: string; message: string }> = []
    // De-duplicate while preserving order; the inFlight map keeps two concurrent
    // requests for one id from double-deleting it, because both see the same
    // settled promise.
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }
    for (const id of unique) {
      try {
        const wasDeleted = await this.delete(id)
        deleted.push(id)
        if (!wasDeleted) {
          // A registered-but-absent row still counts as reconciled; keep it in
          // `deleted` so the client stops showing it.
          await Promise.resolve()
        }
      } catch (error: unknown) {
        failed.push({ id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { deleted, failed }
  }

  private async deleteCore(id: string): Promise<boolean> {
    const persistence = this.ctx.sessionPersistence as PersistenceLike
    const headers = await this.readHeaders()
    const persistedHeader = headers.find(header => header.id === id)
    const liveSession = this.ctx.sessions.get(id)
    const header = persistedHeader ?? liveSession?.header
    if (header === undefined) {
      if (this.ctx.agents.get(id) === undefined) {
        throw new SessionDeleteNotFoundError(`session "${id}" not found`)
      }
      throw new SessionDeleteBusyError(`agent "${id}" has no matching live session`)
    }
    // A managed child can be removed directly only after its recorded parent
    // has disappeared. This makes orphan cleanup possible without allowing a
    // live parent to lose one of its children independently.
    if (header.origin === 'subagent' && hasLiveOrDurableParent(header, headers, this.ctx)) {
      throw new SessionDeleteBusyError(`session "${id}" is managed by its parent agent`)
    }
    const adapter = resolveAdapter(persistence)
    const rootHadLive = liveSession !== undefined || this.ctx.agents.get(id) !== undefined

    // Stop the root before taking the cascade snapshot. A live parent is the
    // only component that can admit new managed children during this request.
    await this.stopLiveAgent(id)
    const cascade = await this.stabilizeCascade(id, headers)
    const durableHeaders = await persistence.list()
    const durableIds = new Set(durableHeaders.map(candidate => candidate.id))
    const targets = [...cascade.ids, id]
      .map(targetId => ({
        id: targetId,
        header: cascade.headers.get(targetId),
        durable: durableIds.has(targetId),
        live: cascade.liveIds.has(targetId) || (targetId === id && rootHadLive),
      }))
      .filter((target): target is DeleteTarget => target.header !== undefined)
    // Preflight every child before the first irreversible erase. This catches
    // known busy/reserved states up front and keeps the parent and siblings
    // intact when the request is rejected.
    await this.preflightDeletes(adapter, targets)
    return eraseDurablePlan(adapter, this.ctx, targets)
  }

  private async readHeaders(): Promise<SessionHeaderLike[]> {
    const headers: SessionHeaderLike[] = await (this.ctx.sessionPersistence as PersistenceLike).list()
    const byId = new Map(headers.map(header => [header.id, header]))
    for (const session of this.ctx.sessions.list?.() ?? []) {
      if (!byId.has(session.id)) byId.set(session.id, session.header)
    }
    return [...byId.values()]
  }

  private async preflightDeletes(adapter: DeleteAdapter, targets: readonly DeleteTarget[]): Promise<void> {
    for (const target of targets) {
      await this.stopLiveAgent(target.id)
      if (!target.durable) continue
      validateDurableDelete(adapter, target.id, target.header)
    }
  }

  /** Stop every observed descendant and repeat until the corpus is stable. */
  private async stabilizeCascade(rootId: string, seed: readonly SessionHeaderLike[]): Promise<CascadeSnapshot> {
    const known = new Map(seed.map(header => [header.id, header]))
    const liveIds = new Set<string>()
    const discovered = new Set<string>()
    for (let attempt = 0; attempt < MAX_CASCADE_STABILIZE_ATTEMPTS; attempt += 1) {
      const current = await this.readHeaders()
      for (const currentHeader of current) known.set(currentHeader.id, currentHeader)
      const observed = collectManagedDescendants([...known.values()], rootId)
      let added = false
      for (const child of observed) {
        if (!discovered.has(child)) {
          discovered.add(child)
          added = true
        }
        if (this.ctx.sessions.get(child) !== undefined || this.ctx.agents.get(child) !== undefined) {
          liveIds.add(child)
        }
        await this.stopLiveAgent(child)
      }
      const refreshed = await this.readHeaders()
      for (const refreshedHeader of refreshed) known.set(refreshedHeader.id, refreshedHeader)
      const stillLive = [...discovered].some(child => this.ctx.sessions.get(child) !== undefined
        || this.ctx.agents.get(child) !== undefined)
      if (!added && !stillLive) {
        const ids = collectManagedDescendants([...known.values()], rootId)
        return { ids, headers: known, liveIds }
      }
    }
    throw new SessionDeleteBusyError('managed child sessions did not reach a stable stopped state')
  }

  private async stopLiveAgent(id: string): Promise<void> {
    const agent = this.ctx.agents.get(id)
    if (agent === undefined) {
      if (this.ctx.sessions.get(id) !== undefined) {
        throw new SessionDeleteBusyError(`session "${id}" is live without an AgentLoop-owned lifecycle`)
      }
      return
    }

    if (typeof this.ctx.agentLoop.stop === 'function') {
      await this.ctx.agentLoop.stop(id)
    } else {
      const disposer = findLifecycleDisposer(this.ctx, id)
      if (disposer === undefined) {
        throw new SessionDeleteBusyError(`agent "${id}" is not owned by the rc.8 AgentLoop lifecycle`)
      }
      await Promise.resolve(disposer())
    }

    if (this.ctx.agents.get(id) !== undefined || this.ctx.sessions.get(id) !== undefined) {
      throw new SessionDeleteBusyError(`agent "${id}" did not leave the live registries`)
    }
  }
}

function resolveAdapter(persistence: PersistenceLike): DeleteAdapter {
  if (typeof persistence.delete === 'function' || typeof persistence.deleteMany === 'function') {
    return { kind: 'native', persistence }
  }
  const coordinator = persistence.coordinator
  if (!isCoordinator(coordinator)) {
    throw new Error(`unsupported session persistence backend ${JSON.stringify(persistence.name ?? 'unknown')}`)
  }
  if (persistence.name === 'session-persistence-jsonl') {
    return { kind: 'jsonl', persistence, coordinator }
  }
  if (persistence.name === 'session-persistence-sqlite' && isSqliteStore(persistence.store)) {
    return { kind: 'sqlite', persistence, coordinator, store: persistence.store }
  }
  throw new Error(`unsupported session persistence backend ${JSON.stringify(persistence.name ?? 'unknown')}`)
}

function isCoordinator(value: CoordinatorInternals | undefined): value is CoordinatorInternals {
  return value !== undefined
    && typeof value.serialize === 'function'
    && value.retirements instanceof Map
    && value.states instanceof Map
    && value.live instanceof Map
    && typeof value.preparations?.invalidate === 'function'
}

function isSqliteStore(value: SqliteStoreInternals | undefined): value is SqliteStoreInternals {
  return value !== undefined && typeof value.open === 'function'
}

function hasLiveOrDurableParent(
  header: SessionHeaderLike,
  headers: readonly SessionHeaderLike[],
  ctx: DeleteHostContext,
): boolean {
  return header.parentSession !== undefined
    && (headers.some(candidate => candidate.id === header.parentSession)
      || ctx.sessions.get(header.parentSession) !== undefined)
}

function validateDurableDelete(
  adapter: DeleteAdapter,
  id: string,
  header: SessionHeaderLike,
): void {
  if (adapter.kind === 'native') return
  const preparationPhase = adapter.coordinator.preparations.entries?.get(id)?.phase
  if (preparationPhase !== undefined && preparationPhase !== 'ready') {
    throw new SessionDeleteBusyError(
      `session "${id}" has an unpublished ${preparationPhase} persistence preparation`,
    )
  }
  if (adapter.kind === 'jsonl') {
    validateJsonlLocation(adapter.persistence, header)
  }
}

async function eraseDurablePlan(
  adapter: DeleteAdapter,
  ctx: DeleteHostContext,
  targets: readonly DeleteTarget[],
): Promise<boolean> {
  const durable = targets.filter(target => target.durable)
  const hadLive = targets.some(target => target.live)
  if (durable.length === 0) return hadLive
  await Promise.all(durable.map(async target => {
    if (adapter.kind === 'native') return
    const retirement = adapter.coordinator.retirements.get(target.id)
    if (retirement !== undefined) await retirement
  }))

  assertPlanStopped(ctx, targets)
  if (adapter.kind === 'native') {
    let deleted = false
    if (typeof adapter.persistence.deleteMany === 'function') {
      deleted = await adapter.persistence.deleteMany(durable.map(target => target.id))
    } else {
      if (durable.length > 1) {
        throw new SessionDeleteBusyError(
          'native persistence must provide atomic deleteMany for a session cascade',
        )
      }
      if (typeof adapter.persistence.delete !== 'function') {
        throw new SessionDeleteBusyError('native persistence must provide delete(id) or deleteMany(ids)')
      }
      deleted = await adapter.persistence.delete(durable[0].id)
    }
    assertPlanStopped(ctx, targets)
    return deleted || hadLive
  }
  if (adapter.kind === 'sqlite') {
    const deleted = await adapter.coordinator.serialize(durable[0].id, async () => {
      assertPlanStopped(ctx, targets)
      for (const target of durable) adapter.coordinator.preparations.invalidate(target.id)
      const result = await deleteSqliteMany(adapter.store, durable.map(target => target.id))
      assertPlanStopped(ctx, targets)
      commitCoordinatorState(adapter.coordinator, durable)
      return result
    })
    return deleted || hadLive
  }
  const deleted = await deleteJsonlPlan(adapter, ctx, durable)
  assertPlanStopped(ctx, targets)
  return deleted || hadLive
}

function assertPlanStopped(ctx: DeleteHostContext, targets: readonly DeleteTarget[]): void {
  for (const target of targets) {
    if (ctx.sessions.get(target.id) !== undefined || ctx.agents.get(target.id) !== undefined) {
      throw new SessionDeleteBusyError(`session "${target.id}" became live while deletion was in progress`)
    }
  }
}

function commitCoordinatorState(
  coordinator: CoordinatorInternals,
  targets: readonly DeleteTarget[],
): void {
  for (const target of targets) {
    coordinator.states.delete(target.id)
    coordinator.preparations.invalidate(target.id)
  }
}

async function deleteJsonlPlan(
  adapter: Extract<DeleteAdapter, { kind: 'jsonl' }>,
  ctx: DeleteHostContext,
  targets: readonly DeleteTarget[],
): Promise<boolean> {
  const backendRoot = adapter.persistence.root
  if (typeof backendRoot !== 'string' || !isAbsolute(backendRoot)) {
    throw new Error('JSONL backend internals are incompatible with dsh-session-manager')
  }
  const trash = await mkdtemp(join(backendRoot, '.dsh-session-manager-trash-'))
  const moved: Array<{ source: string; staged: string }> = []
  try {
    for (const target of targets) {
      await adapter.coordinator.serialize(target.id, async () => {
        assertPlanStopped(ctx, [target])
        const location = validateJsonlLocation(adapter.persistence, target.header)
        const source = dirname(location.path)
        const staged = join(trash, String(moved.length))
        try {
          await rename(source, staged)
          moved.push({ source, staged })
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      })
    }
    await rm(trash, { recursive: true, force: false })
  } catch (error: unknown) {
    const restoreErrors: unknown[] = []
    for (const item of [...moved].reverse()) {
      try {
        await rename(item.staged, item.source)
      } catch (restoreError: unknown) {
        restoreErrors.push(restoreError)
      }
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError([error, ...restoreErrors], 'session deletion failed and staged data could not be fully restored')
    }
    throw error
  }
  commitCoordinatorState(adapter.coordinator, targets)
  return moved.length > 0
}

function validateJsonlLocation(
  persistence: PersistenceLike,
  header: SessionHeaderLike,
): { kind: 'jsonl'; path: string } {
  const location = persistence.locate(header)
  if (location?.kind !== 'jsonl' || !isAbsolute(location.path)) {
    throw new Error(`JSONL backend returned an invalid location for session "${header.id}"`)
  }
  const filename = basename(location.path)
  if (filename !== 'session.jsonl' && filename !== 'session.jsonl.zstd') {
    throw new Error(`refusing to remove unexpected JSONL artifact ${JSON.stringify(location.path)}`)
  }
  const ownedDirectory = dirname(location.path)
  const backendRoot = persistence.root
  if (typeof backendRoot !== 'string' || !isAbsolute(backendRoot)) {
    throw new Error('JSONL backend internals are incompatible with dsh-session-manager')
  }
  const relativeDirectory = relative(backendRoot, ownedDirectory)
  const segments = relativeDirectory.split(sep)
  if (relativeDirectory === '' || relativeDirectory === '..'
    || relativeDirectory.startsWith(`..${sep}`) || isAbsolute(relativeDirectory)
    || segments.length !== 2 || segments.some(segment => segment.length === 0)) {
    throw new Error(`refusing to remove JSONL path outside a session-owned directory: ${JSON.stringify(location.path)}`)
  }
  return { kind: 'jsonl', path: location.path }
}

async function deleteSqliteMany(store: SqliteStoreInternals, ids: readonly string[]): Promise<boolean> {
  await store.open()
  const db = store.db
  if (db === undefined || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('SQLite backend internals are incompatible with dsh-session-manager')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    let changes = 0
    for (const id of ids) changes += Number(db.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes)
    db.exec('COMMIT')
    return changes > 0
  } catch (error: unknown) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError: unknown) {
      throw new AggregateError([error, rollbackError], 'session delete and rollback both failed')
    }
    throw error
  }
}

function findLifecycleDisposer(ctx: DeleteHostContext, id: string): EffectDisposer | undefined {
  const label = `agentLoop.lifecycle(${id})`
  const fibers = new Set<FiberInternals>([ctx.root.fiber])
  for (const runtime of ctx.registry.values()) {
    for (const fiber of runtime.fibers ?? []) fibers.add(fiber)
  }
  const matches: EffectDisposer[] = []
  for (const fiber of fibers) {
    for (const disposable of fiber._disposables ?? []) {
      if (disposable[EFFECT_SYMBOL]?.label === label) matches.push(disposable)
    }
  }
  if (matches.length > 1) {
    throw new Error(`multiple AgentLoop lifecycle owners found for session "${id}"`)
  }
  return matches[0]
}
