import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/message.js'
import { lastTurnFailed } from './turnOutcome.js'

const prompt = (text: string) =>
  ({ type: 'user', message: { role: 'user', content: text } }) as unknown as Message
const toolResult = () =>
  ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  }) as unknown as Message
const reply = (extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', message: { role: 'assistant', content: [] }, ...extra }) as unknown as Message
const system = () => ({ type: 'system', subtype: 'turn_duration' }) as unknown as Message

describe('lastTurnFailed', () => {
  test('a turn that ends in a normal reply succeeded', () => {
    expect(lastTurnFailed([prompt('hi'), reply()])).toBe(false)
  })

  test('a local API error message fails the turn', () => {
    expect(lastTurnFailed([prompt('hi'), reply({ isApiErrorMessage: true })])).toBe(true)
  })

  test('system messages appended after the error do not hide it', () => {
    expect(
      lastTurnFailed([prompt('hi'), reply({ isApiErrorMessage: true }), system(), system()]),
    ).toBe(true)
  })

  test('a remote assistant message carrying the SDK error field fails the turn', () => {
    expect(lastTurnFailed([prompt('hi'), reply({ error: 'rate_limit' })])).toBe(true)
  })

  test('an error recovered from later in the turn does not count', () => {
    expect(
      lastTurnFailed([prompt('go'), reply({ isApiErrorMessage: true }), toolResult(), reply()]),
    ).toBe(false)
  })

  test("an earlier turn's error never leaks into a turn with no reply", () => {
    expect(lastTurnFailed([prompt('a'), reply({ isApiErrorMessage: true }), prompt('b')])).toBe(false)
  })

  test('tool results and meta messages do not end the search', () => {
    const meta = { ...(prompt('reminder') as object), isMeta: true } as Message
    expect(
      lastTurnFailed([prompt('go'), reply({ error: 'server_error' }), toolResult(), meta]),
    ).toBe(true)
  })

  test('an empty transcript has not failed', () => {
    expect(lastTurnFailed([])).toBe(false)
  })
})
