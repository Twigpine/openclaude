import { describe, expect, it, test } from 'bun:test'
import {
  DEFAULT_COMPACT_TAIL_TURNS,
  normalizeCompactTailTurns,
  pruneByRelevance,
  getTopRelevantMessages,
  getRelevanceStats,
  hasToolCalls,
  hasErrors,
} from './relevancePruning.js'

function createMessage(role: string, content: string, createdAt: number = Date.now()): any {
  return {
    message: { role, content, id: 'test', type: 'message', created_at: createdAt },
    sender: role,
  }
}

describe('relevancePruning', () => {
  describe('pruneByRelevance', () => {
    it('prunes to target token count', () => {
      const messages = [
        createMessage('user', 'Hello world how are you', 1000),
        createMessage('assistant', 'I am doing great', 2000),
        createMessage('user', 'Can you help with python', 3000),
      ]

      const result = pruneByRelevance(messages, { targetTokens: 50 })

      expect(result.length).toBeLessThanOrEqual(messages.length)
    })

    it('preserves recent messages', () => {
      const messages = [
        createMessage('user', 'Old message', 1000),
        createMessage('user', 'Recent message', Date.now()),
      ]

      const result = pruneByRelevance(messages, { targetTokens: 100, preserveRecent: 1 })

      expect(result.length).toBeGreaterThan(0)
    })

    it('preserves message id groups together', () => {
      // Messages with same ID should be kept together
      const messages = [
        { message: { role: 'assistant', content: 'Hello', id: 'msg1', created_at: 1000 } },
        { message: { role: 'tool_result', content: 'Result', id: 'msg1', created_at: 1001 } },
        { message: { role: 'user', content: 'New request', id: 'msg2', created_at: 2000 } },
      ] as any[]

      const result = pruneByRelevance(messages, { targetTokens: 500 })

      // Either both msg1 messages are kept or neither (not partial)
      const msg1Msgs = result.filter(m => m.message?.id === 'msg1')
      // If any msg1 is kept, all should be kept
      if (msg1Msgs.length > 0) {
        expect(msg1Msgs.length).toBe(2)
      }
    })

    it('preserves API-round groups (tool_use + tool_result) together', () => {
      // Simulate tool_use + tool_result in same API round (same assistant message.id)
      const messages = [
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read' }], id: 'api-round-1', created_at: 1000 } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents' }], created_at: 1001 } },
        { type: 'assistant', message: { role: 'assistant', content: 'Response 1', id: 'api-round-2', created_at: 2000 } },
        { type: 'user', message: { role: 'user', content: 'User question', id: 'api-round-3', created_at: 3000 } },
        { type: 'assistant', message: { role: 'assistant', content: 'Response 2', id: 'api-round-4', created_at: 4000 } },
      ] as any[]

      const result = pruneByRelevance(messages, { targetTokens: 200, preserveRecent: 1 })

      const round1Msgs = result.filter(m => m.message?.id === 'api-round-1')
      const toolResultForTu1 = result.filter(m => 
        m.message?.content?.[0]?.type === 'tool_result' && m.message.content[0].tool_use_id === 'tu1'
      )

      // Both tool_use and its tool_result should be kept together or neither
      if (round1Msgs.length > 0) {
        expect(toolResultForTu1.length).toBe(1)
      }
    })
  })

  describe('hasToolCalls', () => {
    it('detects tool calls', () => {
      const msg = createMessage('assistant', 'Using tool_use to check file')
      expect(hasToolCalls(msg)).toBe(true)
    })

    it('returns false for regular content', () => {
      const msg = createMessage('user', 'Hello there')
      expect(hasToolCalls(msg)).toBe(false)
    })
  })

  describe('hasErrors', () => {
    it('detects errors', () => {
      const msg = createMessage('assistant', 'Found an error in code')
      expect(hasErrors(msg)).toBe(true)
    })

    it('returns false for normal content', () => {
      const msg = createMessage('user', 'Hello there')
      expect(hasErrors(msg)).toBe(false)
    })
  })

  describe('getTopRelevantMessages', () => {
    it('returns top N messages', () => {
      const messages = [
        createMessage('user', 'Python programming', 1000),
        createMessage('assistant', 'Python is great', 2000),
        createMessage('user', 'JavaScript here', 3000),
      ]

      const result = getTopRelevantMessages(
        messages,
        { targetTokens: 100, taskContext: 'python' },
        2
      )

      expect(result.length).toBeLessThanOrEqual(2)
    })
  })

  describe('getRelevanceStats', () => {
    it('calculates statistics', () => {
      const messages = [
        createMessage('user', 'Important about errors', 1000),
        createMessage('assistant', 'Using tool_use', 2000),
        createMessage('user', 'Regular message', 3000),
      ]

      const stats = getRelevanceStats(messages, {
        targetTokens: 100,
        preserveTools: true,
        preserveErrors: true,
      })

      expect(stats.averageScore).toBeGreaterThan(0)
      expect(stats.toolCallCount).toBeGreaterThanOrEqual(0)
    })
  })

  describe('chronological ordering', () => {
    // Production Message objects carry the chronological key on the envelope
    // `timestamp` (an ISO string), not on `message.created_at`. Build that real
    // shape here so the final "restore chronological order" sort is exercised.
    function envMessage(idx: number): any {
      return {
        type: 'user',
        uuid: `u${idx}`,
        timestamp: new Date(1_700_000_000_000 + idx * 1000).toISOString(),
        message: { role: 'user', content: `message number ${idx} content here`, id: `m${idx}` },
      }
    }

    it('returns retained messages in chronological order', () => {
      const messages = Array.from({ length: 8 }, (_, i) => envMessage(i))
      // Large target keeps every group; with preserveRecent=3 the last three
      // are sliced off first, so a broken final sort leaves them out front.
      const result = pruneByRelevance(messages, { targetTokens: 1_000_000 })
      expect(result.map(m => m.message.id)).toEqual(messages.map(m => m.message.id))
    })
  })
})
describe('normalizeCompactTailTurns', () => {
  test('valid values floor to integers', () => {
    expect(normalizeCompactTailTurns(5)).toBe(5)
    expect(normalizeCompactTailTurns(2.5)).toBe(2)
    expect(normalizeCompactTailTurns('8')).toBe(8)
    expect(normalizeCompactTailTurns(1)).toBe(1)
  })

  test('invalid or dangerous values fall back to the default', () => {
    // 0.5 previously passed a `> 0` check and floored to a ZERO-message tail.
    expect(normalizeCompactTailTurns(0.5)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(0)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(-3)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(NaN)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(Infinity)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns('abc')).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(undefined)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns(null)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    // Non-string non-number shapes must not coerce (Number(true) === 1,
    // Number([2]) === 2) into a tiny tail.
    expect(normalizeCompactTailTurns(true)).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns([2])).toBe(DEFAULT_COMPACT_TAIL_TURNS)
    expect(normalizeCompactTailTurns({})).toBe(DEFAULT_COMPACT_TAIL_TURNS)
  })
})
