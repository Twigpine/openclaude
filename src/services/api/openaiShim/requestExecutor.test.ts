import { APIError } from '@anthropic-ai/sdk'
import { afterEach, beforeEach, expect, jest, mock, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../../test/sharedMutationLock.js'
import { asMockFetch } from '../../../test/typedMocks.js'
import { _clearRegistryForTesting, ensureIntegrationsLoaded, registerGateway } from '../../../integrations/index.ts'
import { applyProviderFlag } from '../../../utils/providerFlag.ts'
import { applyProviderProfileToProcessEnv } from '../../../utils/providerProfiles.ts'
import {
  getAssistantMessageFromError,
  OPENCODE_GO_FREE_LIMIT_ERROR_MESSAGE,
} from '../errors.ts'
import { createOpenAIShimClient, hasMistralApiHost } from '../openaiShim.ts'
import { formatRetryAfterHint, sleepMs } from './requestExecutor.js'
import * as realGithubModelsCredentials from '../../../utils/githubModelsCredentials.js'

type FetchType = typeof globalThis.fetch

const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  LLMTR_API_KEY: process.env.LLMTR_API_KEY,
  API_ROUTE_API_KEY: process.env.API_ROUTE_API_KEY,
  CMD_API_KEY: process.env.CMD_API_KEY,
  COMMANDCODE_API_KEY: process.env.COMMANDCODE_API_KEY,
  COMMAND_CODE_API_KEY: process.env.COMMAND_CODE_API_KEY,
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
  CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
  CONCENTRATE_BASE_URL: process.env.CONCENTRATE_BASE_URL,
  CONCENTRATE_MODEL: process.env.CONCENTRATE_MODEL,
  OPENGATEWAY_API_KEY: process.env.OPENGATEWAY_API_KEY,
  OPENGATEWAY_BASE_URL: process.env.OPENGATEWAY_BASE_URL,
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED: process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID: process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  CLAUDE_STREAM_IDLE_TIMEOUT_MS: process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS,
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
): Promise<typeof import('../openaiShim.ts')> {
  return import(`../openaiShim.ts?${cacheKey}`)
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

async function captureChatCompletionRequest(
  model = 'mimo-v2.5-pro',
  defaultHeaders: Record<string, string> = {},
): Promise<{
  authorization: string | null
  headers: Record<string, string>
  url: string | null
}> {
  let authorization: string | null = null
  let headers: Record<string, string> = {}
  let url: string | null = null

  globalThis.fetch = (async (input, init) => {
    url = String(input)
    headers = (init?.headers as Record<string, string> | undefined) ?? {}
    authorization = headers.Authorization ?? headers.authorization ?? null

    return makeChatCompletionResponse(model)
  }) as unknown as FetchType

  const client = createOpenAIShimClient({ defaultHeaders }) as OpenAIShimClient

  await client.beta.messages.create({
    model,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  return { authorization, headers, url }
}

function makeCodexSseResponse(responseData: Record<string, unknown>): Response {
  const data = JSON.stringify(responseData)
  return makeSseResponse([`event: response.completed\ndata: ${data}\n\n`])
}

beforeEach(async () => {
  await acquireSharedMutationLock('openaiShim.test.ts')
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  delete process.env.OPENAI_API_BASE
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_API_KEYS
  delete process.env.LLMTR_API_KEY
  delete process.env.API_ROUTE_API_KEY
  delete process.env.CMD_API_KEY
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.COMMAND_CODE_API_KEY
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
  delete process.env.CONCENTRATE_API_KEY
  delete process.env.CONCENTRATE_BASE_URL
  delete process.env.CONCENTRATE_MODEL
  delete process.env.OPENGATEWAY_API_KEY
  delete process.env.OPENGATEWAY_BASE_URL
  delete process.env.OPENCODE_API_KEY
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS
})

afterEach(() => {
  try {
    mock.restore()
    jest.useRealTimers()
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_BASE', originalEnv.OPENAI_API_BASE)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_API_KEYS', originalEnv.OPENAI_API_KEYS)
    restoreEnv('LLMTR_API_KEY', originalEnv.LLMTR_API_KEY)
    restoreEnv('API_ROUTE_API_KEY', originalEnv.API_ROUTE_API_KEY)
    restoreEnv('CMD_API_KEY', originalEnv.CMD_API_KEY)
    restoreEnv('COMMANDCODE_API_KEY', originalEnv.COMMANDCODE_API_KEY)
    restoreEnv('COMMAND_CODE_API_KEY', originalEnv.COMMAND_CODE_API_KEY)
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
    restoreEnv('CONCENTRATE_API_KEY', originalEnv.CONCENTRATE_API_KEY)
    restoreEnv('CONCENTRATE_BASE_URL', originalEnv.CONCENTRATE_BASE_URL)
    restoreEnv('CONCENTRATE_MODEL', originalEnv.CONCENTRATE_MODEL)
    restoreEnv('OPENGATEWAY_API_KEY', originalEnv.OPENGATEWAY_API_KEY)
    restoreEnv('OPENGATEWAY_BASE_URL', originalEnv.OPENGATEWAY_BASE_URL)
    restoreEnv('OPENCODE_API_KEY', originalEnv.OPENCODE_API_KEY)
    restoreEnv('CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED', originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED)
    restoreEnv('CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID', originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID)
    restoreEnv('CLAUDE_STREAM_IDLE_TIMEOUT_MS', originalEnv.CLAUDE_STREAM_IDLE_TIMEOUT_MS)
    globalThis.fetch = originalFetch
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  } finally {
    releaseSharedMutationLock()
  }
})


test('gitlawb opengateway provider flag prefers OPENGATEWAY_API_KEY over generic OPENAI_API_KEYS pool', async () => {
  process.env.OPENGATEWAY_BASE_URL = 'http://localhost:8181/v1'
  process.env.OPENGATEWAY_API_KEY = 'fake-ogw-key'
  process.env.OPENAI_API_KEYS = 'fake-openai-pool-a,fake-openai-pool-b'
  delete process.env.OPENAI_API_KEY

  const result = applyProviderFlag('gitlawb-opengateway', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('http://localhost:8181/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-ogw-key')
})

test('Concentrate selection prefers its dedicated key over a generic OPENAI_API_KEYS pool', async () => {
  process.env.CONCENTRATE_API_KEY = 'concentrate-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-key-a,generic-openai-key-b'
  delete process.env.OPENAI_API_KEY

  const result = applyProviderFlag('concentrate', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('https://api.concentrate.ai/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer concentrate-key')
})

test('API Route selection prefers its dedicated key over a generic OPENAI_API_KEYS pool', async () => {
  process.env.API_ROUTE_API_KEY = 'api-route-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-key-a,generic-openai-key-b'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('api-route', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest('claude-sonnet-4-6')

  expect(captured.url).toBe('https://global.api-route.com/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer api-route-key')
})

test('selected LLMTR route sends LLMTR_API_KEY through the generic route credential resolver', async () => {
  process.env.LLMTR_API_KEY = 'llmtr-key'
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('llmtr', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
  )

  expect(captured.url).toBe('https://llmtr.com/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer llmtr-key')
})

test('selected LLMTR route prefers its dedicated key over a generic OPENAI_API_KEYS pool', async () => {
  process.env.LLMTR_API_KEY = 'llmtr-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-key-a,generic-openai-key-b'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('llmtr', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
  )

  expect(captured.authorization).toBe('Bearer llmtr-key')
})

test('selected Command Code route sends CMD_API_KEY through the generic route credential resolver', async () => {
  process.env.CMD_API_KEY = 'cmd-key'
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('commandcode', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
  )

  expect(captured.url).toBe(
    'https://api.commandcode.ai/provider/v1/chat/completions',
  )
  expect(captured.authorization).toBe('Bearer cmd-key')
})

test('selected Command Code route accepts the official client credential variable', async () => {
  process.env.COMMAND_CODE_API_KEY = 'official-key'
  delete process.env.CMD_API_KEY
  delete process.env.COMMANDCODE_API_KEY
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('commandcode', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
  )

  expect(captured.authorization).toBe('Bearer official-key')
})

test('selected Command Code route prefers CMD_API_KEY over a generic OPENAI_API_KEYS pool', async () => {
  process.env.CMD_API_KEY = 'cmd-key'
  process.env.OPENAI_API_KEYS = 'generic-openai-key-a,generic-openai-key-b'
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  const result = applyProviderFlag('commandcode', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
  )

  expect(captured.authorization).toBe('Bearer cmd-key')
})

test('Command Code rejects Anthropic-only models before sending a request', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
  process.env.OPENAI_MODEL = 'anthropic/claude-sonnet-4-6'
  process.env.CMD_API_KEY = 'cmd-key'
  delete process.env.OPENAI_API_KEY

  const fetchMock = mock(() => Promise.resolve(makeChatCompletionResponse('unused')))
  globalThis.fetch = asMockFetch(fetchMock)
  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const requestPromise = client.beta.messages.create({
    model: 'anthropic/claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  await expect(requestPromise).rejects.toMatchObject({ status: 400 })
  await expect(requestPromise).rejects.toThrow(
    'requires the Anthropic Messages protocol',
  )
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each(['sonnet', 'sonnet?reasoning=high'])(
  'Command Code rejects Claude alias %s before sending a request',
  async rejectedModel => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    process.env.OPENAI_MODEL = rejectedModel
    process.env.CMD_API_KEY = 'cmd-key'
    delete process.env.OPENAI_API_KEY

    const fetchMock = mock(() =>
      Promise.resolve(makeChatCompletionResponse('unused')),
    )
    globalThis.fetch = asMockFetch(fetchMock)
    const client = createOpenAIShimClient({}) as OpenAIShimClient

    const requestPromise = client.beta.messages.create({
      model: rejectedModel,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    await expect(requestPromise).rejects.toMatchObject({ status: 400 })
    await expect(requestPromise).rejects.toThrow(
      'requires the Anthropic Messages protocol',
    )
    expect(fetchMock).not.toHaveBeenCalled()
  },
)

test('raw-env LLMTR ignores unsupported custom auth and custom headers', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://llmtr.com/v1'
  process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash'
  process.env.LLMTR_API_KEY = 'llmtr-key'
  process.env.OPENAI_AUTH_HEADER = 'X-Proxy-Key'
  process.env.OPENAI_AUTH_SCHEME = 'raw'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'proxy-secret'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant-Secret: tenant-secret'
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_API_KEY

  const captured = await captureChatCompletionRequest(
    'deepseek/deepseek-v4-flash',
    { 'X-Tenant-Secret': 'tenant-secret' },
  )

  expect(captured.url).toBe('https://llmtr.com/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer llmtr-key')
  expect(captured.headers['X-Proxy-Key']).toBeUndefined()
  expect(captured.headers['X-Tenant-Secret']).toBeUndefined()
})

test('custom endpoints preserve configured auth and custom headers', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://proxy.example/v1'
  process.env.OPENAI_MODEL = 'proxy-model'
  process.env.LLMTR_API_KEY = 'llmtr-key'
  process.env.OPENAI_AUTH_HEADER = 'X-Proxy-Key'
  process.env.OPENAI_AUTH_SCHEME = 'raw'
  process.env.OPENAI_AUTH_HEADER_VALUE = 'proxy-secret'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Tenant-Secret: tenant-secret'
  delete process.env.OPENAI_API_KEYS
  delete process.env.OPENAI_API_KEY

  const captured = await captureChatCompletionRequest('proxy-model', {
    'X-Tenant-Secret': 'tenant-secret',
  })

  expect(captured.url).toBe('https://proxy.example/v1/chat/completions')
  expect(captured.authorization).toBeNull()
  expect(captured.headers['X-Proxy-Key']).toBe('proxy-secret')
  expect(captured.headers['X-Tenant-Secret']).toBe('tenant-secret')
})

test('gitlawb opengateway provider flag uses generic OPENAI_API_KEYS pool before generic OPENAI_API_KEY fallback', async () => {
  process.env.OPENGATEWAY_BASE_URL = 'http://localhost:8181/v1'
  process.env.OPENAI_API_KEYS = 'fake-openai-pool-a,fake-openai-pool-b'
  process.env.OPENAI_API_KEY = 'fake-generic-openai-key'
  delete process.env.OPENGATEWAY_API_KEY

  const result = applyProviderFlag('gitlawb-opengateway', [])
  expect(result.error).toBeUndefined()

  const captured = await captureChatCompletionRequest()

  expect(captured.url).toBe('http://localhost:8181/v1/chat/completions')
  expect(captured.authorization).toBe('Bearer fake-openai-pool-a')
})

test('OPENAI_API_KEYS rejects placeholder values before sending requests', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,SUA_CHAVE'
  process.env.OPENAI_API_KEY = 'single-key-should-not-hide-invalid-pool'

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow(/invalid credential placeholder|Authentication failed/)

  expect(authorizations).toEqual([])
})

test('OPENAI_API_KEYS rotates to the next key on rate-limit failure', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  process.env.OPENAI_API_KEY = 'single-key-should-not-win'

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    if (authorizations.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('GitHub 429 cools the active pooled credential before retrying', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://models.github.ai/inference'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    if (authorizations.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('GitHub 429 stops when every pooled credential is cooling down', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://models.github.ai/inference'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow('rate limited')

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('GitHub 429 does not retry a cooled key after a concurrent request cools the pool', async () => {
  const authorizations: Array<string | null> = []
  let markFirstRequestStarted: (() => void) | undefined
  const firstRequestStarted = new Promise<void>(resolve => {
    markFirstRequestStarted = resolve
  })
  let markFirstResponseBodyRead: (() => void) | undefined
  const firstResponseBodyRead = new Promise<void>(resolve => {
    markFirstResponseBodyRead = resolve
  })

  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://models.github.ai/inference'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    if (authorizations.length === 1) {
      markFirstRequestStarted?.()
    }
    return {
      ok: false,
      status: 429,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: () => {
        if (authorizations.length === 1) {
          markFirstResponseBodyRead?.()
        }
        return Promise.resolve(JSON.stringify({ error: { message: 'rate limited' } }))
      },
    } as unknown as Response
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  const createRequest = () => client.beta.messages.create({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  jest.useFakeTimers()
  try {
    const firstRequest = createRequest()
    await firstRequestStarted
    // The first body read happens after it cools key-a. Once it resolves, the
    // request synchronously schedules its backoff in the next microtask.
    await firstResponseBodyRead
    for (let tick = 0; tick < 8 && jest.getTimerCount() === 0; tick++) {
      await Promise.resolve()
    }
    expect(jest.getTimerCount()).toBe(1)

    const secondRequest = createRequest()
    await expect(secondRequest).rejects.toThrow('rate limited')

    jest.advanceTimersByTime(1_000)
    await expect(firstRequest).rejects.toThrow('rate limited')
    expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
  } finally {
    jest.useRealTimers()
  }
})

test('OPENAI_API_KEYS does not reuse a cooled-down key after every key is rate-limited', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('comma-separated OPENAI_API_KEY rotates to the next key on rate-limit failure', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEY = 'key-a,key-b'
  delete process.env.OPENAI_API_KEYS

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    if (authorizations.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('OPENAI_API_KEYS does not rotate through pool on provider 5xx outage', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    return new Response(JSON.stringify({ error: { message: 'server error' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  expect(authorizations).toEqual(['Bearer key-a'])
})

test('OPENAI_API_KEYS preserves cooldown state across client requests', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    if (authorizations.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  for (let i = 0; i < 2; i++) {
    await client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })
  }

  expect(authorizations).toEqual([
    'Bearer key-a',
    'Bearer key-b',
    'Bearer key-b',
  ])
})

test('OPENAI_API_KEYS rotates Azure api-key auth on auth failure', async () => {
  const apiKeys: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://example.openai.azure.com/openai/deployments/test/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'azure-key-a,azure-key-b'

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    apiKeys.push(headers?.['api-key'] ?? null)

    if (apiKeys.length === 1) {
      return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    return makeChatCompletionResponse('gpt-5.5')
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 32,
    stream: false,
  })

  expect(apiKeys).toEqual(['azure-key-a', 'azure-key-b'])
})

test('OPENAI_API_KEYS does not reuse auth-disabled credentials across client requests', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello again' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('OPENAI_API_KEYS permanently evicts 403 auth failures', async () => {
  const authorizations: Array<string | null> = []

  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)

    return new Response(JSON.stringify({ error: { message: 'forbidden' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  await expect(
    client.beta.messages.create({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hello again' }],
      max_tokens: 32,
      stream: false,
    }),
  ).rejects.toThrow()

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-b'])
})

test('strips credentials and query params from URL in fetch network error message', async () => {
  process.env.OPENAI_BASE_URL =
    'https://user:password@internal.example.test/v1?token=abc123'
  process.env.OPENAI_API_KEY = 'test-key'

  globalThis.fetch = asMockFetch(mock(async () => {
    throw new TypeError(
      'fetch failed https://user:password@internal.example.test/v1?token=abc123/chat/completions',
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

  const message = (caught as Error).message
  expect(message).toContain('internal.example.test')
  expect(message).toContain('fetch failed')
  expect(message).not.toContain('password')
  expect(message).not.toContain('user:')
  expect(message).not.toContain('token=abc123')
})

test('redacts configured secrets from HTTP error messages', async () => {
  process.env.OPENAI_API_KEY = 'super-secret-key'

  globalThis.fetch = asMockFetch(mock(async () => new Response(
    JSON.stringify({ error: { message: 'upstream rejected super-secret-key' } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  )))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  const error = await client.beta.messages
    .create({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    })
    .then(
      () => undefined,
      (caught: unknown) => caught as Error,
    )

  expect(error?.message).toContain('upstream rejected')
  expect(error?.message).not.toContain('super-secret-key')
})

test('classifies localhost transport failures with actionable category marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ECONNREFUSED',
  })

  globalThis.fetch = asMockFetch(mock(async () => {
    throw transportError
  }))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=connection_refused')

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('local server is running')
})

test('transport failures are not labeled with HTTP status 503', async () => {
  // Issue #971: ENETDOWN (and other transport errors) are emitted before any
  // HTTP response is received. Reporting them as "503" makes users believe the
  // upstream server returned 503 Service Unavailable.
  process.env.OPENAI_BASE_URL = 'https://intranet.example.test/v1'

  const transportError = Object.assign(new TypeError('fetch failed'), {
    code: 'ENETDOWN',
  })

  globalThis.fetch = asMockFetch(mock(async () => {
    throw transportError
  }))

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
  }

  expect(caught).toBeDefined()
  const err = caught as { status?: number; message: string; constructor: { name: string } }
  expect(err.constructor.name).toBe('APIConnectionError')
  expect(err.status).toBeUndefined()
  expect(err.message).not.toMatch(/^503\b/)
  expect(err.message).toContain('OpenAI API transport error')
  expect(err.message).toContain('code=ENETDOWN')
  expect(err.message).toContain('openai_category=network_error')
})

test('propagates AbortError without wrapping it as transport failure', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const abortError = new DOMException('The operation was aborted.', 'AbortError')
  globalThis.fetch = asMockFetch(mock(async () => {
    throw abortError
  }))

  const controller = new AbortController()
  controller.abort()

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
  ).rejects.toBe(controller.signal.reason)
})

test('classifies chat-completions endpoint 404 failures with endpoint_not_found marker', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'

  globalThis.fetch = asMockFetch(mock(async () =>
    new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain',
      },
    })))

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await expect(
    client.beta.messages.create({
      model: 'qwen2.5-coder:7b',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    }),
  ).rejects.toThrow('openai_category=endpoint_not_found')
})

test('self-heals localhost resolution failures by retrying local loopback base URL', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'

  const requestUrls: string[] = []
  globalThis.fetch = (async (input, _init) => {
    const url = typeof input === 'string' ? input : input.url
    requestUrls.push(url)

    if (url.includes('localhost')) {
      const error = Object.assign(new TypeError('fetch failed'), {
        code: 'ENOTFOUND',
      })
      throw error
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'hello from loopback',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
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

  expect(requestUrls[0]).toBe('http://localhost:11434/api/chat')
  expect(requestUrls).toContain('http://127.0.0.1:11434/api/chat')
})

test('self-heals tool-call incompatibility by retrying local Ollama requests without tools', async () => {
  // A direct loopback address has no alternate retry base, so this verifies
  // the recovery reserves its own second request rather than relying on URL
  // fallback attempts.
  process.env.OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1'

  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestBodies.push(requestBody)

    if (requestBodies.length === 1) {
      return new Response('tool_calls are not supported', {
        status: 400,
        headers: {
          'Content-Type': 'text/plain',
        },
      })
    }

    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'fallback without tools',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
        },
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
      tools: [
        {
          name: 'Read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
            },
            required: ['filePath'],
          },
        },
      ],
      max_tokens: 64,
      stream: false,
    }),
  ).resolves.toBeDefined()

  expect(requestBodies).toHaveLength(2)
  expect(Array.isArray(requestBodies[0]?.tools)).toBe(true)
  expect(requestBodies[0]?.tool_choice).toBeUndefined()
  expect(
    requestBodies[1]?.tools === undefined ||
      (Array.isArray(requestBodies[1]?.tools) && requestBodies[1]?.tools.length === 0),
  ).toBe(true)
  expect(requestBodies[1]?.tool_choice).toBeUndefined()
  expect(requestBodies[1]?.tool_stream).toBeUndefined()
})

test('reuses the pooled credential for a local toolless retry', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  const authorizations: Array<string | null> = []
  let callCount = 0
  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    callCount += 1
    if (callCount === 1) {
      return new Response('tool_calls are not supported', {
        status: 400,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-1',
        model: 'qwen2.5-coder:7b',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'qwen2.5-coder:7b',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { filePath: { type: 'string' } } },
    }],
    max_tokens: 64,
    stream: false,
  })

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-a'])
})

test('Shim self-heals a JSON `tool_stream` rejection by retrying without it (#1950)', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const requestBodies: Array<Record<string, unknown>> = []
  let callCount = 0
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)))
    callCount += 1
    if (callCount === 1) {
      return new Response(
        '{"error":{"message":"tool_stream is unsupported"}}',
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]))
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  // Must not throw — the self-heal retry succeeds.
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [
      {
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      },
    ],
    max_tokens: 64,
    stream: true,
  })

  // First attempt sent tool_stream; the self-heal dropped it and retried.
  expect(requestBodies).toHaveLength(2)
  expect(requestBodies[0]?.tool_stream).toBe(true)
  expect(requestBodies[1]?.tool_stream).toBeUndefined()
  // Tools are preserved across the retry.
  expect(Array.isArray(requestBodies[1]?.tools)).toBe(true)
})

