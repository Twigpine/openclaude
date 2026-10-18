import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'
import { _clearRegistryForTesting, ensureIntegrationsLoaded, registerGateway } from '../../integrations/index.ts'
import { applyProviderFlag } from '../../utils/providerFlag.ts'
import { applyProviderProfileToProcessEnv } from '../../utils/providerProfiles.ts'
import {
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../../utils/interruptionTrace.js'
import {
  getAssistantMessageFromError,
  OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE,
} from './errors.ts'
import { accumulateUsage, updateUsage } from './claude.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import {
  extractOpenAICategoryMarker,
  isOpenAIRequestNonReplayable,
} from './openaiErrorClassification.ts'
import {
  createOpenAIShimClient,
  hasMistralApiHost,
  parseTextToolCalls,
  parseXmlToolCalls,
} from './openaiShim.ts'
import * as realGithubModelsCredentials from '../../utils/githubModelsCredentials.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import type { AssistantMessage } from '../../types/message.js'

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_AZURE_STYLE: process.env.OPENAI_AZURE_STYLE,
  OPENAI_AUTH_HEADER: process.env.OPENAI_AUTH_HEADER,
  OPENAI_AUTH_SCHEME: process.env.OPENAI_AUTH_SCHEME,
  OPENAI_AUTH_HEADER_VALUE: process.env.OPENAI_AUTH_HEADER_VALUE,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  GITHUB_COPILOT_KEY: process.env.GITHUB_COPILOT_KEY,
  GITHUB_ENTERPRISE_URL: process.env.GITHUB_ENTERPRISE_URL,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  GH_TOKEN: process.env.GH_TOKEN,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_ACCESS_TOKEN: process.env.GEMINI_ACCESS_TOKEN,
  GEMINI_AUTH_MODE: process.env.GEMINI_AUTH_MODE,
  GEMINI_BASE_URL: process.env.GEMINI_BASE_URL,
  GEMINI_MODEL: process.env.GEMINI_MODEL,
  GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT,
  ANTHROPIC_CUSTOM_HEADERS: process.env.ANTHROPIC_CUSTOM_HEADERS,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_NIM: process.env.NVIDIA_NIM,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  BNKR_API_KEY: process.env.BNKR_API_KEY,
  BANKR_BASE_URL: process.env.BANKR_BASE_URL,
  BANKR_MODEL: process.env.BANKR_MODEL,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  MIMO_API_KEY: process.env.MIMO_API_KEY,
  LONGCAT_API_KEY: process.env.LONGCAT_API_KEY,
  CLINE_API_KEY: process.env.CLINE_API_KEY,
  GMI_API_KEY: process.env.GMI_API_KEY,
  OPENGATEWAY_API_KEY: process.env.OPENGATEWAY_API_KEY,
  OPENGATEWAY_BASE_URL: process.env.OPENGATEWAY_BASE_URL,
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
  API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
}

const originalFetch = globalThis.fetch

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown> & {
        withResponse: () => Promise<{ data: AsyncIterable<Record<string, unknown>> }>
      }
    }
  }
}

function makeSseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
      },
    },
  )
}

function withResponseUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', {
    value: url,
    configurable: true,
  })
  return response
}

type StallingResponse = {
  response: Response
  cancelReasons: unknown[]
  close: () => void
}

function makeStallingResponse(
  firstChunk: string,
  url = 'https://api.example.test/v1/chat/completions',
  contentType = 'text/event-stream',
): StallingResponse {
  const encoder = new TextEncoder()
  const cancelReasons: unknown[] = []
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false

  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
        controller.enqueue(encoder.encode(firstChunk))
      },
      cancel(reason) {
        closed = true
        cancelReasons.push(reason)
      },
    }),
    {
      headers: {
        'Content-Type': contentType,
      },
    },
  )

  return {
    response: withResponseUrl(response, url),
    cancelReasons,
    close: () => {
      if (closed) return
      closed = true
      try {
        streamController?.close()
      } catch {
        // The test may already have cancelled the stream.
      }
    },
  }
}

type ShimStream = AsyncIterable<Record<string, unknown>> & {
  controller: AbortController
}

type StreamDrainOutcome =
  | { status: 'completed'; events: Array<Record<string, unknown>> }
  | {
    status: 'rejected'
    events: Array<Record<string, unknown>>
    error: unknown
  }

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

async function expectAbortStopsStream({
  abort,
  cancelReasons,
  expectedEventsBeforeAbort,
  label,
  stream,
}: {
  abort: () => void
  cancelReasons: unknown[]
  expectedEventsBeforeAbort: number
  label: string
  stream: ShimStream
}): Promise<StreamDrainOutcome> {
  const events: Array<Record<string, unknown>> = []
  let resolveReady!: () => void
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve
  })

  const drain = (async (): Promise<StreamDrainOutcome> => {
    try {
      for await (const event of stream) {
        events.push(event)
        if (events.length >= expectedEventsBeforeAbort) {
          resolveReady()
        }
      }
      return { status: 'completed', events }
    } catch (error) {
      return { status: 'rejected', events, error }
    }
  })()

  await waitForPromise(
    ready,
    500,
    `${label} did not produce initial stream events`,
  )
  // Let the for-await loop ask the stream reader for the next chunk, so the
  // abort has to wake a real pending read rather than only flipping a flag.
  await Promise.resolve()
  await Promise.resolve()

  abort()

  const outcome = await waitForPromise(
    drain,
    500,
    `${label} did not stop promptly after abort`,
  )
  expect(cancelReasons).toHaveLength(1)
  expect(outcome.status).toBe('rejected')
  if (outcome.status === 'rejected') {
    expect((outcome.error as { name?: unknown }).name).toBe('AbortError')
  }
  return outcome
}

async function expectPausedAbortCancelsStream({
  cancelReasons,
  label,
  stream,
}: {
  cancelReasons: unknown[]
  label: string
  stream: ShimStream
}): Promise<IteratorResult<Record<string, unknown>>> {
  const iterator = stream[Symbol.asyncIterator]()
  const first = await waitForPromise(
    iterator.next(),
    500,
    `${label} did not produce first stream event`,
  )
  expect(first.done).toBe(false)

  stream.controller.abort()
  await waitForPromise(
    (async () => {
      for (let i = 0; i < 10; i++) {
        if (cancelReasons.length > 0) return
        await Promise.resolve()
      }
      throw new Error(`${label} did not cancel source on controller abort`)
    })(),
    500,
    `${label} did not cancel source on controller abort`,
  )

  const returned = await waitForPromise(
    Promise.resolve(iterator.return?.()),
    500,
    `${label} did not return promptly after abort while paused`,
  )
  expect(cancelReasons).toHaveLength(1)
  return returned as IteratorResult<Record<string, unknown>>
}

