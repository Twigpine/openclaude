import { afterEach, beforeEach, expect, test } from 'bun:test'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { setToolHistoryCompressionEnabledOverrideForTest } from './compressToolHistory.js'
import { __test, createOpenAIShimClient } from './openaiShim.js'

type FetchType = typeof globalThis.fetch
const originalFetch = globalThis.fetch

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW:
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  OPENCLAUDE_LOCAL_FAST_PATH: process.env.OPENCLAUDE_LOCAL_FAST_PATH,
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
}

const originalConfig = {
  toolHistoryCompressionEnabled:
    getGlobalConfig().toolHistoryCompressionEnabled,
  autoCompactEnabled: getGlobalConfig().autoCompactEnabled,
}

const mockState = {
  enabled: true,
  effectiveWindow: 100_000, // Copilot gpt-4o tier
}

const MID_TIER_MODEL = 'llama-3.1-8b-instant'
const LARGE_CONTEXT_MODEL = 'deepseek-v4-flash'
const SMALL_CONTEXT_MODEL = 'minimax-vision-01'

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function setEffectiveWindowForTest(effectiveWindow: number): void {
  mockState.effectiveWindow = effectiveWindow
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '8000'
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(effectiveWindow + 8_000)
}

function setCompressionEnabledForTest(enabled: boolean): void {
  mockState.enabled = enabled
  setToolHistoryCompressionEnabledOverrideForTest(enabled)
  saveGlobalConfig(current => ({
    ...current,
    toolHistoryCompressionEnabled: mockState.enabled,
    autoCompactEnabled: false,
  }))
}

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (
        params: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<unknown>
    }
  }
}

function bigText(n: number): string {
  return 'A'.repeat(n)
}

function buildToolExchange(id: number, resultLength: number) {
  return [
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: `toolu_${id}`,
          name: 'Read',
          input: { file_path: `/path/to/file${id}.ts` },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: `toolu_${id}`,
          content: bigText(resultLength),
        },
      ],
    },
  ]
}

function buildLongConversation(numExchanges: number, resultLength = 5_000) {
  const out: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'start the work' },
  ]
  for (let i = 0; i < numExchanges; i++) {
    out.push(...buildToolExchange(i, resultLength))
  }
  return out
}

function buildParallelToolConversation(
  numBatches: number,
  batchSize: number,
  resultLength = 5_000,
) {
  const out: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: 'start the parallel work' },
  ]
  for (let batch = 0; batch < numBatches; batch++) {
    const firstId = batch * batchSize
    out.push({
      role: 'assistant',
      content: Array.from({ length: batchSize }, (_, offset) => ({
        type: 'tool_use',
        id: `toolu_${firstId + offset}`,
        name: 'Read',
        input: { file_path: `/path/to/file${firstId + offset}.ts` },
      })),
    })
    out.push({
      role: 'user',
      content: Array.from({ length: batchSize }, (_, offset) => ({
        type: 'tool_result',
        tool_use_id: `toolu_${firstId + offset}`,
        content: bigText(resultLength),
      })),
    })
  }
  return out
}

function makeFakeResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4o',
      choices: [
        {
          message: { role: 'assistant', content: 'done' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

function makeFakeResponsesResponse(): Response {
  return new Response(
    JSON.stringify({
      id: 'resp-1',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  )
}

beforeEach(async () => {
  await acquireSharedMutationLock('openaiShim.compression.test.ts')
  setCompressionEnabledForTest(true)
  setEffectiveWindowForTest(100_000)
  process.env.OPENAI_BASE_URL = 'http://example.test/v1'
  process.env.OPENAI_API_KEY = 'test-key'
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_API_FORMAT
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.GITHUB_TOKEN
  delete process.env.OPENCLAUDE_LOCAL_FAST_PATH
  delete process.env.OPENCODE_API_KEY
})

afterEach(() => {
  try {
    for (const key of Object.keys(originalEnv) as Array<keyof typeof originalEnv>) {
      restoreEnv(key)
    }
    saveGlobalConfig(current => ({
      ...current,
      toolHistoryCompressionEnabled:
        originalConfig.toolHistoryCompressionEnabled,
      autoCompactEnabled: originalConfig.autoCompactEnabled,
    }))
    globalThis.fetch = originalFetch
  } finally {
    setToolHistoryCompressionEnabledOverrideForTest(undefined)
    releaseSharedMutationLock()
  }
})

async function captureRequestBody(
  messages: Array<{ role: string; content: unknown }>,
  model: string,
  options: {
    useModelWindow?: boolean
    providerOverride?: { model: string; baseURL: string; apiKey: string }
  } = {},
): Promise<Record<string, unknown>> {
  const originalAutoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  const originalMaxOutputTokens = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  const originalFetch = globalThis.fetch
  try {
    setCompressionEnabledForTest(mockState.enabled)
    if (options.useModelWindow) {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    } else {
      setEffectiveWindowForTest(mockState.effectiveWindow)
    }
    let captured: Record<string, unknown> | undefined

    globalThis.fetch = (async (_input, init) => {
      captured = JSON.parse(String(init?.body))
      return makeFakeResponse()
    }) as FetchType

    const client = createOpenAIShimClient({
      providerOverride: options.providerOverride,
    }) as OpenAIShimClient
    await client.beta.messages.create({
      model,
      system: 'system prompt',
      messages,
    })

    if (!captured) throw new Error('request not captured')
    return captured
  } finally {
    if (originalAutoCompactWindow === undefined) {
      delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    } else {
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = originalAutoCompactWindow
    }
    if (originalMaxOutputTokens === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = originalMaxOutputTokens
    }
    globalThis.fetch = originalFetch
  }
}

async function captureResponsesRequestBody(
  messages: Array<{ role: string; content: unknown }>,
  model: string,
  options: {
    apiFormat?: 'responses' | 'responses_compat'
    baseUrl?: string
  } = {},
): Promise<Record<string, unknown>> {
  setCompressionEnabledForTest(mockState.enabled)
  setEffectiveWindowForTest(mockState.effectiveWindow)
  process.env.OPENAI_API_FORMAT = options.apiFormat ?? 'responses'
  process.env.OPENAI_BASE_URL = options.baseUrl ?? 'http://example.test/v1'
  let captured: Record<string, unknown> | undefined

  globalThis.fetch = (async (_input, init) => {
    captured = JSON.parse(String(init?.body))
    return makeFakeResponsesResponse()
  }) as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model,
    system: 'system prompt',
    messages,
  })

  if (!captured) throw new Error('Responses request not captured')
  return captured
}

function getToolMessages(body: Record<string, unknown>): Array<{ content: string }> {
  const messages = body.messages as Array<{ role: string; content: string }>
  return messages.filter(m => m.role === 'tool')
}

function getAssistantToolCalls(body: Record<string, unknown>): unknown[] {
  const messages = body.messages as Array<{
    role: string
    tool_calls?: unknown[]
  }>
  return messages
    .filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls))
    .flatMap(m => m.tool_calls ?? [])
}

type ResponsesInputItem = {
  type: string
  role?: string
  id?: string
  call_id?: string
  name?: string
  output?: string
  content?: Array<{ type?: string; text?: string; image_url?: string }>
}

function getResponsesInput(body: Record<string, unknown>): ResponsesInputItem[] {
  return body.input as ResponsesInputItem[]
}

function getResponsesFunctionCalls(body: Record<string, unknown>): ResponsesInputItem[] {
  return getResponsesInput(body).filter(item => item.type === 'function_call')
}

function getResponsesFunctionOutputs(body: Record<string, unknown>): ResponsesInputItem[] {
  return getResponsesInput(body).filter(item => item.type === 'function_call_output')
}

function buildStructuredLongConversation(resultLength = 5_000) {
  const messages = buildLongConversation(30, resultLength)

  messages[2] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_0',
        content: '[Old tool result content cleared]',
      },
    ],
  }

  messages[33] = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking both files.' },
      {
        type: 'tool_use',
        id: 'toolu_16',
        name: 'Read',
        input: { file_path: '/path/to/file16.ts' },
      },
      { type: 'text', text: 'The second file is related.' },
      {
        type: 'tool_use',
        id: 'toolu_16_extra',
        name: 'Read',
        input: { file_path: '/path/to/extra16.ts' },
      },
    ],
  }
  messages[34] = {
    role: 'user',
    content: [
      { type: 'text', text: 'Keep the screenshot with the results.' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_16',
        content: bigText(resultLength),
      },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_16_extra',
        content: bigText(resultLength),
      },
    ],
  }

  return messages
}

// ============================================================================
// BUG REPRO: without compression, full tool history is resent every turn
// ============================================================================

test('BUG REPRO: without compression, all 30 tool results are sent at full size', async () => {
  setCompressionEnabledForTest(false)
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, 'gpt-4o')
  const toolMessages = getToolMessages(body)
  const payloadSize = JSON.stringify(body).length

  // All 30 tool results present, none truncated
  expect(toolMessages.length).toBe(30)
  for (const m of toolMessages) {
    expect(m.content.length).toBeGreaterThanOrEqual(5_000)
    expect(m.content).not.toContain('[…truncated')
    expect(m.content).not.toContain('chars omitted')
  }

  // Total payload is large (~150KB raw) — this is the cost being paid every turn
  expect(payloadSize).toBeGreaterThan(150_000)
})

// ============================================================================
// FIX: with compression, recent kept full, mid truncated, old stubbed
// ============================================================================

