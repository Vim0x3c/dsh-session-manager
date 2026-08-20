/** rc.8 host compatibility implementation for permanent session deletion. */

import type { Context } from '@deepseek-ai/cordis'
import { rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'

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
  readonly sessions: { get(id: string): SessionLike | undefined }
  readonly agents: { get(id: string): AgentLike | undefined }
  readonly agentLoop: AgentLoopLike
  readonly sessionPersistence: PersistenceLike
}

/** Requested identity does not exist either live or durably. */
export class SessionDeleteNotFoundError extends Error {}
/** Requested identity is owned by another lifecycle or raced back to live. */
export class SessionDeleteBusyError extends Error {}

type DeleteAdapter =
  | { kind: 'native'; persistence: PersistenceLike }
  | { kind: 'jsonl'; persistence: PersistenceLike; coordinator: CoordinatorInternals }
  | { kind: 'sqlite'; persistence: PersistenceLike; coordinator: CoordinatorInternals; store: SqliteStoreInternals }

const EFFECT_SYMBOL = Symbol.for('cordis.effect')
const MAX_LIVE_RACE_RETRIES = 3

/** Stop a live lifecycle and erase the matching durable artifact. */
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

  private async deleteCore(id: string): Promise<boolean> {
    const persistence = this.ctx.sessionPersistence
    const headers = await persistence.list()
    const persistedHeader = headers.find(header => header.id === id)
    const liveSession = this.ctx.sessions.get(id)
    const header = persistedHeader ?? liveSession?.header
    if (header === undefined) {
      if (this.ctx.agents.get(id) === undefined) {
        throw new SessionDeleteNotFoundError(`session "${id}" not found`)
      }
      throw new SessionDeleteBusyError(`agent "${id}" has no matching live session`)
    }
    if (header?.origin === 'subagent') {
      throw new SessionDeleteBusyError(`session "${id}" is managed by its parent agent`)
    }
    const adapter = resolveAdapter(persistence)

    const hadLive = liveSession !== undefined || this.ctx.agents.get(id) !== undefined
    for (let attempt = 0; attempt < MAX_LIVE_RACE_RETRIES; attempt += 1) {
      const attemptLiveHeader = this.ctx.sessions.get(id)?.header
      await this.stopLiveAgent(id)
      try {
        const erased = await eraseDurable(adapter, this.ctx, id, attemptLiveHeader ?? header)
        return hadLive || erased
      } catch (error: unknown) {
        if (!(error instanceof SessionBecameLiveError)) throw error
      }
    }
    throw new SessionDeleteBusyError(`session "${id}" became live while deletion was in progress`)
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

class SessionBecameLiveError extends Error {}

function resolveAdapter(persistence: PersistenceLike): DeleteAdapter {
  if (typeof persistence.delete === 'function') return { kind: 'native', persistence }
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

async function eraseDurable(
  adapter: DeleteAdapter,
  ctx: DeleteHostContext,
  id: string,
  header: SessionHeaderLike,
): Promise<boolean> {
  if (adapter.kind === 'native') return adapter.persistence.delete!(id)
  const retirement = adapter.coordinator.retirements.get(id)
  if (retirement !== undefined) await retirement
  return adapter.coordinator.serialize(id, async () => {
    if (ctx.sessions.get(id) !== undefined
      || [...adapter.coordinator.live.keys()].some(session => session.id === id)) {
      throw new SessionBecameLiveError()
    }
    const preparationPhase = adapter.coordinator.preparations.entries?.get(id)?.phase
    if (preparationPhase !== undefined && preparationPhase !== 'ready') {
      throw new SessionDeleteBusyError(
        `session "${id}" has an unpublished ${preparationPhase} persistence preparation`,
      )
    }
    adapter.coordinator.preparations.invalidate(id)
    const deleted = adapter.kind === 'jsonl'
      ? await deleteJsonl(adapter.persistence, header)
      : await deleteSqlite(adapter.store, id)
    if (ctx.sessions.get(id) !== undefined
      || [...adapter.coordinator.live.keys()].some(session => session.id === id)) {
      throw new SessionBecameLiveError()
    }
    adapter.coordinator.states.delete(id)
    adapter.coordinator.preparations.invalidate(id)
    return deleted
  })
}

async function deleteJsonl(persistence: PersistenceLike, header: SessionHeaderLike): Promise<boolean> {
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
  try {
    await rm(ownedDirectory, { recursive: true, force: false })
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function deleteSqlite(store: SqliteStoreInternals, id: string): Promise<boolean> {
  await store.open()
  const db = store.db
  if (db === undefined || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new Error('SQLite backend internals are incompatible with dsh-session-manager')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    db.exec('COMMIT')
    return Number(result.changes) > 0
  } catch (error: unknown) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError: unknown) {
      throw new AggregateError([error, rollbackError], `session "${id}" delete and rollback both failed`)
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