async function expectBufferedAbortRejectsNext({
  expectedText,
  label,
  stream,
}: {
  expectedText?: string
  label: string
  stream: ShimStream
}): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]()

  try {
    let firstDelta: Record<string, unknown> | undefined
    for (let i = 0; i < 5; i++) {
      const next = await waitForPromise(
        iterator.next(),
        500,
        `${label} did not produce expected pre-abort events`,
      )
      expect(next.done).toBe(false)
      if (next.value?.type === 'content_block_delta') {
        firstDelta = next.value
        break
      }
    }

    expect(firstDelta).toBeDefined()
    if (expectedText !== undefined) {
      expect((firstDelta as { delta?: { text?: string } }).delta?.text).toBe(expectedText)
    }

    stream.controller.abort()
    const afterAbort = await waitForPromise(
      iterator.next().then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      500,
      `${label} did not stop after abort`,
    )

    if (afterAbort.status !== 'rejected') {
      throw new Error(`${label} yielded after abort: ${JSON.stringify(afterAbort.value)}`)
    }
    expect((afterAbort.error as { name?: unknown }).name).toBe('AbortError')
  } finally {
    await Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

function makeOpenAIStreamFrame(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-abort-test',
    object: 'chat.completion.chunk',
    created: 1_780_000_000,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function makeStreamChunks(chunks: unknown[]): string[] {
  return [
    ...chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`),
    'data: [DONE]\n\n',
  ]
}

function importFreshOpenAIShim(
  cacheKey: string,
): Promise<typeof import('./openaiShim.ts')> {
  return import(`./openaiShim.ts?${cacheKey}`)
}

type StreamIdleTestApi = {
  StreamIdleTimeoutError: new (timeoutMs: number) => Error
  getStreamIdleTimeoutMs: () => number
  readWithIdleTimeout: (
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    options?: { signal?: AbortSignal; onTimeout?: () => void },
  ) => Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>>
}

async function getStreamIdleTestApi(cacheKey: string): Promise<StreamIdleTestApi> {
  const mod = await importFreshOpenAIShim(cacheKey)
  const testApi = mod.__test as unknown as Partial<StreamIdleTestApi>
  expect(typeof testApi.StreamIdleTimeoutError).toBe('function')
  expect(typeof testApi.getStreamIdleTimeoutMs).toBe('function')
  expect(typeof testApi.readWithIdleTimeout).toBe('function')
  return testApi as StreamIdleTestApi
}

function makeChatCompletionResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      model,
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'ok',
          },
          finish_reason: 'stop',
        },
      ],
    }),
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  )
}

function makeGithubChatFallbackResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { message: '/chat/completions is not accessible for this model' },
    }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  )
}

function makeResponsesApiResponse(model: string): Response {
  return new Response(
    JSON.stringify({
      id: 'resp-fallback-test',
      model,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

function pendingFetchUntilAbort(
  init: RequestInit | undefined,
): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) return

    const rejectFromAbort = () => {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', rejectFromAbort, { once: true })
    if (signal.aborted) rejectFromAbort()
  })
}

async function captureChatCompletionRequest(
  model = 'mimo-v2.5-pro',
): Promise<{ authorization: string | null; url: string | null }> {
  let authorization: string | null = null
  let url: string | null = null

  globalThis.fetch = (async (input, init) => {
    url = String(input)
    const headers = init?.headers as Record<string, string> | undefined
    authorization = headers?.Authorization ?? headers?.authorization ?? null

    return makeChatCompletionResponse(model)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  return { authorization, url }
}

beforeEach(async () => {
  await acquireSharedMutationLock('openaiShim.test.ts')
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_FORMAT
  delete process.env.OPENAI_AZURE_STYLE
  delete process.env.OPENAI_AUTH_HEADER
  delete process.env.OPENAI_AUTH_SCHEME
  delete process.env.OPENAI_AUTH_HEADER_VALUE
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_COPILOT_KEY
  delete process.env.GITHUB_ENTERPRISE_URL
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.GEMINI_ACCESS_TOKEN
  delete process.env.GEMINI_AUTH_MODE
  delete process.env.GEMINI_BASE_URL
  delete process.env.GEMINI_MODEL
  delete process.env.GOOGLE_CLOUD_PROJECT
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.NVIDIA_API_KEY
  delete process.env.NVIDIA_NIM
  delete process.env.MINIMAX_API_KEY
  delete process.env.BNKR_API_KEY
  delete process.env.BANKR_BASE_URL
  delete process.env.BANKR_MODEL
  delete process.env.OPENROUTER_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.CLINE_API_KEY
  delete process.env.GMI_API_KEY
  delete process.env.OPENGATEWAY_API_KEY
  delete process.env.OPENGATEWAY_BASE_URL
  delete process.env.OPENCODE_API_KEY
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  delete process.env.API_TIMEOUT_MS
})

afterEach(() => {
  try {
    mock.restore()
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_API_KEYS', originalEnv.OPENAI_API_KEYS)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
    restoreEnv('OPENAI_API_FORMAT', originalEnv.OPENAI_API_FORMAT)
    restoreEnv('OPENAI_AZURE_STYLE', originalEnv.OPENAI_AZURE_STYLE)
    restoreEnv('OPENAI_AUTH_HEADER', originalEnv.OPENAI_AUTH_HEADER)
    restoreEnv('OPENAI_AUTH_SCHEME', originalEnv.OPENAI_AUTH_SCHEME)
    restoreEnv('OPENAI_AUTH_HEADER_VALUE', originalEnv.OPENAI_AUTH_HEADER_VALUE)
    restoreEnv('CLAUDE_CODE_USE_GITHUB', originalEnv.CLAUDE_CODE_USE_GITHUB)
    restoreEnv('GITHUB_COPILOT_KEY', originalEnv.GITHUB_COPILOT_KEY)
    restoreEnv('GITHUB_ENTERPRISE_URL', originalEnv.GITHUB_ENTERPRISE_URL)
    restoreEnv('GITHUB_TOKEN', originalEnv.GITHUB_TOKEN)
    restoreEnv('GH_TOKEN', originalEnv.GH_TOKEN)
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('CLAUDE_CODE_USE_GEMINI', originalEnv.CLAUDE_CODE_USE_GEMINI)
    restoreEnv('GEMINI_API_KEY', originalEnv.GEMINI_API_KEY)
    restoreEnv('GOOGLE_API_KEY', originalEnv.GOOGLE_API_KEY)
    restoreEnv('GEMINI_ACCESS_TOKEN', originalEnv.GEMINI_ACCESS_TOKEN)
    restoreEnv('GEMINI_AUTH_MODE', originalEnv.GEMINI_AUTH_MODE)
    restoreEnv('GEMINI_BASE_URL', originalEnv.GEMINI_BASE_URL)
    restoreEnv('GEMINI_MODEL', originalEnv.GEMINI_MODEL)
    restoreEnv('GOOGLE_CLOUD_PROJECT', originalEnv.GOOGLE_CLOUD_PROJECT)
    restoreEnv('ANTHROPIC_CUSTOM_HEADERS', originalEnv.ANTHROPIC_CUSTOM_HEADERS)
    restoreEnv('NVIDIA_API_KEY', originalEnv.NVIDIA_API_KEY)
    restoreEnv('NVIDIA_NIM', originalEnv.NVIDIA_NIM)
    restoreEnv('MINIMAX_API_KEY', originalEnv.MINIMAX_API_KEY)
    restoreEnv('BNKR_API_KEY', originalEnv.BNKR_API_KEY)
    restoreEnv('BANKR_BASE_URL', originalEnv.BANKR_BASE_URL)
    restoreEnv('BANKR_MODEL', originalEnv.BANKR_MODEL)
    restoreEnv('OPENROUTER_API_KEY', originalEnv.OPENROUTER_API_KEY)
    restoreEnv('DEEPSEEK_API_KEY', originalEnv.DEEPSEEK_API_KEY)
    restoreEnv('MIMO_API_KEY', originalEnv.MIMO_API_KEY)
    restoreEnv('LONGCAT_API_KEY', originalEnv.LONGCAT_API_KEY)
    restoreEnv('CLINE_API_KEY', originalEnv.CLINE_API_KEY)
    restoreEnv('GMI_API_KEY', originalEnv.GMI_API_KEY)
    restoreEnv('OPENGATEWAY_API_KEY', originalEnv.OPENGATEWAY_API_KEY)
    restoreEnv('OPENGATEWAY_BASE_URL', originalEnv.OPENGATEWAY_BASE_URL)
    restoreEnv('OPENCODE_API_KEY', originalEnv.OPENCODE_API_KEY)
    restoreEnv('CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED', originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED)
    restoreEnv('CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID', originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID)
    restoreEnv('CLAUDE_STREAM_IDLE_TIMEOUT_MS', originalEnv.CLAUDE_STREAM_IDLE_TIMEOUT_MS)
    restoreEnv('API_TIMEOUT_MS', originalEnv.API_TIMEOUT_MS)
    globalThis.fetch = originalFetch
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  } finally {
    releaseSharedMutationLock()
  }
})
// openaiShim test extraction seam 003 end

test('auto-routes gpt-5.6 to /responses on api.openai.com with tools and nested reasoning', async () => {
  // No OPENAI_API_FORMAT set: the model+base predicate must pick responses.
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'high' }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the weather',
        input_schema: {
          type: 'object',
          properties: { location: { type: 'string' } },
          required: ['location'],
        },
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.openai.com/v1/responses')
  expect(Array.isArray(capturedBody?.tools)).toBe(true)
  expect((capturedBody?.tools as unknown[]).length).toBe(1)
  expect(JSON.stringify(capturedBody?.tools)).toContain('get_weather')
  expect(capturedBody?.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  expect(capturedBody).not.toHaveProperty('reasoning_effort')
})

test('gpt-5.6 chat-completions escape hatch omits reasoning effort with tools', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_API_FORMAT = 'chat_completions'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5.6-sol',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'high' }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: { type: 'object', properties: {} },
    }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions')
  expect(capturedBody?.tools).toBeDefined()
  expect(capturedBody).not.toHaveProperty('reasoning_effort')
})

test('gpt-5.4 chat-completions escape hatch omits reasoning effort with tools', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_API_FORMAT = 'chat_completions'
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      id: 'chatcmpl-1', model: 'gpt-5.4',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'high' }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'get_weather', description: 'Get the weather', input_schema: { type: 'object', properties: {} } }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedBody).not.toHaveProperty('reasoning_effort')
})

test('gpt-5.6 chat-completions escape hatch keeps reasoning effort without tools', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_API_FORMAT = 'chat_completions'
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5.6-sol',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'high' }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedBody?.reasoning_effort).toBe('high')
})

test('auto-route leaves non gpt-5.4+ models on chat/completions', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://api.openai.com/v1/chat/completions')
})

test('auto-route does NOT fire for arbitrary non-OpenAI gateway bases', async () => {
  process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5.6-sol',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://gateway.example/v1/chat/completions')
})

test('auto-routed responses on a bare Azure resource base normalizes to the v1 surface', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-terra',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('auto-routed responses on the Azure v1 base appends /responses without rewriting the path', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-luna',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-luna',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('Azure responses URL normalization drops a configured query string', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1?api-version=2024-12-01-preview'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({
      id: 'resp-1', model: 'gpt-5.6-sol',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('Azure responses URL normalization drops a query string after a trailing slash', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1/?api-version=2024-12-01-preview'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({
      id: 'resp-1', model: 'gpt-5.6-sol',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('Azure chat-completions URL normalization drops a configured query string', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1?api-version=2024-12-01-preview'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_API_FORMAT = 'chat_completions'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({
      id: 'chatcmpl-1', model: 'gpt-5.6-sol',
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, stream: false })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/deployments/gpt-5.6-sol/chat/completions?api-version=2024-12-01-preview')
})

test('auto-routed responses on an Azure /deployments/ base strips the deployment and uses the v1 surface', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/deployments/my-gpt56'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('OPENAI_AZURE_STYLE routes gpt-5.6 on a custom base to {base}/openai/v1/responses', async () => {
  process.env.OPENAI_BASE_URL = 'https://apim.contoso.example/azure-openai'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_AZURE_STYLE = '1'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://apim.contoso.example/azure-openai/openai/v1/responses')
})

test('Azure responses URL normalization strips stacked v1 and deployment suffixes', async () => {
  process.env.OPENAI_BASE_URL =
    'https://myres.openai.azure.com/openai/deployments/my-gpt56/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-terra',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-terra',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
})

test('explicit OPENAI_API_FORMAT=responses works for arbitrary Azure deployment names', async () => {
  // Azure deployment names are arbitrary, so the model-name auto-route cannot
  // recognize them; the documented path is the explicit responses format.
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  process.env.OPENAI_API_FORMAT = 'responses'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'production-coding',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'production-coding',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe('https://myres.openai.azure.com/openai/v1/responses')
  expect(capturedBody?.model).toBe('production-coding')
})

test('arbitrary Azure deployment names stay on chat/completions without the explicit format', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''

  globalThis.fetch = (async (input, _init) => {
    capturedUrl = String(input)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'production-coding',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'production-coding',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl).toBe(
    'https://myres.openai.azure.com/openai/deployments/production-coding/chat/completions?api-version=2024-12-01-preview',
  )
})

test('auto-routed gpt-5.6 on an Azure base nests reasoning.effort and the encrypted-content include', async () => {
  process.env.OPENAI_BASE_URL = 'https://myres.openai.azure.com/openai/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  let capturedUrl = ''
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (input, init) => {
    capturedUrl = String(input)
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.6-sol',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ reasoningEffort: 'high' }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(capturedUrl.endsWith('/openai/v1/responses')).toBe(true)
  expect(capturedBody?.reasoning).toEqual({ effort: 'high', summary: 'auto' })
  expect(capturedBody?.include).toEqual(['reasoning.encrypted_content'])
})
// openaiShim test extraction seam 004 end


// openaiShim test extraction seam 005 start: uses correct empty input fallback schema for standard responses and responses_compat
test('uses correct empty input fallback schema for standard responses and responses_compat', async () => {
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(JSON.stringify({
      id: 'resp-1',
      model: 'test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  process.env.OPENAI_API_FORMAT = 'responses'
  await client.beta.messages.create({
    model: 'test',
    max_tokens: 10,
    messages: [{ role: 'user', content: [] }],
  })

  expect(capturedBody?.input).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '' }],
    },
  ])

  process.env.OPENAI_API_FORMAT = 'responses_compat'
  await client.beta.messages.create({
    model: 'test',
    max_tokens: 10,
    messages: [{ role: 'user', content: [] }],
  })

  expect(capturedBody?.input).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: '' }],
    },
  ])
})
// openaiShim test extraction seam 020 end


// openaiShim test extraction seam 021 start: preserves usage from final OpenAI stream chunk with empty choices
test('preserves usage from final OpenAI stream chunk with empty choices', async () => {
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:8000/v1'
  globalThis.fetch = (async (_input, init) => {
    const url = typeof _input === 'string' ? _input : _input.url
    expect(url).toBe('http://127.0.0.1:8000/v1/chat/completions')

    const body = JSON.parse(String(init?.body))
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })

    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello world' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [],
        usage: {
          prompt_tokens: 123,
          completion_tokens: 45,
          total_tokens: 168,
          prompt_tokens_details: { cached_tokens: 23 },
        },
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const usageEvents = events.filter(
    event => event.type === 'message_delta' && typeof event.usage === 'object' && event.usage !== null,
  ) as Array<{
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
    }
  }>

  expect(usageEvents).toHaveLength(1)
  expect(usageEvents[0]?.usage?.input_tokens).toBe(100)
  expect(usageEvents[0]?.usage?.output_tokens).toBe(45)
  expect(usageEvents[0]?.usage?.cache_read_input_tokens).toBe(23)

  let currentUsage = EMPTY_USAGE
  let totalUsage = EMPTY_USAGE
  for (const event of events) {
    if (event.type === 'message_start') {
      const message = event.message as {
        usage?: Parameters<typeof updateUsage>[1]
      }
      currentUsage = updateUsage(EMPTY_USAGE, message.usage)
    } else if (event.type === 'message_delta') {
      currentUsage = updateUsage(
        currentUsage,
        event.usage as Parameters<typeof updateUsage>[1],
      )
    } else if (event.type === 'message_stop') {
      totalUsage = accumulateUsage(totalUsage, currentUsage)
    }
  }

  expect(events.filter(event => event.type === 'message_stop')).toHaveLength(1)
  expect(totalUsage).toMatchObject({
    input_tokens: 100,
    output_tokens: 45,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 23,
  })

  const accountedMessage = {
    type: 'assistant',
    uuid: '00000000-0000-0000-0000-000000000213',
    timestamp: '2026-08-19T00:00:00.000Z',
    message: {
      id: 'msg_local_usage',
      type: 'message',
      role: 'assistant',
      model: 'fake-model',
      content: [{ type: 'text', text: 'hello world' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: currentUsage,
    },
  } as unknown as AssistantMessage
  expect(tokenCountWithEstimation([accountedMessage])).toBe(168)
})
// openaiShim test extraction seam 021 end


// Extraction seam: stream conversion usage | shared stream control.

// openaiShim test extraction seam 022 start: readWithIdleTimeout rejects quickly and cancels a stalled reader
test('readWithIdleTimeout rejects quickly and cancels a stalled reader', async () => {
  const testApi = await getStreamIdleTestApi('stream-idle-helper')
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  const startedAt = Date.now()
  let caught: unknown
  try {
    await testApi.readWithIdleTimeout(reader, 20)
  } catch (error) {
    caught = error
  }

  expect(Date.now() - startedAt).toBeLessThan(500)
  expect(caught).toBeInstanceOf(testApi.StreamIdleTimeoutError)
  expect((caught as Error).name).toBe('StreamIdleTimeoutError')
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(testApi.StreamIdleTimeoutError)
})
// openaiShim test extraction seam 022 end


// openaiShim test extraction seam 023 start: readWithIdleTimeout preserves parent abort instead of reporting idle timeout
test('readWithIdleTimeout preserves parent abort instead of reporting idle timeout', async () => {
  const testApi = await getStreamIdleTestApi('stream-idle-user-abort')
  const parent = new AbortController()
  const cancelReasons: unknown[] = []
  const reader = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelReasons.push(reason)
    },
  }).getReader()

  const read = testApi.readWithIdleTimeout(reader, 1_000, {
    signal: parent.signal,
  })
  parent.abort()

  let caught: unknown
  try {
    await read
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(DOMException)
  expect((caught as DOMException).name).toBe('AbortError')
  expect(cancelReasons).toHaveLength(1)
  expect(cancelReasons[0]).toBeInstanceOf(DOMException)
  expect((cancelReasons[0] as DOMException).name).toBe('AbortError')
})
// openaiShim test extraction seam 023 end


// openaiShim test extraction seam 024 start: stream idle timeout env parser parses and bounds overrides
test('stream idle timeout env parser parses and bounds overrides', async () => {
  const testApi = await getStreamIdleTestApi('stream-idle-env-parser')

  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
  expect(testApi.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(25)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = ' 25 '
  expect(testApi.getStreamIdleTimeoutMs()).toBe(25)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '3000000000'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(2_147_483_647)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '9007199254740993'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25ms'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '0'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(90_000)

  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '-5'
  expect(testApi.getStreamIdleTimeoutMs()).toBe(90_000)
})
// openaiShim test extraction seam 024 end

// openaiShim test extraction seam 025 start: Anthropic-compatible passthrough stream rejects with idle timeout when it stalls
test('Anthropic-compatible passthrough stream rejects with idle timeout when it stalls', async () => {
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_idle_passthrough',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'passthrough-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  let caught: unknown
  try {
    for await (const _event of result.data) {
      // drain until the stalled reader times out
    }
  } catch (error) {
    caught = error
  } finally {
    stalled.close()
  }

  expect((caught as Error).name).toBe('StreamIdleTimeoutError')
  expect((stalled.cancelReasons[0] as Error).name).toBe('StreamIdleTimeoutError')
})
// openaiShim test extraction seam 025 end


// Extraction seam: shared stream control | Gemini stream conversion.

// openaiShim test extraction seam 026 start: Gemini SSE stream rejects with idle timeout when it stalls
test('Gemini SSE stream rejects with idle timeout when it stalls', async () => {
  process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '25'
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'partial' }],
          },
        },
      ],
    })}\n\n`,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'google/gemini-2.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  let caught: unknown
  try {
    for await (const _event of result.data) {
      // drain until the stalled reader times out
    }
  } catch (error) {
    caught = error
  } finally {
    stalled.close()
  }

  expect((caught as Error).name).toBe('StreamIdleTimeoutError')
  expect((stalled.cancelReasons[0] as Error).name).toBe('StreamIdleTimeoutError')
})
// openaiShim test extraction seam 028 end


// openaiShim test extraction seam 029 start: controller abort reaches generic OpenAI SSE converter
test('controller abort reaches generic OpenAI SSE converter', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'generic OpenAI SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 029 end


// openaiShim test extraction seam 030 start: controller abort cancels generic OpenAI SSE before iteration starts
test('controller abort cancels generic OpenAI SSE before iteration starts', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    stream.controller.abort()
    await waitForPromise(
      (async () => {
        for (let i = 0; i < 10; i++) {
          if (stalled.cancelReasons.length > 0) return
          await Promise.resolve()
        }
        throw new Error('pre-iteration OpenAI SSE stream did not cancel source')
      })(),
      500,
      'pre-iteration OpenAI SSE stream did not cancel source',
    )
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 030 end


// openaiShim test extraction seam 031 start: controller abort cancels generic OpenAI SSE when paused after message_start
test('controller abort cancels generic OpenAI SSE when paused after message_start', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectPausedAbortCancelsStream({
      cancelReasons: stalled.cancelReasons,
      label: 'paused generic OpenAI SSE stream',
      stream,
    })
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 031 end


// openaiShim test extraction seam 032 start: controller abort stops buffered generic OpenAI SSE events
test('controller abort stops buffered generic OpenAI SSE events', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'first' }) +
      makeOpenAIStreamFrame({ content: 'second' }),
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectBufferedAbortRejectsNext({
      expectedText: 'first',
      label: 'buffered generic OpenAI SSE stream',
      stream,
    })
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 032 end


// openaiShim test extraction seam 033 start: controller abort reaches Anthropic messages SSE passthrough
test('controller abort reaches Anthropic messages SSE passthrough', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_passthrough_abort',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'passthrough-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 1,
      label: 'Anthropic messages passthrough stream',
      stream,
    })

    expect(outcome.events[0]?.type).toBe('message_start')
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 033 end


// openaiShim test extraction seam 034 start: controller abort cancels Anthropic messages SSE when paused after event
test('controller abort cancels Anthropic messages SSE when paused after event', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: 'msg_paused_passthrough_abort',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'passthrough-model',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })}\n\n`,
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectPausedAbortCancelsStream({
      cancelReasons: stalled.cancelReasons,
      label: 'paused Anthropic messages passthrough stream',
      stream,
    })
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 034 end


// openaiShim test extraction seam 035 start: controller abort stops buffered Anthropic messages SSE events
test('controller abort stops buffered Anthropic messages SSE events', async () => {
  const stalled = makeStallingResponse(
    [
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_buffered_passthrough_abort',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'passthrough-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}`,
      '',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}`,
      '',
      '',
    ].join('\n'),
    'https://api.anthropic-shaped.example.com/v1/messages',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'passthrough-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream
  const iterator = stream[Symbol.asyncIterator]()

  try {
    const first = await waitForPromise(
      iterator.next(),
      500,
      'buffered Anthropic messages passthrough did not produce first event',
    )
    expect(first.done).toBe(false)
    expect(first.value?.type).toBe('message_start')

    stream.controller.abort()
    const afterAbort = await waitForPromise(
      iterator.next().then(
        value => ({ status: 'resolved' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      ),
      500,
      'buffered Anthropic messages passthrough did not stop after abort',
    )

    if (afterAbort.status !== 'rejected') {
      throw new Error(`buffered Anthropic messages passthrough yielded after abort: ${JSON.stringify(afterAbort.value)}`)
    }
    expect((afterAbort.error as { name?: unknown }).name).toBe('AbortError')
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    await Promise.resolve(iterator.return?.()).catch(() => {})
    stalled.close()
  }
})
// openaiShim test extraction seam 035 end


// openaiShim test extraction seam 036 start: parent signal abort still reaches OpenAI SSE converter
test('parent signal abort still reaches OpenAI SSE converter', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )
  const parent = new AbortController()

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create(
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      },
      { signal: parent.signal },
    )
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => parent.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'parent-aborted OpenAI SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 036 end


// openaiShim test extraction seam 037 start: parent signal abort cancels OpenAI SSE before iteration starts
test('parent signal abort cancels OpenAI SSE before iteration starts', async () => {
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'partial' }),
  )
  const parent = new AbortController()

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create(
      {
        model: 'fake-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      },
      { signal: parent.signal },
    )
    .withResponse()
  expect(result.data).toBeDefined()

  try {
    parent.abort()
    await waitForPromise(
      (async () => {
        for (let i = 0; i < 10; i++) {
          if (stalled.cancelReasons.length > 0) return
          await Promise.resolve()
        }
        throw new Error('pre-iteration parent-aborted OpenAI SSE stream did not cancel source')
      })(),
      500,
      'pre-iteration parent-aborted OpenAI SSE stream did not cancel source',
    )
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 037 end


// openaiShim test extraction seam 038 start: controller abort reaches Codex responses stream converter
test('controller abort reaches Codex responses stream converter', async () => {
  const stalled = makeStallingResponse(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'partial' })}\n\n`,
    'https://api.example.test/v1/responses',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'Codex responses stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 038 end


