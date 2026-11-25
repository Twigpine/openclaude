import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { getEmptyToolPermissionContext, type Tool, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { resetDoomLoop } from '../../utils/doomLoop.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import {
  DEFAULT_REPL_PROVENANCE_BUDGET_BYTES,
  ReplInnerToolRunner,
} from './innerToolRunner.js'
import { executeQuickJSScript, PromptWaitTracker } from './quickjsRuntime.js'

function createContext(
  tools: readonly Tool[],
  sessionHooks: Map<string, unknown> = new Map(),
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

function allowCanUseTool(calls: string[] = []): CanUseToolFn {
  return async (tool, input) => {
    calls.push(tool.name)
    return { behavior: 'allow', updatedInput: input }
  }
}

function createRunner(tools: readonly Tool[], options: {
  caps?: ConstructorParameters<typeof ReplInnerToolRunner>[0]['caps']
  onVirtualMessage?: (message: Message) => void
  onProgress?: (message: Message) => void
  canUseTool?: CanUseToolFn
  abortSignal?: AbortSignal
  sessionHooks?: Map<string, unknown>
} = {}) {
  const context = createContext(tools, options.sessionHooks ?? new Map())
  return new ReplInnerToolRunner({
    inventory: tools,
    toolUseContext: context,
    canUseTool: options.canUseTool ?? allowCanUseTool(),
    promptWaitTracker: new PromptWaitTracker(),
    caps: options.caps,
    onVirtualMessage: options.onVirtualMessage,
    onProgress: options.onProgress,
    abortSignal: options.abortSignal,
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
    expect(messages.some(message => message.type === 'user' && message.isVirtual)).toBe(true)
  })

  test('attributes emitted progress to the owning inner tool invocation', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const progressMessages: Message[] = []
    const tool = createToolFixture(z.object({}), {
      name: 'FixtureProgress',
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
    const runner = createRunner([tool], {
      onVirtualMessage: message => messages.push(message),
      onProgress: message => progressMessages.push(message),
    })

    await expect(runner.callTool('FixtureProgress', {})).resolves.toBe('done')
    const assistant = messages.find(message => message.type === 'assistant')
    const toolUseId = assistant?.type === 'assistant' && Array.isArray(assistant.message.content)
      ? assistant.message.content[0]?.type === 'tool_use'
        ? assistant.message.content[0].id
        : undefined
      : undefined
    const emitted = progressMessages[0]
    if (!toolUseId) throw new Error('Expected inner tool use provenance')
    expect(emitted?.type).toBe('progress')
    if (emitted?.type !== 'progress') throw new Error('Expected progress provenance')
    expect(emitted.parentToolUseID).toBe(toolUseId)
    expect((emitted.data as Record<string, unknown>).replInnerToolName).toBe('FixtureProgress')
  })

  test('lower-case primitive aliases resolve to canonical tools without replacing exact names', async () => {
    resetDoomLoop()
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'Read',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) { return { data: `read:${input.value}` } },
    })
    const runner = createRunner([tool])
    const hostFunctions = runner.createHostFunctions()
    await expect(hostFunctions.Read([{ value: 'exact' }])).resolves.toBe('read:exact')
    await expect(hostFunctions.read([{ value: 'alias' }])).resolves.toBe('read:alias')
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

  test('enforces the injectable total cap before host work starts', async () => {
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
      caps: { maxTotalCalls: 1 },
    })
    await runner.callTool(BASH_TOOL_NAME, { command: 'one' })
    await expect(runner.callTool(BASH_TOOL_NAME, { command: 'two' })).rejects.toThrow('total inner call cap')
    expect(calls).toBe(1)
  })


  test('enforces shell, mutation, and Agent caps independently', async () => {
    resetDoomLoop()
    const shellTool = createToolFixture(z.object({ command: z.string() }), {
      name: BASH_TOOL_NAME,
      async call() {
        return { data: 'ok' }
      },
    })
    const shellRunner = createRunner([shellTool], {
      caps: { maxTotalCalls: 10, maxShellCalls: 1 },
    })
    await shellRunner.callTool(BASH_TOOL_NAME, { command: 'one' })
    await expect(shellRunner.callTool(BASH_TOOL_NAME, { command: 'two' })).rejects.toThrow('shell/process call cap')

    const mutationTool = createToolFixture(z.object({}), {
      name: 'FixtureMutation',
      isReadOnly: () => false,
      async call() {
        return { data: 'ok' }
      },
    })
    const mutationRunner = createRunner([mutationTool], {
      caps: { maxTotalCalls: 10, maxMutationCalls: 1 },
    })
    await mutationRunner.callTool('FixtureMutation', {})
    await expect(mutationRunner.callTool('FixtureMutation', {})).rejects.toThrow('mutation call cap')

    const agentTool = createToolFixture(z.object({}), {
      name: 'Agent',
      async call() {
        return { data: 'ok' }
      },
    })
    const agentRunner = createRunner([agentTool], {
      caps: { maxTotalCalls: 10, maxAgentCalls: 1 },
    })
    await agentRunner.callTool('Agent', {})
    await expect(agentRunner.callTool('Agent', {})).rejects.toThrow('Agent call cap')
  })

  test('runs independent concurrency-safe calls in parallel', async () => {
    resetDoomLoop()
    let active = 0
    let maxActive = 0
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'ConcurrentFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active -= 1
        return { data: input.value }
      },
    })
    const runner = createRunner([tool])
    await expect(Promise.all([
      runner.callTool('ConcurrentFixture', { value: 'one' }),
      runner.callTool('ConcurrentFixture', { value: 'two' }),
    ])).resolves.toEqual(['one', 'two'])
    expect(maxActive).toBe(2)
  })

  test('serializes non-concurrency-safe calls while reads can overlap', async () => {
    resetDoomLoop()
    const events: string[] = []
    const writeTool = createToolFixture(z.object({ value: z.string() }), {
      name: 'WriteFixture',
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(input) {
        events.push(`start:${input.value}`)
        await new Promise(resolve => setTimeout(resolve, 10))
        events.push(`end:${input.value}`)
        return { data: input.value }
      },
    })
    const runner = createRunner([writeTool])
    await Promise.all([
      runner.callTool('WriteFixture', { value: 'one' }),
      runner.callTool('WriteFixture', { value: 'two' }),
    ])
    expect(events).toEqual(['start:one', 'end:one', 'start:two', 'end:two'])
  })

  test('aborts the in-flight canonical tool when REPL execution is interrupted', async () => {
    resetDoomLoop()
    let sawAbort = false
    let signalListenerInstalled!: () => void
    const listenerReady = new Promise<void>(resolve => {
      signalListenerInstalled = resolve
    })
    const tool = createToolFixture(z.object({}), {
      name: 'CancellableFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(_input, context) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 500)
          context.abortController.signal.addEventListener('abort', () => {
            sawAbort = true
            clearTimeout(timer)
            reject(new Error('cancelled by abort signal'))
          }, { once: true })
          signalListenerInstalled()
        })
        return { data: 'done' }
      },
    })
    const controller = new AbortController()
    const runner = createRunner([tool], { abortSignal: controller.signal })
    const pending = runner.callTool('CancellableFixture', {})
    await listenerReady
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(sawAbort).toBe(true)
  })

  test('rejects queued semaphore acquisitions when the runner aborts', async () => {
    resetDoomLoop()
    let startedCalls = 0
    let sawAbort = false
    let signalListenerInstalled!: () => void
    const listenerReady = new Promise<void>(resolve => {
      signalListenerInstalled = resolve
    })
    const tool = createToolFixture(z.object({}), {
      name: 'AbortSemaphoreFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(_input, context) {
        startedCalls += 1
        await new Promise<void>((_resolve, reject) => {
          context.abortController.signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('cancelled by abort signal'))
          }, { once: true })
          signalListenerInstalled()
        })
        return { data: 'done' }
      },
    })
    const controller = new AbortController()
    const runner = createRunner([tool], {
      caps: { maxConcurrentCalls: 1 },
      abortSignal: controller.signal,
    })
    const first = runner.callTool('AbortSemaphoreFixture', {})
    const second = runner.callTool('AbortSemaphoreFixture', {})
    await listenerReady
    controller.abort()
    const results = await Promise.allSettled([first, second])
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('rejected')
    const secondReason = results[1]?.status === 'rejected' ? results[1].reason : undefined
    expect((secondReason as Error).message).toContain('aborted')
    expect(sawAbort).toBe(true)
    expect(startedCalls).toBe(1)
  })

  test('rejects queued read-write lane acquisitions when the runner aborts', async () => {
    resetDoomLoop()
    let startedCalls = 0
    let sawAbort = false
    let signalListenerInstalled!: () => void
    const listenerReady = new Promise<void>(resolve => {
      signalListenerInstalled = resolve
    })
    const tool = createToolFixture(z.object({}), {
      name: 'AbortWriteLaneFixture',
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call(_input, context) {
        startedCalls += 1
        await new Promise<void>((_resolve, reject) => {
          context.abortController.signal.addEventListener('abort', () => {
            sawAbort = true
            reject(new Error('cancelled by abort signal'))
          }, { once: true })
          signalListenerInstalled()
        })
        return { data: 'done' }
      },
    })
    const controller = new AbortController()
    const runner = createRunner([tool], {
      caps: { maxConcurrentCalls: 2 },
      abortSignal: controller.signal,
    })
    const first = runner.callTool('AbortWriteLaneFixture', {})
    const second = runner.callTool('AbortWriteLaneFixture', {})
    await listenerReady
    controller.abort()
    const results = await Promise.allSettled([first, second])
    expect(results[0]?.status).toBe('rejected')
    expect(results[1]?.status).toBe('rejected')
    const secondReason = results[1]?.status === 'rejected' ? results[1].reason : undefined
    expect((secondReason as Error).message).toContain('aborted')
    expect(sawAbort).toBe(true)
    expect(startedCalls).toBe(1)
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

  test('omits nested FileRead image and PDF payloads from guest results', async () => {
    resetDoomLoop()
    const tool = createToolFixture(z.object({}), {
      name: 'FileReadFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return {
          data: {
            type: 'image',
            file: {
              base64: 'a'.repeat(1000),
              type: 'image/png',
              originalSize: 1000,
            },
          },
        }
      },
    })
    const runner = createRunner([tool])
    const result = await runner.callTool('FileReadFixture', {}) as {
      file: { base64: string; type: string; originalSize: number }
    }
    expect(result.file.base64).toBe('[attachment payload omitted from REPL result]')
    expect(result.file.type).toBe('image/png')
    expect(result.file.originalSize).toBe(1000)

    const pdfTool = createToolFixture(z.object({}), {
      name: 'PdfReadFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call() {
        return {
          data: {
            type: 'pdf',
            file: {
              filePath: '/tmp/example.pdf',
              base64: 'c'.repeat(1000),
              originalSize: 1000,
            },
          },
        }
      },
    })
    const pdfRunner = createRunner([pdfTool])
    const pdfResult = await pdfRunner.callTool('PdfReadFixture', {}) as {
      file: { base64: string; filePath: string }
    }
    expect(pdfResult.file.base64).toBe('[attachment payload omitted from REPL result]')
    expect(pdfResult.file.filePath).toBe('/tmp/example.pdf')
  })

  test('caps initial virtual assistant input provenance while preserving the tool use id', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ command: z.string() }), {
      name: BASH_TOOL_NAME,
      async call() { return { data: 'ok' } },
    })
    const runner = createRunner([tool], {
      onVirtualMessage: message => messages.push(message),
    })
    const longKey = 'k'.repeat(20_000)
    await runner.callTool(BASH_TOOL_NAME, { command: `echo ${'x'.repeat(20_000)}`, [longKey]: 'extra' })
    const assistant = messages.find(message => message.type === 'assistant')
    const block = assistant?.message.content[0] as { id?: string; input?: { command?: string } }
    expect(block.id).toStartWith('repl_tool_')
    expect(block.input?.command?.length).toBeLessThan(5_000)
    expect(block.input?.command).toContain('truncated')
    expect(JSON.stringify(assistant)).not.toContain('[undefined]')
    expect(JSON.stringify(assistant)).not.toContain(longKey)
  })

  test('rejects multi-MB Write and Bash fanout before queued concurrency slots open', async () => {
    resetDoomLoop()
    let started = 0
    const writeTool = createToolFixture(z.object({ file_path: z.string(), content: z.string() }), {
      name: 'Write',
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      async call() {
        started += 1
        await new Promise(resolve => setTimeout(resolve, 2))
        return { data: 'ok' }
      },
    })
    const bashTool = createToolFixture(z.object({ command: z.string() }), {
      name: BASH_TOOL_NAME,
      async call() {
        started += 1
        await new Promise(resolve => setTimeout(resolve, 2))
        return { data: 'ok' }
      },
    })
    const runner = createRunner([writeTool, bashTool], {
      caps: { maxConcurrentCalls: 1, maxTotalCalls: 100, maxMutationCalls: 100, maxShellCalls: 100 },
    })
    let execution
    try {
      execution = await executeQuickJSScript({
        code: [
          "const chunk = 'x'.repeat(600 * 1024)",
          'const pending = []',
          'const errors = []',
          'for (let index = 0; index < 20; index++) {',
          '  const call = index % 2 === 0',
          '    ? Write({ file_path: `/tmp/repl-queued-${index}`, content: chunk })',
          '    : Bash({ command: chunk })',
          '  pending.push(call.then(',
          "    () => 'ok',",
          "    error => { errors.push(error.message); return 'rejected' },",
          '  ))',
          '}',
          'const outcomes = await Promise.all(pending)',
          "return { accepted: outcomes.filter(outcome => outcome === 'ok').length, errors: errors.length, firstError: errors[0] || '' }",
        ].join('\n'),
        hostFunctions: runner.createHostFunctions(),
      })
    } finally {
      runner.dispose()
    }
    expect(execution.status).toBe('completed')
    const outcome = execution.result as { accepted: number; errors: number; firstError: string }
    expect(outcome.errors).toBeGreaterThan(0)
    expect(outcome.firstError).toContain('per-script serialized input budget')
    expect(outcome.accepted).toBe(started)
    expect(started).toBeLessThan(20)
    expect(started + outcome.errors).toBe(20)
  })

  test('bounds large attachment arrays in input provenance redaction', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ command: z.string() }), {
      name: BASH_TOOL_NAME,
      async call() { return { data: 'ok' } },
    })
    const runner = createRunner([tool], {
      onVirtualMessage: message => messages.push(message),
    })
    const payload = 'a'.repeat(1_000)
    const attachments = Array.from({ length: 5_000 }, () => ({
      type: 'image',
      mimeType: 'image/png',
      data: payload,
    }))
    await runner.callTool(BASH_TOOL_NAME, { command: 'echo ok', attachments })
    const assistant = messages.find(message => message.type === 'assistant')
    const block = assistant?.message.content[0] as { input?: { attachments?: unknown[] } }
    const items = block.input?.attachments ?? []
    expect(items).toHaveLength(51)
    expect((items[0] as { data?: string }).data).toBe('[attachment payload omitted from REPL result]')
    expect(String(items[50])).toContain('truncated')
    expect(JSON.stringify(block.input)).not.toContain(payload)
  })

  test('rejects background execution introduced by permission input rewriting', async () => {
    resetDoomLoop()
    let called = false
    const tool = createToolFixture(z.object({ command: z.string(), run_in_background: z.boolean().optional() }), {
      name: BASH_TOOL_NAME,
      async call() {
        called = true
        return { data: 'bad' }
      },
    })
    const rewriteCanUseTool: CanUseToolFn = async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: { ...(input as Record<string, unknown>), run_in_background: true },
    })
    const runner = createRunner([tool], { canUseTool: rewriteCanUseTool })
    await expect(runner.callTool(BASH_TOOL_NAME, { command: 'sleep 10' })).rejects.toThrow('run_in_background is unavailable')
    expect(called).toBe(false)
  })

  test('serializes execution when permission input rewriting escalates the lane requirement', async () => {
    resetDoomLoop()
    let active = 0
    let maxActive = 0
    const tool = createToolFixture(z.object({ value: z.string(), mode: z.string().optional() }), {
      name: 'LaneEscalationFixture',
      isReadOnly: () => true,
      isConcurrencySafe: input => input.mode !== 'write',
      async call(input) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active -= 1
        return { data: input.mode ?? 'none' }
      },
    })
    const rewriteCanUseTool: CanUseToolFn = async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: { ...(input as Record<string, unknown>), mode: 'write' },
    })
    const runner = createRunner([tool], { canUseTool: rewriteCanUseTool })
    try {
      await expect(Promise.all([
        runner.callTool('LaneEscalationFixture', { value: 'one' }),
        runner.callTool('LaneEscalationFixture', { value: 'two' }),
      ])).resolves.toEqual(['write', 'write'])
      expect(maxActive).toBe(1)
    } finally {
      runner.dispose()
    }
  })

  test('charges the mutation budget when permission input rewriting escalates a read-only call', async () => {
    resetDoomLoop()
    const tool = createToolFixture(z.object({ mode: z.string().optional() }), {
      name: 'MutationEscalationFixture',
      isReadOnly: input => input.mode !== 'write',
      isConcurrencySafe: () => true,
      async call() {
        return { data: 'ok' }
      },
    })
    const rewriteCanUseTool: CanUseToolFn = async (_tool, input) => ({
      behavior: 'allow',
      updatedInput: { ...(input as Record<string, unknown>), mode: 'write' },
    })
    const runner = createRunner([tool], {
      canUseTool: rewriteCanUseTool,
      caps: { maxTotalCalls: 10, maxMutationCalls: 1 },
    })
    try {
      await expect(runner.callTool('MutationEscalationFixture', {})).resolves.toBe('ok')
      // The rewritten first call must have consumed the single mutation slot,
      // so this direct mutation exceeds the cap before it can execute.
      await expect(runner.callTool('MutationEscalationFixture', { mode: 'write' })).rejects.toThrow('mutation call cap')
    } finally {
      runner.dispose()
    }
  })

  test('applies mutation budget charging to passthrough hook input rewrites', async () => {
    resetDoomLoop()
    let calls = 0
    const tool = createToolFixture(z.object({ value: z.string(), mode: z.string().optional() }), {
      name: 'PassthroughRewriteFixture',
      isReadOnly: input => input.mode !== 'write',
      isConcurrencySafe: () => true,
      async call() {
        calls += 1
        return { data: 'ok' }
      },
    })
    const hookOutputJson = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { value: 'x', mode: 'write' },
      },
    })
    const sessionHooks = new Map([
      [
        getSessionId(),
        {
          hooks: {
            PreToolUse: [
              {
                matcher: 'PassthroughRewriteFixture',
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
    ]) as Map<string, unknown>
    const runner = createRunner([tool], {
      caps: { maxTotalCalls: 10, maxMutationCalls: 0 },
      sessionHooks,
    })
    try {
      // The passthrough rewrite escalates the call to a mutation; with zero
      // mutation budget the call must be rejected before executing.
      await expect(runner.callTool('PassthroughRewriteFixture', { value: 'x' })).rejects.toThrow('mutation call cap')
      expect(calls).toBe(0)
    } finally {
      runner.dispose()
    }
  })

  test('bounds maximal fanout virtual provenance and preserves elision audit metadata', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'FanoutMutation',
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      maxResultSizeChars: 100_000,
      async call(input) {
        if (input.value.includes('error-me')) {
          throw new Error(`mutation failed ${'e'.repeat(4_000)}`)
        }
        return { data: `result:${input.value}` }
      },
    })
    const runner = createRunner([tool], {
      caps: { maxTotalCalls: 100, maxMutationCalls: 100 },
      onVirtualMessage: message => messages.push(message),
    })
    try {
      await Promise.allSettled(Array.from({ length: 100 }, (_, index) =>
        runner.callTool('FanoutMutation', {
          value: `${index}:${index % 3 === 0 ? 'error-me' : 'ok'}:${'x'.repeat(4_000)}`,
        }),
      ))
    } finally {
      runner.dispose()
    }

    const serializedBytes = messages.reduce(
      (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), 'utf8'),
      0,
    )
    expect(serializedBytes).toBeLessThanOrEqual(DEFAULT_REPL_PROVENANCE_BUDGET_BYTES)
    expect(messages.filter(message => message.type === 'assistant').length).toBeLessThan(100)

    const summary = messages.find(message =>
      message.type === 'system' &&
      (message as { replProvenanceElision?: unknown }).replProvenanceElision !== undefined,
    )
    expect(summary).toBeDefined()
    if (!summary) throw new Error('Expected provenance elision summary')
    const detail = (summary as unknown as {
      replProvenanceElision: {
        marker: string
        budgetBytes: number
        retainedBytes: number
        elidedMessages: number
        elidedBytes: number
        omittedEntries: number
      }
    }).replProvenanceElision
    expect(detail.marker).toBe('repl-provenance-elision-v1')
    expect(detail.budgetBytes).toBe(DEFAULT_REPL_PROVENANCE_BUDGET_BYTES)
    expect(detail.elidedMessages).toBeGreaterThan(0)
    expect(detail.elidedBytes).toBeGreaterThan(0)
    expect(detail.retainedBytes).toBeGreaterThan(0)

    const content = String((summary as { content?: unknown }).content)
    expect(content).toContain('REPL virtual provenance elided')
    expect(content).toContain('aggregate budget')
    expect(content).toMatch(/repl_tool_[0-9a-f-]+ use FanoutMutation mutation/)
    expect(content).toMatch(/repl_tool_[0-9a-f-]+ result FanoutMutation mutation error/)
    expect(content).toContain('input=')
  })

  test('releases the concurrency slot when concurrency safety classification throws', async () => {
    resetDoomLoop()
    let classifications = 0
    const tool = createToolFixture(z.object({}), {
      name: 'ThrowingClassificationFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => {
        classifications += 1
        if (classifications === 1) throw new Error('classification exploded')
        return true
      },
      async call() { return { data: 'ok' } },
    })
    const runner = createRunner([tool], { caps: { maxConcurrentCalls: 1 } })
    try {
      await expect(runner.callTool('ThrowingClassificationFixture', {})).rejects.toThrow('classification exploded')
      const second = runner.callTool('ThrowingClassificationFixture', {})
      const outcome = await Promise.race([
        second.then(() => 'resolved', () => 'rejected'),
        new Promise(resolve => setTimeout(() => resolve('timeout'), 500)),
      ])
      expect(outcome).toBe('resolved')
    } finally {
      runner.dispose()
    }
  })

  test('publishes a complete provenance elision marker on the first elision', async () => {
    resetDoomLoop()
    const snapshots: Array<Record<string, unknown>> = []
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'ElisionPublishFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) { return { data: `result:${input.value.length}` } },
    })
    const runner = createRunner([tool], {
      caps: { maxProvenanceBytes: 4_096 },
      onVirtualMessage: message => snapshots.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>),
    })
    try {
      await runner.callTool('ElisionPublishFixture', { value: 'x'.repeat(4_000) })
    } finally {
      runner.dispose()
    }
    const marker = snapshots.find(snapshot => snapshot.type === 'system')
    expect(marker).toBeDefined()
    if (!marker) throw new Error('Expected published elision marker snapshot')
    expect(String(marker.content)).toContain('REPL virtual provenance elided')
    expect(marker.replProvenanceElision).toBeDefined()
  })

  test('keeps the encoded elision marker within the summary reserve or omits it', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'ElisionSizeFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) { return { data: `result:${input.value.length}` } },
    })
    const budgetBytes = 4_096
    // Mirror of the budget split contract: the summary reserve is one eighth
    // of the budget, floored at 256 and capped at 32k (and at the budget).
    const reserveBytes = Math.min(
      budgetBytes,
      Math.min(32 * 1024, Math.max(256, Math.floor(budgetBytes / 8))),
    )
    const runner = createRunner([tool], {
      caps: { maxProvenanceBytes: budgetBytes },
      onVirtualMessage: message => messages.push(message),
    })
    try {
      await Promise.allSettled(Array.from({ length: 4 }, (_, index) =>
        runner.callTool('ElisionSizeFixture', { value: `${index}:${'x'.repeat(4_000)}` }),
      ))
    } finally {
      runner.dispose()
    }
    const marker = messages.find(message => message.type === 'system')
    if (marker) {
      const markerBytes = Buffer.byteLength(JSON.stringify(marker), 'utf8')
      expect(markerBytes).toBeLessThanOrEqual(reserveBytes)
    }
    const serializedBytes = messages.reduce(
      (sum, message) => sum + Buffer.byteLength(JSON.stringify(message), 'utf8'),
      0,
    )
    expect(serializedBytes).toBeLessThanOrEqual(budgetBytes)
  })

  test('omits the elision marker entirely when even a minimal marker cannot fit the budget', async () => {
    resetDoomLoop()
    const messages: Message[] = []
    const tool = createToolFixture(z.object({ value: z.string() }), {
      name: 'ElisionOmitFixture',
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async call(input) { return { data: `result:${input.value.length}` } },
    })
    const runner = createRunner([tool], {
      caps: { maxProvenanceBytes: 256 },
      onVirtualMessage: message => messages.push(message),
    })
    try {
      await runner.callTool('ElisionOmitFixture', { value: 'x'.repeat(4_000) })
    } finally {
      runner.dispose()
    }
    const marker = messages.find(message =>
      message.type === 'system' ||
      (message as { replProvenanceElision?: unknown }).replProvenanceElision !== undefined,
    )
    expect(marker).toBeUndefined()
    expect(JSON.stringify(messages)).not.toContain('REPL virtual provenance elided')
  })

})
