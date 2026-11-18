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
})
