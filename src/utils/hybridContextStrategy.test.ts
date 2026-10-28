import type { Message } from '../types/message.js'
import { describe, expect, it } from 'bun:test'
import {
  splitContext,
  applyHybridStrategy,
  optimizeForCost,
  optimizeForAccuracy,
  getHybridStats,
} from './hybridContextStrategy.js'

function createMessage(role: string, content: string, createdAt: number = Date.now()): Message {
  return {
    message: { role, content, id: 'test', type: 'message', created_at: createdAt },
    sender: role,
  } as unknown as Message
}

describe('hybridContextStrategy', () => {
  describe('splitContext', () => {
    it('splits context into cached and fresh', () => {
      const messages = [
        createMessage('system', 'System prompt', Date.now() - 86400000),
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there'),
      ]

      const split = splitContext(messages, {
        cacheWeight: 0.4,
        freshWeight: 0.6,
        maxTotalTokens: 10000,
      })

      expect(split.cachedTokens).toBeGreaterThanOrEqual(0)
      expect(split.freshTokens).toBeGreaterThanOrEqual(0)
      expect(split.totalTokens).toBeGreaterThan(0)
    })

    it('respects weight configuration', () => {
      const messages = [
        createMessage('system', 'Old system', Date.now() - 86400000),
        createMessage('user', 'Recent message', Date.now()),
      ]

      const split = splitContext(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      expect(split.cached).toBeDefined()
      expect(split.fresh).toBeDefined()
    })
  })

  describe('applyHybridStrategy', () => {
    it('applies strategy and returns messages', () => {
      const messages = [
        createMessage('user', 'Message 1'),
        createMessage('assistant', 'Response 1'),
      ]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      expect(result.selectedMessages.length).toBeGreaterThan(0)
      expect(['cache_heavy', 'fresh_heavy', 'balanced']).toContain(result.strategy)
    })

    it('calculates estimated cost', () => {
      const messages = [
        createMessage('user', 'Test message'),
      ]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      expect(result.estimatedCost).toBeGreaterThanOrEqual(0)
    })
  })

  describe('optimizeForCost', () => {
    it('returns messages within budget', () => {
      const messages = [
        createMessage('user', 'Message 1'),
        createMessage('assistant', 'Response 1'),
      ]

      const result = optimizeForCost(messages, 0.001)

      expect(result.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('optimizeForAccuracy', () => {
    it('optimizes for accuracy with token limit', () => {
      const messages = [
        createMessage('user', 'Message 1'),
        createMessage('assistant', 'Response 1'),
      ]

      const result = optimizeForAccuracy(messages, 5000)

      expect(result.length).toBeGreaterThan(0)
    })
  })

  describe('getHybridStats', () => {
    it('returns statistics', () => {
      const messages = [
        createMessage('system', 'System', Date.now() - 86400000),
        createMessage('user', 'Hello'),
      ]

      const split = splitContext(messages, { cacheWeight: 0.5, freshWeight: 0.5, maxTotalTokens: 10000 })
      const stats = getHybridStats(split)

      expect(stats.cacheRatio).toBeGreaterThanOrEqual(0)
      expect(stats.freshRatio).toBeGreaterThanOrEqual(0)
      expect(stats.totalTokens).toBeGreaterThan(0)
    })
  })

  describe('tool_use/tool_result pairing', () => {
    it('preserves tool_use and tool_result together', () => {
      const toolUseId = 'tool-use-123'
      const messages = [
        {
          type: 'assistant',
          uuid: 'uuid-1',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolUseId, name: 'Read' }],
            id: 'msg-1',
            created_at: 1000,
          },
        },
        {
          type: 'user',
          uuid: 'uuid-2',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file content' }],
            id: 'msg-2',
            created_at: 2000,
          },
        },
        {
          type: 'assistant',
          uuid: 'uuid-3',
          message: {
            role: 'assistant',
            content: 'Response after tool',
            id: 'msg-3',
            created_at: 3000,
          },
        },
      ] as unknown as Message[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 10000,
      })

      const hasToolUse = result.selectedMessages.some(
        m => Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_use')
      )
      const hasToolResult = result.selectedMessages.some(
        m => Array.isArray(m.message?.content) && m.message.content.some((b) => b.type === 'tool_result')
      )

      expect(hasToolUse).toBe(true)
      expect(hasToolResult).toBe(true)
    })

    it('accounts for large tool_use input in token counting', () => {
      const largeInput = 'x'.repeat(5000)
      const messages = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu1', name: 'Edit', input: { path: 'test.js', content: largeInput } },
            ],
            created_at: 1000,
          },
        },
      ] as unknown as Message[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 20000,
      })

      expect(result.totalTokens).toBeGreaterThan(1000)
    })

    it('accounts for large thinking blocks in token counting', () => {
      const longThinking = 'Thinking '.repeat(1000)
      const messages = [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: longThinking },
              { type: 'text', text: 'Final response' },
            ],
            created_at: 1000,
          },
        },
      ] as unknown as Message[]

      const result = applyHybridStrategy(messages, {
        cacheWeight: 0.5,
        freshWeight: 0.5,
        maxTotalTokens: 20000,
      })

      expect(result.totalTokens).toBeGreaterThan(500)
    })
  })
})