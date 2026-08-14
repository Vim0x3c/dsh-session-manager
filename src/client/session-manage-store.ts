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
}

/** Page snapshot. */
export interface SessionManageState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Whole-load or delete failure text; the delete error stays on the page. */
  error: string | null
  /** Every session on this machine, newest first. */
  rows: readonly SessionRow[]
  /** The session awaiting delete confirmation, or null. */
  pendingDelete: string | null
  /** Whether a delete is in flight. */
  deleting: boolean
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
  rows: [],
  pendingDelete: null,
  deleting: false,
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
    ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
  }
}

/** Reads the corpus and drives the delete confirmation. */
export class SessionManageController {
  /** Page snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<SessionManageState> = createSnapshotStore(INITIAL)

  constructor(private readonly api: Pick<IApiClient, 'sessions' | 'workspace'>) {}

  private set(patch: Partial<SessionManageState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  /**
   * Load every session plus the archive set. An empty corpus is a valid
   * machine, not a failure — the page renders an empty state.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    this.set({ status: 'loading', error: null })
    try {
      const [sessions, workspaces] = await Promise.all([
        this.api.sessions.list({}),
        this.api.workspace.list({}),
      ])
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
        // A reload reflects a completed delete; close any dialog it supersedes.
        pendingDelete: null,
      })
    } catch (error) {
      this.set({ status: 'error', error: messageOf(error) })
    }
  }

  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete(sessionId: string | null): void {
    if (this.store.getSnapshot().deleting) return
    this.set({ pendingDelete: sessionId })
  }

  /**
   * Open the outline dialog for one session and fold its recent history. The
   * host serves the tail page only, so the stats describe the recent window.
   * @param sessionId - the session to preview.
   * @returns once the snapshot reflects the host or the failure.
   */
  async loadOutline(sessionId: string): Promise<void> {
    this.set({ outline: { sessionId, status: 'loading', error: null, data: null } })
    try {
      const response = await this.api.sessions.history({ sessionId: sessionId as SessionId })
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
      this.set({ outline: { sessionId, status: 'error', error: messageOf(error), data: null } })
    }
  }

  /** Close the outline dialog. */
  closeOutline(): void {
    this.set({ outline: null })
  }

  /**
   * Delete the session awaiting confirmation and re-read the corpus. A live
   * session is stopped and detached by the host before its durable data is
   * removed, so after a successful delete the row is gone everywhere.
   * @returns once the delete settled and the page reflects it.
   */
  async remove(): Promise<void> {
    const { pendingDelete, deleting } = this.store.getSnapshot()
    if (pendingDelete === null || deleting) return
    this.set({ deleting: true, error: null })
    try {
      const response = await this.api.sessions.delete({ sessionId: pendingDelete as SessionId })
      if (!response.result.ok) {
        this.set({ deleting: false, error: response.result.error.message })
        return
      }
      this.set({ deleting: false, pendingDelete: null })
      await this.load()
    } catch (error) {
      this.set({ deleting: false, error: messageOf(error) })
    }
  }
}
