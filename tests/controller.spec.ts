/**
 * Controller behavior tests: list load, delete success/failure surfacing, and
 * the last-request-wins load/outline racing. These import the controller, whose
 * runtime store dependency is aliased to a local stub (see vitest.config.ts),
 * so they run in a clean environment without @deepseek-ai peers.
 */
import { describe, expect, it } from 'vitest'
import {
  SessionManageController, countManagedDescendants, foldOutline, isOrphanSession,
} from '../src/client/session-manage-store.ts'
import type { SessionRow } from '../src/client/session-manage-store.ts'

interface FakeSession {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
}

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
    ...s.origin === undefined ? {} : { origin: s.origin },
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
    controller.confirmDelete(['s1'])
    expect(controller.store.getSnapshot().pendingDelete).toEqual(['s1'])
    await controller.remove()
    const state = controller.store.getSnapshot()
    // The confirm dialog stays open so the user sees the reason.
    expect(state.pendingDelete).toEqual(['s1'])
    expect(state.deleteError).toBe('agent-busy')
    expect(state.status).toBe('ready') // list is not collapsed by a delete failure
  })

  it('closes the dialog and reloads after a successful delete', async () => {
    const { controller } = makeController({
      sessions: [session({ sessionId: 's1' })],
      deleteResult: { ok: true, value: { deleted: true } },
    })
    await controller.load()
    controller.confirmDelete(['s1'])
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
    controller.confirmDelete(['s1'])
    await controller.remove()
    const state = controller.store.getSnapshot()
    expect(state.deleting).toBe(false)
    expect(state.deleteError).toBeTruthy()
  })

  it('reflects an absent host session.delete method in hasDeleteCapability', async () => {
    const { controller } = makeController({ sessions: [session({ sessionId: 's1' })] })
    expect(controller.hasDeleteCapability()).toBe(true)
    const api = {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [] } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    expect(new SessionManageController(api).hasDeleteCapability()).toBe(false)
  })

  it('explains that deletion is unsupported when the host method is absent', async () => {
    const api = {
      sessions: {
        list: async () => ({ result: { ok: true, value: { items: [toSummaryLike(session({ sessionId: 's1' }))] } } }),
        history: async () => ({ result: { ok: true, value: { events: [] } } }),
      },
      workspace: { list: async () => ({ result: { ok: true, value: { archivedSessionIds: [] } } }) },
    } as any
    const controller = new SessionManageController(api)
    await controller.load()
    controller.setCanDelete(true)
    controller.confirmDelete(['s1'])
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

describe('countManagedDescendants', () => {
  const row = (sessionId: string, extra: Partial<SessionRow> = {}): SessionRow => ({
    sessionId,
    title: null,
    updatedAt: 1,
    running: false,
    blank: false,
    archived: false,
    ...extra,
  })

  it('counts managed descendants through ordinary traversal nodes', () => {
    const rows = [
      row('root'),
      row('child', { parentSessionId: 'root', origin: 'subagent' }),
      row('grandchild', { parentSessionId: 'child', origin: 'subagent' }),
      row('fork', { parentSessionId: 'root' }),
      row('forkChild', { parentSessionId: 'fork', origin: 'subagent' }),
    ]
    expect(countManagedDescendants(rows, 'root')).toBe(3)
    expect(countManagedDescendants(rows, 'fork')).toBe(1)
    expect(countManagedDescendants(rows, 'grandchild')).toBe(0)
    expect(countManagedDescendants(rows, 'missing')).toBe(0)
  })

  it('marks a missing-parent managed row as an orphan', () => {
    const orphan = row('orphan', { parentSessionId: 'gone', origin: 'subagent' })
    const unparented = row('unparented', { origin: 'subagent' })
    const parent = row('parent')
    expect(isOrphanSession([orphan], orphan)).toBe(true)
    expect(isOrphanSession([unparented], unparented)).toBe(true)
    expect(isOrphanSession([parent, { ...orphan, parentSessionId: 'parent' }], {
      ...orphan,
      parentSessionId: 'parent',
    })).toBe(false)
  })

  it('never loops on a corrupt cyclic lineage', () => {
    const rows = [
      row('a'),
      row('b', { parentSessionId: 'a', origin: 'subagent' }),
      row('c', { parentSessionId: 'b', origin: 'subagent' }),
    ]
    // Corrupt the tail into claiming the root as its own child.
    rows[2] = { ...rows[2], parentSessionId: 'a' }
    expect(countManagedDescendants(rows, 'a')).toBe(2)
  })

  it('toggles a single row in and out of the selection set', async () => {
    const { controller } = makeController({
      sessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' })],
    })
    await controller.load()
    controller.toggleSelect('a')
    expect([...controller.store.getSnapshot().selected]).toEqual(['a'])
    controller.toggleSelect('b')
    expect([...controller.store.getSnapshot().selected]).toEqual(['a', 'b'])
    controller.toggleSelect('a')
    expect([...controller.store.getSnapshot().selected]).toEqual(['b'])
    controller.clearSelection()
    expect(controller.store.getSnapshot().selected.size).toBe(0)
  })

  it('select-all picks only independently-deletable rows, not managed children', async () => {
    const { controller } = makeController({
      sessions: [
        session({ sessionId: 'root' }),
        session({ sessionId: 'child', parentSessionId: 'root', origin: 'subagent' }),
        session({ sessionId: 'orphan', parentSessionId: 'gone', origin: 'subagent' }),
        session({ sessionId: 'fork' }),
      ],
    })
    await controller.load()
    controller.toggleSelectAllDeletable()
    const selected = [...controller.store.getSnapshot().selected]
    // root + orphan + fork are independent targets; 'child' is managed and skipped.
    expect(selected.sort()).toEqual(['fork', 'orphan', 'root'])
  })

  it('bulk delete removes every checked row and clears the selection', async () => {
    const seen: string[][] = []
    const { api } = makeController({
      sessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' }), session({ sessionId: 'c' })],
    })
    // Override the transport with one that captures the bulk payload.
    const service = new SessionManageController(api, async (ids) => {
      seen.push([...ids])
      return { result: { ok: true, value: { deleted: true, deletedIds: [...ids] } } }
    })
    await service.load()
    service.confirmDelete(['a', 'b'])
    await service.remove()
    expect(seen).toEqual([['a', 'b']])
    const state = service.store.getSnapshot()
    expect(state.pendingDelete).toBeNull()
    expect(state.selected.size).toBe(0)
  })

  it('keeps a bulk dialog open when some ids fail and reports each reason', async () => {
    const { api } = makeController({ sessions: [session({ sessionId: 'a' }), session({ sessionId: 'b' })] })
    const service = new SessionManageController(api, async () => ({
      result: { ok: true, value: {
        deleted: true,
        deletedIds: ['a'],
        failed: [{ id: 'b', message: 'nope' }],
      } },
    }))
    await service.load()
    service.confirmDelete(['a', 'b'])
    await service.remove()
    const state = service.store.getSnapshot()
    expect(state.pendingDelete).toEqual(['b'])
    expect(state.deleteError).toContain('nope')
    expect(state.selected.size).toBe(0)
  })
})
