import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import { anysearchProvider } from './anysearch.js'

await acquireSharedMutationLock('WebSearchTool/providers/anysearch.test.ts')

const originalFetch = globalThis.fetch
const originalKey = process.env.ANYSEARCH_API_KEY
const originalMaxResults = process.env.ANYSEARCH_MAX_RESULTS
const originalTimeout = process.env.WEB_SEARCH_TIMEOUT_SEC

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ANYSEARCH_API_KEY
  else process.env.ANYSEARCH_API_KEY = originalKey
  if (originalMaxResults === undefined) delete process.env.ANYSEARCH_MAX_RESULTS
  else process.env.ANYSEARCH_MAX_RESULTS = originalMaxResults
  if (originalTimeout === undefined) delete process.env.WEB_SEARCH_TIMEOUT_SEC
  else process.env.WEB_SEARCH_TIMEOUT_SEC = originalTimeout
})

afterAll(() => {
  releaseSharedMutationLock()
})

describe('AnySearch basic search', () => {
  test('sends an anonymous query and maps the returned search hit', async () => {
    delete process.env.ANYSEARCH_API_KEY
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedInit = init
      return new Response(JSON.stringify({
        code: 0,
        data: {
          results: [{
            title: 'Example',
            url: 'https://example.com/article',
            content: 'An example article',
          }],
        },
      }), { status: 200 })
    }) as typeof fetch

    const output = await anysearchProvider.search({ query: 'example article' })

    expect(requestedUrl).toBe('https://api.anysearch.com/v1/search')
    expect(requestedInit?.method).toBe('POST')
    expect(requestedInit?.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      query: 'example article',
      max_results: 10,
    })
    expect(output.providerName).toBe('anysearch')
    expect(output.hits).toEqual([{
      title: 'Example',
      url: 'https://example.com/article',
      description: 'An example article',
      source: 'example.com',
    }])
  })

  test('uses an optional key, configured result count, snippet fallback, and domain filters', async () => {
    process.env.ANYSEARCH_API_KEY = '  test-secret  '
    process.env.ANYSEARCH_MAX_RESULTS = '3'
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedInit = init
      return new Response(JSON.stringify({
        code: 0,
        data: { results: [
          { title: 'Keep', url: 'https://keep.example/a', snippet: 'Kept excerpt' },
          { title: 'Drop', url: 'https://drop.example/b', content: 'Dropped excerpt' },
        ] },
      }), { status: 200 })
    }) as typeof fetch

    const output = await anysearchProvider.search({
      query: 'filtered query',
      blocked_domains: ['drop.example'],
    })

    expect(requestedInit?.headers).toHaveProperty('Authorization', 'Bearer test-secret')
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      query: 'filtered query',
      max_results: 3,
    })
    expect(output.hits).toEqual([{
      title: 'Keep',
      url: 'https://keep.example/a',
      description: 'Kept excerpt',
      source: 'keep.example',
    }])
  })

  test('treats a blank key as anonymous and ignores an invalid result count', async () => {
    process.env.ANYSEARCH_API_KEY = '   '
    process.env.ANYSEARCH_MAX_RESULTS = '11'
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestedInit = init
      return new Response(JSON.stringify({ code: 0, data: { results: [] } }), { status: 200 })
    }) as typeof fetch

    const output = await anysearchProvider.search({ query: 'no hits' })

    expect(requestedInit?.headers).not.toHaveProperty('Authorization')
    expect(JSON.parse(String(requestedInit?.body))).toEqual({ query: 'no hits', max_results: 10 })
    expect(output.hits).toEqual([])
  })

  test('reports HTTP auth and quota errors without exposing the key', async () => {
    process.env.ANYSEARCH_API_KEY = 'private-key'
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 401,
      message: 'private-key',
      request_id: 'req-auth',
    }), { status: 401 })) as typeof fetch

    const authError = await anysearchProvider.search({ query: 'auth' }).catch(error => error)
    expect(String(authError)).toContain(
      'AnySearch search error HTTP 401 (check ANYSEARCH_API_KEY) (request_id: req-auth)',
    )
    expect(String(authError)).not.toContain('private-key')

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ code: 429 }), {
      status: 429,
    })) as typeof fetch
    await expect(anysearchProvider.search({ query: 'quota' })).rejects.toThrow(
      /HTTP 429 \(rate limit or quota exceeded\)/,
    )
  })

  test('includes a sanitized and truncated snippet for non-JSON HTTP errors', async () => {
    process.env.ANYSEARCH_API_KEY = 'private-key'
    const gatewayBody = `gateway failure\nAuthorization: Bearer private-key\n${'x'.repeat(300)}`
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(gatewayBody, {
      status: 502,
    })) as typeof fetch

    const error = await anysearchProvider.search({ query: 'gateway failure' }).catch(error => error)
    const message = String(error)
    expect(message).toContain('AnySearch search error HTTP 502')
    expect(message).toContain('gateway failure')
    expect(message).toContain('Authorization: [redacted]')
    expect(message).not.toContain('private-key')
    expect(message).toContain('…')
    expect(message).not.toContain('x'.repeat(250))
  })

  test('separates empty results from business errors and malformed responses', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 1001,
      request_id: 'req-business',
      data: { results: [] },
    }), { status: 200 })) as typeof fetch
    await expect(anysearchProvider.search({ query: 'business error' })).rejects.toThrow(
      'AnySearch search error code 1001 (request_id: req-business)',
    )

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      code: 0,
      data: {},
    }), { status: 200 })) as typeof fetch
    await expect(anysearchProvider.search({ query: 'missing results' })).rejects.toThrow(
      'AnySearch search returned an invalid results list',
    )
  })

  test('reports a stalled AnySearch request as a timeout', async () => {
    process.env.WEB_SEARCH_TIMEOUT_SEC = '1'
    const activeNetwork = setInterval(() => {}, 50)
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch

    try {
      await expect(anysearchProvider.search({ query: 'stalled' })).rejects.toThrow(
        /AnySearch search timed out after 1s/,
      )
    } finally {
      clearInterval(activeNetwork)
    }
  })
})