// openaiShim test extraction seam 039 start: controller abort cancels Codex responses stream when paused after message_start
test('controller abort cancels Codex responses stream when paused after message_start', async () => {
  const stalled = makeStallingResponse(
    `event: response.output_text.delta\ndata: ${JSON.stringify({ delta: 'partial' })}\n\n`,
    'https://api.example.test/v1/responses',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-5.4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectPausedAbortCancelsStream({
      cancelReasons: stalled.cancelReasons,
      label: 'paused Codex responses stream',
      stream,
    })
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 039 end


// openaiShim test extraction seam 040 start: controller abort reaches Gemini SSE converter
test('controller abort reaches Gemini SSE converter', async () => {
  const stalled = makeStallingResponse(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'partial' }],
          },
        },
      ],
    })}\n\n`,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 3,
      label: 'Gemini SSE stream',
      stream,
    })

    expect(outcome.events.some(event => event.type === 'content_block_delta')).toBe(true)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 040 end


// openaiShim test extraction seam 041 start: controller abort stops buffered Gemini SSE events
test('controller abort stops buffered Gemini SSE events', async () => {
  const makeGeminiFrame = (text: string) =>
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text }],
          },
        },
      ],
    })}\n\n`
  const stalled = makeStallingResponse(
    makeGeminiFrame('first') + makeGeminiFrame('second'),
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
  )

  globalThis.fetch = (async () => stalled.response) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()
  const stream = result.data as unknown as ShimStream

  try {
    await expectBufferedAbortRejectsNext({
      expectedText: 'first',
      label: 'buffered Gemini SSE stream',
      stream,
    })
    expect(stalled.cancelReasons).toHaveLength(1)
  } finally {
    stalled.close()
  }
})
// openaiShim test extraction seam 041 end


// Extraction seam: Gemini stream conversion | native Ollama stream adaptation.

// openaiShim test extraction seam 042 start: controller abort reaches native Ollama converted stream
test('controller abort reaches native Ollama converted stream', async () => {
  const previousBaseUrl = process.env.OPENAI_BASE_URL
  let stalled: StallingResponse | undefined

  try {
    process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
    stalled = makeStallingResponse(
      `${JSON.stringify({
        model: 'llama3.1:8b',
        message: { role: 'assistant', content: 'partial' },
        done: false,
      })}\n`,
      'http://localhost:11434/api/chat',
      'application/x-ndjson',
    )
    const activeStalled = stalled

    globalThis.fetch = (async () => activeStalled.response) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model: 'llama3.1:8b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()
    const stream = result.data as unknown as ShimStream

    const outcome = await expectAbortStopsStream({
      abort: () => stream.controller.abort(),
      cancelReasons: activeStalled.cancelReasons,
      expectedEventsBeforeAbort: 1,
      label: 'native Ollama converted stream',
      stream,
    })

    expect(outcome.events[0]?.type).toBe('message_start')
  } finally {
    stalled?.close()
    restoreEnv('OPENAI_BASE_URL', previousBaseUrl)
  }
})
// openaiShim test extraction seam 042 end


// openaiShim test extraction seam 043 start: normal OpenAI SSE stream still completes after controller wiring
test('normal OpenAI SSE stream still completes after controller wiring', async () => {
  globalThis.fetch = (async () =>
    makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-normal-stream',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: 'complete' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-normal-stream',
        object: 'chat.completion.chunk',
        model: 'fake-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ]))) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'fake-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe('complete')
  expect((result.data as unknown as ShimStream).controller.signal.aborted).toBe(false)
})
// openaiShim test extraction seam 043 end


// openaiShim test extraction seam 044 start: uses max_tokens instead of max_completion_tokens for local providers
test('uses max_tokens instead of max_completion_tokens for local providers', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.options?.num_predict).toBe(64)
    expect(body.options?.num_ctx).toBe(32768)
    expect(body.stream_options).toBeUndefined()

    return new Response(
      JSON.stringify({
        model: 'llama3.1:8b',
        message: {
          role: 'assistant',
          content: 'hello',
        },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 1,
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'llama3.1:8b',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })
})
// openaiShim test extraction seam 052 end


// openaiShim test extraction seam 053 start: preserves Grep tool pattern field in OpenAI-compatible schemas

// openaiShim test extraction seam 053 end


// openaiShim test extraction seam 054 start: does not infer Gemini mode from OPENAI_BASE_URL path substrings

// openaiShim test extraction seam 054 end


// openaiShim test extraction seam 055 start: the OpenAI shim façade exposes the beta.messages namespace
test('the OpenAI shim façade exposes the beta.messages namespace', () => {
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  expect(client.beta.messages).toBeDefined()
})
// openaiShim test extraction seam 055 end


// openaiShim test extraction seam 056 start: preserves image tool results as placeholders in follow-up requests
test('preserves image tool results as placeholders in follow-up requests', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen/qwen3.6-plus',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'qwen/qwen3.6-plus',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Read this screenshot' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_image_1',
            name: 'Read',
            input: { file_path: 'C:\\temp\\screenshot.png' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image_1',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'ZmFrZQ==',
                },
              },
            ],
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const toolMessage = (requestBody?.messages as Array<Record<string, unknown>>).find(
    message => message.role === 'tool',
  ) as {
    content?: Array<{
      type: string
      text?: string
      image_url?: { url: string }
    }> | string
  } | undefined

  expect(Array.isArray(toolMessage?.content)).toBe(true)
  const parts = toolMessage?.content as Array<{
    type: string
    text?: string
    image_url?: { url: string }
  }>
  // Issue #1421: image-only tool results now get a placeholder text part
  // prepended so OpenAI-compatible providers that require a `text` field on
  // `role: "tool"` messages (e.g. Xiaomi Mimo) don't 400 with "text is not set".
  expect(parts).toEqual([
    { type: 'text', text: 'Image attached.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,ZmFrZQ==' },
    },
  ])
})
// openaiShim test extraction seam 056 end


// openaiShim test extraction seam 057 start: adds text part for image-only user messages
test('adds text part for image-only user messages', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'mimo-v2.5-pro',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mimo-v2.5-pro',
    system: 'test system',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'ZmFrZQ==',
            },
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const userMessage = (requestBody?.messages as Array<Record<string, unknown>>).find(
    message => message.role === 'user',
  ) as {
    content?: Array<{
      type: string
      text?: string
      image_url?: { url: string }
    }>
  } | undefined

  expect(userMessage?.content).toEqual([
    { type: 'text', text: 'Image attached.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,ZmFrZQ==' },
    },
  ])
})
// openaiShim test extraction seam 057 end