test('Shim stops after one tool_stream self-heal retry when the retry also fails (#1950)', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const requestBodies: Array<Record<string, unknown>> = []
  globalThis.fetch = (async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)))
    return new Response(
      '{"error":{"message":"tool_stream is unsupported"}}',
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(
    client.beta.messages.create({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'run pwd' }],
      tools: [{
        name: 'Bash',
        description: 'Run a shell command',
        input_schema: {
          type: 'object',
          properties: { command: { type: 'string' } },
          required: ['command'],
        },
      }],
      max_tokens: 64,
      stream: true,
    }),
  ).rejects.toThrow()

  expect(requestBodies).toHaveLength(2)
  expect(requestBodies[0]?.tool_stream).toBe(true)
  expect(requestBodies[1]?.tool_stream).toBeUndefined()
})

test('Shim retries a tool_stream rejection with the same pooled credential (#1950)', async () => {
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY

  const authorizations: Array<string | null> = []
  let callCount = 0
  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    authorizations.push(headers?.Authorization ?? headers?.authorization ?? null)
    callCount += 1
    if (callCount === 1) {
      return new Response(
        '{"error":{"message":"Validation: Unsupported parameter(s): `tool_stream`"}}',
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    return makeSseResponse(makeStreamChunks([
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        model: 'glm-5.2',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
    ]))
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'glm-5.2',
    messages: [{ role: 'user', content: 'run pwd' }],
    tools: [{
      name: 'Bash',
      description: 'Run a shell command',
      input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    }],
    max_tokens: 64,
    stream: true,
  })

  expect(authorizations).toEqual(['Bearer key-a', 'Bearer key-a'])
})


