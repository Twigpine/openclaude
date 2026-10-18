import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  BetaMessage,
  BetaMessageStreamParams,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { resetGrowthBook } from '../analytics/growthbook.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { QueryLifecycleOperationTracker } from '../../utils/queryLifecycle.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
} from '../../utils/interruptionTrace.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth.js'
import { enableConfigs } from '../../utils/config.js'
import { SETTING_SOURCES } from '../../utils/settings/constants.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { type Options } from './claude.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import {
  providerModuleIsMocked,
  REAL_PROVIDER_TEST_CHILD_ENV,
  REAL_PROVIDER_TEST_TIMEOUT_MS,
  runTestFileWithRealProviders,
} from '../../test/providerModuleIsolation.js'

// Bun keeps mock.module() registrations process-global across test files.
// Bind request modules only when the canonical provider module is real. When a
// prior file replaced it, run this file in a clean child process instead.
const _realProvidersModule = await import(
  `../../utils/model/providers.js?attributionReal=${Date.now()}-${Math.random()}`
)
const _loadedProvidersModule = await import('src/utils/model/providers.js')
const runInProviderIsolatedChild =
  process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1' &&
  providerModuleIsMocked(_loadedProvidersModule, _realProvidersModule)
type ClaudeModule = typeof import('./claude.js')
let executeNonStreamingRequest!: ClaudeModule['executeNonStreamingRequest']
let queryHaiku!: ClaudeModule['queryHaiku']
let queryModelWithStreaming!: ClaudeModule['queryModelWithStreaming']
if (!runInProviderIsolatedChild) {
  ;({ executeNonStreamingRequest, queryHaiku, queryModelWithStreaming } =
    await import(
      `./claude.js?attributionReal=${Date.now()}-${Math.random()}`
    ))
}

const envKeys = [
  'AIMLAPI_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_FIRST_PARTY_PROXY_HOSTS',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT',
  'ANTHROPIC_UNIX_SOCKET',
  'CLAUDE_CODE_ATTRIBUTION_HEADER',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
  'CLAUDE_DISABLE_STREAM_WATCHDOG',
  'CLAUDE_FEATURE_FLAGS_FILE',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'LONGCAT_API_KEY',
  'MINIMAX_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENCLAUDE_CONFIG_DIR',
  'OPENCLAUDE_INTERRUPT_TRACE',
  'OPENCLAUDE_MAX_RETRIES',
  'VCR_RECORD',
] as const
const originalEnv = { ...process.env }
const originalFetch = globalThis.fetch
const hadSavedMacro = Object.hasOwn(globalThis, 'MACRO')
const savedMacro = (globalThis as Record<string, unknown>).MACRO
const originalNodeEnv = process.env.NODE_ENV
let fixturesRoot: string | undefined

type FetchOverride = NonNullable<Options['fetchOverride']>
type LifecycleSnapshot = ReturnType<QueryLifecycleOperationTracker['snapshot']>
const TEST_STREAM_IDLE_TIMEOUT_MS = 25
const STREAM_IDLE_RECOVERY_ASSERTION_MS = 1_000
const STALLING_STREAM_CLEANUP_MS = 2_000

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'request-id': `req-${status}`,
    },
  })
}

function makeErrorResponse(status: number, message: string): Response {
  return makeJsonResponse(
    {
      type: 'error',
      error: {
        type: 'api_error',
        message,
      },
    },
    status,
  )
}

function makeBetaMessage(): BetaMessage {
  return {
    id: 'msg-lifecycle-test',
    type: 'message',
    role: 'assistant',
    model: 'claude-lifecycle-test',
    content: [],
    container: null,
    context_management: null,
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      ...EMPTY_USAGE,
      input_tokens: 1,
      output_tokens: 1,
    },
  }
}

function makeOpenAIChatCompletionResponse(): Response {
  return makeJsonResponse({
    id: 'chatcmpl-lifecycle-fallback',
    object: 'chat.completion',
    created: 1_771_264_800,
    model: 'gpt-override',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'fallback ok',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  })
}

function makeOpenAIStreamChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-lifecycle-stream',
    object: 'chat.completion.chunk',
    created: 1_771_264_800,
    model: 'glm-5.2',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function makeOpenAIStreamingResponse(): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            makeOpenAIStreamChunk({ role: 'assistant', content: 'ok' }),
          ),
        )
        controller.enqueue(encoder.encode(makeOpenAIStreamChunk({}, 'stop')))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

