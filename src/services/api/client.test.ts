import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import {
  _clearRegistryForTesting,
  ensureIntegrationsLoaded,
  registerGateway,
} from '../../integrations/index.js'
import { publicBuildVersion } from '../../utils/version.js'

// bun:test keeps mock.module() registrations process-global across test files.
// Load and re-register the real module before importing the client so a prior
// provider mock cannot make this suite validate the wrong route in CI.
const _realProvidersModule = await import(
  `../../utils/model/providers.js?real=${Date.now()}-${Math.random()}`,
)
const realProviders = {
  getAPIProvider: _realProvidersModule.getAPIProvider,
  usesAnthropicAccountFlow: _realProvidersModule.usesAnthropicAccountFlow,
  isGithubNativeAnthropicMode: _realProvidersModule.isGithubNativeAnthropicMode,
  getAPIProviderForStatsig: _realProvidersModule.getAPIProviderForStatsig,
  isFirstPartyAnthropicBaseUrl: _realProvidersModule.isFirstPartyAnthropicBaseUrl,
}
mock.module('../../utils/model/providers.js', () => realProviders)
mock.module('src/utils/model/providers.js', () => realProviders)
const _realModelSupportOverridesModule = await import(
  `../../utils/model/modelSupportOverrides.js?real=${Date.now()}-${Math.random()}`,
)
const realModelSupportOverrides = {
  get3PModelCapabilityOverride:
    _realModelSupportOverridesModule.get3PModelCapabilityOverride,
}
mock.module(
  '../../utils/model/modelSupportOverrides.js',
  () => realModelSupportOverrides,
)
mock.module(
  'src/utils/model/modelSupportOverrides.js',
  () => realModelSupportOverrides,
)
const { getAnthropicClient } = await import(
  `./client.js?real=${Date.now()}-${Math.random()}`,
)

type FetchType = typeof globalThis.fetch

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

const originalFetch = globalThis.fetch
const originalMacro = (globalThis as Record<string, unknown>).MACRO
const originalEnv = {
  CLAUDE_CODE_ALWAYS_ENABLE_EFFORT:
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  OPENAI_AUTH_HEADER: process.env.OPENAI_AUTH_HEADER,
  OPENAI_AUTH_SCHEME: process.env.OPENAI_AUTH_SCHEME,
  OPENAI_AUTH_HEADER_VALUE: process.env.OPENAI_AUTH_HEADER_VALUE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  MIMO_API_KEY: process.env.MIMO_API_KEY,
  VENICE_API_KEY: process.env.VENICE_API_KEY,
  FIREWORKS_API_KEY: process.env.FIREWORKS_API_KEY,
  NEARAI_API_KEY: process.env.NEARAI_API_KEY,
  CLINE_API_KEY: process.env.CLINE_API_KEY,
  LONGCAT_API_KEY: process.env.LONGCAT_API_KEY,
  AIMLAPI_API_KEY: process.env.AIMLAPI_API_KEY,
  APISMART_API_KEY: process.env.APISMART_API_KEY,
  API_ROUTE_API_KEY: process.env.API_ROUTE_API_KEY,
  API_ROUTE_MODEL: process.env.API_ROUTE_MODEL,
  CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
  CONCENTRATE_BASE_URL: process.env.CONCENTRATE_BASE_URL,
  CONCENTRATE_MODEL: process.env.CONCENTRATE_MODEL,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  ANTHROPIC_DEFAULT_OPUS_MODEL:
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
  ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
  ANTHROPIC_DEFAULT_SONNET_MODEL:
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
  ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
  ANTHROPIC_DEFAULT_HAIKU_MODEL:
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES:
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES,
  USER_TYPE: process.env.USER_TYPE,
  USE_STAGING_OAUTH: process.env.USE_STAGING_OAUTH,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearEnvForMiniMaxOnlyTest(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.GOOGLE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.XAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.VENICE_API_KEY
  delete process.env.FIREWORKS_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.AIMLAPI_API_KEY
  delete process.env.APISMART_API_KEY
  delete process.env.NVIDIA_NIM
  delete process.env.NVIDIA_API_KEY
  process.env.ANTHROPIC_API_KEY = 'must-not-forward'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.USER_TYPE
  delete process.env.USE_STAGING_OAUTH
}

beforeEach(async () => {
  await acquireSharedMutationLock('client.test.ts')
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  process.env.GEMINI_API_KEY = 'gemini-test-key'
  process.env.GEMINI_MODEL = 'gemini-2.0-flash'
  process.env.GEMINI_BASE_URL = 'https://gemini.example/v1beta/openai'
  process.env.GEMINI_AUTH_MODE = 'api-key'

  delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.GOOGLE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_MODEL
  delete process.env.MINIMAX_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.VENICE_API_KEY
  delete process.env.FIREWORKS_API_KEY
  delete process.env.NEARAI_API_KEY
  delete process.env.CLINE_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.AIMLAPI_API_KEY
  delete process.env.APISMART_API_KEY
  delete process.env.API_ROUTE_API_KEY
  delete process.env.API_ROUTE_MODEL
  delete process.env.CONCENTRATE_API_KEY
  delete process.env.CONCENTRATE_BASE_URL
  delete process.env.CONCENTRATE_MODEL
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.NVIDIA_NIM
  delete process.env.NVIDIA_API_KEY
  process.env.ANTHROPIC_API_KEY = 'must-not-forward'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
})

afterEach(() => {
  try {
    ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    restoreEnv(
      'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
      originalEnv.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT,
    )
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('CLAUDE_CODE_USE_BEDROCK', originalEnv.CLAUDE_CODE_USE_BEDROCK)
    restoreEnv(
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      originalEnv.CLAUDE_CODE_SKIP_BEDROCK_AUTH,
    )
    restoreEnv('CLAUDE_CODE_USE_VERTEX', originalEnv.CLAUDE_CODE_USE_VERTEX)
    restoreEnv('CLAUDE_CODE_USE_FOUNDRY', originalEnv.CLAUDE_CODE_USE_FOUNDRY)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('CLAUDE_CODE_USE_GITHUB', originalEnv.CLAUDE_CODE_USE_GITHUB)
    restoreEnv('CLAUDE_CODE_USE_MISTRAL', originalEnv.CLAUDE_CODE_USE_MISTRAL)
    restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
    restoreEnv('GEMINI_MODEL', originalEnv.GEMINI_MODEL)
    restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
    restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
    restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
    restoreEnv('OPENAI_API_FORMAT', originalEnv.OPENAI_API_FORMAT)
    restoreEnv('OPENAI_AZURE_STYLE', originalEnv.OPENAI_AZURE_STYLE)
    restoreEnv('OPENAI_AUTH_HEADER', originalEnv.OPENAI_AUTH_HEADER)
    restoreEnv('OPENAI_AUTH_SCHEME', originalEnv.OPENAI_AUTH_SCHEME)
    restoreEnv('OPENAI_AUTH_HEADER_VALUE', originalEnv.OPENAI_AUTH_HEADER_VALUE)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
    restoreEnv('MINIMAX_API_KEY', originalEnv.MINIMAX_API_KEY)
    restoreEnv('XAI_API_KEY', originalEnv.XAI_API_KEY)
    restoreEnv('MIMO_API_KEY', originalEnv.MIMO_API_KEY)
    restoreEnv('VENICE_API_KEY', originalEnv.VENICE_API_KEY)
    restoreEnv('FIREWORKS_API_KEY', originalEnv.FIREWORKS_API_KEY)
    restoreEnv('NEARAI_API_KEY', originalEnv.NEARAI_API_KEY)
    restoreEnv('CLINE_API_KEY', originalEnv.CLINE_API_KEY)
    restoreEnv('LONGCAT_API_KEY', originalEnv.LONGCAT_API_KEY)
    restoreEnv('AIMLAPI_API_KEY', originalEnv.AIMLAPI_API_KEY)
    restoreEnv('APISMART_API_KEY', originalEnv.APISMART_API_KEY)
    restoreEnv('API_ROUTE_API_KEY', originalEnv.API_ROUTE_API_KEY)
    restoreEnv('API_ROUTE_MODEL', originalEnv.API_ROUTE_MODEL)
    restoreEnv('CONCENTRATE_API_KEY', originalEnv.CONCENTRATE_API_KEY)
    restoreEnv('CONCENTRATE_BASE_URL', originalEnv.CONCENTRATE_BASE_URL)
    restoreEnv('CONCENTRATE_MODEL', originalEnv.CONCENTRATE_MODEL)
    restoreEnv('NVIDIA_NIM', originalEnv.NVIDIA_NIM)
    restoreEnv('NVIDIA_API_KEY', originalEnv.NVIDIA_API_KEY)
    restoreEnv('ANTHROPIC_API_KEY', originalEnv.ANTHROPIC_API_KEY)
    restoreEnv('ANTHROPIC_AUTH_TOKEN', originalEnv.ANTHROPIC_AUTH_TOKEN)
    restoreEnv('ANTHROPIC_BASE_URL', originalEnv.ANTHROPIC_BASE_URL)
    restoreEnv('ANTHROPIC_MODEL', originalEnv.ANTHROPIC_MODEL)
    restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
    restoreEnv(
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      originalEnv.ANTHROPIC_DEFAULT_OPUS_MODEL,
    )
    restoreEnv(
      'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
      originalEnv.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
    )
    restoreEnv(
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      originalEnv.ANTHROPIC_DEFAULT_SONNET_MODEL,
    )
    restoreEnv(
      'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
      originalEnv.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES,
    )
    restoreEnv(
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      originalEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    )
    restoreEnv(
      'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
      originalEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES,
    )
    restoreEnv('USER_TYPE', originalEnv.USER_TYPE)
    restoreEnv('USE_STAGING_OAUTH', originalEnv.USE_STAGING_OAUTH)
    restoreEnv(
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
      originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
    )
    restoreEnv(
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
      originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
    )
    globalThis.fetch = originalFetch
  } finally {
    releaseSharedMutationLock()
  }
})

test('first-party Anthropic requests execute the configured fetch wrapper without runtime symbol errors', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.NVIDIA_NIM
  delete process.env.NVIDIA_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.VENICE_API_KEY
  process.env.ANTHROPIC_API_KEY = 'must-not-forward'
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL

  const fetchOverride = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'msg_first_party_fetch',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        container: null,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = await getAnthropicClient({
    apiKey: 'anthropic-test-key',
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
    fetchOverride,
  })

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
  })

  expect(response).toMatchObject({
    id: 'msg_first_party_fetch',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
  })
  expect(capturedHeaders).toBeDefined()
})

