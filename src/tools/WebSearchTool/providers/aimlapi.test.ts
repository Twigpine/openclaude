import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'

import { AIMLAPI_SEARCH_MAX_COST_USD, aimlapiProvider } from './aimlapi.ts'

await acquireSharedMutationLock('WebSearchTool/providers/aimlapi.test.ts')

const originalEnv = {
  AIMLAPI_API_KEY: process.env.AIMLAPI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDE_CODE_PROVIDER_ROUTE_ID: process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID,
  WEB_SEARCH_TIMEOUT_SEC: process.env.WEB_SEARCH_TIMEOUT_SEC,
}

const originalFetch = globalThis.fetch
const TEST_KEY = 'aiml-test-key'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
  redirect: RequestRedirect | undefined
}

/** Replace fetch with a queue of canned responses and record every request. */
function mockFetch(responses: Array<() => Response>): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      redirect: init?.redirect,
    })
    const next = responses.shift()
    if (!next) throw new Error(`unexpected request to ${String(input)}`)
    return next()
  }) as typeof fetch
  return requests
}

function json(body: unknown, status = 200): () => Response {
  return () => new Response(JSON.stringify(body), { status })
}

function completedRun(results: unknown[]): Record<string, unknown> {
  return {
    id: 'run_1',
    tool: 'web/search',
    status: 'completed',
    is_error: false,
    untrusted: true,
    output: { results },
    cost: { quoted_usd: 0.013, actual_usd: 0.013, credits: 26000, over_max: false },
  }
}

beforeEach(() => {
  process.env.AIMLAPI_API_KEY = TEST_KEY
  delete process.env.WEB_SEARCH_TIMEOUT_SEC
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID
})

afterEach(() => {
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  globalThis.fetch = originalFetch
})

afterAll(() => {
  releaseSharedMutationLock()
})

