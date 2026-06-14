import { describe, expect, test } from 'bun:test'
import { isNotEmptyMessage } from './messages.js'
import type { Message } from '../types/message.js'

describe('isNotEmptyMessage malformed-history hardening', () => {
  test('treats falsy / non-object slots as empty', () => {
    expect(isNotEmptyMessage(undefined as unknown as Message)).toBe(false)
    expect(isNotEmptyMessage(null as unknown as Message)).toBe(false)
    expect(isNotEmptyMessage('oops' as unknown as Message)).toBe(false)
  })

  test('does not crash on malformed user/assistant slots', () => {
    // These passed the object guard but have no message.content and used to
    // crash when it was read.
    expect(isNotEmptyMessage({ type: 'assistant' } as unknown as Message)).toBe(false)
    expect(
      isNotEmptyMessage({ type: 'user', message: {} } as unknown as Message),
    ).toBe(false)
    expect(
      isNotEmptyMessage({ type: 'user', message: { content: null } } as unknown as Message),
    ).toBe(false)
    // Non-string/non-array content (object or number) must not reach the
    // indexed reads below.
    expect(
      isNotEmptyMessage({ type: 'user', message: { content: {} } } as unknown as Message),
    ).toBe(false)
    expect(
      isNotEmptyMessage({ type: 'user', message: { content: 5 } } as unknown as Message),
    ).toBe(false)
  })

  test('still reports a non-empty string user message', () => {
    expect(
      isNotEmptyMessage({
        type: 'user',
        message: { content: 'hello' },
      } as unknown as Message),
    ).toBe(true)
  })
})
