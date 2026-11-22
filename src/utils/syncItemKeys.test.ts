import { describe, expect, test } from 'bun:test'
import { syncItemKeys } from './syncItemKeys.js'

type M = { k: string }
const key = (m: M) => m.k
const off = { itemKeyChanged: false, rekeyOnChange: false }

describe('syncItemKeys', () => {
  test('appends keys for new tail messages', () => {
    const a = { k: 'a' }
    const b = { k: 'b' }
    expect(syncItemKeys(['a'], [a], [a, b], key, off)).toEqual(['a', 'b'])
  })

  test('a same-length in-place replacement keeps the stale key without rekeyOnChange', () => {
    const p = { k: 'p' }
    expect(syncItemKeys(['p', 'answer'], [p, { k: 'answer' }], [p, { k: 'summary' }], key, off)).toEqual(['p', 'answer'])
  })

  test('rekeyOnChange rebuilds on a same-length replacement', () => {
    const p = { k: 'p' }
    expect(
      syncItemKeys(['p', 'answer'], [p, { k: 'answer' }], [p, { k: 'summary' }], key, {
        itemKeyChanged: false,
        rekeyOnChange: true,
      }),
    ).toEqual(['p', 'summary'])
  })

  test('rekeyOnChange keeps the cached keys when the array is unchanged', () => {
    const msgs = [{ k: 'p' }]
    const keys = ['p']
    expect(
      syncItemKeys(keys, msgs, msgs, key, { itemKeyChanged: false, rekeyOnChange: true }),
    ).toBe(keys)
  })

  test('shrinking rebuilds', () => {
    const a = { k: 'a' }
    expect(syncItemKeys(['a', 'b'], [a, { k: 'b' }], [a], key, off)).toEqual(['a'])
  })

  test('rebuilds on the render that turns rekeyOnChange off', () => {
    const p = { k: 'p' }
    const f = { k: 'final' }
    const focused = [p, { k: 'summary' }, f]
    const full = [p, { k: 'tool_use' }, { k: 'tool_result' }, f]
    const focusedKeys = syncItemKeys([], [p], focused, key, {
      itemKeyChanged: false,
      rekeyOnChange: true,
    })
    expect(focusedKeys).toEqual(['p', 'summary', 'final'])
    expect(
      syncItemKeys(focusedKeys, focused, full, key, {
        itemKeyChanged: false,
        rekeyOnChange: false,
        wasRekeyOnChange: true,
      }),
    ).toEqual(['p', 'tool_use', 'tool_result', 'final'])
  })

  test('appends again once the focus-off render has rebuilt', () => {
    const p = { k: 'p' }
    const a = { k: 'a' }
    const b = { k: 'b' }
    expect(
      syncItemKeys(['p', 'a'], [p, a], [p, a, b], key, {
        itemKeyChanged: false,
        rekeyOnChange: false,
        wasRekeyOnChange: false,
      }),
    ).toEqual(['p', 'a', 'b'])
  })
})
