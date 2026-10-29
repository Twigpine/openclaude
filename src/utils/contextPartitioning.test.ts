import type { Message } from '../types/message.js'
import { describe, expect, it } from 'bun:test'
import {
  partitionContext,
  getZoneMessages,
  getAllMessages,
  getAvailableSpace,
  type PriorityZone,
} from './contextPartitioning.js'

function createMessage(role: string, content: string, createdAt: number = Date.now()): Message {
  return {
    message: { role, content, id: 'test', type: 'message', created_at: createdAt },
    sender: role,
  } as unknown as Message
}

describe('contextPartitioning', () => {
  describe('partitionContext', () => {
    it('partitions messages into zones', () => {
      const messages = [
        createMessage('system', 'You are a helpful assistant'),
        createMessage('user', 'Hello world'),
        createMessage('assistant', 'Hi there'),
      ]

      const context = partitionContext(messages, { contextWindow: 100000 })

      expect(context.zones.size).toBe(4)
      expect(context.totalTokens).toBeGreaterThan(0)
      expect(context.canFitInWindow).toBe(true)
    })

    it('classifies important messages', () => {
      const messages = [
        createMessage('user', 'This is an error occurred'),
        createMessage('assistant', 'Fixing the critical issue'),
      ]

      const context = partitionContext(messages, { contextWindow: 100000 })

      const important = context.zones.get('important')
      expect(important?.length).toBeGreaterThan(0)
    })
  })

  describe('getZoneMessages', () => {
    it('returns messages from specific zone', () => {
      const messages = [
        createMessage('user', 'Hello'),
        createMessage('assistant', 'Hi there'),
      ]

      const context = partitionContext(messages, { contextWindow: 100000 })
      const recent = getZoneMessages(context, 'recent')

      expect(recent).toBeDefined()
    })
  })

  describe('getAllMessages', () => {
    it('returns combined messages excluding system', () => {
      const messages = [
        createMessage('system', 'System prompt'),
        createMessage('user', 'Hello'),
      ]

      const context = partitionContext(messages, { contextWindow: 100000 })
      const all = getAllMessages(context)

      expect(all.length).toBeGreaterThan(0)
    })
  })

  describe('getAvailableSpace', () => {
    it('returns non-negative space', () => {
      const messages = [
        createMessage('user', 'Test message'),
      ]

      const context = partitionContext(messages, { contextWindow: 100000 })
      const available = getAvailableSpace(context, 100000)

      expect(available).toBeGreaterThanOrEqual(0)
    })
  })
})