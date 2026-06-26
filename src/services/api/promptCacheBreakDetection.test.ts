import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { QuerySource } from '../../constants/querySource.js'
import type { Message } from '../../types/message.js'
import type { DebugLogLevel } from '../../utils/debug.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { PROVIDER_SELECTION_FLAGS } from '../../utils/providerSelectionFlags.js'

type PromptCacheBreakModule = typeof import('./promptCacheBreakDetection.js')
type EventCall = {
  name: string
  metadata: Record<string, unknown>
}
type DebugCall = {
  message: string
  options?: { level?: DebugLogLevel }
}

const events: EventCall[] = []
const debugCalls: DebugCall[] = []

const logEventMock = mock((name: string, metadata: Record<string, unknown>) => {
  events.push({ name, metadata })
})
const logForDebuggingMock = mock(
  (message: string, options?: { level?: DebugLogLevel }) => {
    debugCalls.push({ message, options })
  },
)
const nonce = `${Date.now()}-${Math.random()}`
const actualDebugModule = {
  ...await import(`../../utils/debug.js?real=${nonce}`),
}
const actualAnalyticsModule = {
  ...await import(`../analytics/index.js?real=${nonce}`),
}

afterAll(() => {
  mock.restore()
  mock.module('../analytics/index.js', () => actualAnalyticsModule)
  mock.module('src/utils/debug.js', () => actualDebugModule)
  mock.module('../../utils/debug.js', () => actualDebugModule)
})

mock.module('../analytics/index.js', () => ({
  ...actualAnalyticsModule,
  logEvent: logEventMock,
}))

mock.module('src/utils/debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: logForDebuggingMock,
}))

mock.module('../../utils/debug.js', () => ({
  ...actualDebugModule,
  logForDebugging: logForDebuggingMock,
}))

const PROVIDER_ENV_KEYS = [
  ...PROVIDER_SELECTION_FLAGS,
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
] as const

const originalEnv: Record<string, string | undefined> = {}
let detector: PromptCacheBreakModule | undefined

for (const key of PROVIDER_ENV_KEYS) {
  originalEnv[key] = process.env[key]
}

async function loadDetector(): Promise<PromptCacheBreakModule> {
  detector ??= await import('./promptCacheBreakDetection.js')
  return detector
}

function restoreProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key]
  }
}

function useOpenAIProvider(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  process.env.OPENAI_MODEL = 'gpt-5.5'
}

function useOpenAIProviderWithDisabledFoundryFlag(flagValue: string): void {
  useOpenAIProvider()
  process.env.CLAUDE_CODE_USE_FOUNDRY = flagValue
}

function useOpenAIProviderWithWhitespaceBaseFallback(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = '   '
  process.env.OPENAI_API_BASE = 'https://api.deepseek.com/v1'
  process.env.OPENAI_MODEL = 'deepseek-chat'
}

function useCodexAliasWithLiteralUndefinedBaseUrl(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'undefined'
  process.env.OPENAI_MODEL = 'codexplan'
}

function useOpenRouterProvider(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'gpt-4o'
}

function useUnsupportedGithubProvider(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_MODEL = 'gpt-4o'
}

function useFoundryProvider(): void {
  clearProviderEnv()
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
}

function systemBlock(
  text: string,
  cacheControl?: Record<string, unknown>,
): TextBlockParam[] {
  return [
    {
      type: 'text',
      text,
      ...(cacheControl ? { cache_control: cacheControl } : {}),
    },
  ] as TextBlockParam[]
}

function tool(
  name: string,
  schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  },
): BetaToolUnion {
  return {
    type: 'custom',
    name,
    description: `${name} test tool`,
    input_schema: schema,
  } as unknown as BetaToolUnion
}

