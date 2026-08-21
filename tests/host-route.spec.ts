import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

function request(host: string, body: object, origin?: string) {
  const req = Readable.from([JSON.stringify(body)]) as any
  req.method = 'POST'
  req.headers = {
    host,
    'content-type': 'application/json',
    ...origin === undefined ? {} : { origin },
  }
  return req
}

function response() {
  const value = { status: 0, headers: {} as object, body: '' }
  return {
    value,
    res: {
      writeHead(status: number, headers?: object) {
        value.status = status
        value.headers = headers ?? {}
      },
      end(body?: string) { value.body = body ?? '' },
    } as any,
  }
}

function setup(ids: string[] = ['s1']) {
  let route: any
  const deleted: string[] = []
  const ctx = {
    effect: (install: () => unknown) => { install() },
    webServer: { register: (candidate: unknown) => { route = candidate; return () => {} } },
    logger: { warn: () => {} },
    root: { fiber: { _disposables: [] } },
    registry: { values: () => [] },
    sessions: { get: () => undefined },
    agents: { get: () => undefined },
    agentLoop: {},
    sessionPersistence: {
      name: 'future-native',
      list: async () => ids.map(id => ({ id })),
      locate: () => undefined,
      delete: async (id: string) => { deleted.push(id); return true },
    },
  }
  apply(ctx as any)
  return { route, deleted }
}

describe('session.delete host route', () => {
  it('accepts a same-origin loopback Connection RPC envelope', async () => {
    const { route, deleted } = setup()
    const { res, value } = response()
    await route.handler(request('127.0.0.1:8848', {
      type: 'client-request',
      rpcId: 'rpc-1',
      method: 'session.delete',
      payload: { sessionId: 's1' },
    }, 'http://127.0.0.1:8848'), res)
    expect(value.status).toBe(200)
    expect(JSON.parse(value.body)).toEqual({
      type: 'server-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { deleted: true, deletedIds: ['s1'] } },
    })
    expect(deleted).toEqual(['s1'])
  })

  it('deletes several ids from one bulk request', async () => {
    const { route, deleted } = setup(['s1', 's2'])
    const { res, value } = response()
    await route.handler(request('127.0.0.1:8848', {
      type: 'client-request',
      rpcId: 'rpc-bulk',
      method: 'session.delete',
      payload: { sessionIds: ['s1', 's2'] },
    }, 'http://127.0.0.1:8848'), res)
    expect(value.status).toBe(200)
    const body = JSON.parse(value.body)
    expect(body.type).toBe('server-response')
    expect(body.rpcId).toBe('rpc-bulk')
    expect(body.result.ok).toBe(true)
    expect(body.result.value.deleted).toBe(true)
    expect(body.result.value.deletedIds).toEqual(['s1', 's2'])
    expect(deleted).toEqual(['s1', 's2'])
  })

  it('rejects a bulk request that mixes invalid sessionIds', async () => {
    const { route, deleted } = setup()
    const { res, value } = response()
    await route.handler(request('127.0.0.1:8848', {
      type: 'client-request',
      rpcId: 'rpc-bad',
      method: 'session.delete',
      payload: { sessionIds: [] },
    }, 'http://127.0.0.1:8848'), res)
    expect(value.status).toBe(200)
    const body = JSON.parse(value.body)
    expect(body.result.ok).toBe(false)
    expect(body.result.error.code).toBe('bad-request')
    expect(deleted).toEqual([])
  })

  it('rejects non-loopback Host authorities before reading the body', async () => {
    const { route, deleted } = setup()
    const { res, value } = response()
    await route.handler(request('harness.example', {
      type: 'client-request', rpcId: 'rpc-2', method: 'session.delete', payload: { sessionId: 's1' },
    }), res)
    expect(value.status).toBe(403)
    expect(deleted).toEqual([])
  })

  it('rejects a cross-site Origin even when Host is loopback', async () => {
    const { route, deleted } = setup()
    const { res, value } = response()
    await route.handler(request('localhost:8848', {
      type: 'client-request', rpcId: 'rpc-3', method: 'session.delete', payload: { sessionId: 's1' },
    }, 'https://evil.example'), res)
    expect(value.status).toBe(403)
    expect(deleted).toEqual([])
  })
})
