import { expect, test } from 'bun:test'
import type { AnthropicStreamEvent } from '../codexShim.js'
import {
  convertOpenAIStreamUsage,
  openaiStreamToAnthropic,
  type StreamConversionDependencies,
} from './streamConversion.js'
import {
  geminiSseToAnthropic,
  type GeminiStreamDependencies,
} from './geminiStreamConversion.js'
import { createProviderStreamTrace } from './streamControl.js'

function makeSseResponse(frames: unknown[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          const data = frame === '[DONE]' ? frame : JSON.stringify(frame)
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function makeOpenAIChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  usage?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  }
}

async function collect(
  generator: AsyncGenerator<AnthropicStreamEvent>,
): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

function createReaderCanceller(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
) {
  let cancelled = false
  const cancel = (error: unknown = new DOMException('Aborted', 'AbortError')) => {
    if (cancelled) return
    cancelled = true
    void reader.cancel(error).catch(() => {})
  }
  const onAbort = () => cancel(new DOMException('Aborted', 'AbortError'))
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  return {
    cancel,
    cleanup: () => signal?.removeEventListener('abort', onAbort),
  }
}

async function readWithSignal(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  _timeoutMs: number,
  options: {
    signal?: AbortSignal
    cancelReader?: (error?: unknown) => void
  } = {},
) {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return await reader.read()
}

const commonControlDependencies: GeminiStreamDependencies = {
  createProviderStreamTrace,
  createReaderCanceller,
  createStreamAbortError: () => new DOMException('Aborted', 'AbortError'),
  getStreamIdleTimeoutMs: () => 1_000,
  makeMessageId: () => 'msg_test',
  readWithIdleTimeout: readWithSignal,
  throwIfStreamAborted(signal) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  },
}

function createStreamDependencies(
  overrides: Partial<StreamConversionDependencies> = {},
): StreamConversionDependencies {
  return {
    ...commonControlDependencies,
    convertNonStreamingResponseToAnthropicMessage: () => ({
      content: [{ type: 'text', text: 'fallback' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 2, output_tokens: 3 },
    }),
    couldBeRawToolCallsRequestedPrefix: text =>
      'Tool calls requested:'.startsWith(text) ||
      text.startsWith('Tool calls requested:'),
    findXmlToolCallOpener: () => -1,
    geminiThoughtSignatureFromExtraContent: extra => {
      if (!extra || typeof extra !== 'object') return undefined
      const google = (extra as Record<string, unknown>).google
      if (!google || typeof google !== 'object') return undefined
      const signature = (google as Record<string, unknown>).thought_signature
      return typeof signature === 'string' ? signature : undefined
    },
    headersWithRequestUrl: headers => new Headers(headers),
    isHy3Model: () => false,
    mergeGeminiThoughtSignature: (extra, signature) =>
      signature
        ? { ...extra, google: { thought_signature: signature } }
        : extra,
    parseRawToolCallsRequestedText: () => null,
    parseTextToolCalls: () => ({ calls: [], toolCallRanges: [] }),
    parseXmlToolCalls: () => ({ calls: [], toolCallRanges: [] }),
    repairPossiblyTruncatedObjectJson(raw) {
      for (const suffix of ['', '}', '"}', '}}']) {
        try {
          const candidate = raw + suffix
          JSON.parse(candidate)
          return candidate
        } catch {}
      }
      return null
    },
    stripRanges: text => text,
    trailingXmlOpenerPrefixLen: () => 0,
    ...overrides,
  }
}

test('converts final OpenAI stream usage, including cached input tokens', () => {
  expect(
    convertOpenAIStreamUsage({
      prompt_tokens: 12,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 4 },
    }),
  ).toEqual({
    input_tokens: 8,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 4,
  })
})

test('omits usage when the OpenAI chunk did not include it', () => {
  expect(convertOpenAIStreamUsage(undefined)).toBeUndefined()
})

test('converts text, thinking, finish reason, and terminal usage events', async () => {
  const response = makeSseResponse([
    makeOpenAIChunk({ reasoning_content: 'considering' }),
    makeOpenAIChunk({ content: 'answer' }),
    makeOpenAIChunk(
      {},
      'stop',
      { prompt_tokens: 7, completion_tokens: 2 },
    ),
    '[DONE]',
  ])
  const events = await collect(
    openaiStreamToAnthropic(
      response,
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )

  expect(events.map(event => event.type)).toContain('message_start')
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'considering' },
  })
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'answer' },
  })
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 7,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test.each([
  ['plain string', 'echo hello', '{"command":"echo hello"}'],
  ['whitespace-only input', '   ', '{}'],
  [
    'bracket syntax',
    '[ -f package.json ] && pwd',
    '{"command":"[ -f package.json ] && pwd"}',
  ],
])('normalizes %s Bash tool arguments at stream stop', async (_label, raw, expected) => {
  const response = makeSseResponse([
    makeOpenAIChunk({
      tool_calls: [{
        index: 0,
        id: 'call_1',
        function: { name: 'Bash', arguments: raw },
      }],
    }),
    makeOpenAIChunk({}, 'tool_calls'),
    '[DONE]',
  ])
  const events = await collect(
    openaiStreamToAnthropic(
      response,
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )
  const partials = events
    .filter(event => event.type === 'content_block_delta')
    .map(event => {
      const delta = event.delta as
        | { type?: string; partial_json?: string }
        | undefined
      return delta?.type === 'input_json_delta'
        ? delta.partial_json
        : undefined
    })
    .filter(Boolean)
  expect(partials.at(-1)).toBe(expected)
})

test('preserves incomplete structured Bash arguments at max_tokens', async () => {
  const raw = '{"command":"unfinished'
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({
          tool_calls: [{
            index: 0,
            id: 'call_1',
            function: { name: 'Bash', arguments: raw },
          }],
        }),
        makeOpenAIChunk({}, 'length'),
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )
  expect(JSON.stringify(events)).toContain(raw.replaceAll('"', '\\"'))
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens', stop_sequence: null },
  })
})

