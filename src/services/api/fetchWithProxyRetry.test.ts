import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'

import { _resetKeepAliveForTesting } from '../../utils/proxy.js'
import {
  fetchWithProxyRetry,
  isRetryableFetchError,
} from './fetchWithProxyRetry.js'

type FetchType = typeof globalThis.fetch

const originalFetch = globalThis.fetch
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
] as const

const originalEnv = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  ALL_PROXY: process.env.ALL_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  all_proxy: process.env.all_proxy,
}

function restoreEnv(
  key:
    | 'HTTP_PROXY'
    | 'HTTPS_PROXY'
    | 'ALL_PROXY'
    | 'http_proxy'
    | 'https_proxy'
    | 'all_proxy',
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV_KEYS) {
    delete process.env[key]
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('fetchWithProxyRetry.test.ts')
  clearProxyEnv()
  process.env.HTTP_PROXY = 'http://127.0.0.1:15236'
  _resetKeepAliveForTesting()
})

afterEach(() => {
  try {
    globalThis.fetch = originalFetch
    clearProxyEnv()
    restoreEnv('HTTP_PROXY', originalEnv.HTTP_PROXY)
    restoreEnv('HTTPS_PROXY', originalEnv.HTTPS_PROXY)
    restoreEnv('ALL_PROXY', originalEnv.ALL_PROXY)
    restoreEnv('http_proxy', originalEnv.http_proxy)
    restoreEnv('https_proxy', originalEnv.https_proxy)
    restoreEnv('all_proxy', originalEnv.all_proxy)
    _resetKeepAliveForTesting()
  } finally {
    releaseSharedMutationLock()
  }
})

test('isRetryableFetchError matches Bun socket-closed failures', () => {
  expect(
    isRetryableFetchError(
      new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      ),
    ),
  ).toBe(true)
})

test('fetchWithProxyRetry retries once with keepalive disabled after socket closure', async () => {
  const calls: Array<RequestInit | undefined> = []

  globalThis.fetch = (async (_input, init) => {
    calls.push(init)
    if (calls.length === 1) {
      throw new Error(
        'The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()',
      )
    }
    return new Response('ok')
  }) as unknown as FetchType

  const response = await fetchWithProxyRetry('https://example.com/search', {
    method: 'POST',
  })

  expect(await response.text()).toBe('ok')
  expect(calls).toHaveLength(2)
  expect((calls[0] as RequestInit & { proxy?: string }).proxy).toBe(
    'http://127.0.0.1:15236',
  )
  expect((calls[0] as RequestInit).keepalive).toBeUndefined()
  expect((calls[1] as RequestInit).keepalive).toBe(false)
})

test('fetchWithProxyRetry does not retry non-network errors', async () => {
  let attempts = 0

  // Match fetch's call signature (param + Promise<Response>): an argless,
  // always-throwing async fn infers a type that no longer overlaps fetch.
  globalThis.fetch = (async (_input): Promise<Response> => {
    attempts += 1
    throw new Error('400 bad request')
  }) as unknown as FetchType

  await expect(fetchWithProxyRetry('https://example.com')).rejects.toThrow(
    '400 bad request',
  )
  expect(attempts).toBe(1)
})

test('fetchWithProxyRetry retries and disables keepalive after receiving a 504 response', async () => {
  const calls: Array<RequestInit | undefined> = []
  
  globalThis.fetch = (async (_input, init) => {
    calls.push(init)
    if (calls.length === 1) {
      return new Response('Gateway Timeout', { status: 504 })
    }
    return new Response('ok')
  }) as unknown as FetchType

  const response = await fetchWithProxyRetry('https://example.com/search')
  expect(response.status).toBe(200)
  expect(calls).toHaveLength(2)
  expect((calls[0] as RequestInit).keepalive).toBeUndefined()
  expect((calls[1] as RequestInit).keepalive).toBe(false)
})

test('fetchWithProxyRetry retries when cancelling a discarded 504 body stalls', async () => {
  let attempts = 0

  globalThis.fetch = (async () => {
    attempts++
    if (attempts === 1) {
      return new Response(new ReadableStream({
        cancel() {
          return new Promise(() => {})
        },
      }), { status: 504 })
    }
    return new Response('ok')
  }) as unknown as FetchType

  const response = await fetchWithProxyRetry('https://example.com/search')

  expect(response.status).toBe(200)
  expect(attempts).toBe(2)
})

test('fetchWithProxyRetry does not retry a 504 after the request is aborted', async () => {
  const controller = new AbortController()
  const abortReason = new DOMException('Deadline exceeded', 'TimeoutError')
  let attempts = 0
  let bodyCancelled = false

  globalThis.fetch = (async () => {
    attempts++
    controller.abort(abortReason)
    return new Response(new ReadableStream({
      cancel() {
        bodyCancelled = true
      },
    }), { status: 504 })
  }) as unknown as FetchType

  await expect(
    fetchWithProxyRetry('https://example.com/generate', {
      method: 'POST',
      signal: controller.signal,
    }),
  ).rejects.toBe(abortReason)

  expect(attempts).toBe(1)
  await Promise.resolve()
  expect(bodyCancelled).toBe(true)
})

test('fetchWithProxyRetry honors an aborted Request signal without replaying', async () => {
  const controller = new AbortController()
  const abortReason = new DOMException('Deadline exceeded', 'TimeoutError')
  let attempts = 0

  globalThis.fetch = (async () => {
    attempts++
    controller.abort(abortReason)
    return new Response('Gateway Timeout', { status: 504 })
  }) as unknown as FetchType

  const request = new Request('https://example.com/generate', {
    method: 'POST',
    signal: controller.signal,
  })

  await expect(fetchWithProxyRetry(request)).rejects.toBe(abortReason)
  expect(attempts).toBe(1)
})

test('fetchWithProxyRetry preserves the abort reason for a generic fetch failure', async () => {
  for (const message of ['fetch failed', 'invalid_argument']) {
    const controller = new AbortController()
    const abortReason = new DOMException('Deadline exceeded', 'TimeoutError')
    let attempts = 0

    globalThis.fetch = (async () => {
      attempts++
      controller.abort(abortReason)
      throw new TypeError(message)
    }) as unknown as FetchType

    await expect(
      fetchWithProxyRetry('https://example.com/generate', {
        method: 'POST',
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason)

    expect(attempts).toBe(1)
  }
})

test('fetchWithProxyRetry preserves an explicit AbortError from fetch', async () => {
  const controller = new AbortController()
  const abortReason = new DOMException('Caller cancelled', 'AbortError')
  const fetchAbortError = new DOMException(
    'The operation was aborted.',
    'AbortError',
  )
  let attempts = 0

  globalThis.fetch = (async () => {
    attempts++
    controller.abort(abortReason)
    throw fetchAbortError
  }) as unknown as FetchType

  await expect(
    fetchWithProxyRetry('https://example.com/generate', {
      method: 'POST',
      signal: controller.signal,
    }),
  ).rejects.toBe(fetchAbortError)

  expect(attempts).toBe(1)
})
