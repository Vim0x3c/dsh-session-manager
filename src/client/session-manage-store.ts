/**
 * Session-management controller: the complete session corpus (live, cold, and
 * archived) with permanent deletion.
 *
 * The host stays the single fact source. The page reads `session.list` (which
 * serves every materialized session, archived included — the workspace browser
 * hides archived rows client-side) and `workspace.list` for the archive set, so
 * an archived row is marked without guessing. Every deletion writes through
 * the wire and the page re-reads afterwards: a live deletion stops the agent
 * and detaches the session, which also moves the row out of any other surface.
 */

import type { HistoryEntry, IApiClient, SessionId, SessionSummary } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only merge edge: the title domain's client-namespace outlet declares the
// 'title' projection key the list rows read.
import type {} from '@deepseek-ai/dsh-session-title/client'

/** One session row the page renders. */
export interface SessionRow {
  /** Shared agent/session identity; the deletion target. */
  sessionId: SessionId
  /** Latest log-backed title, or null before the first title lands. */
  title: string | null
  /** Later of creation and the latest human-authored prompt, epoch ms. */
  updatedAt: number
  /** Whether the attached agent is running a turn right now. */
  running: boolean
  /** Whether no turn has run yet. */
  blank: boolean
  /** Whether the workspace registry lists this session as archived. */
  archived: boolean
  /** Session working directory, absent when unrecorded. */
  cwd?: string
  /**
   * fork/spawn lineage (session.header.parentSession passthrough); absent for
   * root sessions. Ordinary forks remain deletable; only `origin: subagent`
   * identifies a child lifecycle managed by its parent. An origin-marked row
   * whose parent is absent from the loaded corpus is an orphan and is directly
   * deletable.
   */
  parentSessionId?: SessionId
  /**
   * Coarse durable origin; a row with `origin: subagent` and a live/durable
   * parent is removed by deleting that parent, while an orphan is standalone.
   */
  origin?: 'subagent'
}

/** Page snapshot. */
export interface SessionManageState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load failure text; a delete failure is surfaced separately. */
  error: string | null
  /**
   * Delete failure text for the session awaiting confirmation, or null. Kept
   * apart from `error` so a rejected delete never collapses the whole list view
   * into the load-error state; the confirm dialog renders it inline.
   */
  deleteError: string | null
  /** Every session on this machine, newest first. */
  rows: readonly SessionRow[]
  /**
   * Session ids the user flagged for a bulk delete (the multi-select toolbar),
   * or null when nothing is selected.
   */
  selected: ReadonlySet<string>
  /**
   * The session id(s) awaiting delete confirmation. Either one id (the row
   * trash button) or several (the multi-select toolbar). null = dialog closed.
   * Rendered as a list so a batch confirms exactly what it will remove.
   */
  pendingDelete: string[] | null
  /** Whether a delete is in flight. */
  deleting: boolean
  /**
   * Whether the current page authority is a loopback same-origin host. The
   * host pins `sessions.delete` to loopback, so a non-loopback page must not
   * offer deletion at all.
   */
  canDelete: boolean
  /** The outline dialog being previewed, or null when closed. */
  outline: SessionOutlineState | null
}

/** Outline dialog snapshot. */
export interface SessionOutlineState {
  /** The session whose history is being previewed. */
  sessionId: string
  status: 'loading' | 'ready' | 'error'
  /** Outline load failure text. */
  error: string | null
  /** Folded outline stats, present once ready. */
  data: SessionOutline | null
}

/** Folded conversation statistics for one session. */
export interface SessionOutline {
  /** Turn count (turn/start events). */
  turns: number
  /** User-role message count. */
  userMessages: number
  /** Assistant message count. */
  assistantMessages: number
  /** Tool-call counts by tool name, most frequent first. */
  toolCalls: { name: string; count: number }[]
  /** First event time, epoch ms. */
  startedAt: number
  /** Last event time, epoch ms. */
  updatedAt: number
}

/** Transport adapter for the plugin-owned session.delete endpoint. */
export type DeleteSession = (sessionIds: readonly SessionId[]) => Promise<{
  result:
    | { ok: true; value: { deleted: boolean; deletedIds?: SessionId[]; failed?: Array<{ id: string; message: string }> } }
    | { ok: false; error: { message: string } }
}>

