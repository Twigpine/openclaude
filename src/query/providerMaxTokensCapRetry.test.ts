import { expect, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { z } from 'zod/v4'

import { query, type QueryParams } from '../query.js'
import { buildTool, type Tools } from '../Tool.js'
import type { QueryDeps } from './deps.js'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { getAssistantMessageFromError } from '../services/api/errors.js'

const echoTool = buildTool({
  name: 'Echo',
  inputSchema: z.object({ text: z.string() }),
  maxResultSizeChars: Infinity,
  async description() {
    return 'Echo input text'
  },
  async prompt() {
    return ''
  },
  async call(input) {
    return { data: `echo:${input.text}` }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: String(content),
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
})

function makeToolUseContext(tools: Tools = []): QueryParams['toolUseContext'] {
  const abortController = new AbortController()
  let inProgressToolUseIDs = new Set<string>()

  return {
    abortController,
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      toolPermissionContext: { mode: 'default' },
      sessionHooks: new Map(),
      mainLoopModel: 'gpt-4o',
      effortValue: undefined,
      advisorModel: undefined,
    }),
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools,
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      appendSystemPrompt: undefined,
      providerOverride: undefined,
      mainLoopModel: 'gpt-4o',
    },
    addNotification: () => {},
    messages: [],
    setInProgressToolUseIDs: updater => {
      inProgressToolUseIDs = updater(inProgressToolUseIDs)
    },
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

function makeParams(
  callModel: QueryDeps['callModel'],
  tools: Tools = [],
): QueryParams {
  return {
    messages: [createUserMessage({ content: 'hello' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(tools),
    querySource: 'sdk',
    deps: {
      callModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        compactionResult: null,
        consecutiveFailures: undefined,
      }),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as unknown as QueryDeps,
  }
}

// `any[]` on purpose: the collected stream mixes Message/StreamEvent/Terminal
// and the assertions below probe optional properties across all of them.
async function collect(params: QueryParams): Promise<any[]> {
  const previousSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  const messages: any[] = []
  try {
    for await (const message of query(params)) {
      messages.push(message)
    }
  } finally {
    if (previousSimple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = previousSimple
    }
  }
  return messages
}

test('retries once with provider maximum output token cap', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)

    if (seenOverrides.length === 1) {
      yield getAssistantMessageFromError(
        APIError.generate(
          400,
          undefined,
          'OpenAI API error 400: max_tokens exceeds maximum output tokens for this model: 27342. [openai_category=unknown]',
          new Headers(),
        ),
        'openrouter/model',
      )
      return
    }

    yield createAssistantMessage({ content: 'ok after retry' })
  }

  const messages = await collect(makeParams(callModel))

  expect(seenOverrides).toEqual([undefined, 27_342])
  expect(
    messages.some(
      message =>
        message?.type === 'system' &&
        message?.content?.includes(
          'Provider maximum output tokens limit is 27,342; retrying with that cap.',
        ),
    ),
  ).toBe(true)
  expect(
    messages.some(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'Provider max_tokens limit was lower than requested.',
    ),
  ).toBe(false)
})

test('keeps provider maximum output token cap for follow-up calls after tool use', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)

    if (seenOverrides.length === 1) {
      yield getAssistantMessageFromError(
        APIError.generate(
          400,
          undefined,
          'OpenAI API error 400: max_tokens exceeds maximum output tokens for this model: 27342. [openai_category=unknown]',
          new Headers(),
        ),
        'openrouter/model',
      )
      return
    }

    if (seenOverrides.length === 2) {
      yield createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_echo',
            name: 'Echo',
            input: { text: 'ping' },
          },
        ],
      })
      return
    }

    yield createAssistantMessage({ content: 'ok after tool' })
  }

  const messages = await collect(makeParams(callModel, [echoTool]))

  expect(seenOverrides).toEqual([undefined, 27_342, 27_342])
  expect(
    messages.filter(
      message =>
        message?.type === 'system' &&
        message?.content?.includes(
          'Provider maximum output tokens limit is 27,342; retrying with that cap.',
        ),
    ),
  ).toHaveLength(1)
  expect(
    messages.some(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'Provider max_tokens limit was lower than requested.',
    ),
  ).toBe(false)
})

test('does not loop if the reduced-cap retry fails', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)
    const cap = seenOverrides.length === 1 ? 27_342 : 16_384
    yield createAssistantAPIErrorMessage({
      content: 'Provider max_tokens limit was lower than requested.',
      apiError: 'max_tokens_too_high',
      error: 'invalid_request',
      errorDetails: `max_tokens exceeds maximum output tokens for this model: ${cap}`,
    })
  }

  const messages = await collect(makeParams(callModel))

  expect(seenOverrides).toEqual([undefined, 27_342])
  expect(
    messages.filter(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'Provider max_tokens limit was lower than requested.',
    ),
  ).toHaveLength(1)
})

