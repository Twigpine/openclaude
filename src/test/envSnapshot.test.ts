import { describe, expect, test } from 'bun:test'
import { snapshotEnv } from './envSnapshot.js'

const KEYS = [
  'TA001_ENV_SNAPSHOT_TEST_POPULATED',
  'TA001_ENV_SNAPSHOT_TEST_EMPTY',
  'TA001_ENV_SNAPSHOT_TEST_UNDEFINED',
  'TA001_ENV_SNAPSHOT_TEST_ABSENT',
  'TA001_ENV_SNAPSHOT_TEST_UNLISTED',
] as const

function withTestEnv(run: () => void): void {
  const incoming = KEYS.map(key => [key, process.env[key]] as const)
  try {
    run()
  } finally {
    for (const [key, value] of incoming) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

describe('snapshotEnv', () => {
  test('leaves values unchanged by default and restores exact strings', () => {
    withTestEnv(() => {
      const [populated, empty, literalUndefined] = KEYS
      process.env[populated] = 'original'
      process.env[empty] = ''
      process.env[literalUndefined] = 'undefined'

      const restoreEnv = snapshotEnv([populated, empty, literalUndefined])
      expect(process.env[populated]).toBe('original')
      expect(process.env[empty]).toBe('')
      expect(process.env[literalUndefined]).toBe('undefined')

      process.env[populated] = 'changed'
      process.env[empty] = 'changed'
      delete process.env[literalUndefined]
      restoreEnv()

      expect(process.env[populated]).toBe('original')
      expect(process.env[empty]).toBe('')
      expect(process.env[literalUndefined]).toBe('undefined')
    })
  })

  test('clears only named keys and saves their values before clearing', () => {
    withTestEnv(() => {
      const [populated, empty, , , unlisted] = KEYS
      process.env[populated] = 'original'
      process.env[empty] = ''
      process.env[unlisted] = 'untouched'

      const restoreEnv = snapshotEnv([populated, empty], { clear: true })
      expect(Object.hasOwn(process.env, populated)).toBe(false)
      expect(Object.hasOwn(process.env, empty)).toBe(false)
      expect(process.env[unlisted]).toBe('untouched')

      restoreEnv()
      expect(process.env[populated]).toBe('original')
      expect(process.env[empty]).toBe('')
      expect(process.env[unlisted]).toBe('untouched')
    })
  })

  test('deletes keys that were previously absent', () => {
    withTestEnv(() => {
      const absent = KEYS[3]
      delete process.env[absent]
      const restoreEnv = snapshotEnv([absent])
      process.env[absent] = 'temporary'

      restoreEnv()
      expect(process.env[absent]).toBeUndefined()
      expect(Object.hasOwn(process.env, absent)).toBe(false)
    })
  })

  test('preserves changes to unlisted variables during restoration', () => {
    withTestEnv(() => {
      const [populated, , , , unlisted] = KEYS
      process.env[populated] = 'original'
      process.env[unlisted] = 'original unlisted'
      const restoreEnv = snapshotEnv([populated])
      process.env[populated] = 'changed'
      process.env[unlisted] = 'changed unlisted'

      restoreEnv()
      expect(process.env[populated]).toBe('original')
      expect(process.env[unlisted]).toBe('changed unlisted')
    })
  })
})
