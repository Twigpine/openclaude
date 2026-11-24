import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { resetDoomLoop } from '../../utils/doomLoop.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { ReplInnerToolRunner } from './innerToolRunner.js'
import { PromptWaitTracker } from './quickjsRuntime.js'

function createContext(tools: readonly Tool[]): ToolUseContext {
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

function allowCanUseTool(calls: string[] = []): CanUseToolFn {
  return async (tool, input) => {
    calls.push(tool.name)
    return { behavior: 'allow', updatedInput: input }
  }
}

function createRunner(tools: readonly Tool[], options: {
  caps?: ConstructorParameters<typeof ReplInnerToolRunner>[0]['caps']
  onVirtualMessage?: (message: Message) => void
  canUseTool?: CanUseToolFn
} = {}) {
  const context = createContext(tools)
  return new ReplInnerToolRunner({
    inventory: tools,
    toolUseContext: context,
    canUseTool: options.canUseTool ?? allowCanUseTool(),
    promptWaitTracker: new PromptWaitTracker(),
    caps: options.caps,
    onVirtualMessage: options.onVirtualMessage,
  })
}

describe('ReplInnerToolRunner', () => {
  test('executes through canonical permission flow and emits virtual provenance', async () => {
    resetDoomLoop()
    const permissionCalls: string[] = []
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'FixtureRead',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) {
        return { data: `read:${input.value}` }
      },
    })
    const runner = createRunner([tool], {
      canUseTool: allowCanUseTool(permissionCalls),
      onVirtualMessage: message => messages.push(message),
    })
    const result = await runner.callTool('FixtureRead', { value: 'a' })
    expect(result).toBe('read:a')
    expect(permissionCalls).toEqual(['FixtureRead'])
    expect(messages.some(message => message.type === 'assistant' && message.isVirtual)).toBe(true)
    expect(messages.some(message => message.type === 'user')).toBe(true)
  })

  test('generic tool bridge reaches canonical names not exposed as exact identifiers', async () => {
    resetDoomLoop()
    const tool = createToolFixture(z.object({}), {
      name: 'mcp__server__not-legal',
      isMcp: true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() { return { data: 'mcp-ok' } },
    })
    const runner = createRunner([tool])
    const hostFunctions = runner.createHostFunctions()
    expect(hostFunctions['mcp__server__not-legal']).toBeUndefined()
    await expect(hostFunctions.tool(['mcp__server__not-legal', {}])).resolves.toBe('mcp-ok')
  })

  test('rejects background shell work before invoking the tool', async () => {
    resetDoomLoop()
    let called = false
    const tool = createToolFixture(z.object({ command: z.string(), run_in_background: z.boolean().optional() }), {
      name: BASH_TOOL_NAME,
      async call() {
        called = true
        return { data: 'bad' }
      },
    })
    const runner = createRunner([tool])
    await expect(runner.callTool(BASH_TOOL_NAME, {
      command: 'sleep 10',
      run_in_background: true,
    })).rejects.toThrow('run_in_background is unavailable')
    expect(called).toBe(false)
  })

  test('enforces injectable total and shell caps before host work starts', async () => {
    resetDoomLoop()
    let calls = 0
    const tool = createToolFixture(z.object({ command: z.string() }), {
      name: BASH_TOOL_NAME,
      async call() {
        calls += 1
        return { data: 'ok' }
      },
    })
    const runner = createRunner([tool], {
      caps: { maxTotalCalls: 1, maxShellCalls: 1 },
    })
    await runner.callTool(BASH_TOOL_NAME, { command: 'one' })
    await expect(runner.callTool(BASH_TOOL_NAME, { command: 'two' })).rejects.toThrow('total inner call cap')
    expect(calls).toBe(1)
  })

  test('omits binary attachment payloads from guest results', async () => {
    resetDoomLoop()
    const tool = createToolFixture(z.object({}), {
      name: 'ImageFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return {
          data: {
            type: 'image',
            mimeType: 'image/png',
            data: 'a'.repeat(1000),
          },
        }
      },
    })
    const runner = createRunner([tool])
    const result = await runner.callTool('ImageFixture', {}) as Record<string, unknown>
    expect(result.data).toBe('[attachment payload omitted from REPL result]')
    expect(result.mimeType).toBe('image/png')
  })
})