describe('aimlapiProvider isConfigured', () => {
  test('true when AIMLAPI_API_KEY is set', () => {
    expect(aimlapiProvider.isConfigured()).toBe(true)
  })

  test('false when AIMLAPI_API_KEY is missing or blank', () => {
    delete process.env.AIMLAPI_API_KEY
    expect(aimlapiProvider.isConfigured()).toBe(false)
    process.env.AIMLAPI_API_KEY = '   '
    expect(aimlapiProvider.isConfigured()).toBe(false)
  })

  test.each(['OPENAI_BASE_URL', 'OPENAI_API_BASE'])('uses OPENAI_API_KEY only while %s is canonical', async baseEnv => {
    delete process.env.AIMLAPI_API_KEY
    process.env.OPENAI_API_KEY = 'openai-route-key'

    process.env[baseEnv] = 'https://api.openai.com/v1'
    expect(aimlapiProvider.isConfigured()).toBe(false)
    process.env[baseEnv] = 'https://proxy.example.com/aimlapi/v1'
    expect(aimlapiProvider.isConfigured()).toBe(false)

    process.env[baseEnv] = 'https://api.aimlapi.com/v1'
    expect(aimlapiProvider.isConfigured()).toBe(true)
    const requests = mockFetch([json(completedRun([]))])
    await aimlapiProvider.search({ query: 'q' })
    expect(requests[0].headers.Authorization).toBe('Bearer openai-route-key')
  })

  test.each(['OPENAI_BASE_URL', 'OPENAI_API_BASE'])('withholds a proxy-marked key when %s is noncanonical', async baseEnv => {
    // A proxy-marked environment must not share its credential with the Toolbox.
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
    process.env[baseEnv] = 'https://proxy.example.com/v1'
    process.env.AIMLAPI_API_KEY = 'proxy-credential'
    process.env.OPENAI_API_KEY = 'proxy-credential'

    expect(aimlapiProvider.isConfigured()).toBe(false)
    const requests = mockFetch([json(completedRun([]))])
    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(/AIMLAPI_API_KEY/)
    expect(requests).toHaveLength(0)

    // The same marker with a canonical endpoint keeps working.
    process.env[baseEnv] = 'https://api.aimlapi.com/v1'
    expect(aimlapiProvider.isConfigured()).toBe(true)
  })

  test.each([
    ['https://api.aimlapi.com/v1', 'https://proxy.example.com/v1', true],
    ['https://proxy.example.com/v1', 'https://api.aimlapi.com/v1', false],
  ] as const)('keeps primary base %s ahead of alias %s', async (primary, alias, configured) => {
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
    process.env.OPENAI_BASE_URL = primary
    process.env.OPENAI_API_BASE = alias
    expect(aimlapiProvider.isConfigured()).toBe(configured)
    const requests = mockFetch([json(completedRun([]))])
    if (configured) {
      await aimlapiProvider.search({ query: 'q' })
      expect(requests[0].headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    } else {
      await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(/AIMLAPI_API_KEY/)
      expect(requests).toHaveLength(0)
    }
  })
})

describe('aimlapiProvider search', () => {
  test('runs web/search on the Toolbox with the key, attribution, and a cost cap', async () => {
    const requests = mockFetch([json(completedRun([]))])

    await aimlapiProvider.search({ query: 'hello' })

    expect(requests).toHaveLength(1)
    const [run] = requests
    expect(run.url).toBe('https://tools.aimlapi.com/v1/tools/run')
    expect(run.method).toBe('POST')
    expect(run.redirect).toBe('error')
    expect(run.headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
    expect(run.headers['X-AIMLAPI-Source']).toBe('agent/openclaude')
    expect(run.headers['X-AIMLAPI-Partner-ID']).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')
    expect(run.body).toEqual({
      tool: 'web/search',
      input: { query: 'hello', max_results: 10 },
      max_cost_usd: 0.025,
      wait_ms: 13_000,
    })
    expect(AIMLAPI_SEARCH_MAX_COST_USD).toBe(0.025)
  })

  test('maps output.results into SearchHit shape', async () => {
    mockFetch([json(completedRun([
      {
        url: 'https://nodejs.org/en/blog/release',
        title: 'Node.js',
        snippet: 'Node.js 24.22.0 (LTS)',
        published_at: '2026-10-14T15:26:48.000Z',
      },
      { url: 'https://github.com/nodejs/node/releases', title: 'Releases', snippet: 'v26.12.0' },
      { url: 'https://example.com/untitled', snippet: '' },
      { title: 'No URL', snippet: 'dropped' },
      'not an object',
    ]))])

    const out = await aimlapiProvider.search({ query: 'node' })

    expect(out.providerName).toBe('aimlapi')
    expect(out.hits).toEqual([
      {
        title: 'Node.js',
        url: 'https://nodejs.org/en/blog/release',
        description: '(2026-10-14) Node.js 24.22.0 (LTS)',
        source: 'nodejs.org',
      },
      {
        title: 'Releases',
        url: 'https://github.com/nodejs/node/releases',
        description: 'v26.12.0',
        source: 'github.com',
      },
      {
        title: 'https://example.com/untitled',
        url: 'https://example.com/untitled',
        source: 'example.com',
      },
    ])
  })

  test('sends allowed_domains as include_domains and enforces both domain lists', async () => {
    const requests = mockFetch([json(completedRun([
      { url: 'https://docs.example.com/a', title: 'Allowed', snippet: 'a' },
      { url: 'https://blocked.example.com/b', title: 'Blocked', snippet: 'b' },
      { url: 'https://elsewhere.org/c', title: 'Not allowed', snippet: 'c' },
    ]))])

    const out = await aimlapiProvider.search({
      query: 'q',
      allowed_domains: ['example.com'],
      blocked_domains: ['blocked.example.com'],
    })

    expect((requests[0].body as { input: unknown }).input).toEqual({
      query: 'q',
      max_results: 10,
      include_domains: ['example.com'],
    })
    expect(out.hits.map(h => h.title)).toEqual(['Allowed'])
  })

  test('polls a queued (202) run until it completes', async () => {
    const requests = mockFetch([
      json({ id: 'run/1', status: 'queued', next_poll_hint_ms: 1 }, 202),
      json({ id: 'run/1', status: 'running', next_poll_hint_ms: 1 }),
      json(completedRun([{ url: 'https://example.com/', title: 'Done', snippet: 's' }])),
    ])

    const out = await aimlapiProvider.search({ query: 'slow' })

    expect(out.hits.map(h => h.title)).toEqual(['Done'])
    expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
      'POST https://tools.aimlapi.com/v1/tools/run',
      'GET https://tools.aimlapi.com/v1/tools/runs/run%2F1',
      'GET https://tools.aimlapi.com/v1/tools/runs/run%2F1',
    ])
    for (const poll of requests.slice(1)) {
      expect(poll.body).toBeUndefined()
      expect(poll.redirect).toBe('error')
      expect(poll.headers.Authorization).toBe(`Bearer ${TEST_KEY}`)
      expect(poll.headers['X-AIMLAPI-Source']).toBe('agent/openclaude')
      expect(poll.headers['X-AIMLAPI-Partner-ID']).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')
    }
  })

  test('refuses a redirect, so the key and attribution never leave the Toolbox host', async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), redirect: init?.redirect })
      // What fetch does with a 3xx response when redirect is 'error'.
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect')
      return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })
    }) as typeof fetch

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow('unexpected redirect')
    expect(requests).toEqual([
      { url: 'https://tools.aimlapi.com/v1/tools/run', redirect: 'error' },
    ])
  })

  test('throws when a polled run ends without completing', async () => {
    mockFetch([
      json({ id: 'run_2', status: 'queued', next_poll_hint_ms: 1 }, 202),
      json({ id: 'run_2', status: 'timed_out', is_error: true, error: { message: 'source too slow' } }),
    ])

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      'AI/ML API web/search run timed_out: source too slow',
    )
  })

  test('throws on an is_error run, noting when it is retryable', async () => {
    mockFetch([json({
      id: 'run_3',
      status: 'failed',
      is_error: true,
      error: { message: 'upstream search failed', retryable: true },
    })])

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      'AI/ML API web/search run failed: upstream search failed (retryable)',
    )
  })

  test('treats is_error as a failure even when the status says completed', async () => {
    mockFetch([json({ ...completedRun([]), is_error: true, error: { message: 'bad output' } })])

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(/run completed: bad output/)
  })

  test('rejects a completed run without a results list', async () => {
    mockFetch([json({ id: 'run_4', status: 'completed', is_error: false, output: {} })])

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      'AI/ML API web/search returned no results list',
    )
  })

  test('reports HTTP errors with their code and a hint, without the key', async () => {
    mockFetch([json({
      title: 'Unauthorized',
      status: 401,
      message: 'This request requires a valid API key.',
      requestId: 'req-401',
    }, 401)])
    const authError = String(await aimlapiProvider.search({ query: 'q' }).catch(e => e))
    expect(authError).toContain(
      'AI/ML API search error HTTP 401 (check AIMLAPI_API_KEY): This request requires a valid API key. (request_id: req-401)',
    )
    expect(authError).not.toContain(TEST_KEY)

    mockFetch([json({
      error: { code: 'max_cost_exceeded', message: 'The cheapest source costs 0.03 USD, above the limit of 0.025 USD.' },
    }, 400)])
    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      'AI/ML API search error HTTP 400 max_cost_exceeded: The cheapest source costs 0.03 USD',
    )

    mockFetch([json({ error: { code: 'insufficient_funds', message: 'Balance too low' } }, 403)])
    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      'HTTP 403 insufficient_funds (top up your AI/ML API balance): Balance too low',
    )
  })

  test('throws without a key and makes no request', async () => {
    delete process.env.AIMLAPI_API_KEY
    const requests = mockFetch([])
    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(/AIMLAPI_API_KEY/)
    expect(requests).toHaveLength(0)
  })

  test('rejects when the provider-level timeout elapses', async () => {
    process.env.WEB_SEARCH_TIMEOUT_SEC = '1'
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch

    await expect(aimlapiProvider.search({ query: 'q' })).rejects.toThrow(
      /AI\/ML API search timed out after 1s/,
    )
  })
})
