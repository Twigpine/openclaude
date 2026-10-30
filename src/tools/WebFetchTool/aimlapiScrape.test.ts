import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { asMockFetch, callArgs } from '../../test/typedMocks.js'
import {
  AIMLAPI_WEB_FETCH_MAX_COST_USD,
  AIMLAPI_WEB_FETCH_TOOL_ID,
  isAimlapiWebFetchSelected,
  scrapeWithAimlapi,
} from './aimlapiScrape.js'

const originalFetch = globalThis.fetch
const originalEnv = {
  AIMLAPI_API_KEY: process.env.AIMLAPI_API_KEY,
  WEB_FETCH_PROVIDER: process.env.WEB_FETCH_PROVIDER,
  CLAUDE_CODE_PROVIDER_ROUTE_ID: process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(() => {
  // An ambient aimlapi proxy profile would withhold the key from every test.
  delete process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(originalEnv)) restoreEnv(key, value)
})

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function completedRun(content: string): Record<string, unknown> {
  return {
    id: 'run-1',
    tool: AIMLAPI_WEB_FETCH_TOOL_ID,
    status: 'completed',
    is_error: false,
    untrusted: true,
    output: {
      crawlParameters: { url: 'https://example.com' },
      results: { title: 'Example', link: 'https://example.com', content },
    },
    cost: { quoted_usd: 0.0013, actual_usd: 0.0013, credits: 2600, over_max: false },
  }
}

function requestBody(fetchMock: Parameters<typeof asMockFetch>[0], index: number): Record<string, unknown> {
  const init = callArgs(fetchMock, index)[1] as RequestInit
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

describe('AI/ML API WebFetch backend selection', () => {
  test('an AI/ML API key alone does not select the paid backend', () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    delete process.env.WEB_FETCH_PROVIDER

    expect(isAimlapiWebFetchSelected()).toBe(false)
  })

  test('WEB_FETCH_PROVIDER=aimlapi selects it, ignoring case and spaces', () => {
    process.env.WEB_FETCH_PROVIDER = ' AIMLAPI '
    expect(isAimlapiWebFetchSelected()).toBe(true)

    process.env.WEB_FETCH_PROVIDER = 'firecrawl'
    expect(isAimlapiWebFetchSelected()).toBe(false)
  })
})