test('emits usage supplied by a final empty-choices chunk', async () => {
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: 'done' }),
        makeOpenAIChunk({}, 'stop'),
        {
          choices: [],
          usage: { prompt_tokens: 123, completion_tokens: 45 },
        },
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )
  const usageEvents = events.filter(
    event => event.type === 'message_delta' && event.usage !== undefined,
  )
  expect(usageEvents).toEqual([{
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 123,
      output_tokens: 45,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  }])

  const textIndex = events.findIndex(
    event =>
      event.type === 'content_block_delta' &&
      (event.delta as { type?: string; text?: string } | undefined)?.type ===
        'text_delta' &&
      (event.delta as { text?: string } | undefined)?.text === 'done',
  )
  const firstStopIndex = events.findIndex(
    event =>
      event.type === 'message_delta' &&
      (event.delta as { stop_reason?: string } | undefined)?.stop_reason ===
        'end_turn',
  )
  const usageIndex = events.indexOf(usageEvents[0]!)
  const messageStopIndex = events.findIndex(event => event.type === 'message_stop')
  expect(textIndex).toBeLessThan(firstStopIndex)
  expect(firstStopIndex).toBeLessThan(usageIndex)
  expect(usageIndex).toBeLessThan(messageStopIndex)
})

test('emits terminal usage when the provider repeats finish_reason', async () => {
  // Some providers end a stream twice: one chunk carrying the finish_reason,
  // then a second, identical but for the usage, with choices still populated.
  // The loop ignores a repeated finish_reason, so that usage was dropped and
  // every assistant message stored zeros — which is what anything reading the
  // size or the cost of a conversation reads.
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: 'done' }),
        makeOpenAIChunk({}, 'stop'),
        makeOpenAIChunk({ content: '' }, 'stop', {
          prompt_tokens: 84,
          completion_tokens: 1,
        }),
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )

  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: {
      input_tokens: 84,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  expect(
    events.filter(
      event => event.type === 'message_delta' && event.usage !== undefined,
    ),
  ).toHaveLength(1)
})

test('emits terminal usage once when both terminal chunks report it', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 2 }
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: 'done' }),
        makeOpenAIChunk({}, 'stop', usage),
        { choices: [], usage },
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )

  expect(
    events.filter(
      event => event.type === 'message_delta' && event.usage !== undefined,
    ),
  ).toHaveLength(1)
})

test('completes normally when a stream does not report usage', async () => {
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: 'done' }),
        makeOpenAIChunk({}, 'stop'),
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )

  expect(
    events.filter(
      event => event.type === 'message_delta' && event.usage !== undefined,
    ),
  ).toHaveLength(0)
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('strips think tags split across content chunks without phrase heuristics', async () => {
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: '<thi' }),
        makeOpenAIChunk({ content: 'nk>secret</think>Visible prose' }),
        makeOpenAIChunk({}, 'stop'),
      ]),
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )
  const serialized = JSON.stringify(events)
  expect(serialized).not.toContain('secret')
  expect(serialized).toContain('Visible prose')
})

test('converts buffered raw tool-call text into tool_use events', async () => {
  const rawText = 'Tool calls requested: demo'
  const events = await collect(
    openaiStreamToAnthropic(
      makeSseResponse([
        makeOpenAIChunk({ content: rawText }),
        makeOpenAIChunk({}, 'stop'),
      ]),
      'gemini-test',
      undefined,
      false,
      undefined,
      createStreamDependencies({
        parseRawToolCallsRequestedText: text =>
          text === rawText
            ? [{ id: 'call_raw', name: 'Read', argumentsJson: '{"path":"a"}' }]
            : null,
      }),
    ),
  )
  expect(events).toContainEqual({
    type: 'content_block_start',
    index: 0,
    content_block: {
      type: 'tool_use',
      id: 'call_raw',
      name: 'Read',
      input: {},
    },
  })
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
  })
  const emittedText = events
    .filter(event =>
      event.type === 'content_block_delta' &&
      (event.delta as { type?: string }).type === 'text_delta',
    )
    .map(event => (event.delta as { text?: string }).text ?? '')
    .join('')
  expect(emittedText).not.toContain(rawText)
})