// openaiShim test extraction seam 058 start: preserves mixed text and image tool results as multipart content
test('preserves mixed text and image tool results as multipart content', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Read this screenshot' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_image_2',
            name: 'Read',
            input: { file_path: 'C:\\temp\\screenshot.png' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_image_2',
            content: [
              { type: 'text', text: 'Screenshot captured' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'ZmFrZQ==',
                },
              },
            ],
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const toolMessage = (requestBody?.messages as Array<Record<string, unknown>>).find(
    message => message.role === 'tool',
  ) as {
    content?: Array<{
      type: string
      text?: string
      image_url?: { url: string }
    }>
  } | undefined

  expect(Array.isArray(toolMessage?.content)).toBe(true)
  const parts = toolMessage?.content ?? []
  expect(parts[0]).toEqual({ type: 'text', text: 'Screenshot captured' })
  expect(parts[1]).toEqual({
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,ZmFrZQ==' },
  })
})
// openaiShim test extraction seam 074 end

test('longcat provider flag prefers LONGCAT_API_KEY over generic OPENAI_API_KEYS pool', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_API_KEYS = 'fake-openai-pool-a,fake-openai-pool-b'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY

  const result = applyProviderFlag('longcat', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('https://api.longcat.chat/openai/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-longcat-key')
})

test('longcat provider flag strips unsupported tool definitions', async () => {
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return makeChatCompletionResponse('LongCat-2.0')
  }) as unknown as FetchType

  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'LongCat-2.0',
    messages: [
      { role: 'user', content: 'List files' },
    ],
    tools: [{
      name: 'Bash',
      description: 'Run a shell command',
      input_schema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    }],
    max_tokens: 32,
    stream: false,
  })

  expect(requestBody?.tools).toBeUndefined()
})

test('longcat rejects image input before dispatch', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(client.beta.messages.create({
    model: 'LongCat-2.0',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } },
      ],
    }],
    max_tokens: 32,
    stream: false,
  })).rejects.toThrow('does not support image inputs')
})

test('longcat rejects image tool results before dispatch', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY
  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(client.beta.messages.create({
    model: 'LongCat-2.0',
    messages: [
      { role: 'user', content: 'Inspect the screenshot' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_screenshot', name: 'Screenshot', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_screenshot', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }] }] },
    ],
    tools: [{ name: 'Screenshot', description: 'Capture a screenshot', input_schema: { type: 'object', properties: {} } }],
    max_tokens: 32,
    stream: false,
  })).rejects.toThrow('does not support image inputs')
})

test('longcat accepts the documented bare OpenAI SDK base URL', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai'
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('https://api.longcat.chat/openai/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-longcat-key')
})

test('longcat accepts the documented bare OpenAI SDK base URL with a trailing slash', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai/'
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('https://api.longcat.chat/openai/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-longcat-key')
})

test('longcat does not append chat completions to a configured endpoint URL', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai/v1/chat/completions'
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('https://api.longcat.chat/openai/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-longcat-key')
})

test('longcat normalizes a configured endpoint URL with a trailing slash', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai/v1/chat/completions/'
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()
  const captured = await captureChatCompletionRequest()
  expect(captured.url).toBe('https://api.longcat.chat/openai/v1/chat/completions')
})

test('longcat accepts the documented CodeBuddy endpoint URL', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai/chat/completions'
  delete process.env.OPENAI_API_KEY

  expect(applyProviderFlag('longcat', []).error).toBeUndefined()
  const captured = await captureChatCompletionRequest()
  expect(captured.url).toBe('https://api.longcat.chat/openai/chat/completions')
})

test('longcat prefers its dedicated credential over a copied key from another provider', async () => {
  process.env.LONGCAT_API_KEY = 'fake-longcat-key'
  process.env.MIMO_API_KEY = 'fake-mimo-key'
  process.env.OPENAI_API_KEY = 'fake-mimo-key'
  process.env.OPENAI_BASE_URL = 'https://api.longcat.chat/openai/v1'

  const captured = await captureChatCompletionRequest('LongCat-2.0')

  expect(captured.authorization).toBe('Bearer fake-longcat-key')
})

test('longcat provider flag never falls back to an OPENAI_API_KEYS pool', async () => {
  process.env.OPENAI_API_KEYS = 'other-provider-secret'
  delete process.env.LONGCAT_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_KEY

  const result = applyProviderFlag('longcat', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.authorization).not.toBe('Bearer other-provider-secret')
})

test('dedicated-only ClinePass route never falls back to generic OpenAI credentials', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.cline.bot/api/v1'
  process.env.OPENAI_MODEL = 'cline-pass/deepseek-v4-flash'
  process.env.OPENAI_API_KEY = 'generic-openai-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-pool-a,generic-openai-pool-b'
  delete process.env.CLINE_API_KEY

  const captured = await captureChatCompletionRequest(
    'cline-pass/deepseek-v4-flash',
  )

  expect(captured.authorization).toBeNull()
})

test('dedicated-only GMI Cloud route never falls back to generic OpenAI credentials', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.gmi-serving.com/v1'
  process.env.OPENAI_MODEL = 'deepseek-ai/DeepSeek-V4-Pro'
  process.env.OPENAI_API_KEY = 'generic-openai-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-pool-a,generic-openai-pool-b'
  delete process.env.GMI_API_KEY

  const captured = await captureChatCompletionRequest(
    'deepseek-ai/DeepSeek-V4-Pro',
  )

  expect(captured.authorization).toBeNull()
})

test('GMI Cloud route prefers its dedicated key over a generic OpenAI key', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.gmi-serving.com/v1'
  process.env.OPENAI_MODEL = 'deepseek-ai/DeepSeek-V4-Pro'
  process.env.OPENAI_API_KEY = 'generic-openai-key'
  process.env.GMI_API_KEY = 'gmi-key'

  const captured = await captureChatCompletionRequest(
    'deepseek-ai/DeepSeek-V4-Pro',
  )

  expect(captured.authorization).toBe('Bearer gmi-key')
  expect(captured.url).toBe('https://api.gmi-serving.com/v1/chat/completions')
})

test('gmi-cloud provider flag sends the GMI key as Bearer despite settings left by another provider', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.venice.ai/api/v1'
  process.env.OPENAI_API_KEY = 'other-provider-secret'
  process.env.OPENAI_API_FORMAT = 'responses'
  process.env.OPENAI_AUTH_HEADER = 'api-key'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'other-provider-secret'
  process.env.GMI_API_KEY = 'gmi-key'

  const result = applyProviderFlag('gmi-cloud', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek-ai/DeepSeek-V4-Pro',
  )

  expect(captured.authorization).toBe('Bearer gmi-key')
  expect(captured.url).toBe('https://api.gmi-serving.com/v1/chat/completions')
})
// openaiShim test extraction seam 087 end


// openaiShim test extraction seam 088 start: preserves Gemini tool call extra_content from streaming chunks

// openaiShim test extraction seam 088 end


// openaiShim test extraction seam 089 start: preserves Gemini thought signature from streaming delta extra_content

// openaiShim test extraction seam 089 end


// openaiShim test extraction seam 090 start: preserves Gemini thought signature from non-streaming message extra_content

// openaiShim test extraction seam 090 end


// Extraction seam: provider signature metadata | raw streaming tool fallback.

// openaiShim test extraction seam 091 start: converts Gemini raw tool-call text into streaming tool_use blocks
test('converts Gemini raw tool-call text into streaming tool_use blocks', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-raw-tool',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-flash-lite',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: 'Tool calls',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-raw-tool',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-flash-lite',
        choices: [
          {
            index: 0,
            delta: {
              content:
                ' requested:\n- Write({"file_path":"style.css","content":"ul { padding: 0; }"}) [id: call79435b5a26564619b0151197]',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-raw-tool',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-flash-lite',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Write CSS' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  expect(
    events.some(
      event =>
        event.type === 'content_block_start' &&
        (event.content_block as Record<string, unknown> | undefined)?.type ===
          'text',
    ),
  ).toBe(false)

  const toolStart = events.find(
    event =>
      event.type === 'content_block_start' &&
      (event.content_block as Record<string, unknown> | undefined)?.type ===
        'tool_use',
  ) as { content_block?: Record<string, unknown> } | undefined
  expect(toolStart?.content_block).toMatchObject({
    type: 'tool_use',
    id: 'call79435b5a26564619b0151197',
    name: 'Write',
  })

  const toolInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        (event.delta as Record<string, unknown> | undefined)?.type ===
          'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')
  expect(JSON.parse(toolInput)).toEqual({
    file_path: 'style.css',
    content: 'ul { padding: 0; }',
  })

  const stop = events.find(event => event.type === 'message_delta') as
    | { delta?: Record<string, unknown> }
    | undefined
  expect(stop?.delta?.stop_reason).toBe('tool_use')
})
// openaiShim test extraction seam 091 end


// Extraction seam: streaming conversion | non-streaming response conversion.

// openaiShim test extraction seam 092 start: converts Gemini raw tool-call text into non-streaming tool_use blocks
test('converts Gemini raw tool-call text into non-streaming tool_use blocks', async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = (async (_input, _init) => {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-raw-tool',
          model: 'google/gemini-3.1-flash-lite',
          choices: [
            {
              message: {
                role: 'assistant',
                content:
                  'Tool calls requested:\n- Agent({"description":"Verify the todo list application functionality.","prompt":"Check files.","subagent_type":"verification"}) [id: call9a8b7c6d5e4f3a2b1c0d9e8f]',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            total_tokens: 16,
          },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as FetchType

    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const message = await client.beta.messages.create({
      model: 'google/gemini-3.1-flash-lite',
      messages: [{ role: 'user', content: 'Verify' }],
      max_tokens: 64,
      stream: false,
    }) as {
      stop_reason?: string
      content?: Array<Record<string, unknown>>
    }

    expect(message.stop_reason).toBe('tool_use')
    expect(message.content).toEqual([
      {
        type: 'tool_use',
        id: 'call9a8b7c6d5e4f3a2b1c0d9e8f',
        name: 'Agent',
        input: {
          description: 'Verify the todo list application functionality.',
          prompt: 'Check files.',
          subagent_type: 'verification',
        },
      },
    ])
  } finally {
    globalThis.fetch = previousFetch
  }
})
// openaiShim test extraction seam 095 end


// Extraction seam: completed tool parsing | streamed tool normalization.

// openaiShim test extraction seam 096 start: normalizes plain string Bash tool arguments in streaming responses
test('normalizes plain string Bash tool arguments in streaming responses', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})
// openaiShim test extraction seam 096 end


// openaiShim test extraction seam 097 start: normalizes plain string Bash tool arguments when streaming starts with an empty chunk
test('normalizes plain string Bash tool arguments when streaming starts with an empty chunk', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})
// openaiShim test extraction seam 097 end


// openaiShim test extraction seam 098 start: normalizes plain string Bash tool arguments when streaming starts with whitespace
test('normalizes plain string Bash tool arguments when streaming starts with whitespace', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: ' ',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: 'pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":" pwd"}')
})
// openaiShim test extraction seam 098 end


// openaiShim test extraction seam 099 start: keeps terminal whitespace-only Bash arguments invalid in streaming responses
test('keeps terminal whitespace-only Bash arguments invalid in streaming responses', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: ' ',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{}')
})
// openaiShim test extraction seam 099 end


// openaiShim test extraction seam 100 start: normalizes streaming Bash arguments that begin with bracket syntax
test('normalizes streaming Bash arguments that begin with bracket syntax', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '[ -f package.json ] && pwd',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"[ -f package.json ] && pwd"}')
})
// openaiShim test extraction seam 100 end


// openaiShim test extraction seam 101 start: normalizes streaming Bash arguments when the first chunk is only an opening brace
test('normalizes streaming Bash arguments when the first chunk is only an opening brace', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    arguments: ' pwd; }',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"{ pwd; }"}')
})
// openaiShim test extraction seam 101 end


// openaiShim test extraction seam 102 start: repairs truncated structured Bash JSON in streaming responses
test('repairs truncated structured Bash JSON in streaming responses', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"pwd"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const normalizedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(normalizedInput).toBe('{"command":"pwd"}')
})
// openaiShim test extraction seam 102 end


// openaiShim test extraction seam 103 start: does not normalize incomplete streamed Bash commands when finish_reason is length
test('does not normalize incomplete streamed Bash commands when finish_reason is length', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: 'rg --fi',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'length',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const streamedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(streamedInput).toBe('rg --fi')
})
// openaiShim test extraction seam 103 end


