/**
 * Unit tests for the peer-free outline fold. This module has no @deepseek-ai
 * dependency, so these run in any clean environment (`pnpm test`) — they are
 * the only tests that do not need the dsh application closure / installed
 * @deepseek-ai peers.
 */
import { describe, expect, it } from 'vitest'
import type { HistoryEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { foldOutline } from '../src/client/session-manage-store.ts'

function entry(
  time: number,
  type: HistoryEntry['event']['type'],
  data: Record<string, unknown> = {},
): HistoryEntry {
  return { event: { type, data, time } } as HistoryEntry
}

describe('foldOutline', () => {
  it('counts turns, user and assistant messages across the window', () => {
    const events = [
      entry(1, 'turn/start'),
      entry(2, 'user/message', { text: 'hi' }),
      entry(3, 'assistant/message', { text: 'hello' }),
      entry(4, 'user/message', { text: 'again' }),
      entry(5, 'assistant/message', { text: 'world' }),
      entry(6, 'turn/start'),
    ]
    const outline = foldOutline(events)
    expect(outline.turns).toBe(2)
    expect(outline.userMessages).toBe(2)
    expect(outline.assistantMessages).toBe(2)
    expect(outline.startedAt).toBe(1)
    expect(outline.updatedAt).toBe(6)
  })

  it('tallies tool calls and sorts them most-frequent-first', () => {
    const events = [
      entry(1, 'tool/call', { name: 'bash' }),
      entry(2, 'tool/call', { name: 'read' }),
      entry(3, 'tool/call', { name: 'bash' }),
      entry(4, 'tool/call', { name: 'grep' }),
    ]
    const outline = foldOutline(events)
    // Descending by count; ties keep first-seen order (stable sort).
    expect(outline.toolCalls).toEqual([
      { name: 'bash', count: 2 },
      { name: 'read', count: 1 },
      { name: 'grep', count: 1 },
    ])
    expect(outline.toolCalls.reduce((sum, call) => sum + call.count, 0)).toBe(4)
  })

  it('skips unrecognized event types instead of failing', () => {
    const events = [entry(1, 'turn/start'), entry(2, 'some/future-event', {})]
    expect(() => foldOutline(events)).not.toThrow()
    expect(foldOutline(events).turns).toBe(1)
  })

  it('defaults the range to zero when the window has no timestamp', () => {
    const outline = foldOutline([])
    expect(outline.startedAt).toBe(0)
    expect(outline.updatedAt).toBe(0)
    expect(outline.turns).toBe(0)
    expect(outline.toolCalls).toEqual([])
  })
})