test('native Anthropic client validates and clamps API_TIMEOUT_MS', async () => {
  const originalApiTimeoutMs = process.env.API_TIMEOUT_MS
  // Force the first-party native Anthropic constructor path. Every provider
  // route-selection variable is cleared explicitly so an inherited value cannot
  // divert getAnthropicClient into the shim and silently measure the wrong
  // client's timeout. (The suite's afterEach restores all of these.)
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_MODEL
  delete process.env.MINIMAX_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.VENICE_API_KEY
  delete process.env.FIREWORKS_API_KEY
  delete process.env.NEARAI_API_KEY
  delete process.env.CLINE_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.AIMLAPI_API_KEY
  delete process.env.APISMART_API_KEY
  delete process.env.CONCENTRATE_API_KEY
  delete process.env.NVIDIA_NIM
  delete process.env.NVIDIA_API_KEY
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'

  try {
    const timeoutOf = async (): Promise<number> => {
      const client = await getAnthropicClient({
        apiKey: 'anthropic-test-key',
        maxRetries: 0,
        model: 'claude-sonnet-4-6',
      })
      // Guard the premise: only the native constructor exposes the SDK
      // timeout. The OpenAI shim is returned as a cast object, so if a stray
      // route-selection variable (or a future env-only route) diverts this
      // call, fail here rather than silently reading undefined.
      expect(client).toBeInstanceOf(Anthropic)
      return (client as unknown as { timeout: number }).timeout
    }

    // A malformed or negative override must not poison the client with a NaN or
    // negative timeout; it falls back to the 600s default.
    for (const invalid of ['not-a-number', '-1', '0', '1.5', '']) {
      process.env.API_TIMEOUT_MS = invalid
      expect(await timeoutOf()).toBe(600_000)
    }
    // Unset also yields the default.
    delete process.env.API_TIMEOUT_MS
    expect(await timeoutOf()).toBe(600_000)
    // A valid override is honored, and an oversized one is clamped below the
    // 32-bit setTimeout ceiling instead of overflowing to a tiny delay.
    process.env.API_TIMEOUT_MS = '45000'
    expect(await timeoutOf()).toBe(45_000)
    process.env.API_TIMEOUT_MS = '3000000000'
    expect(await timeoutOf()).toBe(2_147_483_647)
  } finally {
    restoreEnv('API_TIMEOUT_MS', originalApiTimeoutMs)
  }
})