// openaiShim test extraction seam 104 start: repairs truncated JSON objects even without command field
test('repairs truncated JSON objects even without command field', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'function-call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"cwd":"/tmp"',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'google/gemini-3.1-pro-preview',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'google/gemini-3.1-pro-preview',
      system: 'test system',
      messages: [{ role: 'user', content: 'Use Bash' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const streamedInput = events
    .filter(
      event =>
        event.type === 'content_block_delta' &&
        typeof event.delta === 'object' &&
        event.delta !== null &&
        (event.delta as Record<string, unknown>).type === 'input_json_delta',
    )
    .map(event => (event.delta as Record<string, unknown>).partial_json)
    .join('')

  expect(streamedInput).toBe('{"cwd":"/tmp"}')
})
// openaiShim test extraction seam 106 end


// Extraction seam: argument parsing | schema sanitation.

// openaiShim test extraction seam 107 start: sanitizes malformed MCP tool schemas before sending them to OpenAI

// openaiShim test extraction seam 107 end


// openaiShim test extraction seam 108 start: optional tool properties are not added to required[] — fixes Groq/Azure 400 tool_use_failed

// openaiShim test extraction seam 108 end


// Extraction seam: schema sanitation | message conversion façade.

// ---------------------------------------------------------------------------
// Extraction boundary: tool conversion | message conversion (Issue #202)
//
// Focused suites own the behavior on either side of this boundary.
// This pointer intentionally remains in the façade suite after extraction.
// It also gives independent extraction branches stable merge context.
//
// ---------------------------------------------------------------------------

// openaiShim test extraction seam 109 start: the OpenAI shim façade exposes the messages.create contract
test('the OpenAI shim façade exposes the messages.create contract', () => {
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  expect(typeof client.beta.messages.create).toBe('function')
})
// openaiShim test extraction seam 109 end


function makeNonStreamResponse(content = 'ok'): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

// openaiShim test extraction seam 110 start: coalesces consecutive user messages to avoid alternation errors (issue #202)
test('coalesces consecutive user messages to avoid alternation errors (issue #202)', async () => {
  let sentMessages: Array<{ role: string; content: unknown }> | undefined

  globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
    sentMessages = JSON.parse(String(init?.body)).messages
    return makeNonStreamResponse()
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'test-model',
    system: 'sys',
    messages: [
      { role: 'user', content: 'first message' },
      { role: 'user', content: 'second message' },
    ],
    max_tokens: 64,
    stream: false,
  })

  expect(sentMessages?.length).toBe(2)
  expect(sentMessages?.[0]?.role).toBe('system')
  expect(sentMessages?.[1]?.role).toBe('user')
  const userContent = sentMessages?.[1]?.content as string
  expect(userContent).toContain('first message')
  expect(userContent).toContain('second message')
})
// openaiShim test extraction seam 110 end


// openaiShim test extraction seam 111 start: coalesces consecutive assistant messages preserving tool_calls (issue #202)
test('coalesces consecutive assistant messages preserving tool_calls (issue #202)', async () => {
  let sentMessages: Array<{ role: string; content: unknown; tool_calls?: unknown[] }> | undefined

  globalThis.fetch = (async (_input: unknown, init: RequestInit | undefined) => {
    sentMessages = JSON.parse(String(init?.body)).messages
    return makeNonStreamResponse()
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'test-model',
    system: 'sys',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'thinking...' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file.txt' }] },
    ],
    max_tokens: 64,
    stream: false,
  })

  const assistantMsgs = sentMessages?.filter(m => m.role === 'assistant')
  expect(assistantMsgs?.length).toBe(1)
  expect(assistantMsgs?.[0]?.tool_calls?.length).toBeGreaterThan(0)
})
// openaiShim test extraction seam 111 end

// ---------------------------------------------------------------------------
// Extraction boundary: message conversion | non-streaming response conversion
//
// Focused suites own the behavior on either side of this boundary.
// This pointer intentionally remains in the façade suite after extraction.
// It also gives independent extraction branches stable merge context.
//
// ---------------------------------------------------------------------------

// openaiShim test extraction seam 112 start: the OpenAI shim façade creates independent client instances
test('the OpenAI shim façade creates independent client instances', () => {
  const first = createOpenAIShimClient({}) as OpenAIShimClient
  const second = createOpenAIShimClient({}) as OpenAIShimClient
  expect(first).not.toBe(second)
  expect(first.beta).not.toBe(second.beta)
  expect(first.beta.messages).not.toBe(second.beta.messages)
})
// openaiShim test extraction seam 112 end

test('facade parseTextToolCalls and parseXmlToolCalls share adapter sequencing', () => {
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

// ---------------------------------------------------------------------------
// openaiShim test extraction seam 113 start: non-streaming: reasoning_content emitted as thinking block only when content is null
test('non-streaming: reasoning_content emitted as thinking block only when content is null', async () => {
  globalThis.fetch = (async (_input, _init) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              reasoning_content: 'Let me think about this step by step.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Let me think about this step by step.' },
  ])
})
// openaiShim test extraction seam 113 end


// openaiShim test extraction seam 114 start: non-streaming: empty string content does not fall through to reasoning_content as text
test('non-streaming: empty string content does not fall through to reasoning_content as text', async () => {
  globalThis.fetch = (async (_input, _init) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'Chain of thought here.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'Chain of thought here.' },
  ])
})
// openaiShim test extraction seam 114 end


