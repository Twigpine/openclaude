import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { acquireEnvMutex, releaseEnvMutex } from '../entrypoints/sdk/shared.js'
import { resolveRouteCredentialValue } from '../integrations/routeMetadata.js'
import type { ProviderProfile } from './config.js'

async function importFreshProvidersModule() {
  return import(`./model/providers.ts?ts=${Date.now()}-${Math.random()}`)
}

const originalEnv = { ...process.env }
const originalCwd = process.cwd()
const originalFetch = globalThis.fetch

const RESTORED_KEYS = [
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
  'CLAUDE_CONFIG_DIR',
  'OPENCLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_FORMAT',
  'OPENAI_AZURE_STYLE',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'OPENAI_API_KEYS',
  'OPENAI_API_KEY',
  'GITHUB_COPILOT_KEY',
  'GITHUB_ENTERPRISE_URL',
  'CODEX_API_KEY',
  'CODEX_CREDENTIAL_SOURCE',
  'CHATGPT_ACCOUNT_ID',
  'CODEX_ACCOUNT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_VERTEX_BASE_URL',
  'GEMINI_BASE_URL',
  'GEMINI_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_AUTH_MODE',
  'GEMINI_ACCESS_TOKEN',
  'GOOGLE_API_KEY',
  'MISTRAL_BASE_URL',
  'MISTRAL_MODEL',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_API_KEY',
  'NVIDIA_NIM',
  'BANKR_BASE_URL',
  'BNKR_API_KEY',
  'BANKR_MODEL',
  'XAI_API_KEY',
  'AIMLAPI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'ATLAS_CLOUD_API_KEY',
  'APISMART_API_KEY',
  'APISMART_MODEL',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'LLMTR_API_KEY',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'CONCENTRATE_API_KEY',
  'CONCENTRATE_BASE_URL',
  'CONCENTRATE_MODEL',
  'CLINE_API_KEY',
  'HICAP_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
] as const

type MockConfigState = {
  providerProfiles: ProviderProfile[]
  activeProviderProfileId?: string
  openaiAdditionalModelOptionsCache: unknown[]
  openaiAdditionalModelOptionsCacheByProfile: Record<string, unknown[]>
  additionalModelOptionsCache?: unknown[]
  additionalModelOptionsCacheScope?: string
}

function createMockConfigState(): MockConfigState {
  return {
    providerProfiles: [],
    activeProviderProfileId: undefined,
    openaiAdditionalModelOptionsCache: [],
    openaiAdditionalModelOptionsCacheByProfile: {},
    additionalModelOptionsCache: [],
    additionalModelOptionsCacheScope: undefined,
  }
}

let mockConfigState: MockConfigState = createMockConfigState()
let testConfigDir: string | null = null

function saveMockGlobalConfig(
  updater: (current: MockConfigState) => MockConfigState,
): void {
  mockConfigState = updater(mockConfigState)
}

beforeEach(async () => {
  await acquireEnvMutex()
  for (const key of RESTORED_KEYS) {
    delete process.env[key]
  }
  testConfigDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
  process.env.CLAUDE_CONFIG_DIR = testConfigDir
  process.env.OPENCLAUDE_CONFIG_DIR = testConfigDir
})

afterEach(() => {
  try {
    for (const key of RESTORED_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }

    mock.restore()
    globalThis.fetch = originalFetch
    mockConfigState = createMockConfigState()
    process.chdir(originalCwd)
    if (testConfigDir) {
      rmSync(testConfigDir, { recursive: true, force: true })
      testConfigDir = null
    }
  } finally {
    releaseEnvMutex()
  }
})

async function importFreshProviderProfileModules() {
  mock.restore()
  const actualConfig = await import(`./config.js?ts=${Date.now()}-${Math.random()}`)
  mock.module('./config.js', () => ({
    ...actualConfig,
    // Spread the real config so the mock stays a COMPLETE GlobalConfig and only
    // the provider-profile fields are overridden. bun's mock.restore() does NOT
    // revert mock.module(), so this replacement leaks into later test files in
    // the same process; returning a partial object (missing e.g.
    // autoCompactEnabled) silently broke unrelated suites that read other config
    // fields via getGlobalConfig().
    getGlobalConfig: () => ({
      ...actualConfig.getGlobalConfig(),
      ...mockConfigState,
    }),
    saveGlobalConfig: (
      updater: (current: MockConfigState) => MockConfigState,
    ) => {
      mockConfigState = updater(mockConfigState)
    },
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const registry = await import('../integrations/registry.js')
  registry._clearRegistryForTesting()
  await import(`../integrations/index.js?ts=${nonce}`)
  const providers = await import(`./model/providers.js?ts=${nonce}`)
  const providerProfiles = await import(`./providerProfiles.js?ts=${nonce}`)

  return {
    ...providers,
    ...providerProfiles,
  }
}

function buildProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: 'provider_test',
    name: 'Test Provider',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o',
    ...overrides,
  }
}

function buildMistralProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'devstral-latest',
    ...overrides,
  })
}

function buildGeminiProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3-flash-preview',
    ...overrides,
  })
}

function buildXaiProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    apiKey: 'xai-test-key',
    ...overrides,
  })
}

function buildVeniceProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'venice',
    name: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    model: 'venice-uncensored',
    apiKey: 'venice-test-key',
    ...overrides,
  })
}

function buildXiaomiMimoProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'mimo-test-key',
    ...overrides,
  })
}

function buildXiaomiMimoTokenProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'xiaomi-mimo-token',
    name: 'Xiaomi MiMo Token Plan',
    baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    model: 'mimo-v2.5-pro',
    apiKey: 'tp-test-key',
    ...overrides,
  })
}

function buildFireworksProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'fireworks',
    name: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    model: 'accounts/fireworks/models/deepseek-v3',
    apiKey: 'fireworks-test-key',
    ...overrides,
  })
}

function buildAtlasCloudProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'atlas-cloud',
    name: 'Atlas Cloud',
    baseUrl: 'https://api.atlascloud.ai/v1',
    model: 'deepseek-ai/deepseek-v4-pro',
    apiKey: 'atlas-test-key',
    ...overrides,
  })
}

function buildApismartProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'apismart',
    name: 'ApiSmart',
    baseUrl: 'https://gw.apismart.ai/v1',
    model: 'DEEPSEEK_V4_FLASH',
    apiKey: 'apismart-test-key',
    ...overrides,
  })
}

function buildConcentrateProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'concentrate',
    name: 'Concentrate',
    baseUrl: 'https://api.concentrate.ai/v1',
    model: 'deepseek-v4-flash-0731',
    apiKey: 'concentrate-test-key',
    ...overrides,
  })
}

function buildApiRouteProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'api-route',
    name: 'API Route',
    baseUrl: 'https://global.api-route.com/v1',
    model: 'claude-sonnet-4-6',
    apiKey: 'api-route-test-key',
    ...overrides,
  })
}

function buildLlmtrProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'llmtr',
    name: 'LLMTR',
    baseUrl: 'https://llmtr.com/v1',
    model: 'deepseek/deepseek-v4-flash',
    apiKey: 'llmtr-test-key',
    ...overrides,
  })
}

function buildCommandcodeProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'commandcode',
    name: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    model: 'deepseek/deepseek-v4-flash',
    apiKey: 'cmd-test-key',
    ...overrides,
  })
}

function buildClinePassProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'clinepass',
    name: 'ClinePass',
    baseUrl: 'https://api.cline.bot/api/v1',
    model: 'cline-pass/deepseek-v4-flash',
    apiKey: 'cline-test-key',
    ...overrides,
  })
}

function buildCloudflareProfile(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return buildProfile({
    provider: 'cloudflare',
    name: 'Cloudflare Workers AI',
    // Account-scoped URL — users substitute `<ACCOUNT_ID>` for their account.
    // Tests use a literal id so host-matching for the descriptor is exercised.
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    apiKey: 'cloudflare-test-token',
    ...overrides,
  })
}

function buildOllamaProfile(
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return buildProfile({
    provider: 'ollama',
    name: 'Ollama',
    baseUrl: 'https://models.example.com/v1',
    model: 'deepseek-v4-flash:cloud',
    apiKey: '',
    ...overrides,
  })
}

