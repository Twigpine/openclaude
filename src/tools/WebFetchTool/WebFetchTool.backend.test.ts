import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'

import * as claudeApi from '../../services/api/claude.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'
import { createAssistantMessage } from '../../utils/messages/factories.js'

// WebFetch hands scraped markdown to the secondary model. Each test routes
// queryHaiku to this stub only for the duration of the WebFetch call. A spy
// can reuse an earlier file's mock, so preserve that mock's implementation
// and count calls on our own stub.
const haikuStub = mock(async ({ userPrompt }: { userPrompt: string }) =>
  createAssistantMessage({
    content: `summary of: ${userPrompt.includes('# Scraped page') ? 'scraped page' : 'other'}`,
  }),
)
const fetchMock = mock()
const originalFetch = globalThis.fetch
// The route and both base-URL spellings decide whether AIMLAPI_API_KEY may be
// sent: an ambient aimlapi proxy profile would withhold the test key, so they
// are cleared along with the backend selectors.
const ENV_KEYS = [
  'AIMLAPI_API_KEY',
  'FIRECRAWL_API_KEY',
  'FIRECRAWL_API_URL',
  'WEB_FETCH_PROVIDER',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
] as const
let restoreEnv: (() => void) | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/WebFetchTool/WebFetchTool.backend.test.ts')
  restoreEnv = snapshotEnv(ENV_KEYS, { clear: true })
  haikuStub.mockClear()
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
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    restoreEnv?.()
    restoreEnv = undefined
  } finally {
    releaseSharedMutationLock()
  }
})

async function runWebFetch(url = 'https://example.com/page') {
  const nonce = `${Date.now()}-${Math.random()}`
  const { WebFetchTool } = await import(`./WebFetchTool.js?ts=${nonce}`)
  const previousQueryHaiku = claudeApi.queryHaiku
  const haikuSpy = spyOn(claudeApi, 'queryHaiku')
  try {
    let result!: Awaited<ReturnType<typeof WebFetchTool.call>>
    await haikuSpy.withImplementation(haikuStub, async () => {
      result = await WebFetchTool.call(
        { url, prompt: 'summarize' },
        {
          abortController: new AbortController(),
          options: { isNonInteractiveSession: true },
        } as Parameters<typeof WebFetchTool.call>[1],
      )
    })
    return result
  } finally {
    // withImplementation restores inherited mocks, including on rejection.
    // Only remove the spy when this call created it.
    if (haikuSpy !== previousQueryHaiku) haikuSpy.mockRestore()
  }
}

function requestedHosts(): string[] {
  return fetchMock.mock.calls.map(call => new URL(String(call[0])).hostname)
}

test('an AI/ML API key alone keeps WebFetch on the Firecrawl backend', async () => {
  process.env.AIMLAPI_API_KEY = 'aiml-test-key'
  process.env.FIRECRAWL_API_KEY = 'fc-test-key'

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
  expect(haikuStub).not.toHaveBeenCalled()
})
