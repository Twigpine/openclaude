import { describe, expect, test } from 'bun:test'

import { getSessionId } from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../Tool.js'
import {
  executePostToolHooks,
  type AggregatedHookResult,
} from './hooks.js'

function createHookTestContext(
  sessionHooks: Map<string, unknown>,
): ToolUseContext {
  const appState = getDefaultAppState()
  return {
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
      agentDefinitions: { agents: [], errors: [] },
    },
    abortController: new AbortController(),
    readFileState: {},
    getAppState: () => ({
      ...appState,
      sessionHooks,
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [],
  } as unknown as ToolUseContext
}

function postToolOutputHookSession(
  hookSpecificOutput: Record<string, unknown>,
): Map<string, unknown> {
  const hookOutputJson = JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      ...hookSpecificOutput,
    },
  })
  return new Map([
    [
      getSessionId(),
      {
        hooks: {
          PostToolUse: [
            {
              matcher: 'HookedTool',
              hooks: [
                {
                  hook: {
                    type: 'command',
                    command: `printf '%s' '${hookOutputJson}'`,
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ])
}

async function collectReplacementResults(
  hookSpecificOutput: Record<string, unknown>,
) {
  const context = createHookTestContext(
    postToolOutputHookSession(hookSpecificOutput),
  )
  const results: AggregatedHookResult[] = []
  for await (const result of executePostToolHooks(
    'HookedTool',
    'toolu_hooked',
    {},
    'original-output',
    context,
  )) {
    results.push(result)
  }
  return results.filter(
    result =>
      result.updatedToolOutput !== undefined ||
      result.updatedMCPToolOutput !== undefined,
  )
}

describe('executePostToolHooks output replacement precedence', () => {
  test('updatedToolOutput suppresses the legacy MCP replacement when both are returned', async () => {
    const results = await collectReplacementResults({
      updatedToolOutput: 'generic-replacement',
      updatedMCPToolOutput: 'legacy-mcp-replacement',
    })

    expect(results).toEqual([
      { updatedToolOutput: 'generic-replacement' },
    ])
  })

  test('legacy MCP replacement is still yielded when it is the only replacement', async () => {
    const results = await collectReplacementResults({
      updatedMCPToolOutput: 'legacy-mcp-replacement',
    })

    expect(results).toEqual([
      { updatedMCPToolOutput: 'legacy-mcp-replacement' },
    ])
  })
})
