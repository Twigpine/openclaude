import { afterEach, beforeEach, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../../test/sharedMutationLock.js'
import { createOpenAIShimClient } from '../openaiShim.js'
import {
  buildOllamaChatUrl,
  convertOllamaNonStreamingResponse,
  convertOllamaStreamingResponse,
  getOllamaNumCtx,
  normalizeOllamaNativeMessages,
} from './ollamaAdapter.js'

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  OPENCLAUDE_OLLAMA_NUM_CTX: process.env.OPENCLAUDE_OLLAMA_NUM_CTX,
  OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH,
}
const originalFetch = globalThis.fetch

beforeEach(async () => {
  await acquireSharedMutationLock('openaiShim-ollamaAdapter.test.ts')
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_MISTRAL
  delete process.env.OPENCLAUDE_OLLAMA_NUM_CTX
  delete process.env.OLLAMA_CONTEXT_LENGTH
})

afterEach(() => {
  try {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    globalThis.fetch = originalFetch
  } finally {
    releaseSharedMutationLock()
  }
})

type ShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function nativeResponse({
  content = 'hello from native Ollama',
  model = 'qwen2.5-coder:7b',
}: {
  content?: string
  model?: string
} = {}): Response {
  return new Response(JSON.stringify({
    model,
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 5,
    eval_count: 2,
  }), { headers: { 'Content-Type': 'application/json' } })
}

test('builds native URLs and selects the configured Ollama context length', () => {
  expect(buildOllamaChatUrl('http://localhost:11434/v1?token=secret')).toBe(
    'http://localhost:11434/api/chat',
  )
  expect(getOllamaNumCtx()).toBe(32768)
  process.env.OLLAMA_CONTEXT_LENGTH = '32768'
  expect(getOllamaNumCtx()).toBe(32768)
  process.env.OPENCLAUDE_OLLAMA_NUM_CTX = '65536'
  expect(getOllamaNumCtx()).toBe(65536)
  process.env.OPENCLAUDE_OLLAMA_NUM_CTX = 'invalid'
  expect(getOllamaNumCtx()).toBe(32768)
})

test('normalizes multipart messages, tool calls, and matching tool results', () => {
  expect(normalizeOllamaNativeMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'describe this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
      ],
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_read',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
      }],
    },
    {
      role: 'tool',
      content: 'contents',
      tool_call_id: 'call_read',
    },
  ])).toEqual([
    {
      role: 'user',
      content: 'describe this',
      images: ['aW1hZ2U='],
      tool_calls: undefined,
    },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
    },
    {
      role: 'tool',
      content: 'contents',
      tool_name: 'read_file',
      tool_calls: undefined,
    },
  ])

  expect(normalizeOllamaNativeMessages([{
    role: 'assistant',
    content: '',
    tool_calls: {},
  }])).toEqual([{
    role: 'assistant',
    content: '',
    tool_calls: undefined,
  }])
})

test('converts native non-streaming text and tool responses', async () => {
  const textResponse = await convertOllamaNonStreamingResponse(
    nativeResponse({ model: 'llama3', content: 'hello' }),
    'fallback',
    () => 'chatcmpl-text',
  )
  expect(await textResponse.json()).toMatchObject({
    id: 'chatcmpl-text',
    model: 'llama3',
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  })

  const toolResponse = await convertOllamaNonStreamingResponse(
    new Response(JSON.stringify({
      model: 'qwen2.5-coder:7b',
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }],
      },
      done: true,
      done_reason: 'stop',
    })),
    'fallback',
    () => 'chatcmpl-tool',
  )
  const toolBody = await toolResponse.json() as {
    choices?: Array<{
      finish_reason?: string
      message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }
    }>
  }
  expect(toolBody.choices?.[0]?.finish_reason).toBe('tool_calls')
  expect(toolBody.choices?.[0]?.message?.tool_calls?.[0]?.function).toEqual({
    name: 'read_file',
    arguments: JSON.stringify({ path: 'a.txt' }),
  })
})

test('converts native NDJSON streams to OpenAI SSE with tool finish and usage', async () => {
  const native = [
    JSON.stringify({ model: 'llama3', message: { content: 'hello' }, done: false }),
    JSON.stringify({
      model: 'llama3',
      message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.txt' } } }] },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 3,
      eval_count: 2,
    }),
  ].join('\n')
  const converted = convertOllamaStreamingResponse(
    new Response(native),
    'fallback',
    () => 'chatcmpl-stream',
  )
  const body = await converted.text()
  expect(body).toContain('data: [DONE]')
  expect(body).toContain('"content":"hello"')
  expect(body).toContain('"name":"read_file"')
  expect(body).toContain('"finish_reason":"tool_calls"')
  expect(body).toContain('"total_tokens":5')
})

test('uses native Ollama chat endpoint when local base URL omits /v1', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'
  const requestUrls: string[] = []
  globalThis.fetch = (async input => {
    requestUrls.push(typeof input === 'string' ? input : input.url)
    return nativeResponse()
  }) as unknown as typeof globalThis.fetch
  const client = createOpenAIShimClient({}) as unknown as ShimClient

  const message = await client.beta.messages.create({
    model: 'qwen2.5-coder:7b',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  }) as { content?: Array<{ type?: string; text?: string }> }

  expect(requestUrls).toEqual(['http://localhost:11434/api/chat'])
  expect(message.content?.[0]).toMatchObject({
    type: 'text',
    text: 'hello from native Ollama',
  })
})

test('uses max_tokens and request-level num_ctx for local Ollama', async () => {
  let requestUrl = ''
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    requestUrl = typeof input === 'string' ? input : input.url
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'hello' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 5,
      eval_count: 1,
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  const client = createOpenAIShimClient({}) as unknown as ShimClient

  await client.beta.messages.create({
    model: 'llama3.1:8b',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestUrl).toBe('http://localhost:11434/api/chat')
  expect(requestBody?.options).toMatchObject({ num_predict: 64, num_ctx: 32768 })
  expect(requestBody?.stream_options).toBeUndefined()
})

test('the façade sends native tool names and preserves streaming tool finish', async () => {
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    const native = [
      JSON.stringify({
        model: 'qwen2.5-coder:7b',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'Write', arguments: { file_path: 'out.txt', content: 'ok' } } }],
        },
        done: true,
        done_reason: 'stop',
      }),
    ].join('\n')
    return new Response(native, { headers: { 'Content-Type': 'application/x-ndjson' } })
  }) as unknown as typeof globalThis.fetch
  const client = createOpenAIShimClient({}) as unknown as ShimClient

  const result = await client.beta.messages.create({
    model: 'qwen2.5-coder:7b',
    messages: [
      { role: 'user', content: 'read a file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_read', name: 'Read', input: { file_path: 'a.txt' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_read', content: 'contents' }],
      },
    ],
    max_tokens: 64,
    stream: true,
  }).withResponse()
  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) events.push(event)

  const nativeMessages = requestBody?.messages as Array<Record<string, unknown>>
  expect(nativeMessages.find(message => message.role === 'tool')).toMatchObject({
    role: 'tool',
    content: 'contents',
    tool_name: 'Read',
  })
  expect(nativeMessages.find(message => message.role === 'tool')?.tool_call_id).toBeUndefined()
  expect(events.find(event => event.type === 'content_block_start')).toMatchObject({
    content_block: { type: 'tool_use', name: 'Write' },
  })
  expect(events.find(event => event.type === 'message_delta')).toMatchObject({
    delta: { stop_reason: 'tool_use' },
  })
})
