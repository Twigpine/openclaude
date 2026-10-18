import { describe, expect, test } from 'bun:test'

import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import { createGoalState, markGoalEvaluated } from './state.js'
import {
  evaluateGoalAfterTurn,
  type GoalEvaluationDeps,
} from './controller.js'
import type { GoalState } from './types.js'
import type { AssistantMessage } from '../../types/message.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  registerInterruptionController,
  requestAbort,
} from '../../utils/interruptionTrace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

function assistant(uuid: string, text: string) {
  // Minimal fixture — cast rather than fabricate the full envelope.
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  } as unknown as AssistantMessage
}

function makeContext(goal = createGoalState('finish implementation')) {
  let state: AppState = {
    ...getDefaultAppState(),
    goal,
  }
  const abortController = new AbortController()
  const context = {
    getAppState: () => state,
    setAppState: (updater: (prev: AppState) => AppState) => {
      state = updater(state)
    },
    abortController,
    options: {
      isNonInteractiveSession: false,
    },
  } as any

  return {
    context,
    abortController,
    getState: () => state,
  }
}

async function drain(
  generator: AsyncGenerator<any, any>,
): Promise<{ yielded: any[]; returned: any }> {
  const yielded: any[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) return { yielded, returned: next.value }
    yielded.push(next.value)
  }
}

