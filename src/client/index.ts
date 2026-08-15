/**
 * Session-management surface plugin, browser half: one settings section that
 * lists every session — running, idle, and archived — and lets the user resume
 * a conversation, preview an outline of its recent activity, or delete any of
 * them behind a confirmation.
 *
 * Archived sessions are hidden from the workspace browser everywhere, so this
 * section is the only surface where an archived session can still be seen,
 * resumed, and removed. Deletion is loopback-privileged on the host and
 * irreversible.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face into
// this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { SessionManageSection } from './SessionManageSection.tsx'
import type { SessionManageInjected } from './SessionManageSection.tsx'
import { SessionManageController } from './session-manage-store.ts'
import { en, zh } from './locales.ts'

const LOCALE_NS = 'settings.dshSessionManager'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'sessions']

/**
 * Mount the Session management settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api, isLoopback } = ctx.get('connection') as ConnectionHandle
  const controller = new SessionManageController(api)

  // Deletion is loopback-privileged on the host and new in recent dsh versions
  // (`session.delete`). On a non-loopback page, or a host that does not expose
  // the RPC, the delete entry must be hidden — not merely fail at click time.
  const deleteCapable = isLoopback && controller.hasDeleteCapability()
  controller.setCanDelete(deleteCapable)

  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-session-manager: settings section dictionaries')

  // The corpus can move while the page is open (a deletion from this page or
  // a reconnect re-baselines the list); refresh only after the page loaded, so
  // an unopened section never fetches on background invalidations. Session
  // host frames are not forwarded through `remote`, so reconnect is the one
  // external signal a settings page can rely on.
  ctx.effect(() => {
    const refresh = (): void => {
      if (controller.store.getSnapshot().status === 'idle') return
      void controller.load()
    }
    return ctx.on('connection/reset', refresh)
  }, 'dsh-session-manager: corpus refresh')

  const injected = (): SessionManageInjected => ({
    hooks: { sessionManage: controller.store },
    load: () => controller.load(),
    openSession: (id) => { ctx.sessions.open(id as SessionId) },
    confirmDelete: (id: string | null) => { controller.confirmDelete(id) },
    remove: () => controller.remove(),
    loadOutline: (id: string) => controller.loadOutline(id),
    closeOutline: () => { controller.closeOutline() },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-session-manager',
    order: 30,
    label: () => ctx.locale.bind(LOCALE_NS)('nav'),
    locale: LOCALE_NS,
    inject: injected,
  }, SessionManageSection))
}
