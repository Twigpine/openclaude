import { afterEach, expect, spyOn, test } from 'bun:test'
import * as originalSettings from './settings/settings.js'
import type { SettingsJson } from './settings/types.js'

type MockSource =
  | 'userSettings'
  | 'projectSettings'
  | 'repositorySettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'none'

async function importAuthFresh() {
  return await import(`./auth.js?ts=${Date.now()}-${Math.random()}`)
}

const settingsSpies: Array<{ mockRestore(): void }> = []

afterEach(() => {
  for (const spy of settingsSpies.splice(0)) spy.mockRestore()
})

// Helper: mock settings to return the given subscriptionType from a specific
// source (or no source at all). The trusted-source helper in auth.ts reads
// from user settings only — project, local, flag, and policy settings must
// NOT propagate subscriptionType.
function mockSettings(
  subscriptionType: SettingsJson['subscriptionType'],
  source: MockSource = 'userSettings',
) {
  settingsSpies.push(
    spyOn(originalSettings, 'getSettings_DEPRECATED').mockImplementation(
      () => (source === 'none' ? {} : { subscriptionType }),
    ),
    spyOn(originalSettings, 'getSettingsForSource').mockImplementation(s => {
      if (source === 'none') return null
      return s === source ? { subscriptionType } : null
    }),
  )
}

async function withControlledAuthEnv<T>(
  fn: () => Promise<T>,
  options: { oauthToken?: string } = {},
): Promise<T> {
  const previous = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR:
      process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR,
    ANTHROPIC_UNIX_SOCKET: process.env.ANTHROPIC_UNIX_SOCKET,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR:
      process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR,
    CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
    CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
    CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
    CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
    CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
    CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
    CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  }
  if (options.oauthToken) {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken
  } else {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  }
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
  delete process.env.ANTHROPIC_UNIX_SOCKET
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GITHUB
  try {
    return await fn()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withOAuthFallbackEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withControlledAuthEnv(fn, { oauthToken: 'test-oauth-token' })
}

test('isClaudeAISubscriber returns true if subscriptionType is pro in user settings', async () => {
  mockSettings('pro', 'userSettings')
  const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
  expect(isClaudeAISubscriber()).toBe(true)
  expect(getSubscriptionType()).toBe('pro')
})

test('isClaudeAISubscriber returns false if subscriptionType is free in user settings', async () => {
  mockSettings('free', 'userSettings')
  const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
  expect(isClaudeAISubscriber()).toBe(false)
  expect(getSubscriptionType()).toBe('free')
})

test('isClaudeAISubscriber returns true for OAuth fallback without a free override', async () => {
  mockSettings(undefined, 'none')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(true)
  })
})

// P2 regression: subscriptionType: "free" must short-circuit the OAuth path.
// Prior code only short-circuited non-free values, so free + valid OAuth
// returned true (the OAuth-detected subscriber state leaked through). This
// test sets a fake Claude AI OAuth token that WOULD satisfy the OAuth path,
// then asserts the free override wins.
test('isClaudeAISubscriber returns false for free override even when OAuth tokens would qualify', async () => {
  mockSettings('free', 'userSettings')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(false)
  })
})

for (const source of [
  'projectSettings',
  'repositorySettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const) {
  test(`isClaudeAISubscriber ignores subscriptionType from ${source}`, async () => {
    mockSettings('pro', source)
    await withControlledAuthEnv(async () => {
      const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
      expect(getSubscriptionType()).toBe(null)
      expect(isClaudeAISubscriber()).toBe(false)
    })
  })
}

// P2/P3 regression: when subscriptionType is 'free', isClaudeAISubscriber() returns false
// even if fallback auth conditions (OAuth/environment) are satisfied, and getSubscriptionType() returns 'free'.
test("when subscriptionType is 'free', isClaudeAISubscriber() returns false even if fallback auth conditions are satisfied, and getSubscriptionType() returns 'free'", async () => {
  mockSettings('free', 'userSettings')
  await withOAuthFallbackEnv(async () => {
    const { isClaudeAISubscriber, getSubscriptionType } = await importAuthFresh()
    expect(isClaudeAISubscriber()).toBe(false)
    expect(getSubscriptionType()).toBe('free')
  })
})
