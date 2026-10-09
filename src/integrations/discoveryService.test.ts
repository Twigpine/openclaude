import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setCachedModels } from './discoveryCache.js'
import { _clearRegistryForTesting, ensureIntegrationsLoaded, registerGateway } from './index.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { publicBuildVersion } from '../utils/version.js'
import { setClaudeConfigHomeDirForTesting } from '../utils/envUtils.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  OPENGATEWAY_API_KEY: process.env.OPENGATEWAY_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  APISMART_API_KEY: process.env.APISMART_API_KEY,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
}

let tempDir: string

async function loadDiscoveryServiceModule() {
  return import(`./discoveryService.js?ts=${Date.now()}-${Math.random()}`)
}

function setMockFetch(
  implementation: typeof globalThis.fetch,
): void {
  globalThis.fetch = implementation
}

function restoreEnvValue(
  key: keyof typeof originalEnv,
): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearProviderEnv(): void {
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_MODEL
  delete process.env.APISMART_API_KEY
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
}

beforeEach(async () => {
  await acquireSharedMutationLock('discoveryService.test.ts')
  mock.restore()
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-discovery-service-test-'))
  setClaudeConfigHomeDirForTesting(tempDir)
  process.env.CLAUDE_CONFIG_DIR = tempDir
  delete process.env.OPENROUTER_API_KEY
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  clearProviderEnv()
  globalThis.fetch = originalFetch
})