test('routes a custom Anthropic endpoint with ANTHROPIC_AUTH_TOKEN without requiring an API key', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  process.env.ANTHROPIC_API_KEY = 'must-not-forward'
  process.env.ANTHROPIC_AUTH_TOKEN = 'custom-anthropic-token'
  process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example/api/v1'
  process.env.USER_TYPE = 'ant'
  process.env.USE_STAGING_OAUTH = '1'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant: tenant-a\nauthorization: stale-value'

  const fetchOverride = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    return new Response(
      JSON.stringify({
        id: 'msg_custom_anthropic',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        container: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
    fetchOverride,
  })

  await client.messages.create({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
  })

  expect(capturedUrl).toBe('https://anthropic.example/api/v1/messages')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer custom-anthropic-token')
  expect(capturedHeaders?.get('x-api-key')).toBeNull()
  expect(capturedHeaders?.get('x-tenant')).toBe('tenant-a')
})

test('does not forward a custom bearer token to the first-party Anthropic endpoint', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_AUTH_TOKEN = 'custom-anthropic-token'
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

  const fetchOverride = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)
    return new Response(
      JSON.stringify({
        id: 'msg_first_party_key', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, container: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = await getAnthropicClient({
    apiKey: 'first-party-api-key',
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
    fetchOverride,
  })
  await client.messages.create({
    model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64,
  })

  expect(capturedHeaders?.get('authorization')).toBeNull()
  expect(capturedHeaders?.get('x-api-key')).toBe('first-party-api-key')
})

test('routes a custom Anthropic endpoint with native x-api-key authentication', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.ANTHROPIC_API_KEY = 'custom-anthropic-api-key'
  process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example/api'
  process.env.ANTHROPIC_CUSTOM_HEADERS =
    'X-Tenant: tenant-a\nauthorization: stale-value\nx-api-key: stale-key'

  const fetchOverride = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)
    return new Response(
      JSON.stringify({
        id: 'msg_custom_anthropic_key', type: 'message', role: 'assistant',
        model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn', stop_sequence: null, container: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = await getAnthropicClient({ maxRetries: 0, model: 'claude-sonnet-4-6', fetchOverride })
  await client.messages.create({
    model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64,
  })

  expect(capturedHeaders?.get('x-api-key')).toBe('custom-anthropic-api-key')
  expect(capturedHeaders?.get('authorization')).toBeNull()
  expect(capturedHeaders?.get('x-tenant')).toBe('tenant-a')
})

test('routes Gemini provider requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  process.env.ANTHROPIC_AUTH_TOKEN = 'must-not-reach-gemini'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-gemini',
        model: 'gemini-2.0-flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'gemini ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gemini-2.0-flash',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'gemini-2.0-flash',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://gemini.example/v1beta/openai/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer gemini-test-key')
  expect(capturedBody?.model).toBe('gemini-2.0-flash')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gemini-2.0-flash',
  })
})

test('routes env-only MiniMax requests through the Anthropic-compatible API', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  clearEnvForMiniMaxOnlyTest()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'ambient-openai-key'
  process.env.XAI_API_KEY = 'ambient-xai-key'
  process.env.MINIMAX_API_KEY = 'minimax-test-key'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'msg-minimax',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M2.5',
        content: [{ type: 'text', text: 'minimax ok' }],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        stop_reason: 'end_turn',
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'MiniMax-M2.5',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'MiniMax-M2.5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.minimax.io/anthropic/v1/messages?beta=true')
  expect(capturedHeaders?.get('x-api-key')).toBe('minimax-test-key')
  expect(capturedBody?.model).toBe('MiniMax-M2.5')
  expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic')
  expect(process.env.ANTHROPIC_API_KEY).toBe('minimax-test-key')
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'MiniMax-M2.5',
  })
})

test('env-only MiniMax fallback preserves legacy OPENAI_MODEL as Anthropic model', async () => {
  let capturedUrl: string | undefined
  let capturedBody: Record<string, unknown> | undefined

  clearEnvForMiniMaxOnlyTest()
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.OPENAI_MODEL = 'MiniMax-M2.7-highspeed'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'msg-minimax-override',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M2.7-highspeed',
        content: [{ type: 'text', text: 'minimax override ok' }],
        usage: { input_tokens: 8, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        stop_reason: 'end_turn',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'MiniMax-M2.7-highspeed',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'MiniMax-M2.7-highspeed',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.minimax.io/anthropic/v1/messages?beta=true')
  expect(capturedBody?.model).toBe('MiniMax-M2.7-highspeed')
  expect(process.env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7-highspeed')
})

test('env-only MiniMax fallback drops stale OpenAI shim options', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined

  clearEnvForMiniMaxOnlyTest()
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.OPENAI_API_FORMAT = 'responses'
  process.env.OPENAI_AZURE_STYLE = '1'
  process.env.OPENAI_AUTH_HEADER = 'api-key'
  process.env.OPENAI_AUTH_SCHEME = 'raw'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-header-value'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'msg-minimax-clean',
        type: 'message',
        role: 'assistant',
        model: 'MiniMax-M2.7',
        content: [{ type: 'text', text: 'minimax clean ok' }],
        usage: { input_tokens: 8, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        stop_reason: 'end_turn',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'MiniMax-M2.7',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'MiniMax-M2.7',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.minimax.io/anthropic/v1/messages?beta=true')
  expect(capturedHeaders?.get('x-api-key')).toBe('minimax-test-key')
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
  expect(process.env.OPENAI_AZURE_STYLE).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
  expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
})

test('env-only MiniMax fallback replaces stale non-MiniMax model env', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.OPENAI_MODEL = 'gpt-4o'

  await getAnthropicClient({
    maxRetries: 0,
    model: 'MiniMax-M2.7',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7')
  expect(process.env.ANTHROPIC_API_KEY).toBe('minimax-test-key')
})

test('env-only MiniMax fallback does not override explicit OpenAI credentials', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.MINIMAX_API_KEY = 'minimax-test-key'

  await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBe('openai-test-key')
  expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  expect(process.env.OPENAI_MODEL).toBeUndefined()
})

test('env-only MiniMax fallback ignores non-MiniMax base overrides', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'MiniMax-M2.7'

  await getAnthropicClient({
    maxRetries: 0,
    model: 'MiniMax-M2.7',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  expect(process.env.OPENAI_MODEL).toBe('MiniMax-M2.7')
})

test('env-only ApiSmart setup withholds its key from a noncanonical same-host URL', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.APISMART_API_KEY = 'apismart-test-key'
  process.env.OPENAI_BASE_URL = 'https://gw.apismart.ai/v1/models'

  await getAnthropicClient({ maxRetries: 0, model: 'DEEPSEEK_V4_FLASH' })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1/models')
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('routes env-only API Route requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.API_ROUTE_API_KEY = 'api-route-test-key'
  process.env.API_ROUTE_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-Auth: ambient-proxy-secret'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-api-route',
        model: 'claude-sonnet-4-6',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'api-route ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as typeof fetch

  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })
  const response = await client.messages.create({
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    model: 'claude-sonnet-4-6',
  })

  expect(response.content[0]).toEqual({
    type: 'text',
    text: 'api-route ok',
  })
  expect(capturedUrl).toBe(
    'https://global.api-route.com/v1/chat/completions',
  )
  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer api-route-test-key',
  )
  expect(capturedHeaders?.get('x-proxy-auth')).toBeNull()
  expect(capturedBody?.model).toBe('claude-sonnet-4-6')
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_BASE_URL).toBe('https://global.api-route.com/v1')
  expect(process.env.OPENAI_API_KEY).toBe('api-route-test-key')
  expect(process.env.OPENAI_MODEL).toBe('claude-sonnet-4-6')
})

