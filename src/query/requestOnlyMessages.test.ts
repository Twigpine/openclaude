import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { query, type QueryParams } from '../query.js'
import type { QueryDeps } from './deps.js'
import { buildTool, type Tools } from '../Tool.js'
import type { Message } from '../types/message.js'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from '../utils/messages.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { INTERRUPTION_CORRECTION_REMINDER } from '../utils/interruptionCorrection.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

function makeToolUseContext(
  tools: Tools = [],
  effortValue: 'low' | 'medium' | 'high' | undefined = undefined,
): QueryParams['toolUseContext'] {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      toolPermissionContext: { mode: 'default' },
      sessionHooks: new Map(),
      mainLoopModel: 'test-model',
      effortValue,
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
      mainLoopModel: 'test-model',
    },
    addNotification: () => {},
    messages: [],
    readFileState: {},
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

async function collect(params: QueryParams): Promise<unknown[]> {
  const yielded: unknown[] = []
  for await (const event of query(params)) yielded.push(event)
  return yielded
}

function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap(message =>
    message.type === 'user' && typeof message.message.content === 'string'
      ? [message.message.content]
      : [],
  )
}

function baseParams(
  callModel: QueryDeps['callModel'],
  autocompact: QueryDeps['autocompact'],
  tools: Tools = [],
): QueryParams {
  return {
    messages: [createUserMessage({ content: 'do Y instead' })],
    requestOnlyMessages: [
      createUserMessage({
        content: INTERRUPTION_CORRECTION_REMINDER,
        isMeta: true,
      }),
    ],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(tools),
    querySource: 'repl_main_thread',
    maxTurns: 2,
    deps: {
      callModel,
      microcompact: async messages => ({ messages }),
      autocompact,
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as QueryDeps,
  }
}

test('keeps request-only context in every model call but out of tool context', async () => {
  const modelCalls: Message[][] = []
  const toolContexts: Message[][] = []
  const inspectTool = buildTool({
    name: 'InspectContext',
    inputSchema: z.object({}),
    maxResultSizeChars: Infinity,
    async description() {
      return 'Inspect current context'
    },
    async prompt() {
      return ''
    },
    async call(_input, context) {
      toolContexts.push(context.messages)
      return { data: 'ok' }
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
  const callModel: QueryDeps['callModel'] = async function* ({ messages }) {
    modelCalls.push(messages)
    if (modelCalls.length === 1) {
      yield createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'inspect-context-1',
            name: 'InspectContext',
            input: {},
          },
        ],
      })
      return
    }
    yield createAssistantMessage({ content: 'done' })
  }

  await collect(
    baseParams(
      callModel,
      async () => ({ wasCompacted: false }),
      [inspectTool],
    ),
  )

  expect(modelCalls).toHaveLength(2)
  for (const messages of modelCalls) {
    expect(userTexts(messages)).toContain(INTERRUPTION_CORRECTION_REMINDER)
  }
  expect(userTexts(modelCalls[0]!)).toEqual([
    INTERRUPTION_CORRECTION_REMINDER,
    'do Y instead',
  ])
  expect(userTexts(modelCalls[1]!)).toEqual([
    INTERRUPTION_CORRECTION_REMINDER,
    'do Y instead',
  ])
  expect(toolContexts).toHaveLength(1)
  expect(userTexts(toolContexts[0]!)).not.toContain(
    INTERRUPTION_CORRECTION_REMINDER,
  )
})

test('leaves model messages unchanged when request-only context is absent', async () => {
  const originalMessages = [createUserMessage({ content: 'ordinary prompt' })]
  const modelCalls: Message[][] = []
  const callModel: QueryDeps['callModel'] = async function* ({ messages }) {
    modelCalls.push(messages)
    yield createAssistantMessage({ content: 'done' })
  }
  const params = baseParams(
    callModel,
    async () => ({ wasCompacted: false }),
  )
  params.messages = originalMessages
  params.requestOnlyMessages = undefined

  await collect(params)

  expect(modelCalls).toHaveLength(1)
  expect(modelCalls[0]).toEqual(originalMessages)
})

