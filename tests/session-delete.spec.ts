import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SessionDeleteBusyError,
  SessionDeleteNotFoundError,
  SessionDeleteService,
} from '../src/session-delete.ts'

const EFFECT = Symbol.for('cordis.effect')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function coordinator(id: string) {
  const invalidated: string[] = []
  return {
    invalidated,
    states: new Map([[id, { cursor: 1 }]]),
    live: new Map(),
    retirements: new Map(),
    preparations: {
      entries: new Map<string, { phase: string }>(),
      invalidate: (target: string) => { invalidated.push(target) },
    },
    serialize: async (_target: string, op: () => unknown) => op(),
  }
}

function host(options: {
  sessions?: Map<string, any>
  agents?: Map<string, any>
  persistence: any
  disposables?: Array<(() => void | Promise<void>) & { [EFFECT]?: { label: string } }>
  agentLoop?: { stop?: (id: string) => Promise<boolean> }
}) {
  const sessions = options.sessions ?? new Map()
  const agents = options.agents ?? new Map()
  return {
    root: { fiber: { _disposables: options.disposables ?? [] } },
    registry: { values: () => [] },
    sessions: { get: (id: string) => sessions.get(id) },
    agents: { get: (id: string) => agents.get(id) },
    agentLoop: options.agentLoop ?? {},
    sessionPersistence: options.persistence,
  } as any
}

describe('SessionDeleteService', () => {
  it('removes the complete JSONL-owned session directory and coordinator state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-manager-'))
    temporaryRoots.push(root)
    const owned = join(root, 'project', 'session-id')
    const log = join(owned, 'session.jsonl.zstd')
    await mkdir(owned, { recursive: true })
    await writeFile(log, 'fixture')
    await writeFile(join(owned, 'snapshot.fixture'), 'snapshot')

    const state = coordinator('session-id')
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'session-persistence-jsonl',
        root,
        coordinator: state,
        list: async () => [{ id: 'session-id', cwd: '/project' }],
        locate: () => ({ kind: 'jsonl', path: log }),
      },
    }))

    await expect(service.delete('session-id')).resolves.toBe(true)
    await expect(access(owned)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.states.has('session-id')).toBe(false)
    expect(state.invalidated).toEqual(['session-id', 'session-id'])
  })

  it('runs the exact rc.8 AgentLoop lifecycle disposer before erasing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-manager-live-'))
    temporaryRoots.push(root)
    const owned = join(root, 'project', 'live')
    const log = join(owned, 'session.jsonl')
    await mkdir(owned, { recursive: true })
    await writeFile(log, 'fixture')

    const sessions = new Map([['live', { id: 'live', header: { id: 'live' } }]])
    const agents = new Map([['live', { id: 'live' }]])
    let disposed = false
    const lifecycle = Object.assign(async () => {
      disposed = true
      agents.delete('live')
      sessions.delete('live')
    }, { [EFFECT]: { label: 'agentLoop.lifecycle(live)' } })
    const state = coordinator('live')
    const service = new SessionDeleteService(host({
      sessions,
      agents,
      disposables: [lifecycle],
      persistence: {
        name: 'session-persistence-jsonl',
        root,
        coordinator: state,
        list: async () => [{ id: 'live' }],
        locate: () => ({ kind: 'jsonl', path: log }),
      },
    }))

    await expect(service.delete('live')).resolves.toBe(true)
    expect(disposed).toBe(true)
    expect(sessions.has('live')).toBe(false)
    expect(agents.has('live')).toBe(false)
    await expect(access(owned)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deletes SQLite through the live backend connection in one transaction', async () => {
    const statements: string[] = []
    const state = coordinator('sqlite-id')
    const store = {
      open: async () => {},
      db: {
        exec: (sql: string) => { statements.push(sql) },
        prepare: (sql: string) => ({
          run: (id: unknown) => {
            statements.push(`${sql}:${String(id)}`)
            return { changes: 1 }
          },
        }),
      },
    }
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'session-persistence-sqlite',
        coordinator: state,
        store,
        list: async () => [{ id: 'sqlite-id' }],
        locate: () => undefined,
      },
    }))

    await expect(service.delete('sqlite-id')).resolves.toBe(true)
    expect(statements).toEqual([
      'BEGIN IMMEDIATE',
      'DELETE FROM sessions WHERE id = ?:sqlite-id',
      'COMMIT',
    ])
    expect(state.states.has('sqlite-id')).toBe(false)
  })

  it('refuses deletion while an unpublished resume owns the persistence preparation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-session-manager-reserved-'))
    temporaryRoots.push(root)
    const owned = join(root, 'project', 'reserved')
    const log = join(owned, 'session.jsonl')
    await mkdir(owned, { recursive: true })
    await writeFile(log, 'fixture')
    const state = coordinator('reserved')
    state.preparations.entries.set('reserved', { phase: 'reserved' })
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'session-persistence-jsonl',
        root,
        coordinator: state,
        list: async () => [{ id: 'reserved' }],
        locate: () => ({ kind: 'jsonl', path: log }),
      },
    }))

    await expect(service.delete('reserved')).rejects.toBeInstanceOf(SessionDeleteBusyError)
    await expect(access(log)).resolves.toBeUndefined()
  })

  it('refuses direct deletion of a child session', async () => {
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'session-persistence-jsonl',
        coordinator: coordinator('child'),
        list: async () => [{ id: 'child', parentSession: 'parent', origin: 'subagent' }],
        locate: () => ({ kind: 'jsonl', path: '/tmp/session.jsonl' }),
      },
    }))
    await expect(service.delete('child')).rejects.toBeInstanceOf(SessionDeleteBusyError)
  })

  it('reports a missing identity without touching storage', async () => {
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'session-persistence-jsonl',
        coordinator: coordinator('missing'),
        list: async () => [],
        locate: () => undefined,
      },
    }))
    await expect(service.delete('missing')).rejects.toBeInstanceOf(SessionDeleteNotFoundError)
  })

  it('coalesces simultaneous deletes for one identity', async () => {
    let calls = 0
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const service = new SessionDeleteService(host({
      persistence: {
        name: 'future-native',
        list: async () => [{ id: 'same' }],
        locate: () => undefined,
        delete: async () => {
          calls += 1
          await barrier
          return true
        },
      },
    }))
    const first = service.delete('same')
    const second = service.delete('same')
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
    expect(calls).toBe(1)
  })
})
