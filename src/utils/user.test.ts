import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as realExeca from 'execa'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realAuth from './auth.js'
import * as realConfig from './config.js'
import * as realEnv from './env.js'
import * as realEnvUtils from './envUtils.js'

// Snapshot each real module surface into a plain object BEFORE any
// mock.module call. `import * as` gives a live namespace: mock.module
// repoints it, so restoring with the namespace itself re-installs the mock
// rather than the real module -- permanently, since mock.module lasts for the
// life of the process. That is how this suite's stderr-less `execa` stub used
// to escape into every later suite, where `result.stderr.trim()` then threw.
const realAuthSnapshot = { ...realAuth }
const realConfigSnapshot = { ...realConfig }
const realEnvSnapshot = { ...realEnv }
const realEnvUtilsSnapshot = { ...realEnvUtils }
const realExecaSnapshot = { ...realExeca }

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

async function importFreshUserModule() {
  return import(`./user.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importActualUserTestDeps() {
  const nonce = `${Date.now()}-${Math.random()}`
  const [authModule, configModule] = await Promise.all([
    import(`./auth.js?ts=${nonce}`),
    import(`./config.js?ts=${nonce}`),
  ])

  // execa comes from the pre-mock snapshot: a plain `import('execa')` here
  // resolves to whatever mock is currently installed, so spreading it would
  // build each new stub on top of the previous one.
  return {
    authModule,
    configModule,
    execaModule: realExecaSnapshot,
  }
}

async function installCommonMocks(options?: {
  oauthEmail?: string
  gitEmail?: string
}) {
  // NOTE: Do NOT mock ../bootstrap/state.js here.
  // mock.module() is process-global in bun:test and mock.restore() does NOT
  // undo it. Mocking state.js leaks getSessionId = () => 'session-test' into
  // every other test file that imports state.js (e.g. SDK CON-1 tests).
  // The dynamic import (importFreshUserModule) will use the real state.js,
  // which is fine — these tests only assert email, not sessionId.
  const { authModule, configModule, execaModule } = await importActualUserTestDeps()

  mock.module('./auth.js', () => ({
    ...authModule,
    getOauthAccountInfo: () =>
      options?.oauthEmail
        ? {
            emailAddress: options.oauthEmail,
            organizationUuid: 'org-test',
            accountUuid: 'acct-test',
          }
        : undefined,
    getRateLimitTier: () => null,
    getSubscriptionType: () => null,
  }))

  mock.module('./config.js', () => ({
    ...configModule,
    getGlobalConfig: () => ({}),
    getOrCreateUserID: () => 'device-test',
  }))

  mock.module('./env.js', () => ({
    ...realEnvSnapshot,
    env: { platform: 'win32' },
    getHostPlatformForAnalytics: () => 'win32',
  }))

  mock.module('./envUtils.js', () => ({
    ...realEnvUtilsSnapshot,
    isEnvTruthy: (value: string | undefined) =>
      !!value && value !== '0' && value.toLowerCase() !== 'false',
  }))

  mock.module('execa', () => ({
    ...execaModule,
    execa: async () => ({
      exitCode: options?.gitEmail ? 0 : 1,
      stdout: options?.gitEmail ?? '',
      stderr: '',
    }),
    execaSync: () => ({
      exitCode: 1,
      stdout: '',
      stderr: '',
      failed: true,
    }),
  }))
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/user.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('./auth.js', () => realAuthSnapshot)
    mock.module('./config.js', () => realConfigSnapshot)
    mock.module('./env.js', () => realEnvSnapshot)
    mock.module('./envUtils.js', () => realEnvUtilsSnapshot)
    mock.module('execa', () => realExecaSnapshot)
    process.env = { ...originalEnv }
    if (originalMacro === undefined) {
      delete (globalThis as Record<string, unknown>).MACRO
    } else {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    }
  } finally {
    releaseSharedMutationLock()
  }
})

describe('user email fallbacks', () => {
  test('getCoreUserData does not synthesize Anthropic email from COO_CREATOR', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    await installCommonMocks()

    const { getCoreUserData } = await importFreshUserModule()
    const result = getCoreUserData()

    expect(result.email).toBeUndefined()
  })

  test('initUser falls back to git email when oauth email is missing', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.COO_CREATOR = 'alice'
    ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0' }

    await installCommonMocks({ gitEmail: 'git@example.com' })

    const { initUser, getCoreUserData } = await importFreshUserModule()
    await initUser()

    const result = getCoreUserData()
    expect(result.email).toBe('git@example.com')
  })
})