test('strips Anthropic-specific headers on GitHub Codex transport requests', async () => {
  let capturedHeaders: Headers | undefined

  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_API_KEY = 'github-test-key'
  process.env.GITHUB_TOKEN = 'stored-secret'
  delete process.env.GITHUB_COPILOT_KEY
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response('', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient

  await client.beta.messages.create(
    {
      model: 'github:gpt-5-codex',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    {
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'x-anthropic-additional-protection': 'true',
        'x-safe-header': 'keep-me',
      },
    },
  )

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('anthropic-beta')).toBeNull()
  expect(capturedHeaders?.get('x-anthropic-additional-protection')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer github-test-key')
  expect(capturedHeaders?.get('editor-plugin-version')).toBe('copilot-chat/0.26.7')
})


test('strips Anthropic-specific headers on GitHub Codex transport with providerOverride API key', async () => {
  let capturedHeaders: Headers | undefined

  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_API_KEY = 'env-should-not-win'
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_MODEL

  globalThis.fetch = (async (_input, init) => {
    capturedHeaders = new Headers(init?.headers)

    return new Response('', {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
      },
    })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({
    providerOverride: {
      model: 'github:gpt-5-codex',
      baseURL: 'https://api.githubcopilot.com',
      apiKey: 'provider-override-key',
    },
  }) as OpenAIShimClient

  await client.beta.messages.create(
    {
      model: 'ignored',
      system: 'test system',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-claude-remote-session-id': 'remote-123',
        'x-safe-header': 'keep-me',
      },
    },
  )

  expect(capturedHeaders?.get('anthropic-version')).toBeNull()
  expect(capturedHeaders?.get('x-claude-remote-session-id')).toBeNull()
  expect(capturedHeaders?.get('x-safe-header')).toBe('keep-me')
  expect(capturedHeaders?.get('authorization')).toBe('Bearer provider-override-key')
  expect(capturedHeaders?.get('editor-plugin-version')).toBe('copilot-chat/0.26.7')
})

test('GitHub Copilot 401 chat_completions retries with refreshed token', async () => {
  const realModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let firstAuth: string | undefined
    let secondAuth: string | undefined

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      const auth = headers?.Authorization

      if (fetchCallCount === 1) {
        firstAuth = auth
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      if (fetchCallCount === 2) {
        secondAuth = auth
        return Promise.resolve(makeChatCompletionResponse('gpt-4'))
      }

      throw new Error(`unexpected fetch call #${fetchCallCount}`)
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-retry')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(process.env.GITHUB_TOKEN).toBe('refreshed-token')
    expect(process.env.OPENAI_API_KEY).toBe('refreshed-token')
    expect(fetchCallCount).toBe(2)
    expect(firstAuth).toBe('Bearer initial-token')
    expect(secondAuth).toBe('Bearer refreshed-token')
    expect(response).toBeDefined()
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realModule)
  }
})

