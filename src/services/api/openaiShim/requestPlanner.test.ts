import { describe, expect, test } from 'bun:test'
import {
  createRequestBodyPlanner,
  hydrateOpenAIShimCompatibilityEnv,
} from './requestPlanner.js'

const envDependencies = (credential?: string) => ({
  isEnvTruthy: (value: string | undefined) => value === '1',
  resolveRouteCredentialValue: () => credential,
})

function createPlanner(
  overrides: Partial<Parameters<typeof createRequestBodyPlanner>[0]> = {},
) {
  const context: Parameters<typeof createRequestBodyPlanner>[0] = {
    request: { resolvedModel: 'test-model' },
    params: {
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 128,
      stream: true,
    },
    effectiveTransport: 'chat_completions',
    shouldStripResponsesStore: false,
    body: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    },
    reasoningRequestPlan: {},
    shimConfig: {},
    getResponsesInput: () => context.params.messages,
    convertSystemPrompt: (system) => (typeof system === 'string' ? system : ''),
    convertToolsToResponsesTools: (tools) =>
      tools.map((tool) => ({ type: 'function', name: tool.name })),
    getOllamaNumCtx: () => 32_768,
    normalizeOllamaNativeMessages: (messages) => messages,
    useNativeOllamaChat: false,
    fastPath: { skipStableStringify: false },
    stableStringifyJson: (value) => JSON.stringify(value),
    omitTools: { responses: false, anthropic: false, gemini: false },
    ...overrides,
  }
  return createRequestBodyPlanner(context)
}

describe('compatibility environment hydration', () => {
  test('hydrates provider aliases without replacing explicit OpenAI credentials', () => {
    const gemini: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_GEMINI: '1',
      GEMINI_API_KEY: 'gemini-key',
    }
    hydrateOpenAIShimCompatibilityEnv(gemini, envDependencies())
    expect(gemini.OPENAI_API_KEY).toBe('gemini-key')

    const mistral: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_MISTRAL: '1',
      MISTRAL_API_KEY: 'mistral-key',
      OPENAI_API_KEY: 'explicit-key',
    }
    hydrateOpenAIShimCompatibilityEnv(mistral, envDependencies())
    expect(mistral.OPENAI_API_KEY).toBe('explicit-key')
  })

  test('uses GitHub credential precedence and Bankr route defaults', () => {
    const github: NodeJS.ProcessEnv = {
      CLAUDE_CODE_USE_GITHUB: '1',
      GITHUB_TOKEN: 'github-token',
      GH_TOKEN: 'gh-token',
    }
    hydrateOpenAIShimCompatibilityEnv(github, envDependencies())
    expect(github.OPENAI_API_KEY).toBe('github-token')

    const bankr: NodeJS.ProcessEnv = {
      BANKR_BASE_URL: 'https://bankr.test/v1',
      BANKR_MODEL: 'bankr-model',
    }
    let resolvedBaseUrl: string | undefined
    hydrateOpenAIShimCompatibilityEnv(bankr, {
      isEnvTruthy: (value) => value === '1',
      resolveRouteCredentialValue: ({ baseUrl }) => {
        resolvedBaseUrl = baseUrl
        return 'route-key'
      },
    })
    expect(bankr).toMatchObject({
      OPENAI_BASE_URL: 'https://bankr.test/v1',
      OPENAI_MODEL: 'bankr-model',
      OPENAI_API_KEY: 'route-key',
    })
    expect(resolvedBaseUrl).toBe('https://bankr.test/v1')
  })
})

