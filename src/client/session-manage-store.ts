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
   * root sessions. Preserved so the UI can avoid offering a delete on a child
   * subagent session the host refuses (`agent-busy`).
   */
  parentSessionId?: SessionId
  /** Coarse durable origin; 'subagent' rows are deleted by their parent, not here. */
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
  /** The session awaiting delete confirmation, or null. */
  pendingDelete: string | null
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

const INITIAL: SessionManageState = {
  status: 'idle',
  error: null,
  deleteError: null,
  rows: [],
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

  constructor(private readonly api: Pick<IApiClient, 'sessions' | 'workspace'>) {}

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
      ...canDelete ? {} : { pendingDelete: null, deleteError: null },
    })
  }

  /**
   * Whether the host bus exposes the session.delete RPC on this deployment. The
   * plugin pins code to some dsh versions; on an older host where the method is
   * absent the delete entry must hide rather than throw at click time.
   */
  hasDeleteCapability(): boolean {
    return typeof (this.api.sessions as Record<string, unknown>).delete === 'function'
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

  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete(sessionId: string | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: sessionId, deleteError: null })
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
   * Delete the session awaiting confirmation and re-read the corpus. A live
   * session is stopped and detached by the host before its durable data is
   * removed, so after a successful delete the row is gone everywhere.
   *
   * On failure the confirm dialog stays open and the reason is surfaced in
   * `deleteError` (agent-busy, session-not-found, loopback 403, network, or an
   * absent host method). The list load state is never collapsed by a delete
   * failure.
   * @returns once the delete settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting, canDelete } = this.store.getSnapshot()
    if (pendingDelete === null || deleting) return
    if (!canDelete) {
      this.set({ deleteError: 'Deletion is only available from a local (loopback) browser session.' })
      return
    }
    const deleteFn = (this.api.sessions as Record<string, unknown>).delete
    if (typeof deleteFn !== 'function') {
      this.set({ deleteError: 'This dsh version does not expose session deletion.' })
      return
    }
    this.set({ deleting: true, deleteError: null })
    try {
      const response = await (deleteFn as (req: { sessionId: SessionId }) => Promise<{
        result: { ok: boolean; error: { message: string }; value?: { deleted: true } }
      }>)({ sessionId: pendingDelete as SessionId })
      if (!response.result.ok) {
        this.set({ deleting: false, deleteError: response.result.error.message })
        return
      }
      this.set({ deleting: false, pendingDelete: null, deleteError: null })
      await this.load()
    } catch (error) {
      this.set({ deleting: false, deleteError: messageOf(error) })
    }
  }
}