test('env-only API Route setup prefers API_ROUTE_API_KEY over stale OPENAI_API_KEYS pool', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.API_ROUTE_API_KEY = 'api-route-correct-key'
  process.env.OPENAI_API_KEYS = 'stale-key-1,stale-key-2'
  process.env.OPENAI_BASE_URL = 'https://global.api-route.com/v1'

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-api-route-precedence',
        model: 'claude-sonnet-4-6',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'api-route ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as typeof fetch

  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })
  await client.messages.create({
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    model: 'claude-sonnet-4-6',
  })

  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer api-route-correct-key',
  )
  expect(capturedHeaders?.get('authorization')).not.toContain('stale-key')
  expect(process.env.OPENAI_API_KEYS).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBe('api-route-correct-key')
})

test('env-only API Route setup withholds its key from a noncanonical URL', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.API_ROUTE_API_KEY = 'api-route-test-key'
  process.env.OPENAI_BASE_URL = 'https://global.api-route.com/v1/models'
  process.env.OPENAI_API_KEYS = 'ambient-key-pool-1,ambient-key-pool-2'

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-api-route-noncanonical',
        model: 'claude-sonnet-4-6',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'api-route noncanonical ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as typeof fetch

  const client = await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })
  await client.messages.create({
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
    model: 'claude-sonnet-4-6',
  })

  expect(capturedHeaders?.get('authorization')).toBeNull()
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_BASE_URL).toBe(
    'https://global.api-route.com/v1/models',
  )
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.OPENAI_API_KEYS).toBeUndefined()
})

test('routes env-only Concentrate requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.CONCENTRATE_API_KEY = 'concentrate-test-key'
  process.env.CONCENTRATE_BASE_URL = 'https://api.concentrate.ai/v1'
  process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Proxy-Auth: ambient-proxy-secret'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-concentrate',
        model: 'claude-sonnet-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'concentrate ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-5',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'claude-sonnet-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.concentrate.ai/v1/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer concentrate-test-key')
  expect(capturedHeaders?.get('x-proxy-auth')).toBeNull()
  expect(capturedBody?.model).toBe('claude-sonnet-5')
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
  expect(process.env.OPENAI_API_KEY).toBe('concentrate-test-key')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'claude-sonnet-5',
  })
})

test('env-only Concentrate setup withholds its key from a noncanonical same-host URL', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.CONCENTRATE_API_KEY = 'concentrate-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.concentrate.ai/v1/models'

  await getAnthropicClient({ maxRetries: 0, model: 'claude-sonnet-5' })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_BASE_URL).toBe(
    'https://api.concentrate.ai/v1/models',
  )
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('generic OpenAI configuration for the canonical Concentrate endpoint retains its key', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.OPENAI_API_KEY = 'generic-openai-key'
  process.env.OPENAI_BASE_URL = 'https://api.concentrate.ai/v1'
  process.env.OPENAI_MODEL = 'claude-sonnet-5'

  await getAnthropicClient({ maxRetries: 0, model: 'claude-sonnet-5' })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
  expect(process.env.OPENAI_MODEL).toBe('claude-sonnet-5')
  expect(process.env.OPENAI_API_KEY).toBe('generic-openai-key')
})

test('routes env-only AI/ML API requests through the OpenAI-compatible shim despite an ambient OpenAI key', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.OPENAI_API_KEY = 'ambient-openai-key'
  process.env.AIMLAPI_API_KEY = 'aimlapi-test-key'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-aimlapi',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'aimlapi ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.aimlapi.com/v1/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer aimlapi-test-key',
  )
  expect(capturedHeaders?.get('x-aimlapi-partner-id')).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')
  expect(capturedHeaders?.get('x-aimlapi-integration-repo')).toBe(
    'Twigpine/openclaude',
  )
  expect(capturedHeaders?.get('x-aimlapi-integration-version')).toBe(
    publicBuildVersion,
  )
  expect(capturedHeaders?.get('http-referer')).toBe('OpenClaude')
  expect(capturedHeaders?.get('x-title')).toBe('OpenClaude')
  expect(capturedBody?.model).toBe('gpt-4o')
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.aimlapi.com/v1')
  expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  expect(process.env.OPENAI_API_KEY).toBe('aimlapi-test-key')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'gpt-4o',
  })
})