describe('Responses API body planning', () => {
  test('builds the fallback input, system, token, sampling, and reasoning fields', () => {
    const planner = createPlanner({
      effectiveTransport: 'responses_compat',
      params: {
        messages: [],
        system: 'system prompt',
        temperature: 0.3,
        top_p: 0.8,
        tools: [{ name: 'Read' }],
      },
      body: { max_completion_tokens: 256 },
      reasoningRequestPlan: {
        wireFormat: 'reasoning_effort',
        reasoningEffort: 'high',
      },
      getResponsesInput: () => [],
    })

    expect(planner.buildResponsesBody()).toEqual({
      model: 'test-model',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'text', text: '' }],
        },
      ],
      stream: false,
      store: false,
      instructions: 'system prompt',
      max_output_tokens: 256,
      temperature: 0.3,
      top_p: 0.8,
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'Read' }],
    })
  })

  test('applies store and configured-field removal on every rebuild', () => {
    const planner = createPlanner({
      effectiveTransport: 'responses',
      shouldStripResponsesStore: true,
      body: { max_tokens: 64 },
      shimConfig: { removeBodyFields: ['temperature'] },
      params: {
        messages: [{ role: 'user', content: 'hello' }],
        temperature: 1,
      },
    })

    expect(planner.buildResponsesBody()).toEqual({
      model: 'test-model',
      input: [{ role: 'user', content: 'hello' }],
      stream: false,
      max_output_tokens: 64,
    })
  })
})

describe('Anthropic Messages body planning', () => {
  test('filters only the billing system block and preserves native tools', () => {
    const planner = createPlanner({
      effectiveTransport: 'anthropic_messages',
      params: {
        messages: [{ role: 'user', content: 'hello' }],
        system: [
          { type: 'text', text: 'x-anthropic-billing-header: hidden' },
          { type: 'text', text: 'keep me' },
        ],
        max_tokens: 512,
        tools: [{ name: 'Read', input_schema: { type: 'object' } }],
        tool_choice: { type: 'auto' },
      },
    })

    expect(planner.buildAnthropicMessagesBody()).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 512,
      stream: false,
      system: [{ type: 'text', text: 'keep me' }],
      tools: [{ name: 'Read', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
    })
  })

  test('maps reasoning effort for adaptive and fixed-budget models', () => {
    const adaptive = createPlanner({
      request: {
        resolvedModel: 'claude-opus-4-6',
        reasoning: { effort: 'xhigh' },
      },
      effectiveTransport: 'anthropic_messages',
    }).buildAnthropicMessagesBody()
    expect(adaptive).toMatchObject({
      thinking: { type: 'adaptive' },
      effort: 'max',
    })

    const fixed = createPlanner({
      request: {
        resolvedModel: 'claude-sonnet-4',
        reasoning: { effort: 'high' },
      },
      effectiveTransport: 'anthropic_messages',
    }).buildAnthropicMessagesBody()
    expect(fixed.thinking).toEqual({ type: 'enabled', budgetTokens: 16_000 })
  })
})

describe('Gemini body planning', () => {
  test('converts text, tool calls, and tool results with the original function name', () => {
    const planner = createPlanner({
      effectiveTransport: 'gemini',
      params: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'working' },
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'Read',
                input: { path: 'a' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                content: [{ type: 'text', text: 'result' }],
              },
            ],
          },
        ],
      },
    })

    expect(planner.buildGeminiBody().contents).toEqual([
      {
        role: 'model',
        parts: [
          { text: 'working' },
          { functionCall: { name: 'Read', args: { path: 'a' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'Read',
              response: { name: 'Read', content: 'result' },
            },
          },
        ],
      },
    ])
  })

  test('builds system, generation, reasoning, and function declaration fields', () => {
    const planner = createPlanner({
      request: {
        resolvedModel: 'gemini-model',
        reasoning: { effort: 'xhigh' },
      },
      effectiveTransport: 'gemini',
      params: {
        messages: [],
        system: 'system prompt',
        temperature: 0.2,
        top_p: 0.7,
        tools: [
          {
            name: 'Read',
            description: 'read a file',
            input_schema: { type: 'object' },
          },
        ],
      },
      maxCompletionTokensValue: 321,
    })

    expect(planner.buildGeminiBody()).toEqual({
      contents: [],
      systemInstruction: { parts: [{ text: 'system prompt' }] },
      generationConfig: {
        maxOutputTokens: 321,
        temperature: 0.2,
        topP: 0.7,
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'high' },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'Read',
              description: 'read a file',
              parameters: { type: 'object' },
            },
          ],
        },
      ],
    })
  })
})

