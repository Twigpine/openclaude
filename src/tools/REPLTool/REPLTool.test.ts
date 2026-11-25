import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { z } from 'zod/v4'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ProgressMessage } from '../../types/message.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { runToolUse, type MessageUpdateLazy } from '../../services/tools/toolExecution.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from '../../Tool.js'
import { getAllBaseTools, getTools } from '../../tools.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { hasPermissionsToUseTool } from '../../utils/permissions/permissions.js'
import { __test as replTestHooks, REPLTool } from './REPLTool.js'
import { isReplModeEnabled, setReplModeEnabledForSession } from './constants.js'
import {
  renderToolResultMessage,
  renderToolUseProgressMessage,
  selectLatestReplProgressMessages,
} from './UI.js'

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

function createFixtureReplContext(tools: ToolUseContext['options']['tools']): ToolUseContext {
  const context = createContext(tools)
  context.options.replPrimitiveToolNames = []
  return context
}

function createWriteBashFixtures(writeCall: () => { data: unknown } | Promise<{ data: unknown }>) {
  const calls = { write: 0, bash: 0 }
  const writeTool = createToolFixture(z.object({ file_path: z.string(), content: z.string() }), {
    name: 'Write',
    isMcp: true,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async call() {
      calls.write += 1
      return writeCall()
    },
  })
  const bashTool = createToolFixture(z.object({ command: z.string() }), {
    name: 'Bash',
    isMcp: true,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async call() {
      calls.bash += 1
      await new Promise(resolve => setTimeout(resolve, 25))
      return { data: 'bash-done' }
    },
  })
  return { calls, writeTool, bashTool }
}

function createStartedSignal() {
  let notify!: () => void
  const promise = new Promise<void>(resolve => {
    notify = resolve
  })
  return { promise, notify }
}

function createNonCooperativeFixtureTool(name: string) {
  const started = createStartedSignal()
  const state = { sawAbort: false }
  const tool = createToolFixture(z.object({}), {
    name,
    isMcp: true,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async call(_input, context) {
      started.notify()
      await new Promise<void>(() => {
        const signal = context.abortController.signal
        if (signal.aborted) {
          state.sawAbort = true
          return
        }
        signal.addEventListener('abort', () => {
          state.sawAbort = true
        }, { once: true })
      })
      return { data: 'done' }
    },
  })
  return { tool, state, started: started.promise }
}

