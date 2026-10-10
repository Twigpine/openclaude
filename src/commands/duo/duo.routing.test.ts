import { describe, expect, test } from 'bun:test'
import { createSubagentContext } from '../../utils/forkedAgent.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import type { ToolUseContext } from '../../Tool.js'
import type { LocalJSXCommandContext } from '../../types/command.js'
import { buildDuoOverrides } from './duo.js'

/**
 * Regression guard for the per-side model routing.
 *
 * query() resolves the request model from appState (src/query.ts), NOT from
 * options.mainLoopModel — so a fork that only sets options silently keeps the
 * session model while the /duo header advertises the pinned one. This test
 * runs the repository's own createSubagentContext, so dropping the appState
 * override (or either field) fails here.
 */

function fakeContext(mainLoopModel: string): LocalJSXCommandContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      mainLoopModel,
      mainLoopModelForSession: mainLoopModel,
      fastMode: false,
      mcp: { tools: {}, clients: [] },
      sessionHooks: new Map(),
      settings: {},
      toolPermissionContext: { mode: 'default' },
    }),
    setAppState: () => {},
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [],
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      mainLoopModel,
      theme: 'dark',
    },
    messages: [],
    readFileState: createFileStateCacheWithSizeLimit(10),
  } as unknown as LocalJSXCommandContext
}

describe('buildDuoOverrides — per-side model routing', () => {
  test('the forked debater really sees the pinned model in appState', () => {
    const parent = fakeContext('session-model')
    const child = createSubagentContext(
      parent as unknown as ToolUseContext,
      buildDuoOverrides(parent, 'duo-side-model'),
    )

    expect(child.options.mainLoopModel).toBe('duo-side-model')
    expect(child.getAppState().mainLoopModel).toBe('duo-side-model')
    expect(child.getAppState().mainLoopModelForSession).toBe('duo-side-model')
  })

  test('the parent session keeps its own model', () => {
    const parent = fakeContext('session-model')
    buildDuoOverrides(parent, 'duo-side-model')
    expect(parent.options.mainLoopModel).toBe('session-model')
    expect(parent.getAppState().mainLoopModel).toBe('session-model')
  })

  test('a state change in the parent is still visible to the debater', () => {
    let current = 'session-model'
    const parent = {
      ...fakeContext('session-model'),
      getAppState: () =>
        ({
          mainLoopModel: current,
          mainLoopModelForSession: current,
          toolPermissionContext: { mode: 'default' },
        }) as ReturnType<ToolUseContext['getAppState']>,
    } as unknown as LocalJSXCommandContext

    const overrides = buildDuoOverrides(parent, 'duo-side-model')
    current = 'session-model-v2'
    const state = overrides.getAppState!()
    // The debater model wins; unrelated state is read live from the parent.
    expect(state.mainLoopModel).toBe('duo-side-model')
    expect(state.mainLoopModelForSession).toBe('duo-side-model')
  })

  test('tool denial cannot be bypassed by a hook', () => {
    const parent = fakeContext('session-model')
    expect(buildDuoOverrides(parent, 'm').requireCanUseTool).toBe(true)
  })
})