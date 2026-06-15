import { describe, expect, test } from 'bun:test'
import { normalizeMessages } from './messages.js'
import type { Message } from '../types/message.js'

describe('normalizeMessages malformed-payload hardening', () => {
  test('drops malformed assistant/user slots instead of throwing', () => {
    const messages = [
      { type: 'user', message: {} },
      { type: 'assistant' },
      { type: 'user', message: { content: null } },
      { type: 'user', message: { content: {} } },
      { type: 'assistant', message: { content: 'not-an-array' } },
      { type: 'assistant', message: { content: 5 } },
    ] as unknown as Message[]

    expect(() => normalizeMessages(messages)).not.toThrow()
    expect(normalizeMessages(messages)).toEqual([])
  })

  test('still normalizes a well-formed user string message', () => {
    const out = normalizeMessages([
      { type: 'user', message: { content: 'hello' }, uuid: 'u1' },
    ] as unknown as Message[])
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('user')
  })
})