function createCooperativeFixtureTool(name: string) {
  const started = createStartedSignal()
  const state = { sawAbort: false }
  const tool = createToolFixture(z.object({}), {
    name,
    isMcp: true,
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async call(_input, context) {
      started.notify()
      await new Promise<void>((_resolve, reject) => {
        const cancel = () => {
          state.sawAbort = true
          reject(new Error('cancelled by abort signal'))
        }
        const signal = context.abortController.signal
        if (signal.aborted) {
          cancel()
          return
        }
        signal.addEventListener('abort', cancel, { once: true })
      })
      return { data: 'done' }
    },
  })
  return { tool, state, started: started.promise }
}

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

  test('PostToolUse output replacement redacts virtual hook attachment and system provenance', async () => {
    const code = "await Bash({command: 'printf inner-tool-$((1))ecret'}); return 'done'"
    const innerHookJson = JSON.stringify({
      systemMessage: 'inner-system-secret',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'inner-additional-secret',
      },
    })
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
                matcher: 'Bash',
                hooks: [
                  {
                    hook: {
                      type: 'command',
                      command: `printf '%s' '${innerHookJson}'`,
                    },
                  },
                ],
              },
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
        id: 'repl-hook-provenance-test',
        name: 'REPL',
        input: { code },
      } as ToolUseBlock,
      parentFor(code),
      allow,
      context,
    )) {
      updates.push(update)
    }

    const serialized = JSON.stringify(updates.map(update => update.message).filter(message => message.type !== 'progress'))
    expect(serialized).toContain('[inner tool output redacted by REPL PostToolUse hook]')
    expect(serialized).not.toContain('inner-tool-1ecret')
    expect(serialized).not.toContain('inner-additional-secret')
    expect(serialized).not.toContain('inner-system-secret')
  })

  test('forwards progress with the owning inner invocation id and original event id', async () => {
    const progressTool = createToolFixture(z.object({}), {
      name: 'mcp__fixture__progress',
      isMcp: true,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(_input, _context, _canUseTool, _parentMessage, onProgress) {
        onProgress?.({
          toolUseID: 'fixture-progress-event',
          data: { type: 'mcp_progress', progressMessage: 'working' },
        })
        return { data: 'done' }
      },
    })
    const progressEvents: Array<{ toolUseID: string; data: Record<string, unknown> }> = []
    const result = await REPLTool.call(
      { code: "await mcp__fixture__progress({}); return 'done'" },
      createContext([progressTool]),
      allow,
      parentFor('return done'),
      progress => progressEvents.push(progress as { toolUseID: string; data: Record<string, unknown> }),
    )

    expect(result.data.status).toBe('completed')
    expect(progressEvents).toHaveLength(1)
    const data = progressEvents[0]?.data ?? {}
    expect(data.replInnerProgressEventID).toBe('fixture-progress-event')
    expect(data.replInnerToolUseID).toBeString()
    expect(data.replInnerToolUseID).not.toBe('fixture-progress-event')
    expect(data.replInnerToolName).toBe('mcp__fixture__progress')
  })

  test('groups interleaved inner progress by owning tool call', () => {
    const progress = (
      innerId: string,
      toolName: string,
      data: Record<string, unknown>,
      eventId: string,
    ) => ({
      type: 'progress',
      toolUseID: eventId,
      parentToolUseID: 'outer-repl',
      data: {
        ...data,
        replInnerToolUseID: innerId,
        replInnerToolName: toolName,
      },
      uuid: eventId,
      timestamp: new Date(0).toISOString(),
    }) as unknown as ProgressMessage
    const events = [
      progress('inner-bash', 'Bash', { type: 'bash_progress', output: 'bash old' }, 'event-1'),
      progress('inner-mcp', 'mcp__server__search', { type: 'mcp_progress', progressMessage: 'mcp working' }, 'event-2'),
      progress('inner-bash', 'Bash', { type: 'bash_progress', output: 'bash new' }, 'event-3'),
      progress('inner-powershell', 'PowerShell', { type: 'powershell_progress', output: 'powershell working' }, 'event-4'),
    ]

    const latest = selectLatestReplProgressMessages(events)
    expect(latest).toHaveLength(3)
    expect(latest.map(message => message.data.replInnerToolUseID)).toEqual([
      'inner-mcp',
      'inner-bash',
      'inner-powershell',
    ])
    expect(latest.find(message => message.data.replInnerToolUseID === 'inner-bash')?.data.output).toBe('bash new')

    const rendered = JSON.stringify(renderToolUseProgressMessage(events, { verbose: false }))
    expect(rendered).toContain('Bash')
    expect(rendered).toContain('PowerShell')
    expect(rendered).toContain('mcp__server__search')
    expect(rendered).toContain('bash new')
    expect(rendered).not.toContain('bash old')
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

  test('plan mode allows outer orchestration while denying an inner mutation', async () => {
    const filePath = `/tmp/openclaude-repl-plan-${randomUUID()}.txt`
    const context = createContext()
    const baseGetAppState = context.getAppState
    context.getAppState = () => {
      const state = baseGetAppState()
      return {
        ...state,
        toolPermissionContext: {
          ...state.toolPermissionContext,
          mode: 'plan' as const,
        },
      }
    }

    try {
      const result = await REPLTool.call(
        {
          code: `try { await Write({ file_path: ${JSON.stringify(filePath)}, content: 'mutation' }); return 'write-succeeded' } catch (error) { return error instanceof Error ? error.message : String(error) }`,
        },
        context,
        hasPermissionsToUseTool,
        createAssistantMessage({ content: 'run repl' }),
        undefined,
      )
      expect(result.data.status).toBe('completed')
      expect(String(result.data.result)).toContain('Plan mode is read-only')
      expect(String(result.data.result)).not.toBe('write-succeeded')
    } finally {
      await rm(filePath, { force: true })
    }
  })

  test('dontAsk keeps direct primitives unless REPL is explicitly pre-approved', () => {
    setReplModeEnabledForSession(true)
    const dontAskContext = {
      ...getEmptyToolPermissionContext(),
      mode: 'dontAsk' as const,
    }
    const directFallbackTools = getTools(dontAskContext)
    expect(directFallbackTools.some(tool => tool.name === 'REPL')).toBe(false)
    expect(directFallbackTools.some(tool => tool.name === 'Read')).toBe(true)
    expect(directFallbackTools.some(tool => tool.name === 'Grep')).toBe(true)
    expect(directFallbackTools.some(tool => tool.name === 'Bash')).toBe(true)

    const preapprovedReplContext = {
      ...dontAskContext,
      alwaysAllowRules: { session: ['REPL'] },
    }
    const replOnlyTools = getTools(preapprovedReplContext)
    expect(replOnlyTools.some(tool => tool.name === 'REPL')).toBe(true)
    expect(replOnlyTools.some(tool => tool.name === 'Read')).toBe(false)
  })

  test('marks runtime failure as a protocol tool error and exposes the full script to classifiers', () => {
    const block = REPLTool.mapToolResultToToolResultBlockParam({ status: 'timeout' }, 'toolu_timeout')
    expect(block.is_error).toBe(true)
    const longCode = `// ${'x'.repeat(20_000)}
return 1`
    expect(REPLTool.toAutoClassifierInput({ code: longCode })).toBe(longCode)
  })

  test('uses authoritative input rather than hook-mutated output code in verbose rendering', () => {
    const rendered = renderToolResultMessage(
      { status: 'completed', code: 'return "mutated"', result: 1 },
      [],
      { verbose: true, input: { code: 'return "authoritative"' } },
    )
    const serialized = JSON.stringify(rendered)
    expect(serialized).toContain('authoritative')
    expect(serialized).not.toContain('mutated')
  })

  test('rejects a fast rejecting unawaited Write that settles during a slower awaited Bash', async () => {
    const fixtures = createWriteBashFixtures(() => { throw new Error('write rejected') })
    const code = "Write({file_path: '/tmp/repl-unobserved', content: 'x'}); await Bash({command: 'slow'}); return 'done'"
    const result = await REPLTool.call(
      { code },
      createFixtureReplContext([fixtures.writeTool, fixtures.bashTool]),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('error')
    expect(result.data.error?.message).toContain('without observing settled inner tool results: Write')
    expect(result.data.result).not.toBe('done')
    expect(fixtures.calls).toEqual({ write: 1, bash: 1 })
  })

  test('rejects a fast successful unawaited mutation that settles during a slower awaited Bash', async () => {
    const fixtures = createWriteBashFixtures(() => ({ data: 'written' }))
    const code = "Write({file_path: '/tmp/repl-unobserved', content: 'x'}); await Bash({command: 'slow'}); return 'done'"
    const result = await REPLTool.call(
      { code },
      createFixtureReplContext([fixtures.writeTool, fixtures.bashTool]),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('error')
    expect(result.data.error?.message).toContain('without observing settled inner tool results: Write')
    expect(result.data.result).not.toBe('done')
    expect(fixtures.calls).toEqual({ write: 1, bash: 1 })
  })

  test('rejects an immediately settling unawaited mutation at completion', async () => {
    const fixtures = createWriteBashFixtures(() => ({ data: 'written' }))
    const code = "Write({file_path: '/tmp/repl-immediate-unobserved', content: 'x'}); return 'done'"
    const result = await REPLTool.call(
      { code },
      createFixtureReplContext([fixtures.writeTool, fixtures.bashTool]),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('error')
    expect(result.data.error?.message).toMatch(/without (awaiting all inner tool calls|observing settled inner tool results)/)
    expect(result.data.result).not.toBe('done')
    expect(fixtures.calls.write).toBe(1)
  })

  test('keeps awaited mutation and shell calls passing', async () => {
    const fixtures = createWriteBashFixtures(() => ({ data: 'written' }))
    const code = "const written = await Write({file_path: '/tmp/repl-awaited', content: 'x'}); const bash = await Bash({command: 'slow'}); return [written, bash]"
    const result = await REPLTool.call(
      { code },
      createFixtureReplContext([fixtures.writeTool, fixtures.bashTool]),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('completed')
    expect(result.data.result).toEqual(['written', 'bash-done'])
  })

  test('counts Promise.all as observation for independent mutation and shell calls', async () => {
    const fixtures = createWriteBashFixtures(() => ({ data: 'written' }))
    const code = "return await Promise.all([Write({file_path: '/tmp/repl-all', content: 'x'}), Bash({command: 'slow'})])"
    const result = await REPLTool.call(
      { code },
      createFixtureReplContext([fixtures.writeTool, fixtures.bashTool]),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('completed')
    expect(result.data.result).toEqual(['written', 'bash-done'])
  })

  test('reports residual inner work after timeout when a tool ignores abort', async () => {
    const warmupCode = 'return 1'
    await REPLTool.call({ code: warmupCode }, createContext(), allow, parentFor(warmupCode), undefined)
    const fixture = createNonCooperativeFixtureTool('TimeoutResidualFixture')
    const code = "await TimeoutResidualFixture({}); return 'done'"

    await replTestHooks.withExecutionLimits({ timeoutMs: 50, quiesceTimeoutMs: 30 }, async () => {
      const result = await REPLTool.call(
        { code },
        createFixtureReplContext([fixture.tool]),
        allow,
        parentFor(code),
        undefined,
      )

      expect(result.data.status).toBe('timeout')
      expect(result.data.error?.message).toContain('Script execution timed out')
      expect(result.data.error?.message).not.toContain('still running')
      expect(result.data.residualInnerWork?.active).toBe(true)
      expect(result.data.residualInnerWork?.activeInvocationCount).toBe(1)
      expect(result.data.residualInnerWork?.warning).toContain('may still complete')
      expect(result.data.residualInnerWork?.warning).toContain('Do not retry')
      expect(REPLTool.outputSchema.safeParse(result.data).success).toBe(true)

      const block = REPLTool.mapToolResultToToolResultBlockParam(result.data, 'toolu_timeout_residual')
      expect(String(block.content)).toContain('error: Error: Script execution timed out')
      expect(String(block.content)).toContain('warning: 1 inner tool invocation still running')
      expect(String(block.content)).toContain('Do not retry')
    })
    expect(fixture.state.sawAbort).toBe(true)
  })

  test('reports residual inner work after outer abort when a tool ignores abort', async () => {
    const fixture = createNonCooperativeFixtureTool('AbortResidualFixture')
    const code = "await AbortResidualFixture({}); return 'done'"
    const context = createFixtureReplContext([fixture.tool])

    const result = await replTestHooks.withExecutionLimits({ quiesceTimeoutMs: 30 }, async () => {
      const pending = REPLTool.call(
        { code },
        context,
        allow,
        parentFor(code),
        undefined,
      )
      await fixture.started
      context.abortController.abort(new Error('outer cancellation'))
      return await pending
    })

    expect(result.data.status).toBe('aborted')
    expect(result.data.error?.message).toContain('Script execution aborted')
    expect(result.data.error?.message).not.toContain('still running')
    expect(result.data.residualInnerWork?.active).toBe(true)
    expect(result.data.residualInnerWork?.activeInvocationCount).toBe(1)
    expect(REPLTool.outputSchema.safeParse(result.data).success).toBe(true)
    expect(fixture.state.sawAbort).toBe(true)
  })

  test('does not report residual inner work when abort shutdown is cooperative', async () => {
    const fixture = createCooperativeFixtureTool('AbortCooperativeFixture')
    const code = "await AbortCooperativeFixture({}); return 'done'"
    const context = createFixtureReplContext([fixture.tool])

    const result = await replTestHooks.withExecutionLimits({ quiesceTimeoutMs: 50 }, async () => {
      const pending = REPLTool.call(
        { code },
        context,
        allow,
        parentFor(code),
        undefined,
      )
      await fixture.started
      context.abortController.abort(new Error('outer cancellation'))
      return await pending
    })

    expect(result.data.status).toBe('aborted')
    expect(result.data.error?.message).toContain('Script execution aborted')
    expect(result.data.residualInnerWork).toBeUndefined()
    expect(REPLTool.outputSchema.safeParse(result.data).success).toBe(true)
    expect(fixture.state.sawAbort).toBe(true)
  })

  test('does not report residual inner work when timeout shutdown is cooperative', async () => {
    const warmupCode = 'return 1'
    await REPLTool.call({ code: warmupCode }, createContext(), allow, parentFor(warmupCode), undefined)
    const fixture = createCooperativeFixtureTool('TimeoutCooperativeFixture')
    const code = "await TimeoutCooperativeFixture({}); return 'done'"

    const result = await replTestHooks.withExecutionLimits({ timeoutMs: 50, quiesceTimeoutMs: 50 }, async () =>
      await REPLTool.call(
        { code },
        createFixtureReplContext([fixture.tool]),
        allow,
        parentFor(code),
        undefined,
      ),
    )

    expect(result.data.status).toBe('timeout')
    expect(result.data.error?.message).toContain('Script execution timed out')
    expect(result.data.residualInnerWork).toBeUndefined()
    expect(REPLTool.outputSchema.safeParse(result.data).success).toBe(true)
    expect(fixture.state.sawAbort).toBe(true)
  })

  test('fails closed when script completion leaves inner tool work unawaited', async () => {
    const code = "Bash({command: 'sleep 5'}); return 'done'"
    const result = await REPLTool.call(
      { code },
      createContext(),
      allow,
      parentFor(code),
      undefined,
    )
    expect(result.data.status).toBe('error')
    expect(result.data.error?.message).toContain('without awaiting all inner tool calls')
    expect(result.data.result).not.toBe('done')
  })
})