describe('serialization and retry state', () => {
  test('builds native Ollama options and uses the stable serializer', () => {
    let stableValue: unknown
    const planner = createPlanner({
      request: { resolvedModel: 'llama' },
      params: {
        messages: [],
        stream: true,
        temperature: 0.4,
        top_p: 0.6,
      },
      body: {
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 42,
        tools: [{ type: 'function' }],
      },
      useNativeOllamaChat: true,
      stableStringifyJson: (value) => {
        stableValue = value
        return 'stable-body'
      },
    })

    expect(planner.serializeBody()).toBe('stable-body')
    expect(stableValue).toEqual({
      model: 'llama',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      options: {
        num_ctx: 32_768,
        num_predict: 42,
        temperature: 0.4,
        top_p: 0.6,
      },
      tools: [{ type: 'function' }],
    })
  })

  test('shared omit flags rebuild transport bodies without tools', () => {
    const planner = createPlanner({
      effectiveTransport: 'responses',
      params: {
        messages: [],
        tools: [{ name: 'Read' }],
        tool_choice: { type: 'tool', name: 'Read' },
      },
    })
    expect(planner.buildResponsesBody()).toHaveProperty('tools')
    planner.omitTools.responses = true
    expect(planner.buildResponsesBody()).not.toHaveProperty('tools')
    planner.omitTools.anthropic = true
    expect(planner.buildAnthropicMessagesBody()).not.toHaveProperty('tools')
    expect(planner.buildAnthropicMessagesBody()).not.toHaveProperty('tool_choice')
    planner.omitTools.gemini = true
    expect(planner.buildGeminiBody()).not.toHaveProperty('tools')
  })

  test('serializeBody routes transport bodies and honors omit flags on rebuild', () => {
    const payloads: unknown[] = []
    const stableStringifyJson = (value: unknown) => {
      payloads.push(value)
      return JSON.stringify(value)
    }

    const responsesPlanner = createPlanner({
      effectiveTransport: 'responses',
      params: { messages: [], tools: [{ name: 'Read' }] },
      stableStringifyJson,
    })
    responsesPlanner.serializeBody()
    expect(payloads.at(-1)).toHaveProperty('tools')
    responsesPlanner.omitTools.responses = true
    responsesPlanner.serializeBody()
    expect(payloads.at(-1)).not.toHaveProperty('tools')

    const anthropicPlanner = createPlanner({
      effectiveTransport: 'anthropic_messages',
      params: {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'Read' }],
        tool_choice: { type: 'auto' },
      },
      stableStringifyJson,
    })
    anthropicPlanner.serializeBody()
    expect(payloads.at(-1)).toMatchObject({
      tools: [{ name: 'Read' }],
      tool_choice: { type: 'auto' },
    })
    anthropicPlanner.omitTools.anthropic = true
    anthropicPlanner.serializeBody()
    expect(payloads.at(-1)).not.toHaveProperty('tools')
    expect(payloads.at(-1)).not.toHaveProperty('tool_choice')

    const geminiPlanner = createPlanner({
      effectiveTransport: 'gemini',
      params: {
        messages: [],
        tools: [{ name: 'Read', description: 'read' }],
      },
      stableStringifyJson,
    })
    geminiPlanner.serializeBody()
    expect(payloads.at(-1)).toHaveProperty('tools')
    geminiPlanner.omitTools.gemini = true
    geminiPlanner.serializeBody()
    expect(payloads.at(-1)).not.toHaveProperty('tools')
  })

  test('uses native JSON serialization only when the fast path opts out', () => {
    const planner = createPlanner({
      body: { z: 1, a: 2 },
      fastPath: { skipStableStringify: true },
      stableStringifyJson: () => {
        throw new Error('stable serializer should not run')
      },
    })
    expect(planner.serializeBody()).toBe('{"z":1,"a":2}')
  })
})