test('FIX: with compression on a 128k model (tier 5/10/rest), 30 turns shrinks dramatically', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000 // 64–128k → recent=5, mid=10
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, MID_TIER_MODEL)
  const toolMessages = getToolMessages(body)
  const payloadSize = JSON.stringify(body).length

  // Structure preserved: still 30 tool messages, no orphan tool_calls
  expect(toolMessages.length).toBe(30)
  expect(getAssistantToolCalls(body).length).toBe(30)

  // Tier breakdown (oldest → newest):
  //   indices 0..14  → old tier (stubs)
  //   indices 15..24 → mid tier (truncated)
  //   indices 25..29 → recent (full)
  for (let i = 0; i <= 14; i++) {
    expect(toolMessages[i].content).toMatch(/^\[Read args=.*chars omitted\]$/)
  }
  for (let i = 15; i <= 24; i++) {
    expect(toolMessages[i].content).toContain('[…truncated')
  }
  for (let i = 25; i <= 29; i++) {
    expect(toolMessages[i].content.length).toBe(5_000)
    expect(toolMessages[i].content).not.toContain('[…truncated')
    expect(toolMessages[i].content).not.toContain('chars omitted')
  }

  // Significant reduction: from ~150KB to <60KB (10 mid×2KB + structure overhead)
  expect(payloadSize).toBeLessThan(60_000)
})

// ============================================================================
// FIX: large-context model gets generous tiers — compression effectively inert
// ============================================================================

test('FIX: 1M context model with 25 exchanges keeps all full (recent tier=25)', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 1_000_000 // ≥500k → recent=25, mid=50
  const messages = buildLongConversation(25, 5_000)

  const body = await captureRequestBody(messages, LARGE_CONTEXT_MODEL)
  const toolMessages = getToolMessages(body)

  expect(toolMessages.length).toBe(25)
  for (const m of toolMessages) {
    expect(m.content.length).toBe(5_000)
    expect(m.content).not.toContain('[…truncated')
    expect(m.content).not.toContain('chars omitted')
  }
})

test('FIX: 1M context model with 30 exchanges → only first 5 mid-truncated', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 1_000_000 // recent=25, mid=50
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, LARGE_CONTEXT_MODEL)
  const toolMessages = getToolMessages(body)

  // 30 total: indices 0..4 mid, indices 5..29 recent
  for (let i = 0; i < 5; i++) {
    expect(toolMessages[i].content).toContain('[…truncated')
  }
  for (let i = 5; i < 30; i++) {
    expect(toolMessages[i].content.length).toBe(5_000)
  }
})

test('provider override uses Z.AI Flash limits instead of ambient Anthropic limits', async () => {
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_BASE_URL
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
  const messages = buildLongConversation(25, 5_000)

  const zaiBody = await captureRequestBody(messages, 'claude-sonnet-4-6', {
    useModelWindow: true,
    providerOverride: {
      model: 'glm-5.3-flash',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'test-key',
    },
  })
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://custom.example.test/v1'
  const customBody = await captureRequestBody(messages, 'claude-sonnet-4-6', {
    useModelWindow: true,
    providerOverride: {
      model: 'glm-5.3-flash',
      baseURL: 'https://custom.example.test/v1',
      apiKey: 'test-key',
    },
  })
  const zaiToolMessages = getToolMessages(zaiBody)
  const customToolMessages = getToolMessages(customBody)

  expect(zaiBody.model).toBe('glm-5.3-flash')
  expect(customBody.model).toBe('glm-5.3-flash')
  expect(zaiToolMessages).toHaveLength(25)
  expect(customToolMessages).toHaveLength(25)
  for (const message of zaiToolMessages) {
    expect(message.content).toHaveLength(5_000)
    expect(message.content).not.toContain('chars omitted')
    expect(message.content).not.toContain('[…truncated')
  }
  for (let index = 0; index < 10; index++) {
    expect(customToolMessages[index].content).toContain('chars omitted')
  }
  for (let index = 10; index < 20; index++) {
    expect(customToolMessages[index].content).toContain('[…truncated')
  }
  for (let index = 20; index < 25; index++) {
    expect(customToolMessages[index].content).toHaveLength(5_000)
    expect(customToolMessages[index].content).not.toContain('chars omitted')
    expect(customToolMessages[index].content).not.toContain('[…truncated')
  }
})

test('Kimi K3 256K selection keeps history uncompressed (implicit prefix caching) while sending the k3 API name', async () => {
  mockState.enabled = true
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  const messages = buildLongConversation(50, 5_000)

  const body = await captureRequestBody(messages, 'k3-256k', {
    useModelWindow: true,
  })
  const toolMessages = getToolMessages(body)

  expect(body.model).toBe('k3')
  expect(toolMessages).toHaveLength(50)
  // api.kimi.com does implicit prefix caching: compressToolHistory's
  // end-relative window would rewrite already-sent tool results each turn
  // and bust the cache, so compression is skipped for this host.
  for (const m of toolMessages) {
    expect(m.content).not.toContain('chars omitted')
    expect(m.content).not.toContain('[…truncated')
  }
})

