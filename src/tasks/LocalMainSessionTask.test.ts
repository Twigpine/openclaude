import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getOriginalCwd, setOriginalCwd } from '../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { QueryParams } from '../query.js'
import { createQueryTurnBudget } from '../query.js'
import type { Terminal } from '../query/transitions.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import type { Message } from '../types/message.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { createAssistantMessage } from '../utils/messages.js'
import {
  getClaudeConfigHomeDir,
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../utils/envUtils.js'
import { dequeueAll } from '../utils/messageQueueManager.js'
import { getClaudeTempDir } from '../utils/permissions/filesystem.js'
import {
  flushSessionStorage,
  getProjectDir,
  resetProjectForTesting,
} from '../utils/sessionStorage.js'
import {
  _clearOutputsForTest,
  _resetTaskOutputDirForTest,
} from '../utils/task/diskOutput.js'
import {
  isMainSessionTask,
  startBackgroundSession,
} from './LocalMainSessionTask.js'

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`)
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

let originalCwd: string
let originalConfigDir: string | undefined
let originalClaudeTmpDir: string | undefined
let testRoot: string

beforeEach(async () => {
  await acquireSharedMutationLock('tasks/LocalMainSessionTask.test.ts')
  originalCwd = getOriginalCwd()
  originalConfigDir = getClaudeConfigHomeDirOverrideForTesting()
  originalClaudeTmpDir = process.env.CLAUDE_CODE_TMPDIR
  testRoot = await mkdtemp(join(tmpdir(), 'openclaude-main-session-task-'))
  const projectDir = join(testRoot, 'project')
  await mkdir(projectDir)

  setClaudeConfigHomeDirForTesting(join(testRoot, 'config'))
  getClaudeConfigHomeDir.cache?.clear?.()
  getProjectDir.cache?.clear?.()
  setOriginalCwd(projectDir)
  process.env.CLAUDE_CODE_TMPDIR = join(testRoot, 'tmp')
  getClaudeTempDir.cache?.clear?.()
  _resetTaskOutputDirForTest()
  resetProjectForTesting()
})

afterEach(async () => {
  dequeueAll()
  try {
    await _clearOutputsForTest()
    await flushSessionStorage()
  } finally {
    resetProjectForTesting()
    _resetTaskOutputDirForTest()
    setClaudeConfigHomeDirForTesting(originalConfigDir)
    getClaudeConfigHomeDir.cache?.clear?.()
    getProjectDir.cache?.clear?.()
    setOriginalCwd(originalCwd)
    if (originalClaudeTmpDir === undefined) {
      delete process.env.CLAUDE_CODE_TMPDIR
    } else {
      process.env.CLAUDE_CODE_TMPDIR = originalClaudeTmpDir
    }
    getClaudeTempDir.cache?.clear?.()
    await rm(testRoot, { recursive: true, force: true })
    releaseSharedMutationLock()
  }
})

describe('LocalMainSessionTask', () => {
  test('does not register a task when foreground settlement needs no continuation', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }

    const { taskId } = startBackgroundSession({
      description: 'settled foreground',
      setAppState,
      prepare: async () => null,
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(state.tasks[taskId]).toBeUndefined()
  })

  test('restores claimed notifications when preparation returns after abort', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    let restoreCalls = 0

    const { taskId } = startBackgroundSession({
      description: 'aborted preparation',
      setAppState,
      prepare: async abortController => {
        abortController.abort('stopped')
        return {
          messages: [],
          restoreNotificationsIfUnsent: () => {
            restoreCalls++
          },
          queryParams: {} as Omit<QueryParams, 'messages'>,
        }
      },
    })

    await new Promise(resolve => setTimeout(resolve, 0))

    expect(restoreCalls).toBe(1)
    expect(state.tasks[taskId]).toBeUndefined()
  })

  test('restores claimed notifications when background aborts before provider dispatch', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    let restoreCalls = 0
    let releaseQuery!: () => void
    const queryBlocked = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    let taskRegistered = false

    const { taskId, abortController } = startBackgroundSession({
      description: 'pre-dispatch abort',
      setAppState,
      prepare: async () => ({
        messages: [],
        restoreNotificationsIfUnsent: () => {
          restoreCalls++
        },
        queryParams: {} as Omit<QueryParams, 'messages'>,
      }),
      onRegistered: () => {
        taskRegistered = true
      },
      queryImpl: (async function* (): AsyncGenerator<Message, Terminal> {
        await queryBlocked
        yield createAssistantMessage({ content: 'late' })
        return { reason: 'completed' }
      }) as typeof import('../query.js').query,
    })

    await waitFor(() => taskRegistered, 'task registration')
    abortController.abort('stopped')
    releaseQuery()
    await waitFor(() => restoreCalls === 1, 'notification restore')
    expect(state.tasks[taskId]?.status).toBe('killed')
  })

  test('does not restore notifications after provider dispatch commits ownership', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    let restoreCalls = 0
    let ownershipActive = true
    let releaseQuery!: () => void
    const queryBlocked = new Promise<void>(resolve => {
      releaseQuery = resolve
    })
    let taskRegistered = false

    const { taskId, abortController } = startBackgroundSession({
      description: 'post-dispatch abort',
      setAppState,
      prepare: async () => ({
        messages: [],
        restoreNotificationsIfUnsent: () => {
          if (!ownershipActive) return
          ownershipActive = false
          restoreCalls++
        },
        commitNotificationOwnership: () => {
          ownershipActive = false
        },
        queryParams: {} as Omit<QueryParams, 'messages'>,
      }),
      onRegistered: () => {
        taskRegistered = true
      },
      queryImpl: (async function* (
        params,
      ): AsyncGenerator<Message, Terminal> {
        params.onProviderDispatchAccepted?.()
        await queryBlocked
        yield createAssistantMessage({ content: 'late' })
        return { reason: 'completed' }
      }) as typeof import('../query.js').query,
    })

    await waitFor(() => taskRegistered, 'task registration')
    abortController.abort('stopped')
    releaseQuery()
    await waitFor(() => state.tasks[taskId]?.status === 'killed', 'task killed')
    expect(restoreCalls).toBe(0)
  })

  test('does not restore merged notifications when background completes at turn cap without provider dispatch', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    let restoreCalls = 0
    let commitCalls = 0
    const notificationAttachment = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt:
        '<task-notification><task-id>sabc1234</task-id><summary>done</summary></task-notification>',
    })

    const { taskId } = startBackgroundSession({
      description: 'turn-cap completion',
      setAppState,
      prepare: async () => ({
        messages: [notificationAttachment],
        restoreNotificationsIfUnsent: () => {
          restoreCalls++
        },
        commitNotificationOwnership: () => {
          commitCalls++
        },
        queryParams: {
          turnBudget: createQueryTurnBudget(1),
        } as Omit<QueryParams, 'messages'>,
      }),
      queryImpl: (async function* (): AsyncGenerator<Message, Terminal> {
        return { reason: 'max_turns', turnCount: 2 }
      }) as typeof import('../query.js').query,
    })

    await waitFor(
      () => state.tasks[taskId]?.status === 'completed',
      'background task completion',
    )

    expect(restoreCalls).toBe(0)
    expect(commitCalls).toBe(0)
  })

  test('retains a max-turn terminal attachment in task messages', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    const cap = createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns: 1,
      turnCount: 2,
    })
    const queryImpl = async function* (): AsyncGenerator<Message, Terminal> {
      yield cap
      return { reason: 'max_turns', turnCount: 2 }
    }

    const { taskId } = startBackgroundSession({
      description: 'cap retention test',
      setAppState,
      queryImpl: queryImpl as typeof import('../query.js').query,
      prepare: async () => ({
        messages: [],
        queryParams: {} as Omit<QueryParams, 'messages'>,
      }),
    })

    await waitFor(
      () => state.tasks[taskId]?.status === 'completed',
      'background task completion',
    )

    const task = state.tasks[taskId]
    expect(isMainSessionTask(task)).toBe(true)
    if (!isMainSessionTask(task)) throw new Error('expected main-session task')
    expect(task.messages).toEqual([cap])
  })

  test('reports a preparation failure before task registration', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    const failure = new Error('context failed')
    const errors: unknown[] = []
    const cancelled: boolean[] = []

    const { taskId } = startBackgroundSession({
      description: 'failing preparation',
      setAppState,
      prepare: async () => {
        throw failure
      },
      onPreparationError: error => errors.push(error),
      onContinuationCancelled: () => cancelled.push(true),
    })

    await waitFor(() => errors.length === 1, 'preparation failure callback')

    expect(errors).toEqual([failure])
    expect(cancelled).toEqual([true])
    expect(state.tasks[taskId]).toBeUndefined()
  })

  test('settles the pending controller after preparation completes', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    const settledControllers: AbortController[] = []

    const { taskId, abortController } = startBackgroundSession({
      description: 'settled preparation',
      setAppState,
      prepare: async () => null,
      onSettled: controller => settledControllers.push(controller),
    })

    await waitFor(() => settledControllers.length === 1, 'handoff settlement')

    expect(settledControllers).toEqual([abortController])
    expect(state.tasks[taskId]).toBeUndefined()
  })

  test('reports when a pending handoff is registered as a task', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    const registeredControllers: AbortController[] = []

    const { taskId, abortController } = startBackgroundSession({
      description: 'registered handoff',
      setAppState,
      prepare: async () => ({
        messages: [],
        queryParams: {} as Omit<QueryParams, 'messages'>,
      }),
      onRegistered: controller => registeredControllers.push(controller),
      queryImpl: (async function* (): AsyncGenerator<Message, Terminal> {
        return { reason: 'completed' }
      }) as typeof import('../query.js').query,
    })

    await waitFor(() => state.tasks[taskId]?.status === 'completed', 'task completion')

    expect(registeredControllers).toEqual([abortController])
  })

  test('exposes a controller that cancels preparation before registration', async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (previous: AppState) => AppState): void => {
      state = update(state)
    }
    let releasePreparation!: () => void
    const preparation = new Promise<void>(resolve => {
      releasePreparation = resolve
    })

    const { taskId, abortController } = startBackgroundSession({
      description: 'cancellable preparation',
      setAppState,
      prepare: async controller => {
        await preparation
        if (controller.signal.aborted) return null
        throw new Error('preparation should have been cancelled')
      },
    })

    abortController.abort('user-cancel')
    releasePreparation()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(state.tasks[taskId]).toBeUndefined()
  })
})
