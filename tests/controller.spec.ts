/**
 * Controller behavior tests: list load, delete success/failure surfacing, and
 * the last-request-wins load/outline racing. These import the controller, whose
 * runtime store dependency is aliased to a local stub (see vitest.config.ts),
 * so they run in a clean environment without @deepseek-ai peers.
 */
import { describe, expect, it } from 'vitest'
import {
  SessionManageController, foldOutline,
} from '../src/client/session-manage-store.ts'

interface FakeSession { sessionId: string; updatedAt: number; running: boolean; blank: boolean; parentSessionId?: string }

function session(row: Partial<FakeSession> & { sessionId: string }): FakeSession {
  return { running: false, blank: false, updatedAt: 1, ...row }
}

/** Build a controller over a stub api with controllable RPC latencies. */
function makeController(options: {
  sessions?: FakeSession[]
  archived?: string[]
  deleteResult?: { ok: boolean; error?: { message: string }; value?: { deleted: true } }
  listDelayMs?: number
  historyDelayMs?: number
  historyValue?: { events: { type: string; data: Record<string, unknown>; time: number }[] }
  deleteFn?: (req: { sessionId: string }) => Promise<unknown>
}) {
  const sessions = options.sessions ?? []
  const archived = options.archived ?? []
  const deleteResult = options.deleteResult ?? { ok: true, value: { deleted: true } }
  const listDelayMs = options.listDelayMs ?? 0
  const historyValue = options.historyValue ?? { events: [] }

  const api = {
    sessions: {
      list: async () => {
        await sleep(listDelayMs)
        return { result: { ok: true, value: { items: sessions.map(s => toSummaryLike(s)) } } }
      },
      history: async () => {
        await sleep(options.historyDelayMs ?? 0)
        return { result: { ok: true, value: historyValue } }
      },
      delete: async (req: { sessionId: string }) => {
        if (options.deleteFn) return options.deleteFn(req)
        return { result: deleteResult }
      },
    },
    workspace: {
      list: async () => ({ result: { ok: true, value: { archivedSessionIds: archived } } }),
    },
  } as any

  return { controller: new SessionManageController(api), api }
}

function toSummaryLike(s: FakeSession) {
  return {
    sessionId: s.sessionId,
    updatedAt: s.updatedAt,
    running: s.running,
    blank: s.blank,
    ...s.parentSessionId === undefined ? {} : { parentSessionId: s.parentSessionId },
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) })