test('does not retry OpenRouter affordability errors handled by withRetry', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)
    yield getAssistantMessageFromError(
      APIError.generate(
        402,
        undefined,
        'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 27342.',
        new Headers(),
      ),
      'openrouter/model',
    )
  }

  const messages = await collect(makeParams(callModel))

  expect(seenOverrides).toEqual([undefined])
  expect(
    messages.some(
      message =>
        message?.type === 'system' &&
        message?.content?.includes('retrying with that cap'),
    ),
  ).toBe(false)
  expect(
    messages.some(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text?.includes('can only afford 27342'),
    ),
  ).toBe(true)
})

test('OpenAI-compatible context overflow messages are tagged for recovery', () => {
  const message = getAssistantMessageFromError(
    APIError.generate(
      400,
      undefined,
      'OpenAI API error 400: Bad Request [openai_category=context_overflow,host=api.z.ai] too many tokens',
      new Headers(),
    ),
    'zai/model',
  )

  expect(message.apiError).toBe('context_overflow')
  expect(message.error).toBe('invalid_request')
})

test('compacts and retries once for context overflow errors', async () => {
  let callCount = 0
  const seenRequestMessages: QueryParams['messages'][] = []
  const callModel: QueryDeps['callModel'] = async function* ({ messages }) {
    seenRequestMessages.push(messages)
    callCount += 1
    if (callCount === 1) {
      yield createAssistantAPIErrorMessage({
        content: 'The conversation exceeded the provider context limit.',
        apiError: 'context_overflow',
        error: 'invalid_request',
      })
      return
    }

    yield createAssistantMessage({ content: 'ok after compact' })
  }
  const params = makeParams(callModel)
  const seenForceReasons: Array<string | undefined> = []
  let autocompactCalls = 0
  params.deps = {
    ...params.deps,
    autocompact: async (
      _messages,
      _toolUseContext,
      _cacheSafeParams,
      _querySource,
      tracking,
    ) => {
      autocompactCalls += 1
      seenForceReasons.push(tracking?.forceReason)
      if (autocompactCalls === 1) {
        return { wasCompacted: false }
      }

      return {
        wasCompacted: true,
        consecutiveFailures: 0,
        compactionResult: {
          boundaryMarker: createCompactBoundaryMessage('auto', 10_000),
          summaryMessages: [
            createUserMessage({ content: 'compacted context summary' }),
          ],
          messagesToKeep: [],
          attachments: [],
          hookResults: [],
          preCompactTokenCount: 10_000,
          postCompactTokenCount: 500,
          truePostCompactTokenCount: 500,
        },
      }
    },
  } as unknown as QueryDeps

  const messages = await collect(params)

  expect(callCount).toBe(2)
  expect(seenForceReasons).toEqual([undefined, 'context-overflow'])
  const retryMessages = seenRequestMessages[1] ?? []
  expect(
    retryMessages.some(
      message =>
        message.type === 'user' &&
        message.isMeta === true &&
        typeof message.message.content === 'string' &&
        message.message.content.includes('exceeded the context window') &&
        message.message.content.includes('retrying this turn once'),
    ),
  ).toBe(true)
  expect(
    messages.some(message => message?.apiError === 'context_overflow'),
  ).toBe(false)
  expect(
    messages.some(
      message =>
        message?.type === 'system' &&
        message?.content?.includes('compacting conversation and retrying'),
    ),
  ).toBe(true)
  expect(
    messages.some(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'ok after compact',
    ),
  ).toBe(true)
})

test('does not retry malformed provider cap errors', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)
    yield createAssistantAPIErrorMessage({
      content: 'Provider max_tokens limit was lower than requested.',
      apiError: 'max_tokens_too_high',
      error: 'invalid_request',
      errorDetails: 'max_tokens exceeds maximum output tokens',
    })
  }

  const messages = await collect(makeParams(callModel))

  expect(seenOverrides).toEqual([undefined])
  expect(
    messages.filter(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'Provider max_tokens limit was lower than requested.',
    ),
  ).toHaveLength(1)
})

test('does not retry when provider cap is not lower than the current override', async () => {
  const seenOverrides: Array<number | undefined> = []
  const callModel: QueryDeps['callModel'] = async function* ({ options }) {
    seenOverrides.push(options.maxOutputTokensOverride)
    yield createAssistantAPIErrorMessage({
      content: 'Provider max_tokens limit was lower than requested.',
      apiError: 'max_tokens_too_high',
      error: 'invalid_request',
      errorDetails: 'max_tokens exceeds maximum output tokens for this model: 16384',
    })
  }

  const params = makeParams(callModel)
  params.maxOutputTokensOverride = 8_192

  const messages = await collect(params)

  expect(seenOverrides).toEqual([8_192])
  expect(
    messages.some(
      message =>
        message?.type === 'system' &&
        message?.content?.includes('retrying with that cap'),
    ),
  ).toBe(false)
  expect(
    messages.filter(
      message =>
        message?.type === 'assistant' &&
        message?.message?.content?.[0]?.text === 'Provider max_tokens limit was lower than requested.',
    ),
  ).toHaveLength(1)
})
