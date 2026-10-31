/**
 * Unit tests for parseTextToolCalls — the Ollama text-based tool call
 * fallback parser introduced in fix/#1053.
 *
 * Covers the four formats requested in the PR review:
 *   1. Bare JSON object  {"name":"X","arguments":{}}
 *   2. Fenced ```json``` block
 *   3. {type:"function",function:{name,arguments}} shape
 *   4. Deduplication by name:args key
 *   5. P1 context guard — bare JSON in explanatory prose is skipped
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { snapshotEnv } from '../../test/envSnapshot.js'
import { createOpenAIShimClient } from './openaiShim.js'
import { parseTextToolCalls } from './openaiShim/rawToolCallParsing.js'

const ENV_KEYS = ['OLLAMA_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const

type FetchType = typeof globalThis.fetch

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function makeOllamaNativeStreamingResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line))
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  )
}

function makeNdjsonChunks(chunks: unknown[]): string[] {
  return chunks.map(c => `${JSON.stringify(c)}\n`)
}

describe('parseTextToolCalls', () => {
  test('parses bare JSON object {"name","arguments"} shape', () => {
    const text = `Let me read that file.\n{"name":"Read","arguments":{"file_path":"/tmp/foo.ts"}}`
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Read')
    expect(calls[0].arguments).toEqual({ file_path: '/tmp/foo.ts' })
    expect(calls[0].id).toMatch(/^ollama_tc_\d+$/)
  })

  test('parses fenced ```json``` block', () => {
    const text = 'I will run this:\n```json\n{"name":"Bash","arguments":{"command":"ls -la"}}\n```'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bash')
    expect(calls[0].arguments).toEqual({ command: 'ls -la' })
  })

  test('parses fenced ``` block (no language tag)', () => {
    const text = '```\n{"name":"Glob","arguments":{"pattern":"src/**/*.ts"}}\n```'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Glob')
  })

  test('parses {type:"function",function:{name,arguments}} shape', () => {
    const text = '{"type":"function","function":{"name":"Grep","arguments":{"pattern":"TODO","path":"src"}}}'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Grep')
    expect(calls[0].arguments).toEqual({ pattern: 'TODO', path: 'src' })
  })

  test('parses {type:"function"} shape when arguments is a JSON string', () => {
    const args = JSON.stringify({ file_path: '/tmp/x.ts' })
    const text = `{"type":"function","function":{"name":"Read","arguments":${JSON.stringify(args)}}}`
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Read')
    expect(calls[0].arguments).toEqual({ file_path: '/tmp/x.ts' })
  })

  test('deduplicates by name:args key', () => {
    const snippet = '{"name":"Read","arguments":{"file_path":"/tmp/foo.ts"}}'
    const text = `${snippet}\nSome text\n${snippet}`
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
  })

  test('returns multiple distinct calls', () => {
    const text = [
      '{"name":"Read","arguments":{"file_path":"a.ts"}}',
      '{"name":"Bash","arguments":{"command":"echo hi"}}',
    ].join('\n')
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(2)
    expect(calls.map(c => c.name)).toEqual(['Read', 'Bash'])
  })

  test('returns empty array for plain text with no JSON', () => {
    const { calls } = parseTextToolCalls('I think you should check the file manually.')
    expect(calls).toHaveLength(0)
  })

  test('ignores malformed JSON', () => {
    const { calls } = parseTextToolCalls('{"name":"Read","arguments":{broken}')
    expect(calls).toHaveLength(0)
  })

  test('ignores JSON objects without name or type:function', () => {
    const { calls } = parseTextToolCalls('{"foo":"bar","baz":42}')
    expect(calls).toHaveLength(0)
  })

  // P1 context guard — bare JSON followed by explanatory prose must not be extracted
  test('skips bare JSON immediately followed by explanatory text (P1 guard)', () => {
    const text =
      'Here is an example call: {"name":"Bash","arguments":{"command":"ls"}}. Note that you must use this format.'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(0)
  })

  // P1 context guard — fenced block followed by explanatory prose must also be skipped
  test('skips fenced JSON block immediately followed by explanatory text (P1 guard fenced)', () => {
    const text =
      'Here is the format to use:\n```json\n{"name":"Bash","arguments":{"command":"echo example"}}\n```\nDo not execute it yet.'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(0)
  })

  test('still parses fenced JSON block with nothing after the closing fence', () => {
    const text = 'Running the command:\n```json\n{"name":"Bash","arguments":{"command":"ls"}}\n```'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bash')
  })

  test('still parses bare JSON with only trailing whitespace (no trailing context)', () => {
    const text = 'Running the command:\n{"name":"Bash","arguments":{"command":"ls"}}\n'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bash')
  })

  // toolCallRanges covers the extracted JSON so callers can strip it from text
  test('returns toolCallRanges covering extracted bare JSON', () => {
    const call = '{"name":"Bash","arguments":{"command":"ls"}}'
    const prefix = 'Running:\n'
    const text = prefix + call
    const { calls, toolCallRanges } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(toolCallRanges).toHaveLength(1)
    const [start, end] = toolCallRanges[0]
    expect(text.slice(start, end)).toBe(call)
  })

  // Regression: fenced/bare ranges must only be added to toolCallRanges AFTER
  // parseAndAdd confirms acceptance — rejected blocks must not silently strip text.
  test('fenced block with bad JSON: no call emitted, range not in toolCallRanges', () => {
    const { calls, toolCallRanges } = parseTextToolCalls('```json\n{bad json}\n```')
    expect(calls).toHaveLength(0)
    expect(toolCallRanges).toHaveLength(0)
  })

  test('fenced block without name field: no call emitted, range not in toolCallRanges', () => {
    const { calls, toolCallRanges } = parseTextToolCalls('```json\n{"foo":"bar"}\n```')
    expect(calls).toHaveLength(0)
    expect(toolCallRanges).toHaveLength(0)
  })

  test('duplicate fenced blocks: second block not in toolCallRanges', () => {
    const block = '```json\n{"name":"Read","arguments":{"file_path":"x"}}\n```'
    const { calls, toolCallRanges } = parseTextToolCalls(block + '\n' + block)
    expect(calls).toHaveLength(1)
    expect(toolCallRanges).toHaveLength(1)
  })

  test('duplicate bare JSON: second occurrence not in toolCallRanges', () => {
    const call = '{"name":"Bash","arguments":{"command":"ls"}}'
    const { calls, toolCallRanges } = parseTextToolCalls(call + '\n' + call)
    expect(calls).toHaveLength(1)
    expect(toolCallRanges).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Streaming integration tests — require the full shim pipeline
// ---------------------------------------------------------------------------

const ollamaChunk = (content: string, finishReason?: string) => ({
  model: 'qwen2.5:7b',
  message: { role: 'assistant', content },
  done: Boolean(finishReason),
  ...(finishReason ? { done_reason: finishReason } : {}),
})

const ollamaToolChunk = (toolCalls: unknown[], finishReason?: string) => ({
  model: 'qwen2.5:7b',
  message: {
    role: 'assistant',
    content: '',
    tool_calls: toolCalls.map((toolCall) => {
      const call = toolCall as {
        function?: { name?: string; arguments?: unknown }
      }
      const args = call.function?.arguments
      return {
        function: {
          name: call.function?.name,
          arguments: typeof args === 'string' ? JSON.parse(args) : args,
        },
      }
    }),
  },
  done: Boolean(finishReason),
  ...(finishReason ? { done_reason: finishReason } : {}),
})

describe('Ollama streaming — think-tag filtering on text-tool fallback (P1)', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('<think> content is NOT emitted as assistant text when text-tool fallback fires', async () => {
    // Repro: model emits <think>private plan</think> followed by tool-call JSON.
    // accumulatedText is raw; stripRanges leaves the <think> block unless we filter it.
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('<think>private plan</think>{"name":"Bash","arguments":{"command":"ls"}}'),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'run ls' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const textDeltas = events.filter(
      e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta',
    )
    for (const d of textDeltas) {
      expect((d.delta as Record<string, string>).text).not.toContain('<think>')
    }

    const toolStarts = events.filter(
      e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].content_block as Record<string, string>).name).toBe('Bash')
  })
})

