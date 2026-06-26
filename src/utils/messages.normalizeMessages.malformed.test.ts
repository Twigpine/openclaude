import { describe, expect, test } from 'bun:test'
import { normalizeMessages } from './messages.js'
import type { Message } from '../types/message.js'

describe('normalizeMessages malformed-payload hardening', () => {
  test('drops malformed assistant/user slots instead of throwing', () => {
    const messages = [
      // Falsy top-level slots must be dropped, not throw.
      null,
      undefined,
      // Unknown message type must be dropped.
      { type: 'totally-bogus', message: { content: 'x' } },
      { type: 'user', message: {} },
      { type: 'assistant' },
      { type: 'user', message: { content: null } },
      { type: 'user', message: { content: {} } },
      { type: 'assistant', message: { content: 'not-an-array' } },
      { type: 'assistant', message: { content: 5 } },
      // Array containers with malformed elements must be dropped too.
      { type: 'assistant', message: { content: [null] } },
      { type: 'user', message: { content: ['just-a-string'] } },
      { type: 'assistant', message: { content: [{ foo: 'bar' }] } },
      { type: 'assistant', message: { content: [{ type: 'text' }] } },
    ] as unknown as Message[]

    expect(() => normalizeMessages(messages)).not.toThrow()
    expect(normalizeMessages(messages)).toEqual([])
  })

  test('still normalizes a well-formed user string message', () => {
    const out = normalizeMessages([
      { type: 'user', message: { content: 'hello' }, uuid: 'u1' },
    ] as unknown as Message[])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'user',
      uuid: 'u1',
      message: { content: [{ type: 'text', text: 'hello' }] },
    })
  })

  test('keeps a well-formed assistant block message', () => {
    const out = normalizeMessages([
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-01-01T00:00:00Z',
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    ] as unknown as Message[])
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('assistant')
    expect((out[0] as { message: { content: unknown[] } }).message.content).toEqual([
      { type: 'text', text: 'hi' },
    ])
  })
})
