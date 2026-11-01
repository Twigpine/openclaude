import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type CapturedSpawnSyncCall = {
  command: string
  args: string[]
  timeout?: number
}

const spawnSyncCalls: CapturedSpawnSyncCall[] = []

let spawnBehavior: 'timeout' | 'success' = 'timeout'

const spawnSyncMock = mock(
  (command: string, args: string[], options: { timeout?: number }) => {
    spawnSyncCalls.push({ command, args, timeout: options?.timeout })
    if (spawnBehavior === 'timeout') {
      return {
        error: Object.assign(new Error('spawn ETIMEDOUT'), {
          code: 'ETIMEDOUT',
        }),
        status: null,
        stdout: '',
        stderr: '',
      }
    }
    return {
      error: undefined,
      status: 0,
      stdout: '638663053464013680\n',
      stderr: '',
    }
  },
)

// The stub is injected into each fresh module instance via __test below.
// Repointing node:child_process process-wide with mock.module leaked into
// unrelated suites on CI even after an afterAll restore (bun test shares
// one module registry across files in a process; unit-tests shard 1 kept
// receiving the stub in tests/sdk/generated-types.test.ts).

// The lock identity is memoized per module instance once a lookup succeeds,
// and the platform dispatch reads process.platform at call time, so each case
// loads a fresh module instance behind a unique query string and pins the
// platform before the first settings write.
let importCounter = 0
async function loadTransactionModule() {
  importCounter += 1
  return await import(
    `./settingsFileTransaction.js?case=${importCounter}`
  )
}

const originalPlatform = process.platform

describe('settings lock process identity lookup timeouts', () => {
  afterEach(() => {
    spawnSyncCalls.length = 0
    spawnBehavior = 'timeout'
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    })
  })

  test('gives the Windows PowerShell identity lookup more than one second', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnBehavior = 'success'
    const { __test, replaceSettingsFileSync } = await loadTransactionModule()
    __test.setIdentityLookupSync(spawnSyncMock)
    const root = mkdtempSync(join(tmpdir(), 'oc-identity-timeout-'))
    try {
      writeFileSync(join(root, 'settings.json'), '{}\n')
      replaceSettingsFileSync(join(root, 'settings.json'), '{"a":1}\n')
      expect(spawnSyncCalls.length).toBeGreaterThan(0)
      const windowsLookup = spawnSyncCalls.find(
        call => call.command === 'powershell.exe',
      )
      expect(windowsLookup).toBeDefined()
      // Reported Windows lookups take 1.3-1.7s in the wild; the historical
      // 1s budget failed them with EIDENTITY before any settings write.
      expect(windowsLookup?.timeout).toBe(10_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps the non-Windows identity lookup budget at one second', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    spawnBehavior = 'success'
    const { __test, replaceSettingsFileSync } = await loadTransactionModule()
    __test.setIdentityLookupSync(spawnSyncMock)
    const root = mkdtempSync(join(tmpdir(), 'oc-identity-timeout-'))
    try {
      writeFileSync(join(root, 'settings.json'), '{}\n')
      replaceSettingsFileSync(join(root, 'settings.json'), '{"a":1}\n')
      const posixLookup = spawnSyncCalls.find(call => call.command === 'ps')
      expect(posixLookup).toBeDefined()
      expect(posixLookup?.timeout).toBe(1_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('still fails settings saves with EIDENTITY when the lookup never succeeds', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    spawnBehavior = 'timeout'
    const { __test, replaceSettingsFileSync } = await loadTransactionModule()
    __test.setIdentityLookupSync(spawnSyncMock)
    const root = mkdtempSync(join(tmpdir(), 'oc-identity-timeout-'))
    try {
      writeFileSync(join(root, 'settings.json'), '{}\n')
      expect(() =>
        replaceSettingsFileSync(join(root, 'settings.json'), '{"a":1}\n'),
      ).toThrow(/Unable to determine process identity for settings lock/)
      // Prove the EIDENTITY came from the stubbed lookup rather than a real
      // powershell.exe spawn failing with ENOENT on non-Windows hosts.
      expect(spawnSyncCalls.length).toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
