/**
 * Session-management settings section: every session on this machine as rows —
 * running, idle, and archived — with resume, an outline preview, and permanent
 * deletion behind a confirmation.
 *
 * The workspace browser hides archived sessions everywhere, so this page is the
 * only surface where an archived session can still be seen, resumed, and
 * removed. The host stops a live session before deleting its durable data, and
 * the browser receives `host/session-removed` for the open conversation.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import {
  Button, IconListPenOutline16, IconTrashOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionManageState, SessionOutline } from './session-manage-store.ts'
import type { SessionManageKey } from './locales.ts'
import css from './SessionManageSection.module.css'

/** Registration-side business face for the management section. */
export interface SessionManageInjected {
  hooks: {
    /** Page snapshot bound by the renderer as useSessionManage. */
    sessionManage: SnapshotStore<SessionManageState>
  }
  /** Read the corpus; called once when the section first renders. */
  load: () => Promise<void>
  /** Switch the GUI to the given session's conversation. */
  openSession: (id: string) => void
  /** Ask for delete confirmation, or dismiss it with null. */
  confirmDelete: (id: string | null) => void
  /** Delete the session awaiting confirmation. */
  remove: () => Promise<void>
  /** Open the outline dialog for one session. */
  loadOutline: (id: string) => Promise<void>
  /** Close the outline dialog. */
  closeOutline: () => void
}

/** Full component props. */
export type SessionManageSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.dshSessionManager'>
  & InjectFace<SessionManageInjected>

