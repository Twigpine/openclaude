import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'

const originalEnv = {
  WEB_SEARCH_TIMEOUT_SEC: process.env.WEB_SEARCH_TIMEOUT_SEC,
}

beforeEach(async () => {
  await acquireSharedMutationLock('WebSearchTool/providers/duckduckgo.test.ts')
})

afterEach(() => {
  try {
    if (originalEnv.WEB_SEARCH_TIMEOUT_SEC === undefined) {
      delete process.env.WEB_SEARCH_TIMEOUT_SEC
    } else {
      process.env.WEB_SEARCH_TIMEOUT_SEC = originalEnv.WEB_SEARCH_TIMEOUT_SEC
    }
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('DuckDuckGo SafeSearchType', () => {
  test('SafeSearchType.STRICT === 0 (matches previous raw value)', async () => {
    const { SafeSearchType } = await import('duck-duck-scrape')
    expect(SafeSearchType.STRICT).toBe(0)
  })

  test('SafeSearchType enum values are sane', async () => {
    const { SafeSearchType } = await import('duck-duck-scrape')
    expect(SafeSearchType.STRICT).toBe(0)
    expect(SafeSearchType.MODERATE).toBe(-1)
    expect(SafeSearchType.OFF).toBe(-2)
  })
})

describe('duckduckgoProvider retry cancellation', () => {
  test('anomaly hint includes local and hosted Ollama configuration', async () => {
    mock.module('duck-duck-scrape', () => ({
      SafeSearchType: {
        STRICT: 0,
        MODERATE: -1,
        OFF: -2,
      },
      search: async () => {
        throw new Error('anomaly in the request')
      },
    }))

    const { duckduckgoProvider } = await import('./duckduckgo.js')
    await expect(
      duckduckgoProvider.search({ query: 'blocked search' }),
    ).rejects.toThrow(/OLLAMA_BASE_URL, OLLAMA_API_KEY/)
  })

  test('provider-level timeout stops after one scrape attempt', async () => {
    process.env.WEB_SEARCH_TIMEOUT_SEC = '1'

    let calls = 0
    let observedSignal: AbortSignal | undefined
    mock.module('duck-duck-scrape', () => ({
      SafeSearchType: {
        STRICT: 0,
        MODERATE: -1,
        OFF: -2,
      },
      search: (
        _query: string,
        _options: unknown,
        needleOptions?: { signal?: AbortSignal },
      ) => {
        calls++
        observedSignal = needleOptions?.signal
        return new Promise(() => undefined)
      },
    }))

    const { duckduckgoProvider } = await import('./duckduckgo.js')
    await expect(
      duckduckgoProvider.search({ query: 'provider timeout' }),
    ).rejects.toThrow(/DuckDuckGo search timed out/)

    expect(calls).toBe(1)
    expect(observedSignal).toBeInstanceOf(AbortSignal)
    expect(observedSignal?.aborted).toBe(true)
  })

  test('caller abort during retry backoff stops without another attempt', async () => {
    let calls = 0
    mock.module('duck-duck-scrape', () => ({
      SafeSearchType: {
        STRICT: 0,
        MODERATE: -1,
        OFF: -2,
      },
      search: async () => {
        calls++
        throw new Error('timeout from DuckDuckGo')
      },
    }))

    const { duckduckgoProvider } = await import('./duckduckgo.js')
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 10)

    try {
      await expect(
        duckduckgoProvider.search({ query: 'retry abort' }, controller.signal),
      ).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      clearTimeout(abortTimer)
    }

    expect(calls).toBe(1)
  })
})
