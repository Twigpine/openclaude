import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const originalEnv = {
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  LONGCAT_API_KEY: process.env.LONGCAT_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  XAI_API_KEY: process.env.XAI_API_KEY,
  VENICE_API_KEY: process.env.VENICE_API_KEY,
  MIMO_API_KEY: process.env.MIMO_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}

function restoreEnv(key: keyof typeof originalEnv): void {
  if (originalEnv[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalEnv[key]
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('model/providers.test.ts')
})

afterEach(() => {
  try {
    for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
      restoreEnv(key)
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshProvidersModule() {
  return import(`./providers.js?ts=${Date.now()}-${Math.random()}`)
}

function clearProviderEnv(): void {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.NVIDIA_NIM
  delete process.env.MINIMAX_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.XAI_API_KEY
  delete process.env.VENICE_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.OPENAI_API_KEY
}

test('first-party provider keeps Anthropic account setup flow enabled', () => {
  clearProviderEnv()
  return importFreshProvidersModule().then(
    ({ getAPIProvider, usesAnthropicAccountFlow }) => {
      expect(getAPIProvider()).toBe('firstParty')
      expect(usesAnthropicAccountFlow()).toBe(true)
    },
  )
})

test('custom Anthropic endpoints do not start the first-party account flow', async () => {
  clearProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'https://tenant.example'
  process.env.ANTHROPIC_MODEL = 'tenant-model'
  process.env.ANTHROPIC_AUTH_TOKEN = 'tenant-token'

  const { usesAnthropicAccountFlow } = await importFreshProvidersModule()
  expect(usesAnthropicAccountFlow()).toBe(false)
})

test('HTTP Anthropic URLs do not enable the first-party account flow', async () => {
  clearProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'http://api.anthropic.com'

  const { isFirstPartyAnthropicBaseUrl, usesAnthropicAccountFlow } =
    await importFreshProvidersModule()
  expect(isFirstPartyAnthropicBaseUrl()).toBe(false)
  expect(usesAnthropicAccountFlow()).toBe(false)
})

test.each([
  ['CLAUDE_CODE_USE_OPENAI', 'openai'],
  ['CLAUDE_CODE_USE_GITHUB', 'github'],
  ['CLAUDE_CODE_USE_GEMINI', 'gemini'],
  ['CLAUDE_CODE_USE_BEDROCK', 'bedrock'],
  ['CLAUDE_CODE_USE_VERTEX', 'vertex'],
  ['CLAUDE_CODE_USE_FOUNDRY', 'foundry'],
] as const)(
  '%s disables Anthropic account setup flow',
  async (envKey, provider) => {
    clearProviderEnv()
    process.env[envKey] = '1'
    const { getAPIProvider, usesAnthropicAccountFlow } =
      await importFreshProvidersModule()

    expect(getAPIProvider()).toBe(provider)
    expect(usesAnthropicAccountFlow()).toBe(false)
  },
)

test('GEMINI takes precedence over GitHub when both are set', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('gemini')
})

test('GEMINI takes precedence over NVIDIA_NIM when both flags are set', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.NVIDIA_NIM = '1'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('gemini')
})

test('Foundry takes precedence over Gemini when both flags are set', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('foundry')
})

test('GEMINI takes precedence over env-only MiniMax API keys', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.MINIMAX_API_KEY = 'minimax-key'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('gemini')
})

test('OPENAI takes precedence over env-only MiniMax API keys', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.MINIMAX_API_KEY = 'minimax-key'
  const { getAPIProvider } = await importFreshProvidersModule()

  expect(getAPIProvider()).toBe('openai')
})

test('explicit local openai-compatible base URLs stay on the openai provider', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8080/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

test('codex aliases still resolve to the codex provider without a non-codex base URL', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'codexplan'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('codex')
})

test('XAI_API_KEY resolves to the xai provider', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.x.ai/v1'
  process.env.OPENAI_MODEL = 'grok-4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('xai')
})

test('env-only XAI_API_KEY resolves to the xai provider', async () => {
  clearProviderEnv()
  process.env.XAI_API_KEY = 'xai-test-key'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('xai')
})

test('conflicting OpenAI base prevents env-only xAI provider label', async () => {
  clearProviderEnv()
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

  const { getAPIProvider, usesAnthropicAccountFlow } =
    await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('firstParty')
  expect(usesAnthropicAccountFlow()).toBe(true)
})

test('official OpenAI base URLs now keep provider detection on openai for aliases', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('openai')
})

test('descriptor-backed MiniMax routes keep the legacy minimax provider category', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.minimax.chat/v1'
  process.env.MINIMAX_API_KEY = 'minimax-key'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('minimax')
})

test('env-only MiniMax API key resolves to the minimax provider', async () => {
  clearProviderEnv()
  process.env.MINIMAX_API_KEY = 'minimax-key'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('minimax')
})

test('Anthropic-compatible MiniMax profile resolves to the minimax provider', async () => {
  clearProviderEnv()
  process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
  process.env.ANTHROPIC_API_KEY = 'minimax-key'
  process.env.ANTHROPIC_MODEL = 'MiniMax-M2.7'

  const { getAPIProvider, usesAnthropicAccountFlow } =
    await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('minimax')
  expect(usesAnthropicAccountFlow()).toBe(false)
})

test('conflicting OpenAI base prevents env-only MiniMax provider label', async () => {
  clearProviderEnv()
  process.env.MINIMAX_API_KEY = 'minimax-key'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

  const { getAPIProvider, usesAnthropicAccountFlow } =
    await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('firstParty')
  expect(usesAnthropicAccountFlow()).toBe(true)
})

test('NVIDIA_NIM env preserves the legacy nvidia-nim provider category for custom endpoints', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.NVIDIA_NIM = '1'
  process.env.OPENAI_BASE_URL = 'https://nim.example.com/v1'
  process.env.OPENAI_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'

  const { getAPIProvider } = await importFreshProvidersModule()
  expect(getAPIProvider()).toBe('nvidia-nim')
})

// isGithubNativeAnthropicMode

test('isGithubNativeAnthropicMode: false when CLAUDE_CODE_USE_GITHUB is not set', async () => {
  clearProviderEnv()
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: true for bare claude- model via OPENAI_MODEL', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'claude-sonnet-4-5'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true for github:copilot:claude- compound format', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:claude-sonnet-4'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(true)
})

test('isGithubNativeAnthropicMode: true when resolvedModel is a claude- model', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode('claude-haiku-4-5')).toBe(true)
})

test('isGithubNativeAnthropicMode: false for generic github:copilot alias', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for non-Claude model', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})

test('isGithubNativeAnthropicMode: false for github:copilot:gpt- model', async () => {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'github:copilot:gpt-4o'
  const { isGithubNativeAnthropicMode } = await importFreshProvidersModule()
  expect(isGithubNativeAnthropicMode()).toBe(false)
})
