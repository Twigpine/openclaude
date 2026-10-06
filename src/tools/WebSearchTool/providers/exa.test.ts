import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'

import { exaProvider } from './exa.ts'

const originalEnv = {
  EXA_API_KEY: process.env.EXA_API_KEY,
}

const originalFetch = globalThis.fetch

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/exa.test.ts')
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

describe('exaProvider isConfigured', () => {
  test('true when EXA_API_KEY is set', () => {
    process.env.EXA_API_KEY = 'exa-test-key'
    expect(exaProvider.isConfigured()).toBe(true)
  })

  test('false when EXA_API_KEY is missing', () => {
    delete process.env.EXA_API_KEY
    expect(exaProvider.isConfigured()).toBe(false)
  })
})

describe('exaProvider search request shape', () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = 'exa-test-key'
  })

  test('requests contents.highlights so descriptions are populated', async () => {
    let capturedBody: any = null
    let capturedHeaders: Record<string, string> = {}
    globalThis.fetch = (async (_input: any, init: any) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>
      capturedBody = init?.body ? JSON.parse(init.body as string) : null
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch

    await exaProvider.search({ query: 'gpus' })

    expect(capturedHeaders['x-api-key']).toBe('exa-test-key')
    expect(capturedBody).toMatchObject({
      query: 'gpus',
      type: 'auto',
      numResults: 15,
      contents: { highlights: true },
    })
  })

  test('forwards allowed_domains/blocked_domains as includeDomains/excludeDomains', async () => {
    let capturedBody: any = null
    globalThis.fetch = (async (_input: any, init: any) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as typeof fetch

    await exaProvider.search({
      query: 'q',
      allowed_domains: ['arxiv.org'],
      blocked_domains: ['pinterest.com'],
    })

    expect(capturedBody.includeDomains).toEqual(['arxiv.org'])
    expect(capturedBody.excludeDomains).toEqual(['pinterest.com'])
  })
})

describe('exaProvider response mapping', () => {
  beforeEach(() => {
    process.env.EXA_API_KEY = 'exa-test-key'
  })

  test('maps highlights[] into description (joined with ellipsis)', async () => {
    globalThis.fetch = (async (_input: any, _init: any) => new Response(JSON.stringify({
      results: [{
        title: 'Nvidia post-Blackwell roadmap',
        url: 'https://example.com/nv',
        highlights: [
          'Nvidia announced its next-gen GPU.',
          'Performance gains of ~2x over the prior generation.',
          'Shipping in Q4.',
        ],
        highlightScores: [0.91, 0.84, 0.71],
      }],
    }), { status: 200 })) as typeof fetch

    const out = await exaProvider.search({ query: 'q' })

    expect(out.hits).toHaveLength(1)
    expect(out.hits[0].title).toBe('Nvidia post-Blackwell roadmap')
    expect(out.hits[0].url).toBe('https://example.com/nv')
    expect(out.hits[0].source).toBe('example.com')
    expect(out.hits[0].description).toBe(
      'Nvidia announced its next-gen GPU. … Performance gains of ~2x over the prior generation. … Shipping in Q4.',
    )
  })

  test('caps the joined description at 3 highlights', async () => {
    globalThis.fetch = (async (_input: any, _init: any) => new Response(JSON.stringify({
      results: [{
        title: 't', url: 'https://e.com/x',
        highlights: ['a', 'b', 'c', 'd', 'e'],
      }],
    }), { status: 200 })) as typeof fetch

    const out = await exaProvider.search({ query: 'q' })
    expect(out.hits[0].description).toBe('a … b … c')
  })

  test('falls back to text when highlights is empty/missing', async () => {
    globalThis.fetch = (async (_input: any, _init: any) => new Response(JSON.stringify({
      results: [{
        title: 't', url: 'https://e.com/x',
        text: 'Full page body content.',
      }],
    }), { status: 200 })) as typeof fetch

    const out = await exaProvider.search({ query: 'q' })
    expect(out.hits[0].description).toBe('Full page body content.')
  })

  test('description is undefined when neither highlights nor text is present', async () => {
    globalThis.fetch = (async (_input: any, _init: any) => new Response(JSON.stringify({
      results: [{ title: 't', url: 'https://e.com/x' }],
    }), { status: 200 })) as typeof fetch

    const out = await exaProvider.search({ query: 'q' })
    expect(out.hits[0].description).toBeUndefined()
  })

  test('throws on non-2xx response with status code', async () => {
    globalThis.fetch = (async (_input: any, _init: any) =>
      new Response('quota exceeded', { status: 402 })) as typeof fetch
    await expect(exaProvider.search({ query: 'q' })).rejects.toThrow(/402/)
  })
})

describe('exaProvider tuning env', () => {
  const savedTuning = {
    EXA_NUM_RESULTS: process.env.EXA_NUM_RESULTS,
    EXA_SEARCH_TYPE: process.env.EXA_SEARCH_TYPE,
  }

  beforeEach(() => {
    process.env.EXA_API_KEY = 'exa-test-key'
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedTuning)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  async function captureBody(): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> = {}
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch
    await exaProvider.search({ query: 'q' })
    return capturedBody
  }

  test('EXA_SEARCH_TYPE selects the search type', async () => {
    process.env.EXA_SEARCH_TYPE = 'Fast'
    expect((await captureBody()).type).toBe('fast')
  })

  test('accepts multi-word Exa search types', async () => {
    process.env.EXA_SEARCH_TYPE = 'deep-reasoning'
    expect((await captureBody()).type).toBe('deep-reasoning')
  })

  test.each(['keyword-ish', 'neural'])('unsupported EXA_SEARCH_TYPE %p falls back to auto', async value => {
    process.env.EXA_SEARCH_TYPE = value
    expect((await captureBody()).type).toBe('auto')
  })

  test('EXA_NUM_RESULTS sets the result count', async () => {
    process.env.EXA_NUM_RESULTS = '25'
    expect((await captureBody()).numResults).toBe(25)
  })

  test('EXA_NUM_RESULTS is clamped to 50', async () => {
    process.env.EXA_NUM_RESULTS = '500'
    expect((await captureBody()).numResults).toBe(50)
  })

  test.each(['0', '-3', '2.5', 'many', ''])('invalid EXA_NUM_RESULTS %p uses the default', async value => {
    process.env.EXA_NUM_RESULTS = value
    expect((await captureBody()).numResults).toBe(15)
  })
})
