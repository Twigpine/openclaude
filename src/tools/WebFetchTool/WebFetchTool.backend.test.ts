import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'

// WebFetch hands scraped markdown to the secondary model. Mock it so the test
// exercises only backend selection.
const haikuMock = mock()
const fetchMock = mock()
const originalFetch = globalThis.fetch
const ENV_KEYS = ['AIMLAPI_API_KEY', 'FIRECRAWL_API_KEY', 'FIRECRAWL_API_URL', 'WEB_FETCH_PROVIDER'] as const
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(async () => {
  await acquireSharedMutationLock('tools/WebFetchTool/WebFetchTool.backend.test.ts')
  haikuMock.mockReset()
  haikuMock.mockImplementation(async ({ userPrompt }: { userPrompt: string }) => ({
    message: { content: [{ type: 'text', text: `summary of: ${userPrompt.includes('# Scraped page') ? 'scraped page' : 'other'}` }] },
  }))
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (input: unknown) => {
    const host = new URL(String(input)).hostname
    if (host === 'tools.aimlapi.com') {
      return Response.json({
        id: 'run-1',
        status: 'completed',
        is_error: false,
        output: { results: { content: '# Scraped page' } },
        cost: { quoted_usd: 0.0013, actual_usd: 0.0013, over_max: false },
      })
    }
    if (host === 'api.firecrawl.dev') {
      return Response.json({ success: true, data: { markdown: '# Scraped page' } })
    }
    throw new Error(`unexpected request to ${host}`)
  })
  globalThis.fetch = asMockFetch(fetchMock)
  const actual = await import('../../services/api/claude.js')
  mock.module('../../services/api/claude.js', () => ({
    ...actual,
    queryHaiku: haikuMock,
  }))
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

async function runWebFetch(url = 'https://example.com/page') {
  const nonce = `${Date.now()}-${Math.random()}`
  const { WebFetchTool } = await import(`./WebFetchTool.js?ts=${nonce}`)
  return WebFetchTool.call(
    { url, prompt: 'summarize' },
    {
      abortController: new AbortController(),
      options: { isNonInteractiveSession: true },
    } as Parameters<typeof WebFetchTool.call>[1],
  )
}

function requestedHosts(): string[] {
  return fetchMock.mock.calls.map(call => new URL(String(call[0])).hostname)
}

test('an AI/ML API key alone keeps WebFetch on the Firecrawl backend', async () => {
  process.env.AIMLAPI_API_KEY = 'aiml-test-key'
  process.env.FIRECRAWL_API_KEY = 'fc-test-key'
  delete process.env.FIRECRAWL_API_URL
  delete process.env.WEB_FETCH_PROVIDER

  const { data } = await runWebFetch()

  expect(requestedHosts()).toEqual(['api.firecrawl.dev'])
  expect(data.result).toBe('summary of: scraped page')
})

test('WEB_FETCH_PROVIDER=aimlapi scrapes through the AI/ML API Toolbox, ahead of Firecrawl', async () => {
  process.env.AIMLAPI_API_KEY = 'aiml-test-key'
  process.env.FIRECRAWL_API_KEY = 'fc-test-key'
  process.env.WEB_FETCH_PROVIDER = 'aimlapi'

  const { data } = await runWebFetch()

  expect(requestedHosts()).toEqual(['tools.aimlapi.com'])
  expect(data).toMatchObject({
    bytes: Buffer.byteLength('# Scraped page'),
    code: 200,
    result: 'summary of: scraped page',
    url: 'https://example.com/page',
  })
})

test('an AI/ML API failure is reported, not retried through another backend', async () => {
  process.env.AIMLAPI_API_KEY = 'aiml-test-key'
  process.env.FIRECRAWL_API_KEY = 'fc-test-key'
  process.env.WEB_FETCH_PROVIDER = 'aimlapi'
  fetchMock.mockImplementation(async () =>
    Response.json({
      id: 'run-2',
      status: 'completed',
      is_error: true,
      error: { kind: 'provider_error', retryable: false, message: 'The provider answered HTTP 400.' },
    }),
  )

  await expect(runWebFetch()).rejects.toThrow('The provider answered HTTP 400.')
  expect(requestedHosts()).toEqual(['tools.aimlapi.com'])
  expect(haikuMock).not.toHaveBeenCalled()
})