/** Render the outline stats block: counts plus the tool-call breakdown. */
function OutlineStats({ outline, t }: {
  outline: SessionOutline
  t: (key: SessionManageKey) => string
}): ReactNode {
  return (
    <dl className={css.outlineStats}>
      <div className={css.outlineStat}>
        <dt>{t('outlineTurns')}</dt>
        <dd>{outline.turns}</dd>
      </div>
      <div className={css.outlineStat}>
        <dt>{t('outlineUserMessages')}</dt>
        <dd>{outline.userMessages}</dd>
      </div>
      <div className={css.outlineStat}>
        <dt>{t('outlineAssistantMessages')}</dt>
        <dd>{outline.assistantMessages}</dd>
      </div>
      <div className={css.outlineStat}>
        <dt>{t('outlineToolCalls')}</dt>
        <dd>{outline.toolCalls.reduce((sum, call) => sum + call.count, 0)}</dd>
      </div>
      {outline.toolCalls.length > 0 ? (
        <ul className={css.outlineTools}>
          {outline.toolCalls.map(call => (
            <li key={call.name}>
              <code>{call.name}</code>
              <span>{call.count}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className={css.outlineNone}>{t('outlineNoTools')}</p>
      )}
      <p className={css.outlineRange}>
        {`${t('outlineRange')} ${new Date(outline.startedAt).toLocaleString()} — ${new Date(outline.updatedAt).toLocaleString()}`}
      </p>
    </dl>
  )
}

/** Render one session row: title, badges, meta, and the resume/outline/delete actions. */
function SessionRow({
  row,
  t,
  openSession,
  loadOutline,
  confirmDelete,
  close,
  canDelete,
}: {
  row: SessionManageState['rows'][number]
  t: (key: SessionManageKey) => string
  openSession: (id: string) => void
  loadOutline: (id: string) => Promise<void>
  confirmDelete: (id: string) => void
  close: () => void
  canDelete: boolean
}): ReactNode {
  const title = row.title ?? t('noTitle')
  // A subagent/live child session is owned and deleted by its parent; the host
  // rejects a direct delete with `agent-busy`, so hide the entry rather than
  // offer an action that is guaranteed to fail.
  const deletable = canDelete
    && row.origin !== 'subagent'
    && row.parentSessionId === undefined
  const badges = [
    row.archived ? t('archived') : null,
    row.running ? t('running') : t('idle'),
    row.blank ? t('blank') : null,
    ...deletable ? [] : [t('managed')],
  ].filter((badge): badge is string => badge !== null)
  return (
    <li className={css.row}>
      <div className={css.rowBody}>
        <span className={css.rowHead}>
          <span className={`${css.dot} ${row.running ? css.dotRunning : ''}`} aria-hidden="true" />
          <span className={css.rowTitle}>{title}</span>
          {badges.map(badge => (
            <span key={badge} className={css.badge}>{badge}</span>
          ))}
        </span>
        <code className={css.rowId}>{row.sessionId}</code>
        <span className={css.rowMeta}>
          {`${t('updatedAt')} ${new Date(row.updatedAt).toLocaleString()}`}
          {row.cwd === undefined ? null : ` · ${t('cwd')} ${row.cwd}`}
        </span>
      </div>
      <div className={css.rowActions}>
        <Button
          variant="outline"
          className={css.resumeButton}
          disabled={row.running}
          onClick={() => {
            openSession(row.sessionId)
            // Leave settings: the session is now current, so the panel's modal
            // would otherwise sit over the conversation it just opened.
            close()
          }}
        >
          {row.running ? t('resuming') : t('resume')}
        </Button>
        <button
          type="button"
          className={css.iconButton}
          data-tip={t('outline')}
          aria-label={`${t('outline')}: ${title}`}
          onClick={() => { void loadOutline(row.sessionId) }}
        >
          <IconListPenOutline16 />
        </button>
        {deletable ? (
          <button
            type="button"
            className={`${css.iconButton} ${css.iconDanger}`}
            data-tip={t('delete')}
            aria-label={`${t('delete')}: ${title}`}
            onClick={() => { confirmDelete(row.sessionId) }}
          >
            <IconTrashOutline16 />
          </button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Render the Session management section content column.
 * @param props - composed slot props.
 * @returns the section.
 */
export function SessionManageSection(props: SessionManageSectionProps): ReactNode {
  const {
    useSessionManage, t, load, openSession, confirmDelete, remove, loadOutline, closeOutline, close,
  } = props
  const state = useSessionManage(snapshot => snapshot)
  const pendingRow = state.pendingDelete === null
    ? undefined
    : state.rows.find(row => row.sessionId === state.pendingDelete)
  const outlineRow = state.outline === null
    ? undefined
    : state.rows.find(row => row.sessionId === state.outline?.sessionId)
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={css.section}>
      <h2 className={css.title}>{t('nav')}</h2>
      <p className={css.intro}>{t('sectionIntro')}</p>
      {state.status === 'error' ? (
        <div className={css.errorBlock}>
          <p className={css.error} role="alert">{`${t('error')} ${state.error ?? ''}`}</p>
          <Button variant="outline" onClick={() => { void load() }}>
            {t('retry')}
          </Button>
        </div>
      ) : state.status === 'loading' ? (
        <p className={css.loading} role="status">{t('loading')}</p>
      ) : state.status === 'ready' && state.rows.length === 0 ? (
        <p className={css.empty}>{t('empty')}</p>
      ) : (
        <ul className={css.rows}>
          {state.rows.map(row => (
            <SessionRow
              key={row.sessionId}
              row={row}
              t={t}
              openSession={openSession}
              loadOutline={loadOutline}
              confirmDelete={confirmDelete}
              close={close}
              canDelete={state.canDelete}
            />
          ))}
        </ul>
      )}
      <Modal
        open={state.pendingDelete !== null}
        onClose={() => { confirmDelete(null) }}
        title={t('deleteTitle')}
        closeLabel={t('close')}
        description={t('deleteDescription')}
        className={css.deleteDialog as string}
        footer={(
          <>
            <Button
              variant="outline"
              autoFocus
              disabled={state.deleting}
              onClick={() => { confirmDelete(null) }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={css.deleteConfirm}
              disabled={state.deleting}
              onClick={() => { void remove() }}
            >
              {state.deleting ? t('deleting') : t('deleteConfirm')}
            </Button>
          </>
        )}
      >
        {pendingRow === undefined
          ? null
          : (
            <p className={css.deleteTarget}>
              {pendingRow.title ?? t('noTitle')}
              <code>{pendingRow.sessionId}</code>
            </p>
          )}
        {state.deleteError === null
          ? null
          : <p className={css.deleteError} role="alert">{state.deleteError}</p>}
        {state.canDelete
          ? null
          : <p className={css.deleteNote} role="note">{t('deleteUnavailable')}</p>}
      </Modal>
      <Modal
        open={state.outline !== null}
        onClose={closeOutline}
        title={t('outlineTitle')}
        closeLabel={t('close')}
        className={css.outlineDialog as string}
        description={t('outlineIntro')}
      >
        {state.outline === null ? null : state.outline.status === 'loading' ? (
          <p className={css.loading} role="status">{t('outlineLoading')}</p>
        ) : state.outline.status === 'error' ? (
          <p className={css.error} role="alert">{`${t('error')} ${state.outline.error ?? ''}`}</p>
        ) : state.outline.data === null ? null : (
          <>
            <p className={css.outlineTarget}>
              {outlineRow?.title ?? t('noTitle')}
              <code>{state.outline.sessionId}</code>
            </p>
            <OutlineStats outline={state.outline.data} t={t} />
          </>
        )}
      </Modal>
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Session-management section copy. */
    'settings.dshSessionManager': SessionManageKey
  }
}