// openaiShim test extraction seam 115 start: non-streaming: real content takes precedence over reasoning_content
test('non-streaming: real content takes precedence over reasoning_content', async () => {
  globalThis.fetch = (async (_input, _init) => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'I need to calculate this.',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = (await client.beta.messages.create({
    model: 'glm-5',
    system: 'test system',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'thinking', thinking: 'I need to calculate this.' },
    { type: 'text', text: 'The answer is 42.' },
  ])
})
// openaiShim test extraction seam 117 end


// openaiShim test extraction seam 118 start: non-streaming: strips <think> tag block from assistant content
test('non-streaming: strips <think> tag block from assistant content', async () => {
  globalThis.fetch = asMockFetch(mock(async () => {
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-5-mini',
        choices: [
          {
            message: {
              role: 'assistant',
              content:
                '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = (await client.beta.messages.create({
    model: 'gpt-5-mini',
    system: 'test system',
    messages: [{ role: 'user', content: 'hey' }],
    max_tokens: 64,
    stream: false,
  })) as { content: Array<Record<string, unknown>> }

  expect(result.content).toEqual([
    { type: 'text', text: 'Hey! How can I help you today?' },
  ])
})
// openaiShim test extraction seam 118 end


// Extraction seam: non-streaming response conversion | streaming event conversion.

// openaiShim test extraction seam 119 start: streaming: thinking block closed before tool call
test('streaming: thinking block closed before tool call', async () => {
  globalThis.fetch = (async (_input, _init) => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', reasoning_content: 'Thinking...' },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'Bash',
                    arguments: '{"command":"ls"}',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'glm-5',
      system: 'test system',
      messages: [{ role: 'user', content: 'Run ls' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) {
    events.push(event)
  }

  const types = events.map(e => e.type)

  const thinkingStartIdx = types.indexOf('content_block_start')
  const firstStopIdx = types.indexOf('content_block_stop')
  const toolStartIdx = types.indexOf(
    'content_block_start',
    thinkingStartIdx + 1,
  )

  expect(thinkingStartIdx).toBeGreaterThanOrEqual(0)
  expect(firstStopIdx).toBeGreaterThan(thinkingStartIdx)
  expect(toolStartIdx).toBeGreaterThan(firstStopIdx)

  const thinkingStart = events[thinkingStartIdx] as {
    content_block?: Record<string, unknown>
  }
  expect(thinkingStart?.content_block?.type).toBe('thinking')
})
// openaiShim test extraction seam 119 end


// openaiShim test extraction seam 120 start: streaming: strips <think> tag block from assistant content deltas
test('streaming: strips <think> tag block from assistant content deltas', async () => {
  globalThis.fetch = asMockFetch(mock(async () => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                '<think>user wants a greeting, respond briefly</think>Hey! How can I help you today?',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-5-mini',
      system: 'test system',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
})
// openaiShim test extraction seam 120 end


// openaiShim test extraction seam 121 start: streaming: strips <think> tag split across multiple content chunks
test('streaming: strips <think> tag split across multiple content chunks', async () => {
  globalThis.fetch = asMockFetch(mock(async () => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: '<think>user wants a greeting,',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              content: ' respond briefly</th',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              content: 'ink>Hey! How can I help you today?',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const result = await client.beta.messages
    .create({
      model: 'gpt-5-mini',
      system: 'test system',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe('Hey! How can I help you today?')
})
// openaiShim test extraction seam 121 end


// openaiShim test extraction seam 122 start: streaming: preserves prose without tags (no phrase-based false positive)
test('streaming: preserves prose without tags (no phrase-based false positive)', async () => {
  // Regression: older phrase-based sanitizer would strip "I should..." prose.
  // The tag-based approach leaves legitimate assistant output alone.
  globalThis.fetch = asMockFetch(mock(async () => {
    const chunks = makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                'I should note that the user role requires a briefly concise friendly response format.',
            },
            finish_reason: null,
          },
        ],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'gpt-5-mini',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      },
    ])

    return makeSseResponse(chunks)
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-5-mini',
      system: 'test system',
      messages: [{ role: 'user', content: 'hey' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const textDeltas: string[] = []
  for await (const event of result.data) {
    const delta = (event as { delta?: { type?: string; text?: string } }).delta
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      textDeltas.push(delta.text)
    }
  }

  expect(textDeltas.join('')).toBe(
    'I should note that the user role requires a briefly concise friendly response format.',
  )
})
// openaiShim test extraction seam 123 end

test('redacts configured secret substrings from fetch network error messages', async () => {
  const secret = 'route/key+AbC123'
  process.env.OPENAI_API_KEY = secret

  globalThis.fetch = asMockFetch(mock(async () => {
    throw new TypeError(`fetch failed while routing ${secret}`)
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.not.toThrow(secret)
})

test('redacts encoded configured secrets from non-URL transport error messages', async () => {
  const secret = 'route/key+AbC123'
  const encodedSecret = encodeURIComponent(secret)
  const doubleEncodedSecret = encodeURIComponent(encodedSecret)
  const fullyEncodedSecret = Array.from(new TextEncoder().encode(secret))
    .map(byte => `%${byte.toString(16).padStart(2, '0')}`)
    .join('')
  const malformedAdjacentSecret = `%E0%A4${encodedSecret}`
  const encodedCategoryMarker = '%5Bopenai_category%3Dauth_invalid%5D'
  const encodedControlSequence = '%1B%5B31m'
  process.env.OPENAI_API_KEY = secret

  globalThis.fetch = asMockFetch(mock(async () => {
    throw new TypeError(
      `proxy failed ${encodedCategoryMarker} ${encodedControlSequence} for path /v1/${encodedSecret}?nested=${doubleEncodedSecret}&fully=${fullyEncodedSecret}&malformed=${malformedAdjacentSecret}`,
    )
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  let caught: unknown
  try {
    await client.beta.messages.create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } catch (error) {
    caught = error
  }

  expect(caught).toBeDefined()
  const message = (caught as Error).message
  expect(message).toContain('proxy failed')
  expect(message).toContain(encodedCategoryMarker)
  expect(message).toContain(encodedControlSequence)
  expect(message).not.toContain('\u001B')
  expect(extractOpenAICategoryMarker(message)).toBe('network_error')
  expect(message).not.toContain(secret)
  expect(message).not.toContain(encodedSecret)
  expect(message).not.toContain(doubleEncodedSecret)
  expect(message).not.toContain(fullyEncodedSecret)
  expect(message).not.toContain(malformedAdjacentSecret)
})
// openaiShim test extraction seam 125 end

test('propagates caller AbortError without wrapping it as transport failure', async () => {
// openaiShim test extraction seam 126 start: propagates AbortError without wrapping it as transport failure
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  globalThis.fetch = asMockFetch(mock(async () => {
    throw abortError
  }))

  const controller = new AbortController()
  const callerReason = new DOMException('Cancelled by caller', 'AbortError')
  controller.abort(callerReason)

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create(
      {
        model: 'qwen2.5-coder:7b',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      },
      { signal: controller.signal },
    ),
  ).rejects.toBe(callerReason)
})

test('classifies a pre-header API timeout without replaying the request', async () => {
  process.env.API_TIMEOUT_MS = '20'
  const pathSecret = 'route/key+AbC123'
  const encodedPathSecret = encodeURIComponent(pathSecret)
  const doubleEncodedPathSecret = encodeURIComponent(encodedPathSecret)
  const escapeLookingSecret = 'abc%2FdefLONG'
  const encodedEscapeLookingSecret = encodeURIComponent(escapeLookingSecret)
  const decodedEscapeLookingSecret = decodeURIComponent(escapeLookingSecret)
  const malformedUtf8Secret = 'éSECRET_VALUE_123'
  const encodedMalformedUtf8Secret = encodeURIComponent(malformedUtf8Secret)
  process.env.OPENAI_API_KEY = pathSecret
  process.env.OPENROUTER_API_KEY = escapeLookingSecret
  process.env.DEEPSEEK_API_KEY = malformedUtf8Secret
  process.env.OPENAI_BASE_URL =
    `https://user:password@slow.example.test/v1/invalid%ZZ/${doubleEncodedPathSecret}/${encodedEscapeLookingSecret}/%E0%A4${encodedMalformedUtf8Secret}` +
    `?prompt=${encodedPathSecret}&nested=${doubleEncodedPathSecret}` +
    `&escape=${encodedEscapeLookingSecret}&malformed=%E0%A4${encodedMalformedUtf8Secret}` +
    '&token=secret'
  let fetchCalls = 0
  let completedGenerations = 0
  const receivedBodies: string[] = []
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    receivedBodies.push(String(init?.body))
    return new Promise<Response>((resolve, reject) => {
      setTimeout(() => {
        completedGenerations++
        resolve(makeChatCompletionResponse('gpt-4o-mini'))
      }, 50)
      const signal = init?.signal
      if (!signal) return
      const rejectFromAbort = () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', rejectFromAbort, { once: true })
      if (signal.aborted) rejectFromAbort()
    })
  }) as unknown as FetchType

  const safety = new AbortController()
  const safetyTimer = setTimeout(() => safety.abort(), 500)
  const client = createOpenAIShimClient({}) as OpenAIShimClient

  let caught: unknown
  try {
    await waitForPromise(
      client.beta.messages.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 64,
          stream: false,
        },
        { signal: safety.signal },
      ),
      750,
      'pre-header timeout did not settle',
    )
  } catch (error) {
    caught = error
  } finally {
    clearTimeout(safetyTimer)
  }
  await new Promise(resolve => setTimeout(resolve, 60))

  expect(caught).toBeDefined()
  const error = caught as Error & { constructor: { name: string } }
  expect(error.constructor.name).toBe('APIConnectionError')
  expect(isOpenAIRequestNonReplayable(error)).toBe(true)
  expect(error.message).toContain('no response headers within 20ms (API_TIMEOUT_MS)')
  expect(error.message).toContain('slow.example.test')
  expect(error.message).toContain('openai_category=request_timeout')
  expect(error.message).not.toContain('password')
  expect(error.message).not.toContain('token=secret')
  expect(error.message).not.toContain(pathSecret)
  expect(error.message).not.toContain(encodedPathSecret)
  expect(error.message).not.toContain(doubleEncodedPathSecret)
  expect(error.message).not.toContain(escapeLookingSecret)
  expect(error.message).not.toContain(encodedEscapeLookingSecret)
  expect(error.message).not.toContain(decodedEscapeLookingSecret)
  expect(error.message).not.toContain(malformedUtf8Secret)
  expect(error.message).not.toContain(encodedMalformedUtf8Secret)
  expect(fetchCalls).toBe(1)
  expect(receivedBodies).toHaveLength(1)
  expect(completedGenerations).toBe(1)
})

test('does not proxy-retry when a deadline abort surfaces as fetch failed', async () => {
  process.env.API_TIMEOUT_MS = '20'
  let fetchCalls = 0
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const rejectFromAbort = () => reject(new TypeError('fetch failed'))
      signal?.addEventListener('abort', rejectFromAbort, { once: true })
      if (signal?.aborted) rejectFromAbort()
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('no response headers within 20ms (API_TIMEOUT_MS)')

  expect(fetchCalls).toBe(1)
})

test('deadline wins when an abort-ignoring fetch resolves 504 afterward', async () => {
  process.env.API_TIMEOUT_MS = '20'
  let fetchCalls = 0
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    return new Promise<Response>(resolve => {
      const resolveAfterAbort = () => {
        resolve(new Response('Gateway Timeout', { status: 504 }))
      }
      init?.signal?.addEventListener('abort', resolveAfterAbort, { once: true })
      if (init?.signal?.aborted) resolveAfterAbort()
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('no response headers within 20ms (API_TIMEOUT_MS)')

  expect(fetchCalls).toBe(1)
})

test('gives a proxy retry its own response-header deadline', async () => {
  process.env.API_TIMEOUT_MS = '50'
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls++
    if (fetchCalls === 1) {
      await new Promise(resolve => setTimeout(resolve, 30))
      return new Response('Gateway Timeout', { status: 504 })
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    return makeChatCompletionResponse('gpt-4o-mini')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const response = await client.beta.messages.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  expect(response).toBeDefined()
  expect(fetchCalls).toBe(2)
})

test('bounds nested URL decoding while retaining encoded secret redaction', async () => {
  const secret = 'route/key+AbC123'
  const secretVariants = [secret]
  for (let layer = 0; layer < 4; layer++) {
    secretVariants.push(
      encodeURIComponent(secretVariants[secretVariants.length - 1]!),
    )
  }
  const deeplyNestedValue = `%${'25'.repeat(200)}`
  process.env.OPENAI_API_KEY = secret
  process.env.OPENAI_BASE_URL =
    `https://slow.example.test/v1/${deeplyNestedValue}/${secretVariants[4]}`
  globalThis.fetch = asMockFetch(mock(async () => {
    throw new TypeError('fetch failed')
  }))

  const originalDecodeURIComponent = globalThis.decodeURIComponent
  let decodeCalls = 0
  globalThis.decodeURIComponent = ((value: string) => {
    decodeCalls++
    return originalDecodeURIComponent(value)
  }) as typeof decodeURIComponent

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  let caught: unknown
  try {
    await client.beta.messages.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } catch (error) {
    caught = error
  } finally {
    globalThis.decodeURIComponent = originalDecodeURIComponent
  }

  expect(caught).toBeDefined()
  for (const secretVariant of secretVariants) {
    expect((caught as Error).message).not.toContain(secretVariant)
  }
  expect(decodeCalls).toBeLessThanOrEqual(32)
})

test('decodes malformed URL escape runs in linear work', async () => {
  const secret = 'route/key+AbC123'
  const encodedSecret = encodeURIComponent(secret)
  const malformedEscapeCount = 200
  const malformedUtf8Run = '%80'.repeat(malformedEscapeCount)
  process.env.OPENAI_API_KEY = secret
  process.env.OPENAI_BASE_URL =
    `https://slow.example.test/v1/${malformedUtf8Run}/${encodedSecret}`
  globalThis.fetch = asMockFetch(mock(async () => {
    throw new TypeError('fetch failed')
  }))

  const originalDecodeURIComponent = globalThis.decodeURIComponent
  let malformedDecodeCalls = 0
  globalThis.decodeURIComponent = ((value: string) => {
    if (value.includes('%80')) malformedDecodeCalls++
    return originalDecodeURIComponent(value)
  }) as typeof decodeURIComponent

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  let caught: unknown
  try {
    await client.beta.messages.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
  } catch (error) {
    caught = error
  } finally {
    globalThis.decodeURIComponent = originalDecodeURIComponent
  }

  expect(caught).toBeDefined()
  expect((caught as Error).message).not.toContain(secret)
  expect((caught as Error).message).not.toContain(encodedSecret)
  expect(malformedDecodeCalls).toBeLessThanOrEqual(malformedEscapeCount * 10)
})

test('preserves caller cancellation while waiting for response headers without retrying', async () => {
  process.env.API_TIMEOUT_MS = '200'
  let fetchCalls = 0
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    return pendingFetchUntilAbort(init)
  }) as unknown as FetchType

  const caller = new AbortController()
  const callerReason = new DOMException('Cancelled by user', 'AbortError')
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const originalAbortSignalAny = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'any',
  )
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
  })
  try {
    const request = client.beta.messages.create(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      },
      { signal: caller.signal },
    )

    setTimeout(() => caller.abort(callerReason), 10)

    await expect(
      waitForPromise(request, 500, 'caller abort did not settle'),
    ).rejects.toBe(callerReason)
    expect(fetchCalls).toBe(1)
  } finally {
    if (originalAbortSignalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny)
    }
  }
})

test('native signal composition preserves the caller abort reason when fetch rejects AbortError', async () => {
  expect(typeof AbortSignal.any).toBe('function')
  process.env.API_TIMEOUT_MS = '200'
  let fetchCalls = 0
  const fetchAbortError = new DOMException(
    'The operation was aborted.',
    'AbortError',
  )
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      const rejectFromAbort = () => reject(fetchAbortError)
      signal.addEventListener('abort', rejectFromAbort, { once: true })
      if (signal.aborted) rejectFromAbort()
    })
  }) as unknown as FetchType

  const caller = new AbortController()
  const callerReason = new DOMException('Cancelled by user', 'AbortError')
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const request = client.beta.messages.create(
    {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    },
    { signal: caller.signal },
  )

  const abortTimer = setTimeout(() => caller.abort(callerReason), 10)

  try {
    await expect(
      waitForPromise(request, 500, 'caller abort did not settle'),
    ).rejects.toBe(callerReason)
  } finally {
    clearTimeout(abortTimer)
  }
  expect(fetchCalls).toBe(1)
})

test('caller abort winning the timeout catch race prevents a retry', async () => {
  process.env.API_TIMEOUT_MS = '20'
  let fetchCalls = 0
  const caller = new AbortController()
  const callerReason = new DOMException('Cancelled by user', 'AbortError')
  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return
      const rejectFromAbort = () => {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        if (fetchCalls === 1) {
          queueMicrotask(() => caller.abort(callerReason))
        }
      }
      signal.addEventListener('abort', rejectFromAbort, { once: true })
      if (signal.aborted) rejectFromAbort()
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    waitForPromise(
      client.beta.messages.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 64,
          stream: false,
        },
        { signal: caller.signal },
      ),
      500,
      'caller abort race did not settle',
    ),
  ).rejects.toBe(callerReason)
  expect(fetchCalls).toBe(1)
})

test('interruption tracing preserves the native AbortSignal.any request path', async () => {
  const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
  const originalAbortSignalAny = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'any',
  )
  const nativeAny = AbortSignal.any.bind(AbortSignal)
  let nativeAnyCalls = 0
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    value: (signals: AbortSignal[]) => {
      nativeAnyCalls++
      return nativeAny(signals)
    },
  })
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  globalThis.fetch = asMockFetch(
    mock(async () => makeChatCompletionResponse('gpt-4o-mini')),
  )

  try {
    const client = createOpenAIShimClient({}) as OpenAIShimClient
    await client.beta.messages.create(
      {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stream: false,
      },
      { signal: new AbortController().signal },
    )
    expect(nativeAnyCalls).toBe(1)
  } finally {
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
    if (originalAbortSignalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny)
    }
  }
})

test('manual signal fallback preserves caller cancellation after headers arrive', async () => {
  process.env.API_TIMEOUT_MS = '200'
  const fetchSignals: AbortSignal[] = []
  const stalled = makeStallingResponse(
    makeOpenAIStreamFrame({ role: 'assistant', content: 'started' }),
  )
  globalThis.fetch = (async (_input, init) => {
    if (init?.signal) fetchSignals.push(init.signal)
    return stalled.response
  }) as unknown as FetchType

  const caller = new AbortController()
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const originalAbortSignalAny = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'any',
  )
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
  })
  try {
    const result = await client.beta.messages
      .create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 64,
          stream: true,
        },
        { signal: caller.signal },
      )
      .withResponse()

    await expectAbortStopsStream({
      abort: () => caller.abort(),
      cancelReasons: stalled.cancelReasons,
      expectedEventsBeforeAbort: 1,
      label: 'manual combined signal after headers',
      stream: result.data as ShimStream,
    })

    expect(fetchSignals).toHaveLength(1)
    expect(fetchSignals[0].aborted).toBe(true)
  } finally {
    stalled.close()
    if (originalAbortSignalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny)
    }
  }
})

test('manual signal fallback removes caller forwarding after the body settles', async () => {
  process.env.API_TIMEOUT_MS = '200'
  globalThis.fetch = asMockFetch(mock(async () =>
    makeChatCompletionResponse('gpt-4o-mini')))

  const caller = new AbortController()
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const originalAbortSignalAny = Object.getOwnPropertyDescriptor(
    AbortSignal,
    'any',
  )
  Object.defineProperty(AbortSignal, 'any', {
    value: undefined,
    configurable: true,
  })
  try {
    for (let request = 0; request < 2; request++) {
      await client.beta.messages.create(
        {
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 64,
          stream: false,
        },
        { signal: caller.signal },
      )
      expect(getEventListeners(caller.signal, 'abort')).toHaveLength(0)
    }
  } finally {
    if (originalAbortSignalAny) {
      Object.defineProperty(AbortSignal, 'any', originalAbortSignalAny)
    } else {
      delete (AbortSignal as { any?: unknown }).any
    }
  }
})

test('disarms the API timeout after headers arrive while the body keeps streaming', async () => {
  process.env.API_TIMEOUT_MS = '20'
  const fetchSignals: AbortSignal[] = []
  const encoder = new TextEncoder()
  globalThis.fetch = (async (_input, init) => {
    if (init?.signal) fetchSignals.push(init.signal)
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(encoder.encode(makeOpenAIStreamFrame(
              { role: 'assistant', content: 'late body' },
              'stop',
            )))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
          }, 50)
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const result = await client.beta.messages
    .create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    })
    .withResponse()

  const events: Array<Record<string, unknown>> = []
  for await (const event of result.data) events.push(event)

  expect(events.length).toBeGreaterThan(0)
  expect(fetchSignals).toHaveLength(1)
  expect(fetchSignals[0].aborted).toBe(false)
})
// openaiShim test extraction seam 128 end