test('routes provider JSON stream fallback through non-streaming conversion', async () => {
  const response = new Response(JSON.stringify({ choices: [] }), {
    headers: { 'content-type': 'application/json' },
  })
  const events = await collect(
    openaiStreamToAnthropic(
      response,
      'test-model',
      undefined,
      false,
      undefined,
      createStreamDependencies(),
    ),
  )
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'fallback' },
  })
  expect(
    events.filter(
      event => event.type === 'message_delta' && event.usage !== undefined,
    ),
  ).toEqual([{
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { input_tokens: 2, output_tokens: 3 },
  }])
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('generic converter cancels its reader when the parent signal aborts', async () => {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(makeOpenAIChunk({ content: 'partial' }))}\n\n`))
    },
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  const controller = new AbortController()
  const iterator = openaiStreamToAnthropic(
    response,
    'test-model',
    controller.signal,
    false,
    undefined,
    createStreamDependencies(),
  )[Symbol.asyncIterator]()
  await iterator.next()
  controller.abort()
  await iterator.return?.(undefined as never)
  expect(cancelReasons).toHaveLength(1)
})

test('generic converter cancels an unread body after the [DONE] protocol marker', async () => {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: [DONE]\n'))
    },
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  await collect(openaiStreamToAnthropic(
    response,
    'test-model',
    undefined,
    false,
    undefined,
    createStreamDependencies(),
  ))
  expect(cancelReasons).toHaveLength(1)
})

test('generic converter finalizes content before a [DONE] marker without finish_reason', async () => {
  const events = await collect(openaiStreamToAnthropic(
    makeSseResponse([makeOpenAIChunk({ content: 'partial' }), '[DONE]']),
    'test-model',
    undefined,
    false,
    undefined,
    createStreamDependencies(),
  ))
  expect(events.map(event => event.type)).toEqual([
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
  })
})

test('generic converter rejects an incomplete tool call before a [DONE] marker', async () => {
  await expect(collect(openaiStreamToAnthropic(
    makeSseResponse([
      makeOpenAIChunk({
        tool_calls: [{
          index: 0,
          id: 'call_partial',
          function: { name: 'Bash', arguments: '{"command":"rm' },
        }],
      }),
      '[DONE]',
    ]),
    'test-model',
    undefined,
    false,
    undefined,
    createStreamDependencies(),
  ))).rejects.toThrow('stream ended before a tool call completed')
})

test('converts Gemini SSE text, tools, usage, and finish reason', async () => {
  const events = await collect(
    geminiSseToAnthropic(
      makeSseResponse([
        {
          usageMetadata: {
            promptTokenCount: 4,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 1,
          },
          candidates: [{
            content: {
              role: 'model',
              parts: [
                { text: 'hello' },
                { functionCall: { name: 'Read', args: { path: 'a' } } },
              ],
            },
            finishReason: 'STOP',
          }],
        },
        '[DONE]',
      ]),
      'gemini-test',
      undefined,
      commonControlDependencies,
    ),
  )
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  })
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"path":"a"}' },
  })
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: {
      input_tokens: 4,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('Gemini converter cancels its reader when the parent signal aborts', async () => {
  const cancelReasons: unknown[] = []
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  const controller = new AbortController()
  const iterator = geminiSseToAnthropic(
    response,
    'gemini-test',
    controller.signal,
    commonControlDependencies,
  )[Symbol.asyncIterator]()
  controller.abort()
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelReasons).toHaveLength(1)
})

test('Gemini converter accepts CRLF frames, closes consecutive tools, and retains tool_use after text', async () => {
  const encoder = new TextEncoder()
  const frames = [
    { candidates: [{ content: { parts: [
      { functionCall: { name: 'Read', args: {} } },
      { functionCall: { name: 'Write', args: {} } },
      { text: 'done' },
    ] }, finishReason: 'STOP' }] },
    '[DONE]',
  ]
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        const data = frame === '[DONE]' ? frame : JSON.stringify(frame)
        controller.enqueue(encoder.encode(`data: ${data}\r\n\r\n`))
      }
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
  const events = await collect(geminiSseToAnthropic(
    response,
    'gemini-test',
    undefined,
    commonControlDependencies,
  ))
  expect(events.filter(event => event.type === 'content_block_start')).toHaveLength(3)
  expect(events.filter(event => event.type === 'content_block_stop')).toHaveLength(3)
  expect(events).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: {},
  })
})

test('Gemini converter starts an empty message and maps blocked finishes', async () => {
  const doneEvents = await collect(geminiSseToAnthropic(
    makeSseResponse(['[DONE]']),
    'gemini-test',
    undefined,
    commonControlDependencies,
  ))
  expect(doneEvents.map(event => event.type)).toEqual([
    'message_start',
    'message_delta',
    'message_stop',
  ])

  const safetyEvents = await collect(geminiSseToAnthropic(
    makeSseResponse([{
      candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
    }]),
    'gemini-test',
    undefined,
    commonControlDependencies,
  ))
  expect(safetyEvents).toContainEqual({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
    usage: {},
  })
})