function assistantMessages(gapMs: number): Message[] {
  return [
    {
      type: 'assistant',
      timestamp: new Date(Date.now() - gapMs).toISOString(),
      uuid: '00000000-0000-4000-8000-000000000001',
      message: {
        role: 'assistant',
        content: [],
        id: 'msg_1',
        model: 'claude-sonnet-4',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    },
  ] as unknown as Message[]
}

function snapshot(
  overrides: Partial<Parameters<PromptCacheBreakModule['recordPromptState']>[0]> = {},
): Parameters<PromptCacheBreakModule['recordPromptState']>[0] {
  return {
    system: systemBlock('base system prompt'),
    toolSchemas: [tool('Read')],
    querySource: 'repl_main_thread' as QuerySource,
    model: 'claude-sonnet-4',
    ...overrides,
  }
}

async function triggerCacheDrop({
  first = snapshot(),
  second = snapshot(),
  secondMessages = assistantMessages(60_000),
}: {
  first?: Parameters<PromptCacheBreakModule['recordPromptState']>[0]
  second?: Parameters<PromptCacheBreakModule['recordPromptState']>[0]
  secondMessages?: Message[]
} = {}): Promise<EventCall> {
  const mod = await loadDetector()
  mod.recordPromptState(first)
  await mod.checkResponseForCacheBreak(
    first.querySource,
    10_000,
    0,
    assistantMessages(60_000),
    first.agentId,
    'req-prev',
  )

  mod.recordPromptState(second)
  await mod.checkResponseForCacheBreak(
    second.querySource,
    1_000,
    0,
    secondMessages,
    second.agentId,
    'req-break',
  )

  const event = events.findLast(e => e.name === 'tengu_prompt_cache_break')
  expect(event).toBeDefined()
  return event!
}

beforeEach(async () => {
  await acquireSharedMutationLock('promptCacheBreakDetection.test.ts')
  events.length = 0
  debugCalls.length = 0
  logEventMock.mockClear()
  logForDebuggingMock.mockClear()
  clearProviderEnv()
  const mod = await loadDetector()
  mod.resetPromptCacheBreakDetection()
})

afterEach(() => {
  try {
    detector?.resetPromptCacheBreakDetection()
    restoreProviderEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('prompt cache break taxonomy', () => {
  test('tool addition/removal classifies as expected tool schema change', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({ toolSchemas: [tool('Read'), tool('Edit')] }),
      second: snapshot({ toolSchemas: [tool('Edit'), tool('Bash')] }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_tool_schema_change',
      addedToolCount: 1,
      removedToolCount: 1,
      addedTools: 'Bash',
      removedTools: 'Read',
    })
  })

  test('changed MCP tool schema names are sanitized in analytics', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({
        toolSchemas: [
          tool('mcp__repo_server__search', {
            type: 'object',
            properties: { query: { type: 'string' } },
          }),
        ],
      }),
      second: snapshot({
        toolSchemas: [
          tool('mcp__repo_server__search', {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
          }),
        ],
      }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_tool_schema_change',
      changedToolSchemas: 'mcp',
    })
  })

  test('system prompt hash change classifies as expected local prompt change', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({ system: systemBlock('base system prompt') }),
      second: snapshot({ system: systemBlock('updated system prompt') }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_local_prompt_change',
      severity: 'info',
    })
  })

  test('cache-control-only change classifies separately', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({
        system: systemBlock('base system prompt', { type: 'ephemeral' }),
      }),
      second: snapshot({
        system: systemBlock('base system prompt', {
          type: 'ephemeral',
          ttl: '1h',
        }),
      }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_cache_control_change',
      cacheControlChanged: true,
      systemPromptChanged: false,
    })
  })

  test('global cache strategy change classifies with cache-control changes', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({ globalCacheStrategy: 'tool_based' }),
      second: snapshot({ globalCacheStrategy: 'system_prompt' }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_cache_control_change',
      cacheControlChanged: false,
      globalCacheStrategyChanged: true,
      prevGlobalCacheStrategy: 'tool_based',
      newGlobalCacheStrategy: 'system_prompt',
    })
  })

  test('model, beta, effort, and extra-body changes classify as expected model or beta change', async () => {
    const event = await triggerCacheDrop({
      first: snapshot({
        model: 'claude-sonnet-4',
        betas: ['beta-a'],
        effortValue: 'medium',
        extraBodyParams: { metadata: { source: 'first' } },
      }),
      second: snapshot({
        model: 'claude-opus-4',
        betas: ['beta-b'],
        effortValue: 'high',
        extraBodyParams: { metadata: { source: 'second' } },
      }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_model_or_beta_change',
      modelChanged: true,
      betasChanged: true,
      effortChanged: true,
      extraBodyChanged: true,
      addedBetas: 'beta-b',
      removedBetas: 'beta-a',
    })
  })

  test('same prompt/schema under TTL on advisory provider classifies as provider cache instability with info severity', async () => {
    useOpenAIProvider()

    const event = await triggerCacheDrop()
    const debug = debugCalls.findLast(call =>
      call.message.startsWith('[PROMPT CACHE BREAK]'),
    )

    expect(event.metadata).toMatchObject({
      classification: 'provider_cache_instability',
      cacheMetricsReliability: 'advisory',
      severity: 'info',
      prevCacheReadTokens: 10_000,
      cacheReadTokens: 1_000,
      tokenDrop: 9_000,
      querySource: 'repl_main_thread',
      model: 'claude-sonnet-4',
      providerRoute: 'openai',
      requestId: 'req-break',
    })
    expect(debug?.options).toEqual({ level: 'info' })
    expect(debug?.message).not.toMatch(/app crash|crash|local mutation/i)
  })

  for (const falseyFoundryFlag of ['off', 'no'] as const) {
    test(`stale Foundry=${falseyFoundryFlag} env flag does not override OpenAI cache metadata`, async () => {
      useOpenAIProviderWithDisabledFoundryFlag(falseyFoundryFlag)

      const event = await triggerCacheDrop()
      const debug = debugCalls.findLast(call =>
        call.message.startsWith('[PROMPT CACHE BREAK]'),
      )

      expect(event.metadata).toMatchObject({
        classification: 'provider_cache_instability',
        cacheMetricsReliability: 'advisory',
        cacheProvider: 'openai',
        providerRoute: 'openai',
        severity: 'info',
      })
      expect(debug?.options).toEqual({ level: 'info' })
    })
  }

  test('blank OpenAI base URL falls back to legacy API base for cache provider metadata', async () => {
    useOpenAIProviderWithWhitespaceBaseFallback()

    const event = await triggerCacheDrop({
      first: snapshot({ model: 'deepseek-chat' }),
      second: snapshot({ model: 'deepseek-chat' }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'provider_cache_instability',
      cacheMetricsReliability: 'advisory',
      cacheProvider: 'deepseek',
      severity: 'info',
    })
  })

  test('literal undefined OpenAI base URL still reports Codex alias metadata', async () => {
    useCodexAliasWithLiteralUndefinedBaseUrl()

    const event = await triggerCacheDrop({
      first: snapshot({ model: 'codexplan' }),
      second: snapshot({ model: 'codexplan' }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'provider_cache_instability',
      cacheMetricsReliability: 'advisory',
      cacheProvider: 'codex',
      providerRoute: 'codex',
      severity: 'info',
    })
  })

  test('descriptor OpenAI-compatible route IDs are normalized before logging', async () => {
    useOpenRouterProvider()

    const event = await triggerCacheDrop({
      first: snapshot({ model: 'gpt-4o' }),
      second: snapshot({ model: 'gpt-4o' }),
    })
    const debug = debugCalls.findLast(call =>
      call.message.startsWith('[PROMPT CACHE BREAK]'),
    )

    expect(event.metadata).toMatchObject({
      classification: 'provider_cache_instability',
      cacheMetricsReliability: 'advisory',
      cacheProvider: 'openai',
      providerRoute: 'openai-compatible',
      severity: 'info',
    })
    expect(debug?.message).toContain('route=openai-compatible')
    expect(debug?.message).not.toContain('openrouter')
  })

  test('TTL-window cache drops classify as possible TTL expiry', async () => {
    const event = await triggerCacheDrop({
      secondMessages: assistantMessages(61 * 60 * 1000),
    })

    expect(event.metadata).toMatchObject({
      classification: 'possible_ttl_expiry',
      lastAssistantMsgOver5minAgo: true,
      lastAssistantMsgOver1hAgo: true,
    })
  })

  test('unknown or incomplete state classifies as unknown local mutation, not provider-side instability', async () => {
    const event = await triggerCacheDrop({
      secondMessages: [],
    })

    expect(event.metadata).toMatchObject({
      classification: 'unknown_local_mutation',
      timeSinceLastAssistantMsg: -1,
    })
  })

  test('unsupported provider metrics classify as metrics unavailable', async () => {
    useUnsupportedGithubProvider()

    const event = await triggerCacheDrop({
      first: snapshot({ model: 'gpt-4o' }),
      second: snapshot({ model: 'gpt-4o' }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'metrics_unavailable',
      cacheMetricsReliability: 'unsupported',
      providerRoute: 'github',
    })
  })

  test('unsupported provider metrics do not hide known local prompt changes', async () => {
    useUnsupportedGithubProvider()

    const event = await triggerCacheDrop({
      first: snapshot({
        model: 'gpt-4o',
        system: systemBlock('base system prompt'),
      }),
      second: snapshot({
        model: 'gpt-4o',
        system: systemBlock('changed system prompt'),
      }),
    })

    expect(event.metadata).toMatchObject({
      classification: 'expected_local_prompt_change',
      cacheMetricsReliability: 'unsupported',
      systemPromptChanged: true,
    })
  })

  test('legacy Foundry provider does not get mislabeled as anthropic route', async () => {
    useFoundryProvider()

    const event = await triggerCacheDrop()
    const debug = debugCalls.findLast(call =>
      call.message.startsWith('[PROMPT CACHE BREAK]'),
    )

    expect(event.metadata).toMatchObject({
      classification: 'provider_cache_instability',
      cacheMetricsReliability: 'reliable',
      cacheProvider: 'anthropic',
      providerRoute: 'foundry',
      severity: 'warning',
    })
    expect(debug?.options).toEqual({ level: 'warn' })
  })

  test('cache deletion expected drops remain suppressed', async () => {
    const mod = await loadDetector()
    const first = snapshot()

    mod.recordPromptState(first)
    await mod.checkResponseForCacheBreak(
      first.querySource,
      10_000,
      0,
      assistantMessages(60_000),
      first.agentId,
      'req-prev',
    )

    mod.recordPromptState(snapshot())
    mod.notifyCacheDeletion(first.querySource, first.agentId)
    await mod.checkResponseForCacheBreak(
      first.querySource,
      1_000,
      0,
      assistantMessages(60_000),
      first.agentId,
      'req-drop',
    )

    expect(events.filter(e => e.name === 'tengu_prompt_cache_break')).toEqual([])
    expect(
      debugCalls.some(call => call.message.includes('cache deletion applied')),
    ).toBe(true)
  })
})
