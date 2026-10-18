import { expect, test } from 'bun:test'
import { CredentialPool, firstUsableCredential, hasInvalidCredentialPlaceholder, hasUsableOpenAICredential, parseCredentialList } from './credentialPool.js'

test('parseCredentialList trims comma-separated keys', () => {
  expect(parseCredentialList(' key-a, key-b ,,key-c ')).toEqual([
    'key-a',
    'key-b',
    'key-c',
  ])
})

test('firstUsableCredential rejects pools containing placeholder credentials', () => {
  expect(firstUsableCredential('key-a,key-b')).toBe('key-a')
  expect(firstUsableCredential('key-a,SUA_CHAVE')).toBeUndefined()
  expect(hasInvalidCredentialPlaceholder('key-a,SUA_CHAVE')).toBe(true)
  expect(hasInvalidCredentialPlaceholder('null')).toBe(true)
  expect(hasInvalidCredentialPlaceholder('undefined')).toBe(true)
  expect(hasInvalidCredentialPlaceholder(' NULL ')).toBe(true)
  expect(hasUsableOpenAICredential('null')).toBe(false)
  expect(hasUsableOpenAICredential('sua_chave')).toBe(false)
  expect(hasUsableOpenAICredential('apismart-key')).toBe(true)
})
test('CredentialPool rotates through healthy credentials', () => {
  const pool = new CredentialPool(['key-a', 'key-b'])

  expect(pool.next()?.value).toBe('key-a')
  expect(pool.next()?.value).toBe('key-b')
  expect(pool.next()?.value).toBe('key-a')
})

test('CredentialPool permanently skips auth-failed credentials', () => {
  const pool = new CredentialPool(['key-a', 'key-b'])
  const first = pool.next()

  pool.reportFailure(first, 'auth', 30_000)

  expect(pool.next()?.value).toBe('key-b')
  expect(pool.next()?.value).toBe('key-b')
})

test('CredentialPool cools down recoverable failures', () => {
  let now = 1_000
  const pool = new CredentialPool(['key-a', 'key-b'], () => now)
  const first = pool.next()

  pool.reportFailure(first, 'cooldown', 30_000)

  expect(pool.next()?.value).toBe('key-b')

  now += 30_001
  expect(pool.next()?.value).toBe('key-a')
})

test('CredentialPool does not let an older success clear a newer cooldown', () => {
  const pool = new CredentialPool(['key-a', 'key-b'])
  const firstA = pool.next()
  const keyB = pool.next()

  pool.reportFailure(keyB, 'auth', 0)
  const concurrentA = pool.next()
  pool.reportFailure(concurrentA, 'cooldown', 30_000)
  pool.reportSuccess(firstA)

  expect(pool.hasAvailableCredential()).toBe(false)
})

test('CredentialPool lets a stale auth failure permanently disable a cooled key', () => {
  let now = 1_000
  const pool = new CredentialPool(['key-a', 'key-b'], () => now)
  const firstA = pool.next()
  const keyB = pool.next()

  pool.reportFailure(keyB, 'auth', 0)
  const concurrentA = pool.next()
  pool.reportFailure(concurrentA, 'cooldown', 30_000)
  pool.reportFailure(firstA, 'auth', 0)

  now += 30_001
  expect(pool.hasAvailableCredential()).toBe(false)
})

test('CredentialPool falls back to least-recently failed credential when all are cooling down', () => {
  let now = 1_000
  const pool = new CredentialPool(['key-a', 'key-b'], () => now)
  const first = pool.next()

  pool.reportFailure(first, 'cooldown', 30_000)

  now += 1_000
  const second = pool.next()
  pool.reportFailure(second, 'cooldown', 30_000)

  expect(pool.next()).toEqual({ value: 'key-a', index: 0, generation: 1 })
})