const INITIAL: SessionManageState = {
  status: 'idle',
  error: null,
  deleteError: null,
  rows: [],
  selected: new Set(),
  pendingDelete: null,
  deleting: false,
  canDelete: true,
  outline: null,
}

/**
 * Fold a history window into an outline. The tail page carries at most
 * `maxMessages` messages, so a long session's outline reflects its recent
 * window; `startedAt`/`updatedAt` are the window's own bounds. Events the
 * fold does not recognize are skipped (they carry no surface content).
 */
export function foldOutline(entries: readonly HistoryEntry[]): SessionOutline {
  let turns = 0
  let userMessages = 0
  let assistantMessages = 0
  const toolCounts = new Map<string, number>()
  let startedAt = Number.POSITIVE_INFINITY
  let updatedAt = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    const { type, time, data } = entry.event
    if (time < startedAt) startedAt = time
    if (time > updatedAt) updatedAt = time
    if (type === 'turn/start') turns += 1
    else if (type === 'user/message') userMessages += 1
    else if (type === 'assistant/message') assistantMessages += 1
    else if (type === 'tool/call') {
      toolCounts.set(data.name, (toolCounts.get(data.name) ?? 0) + 1)
    }
  }
  const toolCalls = [...toolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
  return {
    turns,
    userMessages,
    assistantMessages,
    toolCalls,
    startedAt: startedAt === Number.POSITIVE_INFINITY ? 0 : startedAt,
    updatedAt: updatedAt === Number.NEGATIVE_INFINITY ? 0 : updatedAt,
  }
}

/** Flatten an RPC failure to display text. */
function messageOf(error: unknown): string {
  /* v8 ignore start -- the RPC layer and every fixture reject with Error
     instances; the String arm is defensive for foreign rejections. */
  return error instanceof Error ? error.message : String(error)
  /* v8 ignore stop */
}

/** Project one session.list row, merging the archive-set membership. */
function toRow(summary: SessionSummary, archived: ReadonlySet<SessionId>): SessionRow {
  return {
    sessionId: summary.sessionId,
    title: summary.projections?.values.title ?? null,
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    archived: archived.has(summary.sessionId),
    ...summary.parentSessionId === undefined ? {} : { parentSessionId: summary.parentSessionId },
    ...summary.origin === undefined ? {} : { origin: summary.origin },
    ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
  }
}

/** Whether an origin-marked row has no live/durable parent in this corpus. */
export function isOrphanSession(rows: readonly SessionRow[], row: SessionRow): boolean {
  return row.origin === 'subagent'
    && (row.parentSessionId === undefined
      || !rows.some(candidate => candidate.sessionId === row.parentSessionId))
}

/**
 * Whether a row is an independent deletion target (the multi-select toolbar
 * only offers these). Managed children are removed by deleting their parent,
 * so they are not selectable on their own; an orphaned subagent is standalone
 * and is selectable.
 */
export function isDirectlyDeletable(rows: readonly SessionRow[], row: SessionRow): boolean {
  return row.origin !== 'subagent' || isOrphanSession(rows, row)
}

/**
 * Count managed subagent descendants of one session among the loaded rows.
 * Ordinary sessions remain independent deletion targets but are traversal
 * nodes, matching Harness `listDescendants` semantics.
 */
export function countManagedDescendants(
  rows: readonly SessionRow[],
  sessionId: string,
): number {
  const childrenOf = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parentSessionId === undefined) continue
    if (row.sessionId === sessionId) continue
    const siblings = childrenOf.get(row.parentSessionId)
    if (siblings === undefined) childrenOf.set(row.parentSessionId, [row.sessionId])
    else siblings.push(row.sessionId)
  }
  const visited = new Set<string>([sessionId])
  let count = 0
  const walk = (parentId: string): void => {
    for (const child of childrenOf.get(parentId) ?? []) {
      if (visited.has(child)) continue
      visited.add(child)
      const childRow = rows.find(row => row.sessionId === child)
      if (childRow?.origin === 'subagent') count += 1
      walk(child)
    }
  }
  walk(sessionId)
  return count
}

