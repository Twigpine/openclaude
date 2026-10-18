import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import type { Tool } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  requestAbort,
} from '../interruptionTrace.js'
import { createInProcessPermissionAbortCompleter } from './inProcessPermissionAbort.js'
import { createInProcessCanUseTool } from './inProcessRunner.js'
import {
  registerLeaderToolUseConfirmQueue,
  unregisterLeaderToolUseConfirmQueue,
} from './leaderPermissionBridge.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock('inProcessPermissionAbort.test.ts')
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  __resetInterruptionTraceForTests()
})

afterEach(async () => {
  try {
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    unregisterLeaderToolUseConfirmQueue()
    if (originalTrace === undefined) {
      delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    } else {
      process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
    }
  } finally {
    releaseSharedMutationLock()
  }
})

test('links signal-driven permission denial to the winning abort request once', () => {
  const controller = new AbortController()
  let deniedCount = 0
  const completion = createInProcessPermissionAbortCompleter(
    controller.signal,
    () => {
      deniedCount++
    },
  )

  requestAbort(controller, undefined, {
    source: 'query_guard',
    subsystem: 'query_engine',
    controllerRole: 'query-root',
  })

  const trace = __getInterruptionTraceSnapshotForTests()
  const abortRequest = trace.find(entry => entry.event === 'abort.requested')
  const permissionResolution = trace.find(
    entry => entry.event === 'permission.abort_resolved',
  )
  expect(deniedCount).toBe(1)
  expect(abortRequest?.eventId).toBeString()
  expect(permissionResolution).toMatchObject({
    source: 'query_guard',
    subsystem: 'in_process_permission_bridge',
    outcome: 'denied',
    causalEventId: abortRequest?.eventId,
  })
  expect(completion.completeAbort('ui_cancel', 'later-event')).toBe(false)
  expect(deniedCount).toBe(1)
})

test('aborts a queued in-process permission through the production signal path', async () => {
  const controller = new AbortController()
  let queue: ToolUseConfirm[] = []
  registerLeaderToolUseConfirmQueue(updater => {
    queue = updater(queue)
  })
  const canUseTool = createInProcessCanUseTool(
    {
      agentId: 'worker-1',
      agentName: 'worker',
      teamName: 'test-team',
      planModeRequired: false,
      parentSessionId: 'parent-session',
    },
    controller,
  )
  const appState = getDefaultAppState()
  const decisionPromise = canUseTool(
    {
      name: 'TraceTestTool',
      description: async () => 'test permission',
    } as unknown as Tool,
    {},
    {
      getAppState: () => appState,
      options: {
        isNonInteractiveSession: false,
        tools: [],
      },
    } as never,
    {} as never,
    'tool-use-1',
    { behavior: 'ask', message: 'approval required' },
  )

  for (let attempt = 0; attempt < 10 && queue.length === 0; attempt++) {
    await Promise.resolve()
  }
  expect(queue).toHaveLength(1)

  requestAbort(controller, undefined, {
    source: 'query_guard',
    subsystem: 'query_engine',
    controllerRole: 'query-root',
  })

  await expect(decisionPromise).resolves.toMatchObject({
    behavior: 'ask',
  })
  expect(queue).toHaveLength(0)
  const trace = __getInterruptionTraceSnapshotForTests()
  const abortRequest = trace.find(entry => entry.event === 'abort.requested')
  expect(
    trace.find(entry => entry.event === 'permission.abort_resolved'),
  ).toMatchObject({
    source: 'query_guard',
    subsystem: 'in_process_permission_bridge',
    outcome: 'denied',
    causalEventId: abortRequest?.eventId,
  })
})
