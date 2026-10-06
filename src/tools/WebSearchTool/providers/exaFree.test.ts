import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'

import {
  exaFreeProvider,
  parseExaFreeResults,
  resetExaFreeRateLimiterForTests,
} from './exaFree.ts'

const originalEnv = {
  EXA_FREE_TIER: process.env.EXA_FREE_TIER,
  EXA_NUM_RESULTS: process.env.EXA_NUM_RESULTS,
  WEB_SEARCH_TIMEOUT_SEC: process.env.WEB_SEARCH_TIMEOUT_SEC,
}

const originalFetch = globalThis.fetch

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>

function mockFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(input, init)) as unknown as typeof fetch
}

interface ToolCallBody {
  jsonrpc: string
  method: string
  params: {
    name: string
    arguments: { query: string; objective: string; numResults: number }
  }
}

/** Run a search that is expected to fail and return its error. */
async function searchError(query = 'q'): Promise<Error> {
  try {
    await exaFreeProvider.search({ query })
  } catch (err) {
    return err as Error
  }
  throw new Error('expected the search to fail')
}

function parseToolCall(init?: RequestInit): ToolCallBody {
  return JSON.parse(String(init?.body)) as ToolCallBody
}

// Shape captured from a live https://mcp.exa.ai/mcp `web_search_exa` reply,
// trimmed. The second result's excerpt contains markdown front-matter `---`
// lines, which is why the parser must not split on `---`.
const LIVE_SHAPED_TEXT = [
  'Title: Bun Runtime | Bun Docs',
  'URL: https://bun.com/docs/runtime',
  'Published: N/A',
  'Author: N/A',
  'Highlights:',
  'Bun Runtime | Bun Docs',
  '',
  '# Bun Runtime',
  '',
  "Execute JavaScript/TypeScript files with Bun's fast runtime.",
  '...',
  '## Run a file#',
  '',
  'Use `bun run` to execute a source file.',
  '',
  'Title: docs/runtime/index.mdx',
  'URL: https://github.com/oven-sh/bun/blob/main/docs/runtime/index.mdx',
  'Published: 2026-01-02',
  'Author: N/A',
  'Highlights:',
  '---',
  'title: Bun Runtime',
  '---',
  '',
  'The Bun Runtime is designed to start fast and run fast.',
].join('\n')

function sseResponse(payload: unknown, status = 200): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function toolResult(text: string, isError = false): unknown {
  return {
    result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) },
    jsonrpc: '2.0',
    id: 1,
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/exaFree.test.ts')
  resetExaFreeRateLimiterForTests()
})

afterEach(() => {
  try {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    globalThis.fetch = originalFetch
  } finally {
    releaseSharedMutationLock()
  }
})

describe('exaFreeProvider isConfigured', () => {
  test('on by default with no API key', () => {
    delete process.env.EXA_FREE_TIER
    expect(exaFreeProvider.isConfigured()).toBe(true)
  })

  test.each(['0', 'false', 'off', 'no'])('EXA_FREE_TIER=%s disables it', value => {
    process.env.EXA_FREE_TIER = value
    expect(exaFreeProvider.isConfigured()).toBe(false)
  })
})

describe('parseExaFreeResults', () => {
  test('splits result blocks on Title/URL headers, not on --- lines', () => {
    const hits = parseExaFreeResults(LIVE_SHAPED_TEXT)

    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({
      title: 'Bun Runtime | Bun Docs',
      url: 'https://bun.com/docs/runtime',
      source: 'bun.com',
    })
    expect(hits[1]).toMatchObject({
      title: 'docs/runtime/index.mdx',
      url: 'https://github.com/oven-sh/bun/blob/main/docs/runtime/index.mdx',
      source: 'github.com',
    })
  })

  test('descriptions come from the highlights, without metadata or rules', () => {
    const [first, second] = parseExaFreeResults(LIVE_SHAPED_TEXT)

    expect(first?.description).toContain('Use `bun run` to execute a source file.')
    expect(first?.description).toContain('…')
    expect(first?.description).not.toContain('Published:')
    expect(first?.description).not.toContain('Title: docs/runtime')
    expect(second?.description).toBe(
      'title: Bun Runtime The Bun Runtime is designed to start fast and run fast.',
    )
  })

  test('strips the Text:/Summary: label from content variants', () => {
    const [hit] = parseExaFreeResults(
      'Title: T\nURL: https://e.com/x\nPublished: N/A\nText:\nThe page body.',
    )
    expect(hit?.description).toBe('The page body.')
  })

  test('caps long descriptions', () => {
    const text = `Title: Long\nURL: https://e.com/x\nHighlights:\n${'word '.repeat(400)}`
    const [hit] = parseExaFreeResults(text)
    expect(hit?.description?.length).toBeLessThanOrEqual(802)
    expect(hit?.description?.endsWith(' …')).toBe(true)
  })

  test('page text that contains Title:/URL: lines is not mistaken for a result', () => {
    const text = [
      'Title: Real result',
      'URL: https://real.example.com/page',
      'Published: N/A',
      'Author: N/A',
      'Highlights:',
      'An excerpt that quotes another format:',
      'Title: Fake',
      'URL: https://fake.example.com/',
      'and keeps going.',
    ].join('\n')

    const hits = parseExaFreeResults(text)
    expect(hits.map(h => h.url)).toEqual(['https://real.example.com/page'])
    expect(hits[0]?.description).toContain('and keeps going.')
  })

  test('falls back to Title/URL alone when no metadata lines follow', () => {
    const hits = parseExaFreeResults(
      'Title: A\nURL: https://a.example.com/\nSome text\n\nTitle: B\nURL: https://b.example.com/\nMore text',
    )
    expect(hits.map(h => h.url)).toEqual(['https://a.example.com/', 'https://b.example.com/'])
  })

  test('skips blocks whose URL is not http(s)', () => {
    const hits = parseExaFreeResults('Title: Bad\nURL: javascript:alert(1)\nHighlights:\nx')
    expect(hits).toEqual([])
  })

  test('returns no hits for text without result headers', () => {
    expect(parseExaFreeResults('No results found.')).toEqual([])
  })
})

