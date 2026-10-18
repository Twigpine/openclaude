import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

type StorageData = Record<string, unknown>

const originalEnv = { ...process.env }
const originalArgv = [...process.argv]
let storageData: StorageData = {}
let readAsync: () => Promise<StorageData | null> = async () => storageData

const credential = {
  accessToken: 'xai-access-token',
  refreshToken: 'xai-refresh-token',
  tokenEndpoint: 'https://auth.x.ai/oauth/token',
}

async function importFreshXaiCredentials() {
  mock.module('./secureStorage/index.js', () => ({
    getSecureStorage: () => ({
      name: 'mock-secure-storage',
      read: () => storageData,
      readAsync,
      update: (next: StorageData) => {
        storageData = next
        return { success: true }
      },
      delete: () => {
        storageData = {}
        return true
      },
    }),
  }))

  return import(`./xaiCredentials.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/xaiCredentials.test.ts')
  process.env = { ...originalEnv }
  delete process.env.CLAUDE_CODE_SIMPLE
  process.argv = originalArgv.filter(arg => arg !== '--bare')
  storageData = {}
  readAsync = async () => storageData
})

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    process.argv = [...originalArgv]
    storageData = {}
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

test('retries a failed xAI credential read instead of caching not-logged-in', async () => {
  let readCount = 0
  readAsync = async () => {
    readCount++
    return readCount === 1 ? null : { xai: credential }
  }
  const { readXaiCredentialsAsync } = await importFreshXaiCredentials()

  expect(await readXaiCredentialsAsync()).toBeUndefined()
  expect(await readXaiCredentialsAsync()).toEqual(credential)
  expect(readCount).toBe(2)
})

test('does not let a stale async credential read overwrite an in-process login', async () => {
  let resolveRead: ((data: StorageData | null) => void) | undefined
  readAsync = () =>
    new Promise(resolve => {
      resolveRead = resolve
    })
  const {
    getCachedXaiCredentials,
    readXaiCredentialsAsync,
    saveXaiCredentials,
  } = await importFreshXaiCredentials()
  const staleCredential = {
    ...credential,
    accessToken: 'stale-access-token',
  }
  const freshCredential = {
    ...credential,
    accessToken: 'fresh-access-token',
  }

  const pendingRead = readXaiCredentialsAsync()
  expect(saveXaiCredentials(freshCredential).success).toBe(true)
  resolveRead?.({ xai: staleCredential })

  expect(await pendingRead).toMatchObject(freshCredential)
  expect(getCachedXaiCredentials()).toMatchObject(freshCredential)
})