test('routes env-only xAI requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.XAI_API_KEY = 'xai-test-key'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-xai',
        model: 'grok-4',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'xai ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'grok-4',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.x.ai/v1/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer xai-test-key')
  // xAI prompt caching: x-grok-conv-id pins the session to one backend so the
  // cached system prompt and conversation history can be reused. Mirrors the
  // Hermes implementation (RELEASE_v0.8.0 PR #5604).
  expect(capturedHeaders?.get('x-grok-conv-id')).toBeTruthy()
  expect(capturedBody?.model).toBe('grok-4.3')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'grok-4',
  })
})

test('env-only xAI fallback replaces stale OpenAI credentials and model env', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.OPENAI_MODEL = 'gpt-4o'

  await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_MODEL).toBe('grok-4.6')
  expect(process.env.OPENAI_API_KEY).toBe('xai-test-key')
})

test('env-only xAI fallback preserves xAI OPENAI_API_BASE host overrides', async () => {
  let capturedUrl: string | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_API_BASE = 'https://api.x.ai/v1'

  globalThis.fetch = (async (input) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-xai-api-base',
        model: 'grok-4',
        choices: [
          {
            message: { role: 'assistant', content: 'xai api base ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'grok-4',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.x.ai/v1/chat/completions')
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.x.ai/v1')
})

test('env-only xAI fallback drops unsupported OpenAI shim options', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_API_FORMAT = 'responses'
  process.env.OPENAI_AUTH_HEADER = 'api-key'
  process.env.OPENAI_AUTH_SCHEME = 'raw'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-header-value'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-xai-clean',
        model: 'grok-4',
        choices: [
          {
            message: { role: 'assistant', content: 'xai clean ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'grok-4',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.x.ai/v1/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer xai-test-key')
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
  expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
})

test('env-only xAI fallback ignores non-xAI base overrides', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'
  process.env.XAI_API_KEY = 'xai-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'grok-4'

  await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  expect(process.env.OPENAI_MODEL).toBe('grok-4')
})

test('env-only xAI wins when MiniMax key is also present', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.XAI_API_KEY = 'xai-test-key'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-xai',
        model: 'grok-4',
        choices: [
          {
            message: { role: 'assistant', content: 'xai ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'grok-4',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'grok-4',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.x.ai/v1/chat/completions')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer xai-test-key')
  expect(process.env.OPENAI_API_KEY).toBe('xai-test-key')
})

test('env-only MiniMax fallback yields to explicit Bedrock selection', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  process.env.MINIMAX_API_KEY = 'minimax-test-key'

  globalThis.fetch = (async () => {
    throw new Error('MiniMax/OpenAI shim fetch should not run')
  }) as unknown as FetchType

  await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  expect(process.env.OPENAI_MODEL).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('env-only xAI fallback yields to explicit Bedrock selection', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  process.env.XAI_API_KEY = 'xai-test-key'

  globalThis.fetch = (async () => {
    throw new Error('xAI/OpenAI shim fetch should not run')
  }) as unknown as FetchType

  await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  expect(process.env.OPENAI_MODEL).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('routes env-only Fireworks AI requests through the OpenAI-compatible shim', async () => {
  let capturedUrl: string | undefined
  let capturedHeaders: Headers | undefined
  let capturedBody: Record<string, unknown> | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    capturedHeaders = new Headers(init?.headers)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fw',
        model: 'accounts/fireworks/models/deepseek-v3',
        choices: [
          {
            message: { role: 'assistant', content: 'fireworks ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'accounts/fireworks/models/deepseek-v3',
  })) as unknown as ShimClient

  const response = await client.beta.messages.create({
    model: 'accounts/fireworks/models/deepseek-v3',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe(
    'https://api.fireworks.ai/inference/v1/chat/completions',
  )
  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer fireworks-test-key',
  )
  expect(capturedBody?.model).toBe('accounts/fireworks/models/deepseek-v3')
  expect(response).toMatchObject({
    role: 'assistant',
    model: 'accounts/fireworks/models/deepseek-v3',
  })
})

test('env-only Fireworks fallback replaces stale OpenAI model env', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'
  process.env.OPENAI_MODEL = 'gpt-4o'

  await getAnthropicClient({ maxRetries: 0, model: 'accounts/fireworks/models/deepseek-v3' })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
  expect(process.env.OPENAI_MODEL).toBe(
    'accounts/fireworks/models/llama-v3p1-70b-instruct',
  )
  expect(process.env.OPENAI_API_KEY).toBe('fireworks-test-key')
})

test('env-only Fireworks fallback preserves Fireworks OPENAI_API_BASE host overrides', async () => {
  let capturedUrl: string | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.OPENAI_BASE_URL
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'
  process.env.OPENAI_API_BASE = 'https://api.fireworks.ai/inference/v1'

  globalThis.fetch = (async (input, init) => {
    capturedUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fw-api-base',
        model: 'accounts/fireworks/models/deepseek-v3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'fireworks api base ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'accounts/fireworks/models/deepseek-v3',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'accounts/fireworks/models/deepseek-v3',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe(
    'https://api.fireworks.ai/inference/v1/chat/completions',
  )
  expect(String(process.env.OPENAI_BASE_URL)).toBe('https://api.fireworks.ai/inference/v1')
})

test('env-only Fireworks fallback drops unsupported OpenAI shim options', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'
  process.env.OPENAI_API_FORMAT = 'responses'
  process.env.OPENAI_AUTH_HEADER = 'api-key'
  process.env.OPENAI_AUTH_SCHEME = 'raw'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-header-value'

  globalThis.fetch = (async (input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-fw-clean',
        model: 'accounts/fireworks/models/deepseek-v3',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'fireworks clean ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'accounts/fireworks/models/deepseek-v3',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'accounts/fireworks/models/deepseek-v3',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('authorization')).toBe(
    'Bearer fireworks-test-key',
  )
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
  expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
  expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
})

test('env-only Fireworks fallback ignores non-Fireworks base overrides', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.ANTHROPIC_API_KEY = 'anthropic-test-key'
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'accounts/fireworks/models/deepseek-v3'

  await getAnthropicClient({ maxRetries: 0, model: 'accounts/fireworks/models/deepseek-v3' })

  // ANTHROPIC_API_KEY takes precedence — Fireworks env-only provider does not activate
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  expect(process.env.OPENAI_MODEL).toBe(
    'accounts/fireworks/models/deepseek-v3',
  )
})

test('env-only Fireworks does not activate when MiniMax key is present', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'

  globalThis.fetch = (async () => {
    throw new Error('Fireworks/OpenAI shim fetch should not run')
  }) as unknown as FetchType

  await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })

  // MiniMax takes priority over Fireworks
  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  expect(process.env.OPENAI_MODEL).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('env-only Fireworks fallback yields to explicit Bedrock selection', async () => {
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_AUTH_MODE
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
  process.env.FIREWORKS_API_KEY = 'fireworks-test-key'

  globalThis.fetch = (async () => {
    throw new Error('Fireworks/OpenAI shim fetch should not run')
  }) as unknown as FetchType

  await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-sonnet-4-6',
  })

  expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
  expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  expect(process.env.OPENAI_MODEL).toBeUndefined()
  expect(process.env.OPENAI_API_KEY).toBeUndefined()
})

test('strips Anthropic-specific custom headers before sending OpenAI-compatible shim requests', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'anthropic-version: 2023-06-01',
    'anthropic-beta: prompt-caching-2024-07-31',
    'x-anthropic-additional-protection: true',
    'x-claude-remote-session-id: remote-123',
    'x-app: cli',
    'api-key: custom-provider-key',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-openai',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-anthropic-additional-protection')).toBeNull()
  expect(capturedHeaders?.get('x-claude-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-app')).toBeNull()
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer openai-test-key')
})

test('strips Anthropic-specific custom headers on providerOverride shim requests too', async () => {
  let capturedHeaders: Headers | undefined

  process.env.ANTHROPIC_CUSTOM_HEADERS = [
    'anthropic-version: 2023-06-01',
    'anthropic-beta: prompt-caching-2024-07-31',
    'x-claude-remote-session-id: remote-123',
    'api-key: custom-provider-key',
    'x-safe-header: keep-me',
  ].join('\n')

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    providerOverride: {
      model: 'gpt-4o',
      baseURL: 'http://example.test/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-claude-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('api-key')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer provider-test-key')
})

test('providerOverride OpenAI gpt effort does not fall back to ambient provider', async () => {
  let requestUrl = ''
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'resp-provider-override-openai',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'xhigh',
    providerOverride: {
      model: 'gpt-5.4',
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  // gpt-5.4 on api.openai.com auto-routes to the Responses API, where effort
  // is nested as reasoning.effort rather than top-level reasoning_effort.
  expect(requestUrl.endsWith('/responses')).toBe(true)
  expect(requestBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
  expect(requestBody).not.toHaveProperty('reasoning_effort')
})

test('normal OpenAI gpt effort uses catalog metadata', async () => {
  let requestBody: Record<string, unknown> | undefined
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'resp-normal-openai', model: 'gpt-5.6-sol',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-5.6-sol',
    effortValue: 'xhigh',
  })) as unknown as ShimClient

  await client.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(requestBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
})

test('auto-routed Azure gpt-5.4 and gpt-5.5 requests preserve selected effort', async () => {
  const requestBodies: Record<string, unknown>[] = []
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({
      id: 'resp-azure-openai',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  for (const model of ['gpt-5.4', 'gpt-5.5']) {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      model,
      effortValue: 'xhigh',
    })) as unknown as ShimClient
    await client.beta.messages.create({ model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })
  }

  expect(requestBodies).toEqual([
    expect.objectContaining({ reasoning: { effort: 'xhigh', summary: 'auto' } }),
    expect.objectContaining({ reasoning: { effort: 'xhigh', summary: 'auto' } }),
  ])
})