test('implicit-prefix-caching host (api.deepseek.com) skips tool-history compression', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000 // small window: would compress on a custom endpoint
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, 'deepseek-chat')
  const toolMessages = getToolMessages(body)

  expect(toolMessages).toHaveLength(30)
  for (const m of toolMessages) {
    expect(m.content.length).toBe(5_000)
    expect(m.content).not.toContain('chars omitted')
    expect(m.content).not.toContain('[…truncated')
  }
})

test('non-caching custom endpoint still compresses tool history', async () => {
  // Guard against the inverse regression: the prefix-caching skip must not
  // disable compression for endpoints with no implicit caching. The default
  // harness base URL (http://example.test/v1) is such an endpoint.
  mockState.enabled = true
  mockState.effectiveWindow = 100_000 // recent=12, mid=25
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, 'gpt-4o')
  const toolMessages = getToolMessages(body)

  expect(toolMessages).toHaveLength(30)
  expect(toolMessages[0].content).toContain('chars omitted')
})

test('implicit-prefix-caching host skips compression on the Responses path too', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(30, 5_000)

  const body = await captureResponsesRequestBody(messages, 'gpt-4o', {
    baseUrl: 'https://api.openai.com/v1',
  })
  const outputs = (body.input as Array<{ type?: string; output?: string }>)
    .filter(item => item.type === 'function_call_output')

  expect(outputs).toHaveLength(30)
  for (const item of outputs) {
    expect(item.output).not.toContain('chars omitted')
    expect(item.output).not.toContain('[…truncated')
  }
})

// ============================================================================
// FIX: stub preserves tool name and args — model can re-invoke if needed
// ============================================================================

test('FIX: stub format includes original tool name and arguments', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, MID_TIER_MODEL)
  const toolMessages = getToolMessages(body)
  const oldestStub = toolMessages[0].content

  // Format: [<tool_name> args=<json> → <N> chars omitted]
  expect(oldestStub).toMatch(/^\[Read /)
  expect(oldestStub).toMatch(/file_path/)
  expect(oldestStub).toMatch(/→ 5000 chars omitted\]$/)
})

// ============================================================================
// FIX: tool_use blocks (assistant tool_calls) are never modified
// ============================================================================

test('FIX: every tool_call retains its full id, name, and arguments', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(30, 5_000)

  const body = await captureRequestBody(messages, MID_TIER_MODEL)
  const toolCalls = getAssistantToolCalls(body) as Array<{
    id: string
    function: { name: string; arguments: string }
  }>

  expect(toolCalls.length).toBe(30)
  for (let i = 0; i < toolCalls.length; i++) {
    expect(toolCalls[i].id).toBe(`toolu_${i}`)
    expect(toolCalls[i].function.name).toBe('Read')
    expect(JSON.parse(toolCalls[i].function.arguments)).toEqual({
      file_path: `/path/to/file${i}.ts`,
    })
  }
})

// ============================================================================
// FIX: small-context provider (Mistral 32k) gets aggressive compression
// ============================================================================

test('FIX: 32k window tier → recent=3 keeps last 3 only', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 24_000 // 16–32k → recent=3, mid=5
  const messages = buildLongConversation(15, 3_000)

  const body = await captureRequestBody(messages, SMALL_CONTEXT_MODEL)
  const toolMessages = getToolMessages(body)

  // 15 total: indices 0..6 old, 7..11 mid, 12..14 recent
  for (let i = 0; i <= 6; i++) {
    expect(toolMessages[i].content).toContain('chars omitted')
  }
  for (let i = 7; i <= 11; i++) {
    expect(toolMessages[i].content).toContain('[…truncated')
  }
  for (let i = 12; i <= 14; i++) {
    expect(toolMessages[i].content.length).toBe(3_000)
  }
})

test('Chat compression omits old and mid-tier inline image payloads', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const imageData = 'a'.repeat(100_000)
  const messages = buildLongConversation(30, 5_000)
  messages[2] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_0',
        content: [
          {
            type: 'image',
            source: {
              type: 'url',
              url: `data:image/png;charset=utf-8;base64,${imageData}`,
            },
          },
        ],
      },
    ],
  }
  messages[32] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_15',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: imageData,
            },
          },
        ],
      },
    ],
  }
  const body = await captureRequestBody(messages, MID_TIER_MODEL)
  const toolOutputs = getToolMessages(body).map(message => message.content)

  expect(toolOutputs[0]).toContain('0 chars omitted')
  expect(toolOutputs[1]).toContain('5000 chars omitted')
  expect(toolOutputs[15]).toContain('[Inline image omitted from tool history]')
  expect(JSON.stringify(body)).not.toContain(imageData)
  expect(JSON.stringify(body).length).toBeLessThan(100_000)
})

test('Chat compression bounds structured text using its serialized separators', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(10, 5_000)
  messages[2] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_0',
        content: Array.from({ length: 2_000 }, () => ({ type: 'text', text: 'x' })),
      },
    ],
  }

  const body = await captureRequestBody(messages, MID_TIER_MODEL)
  const firstToolOutput = getToolMessages(body)[0]?.content ?? ''

  expect(firstToolOutput).toContain('[…truncated')
  expect(firstToolOutput.length).toBeLessThan(2_200)
})