describe('exaFreeProvider request shape', () => {
  test('posts a JSON-RPC tools/call that accepts SSE and tags the source', async () => {
    process.env.EXA_NUM_RESULTS = '20'
    let capturedUrl = ''
    let capturedHeaders: Record<string, string> = {}
    let capturedBody: ToolCallBody | null = null
    mockFetch((input, init) => {
      capturedUrl = String(input)
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      capturedBody = parseToolCall(init)
      return sseResponse(toolResult(LIVE_SHAPED_TEXT))
    })

    await exaFreeProvider.search({ query: 'bun runtime' })

    expect(capturedUrl).toBe('https://mcp.exa.ai/mcp')
    expect(capturedHeaders.Accept).toBe('application/json, text/event-stream')
    expect(capturedHeaders['x-exa-source']).toBe('openclaude')
    expect(capturedHeaders['x-api-key']).toBeUndefined()
    expect(capturedBody).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: {
          query: 'bun runtime',
          objective: 'Find web pages that answer: bun runtime',
          numResults: 20,
        },
      },
    })
  })

  test('pushes allowed domains into the query and both lists into the objective', async () => {
    let args: ToolCallBody['params']['arguments'] | undefined
    mockFetch((_input, init) => {
      args = parseToolCall(init).params.arguments
      return sseResponse(toolResult('No results found.'))
    })

    await exaFreeProvider.search({
      query: 'strict mode',
      allowed_domains: ['typescriptlang.org', 'github.com'],
    })
    expect(args?.query).toBe('strict mode site:typescriptlang.org OR site:github.com')
    expect(args?.objective).toContain('Only include results from these domains: typescriptlang.org, github.com.')

    await exaFreeProvider.search({ query: 'strict mode', blocked_domains: ['pinterest.com'] })
    expect(args?.query).toBe('strict mode')
    expect(args?.objective).toContain('Exclude results from these domains: pinterest.com.')
  })
})

