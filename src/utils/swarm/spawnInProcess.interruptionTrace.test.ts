import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from '../../state/AppState.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
} from '../interruptionTrace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { killInProcessTeammate } from './spawnInProcess.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock(
    'utils/swarm/spawnInProcess.interruptionTrace.test.ts',
  )
})

afterEach(() => {
  try {
    __resetInterruptionTraceForTests()
    if (originalTrace === undefined) {
      delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    } else {
      process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('records the teammate lifecycle source before a kill abort', () => {
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  const abortController = new AbortController()
  const taskId = 'teammate-task-1'
  const task = {
    id: taskId,
    type: 'in_process_teammate',
    status: 'running',
    description: 'test teammate',
    startTime: Date.now(),
    outputFile: '/tmp/test-teammate-output',
    outputOffset: 0,
    notified: false,
    identity: {
      agentId: 'researcher',
      agentName: 'researcher',
      teamName: '',
      planModeRequired: false,
      parentSessionId: 'parent-session',
    },
    prompt: 'test',
    abortController,
    awaitingPlanApproval: false,
    permissionMode: 'default',
    isIdle: false,
    shutdownRequested: false,
    pendingUserMessages: [],
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
  } satisfies InProcessTeammateTaskState
  let state: AppState = {
    ...getDefaultAppState(),
    tasks: { [taskId]: task },
  }

  expect(
    killInProcessTeammate(taskId, updater => {
      state = updater(state)
    }),
  ).toBe(true)

  expect(abortController.signal.aborted).toBe(true)
  expect(
    __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'abort.requested',
    ),
  ).toMatchObject({
    source: 'task_stop',
    subsystem: 'in_process_teammate',
    controllerRole: 'subagent-lifecycle',
    subagentId: 'researcher',
  })
})