test('Responses compression bounds structured text using its serialized separators', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(10, 5_000)
  messages[2] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_0',
        content: Array.from({ length: 2_000 }, () => ({ type: 'text', text: 'x' })),
      },
    ],
  }

  const body = await captureResponsesRequestBody(messages, MID_TIER_MODEL)
  const firstToolOutput = getResponsesFunctionOutputs(body)[0]?.output ?? ''

  expect(firstToolOutput).toContain('[…truncated')
  expect(firstToolOutput.length).toBeLessThan(2_200)
  expect(firstToolOutput.length).toBeGreaterThan(2_000)
})

test('Responses compression preserves structured history and materially reduces the payload', async () => {
  mockState.effectiveWindow = 100_000
  const messages = buildStructuredLongConversation()

  mockState.enabled = false
  const uncompressedBody = await captureResponsesRequestBody(messages, MID_TIER_MODEL)
  const uncompressedOutputs = getResponsesFunctionOutputs(uncompressedBody)
  const uncompressedByCallId = new Map(
    uncompressedOutputs.map(item => [item.call_id, item.output ?? '']),
  )
  const uncompressedSize = JSON.stringify(uncompressedBody).length

  expect(uncompressedBody).toHaveProperty('input')
  expect(uncompressedBody).not.toHaveProperty('messages')
  expect(uncompressedByCallId.get('toolu_1')).toHaveLength(5_000)
  expect(uncompressedByCallId.get('toolu_1')).not.toContain('[…truncated')
  expect(uncompressedByCallId.get('toolu_1')).not.toContain('chars omitted')

  mockState.enabled = true
  const compressedBody = await captureResponsesRequestBody(messages, MID_TIER_MODEL)
  const functionCalls = getResponsesFunctionCalls(compressedBody)
  const functionOutputs = getResponsesFunctionOutputs(compressedBody)
  const compressedByCallId = new Map(
    functionOutputs.map(item => [item.call_id, item.output ?? '']),
  )
  const compressedSize = JSON.stringify(compressedBody).length

  expect(compressedBody).toHaveProperty('input')
  expect(compressedBody).not.toHaveProperty('messages')
  expect(functionCalls).toHaveLength(31)
  expect(functionOutputs).toHaveLength(31)
  expect(functionCalls.map(item => item.call_id)).toEqual(
    functionOutputs.map(item => item.call_id),
  )

  expect(compressedByCallId.get('toolu_0')).toBe(
    '[Old tool result content cleared]',
  )
  for (let i = 1; i <= 15; i++) {
    expect(compressedByCallId.get(`toolu_${i}`)).toMatch(
      /^\[Read args=.*chars omitted\]$/,
    )
  }
  for (let i = 16; i <= 24; i++) {
    expect(compressedByCallId.get(`toolu_${i}`)).toContain('[…truncated')
  }
  expect(compressedByCallId.get('toolu_16_extra')).toContain('[…truncated')
  for (let i = 25; i <= 29; i++) {
    expect(compressedByCallId.get(`toolu_${i}`)).toHaveLength(5_000)
    expect(compressedByCallId.get(`toolu_${i}`)).not.toContain('[…truncated')
    expect(compressedByCallId.get(`toolu_${i}`)).not.toContain('chars omitted')
  }

  const inputParts = getResponsesInput(compressedBody).flatMap(
    item => item.content ?? [],
  )
  expect(inputParts).toContainEqual({
    type: 'input_image',
    image_url: 'data:image/png;base64,aGVsbG8=',
  })
  expect(inputParts).toContainEqual({
    type: 'input_text',
    text: 'Keep the screenshot with the results.',
  })
  expect(inputParts).toContainEqual({
    type: 'output_text',
    text: 'Checking both files.',
  })

  expect(compressedSize).toBeLessThan(uncompressedSize * 0.5)
})

test('Responses compression assigns tiers per parallel tool result', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildParallelToolConversation(5, 6)

  const body = await captureResponsesRequestBody(messages, MID_TIER_MODEL)
  const functionCalls = getResponsesFunctionCalls(body)
  const functionOutputs = getResponsesFunctionOutputs(body)
  const outputs = new Map(
    functionOutputs.map(item => [item.call_id, item.output ?? '']),
  )

  expect(functionCalls).toHaveLength(30)
  expect(functionOutputs).toHaveLength(30)
  expect(functionCalls.map(item => item.call_id)).toEqual(
    functionOutputs.map(item => item.call_id),
  )
  for (let i = 0; i < 15; i++) {
    expect(outputs.get(`toolu_${i}`)).toMatch(
      /^\[Read args=.*5000 chars omitted\]$/,
    )
  }
  for (let i = 15; i < 25; i++) {
    expect(outputs.get(`toolu_${i}`)).toContain(
      '[…truncated 3000 chars from tool history]',
    )
  }
  for (let i = 25; i < 30; i++) {
    expect(outputs.get(`toolu_${i}`)).toHaveLength(5_000)
  }
})