describe('exaFreeProvider response handling', () => {
  test('maps hits and reports the exa-free provider name', async () => {
    mockFetch(() => sseResponse(toolResult(LIVE_SHAPED_TEXT)))

    const out = await exaFreeProvider.search({ query: 'bun runtime' })

    expect(out.providerName).toBe('exa-free')
    expect(out.hits.map(h => h.url)).toEqual([
      'https://bun.com/docs/runtime',
      'https://github.com/oven-sh/bun/blob/main/docs/runtime/index.mdx',
    ])
  })

  test('enforces domain filters on the parsed hits', async () => {
    mockFetch(() => sseResponse(toolResult(LIVE_SHAPED_TEXT)))

    const out = await exaFreeProvider.search({
      query: 'bun runtime',
      blocked_domains: ['github.com'],
    })

    expect(out.hits.map(h => h.source)).toEqual(['bun.com'])
  })

  test('accepts a plain JSON reply as well as SSE', async () => {
    mockFetch(() =>
      new Response(JSON.stringify(toolResult(LIVE_SHAPED_TEXT)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))

    const out = await exaFreeProvider.search({ query: 'bun runtime' })
    expect(out.hits).toHaveLength(2)
  })

  test('returns no hits when the tool says there are no results', async () => {
    mockFetch(() => sseResponse(toolResult('No results found.')))

    const out = await exaFreeProvider.search({ query: 'nothing' })
    expect(out.hits).toEqual([])
  })

  test('throws on an unrecognized text format so auto mode can fall through', async () => {
    mockFetch(() =>
      sseResponse(toolResult('Something entirely different')))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /unrecognized response format/,
    )
  })

  test('treats an isError rate-limit result as the free-tier limit', async () => {
    mockFetch(() =>
      sseResponse(toolResult('Free tier rate limit exceeded', true)))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /Exa free tier limit reached.*EXA_API_KEY/,
    )
  })

  test("recognizes Exa's real free-tier limit message without echoing its MCP advice", async () => {
    // FREE_MCP_RATE_LIMIT_MESSAGE from exa-mcp-server src/utils/errorHandler.ts
    const exaMessage =
      "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\n" +
      'Fix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this ' +
      'https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY'
    mockFetch(() => sseResponse(toolResult(exaMessage, true)))

    const error = await searchError()
    expect(error.message).toStartWith('Exa free tier limit reached.')
    expect(error.message).toContain('/search key exa')
    expect(error.message).not.toContain('exaApiKey')
  })

  test('treats the live _meta rate-limited reply (no isError) as the free-tier limit', async () => {
    // Shape observed live from mcp.exa.ai once the free tier was exhausted.
    mockFetch(() =>
      sseResponse({
        result: {
          _meta: { 'ai.exa/rateLimited': true },
          content: [{ type: 'text', text: "You've hit Exa's free MCP rate limit." }],
        },
        jsonrpc: '2.0',
        id: 1,
      }))

    const error = await searchError()
    expect(error.message).toStartWith('Exa free tier limit reached.')
  })

  test('rate-limit wording without any flag is still reported as the limit', async () => {
    mockFetch(() => sseResponse(toolResult("You've hit Exa's free MCP rate limit.")))

    const error = await searchError()
    expect(error.message).toStartWith('Exa free tier limit reached.')
  })

  test('surfaces other isError results as search errors', async () => {
    mockFetch(() =>
      sseResponse(toolResult('MCP error -32602: Tool nope not found', true)))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /Exa free tier search error: MCP error -32602/,
    )
  })

  test('surfaces JSON-RPC errors', async () => {
    mockFetch(() =>
      sseResponse({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Bad request' } }))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /Exa free tier search error: Bad request/,
    )
  })

  test('maps HTTP 429 to the free-tier limit error', async () => {
    mockFetch(() =>
      new Response('Too Many Requests', { status: 429 }))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /Exa free tier limit reached/,
    )
  })

  test('reports a non-JSON reply (e.g. an HTML challenge page) readably', async () => {
    mockFetch(() =>
      new Response('<html><body>Just a moment...</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(
      /Exa free tier returned an unreadable response: <html><body>Just a moment/,
    )
  })

  test('trims large error bodies', async () => {
    mockFetch(() => new Response(`<html>${'x'.repeat(5000)}</html>`, { status: 403 }))

    const error = await searchError()
    expect(error.message).toStartWith('Exa free tier search error 403: <html>')
    expect(error.message.length).toBeLessThan(260)
  })

  test('throws on other non-2xx responses with the status code', async () => {
    mockFetch(() => new Response('bad gateway', { status: 502 }))

    await expect(exaFreeProvider.search({ query: 'q' })).rejects.toThrow(/502/)
  })

  test('does not call the endpoint when the caller already aborted', async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return sseResponse(toolResult(LIVE_SHAPED_TEXT))
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      exaFreeProvider.search({ query: 'q' }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(calls).toBe(0)
  })
})

describe('exaFreeProvider cooldown after the limit', () => {
  test('skips the endpoint for a while after a rate-limit reply', async () => {
    let calls = 0
    mockFetch(() => {
      calls++
      return new Response('Too Many Requests', { status: 429 })
    })

    await expect(exaFreeProvider.search({ query: 'a' })).rejects.toThrow(/limit reached\./)
    await expect(exaFreeProvider.search({ query: 'b' })).rejects.toThrow(
      /limit reached recently; skipping/,
    )
    expect(calls).toBe(1)

    resetExaFreeRateLimiterForTests()
    await expect(exaFreeProvider.search({ query: 'c' })).rejects.toThrow(/limit reached\./)
    expect(calls).toBe(2)
  })
})

describe('exaFreeProvider call spacing', () => {
  test('spaces back-to-back calls to stay under the free-tier rate', async () => {
    const callTimes: number[] = []
    mockFetch(() => {
      callTimes.push(Date.now())
      return sseResponse(toolResult('No results found.'))
    })

    await Promise.all([
      exaFreeProvider.search({ query: 'a' }),
      exaFreeProvider.search({ query: 'b' }),
      exaFreeProvider.search({ query: 'c' }),
    ])

    callTimes.sort((a, b) => a - b)
    expect(callTimes[2]! - callTimes[0]!).toBeGreaterThanOrEqual(950)
  })

  test('cancelled waiters do not delay later calls', async () => {
    const callTimes: number[] = []
    mockFetch(() => {
      callTimes.push(Date.now())
      return sseResponse(toolResult('No results found.'))
    })

    await exaFreeProvider.search({ query: 'first' })
    const controller = new AbortController()
    const queued = [1, 2, 3].map(i =>
      exaFreeProvider.search({ query: `queued ${i}` }, controller.signal).catch(() => null),
    )
    controller.abort()
    await Promise.all(queued)
    await exaFreeProvider.search({ query: 'next' })

    expect(callTimes).toHaveLength(2)
    expect(callTimes[1]! - callTimes[0]!).toBeLessThan(900)
  })
})