test('GitHub Copilot 401 with credential pool uses refreshed token not pool key', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    delete process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEYS = 'initial-token,second-key'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let usedAuthHeaders: string[] = []

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      usedAuthHeaders.push(headers?.Authorization ?? '')

      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(makeChatCompletionResponse('gpt-4'))
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-pool')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBe(2)
    expect(usedAuthHeaders[0]).toBe('Bearer initial-token')
    expect(usedAuthHeaders[1]).toBe('Bearer refreshed-token')
    expect(response).toBeDefined()
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot 401 with "token has expired" triggers refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++

      if (fetchCallCount === 1) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: 'token has expired' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }

      return Promise.resolve(makeChatCompletionResponse('gpt-4'))
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-has-expired')

    const client = createClient({}) as OpenAIShimClient

    const response = await client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBe(2)
    expect(response).toBeDefined()
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot 401 without expired-token message does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => true)

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0

    globalThis.fetch = ((_input) => {
      fetchCallCount++
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'invalid token' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-no-refresh')

    const client = createClient({}) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
    expect(fetchCallCount).toBe(1)
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot 401 refresh returning same token does not update auth', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'initial-token'
      process.env.OPENAI_API_KEY = 'initial-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    let fetchCallCount = 0
    let usedAuthHeaders: string[] = []

    globalThis.fetch = ((_input, init) => {
      fetchCallCount++
      const headers = init?.headers as Record<string, string> | undefined
      usedAuthHeaders.push(headers?.Authorization ?? '')

      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-same-token')

    const client = createClient({}) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(fetchCallCount).toBeGreaterThanOrEqual(2)
    expect(usedAuthHeaders.every(h => h === 'Bearer initial-token')).toBe(true)
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot 401 codex_responses with providerOverride does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'stored-copilot-token'
    process.env.GITHUB_TOKEN = 'stored-copilot-token'

    // Mock fetch so performCodexRequest gets a 401 response (no codexShim mock needed)
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-override-codex')

    // providerOverride.apiKey differs from OPENAI_API_KEY → credential source gate blocks refresh
    const client = createClient({
      providerOverride: { model: 'gpt-5', baseURL: 'https://api.githubcopilot.com', apiKey: 'override-token' },
    }) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot 401 chat_completions with providerOverride does not trigger refresh', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })

    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'stored-copilot-token'
    process.env.GITHUB_TOKEN = 'stored-copilot-token'

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      )) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-override-chat')

    // providerOverride.apiKey differs from OPENAI_API_KEY → credential source gate blocks refresh
    const client = createClient({
      providerOverride: { model: 'gpt-4', baseURL: 'https://api.githubcopilot.com', apiKey: 'override-token' },
    }) as OpenAIShimClient

    await expect(
      client.beta.messages.create({
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      }),
    ).rejects.toThrow()

    expect(refreshSpy).toHaveBeenCalledTimes(0)
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

test('GitHub Copilot refreshes a matching providerOverride token', async () => {
  const realGithubModule = realGithubModelsCredentials
  try {
    const refreshSpy = mock(async () => {
      process.env.GITHUB_TOKEN = 'refreshed-token'
      process.env.OPENAI_API_KEY = 'refreshed-token'
      return true
    })
    mock.module('../../../utils/githubModelsCredentials.js', () => ({
      ...realGithubModule,
      refreshCopilotTokenOn401: refreshSpy,
    }))

    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
    process.env.OPENAI_API_KEY = 'initial-token'
    process.env.GITHUB_TOKEN = 'initial-token'

    const authorizations: string[] = []
    globalThis.fetch = ((_input, init) => {
      const headers = init?.headers as Record<string, string> | undefined
      authorizations.push(headers?.Authorization ?? '')
      if (authorizations.length === 1) {
        return Promise.resolve(new Response(
          JSON.stringify({ error: { message: 'token expired' } }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ))
      }
      return Promise.resolve(makeChatCompletionResponse('gpt-4'))
    }) as unknown as typeof globalThis.fetch

    const { createOpenAIShimClient: createClient } =
      await importFreshOpenAIShim('copilot-401-matching-override')
    const client = createClient({
      providerOverride: {
        model: 'gpt-4',
        baseURL: 'https://api.githubcopilot.com',
        apiKey: 'initial-token',
      },
    }) as OpenAIShimClient

    await expect(client.beta.messages.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    })).resolves.toBeDefined()

    expect(refreshSpy).toHaveBeenCalledTimes(1)
    expect(authorizations).toEqual(['Bearer initial-token', 'Bearer refreshed-token'])
  } finally {
    mock.module('../../../utils/githubModelsCredentials.js', () => realGithubModule)
  }
})

// --- retry helper unit tests ------------------------------------------------

test('formats retry guidance from server response headers', () => {
  expect(formatRetryAfterHint(new Response(null, { headers: { 'retry-after': '12' } })))
    .toBe(' (Retry-After: 12)')
  expect(formatRetryAfterHint(new Response())).toBe('')
})

test('waits for the requested retry delay', async () => {
  let scheduledDelay: number | undefined
  let runScheduledCallback: (() => void) | undefined
  let settled = false

  const pending = sleepMs(5, (callback, delay) => {
    scheduledDelay = delay
    runScheduledCallback = callback
  })
  void pending.then(() => {
    settled = true
  })

  expect(scheduledDelay).toBe(5)
  expect(settled).toBe(false)
  runScheduledCallback?.()
  await pending
  expect(settled).toBe(true)
})
