import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import axios from 'axios'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
type ProvidersModule = typeof import('../../utils/model/providers.js')

const originalEnv = { ...process.env }
const originalAxiosGet = axios.get
let originalProvidersModule: ProvidersModule | undefined

async function importFreshModule() {
  mock.restore()
  return import(`./officialRegistry.ts?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(async () => {
  await acquireSharedMutationLock('services/mcp/officialRegistry.test.ts')
  process.env = { ...originalEnv }
})

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    axios.get = originalAxiosGet
    mock.restore()
    if (originalProvidersModule) {
      mock.module('../../utils/model/providers.js', () => originalProvidersModule!)
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importActualProviders(): Promise<ProvidersModule> {
  return {
    ...await import(
      `../../utils/model/providers.ts?officialRegistryActual=${Date.now()}-${Math.random()}`
    ),
  }
}

async function mockApiProvider(provider: string): Promise<void> {
  originalProvidersModule ??= await importActualProviders()
  mock.module('../../utils/model/providers.js', () => ({
    ...originalProvidersModule!,
    getAPIProvider: () => provider,
  }))
}

describe('prefetchOfficialMcpUrls', () => {
  test('does not fetch registry when using OpenAI mode', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    await mockApiProvider('openai')
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('does not fetch registry when using Gemini mode', async () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    await mockApiProvider('gemini')
    const getSpy = mock(() => Promise.resolve({ data: { servers: [] } }))
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).not.toHaveBeenCalled()
  })

  test('fetches registry in first-party mode', async () => {
    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_GITHUB

    await mockApiProvider('firstParty')
    const getSpy = mock(() =>
      Promise.resolve({
        data: {
          servers: [{ server: { remotes: [{ url: 'https://example.com/mcp' }] } }],
        },
      }),
    )
    axios.get = getSpy as typeof axios.get

    const { prefetchOfficialMcpUrls, isOfficialMcpUrl } = await importFreshModule()
    await prefetchOfficialMcpUrls()

    expect(getSpy).toHaveBeenCalledTimes(1)
    expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(true)
  })
})
