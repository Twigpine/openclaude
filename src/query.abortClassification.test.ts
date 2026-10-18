import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import { query, type QueryParams } from './query.js'
import type { QueryDeps } from './query/deps.js'
import { createToolFixture } from './test/toolFixtures.js'
import type { Tools } from './Tool.js'
import {
  createAssistantMessage,
  createUserMessage,
  INTERRUPT_MESSAGE,
} from './utils/messages.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  requestAbort,
} from './utils/interruptionTrace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

const DEFAULT_ABORT = Symbol('default abort')

type AbortInput = string | typeof DEFAULT_ABORT

function makeToolUseContext(tools: Tools = []): QueryParams['toolUseContext'] {
  const abortController = new AbortController()

  return {
    abortController,
    agentId: 'agent-test',
    getAppState: () => ({
      fastMode: false,
      mcp: { tools: [], clients: [] },
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
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

function abort(controller: AbortController, reason: AbortInput): void {
  requestAbort(controller, reason === DEFAULT_ABORT ? undefined : reason, {
    source: 'query_abort_test',
    controllerRole: 'query-root',
  })
}

function makeBaseParams(
  toolUseContext: QueryParams['toolUseContext'],
  callModel: QueryDeps['callModel'],
): QueryParams {
  return {
    messages: [createUserMessage({ content: 'run tool' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext,
    querySource: 'agent:builtin:general-purpose',
    agentStepLimit: { maxSteps: 999, agentType: 'general-purpose' },
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

function makeParams(reason: AbortInput, tools: Tools = []): QueryParams {
  const toolUseContext = makeToolUseContext(tools)

  return makeBaseParams(toolUseContext, async function* () {
    yield createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_timeout_1',
          name: 'SlowTool',
          input: {},
        },
      ],
    })
    abort(toolUseContext.abortController, reason)
  })
}

function makeToolAbortParams(reason: AbortInput): QueryParams {
  let toolUseContext!: QueryParams['toolUseContext']
  const tool = createToolFixture(z.object({}), {
    name: 'AbortDuringTool',
    async call() {
      abort(toolUseContext.abortController, reason)
      return { data: 'aborted during tool execution' }
    },
  })
  toolUseContext = makeToolUseContext([tool])

  return makeBaseParams(toolUseContext, async function* () {
    yield createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_abort_during_tool_1',
          name: 'AbortDuringTool',
          input: {},
        },
      ],
    })
  })
}

async function drainWithReturn(params: QueryParams): Promise<{
  yielded: any[]
  returned: any
}> {
  const yielded: any[] = []
  const generator = query(params)
  while (true) {
    const next = await generator.next()
    if (next.done) return { yielded, returned: next.value }
    yielded.push(next.value)
  }
}

function toolResultContents(yielded: any[]): string[] {
  return yielded.flatMap(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return []
    }
    return message.message.content
      .filter((part: any) => part.type === 'tool_result')
      .map((part: any) => part.content)
  })
}

function systemMessages(yielded: any[]) {
  return yielded.filter(message => message.type === 'system')
}

function interruptionMessages(yielded: any[]) {
  return yielded.filter(
    message =>
      message.type === 'user' &&
      Array.isArray(message.message.content) &&
      message.message.content.some(
        (part: any) => part.type === 'text' && part.text === INTERRUPT_MESSAGE,
      ),
  )
}

describe('query abort classification', () => {
  test.serial('links abort classification to the winning root abort', async () => {
    await acquireSharedMutationLock('query abort classification trace')
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    try {
      await drainWithReturn(makeParams('query-timeout'))

      const trace = __getInterruptionTraceSnapshotForTests()
      const rootAbort = trace.find(entry => entry.event === 'abort.requested')
      const classified = trace.find(
        entry => entry.event === 'query.abort_classified',
      )
      expect(rootAbort).toBeDefined()
      expect(classified).toBeDefined()
      expect(typeof rootAbort!.eventId).toBe('string')
      expect(typeof classified!.causalEventId).toBe('string')
      expect(classified!.causalEventId).toBe(rootAbort!.eventId)
    } finally {
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      releaseSharedMutationLock()
    }
  })

  test('query timeout aborts produce timeout transcript text without user interruption', async () => {
    const { yielded, returned } = await drainWithReturn(
      makeParams('query-timeout'),
    )

    expect(returned.reason).toBe('aborted_streaming')
    expect(toolResultContents(yielded)).toEqual([
      'Tool use was interrupted because the query timed out.',
    ])
    expect(systemMessages(yielded)).toMatchObject([
      {
        content: 'Query timed out before completion.',
        level: 'warning',
      },
    ])
    expect(interruptionMessages(yielded)).toHaveLength(0)
  })

  test('hard max aborts produce hard-timeout transcript text without user interruption', async () => {
    const { yielded, returned } = await drainWithReturn(makeParams('hard_max'))

    expect(returned.reason).toBe('aborted_streaming')
    expect(toolResultContents(yielded)).toEqual([
      'Tool use was interrupted because the query reached its hard maximum runtime.',
    ])
    expect(systemMessages(yielded)).toMatchObject([
      {
        content:
          'Query reached the hard maximum runtime and was stopped before completion.',
        level: 'warning',
      },
    ])
    expect(interruptionMessages(yielded)).toHaveLength(0)
  })

  test('background aborts produce background transcript text without user interruption', async () => {
    const { yielded, returned } = await drainWithReturn(makeParams('background'))

    expect(returned.reason).toBe('aborted_streaming')
    expect(toolResultContents(yielded)).toEqual([
      'Tool use was interrupted because the query was backgrounded.',
    ])
    expect(systemMessages(yielded)).toMatchObject([
      {
        content: 'Query was backgrounded before completion.',
        level: 'warning',
      },
    ])
    expect(interruptionMessages(yielded)).toHaveLength(0)
  })

  test('legacy bare abort remains classified as a user interruption', async () => {
    const { yielded, returned } = await drainWithReturn(
      makeParams(DEFAULT_ABORT),
    )

    expect(returned.reason).toBe('aborted_streaming')
    expect(toolResultContents(yielded)).toEqual(['Interrupted by user'])
    expect(systemMessages(yielded)).toHaveLength(0)
    expect(interruptionMessages(yielded)).toHaveLength(1)
  })

  test('mid-tool query timeout aborts without creating user interruption text', async () => {
    const { yielded, returned } = await drainWithReturn(
      makeToolAbortParams('query-timeout'),
    )

    expect(returned.reason).toBe('aborted_tools')
    expect(systemMessages(yielded)).toMatchObject([
      {
        content: 'Query timed out before completion.',
        level: 'warning',
      },
    ])
    expect(interruptionMessages(yielded)).toHaveLength(0)
  })
})