afterEach(() => {
  try {
    mock.restore()
    globalThis.fetch = originalFetch
    rmSync(tempDir, { recursive: true, force: true })
    setClaudeConfigHomeDirForTesting(undefined)
    restoreEnvValue('CLAUDE_CONFIG_DIR')
    restoreEnvValue('OPENROUTER_API_KEY')
    restoreEnvValue('OPENGATEWAY_API_KEY')
    restoreEnvValue('OPENAI_BASE_URL')
    restoreEnvValue('OPENAI_API_BASE')
    restoreEnvValue('OPENAI_API_KEY')
    restoreEnvValue('OPENAI_API_KEYS')
    restoreEnvValue('OPENAI_MODEL')
    restoreEnvValue('APISMART_API_KEY')
    restoreEnvValue('ANTHROPIC_CUSTOM_HEADERS')
    restoreEnvValue('CLAUDE_CODE_USE_OPENAI')
    restoreEnvValue('CLAUDE_CODE_USE_GEMINI')
    restoreEnvValue('CLAUDE_CODE_USE_MISTRAL')
    restoreEnvValue('CLAUDE_CODE_USE_GITHUB')
    restoreEnvValue('CLAUDE_CODE_USE_BEDROCK')
    restoreEnvValue('CLAUDE_CODE_USE_VERTEX')
    restoreEnvValue('CLAUDE_CODE_USE_FOUNDRY')
    restoreEnvValue('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('discoverModelsForRoute', () => {
  test('does not send an ApiSmart key to an overridden discovery URL', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()
    process.env.APISMART_API_KEY = 'apismart-secret'
    let didFetch = false
    let authorization: string | null | undefined
    setMockFetch(mock((_input: string | URL | Request, init?: RequestInit) => {
      didFetch = true
      authorization = new Headers(init?.headers).get('authorization')
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    }) as unknown as typeof globalThis.fetch)

    await discoverModelsForRoute('apismart', {
      baseUrl: 'https://proxy.example/v1',
      forceRefresh: true,
    })

    expect(didFetch).toBe(true)
    expect(authorization).not.toBe('Bearer apismart-secret')
  })

  test('uses built-in openai-compatible discovery and caches results for dynamic routes', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let callCount = 0
    const calledUrls: string[] = []
    setMockFetch(mock((input: string | URL | Request) => {
      callCount++
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calledUrls.push(url)

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'Qwen3_5-4B_Q4_K_M' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const first = await discoverModelsForRoute('atomic-chat')
    const second = await discoverModelsForRoute('atomic-chat')

    expect(first).toMatchObject({
      routeId: 'atomic-chat',
      source: 'network',
      stale: false,
      models: [{ id: 'Qwen3_5-4B_Q4_K_M', apiName: 'Qwen3_5-4B_Q4_K_M' }],
    })
    expect(second?.source).toBe('cache')
    expect(callCount).toBe(1)
    expect(calledUrls).toEqual(['http://127.0.0.1:1337/v1/models'])
  })

  test('partitions cached discovery results by endpoint base URL', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let callCount = 0
    setMockFetch(mock((input: string | URL | Request) => {
      callCount++
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      const model = url.startsWith('http://remote-a.example/v1/')
        ? 'remote-a-model'
        : 'remote-b-model'

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: model }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const firstRemoteA = await discoverModelsForRoute('atomic-chat', {
      baseUrl: 'http://remote-a.example/v1',
    })
    const firstRemoteB = await discoverModelsForRoute('atomic-chat', {
      baseUrl: 'http://remote-b.example/v1',
    })
    const secondRemoteA = await discoverModelsForRoute('atomic-chat', {
      baseUrl: 'http://remote-a.example/v1',
    })

    expect(firstRemoteA?.source).toBe('network')
    expect(firstRemoteA?.models.map(model => model.apiName)).toEqual([
      'remote-a-model',
    ])
    expect(firstRemoteB?.source).toBe('network')
    expect(firstRemoteB?.models.map(model => model.apiName)).toEqual([
      'remote-b-model',
    ])
    expect(secondRemoteA?.source).toBe('cache')
    expect(secondRemoteA?.models.map(model => model.apiName)).toEqual([
      'remote-a-model',
    ])
    expect(callCount).toBe(2)
  })

  test('uses opaque cache partitions for credential-scoped discovery', async () => {
    const { getDiscoveryCacheKey } = await loadDiscoveryServiceModule()

    const first = getDiscoveryCacheKey('custom', {
      baseUrl: 'https://example.test/v1',
      apiKey: 'discovery-cache-secret-a',
    })
    const second = getDiscoveryCacheKey('custom', {
      baseUrl: 'https://example.test/v1',
      apiKey: 'discovery-cache-secret-b',
    })

    expect(first).toMatch(/^custom:[0-9a-f]{32}$/)
    expect(first).not.toContain('discovery-cache-secret-a')
    expect(second).not.toContain('discovery-cache-secret-b')
    expect(first).not.toBe(second)
  })

  test('preserves stale cache data when refresh fails', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    setMockFetch(mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.1:8b', size: 1024 }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    ) as unknown as typeof globalThis.fetch)

    const first = await discoverModelsForRoute('ollama', { forceRefresh: true })
    expect(first?.source).toBe('network')

    setMockFetch(mock(() =>
      Promise.resolve(new Response('unavailable', { status: 503 })),
    ) as unknown as typeof globalThis.fetch)

    const second = await discoverModelsForRoute('ollama', { forceRefresh: true })
    expect(second).toMatchObject({
      source: 'stale-cache',
      stale: true,
      models: [
        {
          id: 'ollama-qwen3-coder-next-cloud',
          apiName: 'qwen3-coder-next:cloud',
          maxOutputTokens: 32_768,
        },
        {
          id: 'deepseek-v4-pro-cloud',
          apiName: 'deepseek-v4-pro:cloud',
          contextWindow: 1_048_576,
          maxOutputTokens: 65_536,
        },
        { id: 'llama3.1:8b', apiName: 'llama3.1:8b' },
      ],
    })
    expect(second?.error?.message).toContain('Discovery failed')
  })

  test('hybrid routes keep curated descriptor entries ahead of discovered duplicates', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    // OpenRouter lists models publicly; discovery no longer requires a key.
    delete process.env.OPENROUTER_API_KEY
    const openRouterCalls: Array<{ url: string; headers: unknown }> = []
    setMockFetch(mock((input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      openRouterCalls.push({ url, headers: init?.headers })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'openai/gpt-5-mini',
                name: 'OpenAI: GPT-5 Mini',
                context_length: 400000,
                supported_parameters: ['tools'],
              },
              {
                id: 'anthropic/claude-sonnet-4',
                name: 'Anthropic: Claude Sonnet 4',
                context_length: 200000,
                supported_parameters: ['tools', 'reasoning'],
              },
              { id: 'openai/text-embedding-3-large', name: 'Embedding' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('openrouter', {
      forceRefresh: true,
    })

    expect(openRouterCalls).toHaveLength(1)
    expect(openRouterCalls[0]?.url).toContain('/models')
    expect(openRouterCalls[0]?.headers).toBeUndefined()
    expect(result?.models.map((model: { apiName: string }) => model.apiName)).toEqual([
      'openai/gpt-5-mini',
      'x-ai/grok-4.6',
      'x-ai/grok-4.5',
      'anthropic/claude-sonnet-4',
    ])
    expect(result?.models[0]?.label).toBe('GPT-5 Mini (via OpenRouter)')
    expect(result?.models[3]?.label).toBe('Anthropic: Claude Sonnet 4')
    expect(result?.models[3]?.contextWindow).toBe(200000)
  })

  test('opengateway hybrid discovery loads the live list without a key', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    delete process.env.OPENGATEWAY_API_KEY
    delete process.env.OPENAI_API_KEY
    delete process.env.OPENAI_API_KEYS
    const openGatewayCalls: Array<{ url: string; headers: unknown }> = []
    setMockFetch(mock((input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      openGatewayCalls.push({ url, headers: init?.headers })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'auto', name: 'Auto (smart routing)' },
              {
                id: 'xiaomi/mimo-v2.5-pro',
                name: 'MiMo V2.5-Pro',
                context_window: 262144,
              },
              {
                id: 'moonshotai/kimi-k3',
                name: 'Kimi K3',
                context_window: 128000,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('gitlawb-opengateway', {
      forceRefresh: true,
    })

    expect(openGatewayCalls).toHaveLength(1)
    expect(openGatewayCalls[0]?.url).toContain('/v1/models')
    expect(openGatewayCalls[0]?.headers).toEqual({
      'Accept-Encoding': 'identity',
    })
    expect(result?.source).toBe('network')
    const apiNames = result?.models.map(
      (model: { apiName: string }) => model.apiName,
    )
    // Curated static entries stay first; live-only routes are appended.
    expect(apiNames?.[0]).toBe('auto')
    expect(apiNames).toContain('mimo-v2.5-pro')
    expect(apiNames).not.toContain('xiaomi/mimo-v2.5-pro')
    expect(apiNames).toContain('moonshotai/kimi-k3')
    const liveOnly = result?.models.find(
      (model: { apiName: string }) => model.apiName === 'moonshotai/kimi-k3',
    )
    expect(liveOnly?.label).toBe('Kimi K3')
    expect(liveOnly?.contextWindow).toBe(128000)
  })

  test('openrouter discovery preserves credentials and custom headers for overridden base URL', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedUrl: string | undefined
    let capturedHeaders: unknown
    setMockFetch(mock((input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = init?.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'custom-proxy/model-1' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('openrouter', {
      baseUrl: 'https://proxy.corp.internal/v1',
      apiKey: 'sk-or-proxy-key',
      headers: {
        'X-Proxy-Auth': 'secret-proxy-token',
      },
      forceRefresh: true,
    })

    expect(capturedUrl).toBe('https://proxy.corp.internal/v1/models')
    expect(capturedHeaders).toEqual({
      'X-Proxy-Auth': 'secret-proxy-token',
      Authorization: 'Bearer sk-or-proxy-key',
    })
    expect(result?.source).toBe('network')
    expect(result?.models.some(m => m.apiName === 'custom-proxy/model-1')).toBe(true)
  })

  test('opengateway discovery preserves credentials and custom headers for overridden base URL', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedUrl: string | undefined
    let capturedHeaders: unknown
    setMockFetch(mock((input, init) => {
      capturedUrl =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      capturedHeaders = init?.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'custom-og/mimo-v3' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('gitlawb-opengateway', {
      baseUrl: 'https://og-proxy.corp.internal/v1',
      apiKey: 'ogw_live_proxy_key',
      headers: {
        'X-Custom-Gate': 'gate-token',
      },
      forceRefresh: true,
    })

    expect(capturedUrl).toBe('https://og-proxy.corp.internal/v1/models')
    expect(capturedHeaders).toEqual({
      'Accept-Encoding': 'identity',
      'X-Custom-Gate': 'gate-token',
      Authorization: 'Bearer ogw_live_proxy_key',
    })
    expect(result?.source).toBe('network')
    expect(result?.models.some(m => m.apiName === 'custom-og/mimo-v3')).toBe(true)
  })

  test('opengateway hybrid discovery filters expired static models and live duplicates after availableUntil cutoff', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    setMockFetch(mock((input, init) => {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'inclusionai/ling-3.0-tiny:free', name: 'Ling 3.0 Tiny Live' },
              { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('gitlawb-opengateway', {
      forceRefresh: true,
    })

    expect(result?.source).toBe('network')
    const apiNames = result?.models.map(
      (model: { apiName: string }) => model.apiName,
    )
    expect(apiNames).toContain('mimo-v2.5-pro')
    expect(apiNames).toContain('moonshotai/kimi-k3')
    expect(apiNames).not.toContain('inclusionai/ling-3.0-tiny:free')
  })

  test('openai-compatible discovery applies descriptor static headers with auth', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    registerGateway({
      id: 'discovery-header-test',
      label: 'Discovery Header Test',
      category: 'hosted',
      defaultBaseUrl: 'https://discovery-header-test.example/v1',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
        credentialEnvVars: ['DISCOVERY_HEADER_TEST_API_KEY'],
      },
      transportConfig: {
        kind: 'openai-compatible',
        openaiShim: {
          headers: {
            'X-Static-Client': 'openclaude',
          },
        },
      },
      catalog: {
        source: 'dynamic',
        discovery: {
          kind: 'openai-compatible',
        },
      },
    })

    setMockFetch(mock((_input, init) => {
      expect(init?.headers).toEqual({
        'X-Static-Client': 'profile',
        'X-Profile-Header': 'enabled',
        Authorization: 'Bearer discovery-key',
      })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'discovered-model' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('discovery-header-test', {
      apiKey: 'discovery-key',
      headers: {
        'X-Static-Client': 'profile',
        'X-Profile-Header': 'enabled',
      },
      forceRefresh: true,
    })

    expect(result?.source).toBe('network')
    expect(result?.models.map((model: { apiName: string }) => model.apiName)).toEqual(['discovered-model'])
  })

  test('openai-compatible discovery can opt out of auth', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    registerGateway({
      id: 'discovery-no-auth-test',
      label: 'Discovery No Auth Test',
      category: 'hosted',
      defaultBaseUrl: 'https://discovery-no-auth-test.example/v1',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
        credentialEnvVars: ['DISCOVERY_NO_AUTH_TEST_API_KEY'],
      },
      transportConfig: {
        kind: 'openai-compatible',
      },
      catalog: {
        source: 'dynamic',
        discovery: {
          kind: 'openai-compatible',
          requiresAuth: false,
        },
        discoveryCacheTtl: '1d',
      },
    })

    let callCount = 0
    setMockFetch(mock((_input, init) => {
      callCount++
      expect(init?.headers).toBeUndefined()
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'public-model' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('discovery-no-auth-test', {
      forceRefresh: true,
    })
    const cached = await discoverModelsForRoute('discovery-no-auth-test')

    expect(result?.source).toBe('network')
    expect(result?.models.map((model: { apiName: string }) => model.apiName)).toEqual(['public-model'])
    expect(cached?.source).toBe('cache')
    expect(cached?.models.map((model: { apiName: string }) => model.apiName)).toEqual(['public-model'])
    expect(callCount).toBe(1)
  })

  test('AI/ML API discovery filters chat models, dedupes ids, and omits auth', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedHeaders: HeadersInit | undefined
    setMockFetch(mock((_input, init) => {
      capturedHeaders = init?.headers

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              null,
              'not-a-model-object',
              { id: 42, type: 'chat-completion' },
              { id: 'missing-type' },
              { id: 'bad-type', type: 42 },
              {
                id: 'gpt-4o',
                type: 'chat-completion',
                info: {
                  name: 'GPT-4o',
                  developer: 'OpenAI',
                  contextLength: 128000,
                },
              },
              {
                id: 'gpt-4o',
                type: 'chat-completion',
                info: {
                  name: 'GPT-4o',
                  developer: 'OpenAI',
                  contextLength: 128000,
                },
              },
              {
                id: 'gemini-2.5-pro',
                type: 'chat-completion',
                info: {
                  name: 'Gemini 2.5 Pro',
                  developer: 'Google',
                  contextLength: 1048576,
                },
              },
              {
                id: '  GLM-5.2  ',
                type: 'chat-completion',
                info: {
                  name: 'GLM 5.2',
                  developer: 'Z.AI',
                },
              },
              {
                id: 'glm-5.2',
                type: 'chat-completion',
                info: {
                  name: 'GLM 5.2 Duplicate',
                  developer: 'Z.AI',
                },
              },
              {
                id: 'whisper-large-v3',
                type: 'audio-transcription',
                info: {
                  name: 'Whisper Large V3',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('aimlapi', {
      forceRefresh: true,
    })

    expect(result?.source).toBe('network')
    expect(capturedHeaders).toEqual({
      'X-AIMLAPI-Source': 'agent/openclaude',
      'X-AIMLAPI-Partner-ID': 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
      'X-AIMLAPI-Integration-Repo': 'Twigpine/openclaude',
      'X-AIMLAPI-Integration-Version': publicBuildVersion,
      'HTTP-Referer': 'OpenClaude',
      'X-Title': 'OpenClaude',
    })
    expect(result?.models.map((model: { apiName: string }) => model.apiName)).toEqual([
      'gpt-4o',
      'gemini-2.5-pro',
      'GLM-5.2',
    ])
    expect(result?.models.find((model: { apiName: string }) => model.apiName === 'gpt-4o')).toMatchObject({
      id: 'aimlapi-gpt-4o',
      label: 'GPT-4o',
    })
    expect(result?.models.find((model: { apiName: string }) => model.apiName === 'gemini-2.5-pro')).toMatchObject({
      label: 'Gemini 2.5 Pro (Google)',
      contextWindow: 1048576,
    })
  })

  test('AI/ML API discovery keeps managed attribution headers over conflicting caller headers', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedHeaders: HeadersInit | undefined
    setMockFetch(mock((_input, init) => {
      capturedHeaders = init?.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o', type: 'chat-completion' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('aimlapi', {
      forceRefresh: true,
      headers: {
        'X-AIMLAPI-Source': 'agent/attacker',
        'X-AIMLAPI-Partner-ID': 'part_attackerOverride',
        'X-AIMLAPI-Integration-Repo': 'attacker/repo',
        'X-AIMLAPI-Integration-Version': '0.0.0-attacker',
        'HTTP-Referer': 'https://attacker.example',
        'X-Title': 'Attacker',
        'X-Tenant': 'acme',
      },
    })

    expect(result?.source).toBe('network')
    expect(capturedHeaders).toEqual({
      'X-AIMLAPI-Source': 'agent/openclaude',
      'X-AIMLAPI-Partner-ID': 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
      'X-AIMLAPI-Integration-Repo': 'Twigpine/openclaude',
      'X-AIMLAPI-Integration-Version': publicBuildVersion,
      'HTTP-Referer': 'OpenClaude',
      'X-Title': 'OpenClaude',
      'X-Tenant': 'acme',
    })
  })

  test('AI/ML API discovery ignores mixed-case caller attribution headers', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedHeaders: HeadersInit | undefined
    setMockFetch(mock((_input, init) => {
      capturedHeaders = init?.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o', type: 'chat-completion' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('aimlapi', {
      forceRefresh: true,
      headers: {
        'x-aimlapi-source': 'agent/attacker',
        'x-aimlapi-partner-id': 'part_attackerOverride',
        'x-aimlapi-integration-repo': 'attacker/repo',
        'x-aimlapi-integration-version': '0.0.0-attacker',
        'http-referer': 'https://attacker.example',
        'HTTP-REFERER': 'https://attacker.example/referer',
        'x-title': 'Attacker',
        'X-Tenant': 'acme',
      },
    })

    expect(result?.source).toBe('network')
    const headers = new Headers(capturedHeaders)
    expect(headers.get('x-aimlapi-source')).toBe('agent/openclaude')
    expect(headers.get('x-aimlapi-partner-id')).toBe(
      'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    )
    expect(headers.get('x-aimlapi-integration-repo')).toBe('Twigpine/openclaude')
    expect(headers.get('x-aimlapi-integration-version')).toBe(publicBuildVersion)
    expect(headers.get('http-referer')).toBe('OpenClaude')
    expect(headers.get('x-title')).toBe('OpenClaude')
    expect(headers.get('x-tenant')).toBe('acme')
    expect(headers.get('x-aimlapi-source')).not.toContain(',')
    expect(headers.get('http-referer')).not.toContain(',')
  })

  test('AI/ML API proxy discovery strips mixed-case attribution and keeps X-Tenant', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    let capturedHeaders: HeadersInit | undefined
    setMockFetch(mock((_input, init) => {
      capturedHeaders = init?.headers
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-4o', type: 'chat-completion' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('aimlapi', {
      forceRefresh: true,
      baseUrl: 'https://proxy.example.test/v1',
      headers: {
        'x-aimlapi-source': 'agent/attacker',
        'X-AIMLAPI-Partner-ID': 'part_attackerOverride',
        'HTTP-REFERER': 'https://attacker.example',
        'x-title': 'Attacker',
        'X-Tenant': 'acme',
      },
    })

    expect(result?.source).toBe('network')
    const headers = new Headers(capturedHeaders)
    expect(headers.get('x-aimlapi-source')).toBeNull()
    expect(headers.get('x-aimlapi-partner-id')).toBeNull()
    expect(headers.get('http-referer')).toBeNull()
    expect(headers.get('x-title')).toBeNull()
    expect(headers.get('x-tenant')).toBe('acme')
  })

  test('AI/ML API discovery maps the live GET /models response shape', async () => {
    // Captured from the public, unauthenticated `GET https://api.aimlapi.com/v1/models`
    // (returns HTTP 200 without credentials). Chat models use `openai/chat-completions`;
    // the same id is also published under non-chat endpoint types (responses/submit,
    // embeddings, image, anthropic/messages) which must be filtered out.
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    setMockFetch(mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'gpt-3.5-turbo',
                type: 'openai/chat-completions',
                info: { name: 'GPT-3.5 Turbo', developer: 'Open AI', contextLength: 16000 },
                aliases: ['openai/gpt-3.5-turbo'],
                tags: ['playground:chat', 'tier:tier_2'],
              },
              {
                id: 'gpt-3.5-turbo',
                type: 'openai/responses/submit',
                info: { name: 'GPT-3.5 Turbo', developer: 'Open AI', contextLength: 16000 },
              },
              {
                id: 'claude-opus-4-1-20250805',
                type: 'openai/chat-completions',
                info: { name: 'Claude 4.1 Opus', developer: 'Anthropic', contextLength: 200000 },
              },
              {
                id: 'text-embedding-3-small',
                type: 'openai/embeddings',
                info: { name: 'Text Embedding 3 Small', developer: 'Open AI' },
              },
              {
                id: 'flux/schnell',
                type: 'openai/image-generations',
                info: { name: 'Flux Schnell', developer: 'Black Forest Labs' },
              },
              {
                id: 'claude-3-5-haiku-20241022',
                type: 'anthropic/messages',
                info: { name: 'Claude 3.5 Haiku', developer: 'Anthropic' },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('aimlapi', { forceRefresh: true })

    // Only `openai/chat-completions` entries survive discovery; the duplicate
    // gpt-3.5-turbo (responses/submit), embeddings, image, and anthropic
    // endpoint types are dropped. The curated `gpt-4o` rides along from the
    // hybrid catalog.
    expect(result?.models.map((model: { apiName: string }) => model.apiName)).toEqual([
      'gpt-4o',
      'gpt-3.5-turbo',
      'claude-opus-4-1-20250805',
    ])
    expect(result?.models.find((model: { apiName: string }) => model.apiName === 'gpt-3.5-turbo')).toMatchObject({
      label: 'GPT-3.5 Turbo (Open AI)',
      contextWindow: 16000,
    })
    expect(result?.models.find((model: { apiName: string }) => model.apiName === 'claude-opus-4-1-20250805')).toMatchObject({
      label: 'Claude 4.1 Opus (Anthropic)',
      contextWindow: 200000,
    })
  })

  test('skips descriptor network discovery when nonessential traffic is disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    process.env.OPENROUTER_API_KEY = 'or-key'
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    setMockFetch(mock(() => {
      throw new Error('unexpected model discovery request')
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('openrouter', {
      apiKey: 'privacy-test-key',
      forceRefresh: true,
    })

    const modelNames =
      result?.models.map((model: { apiName: string }) => model.apiName) ?? []
    expect(['static', 'cache', 'stale-cache']).toContain(result?.source)
    expect(modelNames).toContain('openai/gpt-5-mini')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  test('reads xAI OAuth cache identity without refreshing when discovery traffic is disabled', async () => {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    const xaiCredentials = await import('../utils/xaiCredentials.js')
    const readSpy = spyOn(xaiCredentials, 'readXaiCredentialsAsync').mockResolvedValue({
      accessToken: 'cached-oauth-token',
      refreshToken: 'stable-account-identity',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
    })
    const refreshSpy = spyOn(xaiCredentials, 'resolveXaiAccessToken').mockResolvedValue(
      'refreshed-oauth-token',
    )
    try {
      const { discoverModelsForRoute, getDiscoveryCacheKey } =
        await loadDiscoveryServiceModule()
      await setCachedModels(
        getDiscoveryCacheKey('xai', {
          baseUrl: 'https://api.x.ai/v1',
          apiKey: 'cached-oauth-token',
          cacheKey: 'stable-account-identity',
        }),
        {
          models: [
            {
              id: 'grok-4.7',
              apiName: 'grok-4.7',
              label: 'grok-4.7',
            },
          ],
        },
      )

      const result = await discoverModelsForRoute('xai', { forceRefresh: true })

      expect(result?.source).toBe('cache')
      expect(result?.models.map(model => model.apiName)).toContain('grok-4.7')
      expect(refreshSpy).not.toHaveBeenCalled()
    } finally {
      readSpy.mockRestore()
      refreshSpy.mockRestore()
    }
  })

  test('uses the persisted xAI OAuth cache identity after token rotation', async () => {
    const xaiCredentials = await import('../utils/xaiCredentials.js')
    const initialCredentials = {
      accessToken: 'old-access-token',
      refreshToken: 'old-refresh-token',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
    }
    const refreshedCredentials = {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      cacheIdentity: 'old-refresh-token',
      tokenEndpoint: 'https://auth.x.ai/oauth/token',
    }
    const readSpy = spyOn(xaiCredentials, 'readXaiCredentialsAsync')
      .mockResolvedValueOnce(initialCredentials)
      .mockResolvedValue(refreshedCredentials)
    const refreshSpy = spyOn(xaiCredentials, 'resolveXaiAccessToken').mockResolvedValue(
      'new-access-token',
    )
    try {
      const { resolveDiscoveryRequestOptions } =
        await loadDiscoveryServiceModule()
      const result = await resolveDiscoveryRequestOptions('xai', {
        baseUrl: 'https://api.x.ai/v1',
      })

      expect(result).toMatchObject({
        apiKey: 'new-access-token',
        cacheKey: 'old-refresh-token',
      })
      expect(refreshSpy).toHaveBeenCalledTimes(1)
    } finally {
      readSpy.mockRestore()
      refreshSpy.mockRestore()
    }
  })

  test('startup refresh mode performs discovery for startup routes and then reuses cache', async () => {
    const { refreshStartupDiscoveryForRoute } = await loadDiscoveryServiceModule()

    let callCount = 0
    setMockFetch(mock((input: string | URL | Request) => {
      callCount++
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      expect(url).toBe('http://localhost:1234/v1/models')

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'local-model' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const first = await refreshStartupDiscoveryForRoute('lmstudio')
    const second = await refreshStartupDiscoveryForRoute('lmstudio')

    expect(first?.source).toBe('network')
    expect(first?.models.map((model: { apiName: string }) => model.apiName)).toEqual(['local-model'])
    expect(second?.source).toBe('cache')
    expect(callCount).toBe(1)
  })

  test('refreshStartupDiscoveryForActiveRoute resolves the active startup route from env', async () => {
    const { refreshStartupDiscoveryForActiveRoute } =
      await loadDiscoveryServiceModule()

    const startupEnv: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1',
    }

    setMockFetch(mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'local-model' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    ) as unknown as typeof globalThis.fetch)

    const result = await refreshStartupDiscoveryForActiveRoute({
      processEnv: startupEnv,
    })

    expect(result?.routeId).toBe('lmstudio')
    expect(result?.source).toBe('network')
  })

  test('openai-compatible discovery does not use invalid pooled credentials', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    registerGateway({
      id: 'discovery-invalid-pool-test',
      label: 'Invalid Pool Test',
      defaultBaseUrl: 'https://invalid-pool.example/v1',
      defaultModel: 'gpt-5.5',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
        credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
      },
      transportConfig: { kind: 'openai-compatible' },
      catalog: {
        source: 'dynamic',
        discovery: { kind: 'openai-compatible' },
      },
    })

    setMockFetch(mock((_input, init) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBeNull()
      expect(headers.get('api-key')).toBeNull()
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-5.5' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('discovery-invalid-pool-test', {
      apiKey: 'key-a,SUA_CHAVE',
      forceRefresh: true,
    })

    expect(result?.routeId).toBe('discovery-invalid-pool-test')
    expect(result?.source).toBe('network')
  })

  test('refreshStartupDiscoveryForActiveRoute sends first pooled OpenAI credential', async () => {
    const { refreshStartupDiscoveryForActiveRoute } =
      await loadDiscoveryServiceModule()

    const startupEnv: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://custom.example/v1',
      OPENAI_API_KEYS: 'key-a,key-b',
    }

    setMockFetch(mock((_input, init) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer key-a' })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'gpt-5.5' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await refreshStartupDiscoveryForActiveRoute({
      processEnv: startupEnv,
    })

    expect(result?.routeId).toBe('custom')
    expect(result?.source).toBe('network')
  })

  test('refreshStartupDiscoveryForActiveRoute discovers custom route with hybrid startup discovery', async () => {
    const { refreshStartupDiscoveryForActiveRoute } =
      await loadDiscoveryServiceModule()

    const startupEnv: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:4000/v1',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Test-Case: startup-context',
    }

    setMockFetch(mock((_input, init) => {
      expect(init?.headers).toEqual({ 'X-Test-Case': 'startup-context' })
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'litellm-proxy',
                model_info: { context_length: 1_000_000 },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await refreshStartupDiscoveryForActiveRoute({
      processEnv: startupEnv,
    })

    expect(result?.routeId).toBe('custom')
    expect(result?.source).toBe('network')
    expect((result?.models ?? [])[0]?.contextWindow).toBe(1_000_000)
  })

  test('refreshStartupDiscoveryForActiveRoute partitions custom discovery by env custom headers', async () => {
    const { getDiscoveryCacheKey, refreshStartupDiscoveryForActiveRoute } =
      await loadDiscoveryServiceModule()
    const { getCachedModels } = await import('./discoveryCache.js')

    const startupEnv: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:4000/v1',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: acme',
    }

    setMockFetch(mock((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      expect(url).toBe('http://localhost:4000/v1/models')
      expect(init?.headers).toEqual({ 'X-Tenant': 'acme' })

      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'tenant-model',
                model_info: { context_length: 1_000_000 },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    const result = await refreshStartupDiscoveryForActiveRoute({
      processEnv: startupEnv,
    })
    const cached = await getCachedModels(
      getDiscoveryCacheKey('custom', {
        baseUrl: 'http://localhost:4000/v1',
        headers: { 'X-Tenant': 'acme' },
      }),
      24 * 60 * 60 * 1000,
    )

    expect(result?.routeId).toBe('custom')
    expect(cached?.models[0]?.contextWindow).toBe(1_000_000)
  })

  test('refreshStartupDiscoveryForActiveRoute still skips anthropic route', async () => {
    const { refreshStartupDiscoveryForActiveRoute } =
      await loadDiscoveryServiceModule()

    const startupEnv: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_ANTHROPIC: '1',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    }

    const result = await refreshStartupDiscoveryForActiveRoute({
      processEnv: startupEnv,
    })

    expect(result).toBeNull()
  })

  test('openai-compatible discovery applies mapModel to filter and shape raw entries', async () => {
    const { discoverModelsForRoute } = await loadDiscoveryServiceModule()

    registerGateway({
      id: 'mapmodel-test',
      label: 'MapModel Test',
      category: 'aggregating',
      defaultBaseUrl: 'https://mapmodel-test.example/v1',
      setup: {
        requiresAuth: true,
        authMode: 'api-key',
        credentialEnvVars: ['MAPMODEL_TEST_API_KEY'],
      },
      transportConfig: { kind: 'openai-compatible' },
      catalog: {
        source: 'dynamic',
        discovery: {
          kind: 'openai-compatible',
          mapModel(raw: unknown) {
            const model = raw as { id?: string; active?: boolean; context_window?: number }
            if (!model.id || model.active === false) return null
            if (/(guard|whisper)/i.test(model.id)) return null
            return {
              id: model.id,
              apiName: model.id,
              label: model.id,
              ...(model.context_window ? { contextWindow: model.context_window } : {}),
            }
          },
        },
        discoveryCacheTtl: '1d',
      },
    })

    setMockFetch(mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'llama-3.3-70b', context_window: 131072 },
              { id: 'whisper-large-v3' },
              { id: 'llama-guard-3' },
              { id: 'inactive-model', active: false },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    ) as unknown as typeof globalThis.fetch)

    const result = await discoverModelsForRoute('mapmodel-test', {
      forceRefresh: true,
    })

    expect(result?.source).toBe('network')
    expect(result?.models).toEqual([
      { id: 'llama-3.3-70b', apiName: 'llama-3.3-70b', label: 'llama-3.3-70b', contextWindow: 131072 },
    ])
  })
})

describe('probeRouteReadiness', () => {
  test('drives ollama readiness through descriptor metadata', async () => {
    const { probeRouteReadiness } = await loadDiscoveryServiceModule()

    setMockFetch(mock((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/tags')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              models: [{ name: 'llama3.1:8b', size: 1024 }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: { role: 'assistant', content: 'OK' },
            done: true,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch)

    await expect(probeRouteReadiness('ollama')).resolves.toMatchObject({
      state: 'ready',
      probeModel: 'llama3.1:8b',
    })
  })

  test('drives atomic chat readiness through descriptor metadata', async () => {
    const { probeRouteReadiness } = await loadDiscoveryServiceModule()

    setMockFetch(mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ id: 'Qwen3_5-4B_Q4_K_M' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    ) as unknown as typeof globalThis.fetch)

    await expect(probeRouteReadiness('atomic-chat')).resolves.toEqual({
      state: 'ready',
      models: ['Qwen3_5-4B_Q4_K_M'],
    })
  })
})

describe('resolveDiscoveryRouteIdFromBaseUrl', () => {
  test('matches descriptor-backed routes by exact default base URL', async () => {
    const { resolveDiscoveryRouteIdFromBaseUrl } =
      await loadDiscoveryServiceModule()

    expect(
      resolveDiscoveryRouteIdFromBaseUrl('http://127.0.0.1:1337/v1'),
    ).toBe('atomic-chat')
    expect(
      resolveDiscoveryRouteIdFromBaseUrl('http://localhost:1234/v1'),
    ).toBe('lmstudio')
  })

  test('falls back to local-provider heuristics for Ollama aliases', async () => {
    const { resolveDiscoveryRouteIdFromBaseUrl } =
      await loadDiscoveryServiceModule()

    expect(
      resolveDiscoveryRouteIdFromBaseUrl('http://127.0.0.1:11434/v1'),
    ).toBe('ollama')
  })
})
