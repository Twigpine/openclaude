import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { asMockFetch } from '../test/typedMocks.js'

const providerSpecifier = './model/providers.js'
const realProvidersForCleanup = {
  ...await import(
    `${providerSpecifier}?real=${Date.now()}-${Math.random()}`
  ),
}

afterAll(() => {
  mock.restore()
  mock.module(providerSpecifier, () => realProvidersForCleanup)
})

const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch

function getMockApiProvider() {
  if (process.env.CLAUDE_CODE_USE_OPENAI === '1') return 'openai'
  if (process.env.CLAUDE_CODE_USE_GEMINI === '1') return 'gemini'
  if (process.env.CLAUDE_CODE_USE_GITHUB === '1') return 'github'
  return 'firstParty'
}

async function importFreshModule() {
  mock.restore()
  const actualProviders = await import(
    `./model/providers.ts?actual=${Date.now()}-${Math.random()}`,
  )
  mock.module('./model/providers.js', () => ({
    ...actualProviders,
    getAPIProvider: getMockApiProvider,
  }))
  return import(`./apiPreconnect.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/apiPreconnect.test.ts')
  process.env = { ...originalEnv }
})

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    globalThis.fetch = originalFetch
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('preconnectAnthropicApi', () => {
  // The provider is injected directly rather than mocking getAPIProvider():
  // bun does not unregister mock.module() overrides, so a leaked providers.js
  // mock from another test file (e.g. fastMode) would otherwise force
  // getAPIProvider() to 'firstParty' here and break these assertions.
  test('does not fetch when OpenAI mode is enabled', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = asMockFetch(fetchMock)

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi('openai')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when Gemini mode is enabled', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = asMockFetch(fetchMock)

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi('gemini')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not fetch when GitHub mode is enabled', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = asMockFetch(fetchMock)

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi('github')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fetches in first-party mode', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_MISTRAL
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.OPENAI_MODEL
    delete process.env.OPENAI_API_KEY
    delete process.env.XAI_API_KEY
    delete process.env.MINIMAX_API_KEY
    delete process.env.VENICE_API_KEY
    delete process.env.MIMO_API_KEY
    delete process.env.NVIDIA_NIM
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.HTTPS_PROXY
    delete process.env.https_proxy
    delete process.env.HTTP_PROXY
    delete process.env.http_proxy
    delete process.env.ANTHROPIC_UNIX_SOCKET
    delete process.env.CLAUDE_CODE_CLIENT_CERT
    delete process.env.CLAUDE_CODE_CLIENT_KEY

    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = asMockFetch(fetchMock)

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi('firstParty')

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not preconnect to a custom Anthropic endpoint', async () => {
    process.env.ANTHROPIC_BASE_URL = 'https://tenant.example'
    const fetchMock = mock(() => Promise.resolve(new Response(null, { status: 200 })))
    globalThis.fetch = asMockFetch(fetchMock)

    const { preconnectAnthropicApi } = await importFreshModule()
    preconnectAnthropicApi('firstParty')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('keeps non-mocked provider exports available to neighboring imports', async () => {
    await importFreshModule()

    const providers = await import('./model/providers.js')

    expect(typeof providers.isFirstPartyAnthropicBaseUrl).toBe('function')
  })
})
