import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import { snapshotEnv } from '../../../test/envSnapshot.js'
import { keenableProvider } from './keenable.js'

const ENV_KEYS = ['KEENABLE_API_KEY', 'WEB_SEARCH_TIMEOUT_SEC'] as const
const originalFetch = globalThis.fetch
let restoreEnv: () => void = () => {}

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/keenable.test.ts')
  restoreEnv = snapshotEnv(ENV_KEYS, { clear: true })
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    restoreEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('Keenable search', () => {
  test('sends a keyless query with the app title and maps the snippet', async () => {
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse({
        results: [
          {
            title: 'Example',
            url: 'https://example.com/article',
            description: '',
            snippet: 'An example\n\narticle   body',
          },
          { title: 'No URL', snippet: 'skipped' },
        ],
      })
    }) as typeof fetch

    const output = await keenableProvider.search({ query: 'example article' })

    expect(requestedUrl).toBe('https://api.keenable.ai/v1/search/public')
    expect(requestedInit?.method).toBe('POST')
    expect(requestedInit?.headers).toHaveProperty('X-Keenable-Title', 'OpenClaude')
    expect(requestedInit?.headers).not.toHaveProperty('X-API-Key')
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      query: 'example article',
      max_results: 10,
    })
    expect(output.providerName).toBe('keenable')
    expect(output.hits).toEqual([{
      title: 'Example',
      url: 'https://example.com/article',
      description: 'An example article body',
      source: 'example.com',
    }])
  })

  test('falls back to the description when a result has no snippet', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      results: [
        { title: 'Summary only', url: 'https://example.com/summary', description: 'A short\nsummary' },
        { title: 'No text', url: 'https://example.com/bare', description: '  ', snippet: '' },
      ],
    })) as typeof fetch

    const output = await keenableProvider.search({ query: 'summary only' })

    expect(output.hits.map(hit => hit.description)).toEqual(['A short summary', undefined])
  })

  test('uses the keyed endpoint with a key, caps long snippets, and applies domain filters', async () => {
    process.env.KEENABLE_API_KEY = '  kn-secret  '
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse({
        results: [
          { title: 'Keep', url: 'https://keep.example/a', snippet: 'word '.repeat(400) },
          { title: 'Drop', url: 'https://drop.example/b', snippet: 'Dropped excerpt' },
        ],
      })
    }) as typeof fetch

    const output = await keenableProvider.search({
      query: 'filtered query',
      blocked_domains: ['drop.example'],
    })

    expect(requestedUrl).toBe('https://api.keenable.ai/v1/search')
    expect(requestedInit?.headers).toHaveProperty('X-API-Key', 'kn-secret')
    expect(requestedInit?.headers).toHaveProperty('X-Keenable-Title', 'OpenClaude')
    expect(output.hits).toHaveLength(1)
    expect(output.hits[0]?.url).toBe('https://keep.example/a')
    const description = output.hits[0]?.description ?? ''
    expect(description.endsWith(' …')).toBe(true)
    expect(description.length).toBeLessThanOrEqual(802)
  })

  test('treats a blank key as keyless', async () => {
    process.env.KEENABLE_API_KEY = '   '
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedInit = init
      return jsonResponse({ results: [] })
    }) as typeof fetch

    const output = await keenableProvider.search({ query: 'no hits' })

    expect(requestedUrl).toBe('https://api.keenable.ai/v1/search/public')
    expect(requestedInit?.headers).not.toHaveProperty('X-API-Key')
    expect(output.hits).toEqual([])
  })

  test('reports rate limit and auth errors without exposing the key', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: 'Too Many Requests' }, 429)) as typeof fetch
    await expect(keenableProvider.search({ query: 'quota' })).rejects.toThrow(
      /Keenable search error HTTP 429 \(keyless rate limit exceeded; add a key with \/search key keenable\)/,
    )

    process.env.KEENABLE_API_KEY = 'private-key'
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ error: 'Invalid API key: private-key' }, 401)) as typeof fetch
    const authError = await keenableProvider.search({ query: 'auth' }).catch(error => error)
    expect(String(authError)).toContain('Keenable search error HTTP 401 (check KEENABLE_API_KEY)')
    expect(String(authError)).toContain('[redacted]')
    expect(String(authError)).not.toContain('private-key')
  })

  test('truncates non-JSON error bodies and rejects malformed responses', async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(`gateway failure\n${'x'.repeat(300)}`, { status: 502 })) as typeof fetch
    const gatewayError = String(
      await keenableProvider.search({ query: 'gateway' }).catch(error => error),
    )
    expect(gatewayError).toContain('Keenable search error HTTP 502: gateway failure')
    expect(gatewayError).toContain('…')
    expect(gatewayError).not.toContain('x'.repeat(250))

    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ detail: 'no results key' })) as typeof fetch
    await expect(keenableProvider.search({ query: 'malformed' })).rejects.toThrow(
      'Keenable search returned an invalid response',
    )
  })

  test('stops when the caller aborts', async () => {
    const controller = new AbortController()
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch

    const pending = keenableProvider.search({ query: 'cancelled' }, controller.signal)
    controller.abort()
    const error = await pending.catch(err => err)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('AbortError')
  })

  test('reports a stalled request as a timeout', async () => {
    process.env.WEB_SEARCH_TIMEOUT_SEC = '1'
    const activeNetwork = setInterval(() => {}, 50)
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
      })) as typeof fetch

    try {
      await expect(keenableProvider.search({ query: 'stalled' })).rejects.toThrow(
        /Keenable search timed out after 1s/,
      )
    } finally {
      clearInterval(activeNetwork)
    }
  })
})
