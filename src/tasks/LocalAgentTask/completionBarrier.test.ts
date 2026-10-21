import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'

// Pin ORC-1337 — the durable-output barrier must precede the observable
// terminal state. TaskOutput(block=true) releases readers the moment it sees
// a terminal status, so if completeAgentTask flips status to 'completed'
// before the session-storage queue (sidechain transcript) and DiskTaskOutput
// are flushed, readers can observe an empty or partial output file. These
// tests gate both flushes behind controllable deferreds and assert the
// status transition cannot be observed until BOTH barriers have settled.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(res => {
    resolve = res
  })
  return { promise, resolve }
}

// Let queued microtasks (the awaits inside completeAgentTask) run.
const settleMicrotasks = () => new Promise<void>(res => setTimeout(res, 0))

const actualSessionStorage = await import('../../utils/sessionStorage.js')
const actualDiskOutput = await import('../../utils/task/diskOutput.js')

afterEach(() => {
  // Restore real modules so gated barriers don't leak into other files
  // on the same shard.
  mock.module('../../utils/sessionStorage.js', () => actualSessionStorage)
  mock.module('../../utils/task/diskOutput.js', () => actualDiskOutput)
})

function makeRunningTask(taskId: string): {
  getTask: () => LocalAgentTaskState
  setAppState: (updater: (prev: AppState) => AppState) => void
} {
  // Minimal fixture — only the fields completeAgentTask touches. Cast
  // type-side only, same pattern as progressTracker.test.ts.
  let appState = {
    tasks: {
      [taskId]: {
        id: taskId,
        type: 'local_agent',
        agentId: taskId,
        status: 'running',
        retain: false,
      } as unknown as LocalAgentTaskState,
    },
  } as unknown as AppState
  return {
    getTask: () => appState.tasks[taskId] as LocalAgentTaskState,
    setAppState: updater => {
      appState = updater(appState)
    },
  }
}

describe('completeAgentTask output barrier (ORC-1337)', () => {
  test('status stays running until session-storage flush AND eviction settle', async () => {
    const flushGate = deferred()
    const evictGate = deferred()
    mock.module('../../utils/sessionStorage.js', () => ({
      ...actualSessionStorage,
      flushSessionStorage: () => flushGate.promise,
    }))
    mock.module('../../utils/task/diskOutput.js', () => ({
      ...actualDiskOutput,
      evictTaskOutput: () => evictGate.promise,
    }))
    const { completeAgentTask } = await import('./LocalAgentTask.js')

    const taskId = 'orc-1337-barrier'
    const { getTask, setAppState } = makeRunningTask(taskId)
    const result = { agentId: taskId, content: [] } as unknown as AgentToolResult

    const completion = completeAgentTask(result, setAppState)

    // Neither barrier has settled — the terminal state must not be visible.
    await settleMicrotasks()
    expect(getTask().status).toBe('running')

    // Session storage flushed, but DiskTaskOutput eviction still pending.
    flushGate.resolve()
    await settleMicrotasks()
    expect(getTask().status).toBe('running')

    // Both barriers settled — now, and only now, the task may complete.
    evictGate.resolve()
    await completion
    expect(getTask().status).toBe('completed')
    expect(getTask().result).toBe(result)
  })

  test('completion resolves and flips status once barriers are already settled', async () => {
    mock.module('../../utils/sessionStorage.js', () => ({
      ...actualSessionStorage,
      flushSessionStorage: () => Promise.resolve(),
    }))
    mock.module('../../utils/task/diskOutput.js', () => ({
      ...actualDiskOutput,
      evictTaskOutput: () => Promise.resolve(),
    }))
    const { completeAgentTask } = await import('./LocalAgentTask.js')

    const taskId = 'orc-1337-settled'
    const { getTask, setAppState } = makeRunningTask(taskId)
    const result = { agentId: taskId, content: [] } as unknown as AgentToolResult

    await completeAgentTask(result, setAppState)
    expect(getTask().status).toBe('completed')
    expect(getTask().evictAfter).toBeGreaterThan(Date.now())
  })
})