test('sends high effort for an ultrathink attachment on the current user turn', async () => {
  let requestEffort: unknown
  const params = baseParams(
    async function* ({ options }) {
      requestEffort = options.effortValue
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.messages = [
    createUserMessage({ content: 'ultrathink solve this' }),
    createAttachmentMessage({ type: 'ultrathink_effort', level: 'high' }),
  ]

  await collect(params)

  expect(requestEffort).toBe('high')
})

test('does not let a historical ultrathink attachment affect a later user turn', async () => {
  let requestEffort: unknown
  const params = baseParams(
    async function* ({ options }) {
      requestEffort = options.effortValue
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.messages = [
    createUserMessage({ content: 'ultrathink solve this' }),
    createAttachmentMessage({ type: 'ultrathink_effort', level: 'high' }),
    createAssistantMessage({ content: 'done' }),
    createUserMessage({ content: 'ordinary prompt' }),
  ]

  await collect(params)

  expect(requestEffort).toBeUndefined()
})

test('does not apply ultrathink effort to a meta-originated prompt', async () => {
  let requestEffort: unknown
  const params = baseParams(
    async function* ({ options }) {
      requestEffort = options.effortValue
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.messages = [
    createUserMessage({ content: 'previous user turn' }),
    createAssistantMessage({ content: 'done' }),
    createUserMessage({ content: 'ultrathink scheduled task', isMeta: true }),
    createAttachmentMessage({ type: 'ultrathink_effort', level: 'high' }),
  ]

  await collect(params)

  expect(requestEffort).toBeUndefined()
})

test('keeps ultrathink effort when image metadata follows its attachment', async () => {
  let requestEffort: unknown
  const params = baseParams(
    async function* ({ options }) {
      requestEffort = options.effortValue
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.messages = [
    createUserMessage({ content: 'ultrathink inspect this image' }),
    createAttachmentMessage({ type: 'ultrathink_effort', level: 'high' }),
    createUserMessage({ content: [{ type: 'text', text: 'image metadata' }], isMeta: true }),
  ]

  await collect(params)

  expect(requestEffort).toBe('high')
})

test('keeps an explicit effort selection over ultrathink', async () => {
  let requestEffort: unknown
  const params = baseParams(
    async function* ({ options }) {
      requestEffort = options.effortValue
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.toolUseContext = makeToolUseContext([], 'low')
  params.messages = [
    createUserMessage({ content: 'ultrathink solve this' }),
    createAttachmentMessage({ type: 'ultrathink_effort', level: 'high' }),
  ]

  await collect(params)

  expect(requestEffort).toBe('low')
})

test('scopes model-request lifecycle callbacks to provider dispatch', async () => {
  const events: string[] = []
  const params = baseParams(
    async function* ({ options }) {
      if (options.onProviderRequestStart?.() === false) return
      yield createAssistantMessage({ content: 'done' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.onModelRequestStart = () => events.push('start')
  params.onModelRequestEnd = () => events.push('end')

  await collect(params)

  expect(events).toEqual(['start', 'end'])
})

test('closes the model-request lifecycle when its start callback aborts', async () => {
  const events: string[] = []
  let providerDispatched = false
  const params = baseParams(
    async function* ({ options }) {
      if (options.onProviderRequestStart?.() === false) return
      providerDispatched = true
      yield createAssistantMessage({ content: 'must not dispatch' })
    },
    async () => ({ wasCompacted: false }),
  )
  params.onModelRequestStart = () => {
    events.push('start')
    params.toolUseContext.abortController.abort('background')
  }
  params.onModelRequestEnd = () => events.push('end')

  await collect(params)

  expect(providerDispatched).toBe(false)
  expect(events).toEqual(['start', 'end'])
})

for (const preserveCorrection of [false, true]) {
  test(`reapplies request-only context after ${
    preserveCorrection ? 'suffix-preserving' : 'full'
  } compaction without yielding it`, async () => {
    const correction = createUserMessage({ content: 'do Y instead' })
    const modelCalls: Message[][] = []
    const compactionInputs: Message[][] = []
    const callModel: QueryDeps['callModel'] = async function* ({ messages }) {
      modelCalls.push(messages)
      yield createAssistantMessage({ content: 'done' })
    }
    const autocompact: QueryDeps['autocompact'] = async messages => {
      compactionInputs.push(messages)
      return {
        wasCompacted: true,
        consecutiveFailures: 0,
        compactionResult: {
          boundaryMarker: createCompactBoundaryMessage('auto', 10_000),
          summaryMessages: [createUserMessage({ content: 'compact summary' })],
          messagesToKeep: preserveCorrection ? [correction] : [],
          attachments: [],
          hookResults: [],
          preCompactTokenCount: 10_000,
          postCompactTokenCount: 500,
          truePostCompactTokenCount: 500,
        },
      }
    }
    const params = baseParams(callModel, autocompact)
    params.messages = [correction]

    const yielded = await collect(params)

    expect(userTexts(compactionInputs[0]!)).not.toContain(
      INTERRUPTION_CORRECTION_REMINDER,
    )
    expect(userTexts(modelCalls[0]!)).toEqual(
      preserveCorrection
        ? ['compact summary', 'do Y instead']
        : ['compact summary'],
    )
    expect(
      yielded.some(
        event =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'user' &&
          'message' in event &&
          typeof event.message === 'object' &&
          event.message !== null &&
          'content' in event.message &&
          event.message.content === INTERRUPTION_CORRECTION_REMINDER,
      ),
    ).toBe(false)
  })
}

test('does not restore request-only context after compaction retries the turn', async () => {
  const modelCalls: Message[][] = []
  const inspectTool = buildTool({
    name: 'InspectContextAfterCompact',
    inputSchema: z.object({}),
    maxResultSizeChars: Infinity,
    async description() {
      return 'Inspect current context'
    },
    async prompt() {
      return ''
    },
    async call() {
      return { data: 'ok' }
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
  const callModel: QueryDeps['callModel'] = async function* ({ messages }) {
    modelCalls.push(messages)
    if (modelCalls.length === 1) {
      yield createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'inspect-after-compact',
            name: 'InspectContextAfterCompact',
            input: {},
          },
        ],
      })
      return
    }
    yield createAssistantMessage({ content: 'done' })
  }
  let compacted = false
  const autocompact: QueryDeps['autocompact'] = async () => {
    if (compacted) return { wasCompacted: false }
    compacted = true
    return {
      wasCompacted: true,
      consecutiveFailures: 0,
      compactionResult: {
        boundaryMarker: createCompactBoundaryMessage('auto', 10_000),
        summaryMessages: [createUserMessage({ content: 'compact summary' })],
        messagesToKeep: [createUserMessage({ content: 'do Y instead' })],
        attachments: [],
        hookResults: [],
        preCompactTokenCount: 10_000,
        postCompactTokenCount: 500,
        truePostCompactTokenCount: 500,
      },
    }
  }

  await collect(baseParams(callModel, autocompact, [inspectTool]))

  expect(modelCalls).toHaveLength(2)
  expect(userTexts(modelCalls[0]!)).not.toContain(
    INTERRUPTION_CORRECTION_REMINDER,
  )
  expect(userTexts(modelCalls[1]!)).not.toContain(
    INTERRUPTION_CORRECTION_REMINDER,
  )
})
