import { describe, expect, test } from 'bun:test'
import type { AppState } from '../state/AppStateStore.js'
import type { ToolUseContext } from '../Tool.js'
import { createRootAppStateGetter, createSubagentContext } from './forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'

describe('createRootAppStateGetter', () => {
  test('preserves the original root across nested transformed contexts', () => {
    const rootState = { source: 'root' } as unknown as AppState
    const firstTransformedState = {
      source: 'first-transformed',
    } as unknown as AppState
    const secondTransformedState = {
      source: 'second-transformed',
    } as unknown as AppState

    const rootContext = {
      getAppState: () => rootState,
    } as ToolUseContext
    const firstTransformedContext = {
      ...rootContext,
      getAppState: () => firstTransformedState,
      getRootAppState: createRootAppStateGetter(rootContext),
    }
    const secondTransformedContext = {
      ...firstTransformedContext,
      getAppState: () => secondTransformedState,
      getRootAppState: createRootAppStateGetter(firstTransformedContext),
    }

    expect(secondTransformedContext.getAppState()).toBe(secondTransformedState)
    expect(secondTransformedContext.getRootAppState()).toBe(rootState)
  })
})

describe('createSubagentContext', () => {
  test('propagates foreground REPL execution state into nested agents', () => {
    const tracker = { begin: () => {}, end: () => {} }
    const parent = {
      options: {
        commands: [],
        debug: false,
        mainLoopModel: 'test-model',
        tools: [],
        verbose: false,
        thinkingConfig: {},
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
      },
      abortController: new AbortController(),
      replInnerExecution: true,
      replPromptWaitTracker: tracker,
      readFileState: createFileStateCacheWithSizeLimit(100, 1000),
      messages: [],
      getAppState: () => ({
        mainLoopModel: 'test-model',
        toolPermissionContext: { shouldAvoidPermissionPrompts: false },
      }),
      getRootAppState: () => ({}),
      setAppState: () => {},
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateFileHistoryState: () => {},
      updateAttributionState: () => {},
    } as unknown as ToolUseContext

    const child = createSubagentContext(parent)
    expect(child.replInnerExecution).toBe(true)
    expect(child.replPromptWaitTracker).toBe(tracker)
  })
})
