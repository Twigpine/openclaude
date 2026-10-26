import type { ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { Message } from '../types/message.js'
import type { QueryDeps } from './deps.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { describe, expect, test } from 'bun:test'

import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import { createGoalState } from '../services/goal/state.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'

function assistant(uuid: string, text: string) {
  return {
    type: 'assistant',
    uuid,
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content: [{ type: 'text', text }],
    },
  } as AssistantMessage
}

function makeToolUseContext(appStateRef: { current: AppState }): ToolUseContext {
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'sonnet',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appStateRef.current,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appStateRef.current = updater(appStateRef.current)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  }
}

describe('goal query continuation', () => {
  test('shared query path continues after incomplete goal and stops when achieved', async () => {
    const decisions = [
      {
        complete: false,
        confidence: 0.7,
        decision: 'incomplete' as const,
        reason: 'Implementation is not verified.',
        nextInstruction: 'Run tests.',
      },
      {
        complete: true,
        confidence: 0.9,
        decision: 'complete' as const,
        reason: 'Implementation is verified.',
        nextInstruction: null,
      },
    ]
    const { query } = await import('../query.js')
    let modelCalls = 0
    const modelRequestMessages: Message[][] = []
    const observedStopHookActive: (boolean | undefined)[] = []
    const appStateRef = {
      current: {
        ...getDefaultAppState(),
        goal: createGoalState('finish implementation'),
      },
    }

    const yielded: Array<ReturnType<typeof query> extends AsyncGenerator<infer Event> ? Event : never> = []
    const terminal = await (async () => {
      const generator = query({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow' }),
        toolUseContext: makeToolUseContext(appStateRef),
        querySource: 'sdk',
        deps: {
          uuid: () => `uuid-${modelCalls}`,
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ wasCompacted: false }),
          goalEvaluationDeps: {
            evaluateGoal: async () => decisions.shift()!,
            saveGoalState: async () => {},
          },
          stopHookExecutionDeps: {
            executeStopHooks: async function* (
              _permissionMode: string | undefined,
              _signal: AbortSignal | undefined,
              _timeoutMs: number | undefined,
              stopHookActive?: boolean,
            ) {
              observedStopHookActive.push(stopHookActive)
            },
            isTeammate: () => false,
          },
          callModel: async function* ({ messages }: Parameters<QueryDeps['callModel']>[0]) {
            modelCalls++
            modelRequestMessages.push(messages)
            yield assistant(
              `assistant-${modelCalls}`,
              modelCalls === 1 ? 'Changed files.' : 'Tests pass.',
            )
          },
        },
      })
      while (true) {
        const next = await generator.next()
        if (next.done) return next.value
        yielded.push(next.value)
      }
    })()

    expect(modelCalls).toBe(2)
    expect(modelRequestMessages).toHaveLength(2)
    expect(observedStopHookActive).toEqual([false, false])
    expect(terminal.reason).toBe('completed')
    expect(appStateRef.current.goal?.status).toBe('achieved')
    const yieldedGoalUsers = yielded.filter(
      item =>
        item.type === 'user' &&
        item.isMeta &&
        typeof item.message.content === 'string' &&
        item.message.content.includes('Run tests.'),
    )
    expect(yieldedGoalUsers).toHaveLength(1)
    const followUpGoalUsers = modelRequestMessages[1].filter(
      item =>
        item.type === 'user' &&
        item.isMeta &&
        typeof item.message.content === 'string' &&
        item.message.content.includes('Run tests.'),
    )
    expect(followUpGoalUsers).toHaveLength(1)
    expect(
      yielded.some(
        item =>
          item.type === 'system' &&
          typeof item.content === 'string' &&
          item.content.includes('Goal not complete:'),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        item =>
          item.type === 'system' &&
          typeof item.content === 'string' &&
          item.content.includes('Goal achieved:'),
      ),
    ).toBe(true)
  })

  test('shared query path skips goal evaluator when maxBudgetUsd is exhausted', async () => {
    const { query } = await import('../query.js')
    let modelCalls = 0
    let evaluatorCalls = 0
    const appStateRef = {
      current: {
        ...getDefaultAppState(),
        goal: createGoalState('finish implementation'),
      },
    }
    const toolUseContext = makeToolUseContext(appStateRef)
    toolUseContext.options.maxBudgetUsd = 0.25

    const yielded: Array<ReturnType<typeof query> extends AsyncGenerator<infer Event> ? Event : never> = []
    const terminal = await (async () => {
      const generator = query({
        messages: [],
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool: async () => ({ behavior: 'allow' }),
        toolUseContext,
        querySource: 'sdk',
        deps: {
          uuid: () => `uuid-${modelCalls}`,
          microcompact: async messages => ({ messages }),
          autocompact: async () => ({ wasCompacted: false }),
          goalEvaluationDeps: {
            evaluateGoal: async () => {
              evaluatorCalls++
              throw new Error('goal evaluator should not run')
            },
            getTotalCost: () => 0.25,
            saveGoalState: async () => {},
          },
          stopHookExecutionDeps: {
            executeStopHooks: async function* () {},
            isTeammate: () => false,
          },
          callModel: async function* () {
            modelCalls++
            yield assistant('assistant-1', 'Done.')
          },
        },
      })
      while (true) {
        const next = await generator.next()
        if (next.done) return next.value
        yielded.push(next.value)
      }
    })()

    expect(modelCalls).toBe(1)
    expect(evaluatorCalls).toBe(0)
    expect(terminal.reason).toBe('completed')
    expect(appStateRef.current.goal?.status).toBe('active')
    expect(appStateRef.current.goal?.turnCount).toBe(0)
    expect(
      yielded.some(
        item =>
          item.type === 'system' &&
          typeof item.content === 'string' &&
          item.content.includes('Goal not complete:'),
      ),
    ).toBe(false)
    expect(
      yielded.some(
        item =>
          item.type === 'user' &&
          item.isMeta &&
          typeof item.message.content === 'string' &&
          item.message.content.includes('finish implementation'),
      ),
    ).toBe(false)
  })
})
