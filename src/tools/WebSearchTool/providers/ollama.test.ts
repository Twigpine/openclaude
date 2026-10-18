import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import { ollamaProvider } from './ollama.js'

const originalFetch = globalThis.fetch
const savedEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDE_CODE_PROVIDER_ROUTE_ID: process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  OLLAMA_API_KEY: process.env.OLLAMA_API_KEY,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function clearOllamaEnv(): void {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID
  delete process.env.OLLAMA_BASE_URL
  delete process.env.OLLAMA_API_KEY
}

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/ollama.test.ts')
  clearOllamaEnv()
})

afterEach(() => {
  try {
    restoreEnv()
    globalThis.fetch = originalFetch
  } finally {
    releaseSharedMutationLock()
  }
})

describe('ollamaProvider', () => {
  test('is configured for the active Ollama route or a hosted API key', () => {
    expect(ollamaProvider.isConfigured()).toBe(false)

    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    expect(ollamaProvider.isConfigured()).toBe(true)

    delete process.env.CLAUDE_CODE_USE_OPENAI
    delete process.env.OPENAI_BASE_URL
    process.env.OLLAMA_API_KEY = 'ollama-test-key'
    expect(ollamaProvider.isConfigured()).toBe(true)
  })

  test.each(['undefined', 'null', 'SUA_CHAVE', ' sua_chave '])(
    'does not configure hosted search for an %s API key placeholder',
    async placeholder => {
      process.env.OLLAMA_API_KEY = placeholder
      let calls = 0
      globalThis.fetch = (async () => {
        calls++
        return Response.json({ results: [] })
      }) as unknown as typeof fetch

      expect(ollamaProvider.isConfigured()).toBe(false)
      await expect(
        ollamaProvider.search({ query: 'placeholder key' }),
      ).rejects.toThrow('OLLAMA_API_KEY')
      expect(calls).toBe(0)
    },
  )

  test('uses the Ollama route marker for a reverse-proxied active profile', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    process.env.OPENAI_BASE_URL = 'https://models.example.com/v1'

    expect(ollamaProvider.isConfigured()).toBe(true)
  })

  test.each(['undefined', 'null'])(
    'falls back to OPENAI_API_BASE when OPENAI_BASE_URL is %s',
    placeholder => {
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
      process.env.OPENAI_BASE_URL = placeholder
      process.env.OPENAI_API_BASE = 'http://localhost:11434/v1'

      expect(ollamaProvider.isConfigured()).toBe(true)
    },
  )

  test('does not infer Ollama from an unrelated hostname substring', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.notollama.example/v1'

    expect(ollamaProvider.isConfigured()).toBe(false)

    process.env.OPENAI_BASE_URL = 'https://ollama.internal/v1'
    expect(ollamaProvider.isConfigured()).toBe(true)
  })

  test('uses the signed-in local endpoint and maps structured results', async () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

    let requestUrl = ''
    let requestInit: RequestInit | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input)
      requestInit = init
      return Response.json({
        results: [
          {
            title: 'Ollama result',
            url: 'https://docs.ollama.com/capabilities/web-search',
            content: 'Structured result content',
          },
        ],
      })
    }) as typeof fetch

    const output = await ollamaProvider.search({ query: 'ollama search' })

    expect(requestUrl).toBe(
      'http://localhost:11434/api/experimental/web_search',
    )
    expect(requestInit?.headers).toEqual({
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      query: 'ollama search',
      max_results: 10,
    })
    expect(output.providerName).toBe('ollama')
    expect(output.hits).toEqual([
      {
        title: 'Ollama result',
        url: 'https://docs.ollama.com/capabilities/web-search',
        description: 'Structured result content',
        source: 'docs.ollama.com',
      },
    ])
  })

  test('falls back from local Ollama to the authenticated hosted API', async () => {
    process.env.OLLAMA_BASE_URL = 'http://ollama.internal:11434/v1/'
    process.env.OLLAMA_API_KEY = 'ollama-test-key'

    const requests: Array<{ url: string; headers: Headers }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      })
      if (requests.length === 1) {
        return Response.json({ results: [] })
      }
      return Response.json({
        results: [
          {
            title: 'Hosted result',
            url: 'https://example.com/result',
            content: 'Hosted content',
          },
        ],
      })
    }) as typeof fetch

    const output = await ollamaProvider.search({ query: 'fallback' })

    expect(requests.map(request => request.url)).toEqual([
      'http://ollama.internal:11434/api/experimental/web_search',
      'https://ollama.com/api/web_search',
    ])
    expect(requests[0].headers.has('Authorization')).toBe(false)
    expect(requests[1].headers.get('Authorization')).toBe(
      'Bearer ollama-test-key',
    )
    expect(output.hits[0]?.title).toBe('Hosted result')
  })

  test('skips a malformed local URL and uses the hosted API', async () => {
    process.env.OLLAMA_BASE_URL = 'not a url'
    process.env.OLLAMA_API_KEY = 'ollama-test-key'

    let requestUrl = ''
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestUrl = String(input)
      return Response.json({
        results: [{ title: 'Hosted', url: 'https://example.com/hosted' }],
      })
    }) as typeof fetch

    const output = await ollamaProvider.search({ query: 'fallback' })

    expect(requestUrl).toBe('https://ollama.com/api/web_search')
    expect(output.hits[0]?.title).toBe('Hosted')
  })

  test('reports malformed local-only configuration without throwing from discovery', async () => {
    process.env.OLLAMA_BASE_URL = 'not a url'

    expect(ollamaProvider.isConfigured()).toBe(false)
    await expect(
      ollamaProvider.search({ query: 'invalid local' }),
    ).rejects.toThrow('configured endpoint is not a valid HTTP(S) URL')
  })

  test('applies shared domain filters to Ollama results', async () => {
    process.env.OLLAMA_API_KEY = 'ollama-test-key'
    globalThis.fetch = (async () =>
      Response.json({
        results: [
          { title: 'Keep', url: 'https://docs.ollama.com/search', content: 'a' },
          { title: 'Drop', url: 'https://example.com/search', content: 'b' },
        ],
      })) as unknown as typeof fetch

    const output = await ollamaProvider.search({
      query: 'domains',
      allowed_domains: ['ollama.com'],
    })

    expect(output.hits.map(hit => hit.title)).toEqual(['Keep'])
  })

  test('does not try hosted fallback after caller cancellation', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OLLAMA_API_KEY = 'ollama-test-key'
    const controller = new AbortController()
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    }) as unknown as typeof fetch

    await expect(
      ollamaProvider.search({ query: 'cancel' }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(1)
  })
})
