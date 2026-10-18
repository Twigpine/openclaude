import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { AppState } from './AppState.js'
import { getDefaultAppState } from './AppStateStore.js'
import { stopOrDismissAgent } from './teammateViewHelpers.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
} from '../utils/interruptionTrace.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock(
    'state/teammateViewHelpers.interruptionTrace.test.ts',
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

test('records the panel stop source and causal input before aborting an agent', () => {
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  const abortController = new AbortController()
  const taskId = 'agent-task-1'
  const task = {
    id: taskId,
    type: 'local_agent',
    status: 'running',
    description: 'test agent',
    startTime: Date.now(),
    outputFile: '/tmp/test-agent-output',
    outputOffset: 0,
    notified: false,
    agentId: 'agent-1',
    prompt: 'test',
    agentType: 'general-purpose',
    abortController,
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
  } satisfies LocalAgentTaskState
  let state: AppState = {
    ...getDefaultAppState(),
    tasks: { [taskId]: task },
  }

  stopOrDismissAgent(taskId, updater => {
    state = updater(state)
  })

  const entries = __getInterruptionTraceSnapshotForTests()
  const input = entries.find(entry => entry.event === 'input.agent_panel_stop')
  const requested = entries.find(entry => entry.event === 'abort.requested')
  expect(abortController.signal.aborted).toBe(true)
  expect(input).toBeDefined()
  expect(requested).toMatchObject({
    source: 'agent_panel_stop',
    subsystem: 'local_agent_task',
    controllerRole: 'background-agent',
    subagentId: taskId,
    causalEventId: input?.eventId,
  })
})
