/**
 * Host half of dsh-session-manager.
 *
 * rc.8 does not expose session.delete, SessionPersistence.delete, or
 * AgentLoop.stop. This plugin carries those compatibility pieces itself and
 * publishes the same loopback-only RPC expected by the browser half.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  SessionDeleteBusyError,
  SessionDeleteNotFoundError,
  SessionDeleteService,
  type DeleteHostContext,
} from './session-delete.ts'

const METHOD = 'session.delete'
const PATH = `/api/${METHOD}`
const MAX_BODY_BYTES = 64 * 1024

/** Stable Cordis plugin name. */
export const name = 'dsh-session-manager'
/** Host services required by the bundled deletion implementation. */
export const inject = ['webServer', 'sessions', 'agents', 'agentLoop', 'sessionPersistence']

/** Install the loopback-only deletion endpoint. */
export function apply(ctx: Context): void {
  const host = ctx as Context & DeleteHostContext & {
    webServer: { register(route: WebRoute): () => void }
    logger: { warn(message: string): void }
  }
  const service = new SessionDeleteService(host)
  ctx.effect(() => host.webServer.register({
    kind: 'exact',
    path: PATH,
    handler: (req, res) => handleDeleteRequest(host, service, req, res),
  }), 'dsh-session-manager: loopback session.delete route')
}

async function handleDeleteRequest(
  ctx: Context & { logger: { warn(message: string): void } },
  service: SessionDeleteService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!isTrustedLoopbackRequest(req)) {
    sendText(res, 403, 'forbidden')
    return
  }
  if (req.method !== 'POST') {
    sendText(res, 404, 'not found')
    return
  }
  const mediaType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (mediaType !== 'application/json') {
    sendText(res, 415, 'content type must be application/json')
    return
  }

  let body: unknown
  try {
    body = JSON.parse(await readBody(req, MAX_BODY_BYTES)) as unknown
  } catch (error: unknown) {
    const status = error instanceof RequestTooLargeError ? 413 : 400
    sendText(res, status, status === 413 ? 'request body too large' : 'body is not JSON')
    if (status === 413) req.destroy()
    return
  }

  const parsed = parseDeleteEnvelope(body)
  if (!parsed.ok) {
    sendRpc(res, parsed.rpcId, rpcError('bad-request', parsed.message, { issues: [] }))
    return
  }

  // One id (the single-row action) or several ids (the bulk toolbar). Both go
  // through the same per-session lifecycle so every member is preflighted and
  // erased independently.
  const ids = parsed.sessionIds ?? [parsed.sessionId]
  if (ids.length === 1) {
    try {
      const deleted = await service.delete(ids[0])
      sendRpc(res, parsed.rpcId, { ok: true, value: { deleted, deletedIds: ids } })
    } catch (error: unknown) {
      if (error instanceof SessionDeleteNotFoundError) {
        sendRpc(res, parsed.rpcId, rpcError('session-not-found', error.message, { sessionId: ids[0] }))
        return
      }
      if (error instanceof SessionDeleteBusyError) {
        sendRpc(res, parsed.rpcId, rpcError('agent-busy', error.message, { reason: error.message }))
        return
      }
      ctx.logger.warn(`dsh-session-manager: deletion of session "${ids[0]}" failed: ${String(error)}`)
      sendRpc(res, parsed.rpcId, rpcError('internal', error instanceof Error ? error.message : String(error), {}))
    }
    return
  }

  const outcome = await service.deleteMany(ids)
  sendRpc(res, parsed.rpcId, {
    ok: true,
    value: { deleted: outcome.deleted.length > 0, deletedIds: outcome.deleted, failed: outcome.failed },
  })
}

interface DeleteEnvelope {
  readonly type?: unknown
  readonly rpcId?: unknown
  readonly method?: unknown
  readonly payload?: unknown
}

type ParsedDeleteEnvelope =
  | { ok: true; rpcId: string; sessionId: string; sessionIds?: string[] }
  | { ok: false; rpcId: string; message: string }

function parseDeleteEnvelope(value: unknown): ParsedDeleteEnvelope {
  const envelope = value as DeleteEnvelope | null
  const rpcId = typeof envelope?.rpcId === 'string' && envelope.rpcId.length > 0
    ? envelope.rpcId
    : 'invalid-request'
  if (envelope === null || typeof envelope !== 'object'
    || envelope.type !== 'client-request' || envelope.method !== METHOD) {
    return { ok: false, rpcId, message: 'invalid client-request message' }
  }
  const payload = envelope.payload as { sessionId?: unknown; sessionIds?: unknown } | null
  if (payload === null || typeof payload !== 'object') {
    return { ok: false, rpcId, message: 'delete requires a sessionId or sessionIds payload' }
  }
  // Single id (the row action).
  if (typeof payload.sessionId === 'string' && payload.sessionId.length > 0) {
    return { ok: true, rpcId, sessionId: payload.sessionId }
  }
  // Bulk ids (the toolbar): must be a non-empty array of non-empty strings.
  if (Array.isArray(payload.sessionIds)) {
    const ids = payload.sessionIds
    if (ids.length > 0 && ids.every(id => typeof id === 'string' && id.length > 0)) {
      return { ok: true, rpcId, sessionId: ids[0], sessionIds: ids as string[] }
    }
    return { ok: false, rpcId, message: 'sessionIds must be a non-empty array of non-empty strings' }
  }
  return { ok: false, rpcId, message: 'session.delete requires a non-empty sessionId or sessionIds' }
}

function rpcError(code: string, message: string, details: object): {
  ok: false
  error: { code: string; message: string; details: object }
} {
  return { ok: false, error: { code, message, details } }
}

function sendRpc(res: ServerResponse, rpcId: string, result: object): void {
  const body = JSON.stringify({ type: 'server-response', rpcId, result })
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

class RequestTooLargeError extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBytes) throw new RequestTooLargeError()
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    size += chunk.byteLength
    if (size > maxBytes) throw new RequestTooLargeError()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** rc.8 Connection's trust checks narrowed to loopback authorities. */
function isTrustedLoopbackRequest(request: IncomingMessage): boolean {
  const host = singleHeader(request, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined || !isLoopbackHostname(hostUrl.hostname)) return false
  if (singleHeader(request, 'sec-fetch-site') === 'cross-site') return false
  const origin = singleHeader(request, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' ? value : undefined
}

function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

export { SessionDeleteBusyError, SessionDeleteNotFoundError } from './session-delete.ts'