// Extraction boundary: executor network behavior | native Ollama routing.
// Native Ollama endpoint selection remains an adapter/facade integration concern.
// Keep this marker stable for independent adjacent test migrations.
// openaiShim test extraction seam 129 start: uses native Ollama chat endpoint when local base URL omits /v1
test('uses native Ollama chat endpoint when local base URL omits /v1', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url = typeof input === 'string' ? input : input.url
    requestUrls.push(url)

    return new Response(
      JSON.stringify({
        model: 'qwen2.5-coder:7b',
        message: {
          role: 'assistant',
          content: 'hello from native Ollama',
        },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 2,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestUrls).toEqual(['http://localhost:11434/api/chat'])
})
// openaiShim test extraction seam 132 end


// Extraction boundary: executor tool self-healing | message conversion.
// Message-history normalization below belongs to the message converter.
// Keep this marker stable for independent adjacent test migrations.
// openaiShim test extraction seam 133 start: preserves valid tool_result and drops orphan tool_result
test('preserves valid tool_result and drops orphan tool_result', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'mistral-large-latest',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Search and then I will interrupt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'valid_call_1',
            name: 'Search',
            input: { query: 'openclaude' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'valid_call_1',
            content: 'Found it!',
          },
          {
            type: 'tool_result',
            tool_use_id: 'orphan_call_2',
            content: 'Interrupted result',
          },
          {
            role: 'user',
            content: 'What happened?',
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>

  // Should have: system, user, assistant (tool_use), tool (valid_call_1), user
  // Should NOT have: tool (orphan_call_2)

  const toolMessages = messages.filter(m => m.role === 'tool')
  expect(toolMessages.length).toBe(1)
  expect(toolMessages[0].tool_call_id).toBe('valid_call_1')

  const orphanMessage = toolMessages.find(m => m.tool_call_id === 'orphan_call_2')
  expect(orphanMessage).toBeUndefined()
  // Tool results stay as role:"tool" messages; a follow-up user turn after
  // them is valid chat-completions history and must not get a synthetic
  // assistant bridge inserted before it (issue #2039).
  const assistantMessages = messages.filter(m => m.role === 'assistant')
  expect(assistantMessages.some(m => m.content === '[Tool results received]')).toBe(false)
})
// openaiShim test extraction seam 133 end


// openaiShim test extraction seam 134 start: drops empty assistant message when only thinking block was present and stripped
test('drops empty assistant message when only thinking block was present and stripped', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 123456789,
      model: 'mistral-large-latest',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Initial' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'I am thinking...', signature: 'sig' }] },
      { role: 'user', content: 'Interrupting query' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // The assistant msg is dropped because thinking is stripped.
  // The two user messages are coalesced.
  expect(messages.length).toBe(1)
  expect(messages[0].role).toBe('user')
  expect(String(messages[0].content)).toContain('Initial')
  expect(String(messages[0].content)).toContain('Interrupting query')
})
// openaiShim test extraction seam 134 end


// openaiShim test extraction seam 135 start: drops empty assistant message when only redacted_thinking block was present and stripped
test('drops empty assistant message when only redacted_thinking block was present and stripped', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 123456789,
      model: 'mistral-large-latest',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    messages: [
      { role: 'user', content: 'Initial' },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: '[thinking hidden]' }] },
      { role: 'user', content: 'Interrupting query' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // The assistant msg is dropped because redacted_thinking is stripped.
  // The two user messages are coalesced.
  expect(messages.length).toBe(1)
  expect(messages[0].role).toBe('user')
  expect(String(messages[0].content)).toContain('Initial')
  expect(String(messages[0].content)).toContain('Interrupting query')
})
// openaiShim test extraction seam 135 end


// openaiShim test extraction seam 136 start: passes tool results through as role:tool messages without synthetic assistant filler (issue #2039)
test('passes tool results through as role:tool messages without synthetic assistant filler (issue #2039)', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 123456789,
      model: 'mistral-large-latest',
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { headers: { 'Content-Type': 'application/json' } })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'mistral-large-latest',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: {} }]
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'Result' }
        ]
      },
      { role: 'user', content: 'Next user query' },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  // Roles should be: assistant (tool_calls) -> tool -> user — no synthetic
  // assistant marker between the tool results and the next user query.
  const roles = messages.map(m => m.role)
  expect(roles).toEqual(['assistant', 'tool', 'user'])
  expect(messages.some(m => m.content === '[Tool results received]')).toBe(false)
})
// openaiShim test extraction seam 156 end



// openaiShim test extraction seam 157 start: collapses multiple text blocks in tool_result to string for DeepSeek compatibility (issue #774)
test('collapses multiple text blocks in tool_result to string for DeepSeek compatibility (issue #774)', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-reasoner',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'deepseek-reasoner',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Run ls' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'line one' },
              { type: 'text', text: 'line two' },
            ],
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const toolMessages = messages.filter(m => m.role === 'tool')
  expect(toolMessages.length).toBe(1)
  expect(toolMessages[0].tool_call_id).toBe('call_1')
  expect(typeof toolMessages[0].content).toBe('string')
  expect(toolMessages[0].content).toBe('line one\n\nline two')
})
// openaiShim test extraction seam 157 end


// openaiShim test extraction seam 158 start: collapses multiple text blocks into a single string for DeepSeek compatibility (issue #774)
test('collapses multiple text blocks into a single string for DeepSeek compatibility (issue #774)', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-reasoner',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'deepseek-reasoner',
    system: 'test system',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello!' },
          { type: 'text', text: 'How are you?' },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  expect(messages.length).toBe(2) // system + user
  expect(messages[1].role).toBe('user')
  expect(typeof messages[1].content).toBe('string')
  expect(messages[1].content).toBe('Hello!\n\nHow are you?')
})
// openaiShim test extraction seam 158 end


// openaiShim test extraction seam 159 start: preserves mixed text and image tool results as multipart content
test('preserves mixed text and image tool results as multipart content', async () => {
  let requestBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'done',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      }),
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: 'test system',
    messages: [
      { role: 'user', content: 'Show me' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_1',
            name: 'Bash',
            input: { command: 'cat image.png' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [
              { type: 'text', text: 'Here is the image:' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgo=',
                },
              },
            ],
          },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const toolMessages = messages.filter(m => m.role === 'tool')
  expect(toolMessages.length).toBe(1)
  expect(Array.isArray(toolMessages[0].content)).toBe(true)
  const content = toolMessages[0].content as Array<Record<string, unknown>>
  expect(content.length).toBe(2)
  expect(content[0].type).toBe('text')
  expect(content[1].type).toBe('image_url')
})
// openaiShim test extraction seam 163 end


test.each([
  ['glm-5.2?reasoning=low', 'high'],
  ['glm-5.2?reasoning=medium', 'high'],
  ['glm-5.2?reasoning=high', 'high'],
  ['glm-5.2?reasoning=xhigh', 'max'],
  ['openrouter/zhipu/glm-5.2?reasoning=low', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=medium', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=high', 'high'],
  ['openrouter/zhipu/glm-5.2?reasoning=xhigh', 'max'],
] as const)('Z.AI GLM-5.2: %s enables mapped reasoning effort', async (model, effort) => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const expectedModel = model.split('?')[0];
  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: expectedModel,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe(expectedModel)
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBe(effort)
})

test.each([
  ['glm-5.3', undefined, undefined],
  ['glm-5.3?reasoning=low', 'enabled', 'low'],
  ['glm-5.3?reasoning=high', 'enabled', 'high'],
  ['glm-5.3?reasoning=xhigh', 'enabled', 'max'],
  ['glm-5.3?thinking=disabled', 'enabled', 'low'],
  ['glm-5.3?thinking=disabled&reasoning=high', 'enabled', 'high'],
] as const)('Z.AI GLM-5.3 serializes the verified request contract for %s', async (
  model,
  thinkingType,
  reasoningEffort,
) => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.3',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.3')
  expect(requestBody?.max_tokens).toBe(64)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
  expect(requestBody?.thinking).toEqual(
    thinkingType ? { type: thinkingType } : undefined,
  )
  expect(requestBody?.reasoning_effort).toBe(reasoningEffort)
})

test.each([
  ['glm-5.3-flash', undefined, undefined],
  ['glm-5.3-flash?reasoning=low', 'enabled', 'low'],
  ['glm-5.3-flash?reasoning=high', 'enabled', 'high'],
  ['glm-5.3-flash?reasoning=xhigh', 'enabled', 'max'],
  ['glm-5.3-flash?thinking=disabled', 'enabled', 'low'],
  ['glm-5.3-flash?thinking=disabled&reasoning=high', 'enabled', 'high'],
] as const)('Z.AI GLM-5.3-Flash serializes the verified request contract for %s', async (
  model,
  thinkingType,
  reasoningEffort,
) => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.3-flash',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.3-flash')
  expect(requestBody?.max_tokens).toBe(64)
  expect(requestBody?.max_completion_tokens).toBeUndefined()
  expect(requestBody?.store).toBeUndefined()
  expect(requestBody?.thinking).toEqual(
    thinkingType ? { type: thinkingType } : undefined,
  )
  expect(requestBody?.reasoning_effort).toBe(reasoningEffort)
})

test('direct Z.AI GLM-5.3-Flash preserves text and image input on the wire', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'glm-5.3-flash',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.3-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image.' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        },
      ],
    }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe('glm-5.3-flash')
  const messages = requestBody?.messages as Array<Record<string, unknown>>
  expect(messages).toHaveLength(1)
  expect(messages[0]?.role).toBe('user')
  expect(messages[0]?.content).toEqual([
    { type: 'text', text: 'Describe this image.' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' },
    },
  ])
})

test('direct Z.AI GLM-5.3-Flash replays reasoning content through tool continuation', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-2',
        model: 'glm-5.3-flash',
        choices: [
          { message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.3-flash',
    messages: [
      { role: 'user', content: 'Inspect the workspace.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'Preserve this complete reasoning content.',
            signature: 'sig-flash',
          },
          {
            type: 'tool_use',
            id: 'call_flash_1',
            name: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_flash_1', content: '/workspace' },
        ],
      },
    ],
    max_tokens: 64,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    message => message.role === 'assistant' && Array.isArray(message.tool_calls),
  )
  expect(assistantWithToolCall?.reasoning_content).toBe(
    'Preserve this complete reasoning content.',
  )
})

test.each([
  'glm-5.3-flash',
  'glm-5.3',
] as const)('streaming direct Z.AI %s tool requests opt into tool_stream', async model => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]))
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const stream = await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'add two numbers' }],
    max_tokens: 64,
    stream: true,
    tools: [{
      name: 'add_numbers',
      description: 'Add two numbers',
      input_schema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    }],
  })
  for await (const _event of stream as AsyncIterable<unknown>) {
    // Drain the mocked response so request execution completes.
  }

  expect(requestBody?.tool_stream).toBe(true)
})

test.each([
  'GLM-5.1?reasoning=high',
  'GLM-4.5-Air?reasoning=high',
] as const)('Z.AI GLM: %s does not receive GLM-5.2-only reasoning_effort', async model => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 64,
    stream: false,
  })

  expect(requestBody?.model).toBe(model.split('?', 1)[0])
  expect(requestBody?.thinking).toEqual({ type: 'enabled' })
  expect(requestBody?.reasoning_effort).toBeUndefined()
})
// openaiShim test extraction seam 175 end


test.each([
  ['non-streaming Z.AI request with tools', 'https://api.z.ai/api/coding/paas/v4', false, true, 'glm-5.2'],
  ['streaming Z.AI request without tools', 'https://api.z.ai/api/coding/paas/v4', true, false, 'glm-5.2'],
  ['streaming NVIDIA GLM-5.3-Flash request with tools', 'https://integrate.api.nvidia.com/v1', true, true, 'glm-5.3-flash'],
  ['streaming NVIDIA GLM-5.3 request with tools', 'https://integrate.api.nvidia.com/v1', true, true, 'glm-5.3'],
  ['streaming custom GLM-5.3-Flash request with tools', 'https://proxy.example.test/v1', true, true, 'glm-5.3-flash'],
  ['streaming same-host general Z.AI GLM-5.3-Flash request with tools', 'https://api.z.ai/api/paas/v4', true, true, 'glm-5.3-flash'],
  ['streaming non-Z.AI request with tools', 'https://api.openai.com/v1', true, true, 'gpt-4o'],
] as const)('does not send tool_stream for %s', async (_name, baseUrl, stream, includeTools, model) => {
  process.env.OPENAI_BASE_URL = baseUrl
  process.env.OPENAI_API_KEY = 'sk-test'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    if (stream) {
      return makeSseResponse(makeStreamChunks([
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ]))
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model,
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: includeTools
      ? [
          {
            name: 'Bash',
            description: 'Run a shell command',
            input_schema: {
              type: 'object',
              properties: { command: { type: 'string' } },
              required: ['command'],
            },
          },
        ]
      : undefined,
    max_tokens: 64,
    stream,
  })

  expect(requestBody?.tool_stream).toBeUndefined()
})
// openaiShim test extraction seam 176 end