describe('Ollama streaming — plain text response with no tool calls', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('plain text in two chunks (content then stop) is emitted as text_delta', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Hello from Ollama.'),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')

    expect(allText).toBe('Hello from Ollama.')
    expect(events.filter(e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use')).toHaveLength(0)
    expect(events.some(e => e.type === 'message_stop')).toBe(true)
  })

  test('plain text in single chunk (content + stop) is emitted as text_delta', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([ollamaChunk('Hello from Ollama.', 'stop')]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')

    expect(allText).toBe('Hello from Ollama.')
  })

  test('multi-chunk plain text (no tool calls) assembles correctly', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Hello '),
          ollamaChunk('from '),
          ollamaChunk('Ollama.'),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')

    expect(allText).toBe('Hello from Ollama.')
  })
})

describe('Ollama streaming — visible text before real structured tool_calls (P2)', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('visible assistant text is preserved when real delta.tool_calls follow it', async () => {
    // Repro: Ollama endpoint emits visible prose first, then real structured tool_calls.
    // Before fix: ollamaTextBuffer was discarded when the text block closed.
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Let me check that.'),
          ollamaToolChunk([
            { index: 0, id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
          ]),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'run ls' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toContain('Let me check that.')

    const toolStarts = events.filter(
      e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].content_block as Record<string, string>).name).toBe('Bash')
  })
})