test('Responses compression preserves structured parts while compressing old and mid text', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const messages = buildLongConversation(30, 5_000)
  messages[2] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_0',
        content: [
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/old-image.png' },
          },
        ],
      },
    ],
  }
  messages[4] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [
          { type: 'text', text: 'Screenshot from the old result.' },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/mixed-result.png' },
          },
        ],
      },
    ],
  }
  messages[32] = {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_15',
        content: [
          { type: 'text', text: bigText(5_000) },
          {
            type: 'image',
            source: { type: 'url', url: 'https://example.com/mid-result.png' },
          },
        ],
      },
    ],
  }

  const body = await captureResponsesRequestBody(messages, MID_TIER_MODEL)
  const outputs = new Map(
    getResponsesFunctionOutputs(body).map(item => [item.call_id, item.output ?? '']),
  )
  const oldMixedOutput = outputs.get('toolu_1') ?? ''
  const midMixedOutput = outputs.get('toolu_15') ?? ''

  expect(outputs.get('toolu_0')).toBe('[Image](https://example.com/old-image.png)')
  expect(outputs.get('toolu_0')).not.toContain('chars omitted')
  expect(oldMixedOutput).toMatch(/^\[Read args=.*31 chars omitted\]/)
  expect(oldMixedOutput).toContain('[Image](https://example.com/mixed-result.png)')
  expect(oldMixedOutput.length).toBeLessThan(200)
  expect(midMixedOutput).toContain('[…truncated 3000 chars from tool history]')
  expect(midMixedOutput).toContain('[Image](https://example.com/mid-result.png)')
  expect(midMixedOutput.length).toBeLessThan(2_200)
})

test('Responses local fast path preserves the uncompressed request', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const body = await captureResponsesRequestBody(
    buildLongConversation(30, 5_000),
    MID_TIER_MODEL,
    { baseUrl: 'http://localhost:8000/v1' },
  )
  const outputs = getResponsesFunctionOutputs(body)

  expect(body).toHaveProperty('input')
  expect(body).not.toHaveProperty('messages')
  expect(outputs).toHaveLength(30)
  expect(outputs[0]?.output).toHaveLength(5_000)
  expect(outputs[0]?.output).not.toContain('[…truncated')
  expect(outputs[0]?.output).not.toContain('chars omitted')
  expect(JSON.stringify(body).length).toBeGreaterThan(150_000)
})

test('responses_compat keeps text content types while compressing tool outputs', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  const body = await captureResponsesRequestBody(
    buildStructuredLongConversation(),
    MID_TIER_MODEL,
    { apiFormat: 'responses_compat' },
  )
  const outputs = getResponsesFunctionOutputs(body)
  const contentParts = getResponsesInput(body).flatMap(item => item.content ?? [])

  expect(outputs.find(item => item.call_id === 'toolu_1')?.output).toContain(
    'chars omitted',
  )
  expect(contentParts.some(part => part.type === 'text')).toBe(true)
  expect(contentParts.some(part => part.type === 'input_text')).toBe(false)
  expect(contentParts.some(part => part.type === 'output_text')).toBe(false)
})

test('Responses compression leaves histories without tool results unchanged', async () => {
  mockState.enabled = true
  const body = await captureResponsesRequestBody(
    [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ],
    MID_TIER_MODEL,
  )

  expect(getResponsesFunctionCalls(body)).toHaveLength(0)
  expect(getResponsesFunctionOutputs(body)).toHaveLength(0)
  expect(getResponsesInput(body)).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'continue' }],
    },
  ])
})

test('GitHub chat fallback compresses the retried Responses request', async () => {
  mockState.enabled = true
  mockState.effectiveWindow = 100_000
  setCompressionEnabledForTest(true)
  setEffectiveWindowForTest(100_000)
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_API_FORMAT
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'github-test-key'
  process.env.GITHUB_TOKEN = 'github-test-key'

  const urls: string[] = []
  let fallbackBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    urls.push(String(input))
    if (urls.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: '/chat/completions not accessible' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    fallbackBody = JSON.parse(String(init?.body))
    return makeFakeResponsesResponse()
  }) as FetchType

  const messages = buildLongConversation(30, 5_000)
  messages[34] = {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_16',
      content: [
        { type: 'text', text: 'a'.repeat(1_000) },
        { type: 'text', text: 'b'.repeat(1_500) },
      ],
    }],
  }

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    messages,
  })

  expect(urls).toEqual([
    'https://api.githubcopilot.com/chat/completions',
    'https://api.githubcopilot.com/responses',
  ])
  expect(fallbackBody).toBeDefined()
  const outputs = getResponsesFunctionOutputs(fallbackBody!)
  expect(outputs[16]?.output).toBe(
    `${'a'.repeat(1_000)}\n${'b'.repeat(999)}\n[…truncated 501 chars from tool history]`,
  )
  expect(outputs[29]?.output).toHaveLength(5_000)
})

