import { REAL_PROVIDER_TEST_CHILD_ENV, REAL_PROVIDER_TEST_TIMEOUT_MS, runTestFileWithRealProviders } from '../../test/providerModuleIsolation.js'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { AppState } from '../../state/AppState.js'
import type { AgentToolResult } from '../../tools/AgentTool/agentToolUtils.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { AbortError } from '../../utils/errors.js'
import type { LocalAgentTaskState } from './LocalAgentTask.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

const actualDiskOutput = { ...await import('../../utils/task/diskOutput.js') }
const settle = () => new Promise<void>(res => setTimeout(res, 0))

// Use the existing clean-child harness: other agent tests replace these
// production modules globally, and this test needs real registration/storage.
if (process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1') {
  test('agent output regression cases in a clean process', () =>
    runTestFileWithRealProviders(import.meta.path), REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000)
} else {
beforeEach(() => acquireSharedMutationLock('tasks/LocalAgentTask/completionBarrier.test.ts'))
afterEach(() => {
  mock.module('../../utils/task/diskOutput.js', () => actualDiskOutput)
  releaseSharedMutationLock()
})

function state() {
  let appState = { tasks: {} } as AppState
  return {
    getTask: (id: string) => appState.tasks[id] as LocalAgentTaskState,
    setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) },
  }
}

describe('local-agent completion output barrier', () => {
  for (const foreground of [false, true]) {
    test(`waits for ${foreground ? 'foreground' : 'async'} output initialization and eviction`, async () => {
      const link = deferred()
      const eviction = deferred()
      mock.module('../../utils/task/diskOutput.js', () => ({
        ...actualDiskOutput,
        initTaskOutputAsSymlink: () => link.promise.then(() => '/output'),
        evictTaskOutput: () => eviction.promise,
      }))
      const { registerAsyncAgent, registerAgentForeground, completeAgentTask } = await import('./LocalAgentTask.js')
      const { getTask, setAppState } = state()
      const agentId = `barrier-${foreground}`
      const register = foreground ? registerAgentForeground : registerAsyncAgent
      register({ agentId, description: 'test', prompt: 'test', selectedAgent: { agentType: 'test' } as AgentDefinition, setAppState })
      const result = { agentId, content: [] } as unknown as AgentToolResult
      const completion = completeAgentTask(result, setAppState)
      try {
        eviction.resolve()
        await settle()
        expect(getTask(agentId).status).toBe('running')
        link.resolve()
        await completion
        expect(getTask(agentId).status).toBe('completed')
        expect(getTask(agentId).result).toBe(result)
        expect(getTask(agentId).evictAfter).toBeGreaterThan(Date.now())
      } finally {
        link.resolve()
        eviction.resolve()
        await completion
      }
    })
  }

  test('cancellation interrupts pending output readiness instead of reporting success', async () => {
    const link = deferred()
    mock.module('../../utils/task/diskOutput.js', () => ({
      ...actualDiskOutput,
      initTaskOutputAsSymlink: () => link.promise.then(() => '/output'),
      evictTaskOutput: async () => {},
    }))
    const { registerAsyncAgent, completeAgentTask, killAsyncAgent } = await import('./LocalAgentTask.js')
    const { getTask, setAppState } = state()
    const agentId = 'barrier-cancel'
    registerAsyncAgent({ agentId, description: 'test', prompt: 'test', selectedAgent: { agentType: 'test' } as AgentDefinition, setAppState })
    const completion = completeAgentTask({ agentId, content: [] } as unknown as AgentToolResult, setAppState)
    const outcome = completion.then(() => undefined, error => error)
    try {
      killAsyncAgent(agentId, setAppState)
      await settle()
      expect(getTask(agentId).status).toBe('killed')
      expect(await Promise.race([outcome, Promise.resolve('still waiting')])).toBeInstanceOf(AbortError)
    } finally {
      link.resolve()
      await outcome
    }
  })
})

}