describe('scrapeWithAimlapi', () => {
  test('runs the pinned tool with a cost cap, bearer auth and attribution headers', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const fetchMock = mock(async (input: unknown, init?: RequestInit) => {
      expect(String(input)).toBe('https://tools.aimlapi.com/v1/tools/run')
      expect(init?.method).toBe('POST')
      expect(init?.redirect).toBe('error')
      const headers = init?.headers as Record<string, string>
      expect(headers.Authorization).toBe('Bearer aiml-test-key')
      expect(headers['X-AIMLAPI-Source']).toBe('agent/openclaude')
      expect(headers['X-AIMLAPI-Partner-ID']).toBe('part_62yQoGYDq4Yqnrj2R1iGrDNJ')
      return json(completedRun('# Héllo'))
    })
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).resolves.toEqual({
      markdown: '# Héllo',
      bytes: Buffer.byteLength('# Héllo'),
    })

    const body = requestBody(fetchMock, 0)
    expect(body).toMatchObject({
      tool: 'search1api/crawl',
      input: { url: 'https://example.com' },
      max_cost_usd: AIMLAPI_WEB_FETCH_MAX_COST_USD,
    })
    expect(typeof body.idempotency_key).toBe('string')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('requires an AI/ML API key and sends nothing without one', async () => {
    delete process.env.AIMLAPI_API_KEY
    const fetchMock = mock(async () => json(completedRun('unused')))
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'WEB_FETCH_PROVIDER=aimlapi needs an AI/ML API key',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('does not send a key exported by an aimlapi profile that points at a proxy', async () => {
    process.env.AIMLAPI_API_KEY = 'proxy-credential'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
    process.env.OPENAI_BASE_URL = 'https://my-proxy.example.com/v1'
    const fetchMock = mock(async () => json(completedRun('unused')))
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'WEB_FETCH_PROVIDER=aimlapi needs an AI/ML API key',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('uses the key of an aimlapi profile on the canonical endpoint', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-profile-key'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
    process.env.OPENAI_BASE_URL = 'https://api.aimlapi.com/v1'
    const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer aiml-profile-key')
      return json(completedRun('# Canonical'))
    })
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).resolves.toMatchObject({
      markdown: '# Canonical',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not send a proxy profile key when only the OPENAI_API_BASE alias is set', async () => {
    process.env.AIMLAPI_API_KEY = 'proxy-credential'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
    process.env.OPENAI_API_BASE = 'https://my-proxy.example.com/v1'
    const fetchMock = mock(async () => json(completedRun('unused')))
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'WEB_FETCH_PROVIDER=aimlapi needs an AI/ML API key',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('sends only the first key of a pooled AIMLAPI_API_KEY', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-first-key, aiml-second-key'
    const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer aiml-first-key')
      return json(completedRun('# Pooled'))
    })
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).resolves.toMatchObject({
      markdown: '# Pooled',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('refuses a redirect, so the key and attribution never leave the Toolbox host', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const fetchMock = mock(async (_input: unknown, init?: RequestInit) => {
      // What fetch does with a 3xx response when redirect is 'error'.
      if (init?.redirect === 'error') throw new TypeError('unexpected redirect')
      return new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } })
    })
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow('unexpected redirect')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('redacts the key when the Toolbox echoes it in an error', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-echoed-key'
    globalThis.fetch = asMockFetch(mock(async () =>
      json({ error: { code: 'invalid_api_key', message: 'Key aiml-echoed-key is not valid.' } }, 401),
    ))

    const error = String(await scrapeWithAimlapi('https://example.com').catch(e => e))
    expect(error).toContain('AI/ML API Toolbox run error 401 (invalid_api_key): Key [redacted] is not valid.')
    expect(error).not.toContain('aiml-echoed-key')
  })

  test('polls a queued (202) run until it completes', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const responses = [
      json({ id: 'run 7', status: 'queued', next_poll_hint_ms: 1 }, 202),
      json({ id: 'run 7', status: 'running', next_poll_hint_ms: 1 }),
      json({ ...completedRun('# Done'), id: 'run 7' }),
    ]
    const fetchMock = mock(async () => responses.shift()!)
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).resolves.toMatchObject({
      markdown: '# Done',
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const [pollUrl, pollInit] = callArgs(fetchMock, 1) as [string, RequestInit]
    expect(pollUrl).toBe('https://tools.aimlapi.com/v1/tools/runs/run%207')
    expect(pollInit.method).toBe('GET')
    expect(pollInit.redirect).toBe('error')
    expect((pollInit.headers as Record<string, string>)['X-AIMLAPI-Partner-ID']).toBe(
      'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
    )
  })

  test('reports an is_error run with its message instead of returning content', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    globalThis.fetch = asMockFetch(mock(async () =>
      json({
        id: 'run-2',
        status: 'completed',
        is_error: true,
        error: {
          kind: 'no_results',
          retryable: false,
          message: 'The provider found no data for this input (HTTP 404).',
        },
        cost: { quoted_usd: 0.0013, actual_usd: 0, credits: 0, over_max: false },
      }),
    ))

    await expect(scrapeWithAimlapi('https://example.com/missing')).rejects.toThrow(
      'search1api/crawl failed for https://example.com/missing: The provider found no data for this input (HTTP 404).',
    )
  })

  test('reports a run that ended in a failed status', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    globalThis.fetch = asMockFetch(mock(async () =>
      json({ id: 'run-3', status: 'timed_out', cost: { over_max: true } }),
    ))

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'run ended with status timed_out. The run hit the $0.005 max_cost_usd cap.',
    )
  })

  test('surfaces an over-cost refusal without retrying it', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const fetchMock = mock(async () =>
      json(
        {
          error: {
            message: 'The cheapest source costs 0.0013 USD, above the limit of 0.001 USD.',
            type: 'invalid_request_error',
            code: 'max_cost_exceeded',
          },
        },
        400,
      ),
    )
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'AI/ML API Toolbox run error 400 (max_cost_exceeded): The cheapest source costs 0.0013 USD, above the limit of 0.001 USD.',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('retries a rate-limited run with the same idempotency key', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const responses = [
      json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429),
      json(completedRun('# After retry')),
    ]
    const fetchMock = mock(async () => responses.shift()!)
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(
      scrapeWithAimlapi('https://example.com', { backoffMs: 1 }),
    ).resolves.toMatchObject({ markdown: '# After retry' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchMock, 1).idempotency_key).toBe(
      requestBody(fetchMock, 0).idempotency_key,
    )
  })

  test('gives up on rate limiting after the last attempt', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    const fetchMock = mock(async () =>
      json({ error: { code: 'rate_limited', message: 'Too many requests' } }, 429),
    )
    globalThis.fetch = asMockFetch(fetchMock)

    await expect(
      scrapeWithAimlapi('https://example.com', { backoffMs: 1, maxAttempts: 2 }),
    ).rejects.toThrow('AI/ML API Toolbox run error 429 (rate_limited): Too many requests')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('rejects a completed run without page content', async () => {
    process.env.AIMLAPI_API_KEY = 'aiml-test-key'
    globalThis.fetch = asMockFetch(mock(async () =>
      json({ ...completedRun(''), output: { results: {} } }),
    ))

    await expect(scrapeWithAimlapi('https://example.com')).rejects.toThrow(
      'search1api/crawl returned no page content for https://example.com.',
    )
  })
})
