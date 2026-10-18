import { expect, test } from 'bun:test'
import type { AnthropicStreamEvent } from '../codexShim.js'
import {
  convertGeminiToAnthropicResponse,
  geminiSseToAnthropic,
  openaiStreamToAnthropic,
  parseTextToolCalls,
  parseXmlToolCalls,
} from './responseAdapters.js'

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

async function collectStreamEvents(
  generator: AsyncGenerator<AnthropicStreamEvent>,
): Promise<AnthropicStreamEvent[]> {
  const events: AnthropicStreamEvent[] = []
  for await (const event of generator) events.push(event)
  return events
}

test('raw-text and XML fallback tool calls use one unique sequence', () => {
  const text = parseTextToolCalls('{"name":"from_text","arguments":{}}')
  const xml = parseXmlToolCalls(
    '<tool_call>{"name":"from_xml","arguments":{}}</tool_call>',
  )

  expect(text.calls[0]?.id).toMatch(/^ollama_tc_\d+$/)
  expect(xml.calls[0]?.id).toMatch(/^xml_tc_\d+$/)
  const textSequence = Number(text.calls[0]?.id?.replace(/^\D+/, ''))
  const xmlSequence = Number(xml.calls[0]?.id?.replace(/^\D+/, ''))
  expect(xmlSequence).toBe(textSequence + 1)
})

test('converts Gemini text and function calls into an Anthropic message', () => {
  const message = convertGeminiToAnthropicResponse({
    candidates: [{
      content: {
        parts: [
          { text: 'Checking the workspace.' },
          { functionCall: { name: 'Read', args: { file_path: 'a.ts' } } },
        ],
      },
      finishReason: 'STOP',
    }],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 3,
      thoughtsTokenCount: 2,
    },
  }, 'gemini-test')

  expect(message).toMatchObject({
    type: 'message',
    role: 'assistant',
    model: 'gemini-test',
    stop_reason: 'tool_use',
    content: [
      { type: 'text', text: 'Checking the workspace.' },
      { type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } },
    ],
    usage: { input_tokens: 5, output_tokens: 5 },
  })
})

test('maps Gemini max-token completion without tool calls', () => {
  const message = convertGeminiToAnthropicResponse({
    candidates: [{
      content: { parts: [{ text: 'partial' }] },
      finishReason: 'MAX_TOKENS',
    }],
  }, 'gemini-test')

  expect(message.stop_reason).toBe('max_tokens')
  expect(message.content).toEqual([{ type: 'text', text: 'partial' }])
})

test('geminiSseToAnthropic wrapper emits content, usage, and terminal stop', async () => {
  const events = await collectStreamEvents(geminiSseToAnthropic(
    makeSseResponse([
      {
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 1,
        },
        candidates: [{
          content: {
            parts: [
              { text: 'Inspecting.' },
              { functionCall: { name: 'Read', args: { file_path: 'a.ts' } } },
            ],
          },
          finishReason: 'STOP',
        }],
      },
      '[DONE]',
    ]),
    'gemini-test',
  ))

  expect(events[0]).toMatchObject({
    type: 'message_start',
    message: { model: 'gemini-test' },
  })
  expect(events.some(event =>
    event.type === 'content_block_delta' &&
    (event.delta as { text?: string })?.text === 'Inspecting.',
  )).toBe(true)

  const toolStartIndex = events.findIndex(event =>
    event.type === 'content_block_start' &&
    (event.content_block as { type?: string; name?: string })?.type === 'tool_use' &&
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
    usage: {
      input_tokens: 4,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  })
  expect(events.at(-1)).toEqual({ type: 'message_stop' })
})

test('openaiStreamToAnthropic wrapper emits text, usage, and terminal stop', async () => {
  const events = await collectStreamEvents(openaiStreamToAnthropic(
    makeSseResponse([
      {
        choices: [{
          index: 0,
          delta: { content: 'hello' },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      },
      '[DONE]',
    ]),
    'test-model',
  ))

  expect(events.map(event => event.type)).toContain('message_start')
  expect(events).toContainEqual({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  })
  expect(events.at(-2)).toMatchObject({
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
