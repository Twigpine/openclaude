import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../../test/sharedMutationLock.js'
import { createOpenAIShimClient } from '../openaiShim.js'
import {
  anthropicSsePassthrough,
  createReaderCanceller,
  getStreamIdleTimeoutMs,
  readWithIdleTimeout,
  StreamIdleTimeoutError,
  throwIfStreamAborted,
} from './streamControl.js'

const originalTimeout = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
const originalBaseUrl = process.env.OPENAI_BASE_URL
const originalApiKey = process.env.OPENAI_API_KEY
const originalFetch = globalThis.fetch

beforeEach(async () => {
  await acquireSharedMutationLock('openaiShim-streamControl.test.ts')
  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  process.env.OPENAI_BASE_URL = 'https://api.anthropic-shaped.example.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  try {
    for (const [key, value] of [
      ['CLAUDE_STREAM_IDLE_TIMEOUT_MS', originalTimeout],
      ['OPENAI_BASE_URL', originalBaseUrl],
      ['OPENAI_API_KEY', originalApiKey],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = originalFetch
  } finally {
    releaseSharedMutationLock()
  }
})

function makeStallingResponse(frames: unknown[]): {
  response: Response
  cancelReasons: unknown[]
} {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  const initial = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(initial))
      },
      cancel(reason) {
        cancelReasons.push(reason)
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
  Object.defineProperty(response, 'url', {
    configurable: true,
    value: 'https://api.anthropic-shaped.example.com/v1/messages',
  })
  return { response, cancelReasons }
}

type ShimStream = AsyncIterable<Record<string, unknown>> & {
  controller: AbortController
}

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => {
        withResponse: () => Promise<{ data: ShimStream }>
      }
    }
  }
}

async function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 500)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('readWithIdleTimeout rejects quickly and cancels a stalled reader', async () => {
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  await expect(
    withDeadline(
      readWithIdleTimeout(reader, 20),
      'idle timeout did not reject within 500ms',
    ),
  ).rejects.toBeInstanceOf(StreamIdleTimeoutError)
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(StreamIdleTimeoutError)
})

test('readWithIdleTimeout preserves parent abort instead of reporting idle timeout', async () => {
  const controller = new AbortController()
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()
  const pendingRead = readWithIdleTimeout(reader, 60_000, { signal: controller.signal })

  controller.abort()

  await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toMatchObject({ name: 'AbortError' })
})

test('readWithIdleTimeout settles when a custom canceller throws synchronously', async () => {
  const controller = new AbortController()
  const reader = new ReadableStream<Uint8Array>({}).getReader()
  const pendingRead = readWithIdleTimeout(reader, 60_000, {
    signal: controller.signal,
    cancelReader: () => {
      throw new Error('cancel failed')
    },
  })

  controller.abort()

  await expect(pendingRead).rejects.toMatchObject({ name: 'AbortError' })
  reader.releaseLock()
})

test('readWithIdleTimeout contains a throwing custom error factory', async () => {
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  await expect(
    withDeadline(
      readWithIdleTimeout(reader, 20, {
        createTimeoutError: () => {
          throw new Error('factory failed')
        },
      }),
      'idle timeout did not reject within 500ms',
    ),
  ).rejects.toBeInstanceOf(StreamIdleTimeoutError)
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(StreamIdleTimeoutError)
})

test('stream idle timeout parser validates and bounds overrides', () => {
  expect(getStreamIdleTimeoutMs()).toBe(90_000)
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  expect(getStreamIdleTimeoutMs()).toBe(25)
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = ' 25 '
  expect(getStreamIdleTimeoutMs()).toBe(25)
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '3000000000'
  expect(getStreamIdleTimeoutMs()).toBe(2_147_483_647)

  for (const invalid of ['9007199254740993', '25ms', '0', '-5']) {
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = invalid
    expect(getStreamIdleTimeoutMs()).toBe(90_000)
  }
})

test('reader cancellation is idempotent and abort checks throw AbortError', () => {
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()
  const canceller = createReaderCanceller(reader)

  canceller.cancel()
  canceller.cancel()
  canceller.cleanup()

  expect(cancelReasons).toHaveLength(1)
  const controller = new AbortController()
  controller.abort()
  expect(() => throwIfStreamAborted(controller.signal)).toThrow(
    expect.objectContaining({ name: 'AbortError' }),
  )
})

test('Anthropic-compatible passthrough stream rejects with idle timeout when it stalls', async () => {
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '20'
  const stalled = makeStallingResponse([{ type: 'message_start' }])
  const stream = anthropicSsePassthrough<{ type: string }>(
    stalled.response,
    undefined,
    () => {},
  )

  expect(await stream.next()).toEqual({ done: false, value: { type: 'message_start' } })
  await expect(stream.next()).rejects.toBeInstanceOf(StreamIdleTimeoutError)
  expect(stalled.cancelReasons[0]).toBeInstanceOf(StreamIdleTimeoutError)
})

