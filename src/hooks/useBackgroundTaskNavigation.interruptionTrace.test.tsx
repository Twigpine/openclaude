import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import React, { useEffect } from 'react'
import { createRoot } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { AppStateProvider, type AppState } from '../state/AppState.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
} from '../utils/interruptionTrace.js'
import { useBackgroundTaskNavigation } from './useBackgroundTaskNavigation.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock(
    'hooks/useBackgroundTaskNavigation.interruptionTrace.test.tsx',
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

function Harness({
  onReady,
}: {
  onReady: (handler: (event: KeyboardEvent) => void) => void
}): React.ReactNode {
  const { handleKeyDown } = useBackgroundTaskNavigation()
  useEffect(() => onReady(handleKeyDown), [handleKeyDown, onReady])
  return null
}

function createTeammateTask(): {
  task: InProcessTeammateTaskState
  currentWorkAbortController: AbortController
  lifecycleAbortController: AbortController
} {
  const currentWorkAbortController = new AbortController()
  const lifecycleAbortController = new AbortController()
  return {
    currentWorkAbortController,
    lifecycleAbortController,
    task: {
      id: 'teammate-task-1',
      type: 'in_process_teammate',
      status: 'running',
      description: 'test teammate',
      startTime: Date.now(),
      outputFile: '/tmp/test-teammate-output',
      outputOffset: 0,
      notified: false,
      identity: {
        agentId: 'researcher@test-team',
        agentName: 'researcher',
        teamName: '',
        planModeRequired: false,
        parentSessionId: 'parent-session',
      },
      prompt: 'test',
      abortController: lifecycleAbortController,
      currentWorkAbortController,
      awaitingPlanApproval: false,
      permissionMode: 'default',
      isIdle: false,
      shutdownRequested: false,
      pendingUserMessages: [],
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
    },
  }
}

async function renderNavigation(initialState: AppState): Promise<{
  invoke: (key: 'escape' | 'k') => void
  cleanup: () => Promise<void>
}> {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  let handler: ((event: KeyboardEvent) => void) | undefined
  try {
    root.render(
      <AppStateProvider initialState={initialState}>
        <Harness
          onReady={value => {
            handler = value
          }}
        />
      </AppStateProvider>,
    )
    for (let attempts = 0; attempts < 100 && !handler; attempts++) {
      await Bun.sleep(10)
    }
    expect(handler).toBeDefined()
    return {
      invoke(key) {
        handler!(
          new KeyboardEvent({
            kind: 'key',
            name: key,
            sequence: key === 'escape' ? '\u001b' : key,
            raw: key === 'escape' ? '\u001b' : key,
            ctrl: false,
            shift: false,
            meta: false,
            option: false,
            super: false,
            fn: false,
            isPasted: false,
          }),
        )
      },
      async cleanup() {
        root.unmount()
        await Bun.sleep(30)
        stdin.end()
        stdout.end()
      },
    }
  } catch (error) {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
    throw error
  }
}

test('records Escape causality before aborting the current teammate turn', async () => {
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  const { task, currentWorkAbortController } = createTeammateTask()
  const rendered = await renderNavigation({
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    viewingAgentTaskId: task.id,
    viewSelectionMode: 'viewing-agent',
  })

  try {
    rendered.invoke('escape')
    const entries = __getInterruptionTraceSnapshotForTests()
    const input = entries.find(entry => entry.event === 'input.teammate_escape')
    const requested = entries.find(entry => entry.event === 'abort.requested')
    expect(currentWorkAbortController.signal.aborted).toBe(true)
    expect(currentWorkAbortController.signal.reason).toBeInstanceOf(
      DOMException,
    )
    expect(
      (currentWorkAbortController.signal.reason as DOMException).name,
    ).toBe('AbortError')
    expect(input).toBeDefined()
    expect(requested).toMatchObject({
      source: 'teammate_escape',
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-turn',
      subagentId: 'researcher@test-team',
      causalEventId: input?.eventId,
    })
  } finally {
    await rendered.cleanup()
  }
})

test('records kill-key causality before aborting the teammate lifecycle', async () => {
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
  const { task, lifecycleAbortController } = createTeammateTask()
  const rendered = await renderNavigation({
    ...getDefaultAppState(),
    tasks: { [task.id]: task },
    expandedView: 'teammates',
    selectedIPAgentIndex: 0,
    viewSelectionMode: 'selecting-agent',
  })

  try {
    rendered.invoke('k')
    const entries = __getInterruptionTraceSnapshotForTests()
    const input = entries.find(entry => entry.event === 'input.teammate_kill')
    const requested = entries.find(entry => entry.event === 'abort.requested')
    expect(lifecycleAbortController.signal.aborted).toBe(true)
    expect(input).toBeDefined()
    expect(requested).toMatchObject({
      source: 'teammate_kill',
      subsystem: 'in_process_teammate',
      controllerRole: 'subagent-lifecycle',
      subagentId: 'researcher@test-team',
      causalEventId: input?.eventId,
    })
  } finally {
    await rendered.cleanup()
  }
})