describe('Ollama streaming — visible prose before text-based tool-call fallback (P2 buffered path)', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('visible prose before text-based JSON tool call is preserved in emitted text_delta', async () => {
    // Repro: Ollama model emits prose then tool-call JSON as plain text (no delta.tool_calls).
    // Before fix: hasEmittedContentStart === false in the fallback branch, so the prose in
    // ollamaTextBuffer was discarded — only the synthetic tool_use block was emitted.
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('I will inspect the file.\n'),
          ollamaChunk('{"name":"Read","arguments":{"file_path":"/tmp/foo.ts"}}'),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'read the file' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toContain('I will inspect the file.')

    const toolStarts = events.filter(
      e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].content_block as Record<string, string>).name).toBe('Read')
  })
})

describe('parseTextToolCalls — pretty-printed bare JSON detection', () => {
  test('detects bare JSON with whitespace/newline between { and "name"', () => {
    const text = '{\n  "name": "Bash",\n  "arguments": {"command": "ls"}\n}'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Bash')
    expect(calls[0].arguments).toEqual({ command: 'ls' })
  })

  test('detects bare JSON with spaces between { and "type"', () => {
    const text = '{  "type": "function", "function": {"name": "Grep", "arguments": {"pattern": "foo"}}}'
    const { calls } = parseTextToolCalls(text)
    expect(calls).toHaveLength(1)
    expect(calls[0].name).toBe('Grep')
  })
})

describe('Ollama streaming — non-stop terminal finish reasons flush buffer', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('buffered text is flushed when finish_reason is "length"', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Partial response cut off by'),
          ollamaChunk('', 'length'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 8,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toContain('Partial response cut off by')
  })

  test('text-tool JSON is extracted when finish_reason is "length" but finish_reason stays "length"', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('{"name":"Bash","arguments":{"command":"ls"}}'),
          ollamaChunk('', 'length'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'run ls' }],
        max_tokens: 8,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const toolStarts = events.filter(
      e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].content_block as Record<string, string>).name).toBe('Bash')

    // finish_reason must NOT be remapped to 'tool_calls' for non-stop reasons
    const messageDelta = events.find(e => e.type === 'message_delta') as Record<string, unknown> | undefined
    const delta = messageDelta?.delta as Record<string, unknown> | undefined
    expect(delta?.stop_reason).not.toBe('tool_use')
  })

  test('buffered text is flushed when finish_reason is "content_filter"', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Text stopped by content filter'),
          ollamaChunk('', 'content_filter'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 8,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toContain('Text stopped by content filter')

    const messageDelta = events.find(e => e.type === 'message_delta') as Record<string, unknown> | undefined
    const delta = messageDelta?.delta as Record<string, unknown> | undefined
    expect(delta?.stop_reason).not.toBe('tool_use')
  })

  test('buffered text is flushed when finish_reason is "safety"', async () => {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('Text stopped by safety check'),
          ollamaChunk('', 'safety'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 8,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toContain('Text stopped by safety check')

    const messageDelta = events.find(e => e.type === 'message_delta') as Record<string, unknown> | undefined
    const delta = messageDelta?.delta as Record<string, unknown> | undefined
    expect(delta?.stop_reason).not.toBe('tool_use')
  })
})

