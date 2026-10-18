import { describe, expect, test } from 'bun:test'

import { createGoalState } from './state.js'
import {
  buildGoalEvaluatorPrompt,
  evaluateGoal,
  type GoalModelCaller,
} from './evaluator.js'
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

function user(uuid: string, content: string) {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content },
  }
}

function assistant(uuid: string, content: string) {
  return {
    type: 'assistant',
    uuid,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: content }],
    },
  }
}

describe('goal evaluator', () => {
  test.serial('traces provider failures without serializing the error message', async () => {
    await acquireSharedMutationLock('goal/evaluator trace')
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    try {
      const controller = new AbortController()
      registerInterruptionController(controller, {
        controllerRole: 'query-root',
      })
      await evaluateGoal({
        goal: createGoalState('finish implementation'),
        messages: [],
        signal: controller.signal,
        isNonInteractiveSession: false,
        modelCaller: async () => {
          requestAbort(controller, 'user-cancel', {
            source: 'cancel_keybinding',
            controllerRole: 'query-root',
          })
          throw new Error('private provider detail')
        },
      })

      const trace = __getInterruptionTraceSnapshotForTests()
      const serialized = JSON.stringify(trace)
      expect(serialized).toContain('goal.evaluation_failed')
      expect(serialized).not.toContain('private provider detail')
      const rootAbort = trace.find(entry => entry.event === 'abort.requested')
      const failed = trace.find(
        entry => entry.event === 'goal.evaluation_failed',
      )
      expect(rootAbort).toBeDefined()
      expect(failed).toBeDefined()
      expect(typeof rootAbort!.eventId).toBe('string')
      expect(typeof failed!.causalEventId).toBe('string')
      expect(failed!.causalEventId).toBe(rootAbort!.eventId)
    } finally {
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      releaseSharedMutationLock()
    }
  })

  test('valid complete JSON', async () => {
    const caller: GoalModelCaller = async () =>
      JSON.stringify({
        complete: true,
        confidence: 0.92,
        reason: 'The implementation and tests are complete.',
        next_instruction: null,
      })

    const decision = await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [user('u1', 'please implement it'), assistant('a1', 'Done.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(decision.complete).toBe(true)
    expect(decision.decision).toBe('complete')
    expect(decision.reason).toContain('complete')
    expect(decision.nextInstruction).toBeNull()
  })

  test('valid incomplete JSON', async () => {
    const caller: GoalModelCaller = async () =>
      JSON.stringify({
        complete: false,
        confidence: 0.7,
        reason: 'Tests have not been run yet.',
        next_instruction: 'Run the focused tests.',
      })

    const decision = await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [user('u1', 'please implement it'), assistant('a1', 'I changed files.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(decision.complete).toBe(false)
    expect(decision.decision).toBe('incomplete')
    expect(decision.reason).toBe('Tests have not been run yet.')
    expect(decision.nextInstruction).toBe('Run the focused tests.')
  })

  test('malformed JSON retries once', async () => {
    let calls = 0
    const caller: GoalModelCaller = async () => {
      calls++
      return calls === 1
        ? 'not json'
        : JSON.stringify({
            complete: true,
            confidence: 0.8,
            reason: 'Recovered on retry.',
            next_instruction: null,
          })
    }

    const decision = await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [assistant('a1', 'Done.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(calls).toBe(2)
    expect(decision.complete).toBe(true)
    expect(decision.decision).toBe('complete')
  })

  test('malformed JSON after retry returns fail-closed decision', async () => {
    let calls = 0
    const caller: GoalModelCaller = async () => {
      calls++
      return calls === 1 ? '```json\n[]\n```' : '{"complete":"yes"}'
    }

    const decision = await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [assistant('a1', 'Done.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(calls).toBe(2)
    expect(decision.complete).toBe(false)
    expect(decision.decision).toBe('malformed')
    expect(decision.reason).toContain('malformed JSON')
    expect(decision.nextInstruction).toBeNull()
  })

  test('model caller errors return fail-closed decision', async () => {
    const caller: GoalModelCaller = async () => {
      throw new Error('provider auth failed')
    }

    const decision = await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [assistant('a1', 'Done.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(decision.complete).toBe(false)
    expect(decision.decision).toBe('error')
    expect(decision.reason).toContain('failed')
    expect(decision.nextInstruction).toBeNull()
  })

  test('bounded context size', () => {
    const prompt = buildGoalEvaluatorPrompt({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: Array.from({ length: 40 }, (_, i) =>
        user(`u${i}`, `message-${i} ${'x'.repeat(5_000)}`),
      ),
    })

    expect(prompt.length).toBeLessThanOrEqual(16_000)
    expect(prompt).not.toContain('x'.repeat(5_000))
  })

  test('includes visible tool-use summary text in bounded context', () => {
    const prompt = buildGoalEvaluatorPrompt({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [
        {
          type: 'tool_use_summary',
          summary: 'Ran focused goal tests',
          precedingToolUseIds: ['tool-1'],
        },
      ],
    })

    expect(prompt).toContain('tool-summary: Ran focused goal tests')
  })

  test('no tools passed to evaluator', async () => {
    let observedTools: unknown
    const caller: GoalModelCaller = async request => {
      observedTools = request.tools
      return JSON.stringify({
        complete: true,
        confidence: 1,
        reason: 'Complete.',
        next_instruction: null,
      })
    }

    await evaluateGoal({
      goal: createGoalState('finish implementation', '2026-05-21T10:00:00.000Z'),
      messages: [assistant('a1', 'Done.')],
      signal: new AbortController().signal,
      isNonInteractiveSession: false,
      modelCaller: caller,
    })

    expect(observedTools).toEqual([])
  })
})