test('Anthropic passthrough emits a final unterminated SSE data frame at EOF', async () => {
  const response = new Response(
    new TextEncoder().encode('data: {"type":"message_stop"}'),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
  const events: Array<{ type: string }> = []
  for await (const event of anthropicSsePassthrough<{ type: string }>(response, undefined, () => {})) {
    events.push(event)
  }
  expect(events).toEqual([{ type: 'message_stop' }])
})

test('Anthropic passthrough cancels a source that stays open after [DONE]', async () => {
  const cancelReasons: unknown[] = []
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
      },
      cancel(reason) {
        cancelReasons.push(reason)
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )

  const events: Array<{ type: string }> = []
  for await (const event of anthropicSsePassthrough<{ type: string }>(response, undefined, () => {})) {
    events.push(event)
  }

  expect(events).toEqual([])
  expect(cancelReasons).toHaveLength(1)
})

test('Anthropic passthrough accepts CRLF frames and data fields without a space', async () => {
  const response = new Response(
    new TextEncoder().encode('data:{"type":"message_start"}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n'),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
  const events: Array<{ type: string }> = []
  for await (const event of anthropicSsePassthrough<{ type: string }>(response, undefined, () => {})) {
    events.push(event)
  }
  expect(events).toEqual([{ type: 'message_start' }, { type: 'message_stop' }])
})

test('controller abort reaches Anthropic messages SSE passthrough', async () => {
  const controller = new AbortController()
  const stalled = makeStallingResponse([{ type: 'message_start' }])
  const events: Array<{ type: string }> = []
  const stream = anthropicSsePassthrough<{ type: string }>(
    stalled.response,
    controller.signal,
    () => {},
  )
  const drain = (async () => {
    for await (const event of stream) {
      events.push(event)
      controller.abort()
    }
  })()

  await expect(withDeadline(drain, 'passthrough did not stop')).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(events).toEqual([{ type: 'message_start' }])
  expect(stalled.cancelReasons).toHaveLength(1)
})

test('the returned stream controller cancels an Anthropic messages response', async () => {
  const stalled = makeStallingResponse([{ type: 'message_start' }])
  globalThis.fetch = (async () => stalled.response) as unknown as typeof globalThis.fetch
  const client = createOpenAIShimClient({}) as unknown as ShimClient
  const result = await client.beta.messages.create({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: true,
  }).withResponse()
  const iterator = result.data[Symbol.asyncIterator]()

  expect((await iterator.next()).value?.type).toBe('message_start')
  result.data.controller.abort()

  await withDeadline(
    (async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (stalled.cancelReasons.length > 0) return
        await Promise.resolve()
      }
      throw new Error('returned controller did not cancel the paused response')
    })(),
    'returned controller did not cancel the paused response',
  )
  expect(stalled.cancelReasons).toHaveLength(1)
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
})

test('Anthropic passthrough preserves errors thrown by its consumer', async () => {
  const stalled = makeStallingResponse([{ type: 'message_start' }])
  const stream = anthropicSsePassthrough<{ type: string }>(
    stalled.response,
    undefined,
    () => {},
  )
  const sentinel = new Error('consumer failed')

  expect((await stream.next()).value).toEqual({ type: 'message_start' })

  await expect(stream.throw(sentinel)).rejects.toBe(sentinel)
  expect(stalled.cancelReasons).toHaveLength(1)
})

test('controller abort cancels Anthropic messages SSE when paused after event', async () => {
  const controller = new AbortController()
  const stalled = makeStallingResponse([{ type: 'message_start' }])
  const stream = anthropicSsePassthrough<{ type: string }>(
    stalled.response,
    controller.signal,
    () => {},
  )

  expect(await stream.next()).toEqual({ done: false, value: { type: 'message_start' } })
  controller.abort()
  await withDeadline(
    (async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (stalled.cancelReasons.length > 0) return
        await Promise.resolve()
      }
      throw new Error('paused passthrough did not cancel its source')
    })(),
    'paused passthrough did not cancel its source',
  )
  await stream.return(undefined)
  expect(stalled.cancelReasons).toHaveLength(1)
})

test('controller abort stops buffered Anthropic messages SSE events', async () => {
  const controller = new AbortController()
  const stalled = makeStallingResponse([
    { type: 'message_start' },
    { type: 'content_block_start' },
  ])
  const stream = anthropicSsePassthrough<{ type: string }>(
    stalled.response,
    controller.signal,
    () => {},
  )

  expect(await stream.next()).toEqual({ done: false, value: { type: 'message_start' } })
  controller.abort()

  await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
  expect(stalled.cancelReasons).toHaveLength(1)
})
