import { afterEach, expect, jest, test } from 'bun:test'
import {
  fetchWithHeadersDeadline,
  getApiTimeoutMs,
  redactUrlForDiagnostics,
  ResponseHeadersTimeoutError,
} from './transport.js'

const originalFetch = globalThis.fetch
const originalApiTimeoutMs = process.env.API_TIMEOUT_MS
const originalApiKey = process.env.OPENAI_API_KEY

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalApiTimeoutMs === undefined) delete process.env.API_TIMEOUT_MS
  else process.env.API_TIMEOUT_MS = originalApiTimeoutMs
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalApiKey
  jest.useRealTimers()
})

test('API timeout parser accepts bounded positive integers', () => {
  delete process.env.API_TIMEOUT_MS
  expect(getApiTimeoutMs()).toBe(600_000)
  process.env.API_TIMEOUT_MS = '25'
  expect(getApiTimeoutMs()).toBe(25)
  process.env.API_TIMEOUT_MS = ' 25 '
  expect(getApiTimeoutMs()).toBe(25)
  process.env.API_TIMEOUT_MS = '3000000000'
  expect(getApiTimeoutMs()).toBe(2_147_483_647)

  for (const invalid of ['abc', '', '1.5', '9007199254740993', '25ms', '0', '-5']) {
    process.env.API_TIMEOUT_MS = invalid
    expect(getApiTimeoutMs()).toBe(600_000)
  }
})

test('API timeout parser can inspect a request-local environment', () => {
  process.env.API_TIMEOUT_MS = '10'
  expect(getApiTimeoutMs({ API_TIMEOUT_MS: '42' })).toBe(42)
  expect(getApiTimeoutMs({})).toBe(600_000)
})

test('API timeout parser honors a caller-supplied fallback', () => {
  // Native clients reuse this parser with their own context default, so an
  // unset/malformed/negative override must resolve to the caller's fallback,
  // never NaN or a negative timeout.
  expect(getApiTimeoutMs({}, 300_000)).toBe(300_000)
  for (const invalid of ['abc', '', '1.5', '25ms', '0', '-5']) {
    expect(getApiTimeoutMs({ API_TIMEOUT_MS: invalid }, 120_000)).toBe(120_000)
  }
  // A valid override still wins over the fallback and stays capped.
  expect(getApiTimeoutMs({ API_TIMEOUT_MS: '25' }, 120_000)).toBe(25)
  expect(getApiTimeoutMs({ API_TIMEOUT_MS: '3000000000' }, 120_000)).toBe(
    2_147_483_647,
  )
})

test('redacts configured and encoded secrets from diagnostic URLs', () => {
  process.env.OPENAI_API_KEY = 'secret/value'
  const diagnostic = redactUrlForDiagnostics(
    'https://example.test/secret%252Fvalue?token=secret%2Fvalue',
  )

  expect(diagnostic).not.toContain('secret')
  expect(diagnostic).not.toContain('value')
  expect(diagnostic.toLowerCase()).toContain('redact')
})

test('rejects a request that receives no headers before its deadline', async () => {
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  })) as typeof globalThis.fetch

  await expect(fetchWithHeadersDeadline(
    'https://example.test/v1/chat/completions',
    {},
    { timeoutMs: 20 },
  )).rejects.toBeInstanceOf(ResponseHeadersTimeoutError)
})

test('preserves caller cancellation instead of reporting a deadline', async () => {
  const caller = new AbortController()
  globalThis.fetch = ((_input, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })) as typeof globalThis.fetch

  const pending = fetchWithHeadersDeadline(
    'https://example.test/v1/chat/completions',
    {},
    { callerSignal: caller.signal, timeoutMs: 60_000 },
  )
  caller.abort(new DOMException('Caller stopped', 'AbortError'))

  await expect(pending).rejects.toBe(caller.signal.reason)
})

test('disarms the deadline once response headers arrive', async () => {
  jest.useFakeTimers()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let capturedSignal: AbortSignal | undefined
  globalThis.fetch = (async (_input, init) => {
    capturedSignal = init?.signal
    return new Response(new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    }))
  }) as typeof globalThis.fetch

  const responsePromise = fetchWithHeadersDeadline(
    'https://example.test/v1/chat/completions',
    {},
    { timeoutMs: 20 },
  )
  await Promise.resolve()
  jest.advanceTimersByTime(30)
  expect(capturedSignal?.aborted).toBe(false)

  controller?.enqueue(new TextEncoder().encode('ok'))
  controller?.close()
  const response = await responsePromise
  expect(await response.text()).toBe('ok')
})

test('cleans up the caller signal after early body cancellation', async () => {
  jest.useFakeTimers()
  const originalAbortSignalAny = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'any',
  )
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
  })
  try {
    let capturedSignal: AbortSignal | undefined
    const caller = new AbortController()
    globalThis.fetch = (async (_input, init) => {
      capturedSignal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({
        start(value) {
          value.enqueue(new TextEncoder().encode('partial'))
        },
      }))
    }) as typeof globalThis.fetch

    const response = await fetchWithHeadersDeadline(
      'https://example.test/v1/chat/completions',
      {},
      { callerSignal: caller.signal, timeoutMs: 20 },
    )
    await response.body?.cancel()
    jest.advanceTimersByTime(30)
    expect(capturedSignal?.aborted).toBe(false)

    caller.abort(new DOMException('Caller stopped', 'AbortError'))
    expect(capturedSignal?.aborted).toBe(false)
  } finally {
    if (originalAbortSignalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny)
    } else {
      delete (AbortSignal as { any?: unknown }).any
    }
  }
})