// openaiShim test extraction seam 177 start: strips Anthropic attribution header block from chat-completions system prompt (#607)
test('strips Anthropic attribution header block from chat-completions system prompt (#607)', async () => {
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'gpt-4o',
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-4o',
    system: [
      {
        type: 'text',
        text:
          'x-anthropic-billing-header: cc_version=0.8.0.abc123; ' +
          'cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are Claude Code, helpful assistant.' },
      { type: 'text', text: 'Project context: bun + react.' },
    ],
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  const messages = capturedBody?.messages as Array<{ role: string; content: string }>
  const sysMsg = messages.find(m => m.role === 'system')
  expect(sysMsg).toBeDefined()
  expect(sysMsg?.content).not.toContain('x-anthropic-billing-header')
  expect(sysMsg?.content).not.toContain('cc_version=')
  expect(sysMsg?.content).toContain('You are Claude Code, helpful assistant.')
  expect(sysMsg?.content).toContain('Project context: bun + react.')
})
// openaiShim test extraction seam 177 end


// openaiShim test extraction seam 178 start: strips Anthropic attribution header block from responses-API instructions (#607)
test('strips Anthropic attribution header block from responses-API instructions (#607)', async () => {
  process.env.OPENAI_API_FORMAT = 'responses'
  let capturedBody: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>

    return new Response(
      JSON.stringify({
        id: 'resp-1',
        model: 'gpt-5.4',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ defaultHeaders: {} }) as OpenAIShimClient

  await client.beta.messages.create({
    model: 'gpt-5.4',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cc_version=0.8.0.abc123; cc_entrypoint=cli;',
      },
      { type: 'text', text: 'You are Claude Code.' },
    ],
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 64,
    stream: false,
  })

  const instructions = capturedBody?.instructions as string
  expect(instructions).not.toContain('x-anthropic-billing-header')
  expect(instructions).not.toContain('cc_version=')
  expect(instructions).toContain('You are Claude Code.')
})
// openaiShim test extraction seam 181 end


// openaiShim test extraction seam 182 start: DeepSeek: redacted_thinking block preserves continuity with reasoning_content: ""
test('DeepSeek: redacted_thinking block preserves continuity with reasoning_content: ""', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'deepseek-chat',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-chat',
    system: 'test',
    messages: [
      { role: 'user', content: 'analyze this' },
      {
        role: 'assistant',
        content: [
          // real redacted_thinking shape: content lives in `.data`, not `.thinking`
          { type: 'redacted_thinking', data: '', signature: 'sig123' },
          { type: 'text', text: 'Analysis complete.' },
          {
            type: 'tool_use',
            id: 'call_redacted_1',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_redacted_1', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  // redacted_thinking is recognized as a thinking block; its .data is "" and the
  // message carries a tool_call, so it falls back to reasoning_content: ""
  expect(assistantWithToolCall?.reasoning_content).toBe('')
})
// openaiShim test extraction seam 182 end


// openaiShim test extraction seam 183 start: DeepSeek: redacted_thinking block with non-empty data propagates data into reasoning_content
test('DeepSeek: redacted_thinking block with non-empty data propagates data into reasoning_content', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.OPENAI_API_KEY = 'sk-deepseek'

  let requestBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (_input, init) => {
    requestBody = JSON.parse(String(init?.body))
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-2',
        model: 'deepseek-chat',
        choices: [
          { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'deepseek-chat',
    system: 'test',
    messages: [
      { role: 'user', content: 'analyze this' },
      {
        role: 'assistant',
        content: [
          // real redacted_thinking with content in .data
          {
            type: 'redacted_thinking',
            data: 'encrypted_chain_of_thought_payload_v1',
            signature: 'sig456',
          },
          { type: 'text', text: 'Analysis complete.' },
          {
            type: 'tool_use',
            id: 'call_redacted_2',
            name: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_redacted_2', content: 'files' },
        ],
      },
    ],
    max_tokens: 32,
    stream: false,
  })

  const messages = requestBody?.messages as Array<Record<string, unknown>>
  const assistantWithToolCall = messages.find(
    m => m.role === 'assistant' && Array.isArray(m.tool_calls),
  )
  expect(assistantWithToolCall).toBeDefined()
  // The real .data payload must be preserved in reasoning_content — this is the
  // case the original test missed (it used a synthetic .thinking field).
  expect(assistantWithToolCall?.reasoning_content).toBe(
    'encrypted_chain_of_thought_payload_v1',
  )
})
// openaiShim test extraction seam 183 end


// openaiShim test extraction seam 184 start: renders tool_reference blocks as text on the chat/completions path
test('renders tool_reference blocks as text on the chat/completions path', async () => {
  const { __test } = await import('./openaiShim.ts')

  const messages = __test.convertMessages(
    [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_ts1', name: 'ToolSearch', input: { query: 'memory' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_ts1',
            content: [
              { type: 'tool_reference', tool_name: 'mcp__example__memory_search' },
              { type: 'tool_reference', tool_name: 'mcp__example__memory_store' },
            ],
          },
        ],
      },
    ],
    undefined,
  )

  const toolMsg = messages.find(m => m.role === 'tool')
  expect(toolMsg).toBeDefined()
  // The rendering contract is plain text: text-only parts collapse to a string.
  expect(typeof toolMsg!.content).toBe('string')
  const content = toolMsg!.content as string
  expect(content).toContain('mcp__example__memory_search')
  expect(content).toContain('mcp__example__memory_store')
})
// openaiShim test extraction seam 184 end


// openaiShim test extraction seam 185 start: preserves valid tool pairs after history pruning while dropping orphaned tool calls
test('preserves valid tool pairs after history pruning while dropping orphaned tool calls', async () => {
  const { __test } = await import('./openaiShim.ts')

  const messages = __test.convertMessages(
    [
      { role: 'user', content: 'compacted summary of previous work' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'call_pruned_without_result',
            name: 'Read',
            input: { file_path: 'old.ts' },
          },
        ],
      },
      { role: 'user', content: 'continue with retained context' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading the current file.' },
          {
            type: 'tool_use',
            id: 'call_retained',
            name: 'Read',
            input: { file_path: 'current.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_retained',
            content: 'current contents',
          },
        ],
      },
    ],
    undefined,
  )

  const toolCalls = messages.flatMap(message => message.tool_calls ?? [])
  expect(toolCalls.map(toolCall => toolCall.id)).toEqual(['call_retained'])

  const toolMessages = messages.filter(message => message.role === 'tool')
  expect(toolMessages).toHaveLength(1)
  expect(toolMessages[0]?.tool_call_id).toBe('call_retained')
})
// openaiShim test extraction seam 185 end


// Extraction boundary: history pruning | executor Copilot refresh behavior.
// The contiguous Copilot authentication retry block below moves with execution.
// Keep this marker stable for independent adjacent test migrations.
function makeCodexSseResponse(responseData: Record<string, unknown>): Response {
  const data = JSON.stringify(responseData)
  return makeSseResponse([`event: response.completed\ndata: ${data}\n\n`])
}


test('GitHub Copilot responses fallback does not replay after a pre-header timeout', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'test-token'
  process.env.API_TIMEOUT_MS = '20'
  const requestUrls: string[] = []

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requestUrls.push(url)
    if (url.endsWith('/chat/completions')) {
      return makeGithubChatFallbackResponse()
    }
    return pendingFetchUntilAbort(init)
  }) as unknown as FetchType

  const safety = new AbortController()
  const safetyTimer = setTimeout(() => safety.abort(), 500)
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  let caught: unknown
  try {
    await waitForPromise(
      client.beta.messages.create(
        {
          model: 'gpt-4',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 32,
          stream: false,
        },
        { signal: safety.signal },
      ),
      750,
      'GitHub responses fallback timeout did not settle',
    )
  } catch (error) {
    caught = error
  } finally {
    clearTimeout(safetyTimer)
  }

  expect(caught).toBeDefined()
  const error = caught as Error & { constructor: { name: string } }
  expect(error.constructor.name).toBe('APIConnectionError')
  expect(isOpenAIRequestNonReplayable(error)).toBe(true)
  expect(requestUrls).toEqual([
    'https://api.githubcopilot.com/chat/completions',
    'https://api.githubcopilot.com/responses',
  ])
})

test('GitHub Copilot responses fallback preserves caller abort without retrying', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'test-token'
  process.env.API_TIMEOUT_MS = '200'
  let fetchCalls = 0

  globalThis.fetch = (async (input, init) => {
    fetchCalls++
    if (String(input).endsWith('/chat/completions')) {
      return makeGithubChatFallbackResponse()
    }
    return pendingFetchUntilAbort(init)
  }) as unknown as FetchType

  const caller = new AbortController()
  const callerReason = new DOMException('Cancelled by user', 'AbortError')
  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const request = client.beta.messages.create(
    {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    },
    { signal: caller.signal },
  )
  setTimeout(() => caller.abort(callerReason), 10)

  await expect(
    waitForPromise(request, 500, 'GitHub responses fallback abort did not settle'),
  ).rejects.toBe(callerReason)
  expect(fetchCalls).toBe(2)
})

test('GitHub Copilot responses fallback preserves non-caller transport aborts', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'test-token'
  let fetchCalls = 0
  const transportAbort = new DOMException('Proxy aborted request', 'AbortError')

  globalThis.fetch = (async input => {
    fetchCalls++
    if (String(input).endsWith('/chat/completions')) {
      return makeGithubChatFallbackResponse()
    }
    throw transportAbort
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toBe(transportAbort)
  expect(fetchCalls).toBe(2)
})

test('GitHub Copilot responses fallback does not retry non-retryable HTTP failures', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'test-token'
  let fetchCalls = 0

  globalThis.fetch = (async input => {
    fetchCalls++
    if (String(input).endsWith('/chat/completions')) {
      return makeGithubChatFallbackResponse()
    }
    return new Response(
      JSON.stringify({ error: { message: 'invalid token' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toMatchObject({ status: 401 })
  expect(fetchCalls).toBe(2)
})
// openaiShim test extraction seam 186 end


// openaiShim test extraction seam 187 start: GitHub Copilot 401 codex_responses retries with refreshed token
// openaiShim test extraction seam 193 end


// Extraction boundary: executor Copilot refresh behavior | JSON fallback conversion.
// JSON fallback response conversion below is not owned by request execution.
// Keep this marker stable for independent adjacent test migrations.
// --- JSON fallback regression tests (#1749) -------------------------------
// Some OpenAI-compatible providers ignore `stream: true` and return a full
// `application/json` chat completion. The fallback inside
// openaiStreamToAnthropic must route that response through the same
// non-streaming converter so tool_calls, Anthropic stop reasons, array
// content, and <think> stripping are all preserved (jatmn CHANGES_REQUESTED).

function makeJsonChatCompletion(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

async function collectFallbackEvents(
  body: Record<string, unknown>,
  model = 'fake-model',
): Promise<Array<Record<string, unknown>>> {
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => makeJsonChatCompletion(body)) as unknown as FetchType
  try {
    const client = createOpenAIShimClient({}) as OpenAIShimClient
    const result = await client.beta.messages
      .create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 64,
        stream: true,
      })
      .withResponse()
    const events: Array<Record<string, unknown>> = []
    for await (const event of result.data) {
      events.push(event)
    }
    return events
  } finally {
    // Restore so the global fetch stub does not leak past this helper.
    globalThis.fetch = previousFetch
  }
}
// openaiShim test extraction seam 200 end

// openaiShim test extraction seam 201 start: JSON fallback: recovers Tencent HY3 text tool calls into tool_use blocks
test('JSON fallback: recovers Tencent HY3 text tool calls into tool_use blocks', async () => {
  const events = await collectFallbackEvents({
    id: 'chatcmpl-json-hy3',
    model: 'tencent/hy3',
    choices: [
      {
        message: {
          role: 'assistant',
          content:
            '<tool_call:call_hy3>TaskCreate\n subject: Verify HY3\n description: Run the live test\n</tool_call:call_hy3>',
        },
        finish_reason: 'stop',
      },
    ],
  }, 'tencent/hy3')
  const toolStart = events.find(
    event =>
      event.type === 'content_block_start' &&
      typeof event.content_block === 'object' &&
      event.content_block !== null &&
      (event.content_block as Record<string, unknown>).type === 'tool_use',
  ) as { content_block?: Record<string, unknown> } | undefined
  expect(toolStart?.content_block).toMatchObject({
    type: 'tool_use',
    name: 'TaskCreate',
  })
  const jsonDelta = events.find(
    event =>
      event.type === 'content_block_delta' &&
      typeof event.delta === 'object' &&
      event.delta !== null &&
      (event.delta as Record<string, unknown>).type === 'input_json_delta',
  ) as { delta?: { partial_json?: string } } | undefined
  expect(JSON.parse(jsonDelta?.delta?.partial_json ?? '')).toEqual({
    subject: 'Verify HY3',
    description: 'Run the live test',
  })
  const stopEvent = events.find(e => e.type === 'message_delta') as
    | { delta?: { stop_reason?: string } }
    | undefined
  expect(stopEvent?.delta?.stop_reason).toBe('tool_use')
})
// openaiShim test extraction seam 204 end
