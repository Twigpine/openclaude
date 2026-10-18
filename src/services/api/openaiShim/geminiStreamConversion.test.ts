import { expect, test } from 'bun:test'
import {
  createProviderStreamTrace,
  createReaderCanceller,
  createStreamAbortError,
  readWithIdleTimeout,
  throwIfStreamAborted,
} from './streamControl.js'
import { geminiSseToAnthropic } from './geminiStreamConversion.js'

const dependencies = {
  createProviderStreamTrace,
  createReaderCanceller,
  createStreamAbortError,
  getStreamIdleTimeoutMs: () => 1_000,
  makeMessageId: () => 'msg_gemini_test',
  readWithIdleTimeout,
  throwIfStreamAborted,
}

function responseFor(...payloads: Array<Record<string, unknown>>): Response {
  const frames = [
    ...payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`),
    'data: [DONE]\n\n',
  ].join('')
  return new Response(new TextEncoder().encode(frames), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function collectEvents(
  response: Response,
  signal?: AbortSignal,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = []
  for await (const event of geminiSseToAnthropic(
    response,
    'gemini-test',
    signal,
    dependencies,
  )) {
    events.push(event as unknown as Record<string, unknown>)
  }
  return events
}

test('converts Gemini text, tool calls, usage, and finish state', async () => {
  const events = await collectEvents(responseFor({
    candidates: [{
      content: {
        parts: [
          { text: 'Inspecting.' },
          { functionCall: { name: 'Read', args: { file_path: 'a.ts' } } },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 4,
      candidatesTokenCount: 2,
      thoughtsTokenCount: 1,
    },
  }))

  expect(events[0]).toMatchObject({
    type: 'message_start',
    message: { id: 'msg_gemini_test', model: 'gemini-test' },
  })
  expect(events.some(event =>
    event.type === 'content_block_delta' &&
    (event.delta as { text?: string })?.text === 'Inspecting.',
  )).toBe(true)

  const toolStartIndex = events.findIndex(event =>
    event.type === 'content_block_start' &&
    (event.content_block as { name?: string })?.name === 'Read',
  )
  expect(toolStartIndex).toBeGreaterThan(-1)
  expect(events[toolStartIndex + 1]).toMatchObject({
    type: 'content_block_delta',
    delta: {
      type: 'input_json_delta',
      partial_json: '{"file_path":"a.ts"}',
    },
  })
  expect(events[toolStartIndex + 2]).toEqual({
    type: 'content_block_stop',
    index: (events[toolStartIndex] as { index: number }).index,
  })
  expect(events.at(-2)).toMatchObject({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { input_tokens: 4, output_tokens: 3 },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('maps STOP to end_turn when no tool call is present', async () => {
  const events = await collectEvents(responseFor({
    candidates: [{
      content: { parts: [{ text: 'Done.' }] },
      finishReason: 'STOP',
    }],
  }))

  expect(events.at(-2)).toMatchObject({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('maps MAX_TOKENS to max_tokens when no tool call is present', async () => {
  const events = await collectEvents(responseFor({
    candidates: [{
      content: { parts: [{ text: 'Truncated.' }] },
      finishReason: 'MAX_TOKENS',
    }],
  }))

  expect(events.at(-2)).toMatchObject({
    type: 'message_delta',
    delta: { stop_reason: 'max_tokens' },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('rejects an already-aborted Gemini stream without yielding events', async () => {
  const cancelReasons: unknown[] = []
  const response = new Response(new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } })
  const controller = new AbortController()
  controller.abort()
  const stream = geminiSseToAnthropic(
    response,
    'gemini-test',
    controller.signal,
    dependencies,
  )

  await expect(stream.next()).rejects.toMatchObject({ name: 'AbortError' })
  expect(cancelReasons).toHaveLength(1)
})
