import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'

// CLAUDE_CODE_SIMPLE puts utils that touch secure storage into a no-op
// "bare" mode — clearXaiCredentials() succeeds without touching the
// keychain, so the test can assert the rest of the cleanup independently.
const SAVED_ENV = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
}

let tempConfigDir = ''
let tempCwd = ''
const originalCwd = process.cwd()

beforeEach(async () => {
  await acquireSharedMutationLock('cli/handlers/xaiAuth.test.ts')
  tempConfigDir = mkdtempSync(join(tmpdir(), 'openclaude-xai-cli-config-'))
  tempCwd = mkdtempSync(join(tmpdir(), 'openclaude-xai-cli-cwd-'))
  process.chdir(tempCwd)
  process.env.CLAUDE_CONFIG_DIR = tempConfigDir
  process.env.CLAUDE_CODE_SIMPLE = '1'
  // Other test files (knowledgeGraph, …) call
  // setClaudeConfigHomeDirForTesting and may leak the override. Pin it
  // to our temp dir so clearPersistedXaiOAuthProfile's path resolution
  // lands on the file we just wrote.
  setClaudeConfigHomeDirForTesting(tempConfigDir)
})

afterEach(() => {
  try {
    setClaudeConfigHomeDirForTesting(undefined)
    process.chdir(originalCwd)
    rmSync(tempConfigDir, { recursive: true, force: true })
    rmSync(tempCwd, { recursive: true, force: true })
    if (SAVED_ENV.CLAUDE_CONFIG_DIR === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = SAVED_ENV.CLAUDE_CONFIG_DIR
    }
    if (SAVED_ENV.CLAUDE_CODE_SIMPLE === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = SAVED_ENV.CLAUDE_CODE_SIMPLE
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function freshHandlerModules() {
  const nonce = `${Date.now()}-${Math.random()}`
  const handlers = (await import(`./xaiAuth.js?ts=${nonce}`)) as typeof import(
    './xaiAuth.js'
  )
  const profileUtils = (await import(
    `../../utils/providerProfile.js?ts=${nonce}`
  )) as typeof import('../../utils/providerProfile.js')
  const profilesUtils = (await import(
    `../../utils/providerProfiles.js?ts=${nonce}`
  )) as typeof import('../../utils/providerProfiles.js')
  const startupOverridesUtils = (await import(
    `../../utils/providerStartupOverrides.js?ts=${nonce}`
  )) as typeof import('../../utils/providerStartupOverrides.js')
  const xaiCredentialsUtils = (await import(
    `../../utils/xaiCredentials.js?ts=${nonce}`
  )) as typeof import('../../utils/xaiCredentials.js')
  // Bundle the real exports xaiLogout needs into a deps object the test
  // can inject. xaiLogout's static imports were captured against the
  // (Codex-mocked) versions when xaiAuth.js was first evaluated; passing
  // these explicitly bypasses that capture without any further mock
  // gymnastics.
  //
  // `clearPersistedXaiOAuthProfile` is wrapped to pin the configDir to
  // our temp dir — other test files run in parallel and call
  // `setClaudeConfigHomeDirForTesting`, so the default-path resolution
  // inside the real helper can't be trusted in the broader suite. The
  // production code still calls it with no args (default path); this
  // wrapper only fences the test.
  const xaiLogoutDeps = {
    clearXaiCredentials: xaiCredentialsUtils.clearXaiCredentials,
    clearPersistedXaiOAuthProfile: () =>
      profileUtils.clearPersistedXaiOAuthProfile({ configDir: tempConfigDir }),
    getProviderProfiles: profilesUtils.getProviderProfiles,
    deleteProviderProfile: profilesUtils.deleteProviderProfile,
    clearStartupProviderOverrides:
      startupOverridesUtils.clearStartupProviderOverrides,
  }
  return { handlers, profileUtils, profilesUtils, xaiLogoutDeps }
}

function readProfileFile(): { profile?: string; env?: Record<string, unknown> } | null {
  const path = join(tempConfigDir, '.openclaude-profile.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeMarkerStartupProfile(): string {
  const path = join(tempConfigDir, '.openclaude-profile.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        profile: 'xai',
        env: {
          OPENAI_BASE_URL: 'https://api.x.ai/v1',
          OPENAI_MODEL: 'grok-4.3',
          XAI_CREDENTIAL_SOURCE: 'oauth',
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  return path
}

// Regression: a user who configured xAI OAuth via /provider and later
// runs `openclaude auth xai logout` previously only had secure storage
// cleared. The marker-tagged .openclaude-profile.json survived, leaving
// startup in a half-logged-out state — validation would still accept
// XAI_CREDENTIAL_SOURCE=oauth while openaiShim could no longer resolve
// a token.
//
// Asserts file-level cleanup directly because Bun's `mock.module(...)`
// in ProviderManager.test.tsx leaks providerProfiles stubs into this
// process. In-memory `getProviderProfiles()` lookups aren't reliable
// here; the startup-file path is what users actually hit at next launch.
test('xaiLogout removes the marker-tagged startup profile', async () => {
  const { handlers, profileUtils, xaiLogoutDeps } = await freshHandlerModules()

  const startupPath = writeMarkerStartupProfile()
  expect(
    profileUtils.isPersistedXaiOAuthProfile(
      profileUtils.loadProfileFile({ configDir: tempConfigDir }),
    ),
  ).toBe(true)

  await handlers.xaiLogout(xaiLogoutDeps)

  expect(existsSync(startupPath)).toBe(false)
  expect(readProfileFile()).toBeNull()
})

test('xaiLogout is a no-op when there is no stored OAuth profile', async () => {
  const { handlers, xaiLogoutDeps } = await freshHandlerModules()

  // No prior /provider setup. Should not crash and should not write any
  // startup file.
  await handlers.xaiLogout(xaiLogoutDeps)
  expect(readProfileFile()).toBeNull()
})

test('xaiLogout leaves unrelated startup profiles intact', async () => {
  const { handlers, xaiLogoutDeps } = await freshHandlerModules()

  // Simulate a non-xAI startup file (e.g. an openai profile).
  const path = join(tempConfigDir, '.openclaude-profile.json')
  writeFileSync(
    path,
    JSON.stringify(
      {
        profile: 'openai',
        env: {
          OPENAI_BASE_URL: 'https://api.openai.com/v1',
          OPENAI_MODEL: 'gpt-4o',
        },
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  await handlers.xaiLogout(xaiLogoutDeps)

  // Unrelated profile must survive.
  expect(existsSync(path)).toBe(true)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  expect(parsed.profile).toBe('openai')
})