describe('SessionManageController', () => {
  it('loads rows and marks archive membership', async () => {
    const { controller } = makeController({
      sessions: [session({ sessionId: 'a', updatedAt: 10 }), session({ sessionId: 'b', updatedAt: 20 })],
      archived: ['a'],
    })
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.rows.map(r => r.sessionId)).toEqual(['a', 'b'])
    expect(state.rows.find(r => r.sessionId === 'a')?.archived).toBe(true)
    expect(state.rows.find(r => r.sessionId === 'b')?.archived).toBe(false)
  })

  it('surfaces a load failure in status:error', async () => {
    const api = {
      sessions: { list: async () => ({ result: { ok: false, error: { message: 'boom' } } }) },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    const controller = new SessionManageController(api)
    await controller.load()
    const state = controller.store.getSnapshot()
    expect(state.status).toBe('error')
    expect(state.error).toBe('boom')
  })

  it('keeps pendingDelete open and surfaces deleteError on a failed delete', async () => {
    const { controller } = makeController({
      sessions: [session({ sessionId: 's1' })],
      deleteResult: { ok: false, error: { message: 'agent-busy' } },
    })
    await controller.load()
    controller.confirmDelete('s1')
    expect(controller.store.getSnapshot().pendingDelete).toBe('s1')
    await controller.remove()
    const state = controller.store.getSnapshot()
    // The confirm dialog stays open so the user sees the reason.
    expect(state.pendingDelete).toBe('s1')
    expect(state.deleteError).toBe('agent-busy')
    expect(state.status).toBe('ready') // list is not collapsed by a delete failure
  })

  it('closes the dialog and reloads after a successful delete', async () => {
    const { controller } = makeController({
      sessions: [session({ sessionId: 's1' })],
      deleteResult: { ok: true, value: { deleted: true } },
    })
    await controller.load()
    controller.confirmDelete('s1')
    await controller.remove()
    const state = controller.store.getSnapshot()
    expect(state.pendingDelete).toBeNull()
    expect(state.deleteError).toBeNull()
    expect(state.deleting).toBe(false)
    expect(state.status).toBe('ready')
  })

  it('does not start a delete when the page is non-loopback and explains why', async () => {
    const { controller } = makeController({ sessions: [session({ sessionId: 's1' })] })
    await controller.load()
    controller.setCanDelete(false)
    controller.confirmDelete('s1')
    await controller.remove()
    const state = controller.store.getSnapshot()
    expect(state.deleting).toBe(false)
    expect(state.deleteError).toBeTruthy()
  })

  it('reflects an absent host session.delete method in hasDeleteCapability', async () => {
    const { controller } = makeController({ sessions: [session({ sessionId: 's1' })] })
    expect(controller.hasDeleteCapability()).toBe(true)
    ;(controller as any).api.sessions.delete = undefined
    expect(controller.hasDeleteCapability()).toBe(false)
  })

  it('explains that deletion is unsupported when the host method is absent', async () => {
    const { controller } = makeController({ sessions: [session({ sessionId: 's1' })] })
    ;(controller as any).api.sessions.delete = undefined
    await controller.load()
    controller.setCanDelete(true)
    controller.confirmDelete('s1')
    await controller.remove()
    const state = controller.store.getSnapshot()
    expect(state.deleting).toBe(false)
    expect(state.deleteError).toBeTruthy()
  })

  /**
   * Last-request-wins: a slow first load must not overwrite a newer load's
   * snapshot. load() #1 (listDelay 40ms) races load() #2 (0ms); only #2 wins.
   */
  it('discards a stale list response (last-request-wins)', async () => {
    let call = 0
    const api = {
      sessions: {
        list: async () => {
          call += 1
          const n = call
          await sleep(n === 1 ? 40 : 5)
          return { result: { ok: true, value: { items: [toSummaryLike(session({ sessionId: `call${n}` }))] } } }
        },
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
        delete: async () => ({ result: { ok: true, value: { deleted: true } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    const controller = new SessionManageController(api)
    const first = controller.load()
    const second = controller.load()
    await Promise.all([first, second])
    await sleep(60)
    const rows = controller.store.getSnapshot().rows
    expect(rows.length).toBe(1)
    expect(rows[0].sessionId).toBe('call2')
  })

  it('a slow outline for dialog A cannot overwrite dialog B', async () => {
    const api = {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async (req: { sessionId: string }) => {
          const delay = req.sessionId === 'A' ? 40 : 5
          await sleep(delay)
          return {
            result: { ok: true, value: { events: [{ event: { type: 'turn/start', data: {}, time: 1 } }] } },
          }
        },
        delete: async () => ({ result: { ok: true, value: { deleted: true } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    const controller = new SessionManageController(api)
    // Fire A (slow) then B (fast); do not await synchronously so they overlap.
    void controller.loadOutline('A')
    void controller.loadOutline('B')
    await sleep(60)
    const outline = controller.store.getSnapshot().outline
    expect(outline?.sessionId).toBe('B')
    expect(outline?.status).toBe('ready')
  })

  it('closing the outline discards an in-flight response (no reopen)', async () => {
    const api = {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => {
          await sleep(40)
          return {
            result: { ok: true, value: { events: [{ event: { type: 'turn/start', data: {}, time: 1 } }] } },
          }
        },
        delete: async () => ({ result: { ok: true, value: { deleted: true } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    const controller = new SessionManageController(api)
    void controller.loadOutline('A')
    controller.closeOutline()
    await sleep(60)
    expect(controller.store.getSnapshot().outline).toBeNull()
  })

  it('foldOutline export is intact via the controller module', () => {
    const outline = foldOutline([{ event: { type: 'turn/start', data: {}, time: 5 } } as never] as any)
    expect(outline.turns).toBe(1)
    expect(outline.startedAt).toBe(5)
  })
})