/** Reads the corpus and drives the delete confirmation. */
export class SessionManageController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<SessionManageState> = createSnapshotStore(INITIAL)

  /**
   * Monotonic load sequence. Only the most recent load() may write the list
   * snapshot; a stale response (an earlier load settling after a newer one)
   * must be discarded, otherwise a slow list read can clobber the fresher rows.
   */
  private loadSeq = 0
  /** As above, for outline previews (consecutive dialogs must not race). */
  private outlineSeq = 0

  private readonly deleteSession: DeleteSession | undefined

  constructor(
    private readonly api: Pick<IApiClient, 'sessions' | 'workspace'>,
    deleteSession?: DeleteSession,
  ) {
    const nativeDelete = (api.sessions as Record<string, unknown>).delete
    this.deleteSession = deleteSession ?? (typeof nativeDelete === 'function'
      ? ids => (nativeDelete as (req: { sessionIds: SessionId[] }) => ReturnType<DeleteSession>)(
          { sessionIds: [...ids] },
        )
      : undefined)
  }

  private set(patch: Partial<SessionManageState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Pin the delete capability to the page authority. The host rejects a
   * non-loopback delete with a 403, so from initial render until this is
   * called the UI is right to keep deletion conservative (hidden) rather than
   * offer an action that is guaranteed to fail. Call once at boot before any
   * row is rendered.
   */
  setCanDelete(canDelete: boolean): void {
    this.set({
      canDelete,
      ...canDelete ? {} : { pendingDelete: null, deleteError: null, selected: new Set() },
    })
  }

  /**
   * Whether a delete transport was installed. Standalone installs supply the
   * plugin-owned endpoint; newer harness builds may supply the native method.
   */
  hasDeleteCapability(): boolean {
    return this.deleteSession !== undefined
  }

  /**
   * Load every session plus the archive set. An empty corpus is a valid
   * machine, not a failure — the page renders an empty state.
   *
   * Last-request-wins: concurrent loads (a reconnect racing a manual retry, or
   * a delete reload overlapping a reconnect) discard every response but the
   * most recent one, so an old list can never overwrite a newer snapshot.
   * @returns once the current request has settled (not necessarily written).
   */
  async load(): Promise<void> {
    const seq = ++this.loadSeq
    this.set({ status: 'loading', error: null })
    try {
      const [sessions, workspaces] = await Promise.all([
        this.api.sessions.list({}),
        this.api.workspace.list({}),
      ])
      if (seq !== this.loadSeq) return // superseded; drop the stale write.
      if (!sessions.result.ok) {
        this.set({ status: 'error', error: sessions.result.error.message })
        return
      }
      if (!workspaces.result.ok) {
        this.set({ status: 'error', error: workspaces.result.error.message })
        return
      }
      const archived = new Set(workspaces.result.value.archivedSessionIds)
      this.set({
        status: 'ready',
        error: null,
        rows: sessions.result.value.items.map(summary => toRow(summary, archived)),
        // Leave the confirm dialog alone: remove() clears pendingDelete after a
        // successful delete, and a reload from a reconnect or retry must not
        // interrupt a confirmation the user is mid-way through.
      })
    } catch (error) {
      if (seq !== this.loadSeq) return
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /** Ask for delete confirmation for one or several sessions, or dismiss with null. */
  confirmDelete(sessionIds: string[] | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: sessionIds, deleteError: null })
  }

  /** Toggle one row in the multi-select set. Never allows a delete while busy. */
  toggleSelect(sessionId: string): void {
    if (this.store.getSnapshot().deleting) return
    const { selected } = this.store.getSnapshot()
    const next = new Set(selected)
    if (next.has(sessionId)) next.delete(sessionId)
    else next.add(sessionId)
    this.set({ selected: next, deleteError: null })
  }

  /** Clear the multi-select set. */
  clearSelection(): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ selected: new Set(), deleteError: null })
  }

  /**
   * Select every independently-deletable session, or deselect all when the
   * whole corpus is already selected. Managed children are never selectable:
   * they are removed with their parent, so selecting them would double-count
   * the cascade.
   */
  toggleSelectAllDeletable(): void {
    if (this.store.getSnapshot().deleting) return
    const { rows, selected } = this.store.getSnapshot()
    const selectable = rows
      .filter(row => isDirectlyDeletable(rows, row))
      .map(row => row.sessionId)
    const allSelected = selectable.length > 0 && selectable.every(id => selected.has(id))
    this.set({
      selected: allSelected ? new Set() : new Set(selectable),
      deleteError: null,
    })
  }

  /** The rows currently checked for a bulk delete. */
  selectedRows(): SessionRow[] {
    const { rows, selected } = this.store.getSnapshot()
    return rows.filter(row => selected.has(row.sessionId))
  }

  /** Whether the multi-select toolbar currently has anything to act on. */
  hasSelection(): boolean {
    return this.store.getSnapshot().selected.size > 0
  }

  /**
   * Open the outline dialog for one session and fold its recent history. The
   * host serves the tail page only, so the stats describe the recent window.
   *
   * Last-request-wins across consecutive dialogs: opening A then quickly B can
   * race — a slow A response must not reopen or overwrite B, and closing the
   * dialog mid-flight must not let it pop back open.
   * @param sessionId - the session to preview.
   * @returns once the current request has settled (not necessarily written).
   */
  async loadOutline(sessionId: string): Promise<void> {
    const seq = ++this.outlineSeq
    this.set({ outline: { sessionId, status: 'loading', error: null, data: null } })
    try {
      const response = await this.api.sessions.history({ sessionId: sessionId as SessionId })
      if (seq !== this.outlineSeq) return // superseded or closed; discard.
      if (!response.result.ok) {
        this.set({
          outline: { sessionId, status: 'error', error: response.result.error.message, data: null },
        })
        return
      }
      this.set({
        outline: { sessionId, status: 'ready', error: null, data: foldOutline(response.result.value.events) },
      })
    } catch (error) {
      if (seq !== this.outlineSeq) return
      this.set({ outline: { sessionId, status: 'error', error: messageOf(error), data: null } })
    }
  }

  /** Close the outline dialog; in-flight responses for it are now discarded. */
  closeOutline(): void {
    this.outlineSeq += 1
    this.set({ outline: null })
  }

  /**
   * Delete the session(s) awaiting confirmation and re-read the corpus. A live
   * session is stopped and detached by the host before its durable data is
   * removed, so after a successful delete the row is gone everywhere.
   *
   * On failure the confirm dialog stays open and the reason is surfaced in
   * `deleteError` (agent-busy, session-not-found, loopback 403, network, or an
   * absent host method). The list load state is never collapsed by a delete
   * failure. A bulk delete removes each selected session independently, so a
   * partial failure still deletes the ones that could be removed and reports
   * the rest via `deleteError`.
   * @returns once the delete(s) settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting, canDelete } = this.store.getSnapshot()
    if (pendingDelete === null || pendingDelete.length === 0 || deleting) return
    if (!canDelete) {
      this.set({ deleteError: 'Deletion is only available from a local (loopback) browser session.' })
      return
    }
    if (this.deleteSession === undefined) {
      this.set({ deleteError: 'The session deletion endpoint is not available.' })
      return
    }
    this.set({ deleting: true, deleteError: null })
    try {
      const response = await this.deleteSession(pendingDelete as SessionId[])
      if (!response.result.ok) {
        this.set({ deleting: false, deleteError: response.result.error.message })
        return
      }
      const failed = response.result.value.failed ?? []
      const remaining = failed.length === 0
        ? null
        : pendingDelete.filter(id => failed.some(failure => failure.id === id))
      this.set({
        deleting: false,
        // Keep the dialog open only if something could not be removed, listing
        // those ids so the user can retry just them once the cause is fixed.
        pendingDelete: remaining,
        deleteError: failed.length === 0
          ? null
          : `${failed.length} session(s) could not be deleted: ${failed.map(f => f.message).join('; ')}`,
        selected: new Set(),
      })
      await this.load()
    } catch (error) {
      this.set({ deleting: false, deleteError: messageOf(error) })
    }
  }
}