test('OPENAI_API_BASE gateway omits the GPT-5.6 default but preserves explicit effort', async () => {
  let requestUrl = ''
  const requestBodies: Record<string, unknown>[] = []
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE = 'https://gateway.example/v1'
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBodies.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify({
      id: 'chatcmpl-gateway',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const defaultClient = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-5.6-sol',
  })) as unknown as ShimClient
  await defaultClient.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  const explicitClient = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-5.6-sol',
    effortValue: 'xhigh',
  })) as unknown as ShimClient
  await explicitClient.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(requestUrl).toBe('https://gateway.example/v1/chat/completions')
  expect(requestBodies[0]?.reasoning_effort).toBeUndefined()
  expect(requestBodies[1]?.reasoning_effort).toBe('xhigh')
})

test('providerOverride Azure gpt effort uses the override base for catalog metadata', async () => {
  let requestBody: Record<string, unknown> | undefined
  process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'resp-provider-override-azure', model: 'gpt-5.6-sol',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'xhigh',
    providerOverride: {
      model: 'gpt-5.6-sol',
      baseURL: 'https://myres.openai.azure.com/openai/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({ model: 'unused', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(requestBody?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' })
})

test('providerOverride does not inherit Azure-style routing from its parent', async () => {
  let requestUrl = ''
  let requestHeaders: Headers | undefined
  let requestBody: Record<string, unknown> | undefined
  process.env.OPENAI_AZURE_STYLE = '1'

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestHeaders = new Headers(init?.headers)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-provider-override-gateway', model: 'gpt-5.6-sol',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    providerOverride: {
      model: 'gpt-5.6-sol',
      baseURL: 'https://gateway.example/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({ model: 'unused', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(requestUrl).toBe('https://gateway.example/v1/chat/completions')
  expect(requestHeaders?.get('authorization')).toBe('Bearer provider-test-key')
  expect(requestHeaders?.get('api-key')).toBeNull()
  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('providerOverride preserves an explicit responses format from its parent', async () => {
  let requestUrl = ''
  process.env.OPENAI_API_FORMAT = 'responses'

  globalThis.fetch = (async (input, _init) => {
    requestUrl = String(input)
    return new Response(JSON.stringify({
      id: 'resp-provider-override-gateway',
      model: 'response-only-model',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    providerOverride: {
      model: 'response-only-model',
      baseURL: 'https://gateway.example/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({ model: 'unused', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(requestUrl).toBe('https://gateway.example/v1/responses')
})

test('providerOverride custom OpenAI-compatible gpt effort uses legacy support', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-custom-openai',
        model: 'gpt-5.4',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'medium',
    providerOverride: {
      model: 'gpt-5.4',
      baseURL: 'https://custom-openai-compatible.example.test/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBe('medium')
})

test('providerOverride custom shims do not infer native Claude or Gemini effort', async () => {
  const requestBodies: Record<string, unknown>[] = []

  globalThis.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body))
    requestBodies.push(requestBody)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-native-name',
        model: requestBody.model,
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  for (const model of ['claude-opus-4-5', 'gemini-3-pro']) {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'medium',
      providerOverride: {
        model,
        baseURL: 'https://custom-openai-compatible.example.test/v1',
        apiKey: 'provider-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  }

  expect(requestBodies.map(body => body.model)).toEqual([
    'claude-opus-4-5',
    'gemini-3-pro',
  ])
  for (const requestBody of requestBodies) {
    expect(requestBody.reasoning_effort).toBeUndefined()
  }

  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  const forceEnabledGemini = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'medium',
    providerOverride: {
      model: 'gemini-3-pro',
      baseURL: 'https://custom-openai-compatible.example.test/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient
  await forceEnabledGemini.beta.messages.create({
    model: 'unused',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })
  expect(requestBodies).toHaveLength(3)
  expect(requestBodies[2]!.reasoning_effort).toBeUndefined()
})

test('NVIDIA NIM does not infer native Claude effort from the model name', async () => {
  let requestBody: Record<string, unknown> | undefined
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  process.env.NVIDIA_NIM = '1'
  process.env.NVIDIA_API_KEY = 'nvidia-test-key'
  process.env.OPENAI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
  process.env.OPENAI_MODEL = 'claude-opus-4-5'

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-nvidia-native-name',
        model: 'claude-opus-4-5',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'claude-opus-4-5',
    effortValue: 'medium',
  })) as unknown as ShimClient
  await client.beta.messages.create({
    model: 'claude-opus-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('OpenCode native endpoints preserve authorized Claude and Gemini effort', async () => {
  const requests: Array<{
    url: string
    body: Record<string, unknown>
  }> = []
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'opencode-test-key'
  process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/v1'

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    if (url.includes('/messages')) {
      return new Response(
        JSON.stringify({
          id: 'msg_opencode_effort',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-5',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 8, output_tokens: 3 },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 3,
          totalTokenCount: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  for (const model of ['claude-opus-4-5', 'gemini-3.1-pro']) {
    process.env.OPENAI_MODEL = model
    const client = (await getAnthropicClient({
      maxRetries: 0,
      model,
      effortValue: 'medium',
    })) as unknown as ShimClient
    await client.beta.messages.create({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  }

  expect(requests[0]?.url).toEndWith('/messages')
  expect(requests[0]?.body.effort).toBe('medium')
  expect(requests[1]?.url).toContain('/models/gemini-3.1-pro')
  expect(requests[1]?.body.generationConfig).toMatchObject({
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: 'medium',
    },
  })
})

test('force enable adds effort only for an otherwise unresolved custom shim model', async () => {
  const requestBodies: Record<string, unknown>[] = []

  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-force-effort',
        model: 'gateway-custom-model',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  for (const forceEnabled of [false, true]) {
    if (forceEnabled) {
      process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    } else {
      delete process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT
    }
    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'medium',
      providerOverride: {
        model: 'gateway-custom-model',
        baseURL: 'https://custom-openai-compatible.example.test/v1',
        apiKey: 'provider-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  }

  expect(requestBodies[0]?.reasoning_effort).toBeUndefined()
  expect(requestBodies[1]?.reasoning_effort).toBe('medium')
})

test('providerOverride third-party false beats force enable under a first-party parent', async () => {
  let requestBody: Record<string, unknown> | undefined
  delete process.env.CLAUDE_CODE_USE_GEMINI
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'gateway-custom-model'
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES = ''

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-force-false',
        model: 'gateway-custom-model',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'medium',
    providerOverride: {
      model: 'gateway-custom-model',
      baseURL: 'https://custom-openai-compatible.example.test/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('force enable respects a shim non-effort contract before request serialization', async () => {
  let requestBody: Record<string, unknown> | undefined
  process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-force-veto',
        model: 'gateway-custom-model',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as FetchType

  _clearRegistryForTesting()
  try {
    registerGateway({
      id: 'non-effort-transport-test',
      label: 'Non-effort Transport Test',
      defaultBaseUrl: 'https://non-effort-transport.example.test/v1',
      setup: { requiresAuth: true, authMode: 'api-key' },
      transportConfig: {
        kind: 'openai-compatible',
        openaiShim: { thinkingRequestFormat: 'none' },
      },
      catalog: { source: 'static', models: [] },
    })

    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'medium',
      providerOverride: {
        model: 'gateway-custom-model',
        baseURL: 'https://non-effort-transport.example.test/v1',
        apiKey: 'provider-test-key',
      },
    })) as unknown as ShimClient

    // Remove the synthetic route before serialization so no later request-body
    // cleanup can hide an incorrect reasoningEffort value captured by the client.
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()

    await client.beta.messages.create({
      model: 'unused',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } finally {
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  }

  expect(requestBody?.reasoning_effort).toBeUndefined()
})

test('providerOverride clamps stale effort against metadata levels', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-metadata-clamp',
        model: 'metadata-high-only-model',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  _clearRegistryForTesting()
  try {
    registerGateway({
      id: 'metadata-effort-test',
      label: 'Metadata Effort Test',
      defaultBaseUrl: 'https://metadata-effort.example.test/v1',
      setup: { requiresAuth: true, authMode: 'api-key' },
      transportConfig: { kind: 'openai-compatible' },
      catalog: {
        source: 'static',
        models: [
          {
            id: 'metadata-high-only-model',
            apiName: 'metadata-high-only-model',
            capabilities: { supportsReasoning: true },
            reasoning: {
              mode: 'levels',
              levels: ['high'],
              wireFormat: 'reasoning_effort',
            },
          },
        ],
      },
    })

    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'low',
      providerOverride: {
        model: 'metadata-high-only-model',
        baseURL: 'https://metadata-effort.example.test/v1',
        apiKey: 'provider-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } finally {
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  }

  expect(requestBody?.reasoning_effort).toBe('high')
})
test('providerOverride Atlas Kimi metadata emits top-level reasoning_effort and clamps unsupported levels', async () => {
  let requestBody: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-provider-override-atlas-kimi',
          model: 'moonshotai/kimi-k2.7-code',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'xhigh',
      providerOverride: {
        model: 'moonshotai/kimi-k2.7-code',
        baseURL: 'https://api.atlascloud.ai/v1',
        apiKey: 'atlas-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('high')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride Kimi Code clamps unsupported xhigh effort to high', async () => {
  let requestBody: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))

      return new Response(
        JSON.stringify({
          id: 'chatcmpl-provider-override-kimi-code',
          model: 'kimi-for-coding',
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
            total_tokens: 11,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as FetchType

    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'xhigh',
      providerOverride: {
        model: 'kimi-for-coding',
        baseURL: 'https://api.kimi.com/coding/v1',
        apiKey: 'kimi-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('high')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride K3 preserves max reasoning from its model query', async () => {
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: string | undefined

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-provider-override-k3',
      model: 'k3',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  try {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      providerOverride: {
        model: 'k3?reasoning=max',
        baseURL: 'https://api.kimi.com/coding/v1',
        apiKey: 'kimi-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('max')
    expect(requestBody?.model).toBe('k3')
    expect(requestUrl).toStartWith('https://api.kimi.com/coding/v1/')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride K3 maps xhigh effort to max', async () => {
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: string | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ id: 'chatcmpl-provider-override-k3-xhigh', model: 'k3', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType
  try {
    const client = (await getAnthropicClient({ maxRetries: 0, effortValue: 'xhigh', providerOverride: { model: 'k3', baseURL: 'https://api.kimi.com/coding/v1', apiKey: 'kimi-test-key' } })) as unknown as ShimClient
    await client.beta.messages.create({ model: 'unused', system: 'test system', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })
    expect(requestBody?.reasoning_effort).toBe('max')
    expect(requestBody?.model).toBe('k3')
    expect(requestUrl).toStartWith('https://api.kimi.com/coding/v1/')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride K3 leaves its default reasoning to the provider', async () => {
  let requestBody: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: 'chatcmpl-provider-override-k3-default',
        model: 'k3',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as FetchType

    const client = (await getAnthropicClient({
      maxRetries: 0,
      providerOverride: {
        model: 'k3',
        baseURL: 'https://api.kimi.com/coding/v1',
        apiKey: 'kimi-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride Hicap keeps multi-level max as xhigh on the wire', async () => {
  let requestBody: Record<string, unknown> | undefined
  const originalFetch = globalThis.fetch

  try {
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        id: 'chatcmpl-provider-override-hicap-max',
        model: 'claude-opus-4.8',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }), { headers: { 'Content-Type': 'application/json' } })
    }) as FetchType

    const client = (await getAnthropicClient({
      maxRetries: 0,
      effortValue: 'max',
      providerOverride: {
        model: 'claude-opus-4.8',
        baseURL: 'https://api.hicap.ai/v1',
        apiKey: 'hicap-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('xhigh')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride K3 preserves supported model-query reasoning', async () => {
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: string | undefined

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-provider-override-k3-low',
      model: 'k3',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  try {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      providerOverride: {
        model: 'k3?reasoning=low',
        baseURL: 'https://api.kimi.com/coding/v1',
        apiKey: 'kimi-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('low')
    expect(requestBody?.model).toBe('k3')
    expect(requestUrl).toStartWith('https://api.kimi.com/coding/v1/')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride K3 forwards disabled thinking to the Kimi API', async () => {
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-provider-override-k3-thinking-disabled',
      model: 'k3',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  try {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      providerOverride: {
        model: 'k3?thinking=disabled',
        baseURL: 'https://api.kimi.com/coding/v1',
        apiKey: 'kimi-test-key',
      },
    })) as unknown as ShimClient
    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.model).toBe('k3')
    expect(requestBody?.thinking).toEqual({ type: 'disabled' })
    expect(requestBody?.reasoning_effort).toBeUndefined()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('providerOverride direct Moonshot K3 preserves supported model-query reasoning', async () => {
  let requestBody: Record<string, unknown> | undefined
  let requestUrl: string | undefined

  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input)
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-provider-override-moonshot-k3',
      model: 'kimi-k3',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  try {
    const client = (await getAnthropicClient({
      maxRetries: 0,
      providerOverride: {
        model: 'kimi-k3?reasoning=low',
        baseURL: 'https://api.moonshot.ai/v1',
        apiKey: 'moonshot-test-key',
      },
    })) as unknown as ShimClient

    await client.beta.messages.create({
      model: 'unused',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })

    expect(requestBody?.reasoning_effort).toBe('low')
    expect(requestBody?.model).toBe('kimi-k3')
    expect(requestUrl).toStartWith('https://api.moonshot.ai/v1/')
  } finally {
    globalThis.fetch = originalFetch
  }
})
test('providerOverride Atlas Grok Build does not send reasoning effort', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-atlas-grok-build',
        model: 'xai/grok-build-0.1',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'high',
    providerOverride: {
      model: 'xai/grok-build-0.1',
      baseURL: 'https://api.atlascloud.ai/v1',
      apiKey: 'atlas-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.reasoning_effort).toBeUndefined()
})
test('providerOverride Groq DeepSeek does not receive stripped effort override', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-provider-override-groq',
        model: 'deepseek-r1-distill-llama-70b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    effortValue: 'xhigh',
    providerOverride: {
      model: 'deepseek-r1-distill-llama-70b',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey: 'provider-test-key',
    },
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'unused',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
    thinking: { type: 'enabled' },
  })

  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
})
test('rejects CRLF-injected custom headers before sending OpenAI-compatible shim requests', async () => {
  let capturedHeaders: Headers | undefined

  delete process.env.CLAUDE_CODE_USE_GEMINI
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_KEY = 'openai-test-key'
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
  process.env.ANTHROPIC_CUSTOM_HEADERS =
    'x-safe-header: keep-me\r\nx-injected: bad'

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-openai-crlf',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as FetchType

  const client = (await getAnthropicClient({
    maxRetries: 0,
    model: 'gpt-4o',
  })) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedHeaders?.get('x-safe-header')).toBeNull()
  expect(capturedHeaders?.get('x-injected')).toBeNull()
  expect(capturedHeaders?.get('authorization')).toBe('Bearer openai-test-key')
})
