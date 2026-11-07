import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import { specstreamProvider } from './specstream.js'

await acquireSharedMutationLock('WebSearchTool/providers/specstream.test.ts')

const originalFetch = globalThis.fetch
const originalKey = process.env.SPECSTREAM_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.SPECSTREAM_API_KEY
  else process.env.SPECSTREAM_API_KEY = originalKey
})

afterAll(() => {
  releaseSharedMutationLock()
})

describe('SpecStream search', () => {
  test('is configured only with a key', () => {
    delete process.env.SPECSTREAM_API_KEY
    expect(specstreamProvider.isConfigured()).toBe(false)
    process.env.SPECSTREAM_API_KEY = '  sk-test  '
    expect(specstreamProvider.isConfigured()).toBe(true)
  })

  test('sends a GET with the bearer key and maps sources to hits', async () => {
    process.env.SPECSTREAM_API_KEY = '  sk-test  '
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input)
      requestedInit = init
      return new Response(JSON.stringify({
        data: {
          sources: [
            { title: 'Example', url: 'https://example.com/a', snippet: 'About a' },
            { title: '', url: 'https://example.org/b' },
            { title: 'No link' },
          ],
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const output = await specstreamProvider.search({ query: 'open source & more' })

    expect(requestedUrl).toBe('https://api.specstream.ai/v1/web-search?q=open+source+%26+more')
    expect(requestedInit?.method).toBe('GET')
    expect(requestedInit?.headers).toMatchObject({ Authorization: 'Bearer sk-test' })
    expect(output.providerName).toBe('specstream')
    expect(output.hits).toEqual([
      { title: 'Example', url: 'https://example.com/a', description: 'About a', source: 'example.com' },
      { title: 'https://example.org/b', url: 'https://example.org/b', description: undefined, source: 'example.org' },
    ])
  })

  test('cuts the question at 2000 characters and keeps at most 10 hits', async () => {
    process.env.SPECSTREAM_API_KEY = 'sk-test'
    let requestedUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        data: {
          sources: Array.from({ length: 15 }, (_, i) => ({
            title: `T${i}`,
            url: `https://example.com/${i}`,
          })),
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const output = await specstreamProvider.search({ query: 'x'.repeat(2500) })

    expect(new URL(requestedUrl).searchParams.get('q')).toHaveLength(2000)
    expect(output.hits).toHaveLength(10)
  })

  test('applies domain filters', async () => {
    process.env.SPECSTREAM_API_KEY = 'sk-test'
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        sources: [
          { title: 'Keep', url: 'https://example.com/a' },
          { title: 'Drop', url: 'https://blocked.example.net/b' },
        ],
      },
    }), { status: 200 })) as unknown as typeof fetch

    const output = await specstreamProvider.search({
      query: 'filters',
      blocked_domains: ['blocked.example.net'],
    })

    expect(output.hits.map(hit => hit.title)).toEqual(['Keep'])
  })

  test('throws on an HTTP error and on a reply without sources', async () => {
    process.env.SPECSTREAM_API_KEY = 'sk-test'
    globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as unknown as typeof fetch
    await expect(specstreamProvider.search({ query: 'q' })).rejects.toThrow(/SpecStream search error 401/)

    globalThis.fetch = (async () => new Response(JSON.stringify({ data: {} }), { status: 200 })) as unknown as typeof fetch
    await expect(specstreamProvider.search({ query: 'q' })).rejects.toThrow(/invalid response/)
  })
})
