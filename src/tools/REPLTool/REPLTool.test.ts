import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { runToolUse, type MessageUpdateLazy } from '../../services/tools/toolExecution.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { REPLTool } from './REPLTool.js'
import { isReplModeEnabled, setReplModeEnabledForSession } from './constants.js'
import { renderToolResultMessage } from './UI.js'

afterEach(() => setReplModeEnabledForSession(false))

function createContext(
  tools: ToolUseContext['options']['tools'] = [],
  sessionHooks = new Map(),
): ToolUseContext {
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
    expect(result.data.code).toBe("console.log('hello'); return {value: 2}")
    expect(result.data.result).toEqual({ value: 2 })
    expect(result.data.stdout).toContain('hello')
    expect(result.data.innerMessageCount).toBe(0)
  })

  test('maps output to concise model-facing text rather than raw script state', async () => {
    const output = {
      status: 'completed' as const,
      code: 'return {large: "x"}',
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


  test('bounds script input and tolerates partial redacted output', () => {
    expect(REPLTool.inputSchema.safeParse({ code: 'x'.repeat(100_000) }).success).toBe(true)
    expect(REPLTool.inputSchema.safeParse({ code: 'x'.repeat(100_001) }).success).toBe(false)
    expect(REPLTool.outputSchema.safeParse({ status: 'completed' }).success).toBe(true)
    expect(REPLTool.outputSchema.safeParse({ stdout: 'redacted partial output' }).success).toBe(true)
  })

  test('shows a concise row and reveals exact source in verbose result rendering', () => {
    const code = "const x = 1\nreturn x"
    expect(REPLTool.renderToolUseMessage({ code })).toBe('2 lines')

    const rendered = renderToolResultMessage(
      { status: 'completed', result: 1, durationMs: 3, toolsUsed: [] },
      [],
      { verbose: true, input: { code } },
    )
    const textOf = (node: unknown): string => {
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map(textOf).join('')
      if (node && typeof node === 'object' && 'props' in node) {
        return textOf((node as { props?: { children?: unknown } }).props?.children)
      }
      return ''
    }
    expect(textOf(rendered)).toContain(code)
  })


  test('virtual inner provenance is emitted before the reduced outer tool result', async () => {
    const code = "try { await Read({file_path: '/definitely/not/a/repl-order-file'}) } catch (error) {} return 'done'"
    const context = createContext([REPLTool])
    const updates: MessageUpdateLazy[] = []
    for await (const update of runToolUse(
      {
        type: 'tool_use',
        id: 'repl_outer_test',
        name: 'REPL',
        input: { code },
      } as ToolUseBlock,
      parentFor(code),
      allow,
      context,
    )) {
      updates.push(update)
    }

    const kinds = updates.map(update => {
      const message = update.message as {
        type: string
        isVirtual?: boolean
        message?: { content?: unknown }
      }
      if (message.type === 'assistant' && message.isVirtual) return 'inner-use'
      if (message.type === 'user' && message.isVirtual) return 'inner-result'
      if (message.type === 'user') return 'outer-result'
      return message.type
    })
    expect(kinds.indexOf('inner-use')).toBeGreaterThanOrEqual(0)
    expect(kinds.indexOf('inner-result')).toBeGreaterThan(kinds.indexOf('inner-use'))
    expect(kinds.indexOf('outer-result')).toBeGreaterThan(kinds.indexOf('inner-result'))
  })

  test('comment-free inner permission denial terminates the script even inside try/catch', async () => {
    const code = "try { await Bash({command: 'echo denied'}) } catch (error) { console.log('caught') } return 'survived'"
    const denyWithoutFeedback: CanUseToolFn = async (tool, input) => tool.name === 'Bash'
      ? { behavior: 'ask', message: 'No shell access' }
      : { behavior: 'allow', updatedInput: input }

    const result = await REPLTool.call(
      { code },
      createContext(),
      denyWithoutFeedback,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('aborted')
    expect(result.data.result).not.toBe('survived')
    expect(result.data.stdout ?? '').not.toContain('caught')
  })

  test('inner permission denial feedback remains catchable by the script', async () => {
    const code = "try { await Bash({command: 'echo denied'}) } catch (error) { console.log('caught') } return 'survived'"
    const denyWithFeedback: CanUseToolFn = async (tool, input) => tool.name === 'Bash'
      ? { behavior: 'ask', message: 'No shell access', rejectFeedback: 'use a read-only query instead' }
      : { behavior: 'allow', updatedInput: input }

    const result = await REPLTool.call(
      { code },
      createContext(),
      denyWithFeedback,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('completed')
    expect(result.data.result).toBe('survived')
    expect(result.data.stdout).toContain('caught')
  })

  test('PostToolUse updatedToolOutput redacts the final REPL output before commit', async () => {
    const code = "return {secret: 'original-script-result'}"
    const replacement = {
      status: 'completed',
      code: '[redacted script]',
      result: '[redacted result]',
    }
    const replacementJson = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: replacement,
      },
    })
    const sessionHooks = new Map([
      [
        getSessionId(),
        {
          hooks: {
            PostToolUse: [
              {
                matcher: 'REPL',
                hooks: [
                  {
                    hook: {
                      type: 'command',
                      command: `printf '%s' '${replacementJson}'`,
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ])
    const context = createContext([REPLTool], sessionHooks)
    const updates: MessageUpdateLazy[] = []
    for await (const update of runToolUse(
      {
        type: 'tool_use',
        id: 'repl-hook-output-test',
        name: 'REPL',
        input: { code },
      } as ToolUseBlock,
      parentFor(code),
      allow,
      context,
    )) {
      updates.push(update)
    }

    const toolResult = updates.find(update => update.message.type === 'user')?.message
    expect((toolResult as { toolUseResult?: unknown })?.toolUseResult).toEqual(replacement)
    expect(JSON.stringify(toolResult)).toContain('[redacted script]')
    expect(JSON.stringify(toolResult)).not.toContain('original-script-result')
    expect(JSON.stringify(toolResult)).not.toContain(code)
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

    const nestedAgentTools = getTools(permissionContext, { forceDirectToolInventory: true })
    expect(nestedAgentTools.some(tool => tool.name === 'Read')).toBe(true)
    expect(nestedAgentTools.some(tool => tool.name === 'REPL')).toBe(false)
  })
})