describe('Ollama streaming — <tool_call>-wrapped JSON text fallback (#2040)', () => {
  let originalFetch: FetchType
  let restoreEnv: () => void
  beforeEach(() => {
    originalFetch = globalThis.fetch
    restoreEnv = snapshotEnv(ENV_KEYS)
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    restoreEnv()
  })

  test('Qwen-style <tool_call>{json}</tool_call> text becomes a tool_use block', async () => {
    // Repro: Ollama returns the model's template-format tool call (prose then
    // <tool_call>{json}</tool_call>) in message.content, not message.tool_calls.
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([
          ollamaChunk('I will build the project.\n<tool_call>\n'),
          ollamaChunk('{"name": "Bash", "arguments": {"command": "npm run build"}}\n'),
          ollamaChunk('</tool_call>'),
          ollamaChunk('', 'stop'),
        ]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5-coder:14b',
        messages: [{ role: 'user', content: 'build the project' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const allText = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'text_delta')
      .map(e => (e.delta as Record<string, string>).text)
      .join('')
    expect(allText).toBe('I will build the project.')

    const toolStarts = events.filter(
      e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use',
    )
    expect(toolStarts).toHaveLength(1)
    expect((toolStarts[0].content_block as Record<string, string>).name).toBe('Bash')
    const toolInput = events
      .filter(e => e.type === 'content_block_delta' && (e.delta as Record<string, string>)?.type === 'input_json_delta')
      .map(e => (e.delta as Record<string, string>).partial_json)
      .join('')
    expect(JSON.parse(toolInput)).toEqual({ command: 'npm run build' })

    const messageDelta = events.find(e => e.type === 'message_delta') as Record<string, unknown> | undefined
    expect((messageDelta?.delta as Record<string, unknown>)?.stop_reason).toBe('tool_use')
  })

  async function streamOllamaContent(content: string) {
    globalThis.fetch = (async () =>
      makeOllamaNativeStreamingResponse(
        makeNdjsonChunks([ollamaChunk(content), ollamaChunk('', 'stop')]),
      )) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'qwen2.5-coder:14b',
        messages: [{ role: 'user', content: 'go' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()

    const events: Record<string, unknown>[] = []
    for await (const event of result.data) events.push(event)

    const deltas = events
      .filter(e => e.type === 'content_block_delta')
      .map(e => e.delta as Record<string, string>)
    const messageDelta = events.find(e => e.type === 'message_delta') as Record<string, unknown> | undefined
    return {
      text: deltas.filter(d => d.type === 'text_delta').map(d => d.text).join(''),
      tools: events
        .filter(e => e.type === 'content_block_start' && (e.content_block as Record<string, string>)?.type === 'tool_use')
        .map(e => (e.content_block as Record<string, string>).name),
      inputs: deltas.filter(d => d.type === 'input_json_delta').map(d => JSON.parse(d.partial_json)),
      stopReason: (messageDelta?.delta as Record<string, unknown>)?.stop_reason,
    }
  }

  const xmlCall = (command: string) =>
    `<tool_call>{"name":"Bash","arguments":{"command":"${command}"}}</tool_call>`

  test.each([
    ['closed', `<think>I could call ${xmlCall('echo speculative')} but should ask first.</think>Please confirm the operation.`],
    ['unterminated', `Please confirm the operation. <think>I could call ${xmlCall('echo speculative')}`],
  ])('<tool_call> inside %s reasoning is not recovered as a tool call', async (_kind, content) => {
    const { text, tools, stopReason } = await streamOllamaContent(content)
    expect(text.trim()).toBe('Please confirm the operation.')
    expect(tools).toEqual([])
    expect(stopReason).toBe('end_turn')
  })

  test('only the visible <tool_call> is recovered when reasoning also contains one', async () => {
    const { text, tools, inputs, stopReason } = await streamOllamaContent(
      `<think>${xmlCall('echo private')}</think>${xmlCall('echo public')}`,
    )
    expect(text).toBe('')
    expect(tools).toEqual(['Bash'])
    expect(inputs).toEqual([{ command: 'echo public' }])
    expect(stopReason).toBe('tool_use')
  })

  test('think tags inside a visible call\'s arguments are kept verbatim', async () => {
    const args = { file_path: 'notes.md', content: 'a <think>keep</think> b' }
    const { text, tools, inputs, stopReason } = await streamOllamaContent(
      `<think>plan</think>Saving.\n<tool_call>${JSON.stringify({ name: 'Write', arguments: args })}</tool_call>`,
    )
    expect(text).toBe('Saving.')
    expect(tools).toEqual(['Write'])
    expect(inputs).toEqual([args])
    expect(stopReason).toBe('tool_use')
  })

  test('XML-looking text inside JSON arguments does not change the recovered tool', async () => {
    const command = "printf '%s' '<function=Read><parameter=file_path>README.md</parameter>'"
    const { text, tools, inputs, stopReason } = await streamOllamaContent(
      `Printing markup.\n<tool_call>${JSON.stringify({ name: 'Bash', arguments: { command } })}</tool_call>`,
    )
    expect(text).toBe('Printing markup.')
    expect(tools).toEqual(['Bash'])
    expect(inputs).toEqual([{ command }])
    expect(stopReason).toBe('tool_use')
  })

  test('a closing tag inside a labelled JSON envelope does not change the recovered tool', async () => {
    const args = {
      file_path: 'a.md',
      content: 'x</tool_call><tool_call><function=Bash><parameter=command>echo leaked</parameter></function></tool_call>y',
    }
    const { text, tools, inputs, stopReason } = await streamOllamaContent(
      `Saving.\n<tool_call>json\n${JSON.stringify({ name: 'Write', arguments: args })}</tool_call>`,
    )
    expect(text).toBe('Saving.')
    expect(tools).toEqual(['Write'])
    expect(inputs).toEqual([args])
    expect(stopReason).toBe('tool_use')
  })

  const nestedBash = '<tool_call><function=Bash><parameter=command>echo leaked</parameter></function></tool_call>'

  test.each([
    [
      'a hidden call argument contains a reasoning close tag',
      `<think><tool_call>${JSON.stringify({ name: 'Write', arguments: { file_path: 'a.md', content: `</think>${nestedBash}` } })}</tool_call></think>Please confirm.`,
    ],
    [
      'a visible opener without a body reaches into reasoning',
      `I'll use a <tool_call> block. <think>Maybe {"name":"Bash","arguments":{"command":"echo leaked"}}</think> Please confirm.`,
    ],
    [
      'an unterminated visible call is followed by reasoning',
      'Listing.\n<tool_call>\n<function=Bash>\n<parameter=command>\nls\n</parameter>\n</function>\n<think>else <parameter=command>echo leaked</parameter></think>',
    ],
    [
      'an opener mentioned in reasoning runs into a visible call',
      `<think>I'll emit a <tool_call> now.</think>\n<tool_call>${JSON.stringify({ name: 'Write', arguments: { file_path: 'n.md', content: 'a <think>keep</think> b' } })}</tool_call>`,
    ],
    [
      'a reasoning close tag is split around a hidden call',
      `<think>plan </<tool_call>${JSON.stringify({ name: 'Write', arguments: { file_path: 'a.md', content: 'x' } })}</tool_call>think>${xmlCall('echo leaked')}</think>Please confirm.`,
    ],
    [
      'a hidden block that is not a named call contains a reasoning close tag',
      `<think><tool_call>${JSON.stringify({ type: 'function', function: { name: 'Write', arguments: { content: '</think>' } } })}</tool_call>${nestedBash}</think>Please confirm.`,
    ],
    [
      'a reasoning open tag runs into the call opener',
      `<think${xmlCall('echo leaked')}</think>Please confirm.`,
    ],
    [
      'an unclosed reasoning tag containing `<` runs into the call opener',
      `Let me check.\n<thinking\nstep 1: if x<0\n${xmlCall('echo leaked')}\ndone`,
    ],
    [
      'removing reasoning splices a call the raw text did not contain',
      `<think>${xmlCall('echo private')}</think><tool_call>{"name":"Bash","arguments":{"command":"echo </tool_call><think>"x</think>; echo leaked"}}</tool_call>`,
    ],
    [
      'reasoning markup splits a visible call\'s function tag',
      `Running.\n${xmlCall('ls')}\n<tool_call><function<think>x</think>=Write><parameter=content>a <think>keep</think> b</parameter></function></tool_call>`,
    ],
  ])('no tool call is recovered when %s', async (_case, content) => {
    const { tools, stopReason } = await streamOllamaContent(content)
    expect(tools).toEqual([])
    expect(stopReason).toBe('end_turn')
  })
})