test('GitHub chat fallback preserves provider-override Z.AI Flash limits', async () => {
  setCompressionEnabledForTest(true)
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_API_FORMAT
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.OPENAI_BASE_URL = 'https://api.githubcopilot.com'
  process.env.OPENAI_API_KEY = 'github-test-key'
  process.env.GITHUB_TOKEN = 'github-test-key'

  const urls: string[] = []
  let fallbackBody: Record<string, unknown> | undefined
  globalThis.fetch = (async (input, init) => {
    urls.push(String(input))
    if (urls.length === 1) {
      return new Response(
        JSON.stringify({ error: { message: '/chat/completions not accessible' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }
    fallbackBody = JSON.parse(String(init?.body))
    return makeFakeResponsesResponse()
  }) as FetchType

  const client = createOpenAIShimClient({
    providerOverride: {
      model: 'glm-5.3-flash',
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'zai-test-key',
    },
  }) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'gpt-4o',
    messages: buildLongConversation(25, 5_000),
  })

  expect(urls).toEqual([
    'https://api.z.ai/api/coding/paas/v4/chat/completions',
    'https://api.z.ai/api/coding/paas/v4/responses',
  ])
  expect(fallbackBody).toBeDefined()
  const outputs = getResponsesFunctionOutputs(fallbackBody!)
  expect(outputs).toHaveLength(25)
  for (const output of outputs) {
    expect(output.output).toHaveLength(5_000)
    expect(output.output).not.toContain('chars omitted')
    expect(output.output).not.toContain('[…truncated')
  }
})

test('non-chat transports do not invoke the Chat message converter', () => {
  const selectMessages = __test.getChatMessagesForTransport
  const unexpectedConversion = () => {
    throw new Error('Chat converter must stay lazy')
  }

  expect(selectMessages('responses', unexpectedConversion)).toBeUndefined()
  expect(selectMessages('responses_compat', unexpectedConversion)).toBeUndefined()
  expect(selectMessages('anthropic_messages', unexpectedConversion)).toBeUndefined()
  expect(selectMessages('gemini', unexpectedConversion)).toBeUndefined()

  const chatMessages = [{ role: 'user', content: 'hello' }]
  expect(selectMessages('chat_completions', () => chatMessages)).toBe(chatMessages)
})

test('only OpenAI-compatible transports invoke tool history compression', () => {
  const selectMessages = __test.getCompressedMessagesForTransport
  const rawMessages = [{ role: 'user', content: 'hello' }]
  const compressedMessages = [{ role: 'user', content: 'compressed' }]
  let compressionCalls = 0
  const compress = () => {
    compressionCalls++
    return compressedMessages
  }

  expect(selectMessages('anthropic_messages', rawMessages, compress)).toBe(rawMessages)
  expect(selectMessages('gemini', rawMessages, compress)).toBe(rawMessages)
  expect(selectMessages('future_transport', rawMessages, compress)).toBe(rawMessages)
  expect(compressionCalls).toBe(0)

  expect(selectMessages('responses', rawMessages, compress)).toBe(compressedMessages)
  expect(selectMessages('responses_compat', rawMessages, compress)).toBe(compressedMessages)
  expect(selectMessages('chat_completions', rawMessages, compress)).toBe(compressedMessages)
  expect(compressionCalls).toBe(3)
})

test('Gemini image detection requires an image MIME type', () => {
  const containsImages = __test.requestBodyContainsImages

  expect(containsImages({
    contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } }] }],
  })).toBe(true)
  expect(containsImages({
    contents: [{ parts: [{ fileData: { mimeType: 'image/jpeg', fileUri: 'gs://bucket/image.jpg' } }] }],
  })).toBe(true)
  expect(containsImages({
    contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: 'aGVsbG8=' } }] }],
  })).toBe(false)
  expect(containsImages({
    contents: [{ parts: [{ fileData: { mimeType: 'application/pdf', fileUri: 'gs://bucket/file.pdf' } }] }],
  })).toBe(false)
})

