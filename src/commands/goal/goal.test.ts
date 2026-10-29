import { describe, expect, test } from 'bun:test'

import {
  achieveGoal,
  createGoalState,
  pauseGoal,
} from '../../services/goal/state.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { LocalCommandResult } from '../../types/command.js'
import { call, createGoalCall } from './goal.js'

type TextCommandResult = Extract<LocalCommandResult, { type: 'text' }>

function expectTextResult(result: LocalCommandResult): TextCommandResult {
  expect(result.type).toBe('text')
  return result as TextCommandResult
}

function makeContext(initialGoal: AppState['goal'] = null) {
  let state: AppState = {
    ...getDefaultAppState(),
    goal: initialGoal,
  }

  return {
    context: {
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
    } as Parameters<typeof call>[1],
    getState: () => state,
  }
}

describe('/goal command', () => {
  test('/goal shows no goal status', async () => {
    const { context } = makeContext()

    const result = expectTextResult(await call('', context))

    expect(result.value).toContain('No goal set')
  })

  test('/goal status returns current status without mutating goal', async () => {
    const { context, getState } = makeContext(
      createGoalState('finish implementation'),
    )
    const originalGoal = getState().goal

    const result = expectTextResult(await call('status', context))

    expect(result.value).toContain('Status: active')
    expect(result.value).toContain('Condition: finish implementation')
    expect(getState().goal).toBe(originalGoal)
    expect(result.shouldQuery).toBeUndefined()
    expect(result.metaMessages).toBeUndefined()
  })

  test('/goal shows active, paused, and achieved status details', async () => {
    const active = createGoalState('finish implementation')
    const { context, getState } = makeContext(active)

    const activeResult = expectTextResult(await call('', context))
    expect(activeResult.value).toContain('Status: active')
    expect(activeResult.value).toContain('Condition: finish implementation')
    expect(activeResult.value).toContain('Turns: 0/50')
    expect(activeResult.value).toContain('Evaluator failures: 0')

    context.setAppState(prev => ({ ...prev, goal: pauseGoal(getState().goal!) }))
    const pausedResult = expectTextResult(await call('', context))
    expect(pausedResult.value).toContain('Status: paused')

    context.setAppState(prev => ({
      ...prev,
      goal: achieveGoal(createGoalState('finish implementation'), {
        evaluatedMessageUuid: 'assistant-1',
        reason: 'done',
      }),
    }))
    const achievedResult = expectTextResult(await call('', context))
    expect(achievedResult.value).toContain('Status: achieved')
    expect(achievedResult.value).toContain('Turns: 1/50')
    expect(achievedResult.value).toContain('Last evaluator reason: done')
  })

  test('/goal <condition> sets an active goal and starts a turn', async () => {
    const { context, getState } = makeContext()

    const result = expectTextResult(
      await call('finish the implementation', context),
    )

    expect(getState().goal?.status).toBe('active')
    expect(getState().goal?.condition).toBe('finish the implementation')
    expect(result.value).toContain('Goal set')
    expect(result.shouldQuery).toBe(true)
    expect(result.metaMessages?.[0]).toContain('finish the implementation')
  })

  test('/goal validates empty conditions', async () => {
    const { context, getState } = makeContext()

    const result = expectTextResult(await call('""', context))

    expect(getState().goal).toBeNull()
    expect(result.value).toContain('Goal condition cannot be empty')
    expect(result.shouldQuery).toBeUndefined()
  })

  test('/goal validates conditions over 4,000 characters', async () => {
    const { context, getState } = makeContext()

    const result = expectTextResult(await call('x'.repeat(4001), context))

    expect(getState().goal).toBeNull()
    expect(result.value).toContain('4,000 characters')
    expect(result.shouldQuery).toBeUndefined()
  })

  test('/goal replaces an active goal cleanly', async () => {
    const { context, getState } = makeContext()

    await call('first goal', context)
    const firstId = getState().goal?.id
    await call('second goal', context)

    expect(getState().goal?.id).not.toBe(firstId)
    expect(getState().goal?.condition).toBe('second goal')
    expect(getState().goal?.status).toBe('active')
  })

  test('/goal clear and aliases clear active goal', async () => {
    const aliases = ['clear', 'stop', 'off', 'reset', 'none', 'cancel']

    for (const alias of aliases) {
      const { context, getState } = makeContext(
        createGoalState('finish implementation'),
      )
      const result = expectTextResult(await call(alias, context))

      expect(getState().goal).toBeNull()
      expect(result.value).toContain('Goal cleared')
    }
  })

  test('/goal pause pauses auto-continuation', async () => {
    const { context, getState } = makeContext(
      createGoalState('finish implementation'),
    )

    const result = expectTextResult(await call('pause', context))

    expect(getState().goal?.status).toBe('paused')
    expect(result.value).toContain('Goal paused')
  })

  test('/goal resume resumes a paused goal and starts a turn', async () => {
    const paused = pauseGoal(createGoalState('finish implementation'))
    const { context, getState } = makeContext(paused)

    const result = expectTextResult(await call('resume', context))

    expect(getState().goal?.status).toBe('active')
    expect(result.value).toContain('Goal resumed')
    expect(result.shouldQuery).toBe(true)
    expect(result.metaMessages?.[0]).toContain('finish implementation')
  })

  test('/goal resume reports when there is no goal to resume', async () => {
    const { context, getState } = makeContext()

    const result = expectTextResult(await call('resume', context))

    expect(getState().goal).toBeNull()
    expect(result.value).toBe('No goal to resume.')
    expect(result.shouldQuery).toBeUndefined()
    expect(result.metaMessages).toBeUndefined()
  })

  test('/goal does not mutate in-memory state when persistence fails', async () => {
    const callWithFailingPersistence = createGoalCall(async () => {
      throw new Error('persist failed')
    })
    const cases = [
      {
        action: 'new persisted goal',
        initialGoal: createGoalState('existing goal'),
      },
      {
        action: 'clear',
        initialGoal: createGoalState('goal to clear'),
      },
      {
        action: 'pause',
        initialGoal: createGoalState('goal to pause'),
      },
      {
        action: 'resume',
        initialGoal: pauseGoal(createGoalState('goal to resume')),
      },
    ]

    for (const { action, initialGoal } of cases) {
      const { context, getState } = makeContext(initialGoal)

      await expect(callWithFailingPersistence(action, context)).rejects.toThrow(
        'persist failed',
      )
      expect(getState().goal).toBe(initialGoal)
    }
  })
})
