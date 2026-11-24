import { afterEach, describe, expect, test } from 'bun:test'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { REPLTool } from './REPLTool.js'
import { isReplModeEnabled, setReplModeEnabledForSession } from './constants.js'

afterEach(() => setReplModeEnabledForSession(false))

function createContext(tools: ToolUseContext['options']['tools'] = []): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools,
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
      sessionHooks: new Map(),
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

const allow: CanUseToolFn = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })

function parentFor(code: string) {
  return createAssistantMessage({
    content: [{
      type: 'tool_use',
      id: 'repl_outer_test',
      name: 'REPL',
      input: { code },
      caller: { type: 'direct' },
    }],
  })
}

describe('REPLTool', () => {
  test('executes JavaScript and returns reduced structured output', async () => {
    const result = await REPLTool.call(
      { code: "console.log('hello'); return {value: 2}" },
      createContext(),
      allow,
      parentFor('return {value: 2}'),
      undefined,
    )
    expect(result.data.status).toBe('completed')
    expect(result.data.result).toEqual({ value: 2 })
    expect(result.data.stdout).toContain('hello')
    expect(result.data.innerMessageCount).toBe(0)
  })

  test('maps output to concise model-facing text rather than raw script state', async () => {
    const output = {
      status: 'completed' as const,
      result: { large: 'x'.repeat(10_000) },
      stdout: 'out',
      stderr: '',
      durationMs: 12,
      toolsUsed: ['Read'],
      innerMessageCount: 2,
    }
    const block = REPLTool.mapToolResultToToolResultBlockParam(output, 'toolu_test')
    expect(block.type).toBe('tool_result')
    expect(String(block.content)).toContain('REPL completed')
    expect(String(block.content)).toContain('tools used: Read')
    expect(String(block.content).length).toBeLessThan(9_000)
  })

  test('registers only when session mode is active and hides primitives only then', () => {
    const permissionContext = getEmptyToolPermissionContext()
    setReplModeEnabledForSession(false)
    expect(getAllBaseTools().some(tool => tool.name === 'REPL')).toBe(false)
    expect(getTools(permissionContext).some(tool => tool.name === 'Read')).toBe(true)

    setReplModeEnabledForSession(true)
    expect(getAllBaseTools().some(tool => tool.name === 'REPL')).toBe(true)
    const tools = getTools(permissionContext)
    expect(tools.some(tool => tool.name === 'REPL')).toBe(true)
    expect(tools.some(tool => tool.name === 'Read')).toBe(false)
    expect(isReplModeEnabled()).toBe(true)
  })
})
