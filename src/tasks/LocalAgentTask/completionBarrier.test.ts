import { REAL_PROVIDER_TEST_CHILD_ENV, REAL_PROVIDER_TEST_TIMEOUT_MS, runTestFileWithRealProviders } from '../../test/providerModuleIsolation.js'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { asAgentId } from '../../types/ids.js'
import type { ToolUseContext } from '../../Tool.js'
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
  let appState = { tasks: {}, agentNameRegistry: new Map() } as AppState
  return {
    getAppState: () => appState,
    getTask: (id: string) => appState.tasks[id] as LocalAgentTaskState,
    setAppState: (updater: (prev: AppState) => AppState) => { appState = updater(appState) },
  }
}

describe('local-agent completion output barrier', () => {
  for (const foreground of [false, true]) {
    test(`waits for ${foreground ? 'foreground' : 'async'} output initialization and eviction`, async () => {
      const link = deferred()
      const eviction = deferred()
      const evict = mock(() => eviction.promise)
      mock.module('../../utils/task/diskOutput.js', () => ({
        ...actualDiskOutput,
        initTaskOutputAsSymlink: () => link.promise.then(() => '/output'),
        evictTaskOutput: evict,
      }))
      const { registerAsyncAgent, registerAgentForeground, completeAgentTask } = await import('./LocalAgentTask.js')
      const { getTask, getAppState, setAppState } = state()
      const agentId = `barrier-${foreground}`
      const register = foreground ? registerAgentForeground : registerAsyncAgent
      register({ agentId, description: 'test', prompt: 'test', selectedAgent: { agentType: 'test' } as AgentDefinition, setAppState })
      getAppState().agentNameRegistry.set('target', asAgentId(agentId))
      const { SendMessageTool } = await import('../../tools/SendMessageTool/SendMessageTool.js')
      const send = (message: string) => SendMessageTool.call(
        { to: 'target', message }, { getAppState, setAppState } as unknown as ToolUseContext,
        async () => ({ behavior: 'allow' }), {} as never,
      )
      const { drainPendingMessages } = await import('./LocalAgentTask.js')
      expect((await send('live input')).data.success).toBe(true)
      expect(drainPendingMessages(agentId, getAppState, setAppState)).toEqual(['live input'])
      // Execute the actual REPL callback with simulated UI dependencies, avoiding
      // a full terminal mount while checking the admission/clear-input decision.
      const source = readFileSync(new URL('../../screens/REPL.tsx', import.meta.url), 'utf8')
      const start = source.indexOf('const onAgentSubmit = useCallback')
      const end = source.indexOf('// Handlers for auto-run', start)
      const callback = ts.transpileModule(source.slice(start, end) + '\nreturn onAgentSubmit;', {
        compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
      }).outputText
      const localAgents = await import('./LocalAgentTask.js')
      const cleared = mock(() => {})
      const notified = mock(() => {})
      const resumed = mock(async () => {})
      const dependencies = {
        ...localAgents, useCallback: (fn: unknown) => fn, setAppState,
        setInputValue: cleared, getToolUseContext: () => ({}), canUseTool: () => {}, mainLoopModel: 'test',
        addNotification: notified, resumeAgentBackground: resumed, messagesRef: { current: [] },
        createUserMessage: (args: unknown) => args, logForDebugging: () => {}, errorMessage: String,
        injectUserMessageToTeammate: () => {}, React: { createElement: (...args: unknown[]) => args }, Text: 'Text',
      }
      const submit = new Function(...Object.keys(dependencies), callback)(...Object.values(dependencies))
      const assertRefusal = async () => {
        const result = await send('FOLLOW-UP')
        expect(result.data.success).toBe(false)
        expect(result.data.message).toContain('retry')
        await submit('typed follow-up', getTask(agentId), { setCursorOffset: cleared, clearBuffer: cleared })
        expect(notified).toHaveBeenCalled()
        expect(cleared).not.toHaveBeenCalled()
        expect(resumed).not.toHaveBeenCalled()
        expect(getTask(agentId).pendingMessages).toEqual([])
        expect(getTask(agentId).messages ?? []).toEqual([])
      }
      const result = { agentId, content: [] } as unknown as AgentToolResult
      const completion = completeAgentTask(result, setAppState)
      try {
        await settle()
        expect(getTask(agentId).status).toBe('running')
        expect(evict).not.toHaveBeenCalled()
        await assertRefusal()
        link.resolve()
        await settle()
        expect(evict).toHaveBeenCalledTimes(1)
        expect(getTask(agentId).status).toBe('running')
        await assertRefusal()
        eviction.resolve()
        await completion
        expect(getTask(agentId).status).toBe('completed')
        expect(getTask(agentId).result).toBe(result)
        expect(getTask(agentId).evictAfter).toBeGreaterThan(Date.now())
        await submit('retry after completion', getTask(agentId), { setCursorOffset: cleared, clearBuffer: cleared })
        expect(resumed).toHaveBeenCalledTimes(1)
        expect(cleared).toHaveBeenCalled()
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
  for (const foreground of [false, true]) {
    for (const outcome of ['resolve', 'reject', 'abort'] as const) {
      test(`obsolete ${foreground ? 'foreground' : 'async'} completion cannot own a replacement after ${outcome}`, async () => {
        const link = deferred()
        const failure = new Error('old initialization failed')
        let count = 0
        mock.module('../../utils/task/diskOutput.js', () => ({
          ...actualDiskOutput,
          initTaskOutputAsSymlink: () => ++count === 1 ? link.promise.then(() => {
            if (outcome === 'reject') throw failure
            return '/old'
          }) : Promise.resolve('/new'),
          evictTaskOutput: async () => {},
        }))
        const { registerAsyncAgent, registerAgentForeground, completeAgentTask, killAsyncAgent } = await import('./LocalAgentTask.js')
        const { getTask, setAppState } = state()
        const agentId = `replace-${foreground}-${outcome}`
        const register = foreground ? registerAgentForeground : registerAsyncAgent
        const params = { agentId, description: 'old', prompt: 'old', selectedAgent: { agentType: 'test' } as AgentDefinition, setAppState }
        register(params)
        const old = getTask(agentId)
        const completion = completeAgentTask({ agentId, content: [] } as unknown as AgentToolResult, setAppState).catch(error => error)
        register({ ...params, description: 'replacement' })
        const replacement = getTask(agentId)
        try {
          if (outcome === 'abort') old.abortController!.abort()
          link.resolve()
          expect(await completion).toBe(false)
          expect(getTask(agentId).status).toBe('running')
          expect(getTask(agentId).result).toBeUndefined()
          expect(getTask(agentId).abortController).toBe(replacement.abortController)
          expect(getTask(agentId).unregisterCleanup).toBe(replacement.unregisterCleanup)
          killAsyncAgent(agentId, setAppState)
          expect(replacement.abortController!.signal.aborted).toBe(true)
        } finally {
          link.resolve()
          await completion
          await replacement.outputReady
          old.unregisterCleanup?.()
          killAsyncAgent(agentId, setAppState)
        }
      })
    }
  }

})

}