test('Responses conversion stays single-pass when error classification inspects images', async () => {
  mockState.enabled = false
  setCompressionEnabledForTest(false)
  process.env.OPENAI_API_FORMAT = 'responses'
  let contentReads = 0
  let fetchCalls = 0
  const message = {
    role: 'user',
    get content() {
      contentReads++
      if (contentReads > 1) {
        throw new Error('Responses input was converted more than once')
      }
      return 'hello'
    },
  }

  globalThis.fetch = (async () => {
    fetchCalls++
    return new Response('server error', { status: 500 })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  let rejection: unknown
  try {
    await client.beta.messages.create({
      model: MID_TIER_MODEL,
      messages: [message],
    })
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBeDefined()
  expect(fetchCalls).toBe(1)
  expect(contentReads).toBe(1)
})

test('local self-healing follows the serialized image-free Chat body', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:8000'
  const requestUrls: string[] = []
  const requestBodies: string[] = []

  globalThis.fetch = (async (input, init) => {
    requestUrls.push(String(input))
    requestBodies.push(String(init?.body))
    if (requestUrls.length === 1) {
      return new Response('Not Found', { status: 404 })
    }
    return makeFakeResponse()
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: MID_TIER_MODEL,
    messages: [
      { role: 'user', content: 'inspect the attachment' },
      {
        role: 'assistant',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
      { role: 'user', content: 'continue' },
    ],
  })

  expect(requestUrls).toEqual([
    'http://localhost:8000/chat/completions',
    'http://localhost:8000/v1/chat/completions',
  ])
  expect(requestBodies[0]).not.toContain('"type":"image_url"')
  expect(requestBodies[1]).toBe(requestBodies[0])
})

test('local image requests probe alternate OpenAI-compatible endpoints before failing', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:8000'
  const requestUrls: string[] = []
  const requestBodies: string[] = []

  globalThis.fetch = (async (input, init) => {
    requestUrls.push(String(input))
    requestBodies.push(String(init?.body))
    if (requestUrls.length === 1) {
      return new Response('Not Found', { status: 404 })
    }
    return makeFakeResponse()
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: MID_TIER_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect the attachment' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ],
  })

  expect(requestUrls).toEqual([
    'http://localhost:8000/chat/completions',
    'http://localhost:8000/v1/chat/completions',
  ])
  expect(requestBodies[0]).toContain('"type":"image_url"')
  expect(requestBodies[1]).toBe(requestBodies[0])
})

test('native Ollama image requests preserve local endpoint fallback', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'
  const requestUrls: string[] = []
  const requestBodies: Array<Record<string, unknown>> = []

  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requestUrls.push(url)
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    if (url.includes('localhost')) {
      return new Response('Not Found', { status: 404 })
    }
    return new Response(
      JSON.stringify({
        model: 'qwen2.5-coder:7b',
        message: { role: 'assistant', content: 'image received' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 5,
        eval_count: 2,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await client.beta.messages.create({
    model: 'qwen2.5-coder:7b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe the image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ],
  })

  expect(requestUrls).toEqual([
    'http://localhost:11434/api/chat',
    'http://127.0.0.1:11434/api/chat',
  ])
  for (const requestBody of requestBodies) {
    const messages = requestBody.messages as Array<{ images?: string[] }>
    expect(messages[0]?.images).toEqual(['aGVsbG8='])
  }
})

test('native Ollama image requests keep vision diagnosis after local fallbacks', async () => {
  process.env.OPENAI_BASE_URL = 'http://localhost:11434'
  const requestUrls: string[] = []
  globalThis.fetch = (async input => {
    requestUrls.push(String(input))
    return new Response('Not Found', { status: 404 })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(client.beta.messages.create({
    model: 'qwen2.5-coder:7b',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe the image' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'aGVsbG8=',
            },
          },
        ],
      },
    ],
  })).rejects.toThrow('openai_category=vision_not_supported')
  expect(requestUrls).toEqual([
    'http://localhost:11434/api/chat',
    'http://127.0.0.1:11434/api/chat',
  ])
})

test('image error classification follows JSON-normalized Anthropic content', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://opencode.ai/zen/go/v1'
  process.env.OPENAI_MODEL = 'minimax-m3'
  process.env.OPENCODE_API_KEY = 'test-opencode-key'

  globalThis.fetch = (async (_input, init) => {
    expect(String(init?.body)).toContain('"type":"image"')
    return new Response('Not Found', { status: 404 })
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  await expect(client.beta.messages.create({
    model: 'minimax-m3',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'placeholder',
            toJSON() {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'aGVsbG8=',
                },
              }
            },
          },
        ],
      },
    ],
  })).rejects.toThrow('openai_category=vision_not_supported')
})

test('Responses requests preserve an abort that happened before fetch', async () => {
  process.env.OPENAI_API_FORMAT = 'responses'
  const controller = new AbortController()
  const abortError = new DOMException('cancelled before request', 'AbortError')
  controller.abort(abortError)
  let fetchCalls = 0

  globalThis.fetch = (async (_input, init) => {
    fetchCalls++
    expect(init?.signal).toBe(controller.signal)
    expect(init?.signal?.aborted).toBe(true)
    throw init?.signal?.reason
  }) as unknown as FetchType

  const client = createOpenAIShimClient({}) as OpenAIShimClient
  let rejection: unknown
  try {
    await client.beta.messages.create(
      {
        model: MID_TIER_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
      },
      { signal: controller.signal },
    )
  } catch (error) {
    rejection = error
  }

  expect(rejection).toBe(abortError)
  expect(fetchCalls).toBe(1)
})