describe('goal continuation controller', () => {
  test.serial('traces goal evaluation start and completion', async () => {
    await acquireSharedMutationLock('goal/controller trace')
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    try {
      const { context, abortController } = makeContext()
      registerInterruptionController(abortController, {
        controllerRole: 'query-root',
      })
      await drain(
        evaluateGoalAfterTurn({
          messagesForQuery: [],
          assistantMessages: [assistant('assistant-trace', 'Done.')],
          toolUseContext: context,
          querySource: 'repl_main_thread',
          deps: {
            evaluateGoal: async () => {
              requestAbort(abortController, 'user-cancel', {
                source: 'cancel_keybinding',
                controllerRole: 'query-root',
              })
              return {
                complete: false,
                confidence: 0,
                decision: 'error',
                reason: 'cancelled',
                nextInstruction: null,
              }
            },
            saveGoalState: async () => {},
          },
        }),
      )

      const trace = __getInterruptionTraceSnapshotForTests()
      expect(trace.map(entry => entry.event)).toEqual(
        expect.arrayContaining([
          'goal.evaluation_started',
          'goal.evaluation_completed',
        ]),
      )
      const rootAbort = trace.find(entry => entry.event === 'abort.requested')
      const completed = trace.find(
        entry => entry.event === 'goal.evaluation_completed',
      )
      expect(rootAbort).toBeDefined()
      expect(completed).toBeDefined()
      expect(typeof rootAbort!.eventId).toBe('string')
      expect(typeof completed!.causalEventId).toBe('string')
      expect(completed!.causalEventId).toBe(rootAbort!.eventId)
    } finally {
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      releaseSharedMutationLock()
    }
  })

  test('evaluator complete => no blocking error, goal achieved', async () => {
    const { context, getState } = makeContext()
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => ({
        complete: true,
        confidence: 0.9,
        decision: 'complete',
        reason: 'Everything requested is done.',
        nextInstruction: null,
      }),
      saveGoalState: async () => {},
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(returned).toEqual([])
    expect(getState().goal?.status).toBe('achieved')
    expect(yielded[0]?.content).toContain('Goal achieved:')
  })

  test('goal persistence failures are reported without failing the turn', async () => {
    const { context, getState } = makeContext()
    const persistenceError = new Error('write failed')
    let observedGoal: GoalState | null | undefined
    let observedError: unknown
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => ({
        complete: true,
        confidence: 0.9,
        decision: 'complete',
        reason: 'Everything requested is done.',
        nextInstruction: null,
      }),
      saveGoalState: async () => {
        throw persistenceError
      },
      logGoalPersistenceFailure: (goal, error) => {
        observedGoal = goal
        observedError = error
      },
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(returned).toEqual([])
    expect(getState().goal?.status).toBe('achieved')
    expect(yielded[0]?.content).toContain('Goal achieved:')
    expect(observedGoal?.id).toBe(getState().goal?.id)
    expect(observedError).toBe(persistenceError)
  })

  test('evaluator incomplete => blocking/meta continuation message returned', async () => {
    const { context, getState } = makeContext()
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => ({
        complete: false,
        confidence: 0.7,
        decision: 'incomplete',
        reason: 'Tests have not been run.',
        nextInstruction: 'Run the focused tests.',
      }),
      saveGoalState: async () => {},
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Changed files.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(getState().goal?.turnCount).toBe(1)
    expect(yielded[0]?.content).toContain('Goal not complete:')
    expect(returned).toHaveLength(1)
    expect(returned[0].isMeta).toBe(true)
    expect(returned[0].message.content).toContain('finish implementation')
    expect(returned[0].message.content).toContain('Run the focused tests.')
  })

  for (const decisionType of ['malformed', 'error'] as const) {
    test(`evaluator ${decisionType} pauses the goal without continuation`, async () => {
      const { context, getState } = makeContext()
      const deps: GoalEvaluationDeps = {
        evaluateGoal: async () => ({
          complete: false,
          confidence: 0,
          decision: decisionType,
          reason:
            decisionType === 'malformed'
              ? 'Goal evaluator returned malformed JSON.'
              : 'Goal evaluator failed.',
          nextInstruction: 'Continue directly toward the goal.',
        }),
        saveGoalState: async () => {},
      }

      const { yielded, returned } = await drain(
        evaluateGoalAfterTurn({
          messagesForQuery: [],
          assistantMessages: [assistant('assistant-1', 'Done.')],
          toolUseContext: context,
          querySource: 'sdk',
          deps,
        }),
      )

      expect(returned).toEqual([])
      expect(getState().goal?.status).toBe('paused')
      expect(getState().goal?.lastDecision).toBe(decisionType)
      expect(getState().goal?.evaluatorFailures).toBe(1)
      expect(yielded[0]?.level).toBe('warning')
      expect(yielded[0]?.content).toContain('Goal paused:')
    })
  }

  test('passes only a bounded recent message slice to evaluator', async () => {
    const { context } = makeContext()
    let observedMessages: unknown[] = []
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async ({ messages }) => {
        observedMessages = messages
        return {
          complete: true,
          confidence: 0.9,
          decision: 'complete',
          reason: 'Done.',
          nextInstruction: null,
        }
      },
      saveGoalState: async () => {},
    }

    await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: Array.from({ length: 100 }, (_, i) =>
          assistant(`prior-${i}`, `prior ${i}`),
        ) as any,
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(observedMessages.length).toBeLessThanOrEqual(24)
    expect((observedMessages.at(-1) as any).uuid).toBe('assistant-1')
  })

  test('no goal evaluation for subagents/agent query sources', async () => {
    const { context } = makeContext()
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
    }

    await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: { ...context, agentId: 'agent-1' },
        querySource: 'repl_main_thread',
        deps,
      }),
    )
    await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-2', 'Done.')],
        toolUseContext: context,
        querySource: 'agent:custom',
        deps,
      }),
    )

    expect(calls).toBe(0)
  })

  test('no duplicate continuation for same terminal message', async () => {
    const goal = markGoalEvaluated(createGoalState('finish implementation'), {
      evaluatedMessageUuid: 'assistant-1',
      decision: 'incomplete',
      reason: 'not done',
      nextInstruction: null,
    })
    const { context } = makeContext(goal)
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
    }

    const { returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Still done.')],
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(returned).toEqual([])
  })

  test('abort prevents continuation', async () => {
    const { context, abortController } = makeContext()
    abortController.abort()
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
    }

    const { returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(returned).toEqual([])
  })

  test('maxBudgetUsd exhaustion skips evaluator before spending on goal evaluation', async () => {
    const { context, getState } = makeContext()
    context.options.maxBudgetUsd = 0.25
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        return {
          complete: false,
          confidence: 0.7,
          decision: 'incomplete',
          reason: 'This would require another paid evaluator call.',
          nextInstruction: 'Continue.',
        }
      },
      saveGoalState: async () => {},
      getTotalCost: () => 0.25,
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(yielded).toEqual([])
    expect(returned).toEqual([])
    expect(getState().goal?.status).toBe('active')
    expect(getState().goal?.turnCount).toBe(0)
  })

  test('maxBudgetUsd below cap still permits goal evaluation', async () => {
    const { context, getState } = makeContext()
    context.options.maxBudgetUsd = 0.25
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        return {
          complete: false,
          confidence: 0.7,
          decision: 'incomplete',
          reason: 'Validation is still missing.',
          nextInstruction: 'Run validation.',
        }
      },
      saveGoalState: async () => {},
      getTotalCost: () => 0.24,
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(calls).toBe(1)
    expect(getState().goal?.turnCount).toBe(1)
    expect(yielded[0]?.content).toContain('Goal not complete:')
    expect(returned).toHaveLength(1)
    expect(returned[0].message.content).toContain('Run validation.')
  })

  test('maxBudgetUsd exhaustion still allows maxTurns pause without evaluator spend', async () => {
    const goal = {
      ...createGoalState('finish implementation'),
      turnCount: 1,
      maxTurns: 1,
    }
    const { context, getState } = makeContext(goal)
    context.options.maxBudgetUsd = 0.25
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
      getTotalCost: () => 0.25,
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'sdk',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(getState().goal?.status).toBe('paused')
    expect(getState().goal?.lastReason).toContain('maximum of 1 turns')
    expect(yielded[0]?.content.startsWith('Goal paused:')).toBe(true)
    expect(yielded[0]?.content).toContain('maximum of 1 turns')
    expect(returned).toEqual([])
  })

  test('pending interactive dialog prevents continuation', async () => {
    const { context } = makeContext()
    const blockedContext = {
      ...context,
      getAppState: () => ({
        ...context.getAppState(),
        elicitation: { queue: [{}] },
      }),
    }
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
    }

    const { returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: blockedContext,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(returned).toEqual([])
  })

  test('maxTurns pauses without evaluating or continuing', async () => {
    const goal = {
      ...createGoalState('finish implementation'),
      turnCount: 1,
      maxTurns: 1,
    }
    const { context, getState } = makeContext(goal)
    let calls = 0
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => {
        calls++
        throw new Error('should not evaluate')
      },
      saveGoalState: async () => {},
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(calls).toBe(0)
    expect(getState().goal?.status).toBe('paused')
    expect(getState().goal?.lastReason).toContain('maximum of 1 turns')
    expect(yielded[0]?.content).toContain('maximum of 1 turns')
    expect(returned).toEqual([])
  })

  test('incomplete evaluation that reaches maxTurns does not continue', async () => {
    const goal = {
      ...createGoalState('finish implementation'),
      turnCount: 1,
      maxTurns: 2,
    }
    const { context, getState } = makeContext(goal)
    const deps: GoalEvaluationDeps = {
      evaluateGoal: async () => ({
        complete: false,
        confidence: 0.8,
        decision: 'incomplete',
        reason: 'One required validation is still missing.',
        nextInstruction: 'Run the final validation.',
      }),
      saveGoalState: async () => {},
    }

    const { yielded, returned } = await drain(
      evaluateGoalAfterTurn({
        messagesForQuery: [],
        assistantMessages: [assistant('assistant-1', 'Done.')],
        toolUseContext: context,
        querySource: 'repl_main_thread',
        deps,
      }),
    )

    expect(getState().goal?.status).toBe('paused')
    expect(getState().goal?.turnCount).toBe(2)
    expect(getState().goal?.lastReason).toContain(
      'One required validation is still missing.',
    )
    expect(yielded[0]?.content.startsWith('Goal not complete:')).toBe(true)
    expect(yielded[0]?.content).toContain('maximum of 2 turns')
    expect(returned).toEqual([])
  })
})