describe('applyProviderProfileToProcessEnv', () => {
  test('marks a reverse-proxied Ollama profile for runtime discovery', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(buildOllamaProfile())

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://models.example.com/v1')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('ollama')
  }, 20_000)

  test('LLMTR profile clears an ambient dedicated key so its saved key wins', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.LLMTR_API_KEY = 'ambient-old'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'llmtr',
        name: 'LLMTR',
        baseUrl: 'https://llmtr.com/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: 'selected-new',
      }),
    )

    expect(process.env.LLMTR_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('selected-new')
    expect(
      resolveRouteCredentialValue({
        routeId: 'llmtr',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('selected-new')
  }, 20_000)

  test('API Route saved profile mirrors its dedicated credential and route identity', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'api-route',
        name: 'API Route',
        baseUrl: 'https://global.api-route.com/v1',
        model: 'saved-api-route-model',
        apiKey: 'saved-api-route-key',
      }),
    )

    expect(process.env.API_ROUTE_API_KEY).toBe('saved-api-route-key')
    expect(process.env.API_ROUTE_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
    expect(process.env.OPENAI_BASE_URL).toBe('https://global.api-route.com/v1')
    expect(process.env.OPENAI_API_KEY).toBe('saved-api-route-key')
    expect(process.env.OPENAI_MODEL).toBe('saved-api-route-model')
    expect(
      resolveRouteCredentialValue({
        routeId: 'api-route',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('saved-api-route-key')
  }, 20_000)

  test('API Route saved profile clears competing dedicated env and uses its saved key/model', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.API_ROUTE_API_KEY = 'ambient-api-route-key'
    process.env.API_ROUTE_MODEL = 'ambient-api-route-model'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'api-route',
        name: 'API Route',
        baseUrl: 'https://global.api-route.com/v1',
        model: 'saved-api-route-model',
        apiKey: 'saved-api-route-key',
      }),
    )

    expect(process.env.API_ROUTE_API_KEY).toBe('saved-api-route-key')
    expect(process.env.API_ROUTE_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
    expect(process.env.OPENAI_API_KEY).toBe('saved-api-route-key')
    expect(process.env.OPENAI_MODEL).toBe('saved-api-route-model')
    expect(
      resolveRouteCredentialValue({
        routeId: 'api-route',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('saved-api-route-key')
  }, 20_000)

  test('switching away from API Route clears dedicated route state', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.API_ROUTE_API_KEY = 'ambient-api-route-key'
    process.env.API_ROUTE_MODEL = 'ambient-api-route-model'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiKey: 'anthropic-key',
      }),
    )

    expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
    expect(process.env.API_ROUTE_MODEL).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBe('anthropic-key')
  }, 20_000)

  test('API Route profile without a base URL uses the canonical endpoint and ambient key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.API_ROUTE_API_KEY = 'ambient-api-route-key'

    applyProviderProfileToProcessEnv(
      buildApiRouteProfile({ baseUrl: undefined, apiKey: undefined }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://global.api-route.com/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ambient-api-route-key')
    expect(process.env.API_ROUTE_API_KEY).toBe('ambient-api-route-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
  }, 20_000)

  test('retargeted API Route profile withholds its dedicated credential and skips discovery', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('{}')))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const { setActiveProviderProfile } = await importFreshProviderProfileModules()
    const profile = buildApiRouteProfile({
      id: 'api_route_proxy',
      baseUrl: 'https://proxy.example/v1',
    })
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [profile],
    }))

    setActiveProviderProfile(profile.id, { configDir: testConfigDir ?? undefined })
    await Promise.resolve()

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
    expect(fetchMock).not.toHaveBeenCalled()

    const persisted = JSON.parse(
      readFileSync(join(testConfigDir!, '.openclaude-profile.json'), 'utf8'),
    )
    expect(persisted.env).toEqual({
      CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
      OPENAI_BASE_URL: 'https://proxy.example/v1',
      OPENAI_MODEL: 'claude-sonnet-4-6',
    })

    const { buildStartupEnvFromProfile } = await import(
      `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
    )
    const startupEnv = await buildStartupEnvFromProfile({
      persisted,
      processEnv: {
        API_ROUTE_API_KEY: 'ambient-api-route-key',
        OPENAI_API_KEY: 'ambient-api-route-key',
      },
    })
    expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
    expect(startupEnv.OPENAI_API_KEY).toBeUndefined()
    expect(startupEnv.API_ROUTE_API_KEY).toBeUndefined()
  }, 20_000)

  test('keyless canonical LLMTR profile adopts its ambient dedicated key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.LLMTR_API_KEY = 'ambient-llmtr-key'

    applyProviderProfileToProcessEnv(buildLlmtrProfile({ apiKey: undefined }))

    expect(process.env.LLMTR_API_KEY).toBe('ambient-llmtr-key')
    expect(process.env.OPENAI_API_KEY).toBe('ambient-llmtr-key')
    expect(
      resolveRouteCredentialValue({
        routeId: 'llmtr',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('ambient-llmtr-key')
  }, 20_000)

  test('Command Code profile persists its dedicated key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CMD_API_KEY = 'ambient-old'

    applyProviderProfileToProcessEnv(buildCommandcodeProfile())

    expect(process.env.CMD_API_KEY).toBe('cmd-test-key')
    expect(process.env.OPENAI_API_KEY).toBe('cmd-test-key')
    expect(
      resolveRouteCredentialValue({
        routeId: 'commandcode',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('cmd-test-key')
  }, 20_000)

  test('canonical generic OpenAI profile preserves legacy Command Code credential ownership', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        name: 'Legacy Command Code',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: 'legacy-cmd-key',
      }),
    )

    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('commandcode')
    expect(process.env.CMD_API_KEY).toBe('legacy-cmd-key')
    expect(
      resolveRouteCredentialValue({
        routeId: 'commandcode',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('legacy-cmd-key')
  }, 20_000)

  test('keyless canonical Command Code profile adopts its ambient dedicated key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CMD_API_KEY = 'ambient-cmd-key'

    applyProviderProfileToProcessEnv(buildCommandcodeProfile({ apiKey: undefined }))

    expect(process.env.CMD_API_KEY).toBe('ambient-cmd-key')
    expect(process.env.OPENAI_API_KEY).toBe('ambient-cmd-key')
    expect(
      resolveRouteCredentialValue({
        routeId: 'commandcode',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('ambient-cmd-key')
  }, 20_000)

  test('retargeted Command Code profile withholds its dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildCommandcodeProfile({ baseUrl: 'https://proxy.example/v1' }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CMD_API_KEY).toBeUndefined()
  })

  test('applies Azure-style routing from a saved OpenAI-compatible profile', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        baseUrl: 'https://apim.contoso.example/azure-openai',
        model: 'gpt-5.6-sol',
        apiKey: 'azure-key',
        azureStyle: true,
      }),
    )

    expect(process.env.OPENAI_AZURE_STYLE).toBe('1')
  }, 20_000)

  test('openai profile clears competing gemini/github flags', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.CLAUDE_CODE_USE_GITHUB = '1'

    applyProviderProfileToProcessEnv(buildProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'provider_test',
    )
    expect(getFreshAPIProvider()).toBe('openai')
  }, 20_000)

  test('mistral profile sets CLAUDE_CODE_USE_MISTRAL and clears openai flags', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    applyProviderProfileToProcessEnv(buildMistralProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_MISTRAL).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.MISTRAL_MODEL).toBe('devstral-latest')
    expect(getFreshAPIProvider()).toBe('mistral')
  })

  test('gemini profile sets CLAUDE_CODE_USE_GEMINI and clears openai flags', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    applyProviderProfileToProcessEnv(buildGeminiProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.GEMINI_MODEL).toBe('gemini-3-flash-preview')
    expect(getFreshAPIProvider()).toBe('gemini')
  })

  test('bedrock profile sets CLAUDE_CODE_USE_BEDROCK and preserves anthropic model routing', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'bedrock',
        baseUrl: 'https://bedrock-proxy.example',
        model: 'claude-sonnet-4-6',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BEDROCK_BASE_URL).toBe(
      'https://bedrock-proxy.example',
    )
    expect(getFreshAPIProvider()).toBe('bedrock')
  })

  test('github profile sets CLAUDE_CODE_USE_GITHUB instead of generic openai mode', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'github',
        baseUrl: 'https://models.github.ai/inference',
        model: 'github:copilot',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://models.github.ai/inference',
    )
    expect(process.env.OPENAI_MODEL).toBe('github:copilot')
    expect(getFreshAPIProvider()).toBe('github')
  })

  test('github-enterprise profile uses GitHub compatibility env', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'github-enterprise',
        baseUrl: 'https://github.mycompany.com/api/copilot',
        model: 'github:copilot:gpt-5.3-codex',
        apiKey: 'enterprise-profile-key',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()
    const { resolveProviderRequest } = await import(
      `../services/api/providerConfig.ts?ts=${Date.now()}-${Math.random()}`
    )

    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://github.mycompany.com/api/copilot',
    )
    expect(process.env.GITHUB_ENTERPRISE_URL).toBe(
      'https://github.mycompany.com',
    )
    expect(process.env.GITHUB_COPILOT_KEY).toBe('enterprise-profile-key')
    expect(process.env.OPENAI_MODEL).toBe('github:copilot:gpt-5.3-codex')
    expect(getFreshAPIProvider()).toBe('github')
    expect(resolveProviderRequest()).toMatchObject({
      baseUrl: 'https://github.mycompany.com/api/copilot',
      resolvedModel: 'gpt-5.3-codex',
      transport: 'codex_responses',
    })
  })

  test('github-enterprise profile does not derive Enterprise URL from public Copilot default', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'github-enterprise',
        baseUrl: 'https://api.githubcopilot.com',
        model: 'github:copilot:gpt-5.3-codex',
      }),
    )

    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.githubcopilot.com')
    expect(process.env.GITHUB_ENTERPRISE_URL).toBeUndefined()
  })

  test('github-enterprise profile remains aligned only with Enterprise env', async () => {
    const {
      applyActiveProviderProfileFromConfig,
      applyProviderProfileToProcessEnv,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'github_enterprise_prof',
      provider: 'github-enterprise',
      baseUrl: 'https://github.mycompany.com/api/copilot',
      model: 'github:copilot:gpt-5.3-codex',
      apiKey: 'enterprise-profile-key',
    })

    applyProviderProfileToProcessEnv(activeProfile)
    const unchanged = applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any)

    expect(unchanged?.id).toBe(activeProfile.id)
    expect(process.env.GITHUB_ENTERPRISE_URL).toBe(
      'https://github.mycompany.com',
    )

    delete process.env.GITHUB_ENTERPRISE_URL
    const updated = applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any)

    expect(updated?.id).toBe(activeProfile.id)
    expect(String(process.env.GITHUB_ENTERPRISE_URL)).toBe(
      'https://github.mycompany.com',
    )
  })

  test('github-enterprise profile persists and relaunches with Enterprise env', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const enterpriseProfile = buildProfile({
        id: 'github_enterprise_persisted',
        name: 'GitHub Enterprise',
        provider: 'github-enterprise',
        baseUrl: 'https://github.mycompany.com/api/copilot',
        model: 'github:copilot:gpt-5.3-codex',
        apiKey: 'enterprise-profile-key',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [enterpriseProfile],
      }))

      const result = setActiveProviderProfile('github_enterprise_persisted', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('github_enterprise_persisted')
      expect(persisted.profile).toBe('github-enterprise')
      expect(persisted.env).toMatchObject({
        GITHUB_ENTERPRISE_URL: 'https://github.mycompany.com',
        GITHUB_COPILOT_KEY: 'enterprise-profile-key',
        OPENAI_BASE_URL: 'https://github.mycompany.com/api/copilot',
        OPENAI_MODEL: 'github:copilot:gpt-5.3-codex',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('nvidia-nim profile keeps openai-compatible routing but stamps NVIDIA_NIM', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'nvidia-nim',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        model: 'nvidia/llama-3.1-nemotron-70b-instruct',
        apiKey: 'nvapi-test',
      }),
    )

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://integrate.api.nvidia.com/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe(
      'nvidia/llama-3.1-nemotron-70b-instruct',
    )
    expect(process.env.OPENAI_API_KEY).toBe('nvapi-test')
    expect(process.env.NVIDIA_API_KEY).toBe('nvapi-test')
    expect(process.env.NVIDIA_NIM).toBe('1')
  })

  test('provider profile apply clears stale codex-managed credentials', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CODEX_API_KEY = 'codex-stale'
    process.env.CODEX_CREDENTIAL_SOURCE = 'oauth'
    process.env.CHATGPT_ACCOUNT_ID = 'acct-stale'
    process.env.CODEX_ACCOUNT_ID = 'acct-stale-legacy'

    applyProviderProfileToProcessEnv(buildProfile())

    expect(process.env.CODEX_API_KEY).toBeUndefined()
    expect(process.env.CODEX_CREDENTIAL_SOURCE).toBeUndefined()
    expect(process.env.CHATGPT_ACCOUNT_ID).toBeUndefined()
    expect(process.env.CODEX_ACCOUNT_ID).toBeUndefined()
  })

  test('anthropic profile clears competing gemini/github flags', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    process.env.CLAUDE_CODE_USE_GITHUB = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(getFreshAPIProvider()).toBe('firstParty')
  })

  test('openai profile with multi-model string sets only first model in OPENAI_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'glm-4.7, glm-4.7-flash, glm-4.7-plus',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('glm-4.7')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  })

  test('openai profile with semicolon-separated multi-model string sets only first model in OPENAI_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'glm-4.7; glm-4.7-flash; glm-4.7-plus',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('glm-4.7')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
  })

  test('openai responses profile sets OPENAI_API_FORMAT', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        apiFormat: 'responses',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('gpt-5.4')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('openai responses_compat profile sets OPENAI_API_FORMAT', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4',
        apiFormat: 'responses_compat',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('gpt-5.4')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses_compat')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('custom OpenAI-compatible responses profile sets OPENAI_API_FORMAT', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
        model: 'custom-responses-model',
        apiFormat: 'responses',
      }),
    )

    expect(process.env.OPENAI_MODEL).toBe('custom-responses-model')
    expect(process.env.OPENAI_BASE_URL).toBe('https://custom.example/v1')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('openai profile sets custom auth header name and value', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.hicap.ai/v1',
        model: 'claude-opus-4.8',
        authHeader: 'api-key',
        authScheme: 'raw',
        authHeaderValue: 'hicap-header-value',
      }),
    )

    expect(process.env.OPENAI_AUTH_HEADER).toBe('api-key')
    expect(process.env.OPENAI_AUTH_SCHEME).toBe('raw')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('hicap-header-value')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
  })

  test('minimax profile ignores advanced OpenAI-compatible auth settings', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.OPENAI_AZURE_STYLE = '1'

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'minimax',
        baseUrl: 'https://api.minimax.io/anthropic',
        model: 'MiniMax-M2.7',
        apiKey: 'minimax-live-key',
        apiFormat: 'responses',
        authHeader: 'api-key',
        authScheme: 'raw',
        authHeaderValue: 'minimax-header-value',
        customHeaders: {
          'X-Team': 'devtools',
        },
      }),
    )

    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic')
    expect(process.env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7')
    expect(process.env.ANTHROPIC_API_KEY).toBe('minimax-live-key')
    expect(process.env.MINIMAX_API_KEY).toBe('minimax-live-key')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AZURE_STYLE).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('venice profile applies OpenAI-compatible env with VENICE_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildVeniceProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.venice.ai/api/v1')
    expect(process.env.OPENAI_MODEL).toBe('venice-uncensored')
    expect(process.env.OPENAI_API_KEY).toBe('venice-test-key')
    expect(process.env.VENICE_API_KEY).toBe('venice-test-key')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('xiaomi mimo profile applies OpenAI-compatible env with MIMO_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildXiaomiMimoProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.xiaomimimo.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('mimo-v2.5-pro')
    expect(process.env.OPENAI_API_KEY).toBe('mimo-test-key')
    expect(process.env.MIMO_API_KEY).toBe('mimo-test-key')
    expect(getFreshAPIProvider()).toBe('xiaomi-mimo')
  })

  test('atlas cloud profile applies OpenAI-compatible env with ATLAS_CLOUD_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildAtlasCloudProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.atlascloud.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-ai/deepseek-v4-pro')
    expect(process.env.OPENAI_API_KEY).toBe('atlas-test-key')
    expect(process.env.ATLAS_CLOUD_API_KEY).toBe('atlas-test-key')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('apismart profile applies OpenAI-compatible env with APISMART_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildApismartProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('DEEPSEEK_V4_FLASH')
    expect(process.env.OPENAI_API_KEY).toBe('apismart-test-key')
    expect(process.env.APISMART_API_KEY).toBe('apismart-test-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('apismart profile clears a stale route-specific model before applying its saved model', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.APISMART_MODEL = 'KIMI_K3'

    applyProviderProfileToProcessEnv(buildApismartProfile())

    expect(process.env.APISMART_MODEL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('DEEPSEEK_V4_FLASH')
  })

  test('apismart profile without a base URL retains its dedicated credential for the default route', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(buildApismartProfile({ baseUrl: undefined }))

    expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1')
    expect(process.env.OPENAI_API_KEY).toBe('apismart-test-key')
    expect(process.env.APISMART_API_KEY).toBe('apismart-test-key')
  })

  test('retargeted ApiSmart profile withholds its dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildApismartProfile({ baseUrl: 'https://proxy.example/v1' }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  })

  test('keyless ApiSmart profile resolves APISMART_API_KEY without persisting it', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.APISMART_API_KEY = 'ambient-apismart-key'

    applyProviderProfileToProcessEnv(
      buildApismartProfile({
        apiKey: undefined,
        baseUrl: 'https://gw.apismart.ai/v1',
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBe('ambient-apismart-key')
    expect(process.env.APISMART_API_KEY).toBe('ambient-apismart-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  }, 20_000)

  test('keyless ApiSmart profile without a base URL resolves the ambient key as canonical', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.APISMART_API_KEY = 'ambient-apismart-key'

    applyProviderProfileToProcessEnv(
      buildApismartProfile({
        apiKey: undefined,
        baseUrl: undefined,
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/v1')
    expect(process.env.OPENAI_API_KEY).toBe('ambient-apismart-key')
    expect(process.env.APISMART_API_KEY).toBe('ambient-apismart-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  }, 20_000)

  test('keyless canonical ApiSmart profile never promotes a generic OpenAI key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEY = 'generic-openai-key'

    applyProviderProfileToProcessEnv(
      buildApismartProfile({
        apiKey: undefined,
        baseUrl: 'https://gw.apismart.ai/v1',
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  }, 20_000)

  test('keyless custom ApiSmart profile preserves route identity without forwarding the ambient key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.APISMART_API_KEY = 'ambient-apismart-key'
    process.env.OPENAI_API_KEY = 'ambient-apismart-key'

    applyProviderProfileToProcessEnv(
      buildApismartProfile({
        apiKey: undefined,
        baseUrl: 'https://proxy.example.com/v1',
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example.com/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  }, 20_000)

  test('non-canonical ApiSmart host path withholds the dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildApismartProfile({ baseUrl: 'https://gw.apismart.ai/staging/v1' }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://gw.apismart.ai/staging/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.APISMART_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
  })

  test('concentrate profile applies OpenAI-compatible env with CONCENTRATE_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildConcentrateProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-flash-0731')
    expect(process.env.OPENAI_API_KEY).toBe('concentrate-test-key')
    expect(process.env.CONCENTRATE_API_KEY).toBe('concentrate-test-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('generic OpenAI profile at the canonical Concentrate endpoint keeps its credential generic', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const { getProviderValidationError } = await import(
      `./providerValidation.js?ts=${Date.now()}-${Math.random()}`
    )

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.concentrate.ai/v1',
        model: 'deepseek-v4-flash-0731',
        apiKey: 'generic-concentrate-key',
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBe('generic-concentrate-key')
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(await getProviderValidationError(process.env)).toBeNull()
  })

  test('concentrate profile clears a stale route-specific model before applying its saved model', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CONCENTRATE_MODEL = 'claude-sonnet-5'

    applyProviderProfileToProcessEnv(buildConcentrateProfile())

    expect(process.env.CONCENTRATE_MODEL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('deepseek-v4-flash-0731')
  })

  test('concentrate profile without a base URL retains its dedicated credential for the default route', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildConcentrateProfile({ baseUrl: undefined }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.concentrate.ai/v1')
    expect(process.env.OPENAI_API_KEY).toBe('concentrate-test-key')
    expect(process.env.CONCENTRATE_API_KEY).toBe('concentrate-test-key')
  })

  test('retargeted Concentrate profile withholds its dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildConcentrateProfile({ baseUrl: 'https://proxy.example/v1' }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
  })

  test('retargeted Concentrate profiles retain generic proxy capabilities', async () => {
    const { addProviderProfile, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    const saved = addProviderProfile({
      provider: 'concentrate',
      name: 'Concentrate proxy',
      baseUrl: 'https://proxy.example/v1',
      model: 'proxy-model',
      apiKey: 'concentrate-test-key',
      apiFormat: 'responses',
      authHeader: 'X-Proxy-Key',
      authScheme: 'raw',
      authHeaderValue: 'proxy-auth-value',
      customHeaders: { 'X-Proxy-Trace': 'enabled' },
    })

    expect(saved).toMatchObject({
      apiFormat: 'responses',
      authHeader: 'X-Proxy-Key',
      authScheme: 'raw',
      authHeaderValue: 'proxy-auth-value',
      customHeaders: { 'X-Proxy-Trace': 'enabled' },
    })

    applyProviderProfileToProcessEnv(saved!)

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(process.env.OPENAI_AUTH_HEADER).toBe('X-Proxy-Key')
    expect(process.env.OPENAI_AUTH_SCHEME).toBe('raw')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('proxy-auth-value')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Proxy-Trace: enabled',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
  })

  test('keyless Concentrate profile resolves CONCENTRATE_API_KEY without persisting it', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CONCENTRATE_API_KEY = 'ambient-concentrate-key'

    applyProviderProfileToProcessEnv(
      buildConcentrateProfile({
        apiKey: undefined,
        baseUrl: 'https://api.concentrate.ai/v1',
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBe('ambient-concentrate-key')
    expect(process.env.CONCENTRATE_API_KEY).toBe('ambient-concentrate-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
  }, 20_000)

  test('keyless canonical Concentrate profile never promotes a generic OpenAI key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEY = 'generic-openai-key'

    applyProviderProfileToProcessEnv(
      buildConcentrateProfile({
        apiKey: undefined,
        baseUrl: 'https://api.concentrate.ai/v1',
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
  }, 20_000)

  test('non-canonical Concentrate host path withholds the dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildConcentrateProfile({
        baseUrl: 'https://api.concentrate.ai/staging/v1',
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.concentrate.ai/staging/v1',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CONCENTRATE_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
  })

  test.each(['SUA_CHAVE', 'sua_chave', 'null', 'undefined', ' NULL '])(
    'addProviderProfile drops placeholder Concentrate credential %s',
    async placeholder => {
      const { addProviderProfile, getProviderProfiles } =
        await importFreshProviderProfileModules()

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [],
        activeProviderProfileId: undefined,
      }))

      const saved = addProviderProfile({
        provider: 'concentrate',
        name: 'Concentrate',
        baseUrl: 'https://api.concentrate.ai/v1',
        model: 'deepseek-v4-flash-0731',
        apiKey: placeholder,
      })

      expect(saved?.apiKey).toBeUndefined()
      expect(getProviderProfiles()[0]?.apiKey).toBeUndefined()
    },
  )

  test.each(['SUA_CHAVE', 'sua_chave', 'null', 'undefined', ' NULL '])(
    'addProviderProfile drops placeholder ApiSmart credential %s',
    async placeholder => {
      const { addProviderProfile, getProviderProfiles } =
        await importFreshProviderProfileModules()

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [],
        activeProviderProfileId: undefined,
      }))

      const saved = addProviderProfile({
        provider: 'apismart',
        name: 'ApiSmart',
        baseUrl: 'https://gw.apismart.ai/v1',
        model: 'DEEPSEEK_V4_FLASH',
        apiKey: placeholder,
      })

      expect(saved?.apiKey).toBeUndefined()
      expect(getProviderProfiles()[0]?.apiKey).toBeUndefined()
    },
  )

  test('addProviderProfile rejects Claude and alias models on canonical Command Code', async () => {
    const { addProviderProfile, getProviderProfiles } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'sonnet, deepseek/deepseek-v4-flash',
      apiKey: 'cmd-test-key',
    })

    expect(saved).toBeNull()
    expect(getProviderProfiles()).toEqual([])
  })

  test('addProviderProfile rejects decorated Claude aliases before persistence', async () => {
    const { addProviderProfile, getProviderProfiles } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'sonnet?reasoning=high',
      apiKey: 'cmd-test-key',
    })

    expect(saved).toBeNull()
    expect(getProviderProfiles()).toEqual([])
  })

  test('addProviderProfile captures CMD_API_KEY when Command Code env adoption omits apiKey', async () => {
    const { addProviderProfile, getProviderProfiles } =
      await importFreshProviderProfileModules()
    process.env.CMD_API_KEY = 'env-cmd-key'
    process.env.OPENAI_API_KEY = 'generic-openai-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
    })

    expect(saved?.apiKey).toBe('env-cmd-key')
    expect(getProviderProfiles()[0]?.apiKey).toBe('env-cmd-key')
  })

  test('addProviderProfile prefers CMD_API_KEY over a leftover generic OPENAI_API_KEY', async () => {
    const { addProviderProfile } = await importFreshProviderProfileModules()
    process.env.CMD_API_KEY = 'env-cmd-key'
    process.env.OPENAI_API_KEY = 'generic-openai-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile(
      {
        provider: 'commandcode',
        name: 'Command Code',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: process.env.OPENAI_API_KEY,
      },
      { credentialSource: 'environment' },
    )

    expect(saved?.apiKey).toBe('env-cmd-key')
  })

  test('environment adoption never promotes a generic OpenAI key to Command Code auth', async () => {
    const { addProviderProfile, getProviderProfiles } =
      await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEY = 'generic-openai-secret'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile(
      {
        provider: 'commandcode',
        name: 'Command Code',
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4-flash',
        apiKey: process.env.OPENAI_API_KEY,
      },
      { credentialSource: 'environment' },
    )

    expect(saved).toBeNull()
    expect(getProviderProfiles()).toEqual([])
    expect(process.env.CMD_API_KEY).toBeUndefined()
  })

  test('explicit Command Code setup preserves its input over a stale ambient dedicated key', async () => {
    const { addProviderProfile } = await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEY = 'same-value-as-explicit-input'
    process.env.CMD_API_KEY = 'stale-commandcode-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'same-value-as-explicit-input',
    })

    expect(saved?.apiKey).toBe('same-value-as-explicit-input')
  })

  test('addProviderProfile captures COMMANDCODE_API_KEY when CMD_API_KEY is unset', async () => {
    const { addProviderProfile } = await importFreshProviderProfileModules()
    process.env.COMMANDCODE_API_KEY = 'env-commandcode-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
    })

    expect(saved?.apiKey).toBe('env-commandcode-key')
  })

  test('addProviderProfile captures the official Command Code client key', async () => {
    const { addProviderProfile } = await importFreshProviderProfileModules()
    process.env.COMMAND_CODE_API_KEY = 'official-command-code-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
    })

    expect(saved?.apiKey).toBe('official-command-code-key')
  })

  test('updateProviderProfile captures dedicated Command Code env when refreshing a keyless profile', async () => {
    const { addProviderProfile, updateProviderProfile } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'cmd-test-key',
    })
    expect(saved?.id).toBeTruthy()

    process.env.CMD_API_KEY = 'rotated-cmd-key'
    const refreshed = updateProviderProfile(saved!.id, {
      provider: 'commandcode',
      name: saved!.name,
      baseUrl: saved!.baseUrl,
      model: saved!.model,
    })

    expect(refreshed?.apiKey).toBe('rotated-cmd-key')
  })

  test('rejected Command Code environment refresh leaves the saved profile unchanged', async () => {
    const { addProviderProfile, getProviderProfiles, updateProviderProfile } =
      await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code',
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      model: 'deepseek/deepseek-v4-flash',
      apiKey: 'saved-commandcode-key',
    })
    delete process.env.CMD_API_KEY
    delete process.env.COMMANDCODE_API_KEY
    process.env.OPENAI_API_KEY = 'generic-openai-secret'

    const refreshed = updateProviderProfile(
      saved!.id,
      { ...saved!, apiKey: process.env.OPENAI_API_KEY },
      { credentialSource: 'environment' },
    )

    expect(refreshed).toBeNull()
    expect(getProviderProfiles()[0]?.apiKey).toBe('saved-commandcode-key')
    expect(process.env.CMD_API_KEY).toBeUndefined()
  })

  test('addProviderProfile does not apply Command Code write rules to a retargeted URL', async () => {
    const { addProviderProfile } = await importFreshProviderProfileModules()
    process.env.CMD_API_KEY = 'env-cmd-key'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))

    const saved = addProviderProfile({
      provider: 'commandcode',
      name: 'Command Code proxy',
      baseUrl: 'https://proxy.example/v1',
      model: 'sonnet',
    })

    expect(saved).toMatchObject({
      baseUrl: 'https://proxy.example/v1',
      model: 'sonnet',
    })
    expect(saved?.apiKey).toBeUndefined()
  })

  test('cloudflare profile applies OpenAI-compatible env with CLOUDFLARE_API_TOKEN mirror', async () => {
    // Account-scoped URL: a real user has substituted `<ACCOUNT_ID>` for their
    // Cloudflare account id. The env-build path should mirror the api key into
    // `CLOUDFLARE_API_TOKEN` so the descriptor's host-based route detection
    // picks the cloudflare preset back up on the next reload.
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildCloudflareProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe(
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    )
    expect(process.env.OPENAI_API_KEY).toBe('cloudflare-test-token')
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('cloudflare-test-token')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('cloudflare profile retargeted to the shared AI Gateway host does not mirror CLOUDFLARE_API_TOKEN', async () => {
    // gateway.ai.cloudflare.com is a shared AI Gateway host that fronts other
    // providers (openai/anthropic/...). A cloudflare profile keeps
    // routeId === 'cloudflare', but the token must NOT be mirrored when the
    // base URL is the shared gateway, otherwise the profile stays tied to the
    // cloudflare route through the descriptor's host-based detection.
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildCloudflareProfile({
        baseUrl:
          'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai',
      }),
    )

    expect(process.env.CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('cloudflare-test-token')
  })

  test('cloudflare profile retargeted off Workers AI keeps generic OpenAI-compatible capabilities', async () => {
    // The Cloudflare route strips apiFormat/custom-auth/custom-header options
    // (Workers AI has a fixed transport). Once the base URL is retargeted away
    // from the real Workers AI endpoint, the runtime runs it as a generic
    // OpenAI-compatible route, so profile capability resolution must fall back
    // to the generic route and preserve those options instead of dropping them
    // based on the stale cloudflare route id.
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildCloudflareProfile({
        baseUrl:
          'https://gateway.ai.cloudflare.com/v1/abc123/my-gateway/openai',
        apiFormat: 'responses',
      }),
    )

    // apiFormat survives because the retargeted profile resolves to a generic
    // OpenAI-compatible route (which supports format selection), not cloudflare.
    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    // …and the Cloudflare token is still not mirrored to a non-Workers host.
    expect(process.env.CLOUDFLARE_API_TOKEN).toBeUndefined()
  })

  test('cloudflare profile on a non-Workers api.cloudflare.com path does not mirror CLOUDFLARE_API_TOKEN', async () => {
    // Same api.cloudflare.com host, but the REST management path — NOT Workers
    // AI. The mirror is gated on the isCloudflareBaseUrl path predicate, so the
    // token must not be attached to this non-Workers endpoint even though the
    // host matches.
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildCloudflareProfile({
        baseUrl: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
      }),
    )

    expect(process.env.CLOUDFLARE_API_TOKEN).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('cloudflare-test-token')
  })

  test('cloudflare profile on a non-Workers api.cloudflare.com path does not persist CLOUDFLARE_API_TOKEN', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const nonWorkersProfile = buildCloudflareProfile({
        id: 'cloudflare_non_workers',
        baseUrl: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [nonWorkersProfile],
      }))

      const result = setActiveProviderProfile('cloudflare_non_workers', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('cloudflare_non_workers')
      // The base URL / key are still persisted, but the dedicated Workers AI
      // token must not be, since this is not a Workers AI endpoint.
      expect(persisted.env.OPENAI_API_KEY).toBe('cloudflare-test-token')
      expect(persisted.env.CLOUDFLARE_API_TOKEN).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('xiaomi mimo profile normalizes stale docs endpoint to resolving API host', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(buildXiaomiMimoProfile({
      baseUrl: 'https://api.mimo-v2.com/v1',
    }))
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.xiaomimimo.com/v1')
    expect(process.env.MIMO_API_KEY).toBe('mimo-test-key')
    expect(getFreshAPIProvider()).toBe('xiaomi-mimo')
  })

  test('xiaomi mimo token plan profile applies OpenAI-compatible env with MIMO_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildXiaomiMimoTokenProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://token-plan-sgp.xiaomimimo.com/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('mimo-v2.5-pro')
    expect(process.env.OPENAI_API_KEY).toBe('tp-test-key')
    expect(process.env.MIMO_API_KEY).toBe('tp-test-key')
    expect(getFreshAPIProvider()).toBe('xiaomi-mimo')
  })

  test('xiaomi mimo token plan CN profile applies OpenAI-compatible env with MIMO_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildXiaomiMimoTokenProfile({
      baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    }))
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://token-plan-cn.xiaomimimo.com/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('mimo-v2.5-pro')
    expect(process.env.OPENAI_API_KEY).toBe('tp-test-key')
    expect(process.env.MIMO_API_KEY).toBe('tp-test-key')
    expect(getFreshAPIProvider()).toBe('xiaomi-mimo')
  })

  test('fireworks profile applies OpenAI-compatible env with FIREWORKS_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildFireworksProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.fireworks.ai/inference/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe(
      'accounts/fireworks/models/deepseek-v3',
    )
    expect(process.env.OPENAI_API_KEY).toBe('fireworks-test-key')
    expect(process.env.FIREWORKS_API_KEY).toBe('fireworks-test-key')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('aimlapi profile applies OpenAI-compatible env with AIMLAPI_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        name: 'AI/ML API',
        provider: 'aimlapi',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-test-key',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.aimlapi.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(process.env.OPENAI_API_KEY).toBe('aimlapi-test-key')
    expect(process.env.AIMLAPI_API_KEY).toBe('aimlapi-test-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
    expect(getFreshAPIProvider()).toBe('openai')
  }, 20_000)

  test('keyless custom AIMLAPI profile preserves route identity without forwarding the ambient key', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEY = 'ambient-openai-key'

    applyProviderProfileToProcessEnv(
      buildProfile({
        name: 'AI/ML API Proxy',
        provider: 'aimlapi',
        baseUrl: 'https://proxy.example.com/v1',
        model: 'gpt-4o',
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    // The base URL is a user-controlled proxy, not the canonical inference
    // host, so the canonical AIMLAPI credential must not be forwarded to it.
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.AIMLAPI_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
  }, 20_000)

  test('keyless AIMLAPI profile resolves AIMLAPI_API_KEY without persisting it', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.AIMLAPI_API_KEY = 'ambient-aimlapi-key'

    applyProviderProfileToProcessEnv(
      buildProfile({
        name: 'AI/ML API',
        provider: 'aimlapi',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: undefined,
      }),
    )

    expect(process.env.OPENAI_API_KEY).toBe('ambient-aimlapi-key')
    expect(process.env.AIMLAPI_API_KEY).toBe('ambient-aimlapi-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
  }, 20_000)

  test('keyless AIMLAPI profile without a base URL resolves the ambient key as canonical', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.AIMLAPI_API_KEY = 'ambient-aimlapi-key'

    // A missing base URL resolves to the canonical aimlapi default; the guard
    // must treat it as canonical rather than crash on undefined.trim().
    applyProviderProfileToProcessEnv(
      buildProfile({
        name: 'AI/ML API',
        provider: 'aimlapi',
        baseUrl: undefined,
        model: 'gpt-4o',
        apiKey: undefined,
      }),
    )

    expect(process.env.AIMLAPI_API_KEY).toBe('ambient-aimlapi-key')
    expect(process.env.OPENAI_API_KEY).toBe('ambient-aimlapi-key')
    expect(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
  }, 20_000)

  test('openai profile on AI/ML API route mirrors AIMLAPI_API_KEY', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-test-key',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.aimlapi.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(process.env.OPENAI_API_KEY).toBe('aimlapi-test-key')
    expect(process.env.AIMLAPI_API_KEY).toBe('aimlapi-test-key')
    expect(getFreshAPIProvider()).toBe('openai')
  }, 20_000)

  test('ClinePass preset profile applies OpenAI-compatible env with CLINE_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GEMINI = '1'

    applyProviderProfileToProcessEnv(buildClinePassProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.cline.bot/api/v1')
    expect(process.env.OPENAI_MODEL).toBe('cline-pass/deepseek-v4-flash')
    expect(process.env.OPENAI_API_KEY).toBe('cline-test-key')
    expect(process.env.CLINE_API_KEY).toBe('cline-test-key')
    expect(getFreshAPIProvider()).toBe('openai')
  })

  test('custom openai profile targeting ClinePass base URL applies CLINE_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        name: 'Custom ClinePass',
        baseUrl: 'https://api.cline.bot/api/v1',
        model: 'cline-pass/qwen3.7-max',
        apiKey: 'custom-cline-key',
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.cline.bot/api/v1')
    expect(process.env.OPENAI_MODEL).toBe('cline-pass/qwen3.7-max')
    expect(process.env.OPENAI_API_KEY).toBe('custom-cline-key')
    expect(process.env.CLINE_API_KEY).toBe('custom-cline-key')
  })

  test('ClinePass provider with custom base URL applies CLINE_API_KEY mirror', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'clinepass',
        name: 'ClinePass Custom',
        baseUrl: 'https://custom.cline.bot/v1',
        model: 'cline-pass/qwen3.7-max',
        apiKey: 'custom-cline-key',
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://custom.cline.bot/v1')
    expect(process.env.OPENAI_MODEL).toBe('cline-pass/qwen3.7-max')
    expect(process.env.OPENAI_API_KEY).toBe('custom-cline-key')
    expect(process.env.CLINE_API_KEY).toBe('custom-cline-key')
  })

  test('legacy OpenAI profile on restricted route ignores advanced settings', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.kimi.com/coding/v1',
        model: 'kimi-for-coding',
        apiKey: 'kimi-live-key',
        apiFormat: 'responses',
        authHeader: 'api-key',
        authScheme: 'raw',
        authHeaderValue: 'kimi-header-value',
        customHeaders: {
          'X-Team': 'devtools',
        },
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://api.kimi.com/coding/v1')
    expect(process.env.OPENAI_MODEL).toBe('kimi-for-coding')
    expect(process.env.OPENAI_API_KEY).toBe('kimi-live-key')
    expect(process.env.OPENAI_API_FORMAT).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER).toBeUndefined()
    expect(process.env.OPENAI_AUTH_SCHEME).toBeUndefined()
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBeUndefined()
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('supported routes apply sanitized profile custom headers to env', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
        customHeaders: {
          'X-Team': 'devtools',
          'X-Trace': 'enabled',
        },
      }),
    )

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Team: devtools\nX-Trace: enabled',
    )
  })

  test('supported routes still reject managed custom headers', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'custom',
        baseUrl: 'https://custom.example/v1',
        customHeaders: {
          'api-key': 'managed-provider-key',
          'X-Team': 'devtools',
        },
      }),
    )

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('unsupported routes do not apply profile custom headers to env', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        customHeaders: {
          'X-Team': 'devtools',
        },
      }),
    )

    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
  })

  test('anthropic profile with multi-model string sets only first model in ANTHROPIC_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6, claude-opus-4-6',
      }),
    )

    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
  })

  test('gemini profile with semicolon-separated multi-model string sets only first model in GEMINI_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildGeminiProfile({
        model: 'gemini-3-flash-preview; gemini-3-pro-preview',
      }),
    )

    expect(process.env.GEMINI_MODEL).toBe('gemini-3-flash-preview')
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBe('1')
  })

  test('mistral profile with semicolon-separated multi-model string sets only first model in MISTRAL_MODEL', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildMistralProfile({
        model: 'devstral-latest; mistral-medium-latest',
      }),
    )

    expect(process.env.MISTRAL_MODEL).toBe('devstral-latest')
    expect(process.env.CLAUDE_CODE_USE_MISTRAL).toBe('1')
  })

  test('xai profile sets XAI_API_KEY and getAPIProvider returns xai', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(buildXaiProfile())
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(String(process.env.XAI_API_KEY)).toBe('xai-test-key')
    expect(getFreshAPIProvider()).toBe('xai')
  })

  test('does not mirror XAI_API_KEY for a lookalike host containing "x.ai"', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    // `vertex.ai` contains the substring "x.ai"; a raw includes() check would
    // wrongly treat this OpenAI-compatible profile as xAI and mirror the key
    // into XAI_API_KEY. Host matching must be by hostname (api.x.ai), not
    // substring.
    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://vertex.ai/v1',
        model: 'some-model',
        apiKey: 'not-an-xai-key',
      }),
    )
    const { getAPIProvider: getFreshAPIProvider } =
      await importFreshProvidersModule()

    expect(process.env.XAI_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBe('not-an-xai-key')
    expect(getFreshAPIProvider()).not.toBe('xai')
  })

  test('openai-compatible profile applies maxContextLength to every configured model', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const { resolveModelRuntimeLimits } = await import(
      '../integrations/runtimeMetadata.js'
    )

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'custom',
        baseUrl: 'http://localhost:4000/v1',
        model: 'local-large, local-small; local-reasoning',
        maxContextLength: 200_000,
      }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(process.env.OPENAI_MODEL).toBe('local-large')
    expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBe(
      JSON.stringify({
        'local-large': 200_000,
        'local-small': 200_000,
        'local-reasoning': 200_000,
      }),
    )
    expect(
      resolveModelRuntimeLimits({
        model: 'local-small',
        processEnv: process.env,
      }).contextWindow,
    ).toBe(200_000)
  })

  test('openai-compatible profile switch clears previous same-model context override', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const { resolveModelRuntimeLimits } = await import(
      '../integrations/runtimeMetadata.js'
    )

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'custom',
        baseUrl: 'http://localhost:4000/v1',
        model: 'gpt-4o',
        maxContextLength: 1_000_000,
      }),
    )
    expect(
      resolveModelRuntimeLimits({
        model: 'gpt-4o',
        processEnv: process.env,
      }).contextWindow,
    ).toBe(1_000_000)

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      }),
    )

    expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBeUndefined()
    expect(
      resolveModelRuntimeLimits({
        model: 'gpt-4o',
        processEnv: process.env,
      }).contextWindow,
    ).not.toBe(1_000_000)
  })

  test('non-openai-compatible profile ignores maxContextLength override', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildProfile({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        maxContextLength: 200_000,
      }),
    )

    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBeUndefined()
  })

  test('retargeted LLMTR profile withholds its dedicated credential', async () => {
    const { applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    applyProviderProfileToProcessEnv(
      buildLlmtrProfile({ baseUrl: 'https://proxy.example/v1' }),
    )

    expect(process.env.OPENAI_BASE_URL).toBe('https://proxy.example/v1')
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.LLMTR_API_KEY).toBeUndefined()
  })

  test('query-bearing LLMTR profiles retain generic proxy capabilities', async () => {
    const { addProviderProfile, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    process.env.LLMTR_API_KEY = 'ambient-llmtr-key'

    const saved = addProviderProfile({
      provider: 'llmtr',
      name: 'LLMTR query proxy',
      baseUrl: 'https://llmtr.com/v1?tenant=proxy',
      model: 'proxy-model',
      apiKey: 'saved-llmtr-key',
      apiFormat: 'responses',
      authHeader: 'X-Proxy-Key',
      authScheme: 'raw',
      authHeaderValue: 'proxy-auth-value',
      customHeaders: { 'X-Proxy-Trace': 'enabled' },
    })

    applyProviderProfileToProcessEnv(saved!)

    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(process.env.OPENAI_AUTH_HEADER).toBe('X-Proxy-Key')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('proxy-auth-value')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Proxy-Trace: enabled',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.LLMTR_API_KEY).toBeUndefined()
  })

  test('retargeted LLMTR profiles retain generic proxy capabilities', async () => {
    const { addProviderProfile, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()

    const saved = addProviderProfile({
      provider: 'llmtr',
      name: 'LLMTR proxy',
      baseUrl: 'https://proxy.example/v1',
      model: 'proxy-model',
      apiKey: 'llmtr-test-key',
      apiFormat: 'responses',
      authHeader: 'X-Proxy-Key',
      authScheme: 'raw',
      authHeaderValue: 'proxy-auth-value',
      customHeaders: { 'X-Proxy-Trace': 'enabled' },
    })

    expect(saved).toMatchObject({
      apiFormat: 'responses',
      authHeader: 'X-Proxy-Key',
      authScheme: 'raw',
      authHeaderValue: 'proxy-auth-value',
      customHeaders: { 'X-Proxy-Trace': 'enabled' },
    })

    applyProviderProfileToProcessEnv(saved!)

    expect(process.env.OPENAI_API_FORMAT).toBe('responses')
    expect(process.env.OPENAI_AUTH_HEADER).toBe('X-Proxy-Key')
    expect(process.env.OPENAI_AUTH_SCHEME).toBe('raw')
    expect(process.env.OPENAI_AUTH_HEADER_VALUE).toBe('proxy-auth-value')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'X-Proxy-Trace: enabled',
    )
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.LLMTR_API_KEY).toBeUndefined()
  })
})

describe('getProviderProfiles', () => {
  test('preserves unknown stored provider ids during sanitization', async () => {
    const { getProviderProfiles } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({
          id: 'moonshot_vendor_prof',
          name: 'Moonshot Vendor',
          provider: 'moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.5',
        }),
      ],
    }))

    const profiles = getProviderProfiles()

    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.provider).toBe('moonshot')
  })

  test('sanitizes maxContextLength to positive finite integers', async () => {
    const { getProviderProfiles } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({ id: 'valid', maxContextLength: 128_000 }),
        buildProfile({ id: 'negative', maxContextLength: -1 }),
        buildProfile({ id: 'float', maxContextLength: 128_000.5 }),
        buildProfile({ id: 'zero', maxContextLength: 0 }),
        buildProfile({ id: 'infinity', maxContextLength: Infinity }),
        buildProfile({ id: 'string', maxContextLength: '128000' as unknown as number }),
        buildProfile({ id: 'missing' }),
      ],
    }))

    const profiles = getProviderProfiles()

    const byId = (id: string) => profiles.find(p => p.id === id)
    expect(byId('valid')?.maxContextLength).toBe(128_000)
    expect(byId('negative')?.maxContextLength).toBeUndefined()
    expect(byId('float')?.maxContextLength).toBeUndefined()
    expect(byId('zero')?.maxContextLength).toBeUndefined()
    expect(byId('infinity')?.maxContextLength).toBeUndefined()
    expect(byId('string')?.maxContextLength).toBeUndefined()
    expect(byId('missing')?.maxContextLength).toBeUndefined()
  })
})

describe('clearActiveProviderProfile', () => {
  test('returns undefined active profile while preserving saved profiles (#1426)', async () => {
    const {
      getActiveProviderProfile,
      clearActiveProviderProfile,
      getProviderProfiles,
      ANTHROPIC_DEFAULT_PROFILE_ID,
    } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({ id: 'saved_deepseek', name: 'DeepSeek' }),
      ],
      activeProviderProfileId: 'saved_deepseek',
    }))

    expect(getActiveProviderProfile()?.id).toBe('saved_deepseek')

    const hadActive = clearActiveProviderProfile()

    expect(hadActive).toBe(true)
    expect(mockConfigState.activeProviderProfileId).toBe(
      ANTHROPIC_DEFAULT_PROFILE_ID,
    )
    // Falls back to Anthropic, NOT to profiles[0].
    expect(getActiveProviderProfile()).toBeUndefined()
    // Saved profiles remain for later re-selection.
    expect(getProviderProfiles()).toHaveLength(1)
  })

  test('clears managed provider env from the current session', async () => {
    const { clearActiveProviderProfile } =
      await importFreshProviderProfileModules()

    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = 'saved_deepseek'
    // Managed provider env that a third-party profile would have applied.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    process.env.OPENAI_API_KEY = 'sk-test'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'saved_deepseek' })],
      activeProviderProfileId: 'saved_deepseek',
    }))

    clearActiveProviderProfile()

    expect(
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
    ).toBeUndefined()
    expect(
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
    ).toBeUndefined()
    // The managed provider env itself must be gone too, otherwise the switch
    // back to Anthropic would not take effect for the current session.
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  })

})

describe('Anthropic sentinel survives profile management (#1426)', () => {
  test('addProviderProfile with makeActive:false keeps the Anthropic sentinel active', async () => {
    const {
      addProviderProfile,
      getActiveProviderProfile,
      ANTHROPIC_DEFAULT_PROFILE_ID,
    } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'saved_one', name: 'Saved One' })],
      activeProviderProfileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    }))

    addProviderProfile(
      {
        provider: 'openai',
        name: 'Saved Two',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      },
      { makeActive: false },
    )

    expect(mockConfigState.activeProviderProfileId).toBe(
      ANTHROPIC_DEFAULT_PROFILE_ID,
    )
    expect(getActiveProviderProfile()).toBeUndefined()
  })

  test('addProviderProfile with makeActive:false keeps the implicit first profile active when no active id is set', async () => {
    const { addProviderProfile, getActiveProviderProfile } =
      await importFreshProviderProfileModules()

    // activeProviderProfileId unset, but a saved profile exists. getActiveProviderProfile
    // implicitly resolves this to the first profile, so adding another with
    // makeActive:false must not silently promote the new one.
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'saved_one', name: 'Saved One' })],
      activeProviderProfileId: undefined,
    }))

    addProviderProfile(
      {
        provider: 'openai',
        name: 'Saved Two',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      },
      { makeActive: false },
    )

    expect(getActiveProviderProfile()?.id).toBe('saved_one')
  })

  test('addProviderProfile with makeActive:false keeps the resolved first profile active when the active id is stale', async () => {
    const { addProviderProfile, getActiveProviderProfile } =
      await importFreshProviderProfileModules()

    // activeProviderProfileId points at a profile that no longer exists.
    // getActiveProviderProfile resolves a stale id to the first profile, so
    // adding another with makeActive:false must keep that first profile active
    // rather than promoting the new one (#1426).
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'saved_one', name: 'Saved One' })],
      activeProviderProfileId: 'deleted_profile_id',
    }))

    addProviderProfile(
      {
        provider: 'openai',
        name: 'Saved Two',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      },
      { makeActive: false },
    )

    expect(getActiveProviderProfile()?.id).toBe('saved_one')
  })

  test('updateProviderProfile of a non-active profile keeps the Anthropic sentinel active', async () => {
    const {
      updateProviderProfile,
      getActiveProviderProfile,
      ANTHROPIC_DEFAULT_PROFILE_ID,
    } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'saved_one', name: 'Saved One' })],
      activeProviderProfileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    }))

    updateProviderProfile('saved_one', {
      provider: 'openai',
      name: 'Saved One Renamed',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    })

    expect(mockConfigState.activeProviderProfileId).toBe(
      ANTHROPIC_DEFAULT_PROFILE_ID,
    )
    expect(getActiveProviderProfile()).toBeUndefined()
  })

  test('deleteProviderProfile of an inactive profile keeps the Anthropic sentinel active', async () => {
    const {
      deleteProviderProfile,
      getActiveProviderProfile,
      getProviderProfiles,
      ANTHROPIC_DEFAULT_PROFILE_ID,
    } = await importFreshProviderProfileModules()

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [
        buildProfile({ id: 'saved_one', name: 'Saved One' }),
        buildProfile({ id: 'saved_two', name: 'Saved Two' }),
      ],
      activeProviderProfileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    }))

    const result = deleteProviderProfile('saved_one')

    expect(result.removed).toBe(true)
    expect(mockConfigState.activeProviderProfileId).toBe(
      ANTHROPIC_DEFAULT_PROFILE_ID,
    )
    expect(getActiveProviderProfile()).toBeUndefined()
    expect(getProviderProfiles()).toHaveLength(1)
  })
})

describe('applyActiveProviderProfileFromConfig', () => {
  test('does not override explicit startup provider selection', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_MISTRAL
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_API_FORMAT
  })

  test('applies active profile when a bare CLAUDE_CODE_USE_OPENAI flag is stale (no BASE_URL/MODEL)', async () => {
    // Regression: a leftover `CLAUDE_CODE_USE_OPENAI=1` in the shell with no
    // paired OPENAI_BASE_URL / OPENAI_MODEL is not a real explicit selection
    // — it's a stale export. The previous guard treated it as intent and
    // skipped the saved profile, causing the startup banner to show hardcoded
    // defaults (gpt-4o @ api.openai.com) instead of the user's active
    // profile.
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied?.id).toBe('saved_moonshot')
    expect(process.env.OPENAI_BASE_URL!).toBe('https://api.moonshot.ai/v1')
    expect(process.env.OPENAI_MODEL!).toBe('kimi-k2.6')
  })

  test('still respects complete shell selection with USE flag + BASE_URL', async () => {
    // Counter-example: when the user really did set both the flag AND a
    // concrete BASE_URL, that IS explicit intent and wins over the saved
    // profile. This preserves the original "explicit startup wins" semantic.
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://192.168.1.1:8080/v1'
    delete process.env.OPENAI_MODEL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe('http://192.168.1.1:8080/v1')
  })

  test('still respects complete shell selection with USE flag + MODEL', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_MODEL = 'gpt-4o-mini'
    delete process.env.OPENAI_BASE_URL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_moonshot',
          baseUrl: 'https://api.moonshot.ai/v1',
          model: 'kimi-k2.6',
        }),
      ],
      activeProviderProfileId: 'saved_moonshot',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o-mini')
  })

  test('respects env-only GitHub Enterprise startup selection', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_ENTERPRISE_URL = 'https://github.mycompany.com/api/copilot'
    process.env.GITHUB_COPILOT_KEY = 'enterprise-direct-key'
    delete process.env.OPENAI_MODEL

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(process.env.GITHUB_ENTERPRISE_URL).toBe(
      'https://github.mycompany.com/api/copilot',
    )
    expect(process.env.GITHUB_COPILOT_KEY).toBe('enterprise-direct-key')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
  })

  test('does not override explicit env-only MiniMax selection with saved profile', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.MINIMAX_API_KEY = 'minimax-live-key'
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
    process.env.ANTHROPIC_MODEL = 'MiniMax-M2.7'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.MINIMAX_API_KEY).toBe('minimax-live-key')
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.minimax.io/anthropic',
    )
    expect(process.env.ANTHROPIC_MODEL).toBe('MiniMax-M2.7')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('does not override explicit startup selection when profile marker is stale', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })

  test('re-applies active profile when profile-managed env drifts', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'kimi-k2.5:cloud',
      }),
    )

    // Simulate settings/env merge clobbering the model while profile flags remain.
    process.env.OPENAI_MODEL = 'github:copilot'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'kimi-k2.5:cloud',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(process.env.OPENAI_MODEL).toBe('kimi-k2.5:cloud')
    expect(process.env.OPENAI_BASE_URL).toBe('http://192.168.33.108:11434/v1')
  })

  test('re-applies Command Code profile when dedicated key drifts', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const activeProfile = buildCommandcodeProfile({ id: 'saved_commandcode' })
    applyProviderProfileToProcessEnv(activeProfile)

    process.env.CMD_API_KEY = 'stale-ambient-key'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: 'saved_commandcode',
    } as any)

    expect(applied?.id).toBe('saved_commandcode')
    expect(process.env.CMD_API_KEY).toBe('cmd-test-key')
    expect(process.env.OPENAI_API_KEY).toBe('cmd-test-key')
    expect(
      resolveRouteCredentialValue({
        routeId: 'commandcode',
        baseUrl: process.env.OPENAI_BASE_URL,
        processEnv: process.env,
      }),
    ).toBe('cmd-test-key')
  })

  test('re-applies active profile when context-window override drifts', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://localhost:4000/v1',
      model: 'gpt-4o',
      maxContextLength: 1_000_000,
    })
    applyProviderProfileToProcessEnv(activeProfile)

    // Simulate an upgraded or partially restored process where the profile
    // marker and core OpenAI env survived, but this PR's new override did not.
    delete process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:4000/v1')
    expect(String(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS)).toBe(
      JSON.stringify({ 'gpt-4o': 1_000_000 }),
    )
  })

  test('does not re-apply active profile when flags conflict with current provider', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'saved_openai',
        baseUrl: 'http://192.168.33.108:11434/v1',
        model: 'kimi-k2.5:cloud',
      }),
    )

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_MODEL = 'github:copilot'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'http://192.168.33.108:11434/v1',
          model: 'kimi-k2.5:cloud',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBe('1')
    expect(process.env.OPENAI_MODEL).toBe('github:copilot')
  })

  test('re-applies xai active profile when XAI_API_KEY is missing (env drift)', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const xaiProfile = buildXaiProfile({ id: 'saved_xai' })
    applyProviderProfileToProcessEnv(xaiProfile)

    // Simulate relaunch where the shell exported OPENAI vars but not XAI_API_KEY
    delete process.env.XAI_API_KEY

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [xaiProfile],
      activeProviderProfileId: 'saved_xai',
    } as any)

    expect(applied?.id).toBe('saved_xai')
    expect(String(process.env.XAI_API_KEY)).toBe('xai-test-key')
  })

  test('re-applies Fireworks AI active profile when FIREWORKS_API_KEY is missing (env drift)', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const fwProfile = buildFireworksProfile({ id: 'saved_fw' })
    applyProviderProfileToProcessEnv(fwProfile)

    // Simulate relaunch where the shell exported OPENAI vars but not FIREWORKS_API_KEY
    delete process.env.FIREWORKS_API_KEY

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [fwProfile],
      activeProviderProfileId: 'saved_fw',
    } as any)

    expect(applied?.id).toBe('saved_fw')
    expect(String(process.env.FIREWORKS_API_KEY)).toBe('fireworks-test-key')
  })

  test('re-applies AI/ML API active profile when AIMLAPI_API_KEY is missing (env drift)', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const aimlapiProfile = buildProfile({
      id: 'saved_aimlapi',
      provider: 'aimlapi',
      name: 'AI/ML API',
      baseUrl: 'https://api.aimlapi.com/v1',
      model: 'gpt-4o',
      apiKey: 'aimlapi-test-key',
    })
    applyProviderProfileToProcessEnv(aimlapiProfile)

    // Simulate relaunch where the shell exported OPENAI vars but not AIMLAPI_API_KEY
    delete process.env.AIMLAPI_API_KEY

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [aimlapiProfile],
      activeProviderProfileId: 'saved_aimlapi',
    } as any)

    expect(applied?.id).toBe('saved_aimlapi')
    expect(String(process.env.AIMLAPI_API_KEY)).toBe('aimlapi-test-key')
  })

  test('does not re-apply xai active profile when XAI_API_KEY is aligned', async () => {
    const { applyActiveProviderProfileFromConfig, applyProviderProfileToProcessEnv } =
      await importFreshProviderProfileModules()
    const xaiProfile = buildXaiProfile({ id: 'saved_xai' })
    applyProviderProfileToProcessEnv(xaiProfile)

    // XAI_API_KEY is already set and aligned
    expect(process.env.XAI_API_KEY).toBe('xai-test-key')
    expect(process.env.OPENAI_API_KEY).toBe('xai-test-key')

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [xaiProfile],
      activeProviderProfileId: 'saved_xai',
    } as any)

    // Returns profile without re-applying since env is aligned
    expect(applied?.id).toBe('saved_xai')
    expect(process.env.XAI_API_KEY).toBe('xai-test-key')
  })

  test('applies active profile when no explicit provider is selected', async () => {
    const { applyActiveProviderProfileFromConfig } =
      await importFreshProviderProfileModules()
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [
        buildProfile({
          id: 'saved_openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
        }),
      ],
      activeProviderProfileId: 'saved_openai',
    } as any)

    expect(applied?.id).toBe('saved_openai')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
  })

  test.each(['', '?reasoning=high', '?thinking=disabled&reasoning=high'])(
    'preserves context limits for configured and saved models across profile rehydration (%j)',
    async query => {
      const {
        _setSavedModelOverrideForTesting,
        applyActiveProviderProfileFromConfig,
        getProviderProfiles,
      } = await importFreshProviderProfileModules()
      const { resolveModelRuntimeLimits } = await import(
        '../integrations/runtimeMetadata.js'
      )
      const configuredModel = `gpt-5.2${query}`
      const savedModel = `gpt-5.4${query}`
      const modelList = `glm-5.2; ${configuredModel}`
      _setSavedModelOverrideForTesting(savedModel)
      const activeProfile = buildProfile({
        id: 'saved_hicap',
        provider: 'hicap',
        baseUrl: 'https://api.hicap.ai/v1',
        model: modelList,
        maxContextLength: 200_000,
      })
      const config = {
        providerProfiles: [activeProfile],
        activeProviderProfileId: activeProfile.id,
      } as any
      const expectedContextWindows = JSON.stringify({
        'glm-5.2': 200_000,
        'gpt-5.2': 200_000,
        'gpt-5.4': 200_000,
      })

      const applied = applyActiveProviderProfileFromConfig(config)

      expect(applied?.id).toBe(activeProfile.id)
      expect(process.env.OPENAI_BASE_URL).toBe('https://api.hicap.ai/v1')
      const expectProfileContextLimits = () => {
        expect(process.env.OPENAI_MODEL).toBe(savedModel)
        for (const model of [
          'glm-5.2',
          'gpt-5.2',
          'gpt-5.4',
          configuredModel,
          savedModel,
        ]) {
          expect(
            resolveModelRuntimeLimits({ model, processEnv: process.env }).contextWindow,
          ).toBe(200_000)
        }
        expect(process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBe(
          expectedContextWindows,
        )
        const saved = getProviderProfiles(config).find(
          (profile: ProviderProfile) => profile.id === activeProfile.id,
        )
        expect(saved?.model).toBe(modelList)
      }
      expectProfileContextLimits()

      expect(applyActiveProviderProfileFromConfig(config)?.id).toBe(activeProfile.id)
      expectProfileContextLimits()

      // Alignment must repair the old configured-only map, even though the
      // effective model and all other profile-managed environment values match.
      process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
        'glm-5.2': 200_000,
        'gpt-5.2': 200_000,
      })
      applyActiveProviderProfileFromConfig(config)
      expectProfileContextLimits()

      // Also repair a complete map written with the old raw query-bearing keys.
      process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
        'glm-5.2': 200_000,
        [configuredModel]: 200_000,
        [savedModel]: 200_000,
      })
      applyActiveProviderProfileFromConfig(config)
      expectProfileContextLimits()
    },
  )

  test('uses saved Codex /model choice when rehydrating the Codex OAuth profile', async () => {
    // Regression: the Codex OAuth profile is created with a single
    // `codexplan` model entry, so profileSupportsModel rejected any other
    // Codex model saved via /model (e.g. gpt-5.6-terra) and the next startup
    // silently reverted to the model behind codexplan. Codex-backend profiles
    // must accept every Codex alias model and gpt-5.x free-text picks.
    const {
      _setSavedModelOverrideForTesting,
      applyActiveProviderProfileFromConfig,
      getProviderProfiles,
    } = await importFreshProviderProfileModules()
    _setSavedModelOverrideForTesting('gpt-5.6-terra')
    const activeProfile = buildProfile({
      id: 'saved_codex',
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
    })

    const applied = applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any)

    expect(applied?.id).toBe(activeProfile.id)
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://chatgpt.com/backend-api/codex',
    )
    expect(process.env.OPENAI_MODEL).toBe('gpt-5.6-terra')
    // The profile's configured model list is never mutated by /model.
    const saved = getProviderProfiles({
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any).find((profile: ProviderProfile) => profile.id === activeProfile.id)
    expect(saved?.model).toBe('codexplan')
  })

  test('accepts a non-alias gpt-5.x free-text pick on a Codex profile, but not a foreign model', async () => {
    // gpt-5.1-codex is served by the Codex backend but is not a
    // CODEX_ALIAS_MODELS key (only its -max/-mini variants are), so it is
    // only reachable via free-text /model — which live-validates against
    // the backend before persisting. It must survive restart. A stale
    // non-GPT model from another provider must NOT leak in.
    const {
      _setSavedModelOverrideForTesting,
      applyActiveProviderProfileFromConfig,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_codex',
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
    })
    const config = {
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any

    _setSavedModelOverrideForTesting('gpt-5.1-codex')
    applyActiveProviderProfileFromConfig(config)
    expect(process.env.OPENAI_MODEL).toBe('gpt-5.1-codex')

    // Simulate a cold start for the second scenario — leftover provider env
    // from the first application counts as explicit startup intent and would
    // short-circuit applyActiveProviderProfileFromConfig.
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_MODEL
    _setSavedModelOverrideForTesting('kimi-k2.6')
    applyActiveProviderProfileFromConfig(config)
    expect(String(process.env.OPENAI_MODEL)).toBe('codexplan')

    // gpt-5-mini/-nano are API-only tiers the Codex backend does not serve;
    // a stale pick from a direct-OpenAI profile must fall back too, not 400.
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_MODEL
    _setSavedModelOverrideForTesting('gpt-5-mini')
    applyActiveProviderProfileFromConfig(config)
    expect(String(process.env.OPENAI_MODEL)).toBe('codexplan')
  })

  test('a [1m]-tagged saved Codex pick survives restart', async () => {
    // The [1m] tag is a client-side context opt-in, not part of the model
    // identity: profileSupportsModel must match the tagged value against the
    // untagged alias/profile entry instead of dropping the override.
    const {
      _setSavedModelOverrideForTesting,
      applyActiveProviderProfileFromConfig,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_codex',
      provider: 'openai',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'codexplan',
    })

    _setSavedModelOverrideForTesting('codexplan[1m]')
    applyActiveProviderProfileFromConfig({
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    } as any)
    expect(process.env.OPENAI_MODEL).toBe('codexplan[1m]')
  })

  test('cold start on the Anthropic sentinel stays on built-in Anthropic and does not fall back to the OpenGateway default (#1429)', async () => {
    // Regression: after clearActiveProviderProfile() records the Anthropic
    // sentinel and deletes the startup profile mirror, a restart must keep the
    // user on built-in Anthropic. Previously applyActiveProviderProfileFromConfig()
    // returned without marking provider env as handled (the sentinel resolves to
    // no profile), so buildStartupEnvFromProfile() saw the missing mirror as a
    // fresh install and synthesized the default Twigpine OpenGateway env —
    // silently moving the user back onto a third-party provider.
    const { applyActiveProviderProfileFromConfig, ANTHROPIC_DEFAULT_PROFILE_ID } =
      await importFreshProviderProfileModules()
    const { buildStartupEnvFromProfile, DEFAULT_STARTUP_PROVIDER_ENV_VAR } =
      await import(`./providerProfile.js?ts=${Date.now()}-${Math.random()}`)

    // Cold start with a fully isolated env. applyActiveProviderProfileFromConfig
    // and buildStartupEnvFromProfile treat ANY CLAUDE_CODE_USE_* flag (OpenAI,
    // GitHub, Gemini, Mistral, Bedrock, Vertex, Foundry) as an explicit provider
    // selection, so an inherited flag would route this case down a different
    // path and hide the sentinel regression. Snapshot every provider key, clear
    // them all, and restore in finally so the test neither leaks nor depends on
    // ambient env.
    const providerEnvKeys = [
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_USE_GITHUB',
      'CLAUDE_CODE_USE_GEMINI',
      'CLAUDE_CODE_USE_MISTRAL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
      'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
    ]
    const providerEnvSnapshot = new Map(
      providerEnvKeys.map(key => [key, process.env[key]] as const),
    )
    for (const key of providerEnvKeys) {
      delete process.env[key]
    }

    try {
      const applied = applyActiveProviderProfileFromConfig({
        providerProfiles: [
          buildProfile({
            id: 'saved_openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o',
          }),
        ],
        activeProviderProfileId: ANTHROPIC_DEFAULT_PROFILE_ID,
      } as any)

      // Built-in Anthropic resolves to no profile, but env is now marked handled
      // and carries no third-party provider selection.
      expect(applied).toBeUndefined()
      expect(String(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED)).toBe('1')
      expect(process.env.OPENAI_BASE_URL).toBeUndefined()
      expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()

      // The deleted profile mirror (persisted: null) must NOT be treated as a
      // fresh install, so no OpenGateway default is synthesized.
      const startupEnv = await buildStartupEnvFromProfile({
        persisted: null,
        processEnv: process.env,
      })
      expect(startupEnv[DEFAULT_STARTUP_PROVIDER_ENV_VAR]).not.toBe(
        'gitlawb-opengateway',
      )
      expect(startupEnv.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
      expect(startupEnv.OPENAI_BASE_URL).toBeUndefined()
    } finally {
      for (const [key, value] of providerEnvSnapshot) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})

describe('persistActiveProviderProfileModel', () => {
  // The runtime active-model selection is owned by mainLoopModelOverride
  // (set by onChangeAppState before this helper is called). This helper
  // intentionally no longer mutates the profile's model list — see the
  // docstring in providerProfiles.ts. Coverage below locks the no-op
  // contract for both single- and multi-model profiles.
  test('returns the active profile unchanged for a single-model profile', async () => {
    const {
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'saved_openai',
      baseUrl: 'http://192.168.33.108:11434/v1',
      model: 'kimi-k2.5:cloud',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))

    const updated = persistActiveProviderProfileModel('minimax-m2.5:cloud')

    expect(updated?.id).toBe(activeProfile.id)
    expect(updated?.model).toBe('kimi-k2.5:cloud')
    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('kimi-k2.5:cloud')
  })

  test('does not mutate multi-model mistral profile when chosen model is out of list', async () => {
    // Regression for #1360: the picker must never silently rewrite a
    // provider's configured model list. The active model is a session-level
    // choice handled by mainLoopModelOverride; the profile's model list
    // only changes via an explicit provider edit. An earlier
    // implementation prepended the chosen model to the list, which
    // contradicted the documented contract and grew the list unboundedly
    // on rotation.
    const {
      applyProviderProfileToProcessEnv,
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildMistralProfile({
      id: 'saved_mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'devstral-latest; mistral-small-latest',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))
    applyProviderProfileToProcessEnv(activeProfile)

    const updated = persistActiveProviderProfileModel('mistral-large-latest')

    expect(updated?.id).toBe(activeProfile.id)
    // The configured list is preserved verbatim regardless of the chosen
    // model being in or out of the list.
    expect(updated?.model).toBe('devstral-latest; mistral-small-latest')
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      activeProfile.id,
    )

    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe('devstral-latest; mistral-small-latest')
  })

  test('preserves comma-separated multi-model list when chosen model is already a member', async () => {
    // Switching between models already in the list is a session-level
    // choice. The list itself must be preserved exactly as configured.
    const {
      getProviderProfiles,
      persistActiveProviderProfileModel,
    } = await importFreshProviderProfileModules()
    const activeProfile = buildMistralProfile({
      id: 'saved_mistral',
      baseUrl: 'https://api.mistral.ai/v1',
      model: 'devstral-latest, mistral-small-latest, mistral-large-latest',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile],
      activeProviderProfileId: activeProfile.id,
    }))

    const updated = persistActiveProviderProfileModel('mistral-small-latest')

    expect(updated?.model).toBe(
      'devstral-latest, mistral-small-latest, mistral-large-latest',
    )
    const saved = getProviderProfiles().find(
      (profile: ProviderProfile) => profile.id === activeProfile.id,
    )
    expect(saved?.model).toBe(
      'devstral-latest, mistral-small-latest, mistral-large-latest',
    )
  })
})

describe('getProviderPresetDefaults', () => {
  test('openai preset skips delimiter-only pooled keys before singular fallback', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEYS = ', ,'
    process.env.OPENAI_API_KEY = 'openai-single-key'

    const defaults = getProviderPresetDefaults('openai')

    expect(defaults.apiKey).toBe('openai-single-key')
  })

  test('openai preset skips placeholder pooled keys before singular fallback', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEYS = 'key-a,SUA_CHAVE'
    process.env.OPENAI_API_KEY = 'openai-single-key'

    const defaults = getProviderPresetDefaults('openai')

    expect(defaults.apiKey).toBe('openai-single-key')
  })
  test('custom preset reads pooled OpenAI credentials', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.OPENAI_API_KEYS = 'key-a,key-b'
    delete process.env.OPENAI_API_KEY

    const defaults = getProviderPresetDefaults('custom')

    expect(defaults.apiKey).toBe('key-a,key-b')
  })

  test('custom Anthropic preserves direct endpoint settings but only hydrates a Bearer token', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.ANTHROPIC_BASE_URL = 'https://tenant.example/v1'
    process.env.ANTHROPIC_MODEL = 'tenant-model'
    process.env.ANTHROPIC_AUTH_TOKEN = 'bearer-token'
    process.env.ANTHROPIC_API_KEY = 'native-api-key'

    const defaults = getProviderPresetDefaults('custom-anthropic')

    expect(defaults.baseUrl).toBe('https://tenant.example/v1')
    expect(defaults.model).toBe('tenant-model')
    expect(defaults.apiKey).toBe('bearer-token')
  })
  test('ollama preset defaults to a local Ollama model', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('ollama')

    expect(defaults.baseUrl).toBe('http://localhost:11434/v1')
    expect(defaults.model).toBe('llama3.1:8b')
  })

  test('atomic-chat preset defaults to a local Atomic Chat endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    delete process.env.OPENAI_MODEL

    const defaults = getProviderPresetDefaults('atomic-chat')

    expect(defaults.provider).toBe('atomic-chat')
    expect(defaults.name).toBe('Atomic Chat')
    expect(defaults.baseUrl).toBe('http://127.0.0.1:1337/v1')
    expect(defaults.requiresApiKey).toBe(false)
  })

  test('kimi-code preset defaults to the Kimi Code coding endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('kimi-code')

    expect(defaults.provider).toBe('kimi-code')
    expect(defaults.name).toBe('Moonshot AI - Kimi Code')
    expect(defaults.baseUrl).toBe('https://api.kimi.com/coding/v1')
    expect(defaults.model).toBe('kimi-for-coding')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('moonshotai preset keeps the direct API under the renamed display label', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('moonshotai')

    expect(defaults.name).toBe('Moonshot AI - API')
    expect(defaults.baseUrl).toBe('https://api.moonshot.ai/v1')
    expect(defaults.model).toBe('kimi-k2.7-code')
  })
  test('deepseek preset defaults to DeepSeek V4 Pro', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('deepseek')

    expect(defaults.provider).toBe('deepseek')
    expect(defaults.name).toBe('DeepSeek')
    expect(defaults.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(defaults.model).toBe('deepseek-v4-pro')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('hicap preset defaults to the Hicap endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.HICAP_API_KEY = 'hicap-live-key'

    const defaults = getProviderPresetDefaults('hicap')

    expect(defaults.provider).toBe('hicap')
    expect(defaults.name).toBe('Hicap')
    expect(defaults.baseUrl).toBe('https://api.hicap.ai/v1')
    expect(defaults.model).toBe('claude-opus-4.8')
    expect(defaults.apiKey).toBe('hicap-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('minimax preset defaults to MiniMax M3', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('minimax')

    expect(defaults.provider).toBe('minimax')
    expect(defaults.name).toBe('MiniMax')
    expect(defaults.baseUrl).toBe('https://api.minimax.io/anthropic')
    expect(defaults.model).toBe('MiniMax-M3')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('venice preset defaults to the official Venice endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.VENICE_API_KEY = 'venice-live-key'

    const defaults = getProviderPresetDefaults('venice')

    expect(defaults.provider).toBe('venice')
    expect(defaults.name).toBe('Venice')
    expect(defaults.baseUrl).toBe('https://api.venice.ai/api/v1')
    expect(defaults.model).toBe('venice-uncensored')
    expect(defaults.apiKey).toBe('venice-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('xiaomi mimo preset defaults to the official Xiaomi MiMo endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.MIMO_API_KEY = 'mimo-live-key'

    const defaults = getProviderPresetDefaults('xiaomi-mimo')

    expect(defaults.provider).toBe('xiaomi-mimo')
    expect(defaults.name).toBe('Xiaomi MiMo')
    expect(defaults.baseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(defaults.model).toBe('mimo-v2.5-pro')
    expect(defaults.apiKey).toBe('mimo-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('xiaomi mimo token plan preset defaults to the token-plan SGP endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.MIMO_API_KEY = 'tp-live-key'

    const defaults = getProviderPresetDefaults('xiaomi-mimo-token')

    expect(defaults.provider).toBe('xiaomi-mimo-token')
    expect(defaults.name).toBe('Xiaomi MiMo (Token Plan)')
    expect(defaults.baseUrl).toBe(
      'https://token-plan-sgp.xiaomimimo.com/v1',
    )
    expect(defaults.model).toBe('mimo-v2.5-pro')
    expect(defaults.apiKey).toBe('tp-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('aimlapi preset defaults to the official AI/ML API endpoint', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.AIMLAPI_API_KEY = 'aimlapi-live-key'

    const defaults = getProviderPresetDefaults('aimlapi')

    expect(defaults.provider).toBe('aimlapi')
    expect(defaults.name).toBe('aimlapi.com')
    expect(defaults.baseUrl).toBe('https://api.aimlapi.com/v1')
    expect(defaults.model).toBe('gpt-4o')
    expect(defaults.apiKey).toBe('aimlapi-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('xai preset ignores stale generic OpenAI model when creating defaults', async () => {
    const { getProviderPresetDefaults } = await importFreshProviderProfileModules()
    process.env.OPENAI_MODEL = 'gpt-5.4'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.XAI_API_KEY = 'xai-live-key'

    const defaults = getProviderPresetDefaults('xai')

    expect(defaults.provider).toBe('xai')
    expect(defaults.name).toBe('xAI')
    expect(defaults.baseUrl).toBe('https://api.x.ai/v1')
    expect(defaults.model).toBe('grok-4.6')
    expect(defaults.apiKey).toBe('xai-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })

  test('zai preset defaults to Z.AI GLM Coding Plan endpoint', async () => {
    const { getProviderPresetDefaults, resolveProfileCapabilityRouteId } =
      await importFreshProviderProfileModules()

    const defaults = getProviderPresetDefaults('zai')

    expect(defaults.provider).toBe('zai')
    expect(defaults.name).toBe('Z.AI - GLM Coding Plan')
    expect(defaults.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(defaults.model).toBe('glm-5.2')
    expect(defaults.requiresApiKey).toBe(true)
    expect(
      resolveProfileCapabilityRouteId('zai', defaults.baseUrl),
    ).toBe('zai')
    expect(
      resolveProfileCapabilityRouteId(
        'zai',
        'https://api.z.ai/api/paas/v4',
      ),
    ).toBe('custom')
  })

  test('fireworks preset defaults to the official Fireworks AI endpoint', async () => {
    const { getProviderPresetDefaults } =
      await importFreshProviderProfileModules()
    process.env.FIREWORKS_API_KEY = 'fireworks-live-key'

    const defaults = getProviderPresetDefaults('fireworks')

    expect(defaults.provider).toBe('fireworks')
    expect(defaults.name).toBe('Fireworks AI')
    expect(defaults.baseUrl).toBe('https://api.fireworks.ai/inference/v1')
    expect(defaults.model).toBe(
      'accounts/fireworks/models/llama-v3p1-70b-instruct',
    )
    expect(defaults.apiKey).toBe('fireworks-live-key')
    expect(defaults.requiresApiKey).toBe(true)
  })
})

describe('setActiveProviderProfile', () => {
  test('sets OPENAI_MODEL env var when switching to an openai-type provider', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const openaiProfile = buildProfile({
        id: 'openai_prof',
        name: 'OpenAI Provider',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [openaiProfile],
      }))

      const result = setActiveProviderProfile('openai_prof', {
        configDir: testConfigDir ?? undefined,
      })

      expect(result?.id).toBe('openai_prof')
      expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
      expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
      expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
      expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
        'openai_prof',
      )
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  // xAI OAuth profile (provider='xai', no API key) must persist the
  // startup file as profile='xai' with XAI_CREDENTIAL_SOURCE='oauth' so
  // (a) startup validation accepts it without XAI_API_KEY, and (b)
  // clearPersistedXaiOAuthProfile() can find and remove it on logout.
  // Regression: previously written as profile='openai' with no marker,
  // leaving a stale startup file that hit the missing-cred warning on
  // every non-interactive launch after logout.
  test('persists xAI OAuth profile with marker so logout cleanup can clear it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const { clearPersistedXaiOAuthProfile, isPersistedXaiOAuthProfile } =
        await import('./providerProfile.js')

      const xaiOAuthProfile = buildProfile({
        id: 'xai_oauth_prof',
        name: 'xAI OAuth',
        provider: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        model: 'grok-4.3',
        apiKey: '',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [xaiOAuthProfile],
      }))

      const result = setActiveProviderProfile('xai_oauth_prof', { configDir })
      const profilePath = join(configDir, '.openclaude-profile.json')
      const persisted = JSON.parse(readFileSync(profilePath, 'utf8'))

      expect(result?.id).toBe('xai_oauth_prof')
      expect(persisted.profile).toBe('xai')
      expect(persisted.env.XAI_CREDENTIAL_SOURCE).toBe('oauth')
      expect(persisted.env.OPENAI_BASE_URL).toBe('https://api.x.ai/v1')
      expect(persisted.env.OPENAI_MODEL).toBe('grok-4.3')
      // No leaked API key fields.
      expect(persisted.env.OPENAI_API_KEY).toBeUndefined()
      expect(persisted.env.XAI_API_KEY).toBeUndefined()

      // Logout cleanup recognises and removes the marker-tagged file.
      expect(isPersistedXaiOAuthProfile(persisted)).toBe(true)
      const removed = clearPersistedXaiOAuthProfile({ configDir })
      expect(removed).toBe(profilePath)
      expect(existsSync(profilePath)).toBe(false)
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists no-key openai-compatible profiles for restart fallback', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.OPENAI_API_KEY = 'sk-shell-should-not-persist'

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const ollamaProfile = buildProfile({
        id: 'ollama_prof',
        name: 'Ollama',
        provider: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3.1:8b, qwen2.5:7b',
        apiKey: '',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [ollamaProfile],
      }))

      const result = setActiveProviderProfile('ollama_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('ollama_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'http://localhost:11434/v1',
        OPENAI_MODEL: 'llama3.1:8b',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists the Ollama route marker for a reverse-proxied profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const ollamaProfile = buildOllamaProfile({ id: 'ollama_proxy_prof' })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [ollamaProfile],
      }))

      const result = setActiveProviderProfile('ollama_proxy_prof', { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('ollama_proxy_prof')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://models.example.com/v1',
        OPENAI_MODEL: 'deepseek-v4-flash:cloud',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'ollama',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists primary model for keyed openai-compatible multi-model profiles', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const deepSeekProfile = buildProfile({
        id: 'deepseek_prof',
        name: 'DeepSeek',
        provider: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-flash?thinking=disabled, deepseek-v4-pro?reasoning=high, deepseek-chat',
        apiKey: 'sk-deepseek-live',
        apiFormat: 'responses',
        maxContextLength: 200_000,
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [deepSeekProfile],
      }))

      const result = setActiveProviderProfile('deepseek_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('deepseek_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_MODEL: 'deepseek-v4-flash?thinking=disabled',
        OPENAI_API_KEY: 'sk-deepseek-live',
        CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: JSON.stringify({
          'deepseek-v4-flash': 200_000,
          'deepseek-v4-pro': 200_000,
          'deepseek-chat': 200_000,
        }),
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists context window for every model in a keyless openai-compatible profile', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const openaiProfile = buildProfile({
        id: 'keyless_multi_model_prof',
        provider: 'custom',
        baseUrl: 'http://localhost:4000/v1',
        model: 'model-a?reasoning=high; Model-B[1m]?thinking=disabled, model-c',
        maxContextLength: 64_000,
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [openaiProfile],
      }))

      const result = setActiveProviderProfile('keyless_multi_model_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('keyless_multi_model_prof')
      expect(persisted.env.OPENAI_MODEL).toBe('model-a?reasoning=high')
      expect(persisted.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS).toBe(
        JSON.stringify({
          'model-a': 64_000,
          'Model-B[1m]': 64_000,
          'model-c': 64_000,
        }),
      )
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists descriptor-backed direct vendors using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const deepSeekProfile = buildProfile({
        id: 'deepseek_vendor_prof',
        name: 'DeepSeek Vendor',
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: 'sk-deepseek-live',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [deepSeekProfile],
      }))

      const result = setActiveProviderProfile('deepseek_vendor_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('deepseek_vendor_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_MODEL: 'deepseek-chat',
        OPENAI_API_KEY: 'sk-deepseek-live',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists the Atlas key for generic openai profiles targeting Atlas Cloud', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const genericAtlasProfile = buildProfile({
        id: 'generic_atlas_prof',
        name: 'Atlas via custom OpenAI',
        baseUrl: 'https://api.atlascloud.ai/v1',
        model: 'deepseek-ai/deepseek-v4-pro',
        apiKey: 'atlas-generic-key',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [genericAtlasProfile],
      }))

      const result = setActiveProviderProfile('generic_atlas_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('generic_atlas_prof')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env.OPENAI_BASE_URL).toBe('https://api.atlascloud.ai/v1')
      expect(persisted.env.OPENAI_API_KEY).toBe('atlas-generic-key')
      expect(persisted.env.ATLAS_CLOUD_API_KEY).toBe('atlas-generic-key')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists Venice profiles using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const veniceProfile = buildVeniceProfile({
        id: 'venice_prof',
        model: 'venice-uncensored, venice-coding',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [veniceProfile],
      }))

      const result = setActiveProviderProfile('venice_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('venice_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.venice.ai/api/v1',
        OPENAI_MODEL: 'venice-uncensored',
        OPENAI_API_KEY: 'venice-test-key',
        VENICE_API_KEY: 'venice-test-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists Fireworks AI profiles using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(
      join(tmpdir(), 'openclaude-provider-'),
    )
    const configDir = mkdtempSync(
      join(tmpdir(), 'openclaude-provider-config-'),
    )
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const fireworksProfile = buildFireworksProfile({
        id: 'fireworks_prof',
        model: 'accounts/fireworks/models/deepseek-v3, accounts/fireworks/models/llama-v3p1-70b-instruct',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [fireworksProfile],
      }))

      const result = setActiveProviderProfile('fireworks_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(
          join(configDir, '.openclaude-profile.json'),
          'utf8',
        ),
      )

      expect(result?.id).toBe('fireworks_prof')
      expect(
        existsSync(join(tempDir, '.openclaude-profile.json')),
      ).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.fireworks.ai/inference/v1',
        OPENAI_MODEL: 'accounts/fireworks/models/deepseek-v3',
        OPENAI_API_KEY: 'fireworks-test-key',
        FIREWORKS_API_KEY: 'fireworks-test-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists ClinePass profiles using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const clinePassProfile = buildClinePassProfile({
        id: 'clinepass_prof',
        model: 'cline-pass/deepseek-v4-flash, cline-pass/qwen3.7-max',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [clinePassProfile],
      }))

      const result = setActiveProviderProfile('clinepass_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('clinepass_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.cline.bot/api/v1',
        OPENAI_MODEL: 'cline-pass/deepseek-v4-flash',
        OPENAI_API_KEY: 'cline-test-key',
        CLINE_API_KEY: 'cline-test-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists ClinePass profiles with custom base URL using the same dedicated credential', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const clinePassProfile = buildProfile({
        provider: 'clinepass',
        name: 'ClinePass Custom',
        baseUrl: 'https://custom.cline.bot/v1',
        model: 'cline-pass/qwen3.7-max',
        apiKey: 'custom-cline-key',
        id: 'clinepass_custom',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [clinePassProfile],
      }))

      const result = setActiveProviderProfile('clinepass_custom', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('clinepass_custom')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://custom.cline.bot/v1',
        OPENAI_MODEL: 'cline-pass/qwen3.7-max',
        OPENAI_API_KEY: 'custom-cline-key',
        CLINE_API_KEY: 'custom-cline-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists Cloudflare profiles with CLOUDFLARE_API_TOKEN in the strict startup env', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const cloudflareProfile = buildCloudflareProfile({ id: 'cloudflare_prof' })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [cloudflareProfile],
      }))

      const result = setActiveProviderProfile('cloudflare_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('cloudflare_prof')
      expect(persisted.profile).toBe('openai')
      // The strict startup-env branch (keyed profile) must mirror the dedicated
      // token, otherwise a relaunched Cloudflare profile persists an env that
      // omits CLOUDFLARE_API_TOKEN and re-detects inconsistently.
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL:
          'https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1',
        OPENAI_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
        OPENAI_API_KEY: 'cloudflare-test-token',
        CLOUDFLARE_API_TOKEN: 'cloudflare-test-token',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('retargeted ApiSmart profiles keep route identity but persist without their dedicated credential', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const apismartProfile = buildApismartProfile({
        id: 'apismart_proxy',
        baseUrl: 'https://proxy.example/v1',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [apismartProfile],
      }))

      const result = setActiveProviderProfile('apismart_proxy', { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('apismart_proxy')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'apismart',
        OPENAI_BASE_URL: 'https://proxy.example/v1',
        OPENAI_MODEL: 'DEEPSEEK_V4_FLASH',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          APISMART_API_KEY: 'ambient-apismart-key',
          OPENAI_API_KEY: 'ambient-apismart-key',
        },
      })

      expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('apismart')
      expect(startupEnv.APISMART_API_KEY).toBeUndefined()
      expect(startupEnv.OPENAI_API_KEY).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('retargeted Concentrate profiles keep route identity but persist without their dedicated credential', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const concentrateProfile = buildConcentrateProfile({
        id: 'concentrate_proxy',
        baseUrl: 'https://api.concentrate.ai/staging/v1',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [concentrateProfile],
      }))

      const result = setActiveProviderProfile('concentrate_proxy', { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('concentrate_proxy')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate',
        OPENAI_BASE_URL: 'https://api.concentrate.ai/staging/v1',
        OPENAI_MODEL: 'deepseek-v4-flash-0731',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          CONCENTRATE_API_KEY: 'ambient-concentrate-key',
          OPENAI_API_KEY: 'ambient-concentrate-key',
        },
      })

      expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('concentrate')
      expect(startupEnv.CONCENTRATE_API_KEY).toBeUndefined()
      expect(startupEnv.OPENAI_API_KEY).toBeUndefined()
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('keyed canonical API Route profiles persist and restart with route identity', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const apiRouteProfile = buildApiRouteProfile({
        id: 'api_route_profile',
      })
      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [apiRouteProfile],
      }))

      setActiveProviderProfile(apiRouteProfile.id, { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(persisted.env).toMatchObject({
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'api-route',
        OPENAI_BASE_URL: 'https://global.api-route.com/v1',
        OPENAI_API_KEY: 'api-route-test-key',
        API_ROUTE_API_KEY: 'api-route-test-key',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {},
      })

      expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('api-route')
      expect(startupEnv.OPENAI_BASE_URL).toBe('https://global.api-route.com/v1')
      expect(startupEnv.OPENAI_API_KEY).toBe('api-route-test-key')
      expect(
        resolveRouteCredentialValue({
          routeId: 'api-route',
          baseUrl: startupEnv.OPENAI_BASE_URL,
          processEnv: startupEnv,
        }),
      ).toBe('api-route-test-key')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('keyed canonical LLMTR profiles persist their saved dedicated credential across restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const llmtrProfile = buildLlmtrProfile({ id: 'llmtr_profile' })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [llmtrProfile],
      }))

      const result = setActiveProviderProfile('llmtr_profile', { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('llmtr_profile')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toMatchObject({
        OPENAI_BASE_URL: 'https://llmtr.com/v1',
        OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
        OPENAI_API_KEY: 'llmtr-test-key',
        LLMTR_API_KEY: 'llmtr-test-key',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          LLMTR_API_KEY: 'ambient-unrelated-key',
        },
      })

      expect(startupEnv.OPENAI_API_KEY).toBe('llmtr-test-key')
      expect(startupEnv.LLMTR_API_KEY).toBe('llmtr-test-key')

      delete persisted.env.LLMTR_API_KEY
      const migratedStartupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          LLMTR_API_KEY: 'ambient-unrelated-key',
        },
      })

      expect(migratedStartupEnv.OPENAI_API_KEY).toBe('llmtr-test-key')
      expect(migratedStartupEnv.LLMTR_API_KEY).toBe('llmtr-test-key')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('keyed canonical Command Code profiles persist their saved dedicated credential across restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const commandcodeProfile = buildCommandcodeProfile({
        id: 'commandcode_profile',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [commandcodeProfile],
      }))

      const result = setActiveProviderProfile('commandcode_profile', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('commandcode_profile')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toMatchObject({
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
        OPENAI_API_KEY: 'cmd-test-key',
        CMD_API_KEY: 'cmd-test-key',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          CMD_API_KEY: 'ambient-unrelated-key',
        },
      })

      expect(startupEnv.CMD_API_KEY).toBe('cmd-test-key')
      expect(
        resolveRouteCredentialValue({
          routeId: 'commandcode',
          baseUrl: startupEnv.OPENAI_BASE_URL,
          processEnv: startupEnv,
        }),
      ).toBe('cmd-test-key')

      delete persisted.env.CMD_API_KEY
      const migratedStartupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          CMD_API_KEY: 'ambient-unrelated-key',
        },
      })

      expect(migratedStartupEnv.OPENAI_API_KEY).toBe('cmd-test-key')
      expect(migratedStartupEnv.CMD_API_KEY).toBe('cmd-test-key')
      expect(
        resolveRouteCredentialValue({
          routeId: 'commandcode',
          baseUrl: migratedStartupEnv.OPENAI_BASE_URL,
          processEnv: migratedStartupEnv,
        }),
      ).toBe('cmd-test-key')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('CMD-only env adoption persists Command Code dedicated key into the startup file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir
    process.env.CMD_API_KEY = 'env-cmd-key'

    try {
      const { addProviderProfile, setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const saved = addProviderProfile(
        {
          provider: 'commandcode',
          name: 'Command Code',
          baseUrl: 'https://api.commandcode.ai/provider/v1',
          model: 'deepseek/deepseek-v4-flash',
        },
        { makeActive: false },
      )
      expect(saved?.id).toBeTruthy()
      setActiveProviderProfile(saved!.id, { configDir })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(saved?.apiKey).toBe('env-cmd-key')
      expect(persisted.env).toMatchObject({
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        OPENAI_MODEL: 'deepseek/deepseek-v4-flash',
        CMD_API_KEY: 'env-cmd-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists Xiaomi MiMo profiles using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const mimoProfile = buildXiaomiMimoProfile({
        baseUrl: 'https://api.mimo-v2.com/v1',
        id: 'mimo_prof',
        model: 'mimo-v2.5-pro, mimo-v2-flash',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [mimoProfile],
      }))

      const result = setActiveProviderProfile('mimo_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('mimo_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        OPENAI_BASE_URL: 'https://api.xiaomimimo.com/v1',
        OPENAI_MODEL: 'mimo-v2.5-pro',
        OPENAI_API_KEY: 'mimo-test-key',
        MIMO_API_KEY: 'mimo-test-key',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists AI/ML API profiles using a legacy-compatible openai startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const aimlapiProfile = buildProfile({
        id: 'aimlapi_prof',
        name: 'AI/ML API',
        provider: 'aimlapi',
        baseUrl: 'https://api.aimlapi.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-test-key',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [aimlapiProfile],
      }))

      const result = setActiveProviderProfile('aimlapi_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('aimlapi_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        AIMLAPI_API_KEY: 'aimlapi-test-key',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: 'https://api.aimlapi.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEY: 'aimlapi-test-key',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {},
      })

      expect(startupEnv.OPENAI_API_KEY).toBe('aimlapi-test-key')
      expect(startupEnv.AIMLAPI_API_KEY).toBe('aimlapi-test-key')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('custom (proxy) AI/ML API profiles preserve AIMLAPI startup identity', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const aimlapiProxyProfile = buildProfile({
        id: 'aimlapi_proxy_prof',
        name: 'AI/ML API Proxy',
        provider: 'aimlapi',
        baseUrl: 'https://proxy.example.com/v1',
        model: 'gpt-4o',
        apiKey: 'aimlapi-test-key',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [aimlapiProxyProfile],
      }))

      const result = setActiveProviderProfile('aimlapi_proxy_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('aimlapi_proxy_prof')
      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toMatchObject({
        AIMLAPI_API_KEY: 'aimlapi-test-key',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_MODEL: 'gpt-4o',
        OPENAI_API_KEY: 'aimlapi-test-key',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {},
      })

      expect(startupEnv.OPENAI_API_KEY).toBe('aimlapi-test-key')
      expect(startupEnv.AIMLAPI_API_KEY).toBe('aimlapi-test-key')
      expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('keyless custom (proxy) AI/ML API profiles keep route identity but withhold the ambient key', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const aimlapiProxyProfile = buildProfile({
        id: 'aimlapi_proxy_prof',
        name: 'AI/ML API Proxy',
        provider: 'aimlapi',
        baseUrl: 'https://proxy.example.com/v1',
        model: 'gpt-4o',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [aimlapiProxyProfile],
      }))

      setActiveProviderProfile('aimlapi_proxy_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(persisted.profile).toBe('openai')
      expect(persisted.env).toEqual({
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'aimlapi',
        OPENAI_BASE_URL: 'https://proxy.example.com/v1',
        OPENAI_MODEL: 'gpt-4o',
      })

      const { buildStartupEnvFromProfile } = await import(
        `./providerProfile.js?ts=${Date.now()}-${Math.random()}`
      )
      const startupEnv = await buildStartupEnvFromProfile({
        persisted,
        processEnv: {
          AIMLAPI_API_KEY: 'ambient-aimlapi-key',
        },
      })

      // Route identity is preserved, but the ambient canonical AIMLAPI key must
      // NOT be forwarded to a user-controlled proxy host.
      expect(startupEnv.AIMLAPI_API_KEY).toBeUndefined()
      expect(startupEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID).toBe('aimlapi')
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists bedrock profiles using a dedicated startup profile kind', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const bedrockProfile = buildProfile({
        id: 'bedrock_prof',
        name: 'Bedrock',
        provider: 'bedrock',
        baseUrl: 'https://bedrock-proxy.example',
        model: 'claude-sonnet-4-6',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [bedrockProfile],
      }))

      const result = setActiveProviderProfile('bedrock_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('bedrock_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('bedrock')
      expect(persisted.env).toEqual({
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock-proxy.example',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists anthropic profiles using a dedicated anthropic startup profile', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } =
        await importFreshProviderProfileModules()
      const anthropicProfile = buildProfile({
        id: 'anthro_persisted_prof',
        name: 'Anthropic Provider',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiKey: 'sk-ant-live',
      })

      saveMockGlobalConfig(current => ({
        ...current,
        providerProfiles: [anthropicProfile],
      }))

      const result = setActiveProviderProfile('anthro_persisted_prof', {
        configDir,
      })
      const persisted = JSON.parse(
        readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'),
      )

      expect(result?.id).toBe('anthro_persisted_prof')
      expect(existsSync(join(tempDir, '.openclaude-profile.json'))).toBe(false)
      expect(persisted.profile).toBe('anthropic')
      expect(persisted.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: 'claude-sonnet-4-6',
        ANTHROPIC_API_KEY: 'sk-ant-live',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('persists custom Anthropic-compatible profiles with Bearer token auth', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-'))
    const configDir = mkdtempSync(join(tmpdir(), 'openclaude-provider-config-'))
    process.chdir(tempDir)
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const { setActiveProviderProfile } = await importFreshProviderProfileModules()
      const profile = buildProfile({
        id: 'custom_anthropic_prof',
        name: 'Custom Anthropic',
        provider: 'custom-anthropic',
        baseUrl: 'https://anthropic-proxy.example',
        model: 'claude-proxy-model',
        apiKey: 'proxy-token',
      })
      saveMockGlobalConfig(current => ({ ...current, providerProfiles: [profile] }))

      const result = setActiveProviderProfile('custom_anthropic_prof', { configDir })
      const persisted = JSON.parse(readFileSync(join(configDir, '.openclaude-profile.json'), 'utf8'))

      expect(result?.id).toBe('custom_anthropic_prof')
      expect(process.env.ANTHROPIC_BASE_URL).toBe('https://anthropic-proxy.example')
      expect(process.env.ANTHROPIC_MODEL).toBe('claude-proxy-model')
      expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token')
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
      expect(persisted.env).toEqual({
        ANTHROPIC_BASE_URL: 'https://anthropic-proxy.example',
        ANTHROPIC_MODEL: 'claude-proxy-model',
        ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      })
    } finally {
      process.chdir(originalCwd)
      rmSync(tempDir, { recursive: true, force: true })
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('sets ANTHROPIC_MODEL env var when switching to an anthropic-type provider', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const anthropicProfile = buildProfile({
      id: 'anthro_prof',
      name: 'Anthropic Provider',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [anthropicProfile],
    }))

    const result = setActiveProviderProfile('anthro_prof', {
      configDir: testConfigDir ?? undefined,
    })

    expect(result?.id).toBe('anthro_prof')
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'anthro_prof',
    )
  })

  test('clears openai model env and sets anthropic model env when switching from openai to anthropic provider', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const openaiProfile = buildProfile({
      id: 'openai_prof',
      name: 'OpenAI Provider',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-openai-key',
    })
    const anthropicProfile = buildProfile({
      id: 'anthro_prof',
      name: 'Anthropic Provider',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-key',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [openaiProfile, anthropicProfile],
    }))

    // First activate the openai profile
    setActiveProviderProfile('openai_prof', {
      configDir: testConfigDir ?? undefined,
    })
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')

    // Now switch to the anthropic profile
    const result = setActiveProviderProfile('anthro_prof', {
      configDir: testConfigDir ?? undefined,
    })

    expect(result?.id).toBe('anthro_prof')
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')
    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'anthro_prof',
    )
  })

  test('clears anthropic model env and sets openai model env when switching from anthropic to openai provider', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const anthropicProfile = buildProfile({
      id: 'anthro_prof',
      name: 'Anthropic Provider',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'sk-ant-key',
    })
    const openaiProfile = buildProfile({
      id: 'openai_prof',
      name: 'OpenAI Provider',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-openai-key',
    })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [anthropicProfile, openaiProfile],
    }))

    // First activate the anthropic profile
    setActiveProviderProfile('anthro_prof', {
      configDir: testConfigDir ?? undefined,
    })
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-sonnet-4-6')
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com')

    // Now switch to the openai profile
    const result = setActiveProviderProfile('openai_prof', {
      configDir: testConfigDir ?? undefined,
    })

    expect(result?.id).toBe('openai_prof')
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_MODEL).toBe('gpt-4o')
    expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID).toBe(
      'openai_prof',
    )
  })

  test('returns null for non-existent profile id', async () => {
    const { setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const openaiProfile = buildProfile({ id: 'existing_prof' })

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [openaiProfile],
    }))

    const result = setActiveProviderProfile('nonexistent_prof', {
      configDir: testConfigDir ?? undefined,
    })

    expect(result).toBeNull()
  })
})

describe('deleteProviderProfile', () => {
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_MISTRAL
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_API_FORMAT
  })

  test('deleting final profile clears provider env when active profile applied it', async () => {
    const {
      applyProviderProfileToProcessEnv,
      deleteProviderProfile,
    } = await importFreshProviderProfileModules()
    applyProviderProfileToProcessEnv(
      buildProfile({
        id: 'only_profile',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-test',
      }),
    )

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'only_profile' })],
      activeProviderProfileId: 'only_profile',
    }))

    const result = deleteProviderProfile('only_profile')

    expect(result.removed).toBe(true)
    expect(result.activeProfileId).toBeUndefined()

    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED).toBeUndefined()

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GITHUB).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_VERTEX).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined()

    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
    expect(process.env.OPENAI_API_BASE).toBeUndefined()
    expect(process.env.OPENAI_MODEL).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('deleting the active custom Anthropic profile removes its startup mirror', async () => {
    const {
      deleteProviderProfile,
      setActiveProviderProfile,
    } = await importFreshProviderProfileModules()
    const profile = buildProfile({
      id: 'custom_anthropic_profile',
      provider: 'custom-anthropic',
      baseUrl: 'https://proxy.example',
      model: 'proxy-model',
      apiKey: 'bearer-token',
    })
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [profile],
      activeProviderProfileId: profile.id,
    }))

    setActiveProviderProfile(profile.id, { configDir: testConfigDir ?? undefined })
    const profilePath = join(testConfigDir!, '.openclaude-profile.json')
    expect(existsSync(profilePath)).toBe(true)

    deleteProviderProfile(profile.id)

    expect(existsSync(profilePath)).toBe(false)
  })

  test('updating the active custom Anthropic profile synchronizes its startup mirror', async () => {
    const { setActiveProviderProfile, updateProviderProfile } =
      await importFreshProviderProfileModules()
    const profile = buildProfile({
      id: 'custom_anthropic_profile',
      provider: 'custom-anthropic',
      baseUrl: 'https://proxy.example',
      model: 'proxy-model',
      apiKey: 'old-token',
    })
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [profile],
      activeProviderProfileId: profile.id,
    }))

    setActiveProviderProfile(profile.id, { configDir: testConfigDir ?? undefined })
    updateProviderProfile(profile.id, {
      ...profile,
      baseUrl: 'https://new-proxy.example',
      model: 'new-proxy-model',
      apiKey: 'new-token',
    })

    const persisted = JSON.parse(
      readFileSync(join(testConfigDir!, '.openclaude-profile.json'), 'utf8'),
    )
    expect(persisted.env.ANTHROPIC_BASE_URL).toBe('https://new-proxy.example')
    expect(persisted.env.ANTHROPIC_MODEL).toBe('new-proxy-model')
    expect(persisted.env.ANTHROPIC_AUTH_TOKEN).toBe('new-token')
  })

  test('deleting an active custom Anthropic profile persists its replacement', async () => {
    const { deleteProviderProfile, setActiveProviderProfile } =
      await importFreshProviderProfileModules()
    const activeProfile = buildProfile({
      id: 'custom_anthropic_profile',
      provider: 'custom-anthropic',
      baseUrl: 'https://proxy.example',
      model: 'proxy-model',
      apiKey: 'bearer-token',
    })
    const replacement = buildProfile({
      id: 'replacement_profile',
      baseUrl: 'https://replacement.example/v1',
      model: 'replacement-model',
      apiKey: 'replacement-token',
    })
    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [activeProfile, replacement],
      activeProviderProfileId: activeProfile.id,
    }))

    setActiveProviderProfile(activeProfile.id, {
      configDir: testConfigDir ?? undefined,
    })
    deleteProviderProfile(activeProfile.id)

    const persisted = JSON.parse(
      readFileSync(join(testConfigDir!, '.openclaude-profile.json'), 'utf8'),
    )
    expect(persisted.profile).toBe('openai')
    expect(persisted.env.OPENAI_BASE_URL).toBe('https://replacement.example/v1')
    expect(persisted.env.OPENAI_MODEL).toBe('replacement-model')
    expect(persisted.env.OPENAI_API_KEY).toBe('replacement-token')
  })

  test('deleting final profile preserves explicit startup provider env', async () => {
    const { deleteProviderProfile } = await importFreshProviderProfileModules()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    process.env.OPENAI_MODEL = 'qwen2.5:3b'

    saveMockGlobalConfig(current => ({
      ...current,
      providerProfiles: [buildProfile({ id: 'only_profile' })],
      activeProviderProfileId: 'only_profile',
    }))

    const result = deleteProviderProfile('only_profile')

    expect(result.removed).toBe(true)
    expect(result.activeProfileId).toBeUndefined()

    expect(process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED).toBeUndefined()
    expect(String(process.env.CLAUDE_CODE_USE_OPENAI)).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe('http://localhost:11434/v1')
    expect(process.env.OPENAI_MODEL).toBe('qwen2.5:3b')
  })
})

describe('getProfileModelOptions', () => {
  test('getConfiguredProfileModelOptions ignores discovered cache entries', async () => {
    const { getConfiguredProfileModelOptions } =
      await importFreshProviderProfileModules()
    const profile = buildProfile({
      id: 'multi_provider',
      name: 'Multi Provider',
      model: 'glm-4.7, glm-4.7-flash',
    })

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [profile],
      activeProviderProfileId: 'multi_provider',
      openaiAdditionalModelOptionsCacheByProfile: {
        multi_provider: [
          {
            value: 'glm-4.7-plus',
            label: 'glm-4.7-plus',
            description: 'Discovered from API',
          },
        ],
      },
    }

    expect(getConfiguredProfileModelOptions(profile)).toEqual([
      {
        value: 'glm-4.7',
        label: 'glm-4.7',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-flash',
        label: 'glm-4.7-flash',
        description: 'Provider: Multi Provider',
      },
    ])
  })

  test('route-scoped OpenAI cache ignores active profile cache entries', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:7777/v1'
    process.env.OPENAI_MODEL = 'route-model'

    const { getAdditionalModelOptionsCacheScope } = await import(
      '../services/api/providerConfig.js'
    )
    const { getActiveOpenAIRouteModelOptionsCache } =
      await importFreshProviderProfileModules()
    const profile = buildProfile({
      id: 'multi_provider',
      name: 'Multi Provider',
      baseUrl: 'http://localhost:7777/v1',
      model: 'profile-model',
    })

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [profile],
      activeProviderProfileId: 'multi_provider',
      additionalModelOptionsCache: [
        {
          value: 'route-model',
          label: 'Route Model',
          description: 'Detected from route',
        },
      ],
      additionalModelOptionsCacheScope:
        getAdditionalModelOptionsCacheScope() ?? undefined,
      openaiAdditionalModelOptionsCacheByProfile: {
        multi_provider: [
          {
            value: 'profile-model',
            label: 'profile-model',
            description: 'Provider: Multi Provider',
          },
        ],
      },
    }

    expect(getActiveOpenAIRouteModelOptionsCache()).toEqual([
      {
        value: 'route-model',
        label: 'Route Model',
        description: 'Detected from route',
      },
    ])
  })

  test('generates options for multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'glm-4.7, glm-4.7-flash, glm-4.7-plus',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Provider: Test Provider' },
    ])
  })

  test('generates options for semicolon-separated multi-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Test Provider',
        model: 'glm-4.7; glm-4.7-flash; glm-4.7-plus',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Provider: Test Provider' },
    ])
  })

  test('returns single option for single-model profile', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Single Model',
        model: 'llama3.1:8b',
      }),
    )

    expect(options).toEqual([
      { value: 'llama3.1:8b', label: 'llama3.1:8b', description: 'Provider: Single Model' },
    ])
  })

  test('appends discovered model cache entries for the same profile without duplicates', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      openaiAdditionalModelOptionsCacheByProfile: {
        provider_test: [
          {
            value: 'glm-4.7-flash',
            label: 'glm-4.7-flash',
            description: 'Discovered from API',
          },
          {
            value: 'glm-4.7-plus',
            label: 'glm-4.7-plus',
            description: 'Discovered from API',
          },
        ],
      },
    }

    const options = getProfileModelOptions(
      buildProfile({
        id: 'provider_test',
        name: 'Test Provider',
        model: 'glm-4.7, glm-4.7-flash',
      }),
    )

    expect(options).toEqual([
      { value: 'glm-4.7', label: 'glm-4.7', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-flash', label: 'glm-4.7-flash', description: 'Provider: Test Provider' },
      { value: 'glm-4.7-plus', label: 'glm-4.7-plus', description: 'Discovered from API' },
    ])
  })

  test('returns empty array for empty model field', async () => {
    const { getProfileModelOptions } =
      await importFreshProviderProfileModules()

    const options = getProfileModelOptions(
      buildProfile({
        name: 'Empty',
        model: '',
      }),
    )

    expect(options).toEqual([])
  })
})

describe('setActiveProviderProfile model cache', () => {
  test('populates model cache with all models from multi-model profile on activation', async () => {
    const {
      setActiveProviderProfile,
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'glm-4.7, glm-4.7-flash, glm-4.7-plus',
          baseUrl: 'https://api.example.com/v1',
        }),
      ],
    }

    setActiveProviderProfile('multi_provider', {
      configDir: testConfigDir ?? undefined,
    })

    const cache = getActiveOpenAIModelOptionsCache()
    const cacheValues = cache.map((opt: { value: string }) => opt.value)
    expect(cacheValues).toContain('glm-4.7')
    expect(cacheValues).toContain('glm-4.7-flash')
    expect(cacheValues).toContain('glm-4.7-plus')
  })

  test('merges configured profile models with discovered cache on activation', async () => {
    const {
      setActiveProviderProfile,
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'glm-4.7, glm-4.7-flash',
          baseUrl: 'https://api.example.com/v1',
        }),
      ],
      openaiAdditionalModelOptionsCacheByProfile: {
        multi_provider: [
          {
            value: 'glm-4.7-plus',
            label: 'glm-4.7-plus',
            description: 'Discovered from API',
          },
          {
            value: 'glm-4.7-flash',
            label: 'glm-4.7-flash',
            description: 'Discovered from API',
          },
        ],
      },
    }

    setActiveProviderProfile('multi_provider', {
      configDir: testConfigDir ?? undefined,
    })

    expect(getActiveOpenAIModelOptionsCache()).toEqual([
      {
        value: 'glm-4.7',
        label: 'glm-4.7',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-flash',
        label: 'glm-4.7-flash',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-plus',
        label: 'glm-4.7-plus',
        description: 'Discovered from API',
      },
    ])
  })

  test('merges configured profile models with discovered cache during refresh writes', async () => {
    const {
      setActiveOpenAIModelOptionsCache,
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'glm-4.7, glm-4.7-flash',
          baseUrl: 'https://api.example.com/v1',
        }),
      ],
      activeProviderProfileId: 'multi_provider',
    }

    setActiveOpenAIModelOptionsCache([
      {
        value: 'glm-4.7-plus',
        label: 'glm-4.7-plus',
        description: 'Discovered from API',
      },
      {
        value: 'glm-4.7-flash',
        label: 'glm-4.7-flash',
        description: 'Discovered from API',
      },
    ])

    expect(getActiveOpenAIModelOptionsCache()).toEqual([
      {
        value: 'glm-4.7',
        label: 'glm-4.7',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-flash',
        label: 'glm-4.7-flash',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-plus',
        label: 'glm-4.7-plus',
        description: 'Discovered from API',
      },
    ])
  })

  test('falls back to configured profile models when no discovery cache exists yet', async () => {
    const {
      getActiveOpenAIModelOptionsCache,
    } = await importFreshProviderProfileModules()

    mockConfigState = {
      ...createMockConfigState(),
      providerProfiles: [
        buildProfile({
          id: 'multi_provider',
          name: 'Multi Provider',
          model: 'glm-4.7, glm-4.7-flash',
          baseUrl: 'https://api.example.com/v1',
        }),
      ],
      activeProviderProfileId: 'multi_provider',
    }

    expect(getActiveOpenAIModelOptionsCache()).toEqual([
      {
        value: 'glm-4.7',
        label: 'glm-4.7',
        description: 'Provider: Multi Provider',
      },
      {
        value: 'glm-4.7-flash',
        label: 'glm-4.7-flash',
        description: 'Provider: Multi Provider',
      },
    ])
  })
})

test('DEFAULT_MISTRAL_MODEL matches the mistral gateway defaultModel', async () => {
  const { DEFAULT_MISTRAL_MODEL } = await import('./providerProfile.js')
  const { default: mistralGateway } = await import('../integrations/gateways/mistral.js')
  expect(mistralGateway.defaultModel).toBeDefined()
  expect(DEFAULT_MISTRAL_MODEL).toBe(mistralGateway.defaultModel!)
})