function makeAnthropicStreamingResponse(): Response {
  const events = [
    {
      event: 'message_start',
      data: { type: 'message_start', message: makeBetaMessage() },
    },
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      },
    },
    {
      event: 'content_block_stop',
      data: { type: 'content_block_stop', index: 0 },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]
  const body = events
    .map(event => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`)
    .join('')
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  })
}

function makeStallingOpenAIStreamResponse(
  onCancel?: (reason: unknown) => void,
): Response {
  const encoder = new TextEncoder()
  let closeTimer: ReturnType<typeof setTimeout> | undefined

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            makeOpenAIStreamChunk({ role: 'assistant', content: 'partial' }),
          ),
        )
        // Bounded cleanup for current/baseline behavior: the idle-timeout
        // assertions should fail before this close fires.
        closeTimer = setTimeout(() => {
          try {
            controller.close()
          } catch {
            // stream may already be cancelled by the idle timeout path
          }
        }, STALLING_STREAM_CLEANUP_MS)
      },
      cancel(reason) {
        if (closeTimer !== undefined) {
          clearTimeout(closeTimer)
        }
        onCancel?.(reason)
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  )
}

function makeRoleOnlyStallingOpenAIStreamResponse(
  onInitialChunk: () => void,
  onCancel?: (reason: unknown) => void,
): Response {
  const encoder = new TextEncoder()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let sentInitialChunk = false

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sentInitialChunk) return
        sentInitialChunk = true
        controller.enqueue(
          encoder.encode(makeOpenAIStreamChunk({ role: 'assistant' })),
        )
        onInitialChunk()
        closeTimer = setTimeout(() => {
          try {
            controller.close()
          } catch {
            // stream may already be cancelled by the abort path
          }
        }, 500)
      },
      cancel(reason) {
        if (closeTimer !== undefined) {
          clearTimeout(closeTimer)
        }
        onCancel?.(reason)
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  )
}

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') return {}
  const parsed = JSON.parse(init.body) as unknown
  return parsed && typeof parsed === 'object'
    ? (parsed as Record<string, unknown>)
    : {}
}

async function drainGenerator<T>(
  generator: AsyncGenerator<unknown, T>,
): Promise<T> {
  while (true) {
    const result = await generator.next()
    if (result.done) return result.value
  }
}

async function waitForPromise<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(timeoutMessage))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

function makeParams(context: { model: string }): BetaMessageStreamParams {
  return {
    model: context.model,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  } as BetaMessageStreamParams
}

function makeOptions(
  queryLifecycle: QueryLifecycleOperationTracker,
): Options {
  return {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    model: 'claude-lifecycle-test',
    isNonInteractiveSession: false,
    querySource: 'sdk',
    agents: [],
    hasAppendSystemPrompt: false,
    mcpTools: [],
    queryLifecycle,
  }
}

async function capturePrimaryRequest({
  model = 'claude-lifecycle-test',
  systemPrompt = asSystemPrompt(['stable system prompt']),
}: {
  model?: string
  systemPrompt?: ReturnType<typeof asSystemPrompt>
} = {}): Promise<{ system: unknown[]; headers: Headers }> {
  const queryLifecycle = new QueryLifecycleOperationTracker()
  let requestBody: Record<string, unknown> | undefined
  let requestHeaders: Headers | undefined
  const fetchOverride: FetchOverride = async (_input, init) => {
    requestBody = parseRequestBody(init)
    requestHeaders = new Headers(init?.headers)
    return makeErrorResponse(400, 'captured request')
  }

  const generator = queryModelWithStreaming({
    messages: [
      {
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000009',
        timestamp: '2026-08-21T00:00:00.000Z',
        message: { role: 'user', content: 'hello' },
      } as Message,
    ],
    systemPrompt,
    thinkingConfig: { type: 'disabled' },
    tools: [],
    signal: new AbortController().signal,
    options: {
      ...makeOptions(queryLifecycle),
      model,
      fetchOverride,
    },
  })

  await generator.next()
  await generator.return(undefined)

  if (!Array.isArray(requestBody?.system)) {
    throw new Error('expected captured Anthropic system blocks')
  }
  if (!requestHeaders) {
    throw new Error('expected captured Anthropic request headers')
  }
  return { system: requestBody.system, headers: requestHeaders }
}

async function capturePrimarySystemBlocks(options: {
  model?: string
  systemPrompt?: ReturnType<typeof asSystemPrompt>
} = {}): Promise<unknown[]> {
  return (await capturePrimaryRequest(options)).system
}

function systemBlockTexts(blocks: unknown[]): string[] {
  return blocks.flatMap(block => {
    if (
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return [(block as { text: string }).text]
    }
    return []
  })
}

function setTestMacro(): void {
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
}

function setClientTestEnv(): void {
  setTestMacro()
  fixturesRoot = mkdtempSync(join(tmpdir(), 'claude-lifecycle-vcr-'))
  for (const key of envKeys) {
    delete process.env[key]
  }
  process.env.ANTHROPIC_API_KEY = 'sk-test-lifecycle'
  process.env.OPENCLAUDE_CONFIG_DIR = fixturesRoot
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = fixturesRoot
  process.env.CLAUDE_FEATURE_FLAGS_FILE = join(
    fixturesRoot,
    'feature-flags.json',
  )
  process.env.VCR_RECORD = '1'
  getClaudeAIOAuthTokens.cache?.clear?.()
  resetGrowthBook()
}

function setIgnoredApiKeyHelper(): void {
  delete process.env.ANTHROPIC_API_KEY
  setFlagSettingsPath(undefined)
  setFlagSettingsInline({ apiKeyHelper: 'ignored-test-helper' })
  setAllowedSettingSources(['flagSettings'])
  resetSettingsCache()
  enableConfigs()
  process.env.NODE_ENV = 'development'
}

beforeEach(async () => {
  await acquireSharedMutationLock('claude.lifecycle.test.ts')
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  setAllowedSettingSources([...SETTING_SOURCES])
  resetSettingsCache()
  getClaudeAIOAuthTokens.cache?.clear?.()
})

afterEach(() => {
  try {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
    if (hadSavedMacro) {
      ;(globalThis as Record<string, unknown>).MACRO = savedMacro
    } else {
      delete (globalThis as Record<string, unknown>).MACRO
    }
    globalThis.fetch = originalFetch
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    setFlagSettingsPath(undefined)
    setFlagSettingsInline(null)
    setAllowedSettingSources([...SETTING_SOURCES])
    resetSettingsCache()
    getClaudeAIOAuthTokens.cache?.clear?.()
    resetGrowthBook()
    if (fixturesRoot) {
      rmSync(fixturesRoot, { force: true, recursive: true })
      fixturesRoot = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

if (runInProviderIsolatedChild) {
  test('runs Claude lifecycle cases with the real provider module', async () => {
    await runTestFileWithRealProviders(import.meta.path)
  }, { timeout: REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000 })
}

const describeLifecycle = runInProviderIsolatedChild
  ? describe.skip
  : describe

describeLifecycle('Claude API lifecycle tracking', () => {
  test.each([
    { provider: 'firstParty', count: 20, withDocument: false, rejects: false },
    { provider: 'firstParty', count: 21, withDocument: false, rejects: true },
    { provider: 'firstParty', count: 20, withDocument: true, rejects: false },
    { provider: 'bedrock', count: 20, withDocument: true, rejects: true },
    { provider: 'vertex', count: 20, withDocument: true, rejects: true },
  ])('validates retained media before dispatch: %j', async ({ provider, count, withDocument, rejects }) => {
    setClientTestEnv()
    if (provider === 'bedrock') process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    if (provider === 'vertex') process.env.CLAUDE_CODE_USE_VERTEX = '1'
    // A recognizable 4K header that cannot be decoded exercises the awaited
    // local failure path without requiring partner credentials or a live API.
    const buffer = Buffer.alloc(24)
    buffer.write('89504e470d0a1a0a', 'hex')
    buffer.writeUInt32BE(3840, 16)
    buffer.writeUInt32BE(2160, 20)
    let requests = 0
    const events: unknown[] = []
    const generator = queryModelWithStreaming({
      messages: [{
        type: 'user',
        uuid: '00000000-0000-0000-0000-000000000019',
        timestamp: '2026-08-21T00:00:00.000Z',
        message: {
          role: 'user',
          content: [...Array.from({ length: count }, () => ({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: buffer.toString('base64') },
          })), ...(withDocument ? [{
            type: 'document',
            source: { type: 'text', media_type: 'text/plain', data: 'Reference document' },
          }] : [])],
        },
      } as Message],
      systemPrompt: asSystemPrompt(['stable system prompt']),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        ...makeOptions(new QueryLifecycleOperationTracker()),
        fetchOverride: async () => {
          requests++
          return makeErrorResponse(400, 'captured request')
        },
      },
    })
    for await (const event of generator) events.push(event)
    expect(requests).toBe(rejects ? 0 : 1)
    if (rejects) {
      expect(JSON.stringify(events)).toContain('Resize the image before sending')
      if (withDocument) expect(JSON.stringify(events)).toContain('20 images and documents combined')
    }
  })

  for (const [label, envKey, envValue, ambientAuth] of [
    ['remote', 'CLAUDE_CODE_REMOTE', '1', 'api-key'],
    [
      'Claude Desktop',
      'CLAUDE_CODE_ENTRYPOINT',
      'claude-desktop',
      'api-key-helper',
    ],
    [
      'Unix-socket OAuth proxy',
      'ANTHROPIC_UNIX_SOCKET',
      '/tmp/openclaude-auth-test.sock',
      'auth-token',
    ],
  ] as const) {
    test(`uses OAuth headers and attribution in managed ${label} sessions`, async () => {
      setClientTestEnv()
      process.env[envKey] = envValue
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
      process.env.OPENCLAUDE_MAX_RETRIES = '0'
      if (ambientAuth === 'api-key-helper') setIgnoredApiKeyHelper()
      if (ambientAuth === 'auth-token') {
        process.env.ANTHROPIC_AUTH_TOKEN = 'ignored-test-auth-token'
      }
      getClaudeAIOAuthTokens.cache?.clear?.()

      const request = await capturePrimaryRequest()
      const texts = systemBlockTexts(request.system)

      expect(
        texts.some(text => text.startsWith('x-anthropic-billing-header')),
      ).toBe(true)
      expect(request.headers.get('authorization')).toBe(
        'Bearer oauth-test-token',
      )
      expect(request.headers.has('x-api-key')).toBe(false)
    })
  }

  test('Haiku side queries omit effort from native Anthropic requests when force enabled', async () => {
    setClientTestEnv()
    process.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT = '1'
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'claude-haiku-4-5-20251001'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    let requestBody: Record<string, unknown> | undefined
    let requestHeaders: Headers | undefined
    const fetchOverride: FetchOverride = async (_input, init) => {
      requestBody = parseRequestBody(init)
      requestHeaders = new Headers(init?.headers)
      return makeAnthropicStreamingResponse()
    }

    await queryHaiku({
      userPrompt: 'summarize this turn',
      systemPrompt: asSystemPrompt([]),
      signal: new AbortController().signal,
      options: {
        isNonInteractiveSession: false,
        querySource: 'sdk',
        agents: [],
        hasAppendSystemPrompt: false,
        mcpTools: [],
        queryLifecycle,
        fetchOverride,
        effortValue: 'medium',
      },
    })

    expect(requestBody?.model).toBe('claude-haiku-4-5-20251001')
    expect(requestBody).not.toHaveProperty('output_config.effort')
    expect(requestBody).not.toHaveProperty('reasoning_effort')
    expect(requestBody).not.toHaveProperty('effort')
    expect(requestHeaders?.get('anthropic-beta')).not.toContain('effort')
  })

  test('keeps Unix-socket API-key auth when the OAuth placeholder is absent', async () => {
    setClientTestEnv()
    writeFileSync(
      join(fixturesRoot!, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stored-test-oauth-token',
          refreshToken: null,
          expiresAt: null,
          scopes: ['user:inference'],
          subscriptionType: null,
          rateLimitTier: null,
        },
      }),
    )
    process.env.ANTHROPIC_UNIX_SOCKET = '/tmp/openclaude-auth-test.sock'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const request = await capturePrimaryRequest()
    const texts = systemBlockTexts(request.system)

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(request.headers.get('x-api-key')).toBe('sk-test-lifecycle')
    expect(request.headers.has('authorization')).toBe(false)
  })

  test('honors a trusted free-plan override in a managed OAuth context', async () => {
    setClientTestEnv()
    writeFileSync(
      join(fixturesRoot!, 'settings.json'),
      JSON.stringify({ subscriptionType: 'free' }),
    )
    resetSettingsCache()
    process.env.CLAUDE_CODE_REMOTE = '1'
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const request = await capturePrimaryRequest()
    const texts = systemBlockTexts(request.system)

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(request.headers.get('x-api-key')).toBe('sk-test-lifecycle')
    expect(request.headers.has('authorization')).toBe(false)
  })

  test('strips Anthropic billing attribution from a custom native endpoint', async () => {
    setClientTestEnv()
    process.env.ANTHROPIC_BASE_URL = 'https://custom-anthropic.example/v1'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(await capturePrimarySystemBlocks())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
    expect(texts).toContain('stable system prompt')
  })

  test('keeps required billing attribution for official OAuth when globally disabled', async () => {
    setClientTestEnv()
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const texts = systemBlockTexts(await capturePrimarySystemBlocks())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(true)
    expect(texts).toContain('stable system prompt')
  })

  test('preserves the disable setting for an official API key', async () => {
    setClientTestEnv()
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(await capturePrimarySystemBlocks())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
  })

  test('does not trust an Anthropic lookalike host with leftover OAuth state', async () => {
    setClientTestEnv()
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
    process.env.ANTHROPIC_BASE_URL =
      'https://api.anthropic.com.attacker.example/secret/path'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(await capturePrimarySystemBlocks())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
  })

  test('keeps OAuth attribution through an approved loopback first-party proxy', async () => {
    setClientTestEnv()
    delete process.env.ANTHROPIC_API_KEY
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'
    process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = '0'
    process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:47821'
    process.env.ANTHROPIC_FIRST_PARTY_PROXY_HOSTS = '127.0.0.1:47821'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    getClaudeAIOAuthTokens.cache?.clear?.()

    const texts = systemBlockTexts(await capturePrimarySystemBlocks())

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(true)
  })

  test('uses the normalized MiniMax native route before building attribution', async () => {
    setClientTestEnv()
    process.env.MINIMAX_API_KEY = 'minimax-test-key'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(
      await capturePrimarySystemBlocks({ model: 'MiniMax-M2.7' }),
    )

    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.minimax.io/anthropic',
    )
    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
  })

  test('strips attribution from GitHub native Anthropic transport', async () => {
    setClientTestEnv()
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'github-test-token'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(
      await capturePrimarySystemBlocks({ model: 'claude-sonnet-4-6' }),
    )

    expect(
      texts.some(text => text.startsWith('x-anthropic-billing-header')),
    ).toBe(false)
  })

  test('keeps the generated block first and drops later stale copies', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'

    const texts = systemBlockTexts(
      await capturePrimarySystemBlocks({
        systemPrompt: asSystemPrompt([
          'stable system prompt',
          'x-anthropic-billing-header: stale',
          'second stable prompt',
        ]),
      }),
    )

    const attribution = texts.filter(text =>
      text.startsWith('x-anthropic-billing-header'),
    )
    expect(attribution).toHaveLength(1)
    expect(attribution[0]).not.toBe('x-anthropic-billing-header: stale')
    expect(texts[1]).toStartWith('You are OpenClaude')
    expect(texts[2]).toBe('stable system prompt\n\nsecond stable prompt')
  })

  test('uses the original codexplan selection for custom-gateway defaults', async () => {
    setClientTestEnv()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://gateway.example/v1'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    let requestBody: Record<string, unknown> | undefined

    globalThis.fetch = (async (_input, init) => {
      requestBody = parseRequestBody(init)
      return makeOpenAIStreamingResponse()
    }) as typeof fetch

    const generator = queryModelWithStreaming({
      messages: [
        {
          type: 'user',
          uuid: '00000000-0000-0000-0000-000000000001',
          timestamp: '2026-06-17T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        ...makeOptions(queryLifecycle),
        model: 'gpt-5.6-sol',
        requestModel: 'codexplan',
      },
    })

    for await (const _message of generator) {
      // Drain the stream before asserting its request.
    }

    expect(requestBody?.model).toBe('gpt-5.6-sol')
    expect(requestBody?.reasoning_effort).toBe('high')
  })

  test('checks provider-request ownership immediately before dispatch', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const events: string[] = []
    let permissionContextReads = 0
    const fetchOverride: FetchOverride = async () => {
      events.push('fetch')
      return makeJsonResponse(makeBetaMessage())
    }

    const generator = queryModelWithStreaming({
      messages: [
        {
          type: 'user',
          uuid: '00000000-0000-0000-0000-000000000001',
          timestamp: '2026-06-17T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        ...makeOptions(queryLifecycle),
        fetchOverride,
        getToolPermissionContext: async () => {
          permissionContextReads++
          return getEmptyToolPermissionContext()
        },
        onProviderRequestStart: () => {
          events.push('ownership-check')
          return false
        },
      },
    })

    expect(await drainGenerator(generator)).toBeUndefined()
    expect(events).toEqual(['ownership-check'])
    expect(permissionContextReads).toBe(0)
  })

  test('ends a failed streaming dispatch before retry backoff is reported', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '1'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const dispatchSnapshots: ReturnType<
      QueryLifecycleOperationTracker['snapshot']
    >[] = []
    const fetchOverride: FetchOverride = async () => {
      dispatchSnapshots.push(queryLifecycle.snapshot())
      return makeErrorResponse(500, 'stream dispatch failed')
    }

    const generator = queryModelWithStreaming({
      messages: [
        {
          type: 'user',
          uuid: '00000000-0000-0000-0000-000000000001',
          timestamp: '2026-06-17T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        ...makeOptions(queryLifecycle),
        fetchOverride,
      },
    })

    const first = await generator.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({
      type: 'system',
      subtype: 'api_error',
    })
    expect(dispatchSnapshots.length).toBeGreaterThanOrEqual(1)
    expect(dispatchSnapshots.some(snapshot => snapshot.apiCalls.length === 1)).toBe(
      true,
    )
    expect(queryLifecycle.snapshot().apiCalls).toEqual([])

    await generator.return(undefined)
  })

  test('preserves provider override and query source during 404 non-streaming fallback', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const providerBaseURL = 'https://provider.example/v1'
    const requests: {
      authorization: string | null
      snapshot: LifecycleSnapshot
      stream: unknown
      url: string
    }[] = []

    globalThis.fetch = (async (input, init) => {
      const body = parseRequestBody(init)
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        snapshot: queryLifecycle.snapshot(),
        stream: body.stream,
        url: input instanceof Request ? input.url : String(input),
      })

      if (body.stream === true) {
        return makeErrorResponse(404, 'streaming unavailable')
      }

      return makeOpenAIChatCompletionResponse()
    }) as typeof fetch

    const messages: unknown[] = []
    const generator = queryModelWithStreaming({
      messages: [
        {
          type: 'user',
          uuid: '00000000-0000-0000-0000-000000000002',
          timestamp: '2026-06-17T00:00:00.000Z',
          message: { role: 'user', content: 'hello' },
        } as Message,
      ],
      systemPrompt: asSystemPrompt([]),
      thinkingConfig: { type: 'disabled' },
      tools: [],
      signal: new AbortController().signal,
      options: {
        ...makeOptions(queryLifecycle),
        providerOverride: {
          model: 'gpt-override',
          baseURL: providerBaseURL,
          apiKey: 'provider-test-key',
        },
      },
    })

    for await (const message of generator) {
      messages.push(message)
      if (
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'assistant'
      ) {
        break
      }
    }

    const streamingRequest = requests.find(request => request.stream === true)
    const fallbackRequest = requests.find(request => request.stream === false)

    expect(
      messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'assistant',
      ),
    ).toBe(true)
    expect(streamingRequest?.url.startsWith(providerBaseURL)).toBe(true)
    expect(fallbackRequest?.url.startsWith(providerBaseURL)).toBe(true)
    expect(fallbackRequest?.authorization).toBe('Bearer provider-test-key')
    expect(fallbackRequest?.snapshot.apiCalls).toHaveLength(1)
    expect(fallbackRequest?.snapshot.apiCalls[0]).toMatchObject({
      querySource: 'sdk',
    })
    expect(queryLifecycle.snapshot().apiCalls).toEqual([])
    const trace = __getInterruptionTraceSnapshotForTests()
    const creationError = trace.find(
      entry =>
        entry.event === 'claude_stream.error' &&
        entry.phase === 'stream_creation',
    )
    const fallbackStarted = trace.find(
      entry => entry.event === 'claude_stream.fallback_started',
    )
    const fallbackSettled = trace.find(
      entry => entry.event === 'claude_stream.fallback_settled',
    )
    expect(creationError).toBeDefined()
    expect(fallbackStarted).toMatchObject({
      trigger: '404_stream_creation',
      causalEventId: creationError?.eventId,
    })
    expect(fallbackSettled).toMatchObject({
      outcome: 'completed',
      causalEventId: fallbackStarted?.eventId,
    })
  })

  test('parent abort during OpenAI-compatible stream does not start non-streaming fallback', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = '1000'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const parent = new AbortController()
    let fallbackRequests = 0
    let fallbackNotifications = 0
    let streamCancelled = false
    const messages: unknown[] = []
    let resolveStreamingRequestStarted!: () => void
    const streamingRequestStarted = new Promise<void>(resolve => {
      resolveStreamingRequestStarted = resolve
    })
    let resolveInitialStreamChunk!: () => void
    const initialStreamChunk = new Promise<void>(resolve => {
      resolveInitialStreamChunk = resolve
    })

    globalThis.fetch = (async (_input, init) => {
      const body = parseRequestBody(init)
      if (body.stream === true) {
        resolveStreamingRequestStarted()
        return makeRoleOnlyStallingOpenAIStreamResponse(
          resolveInitialStreamChunk,
          () => {
            streamCancelled = true
          },
        )
      }
      fallbackRequests++
      return makeOpenAIChatCompletionResponse()
    }) as typeof fetch

    let drainError: unknown
    const drain = (async () => {
      try {
        const generator = queryModelWithStreaming({
          messages: [
            {
              type: 'user',
              uuid: '00000000-0000-0000-0000-000000000006',
              timestamp: '2026-06-17T00:00:00.000Z',
              message: { role: 'user', content: 'hello' },
            } as Message,
          ],
          systemPrompt: asSystemPrompt([]),
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: parent.signal,
          options: {
            ...makeOptions(queryLifecycle),
            providerOverride: {
              model: 'glm-5.2',
              baseURL: 'https://provider.example/v1',
              apiKey: 'provider-test-key',
            },
            onStreamingFallback: () => {
              fallbackNotifications++
            },
          },
        })

        for await (const message of generator) {
          messages.push(message)
        }
      } catch (error) {
        drainError = error
      }
    })()

    await streamingRequestStarted
    await initialStreamChunk
    await Promise.resolve()
    parent.abort()

    await drain

    expect(drainError).toBeUndefined()
    expect(fallbackRequests).toBe(0)
    expect(fallbackNotifications).toBe(0)
    expect(streamCancelled).toBe(true)
    expect(
      messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'assistant',
      ),
    ).toBe(false)
  })

  test('stream idle timeout respects disabled non-streaming fallback guard', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS = String(TEST_STREAM_IDLE_TIMEOUT_MS)
    process.env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK = '1'
    process.env.CLAUDE_DISABLE_STREAM_WATCHDOG = '1'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const parent = new AbortController()
    let fallbackRequests = 0
    const messages: unknown[] = []
    const startedAt = Date.now()

    globalThis.fetch = (async (_input, init) => {
      const body = parseRequestBody(init)
      if (body.stream === true) {
        return makeStallingOpenAIStreamResponse()
      }
      fallbackRequests++
      return makeOpenAIChatCompletionResponse()
    }) as typeof fetch

    let drainError: unknown
    const drain = (async () => {
      try {
        const generator = queryModelWithStreaming({
          messages: [
            {
              type: 'user',
              uuid: '00000000-0000-0000-0000-000000000007',
              timestamp: '2026-06-17T00:00:00.000Z',
              message: { role: 'user', content: 'hello' },
            } as Message,
          ],
          systemPrompt: asSystemPrompt([]),
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: parent.signal,
          options: {
            ...makeOptions(queryLifecycle),
            providerOverride: {
              model: 'glm-5.2',
              baseURL: 'https://provider.example/v1',
              apiKey: 'provider-test-key',
            },
          },
        })

        for await (const message of generator) {
          messages.push(message)
        }
      } catch (error) {
        drainError = error
      }
    })()

    await drain
    expect(Date.now() - startedAt).toBeLessThan(
      TEST_STREAM_IDLE_TIMEOUT_MS + STREAM_IDLE_RECOVERY_ASSERTION_MS,
    )

    expect(drainError).toBeUndefined()
    expect(fallbackRequests).toBe(0)
    expect(
      messages.some(
        message =>
          typeof message === 'object' &&
          message !== null &&
          (message as { type?: unknown }).type === 'assistant' &&
          JSON.stringify((message as { message?: { content?: unknown } }).message?.content).includes('Stream idle timeout'),
      ),
    ).toBe(true)
    const trace = __getInterruptionTraceSnapshotForTests()
    const providerIdle = trace.find(
      entry =>
        entry.event === 'provider_stream.idle_timeout' &&
        entry.transport === 'openai_chat_completions',
    )
    const claudeError = trace.find(
      entry => entry.event === 'claude_stream.error',
    )
    expect(providerIdle).toBeDefined()
    expect(claudeError?.causalEventId).toBe(providerIdle?.eventId)
  })

  test('tracks each non-streaming fallback request and clears it on success', async () => {
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const requestSnapshots: ReturnType<
      QueryLifecycleOperationTracker['snapshot']
    >[] = []
    setClientTestEnv()
    const fetchOverride: FetchOverride = async () => {
      requestSnapshots.push(queryLifecycle.snapshot())
      return makeJsonResponse(makeBetaMessage())
    }

    const result = await drainGenerator(
      executeNonStreamingRequest(
        { model: 'claude-lifecycle-test', source: 'sdk', fetchOverride },
        {
          model: 'claude-lifecycle-test',
          thinkingConfig: { type: 'disabled' },
          signal: new AbortController().signal,
          querySource: 'sdk',
        },
        makeParams,
        () => {},
        () => {},
        null,
        queryLifecycle,
      ),
    )

    if (result === null) throw new Error('expected non-streaming response')
    expect(result.id).toBe('msg-lifecycle-test')
    expect(requestSnapshots).toHaveLength(1)
    expect(requestSnapshots[0]?.apiCalls).toHaveLength(1)
    expect(requestSnapshots[0]?.apiCalls[0]).toMatchObject({
      model: 'claude-lifecycle-test',
      querySource: 'sdk',
    })
    expect(queryLifecycle.snapshot().apiCalls).toEqual([])
  })

  test('non-streaming fallback checks ownership before dispatch', async () => {
    setClientTestEnv()
    const queryLifecycle = new QueryLifecycleOperationTracker()
    let fetchCalls = 0
    const fetchOverride: FetchOverride = async () => {
      fetchCalls++
      return makeJsonResponse(makeBetaMessage())
    }

    const result = await drainGenerator(
      executeNonStreamingRequest(
        { model: 'claude-lifecycle-test', source: 'sdk', fetchOverride },
        {
          model: 'claude-lifecycle-test',
          thinkingConfig: { type: 'disabled' },
          signal: new AbortController().signal,
          querySource: 'sdk',
        },
        makeParams,
        () => {},
        () => {},
        null,
        queryLifecycle,
        () => false,
      ),
    )

    expect(result).toBeNull()
    expect(fetchCalls).toBe(0)
    expect(queryLifecycle.snapshot().apiCalls).toEqual([])
  })

  test('clears non-streaming fallback lifecycle entries after request errors', async () => {
    setClientTestEnv()
    process.env.OPENCLAUDE_MAX_RETRIES = '0'
    const queryLifecycle = new QueryLifecycleOperationTracker()
    const requestSnapshots: ReturnType<
      QueryLifecycleOperationTracker['snapshot']
    >[] = []
    const fetchOverride: FetchOverride = async () => {
      requestSnapshots.push(queryLifecycle.snapshot())
      return makeErrorResponse(400, 'fallback failed')
    }

    await expect(
      drainGenerator(
        executeNonStreamingRequest(
          { model: 'claude-lifecycle-test', source: 'sdk', fetchOverride },
          {
            model: 'claude-lifecycle-test',
            thinkingConfig: { type: 'disabled' },
            signal: new AbortController().signal,
            querySource: 'sdk',
          },
          makeParams,
          () => {},
          () => {},
          null,
          queryLifecycle,
        ),
      ),
    ).rejects.toThrow('fallback failed')

    expect(requestSnapshots).toHaveLength(1)
    expect(requestSnapshots[0]?.apiCalls).toHaveLength(1)
    expect(queryLifecycle.snapshot().apiCalls).toEqual([])
  })
})
