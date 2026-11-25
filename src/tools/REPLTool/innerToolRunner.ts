import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'node:crypto'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import type { Message } from '../../types/message.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { serializeBridgeValue } from './serialization.js'
import type { PromptWaitTracker, QuickJSHostFunction } from './quickjsRuntime.js'
import { isLegalGuestIdentifier } from './guestIdentifiers.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { REPL_TOOL_NAME } from './constants.js'

export interface ReplResourceCaps {
  maxConcurrentCalls: number
  maxTotalCalls: number
  maxMutationCalls: number
  maxShellCalls: number
  maxAgentCalls: number
}

export const DEFAULT_REPL_RESOURCE_CAPS: ReplResourceCaps = {
  maxConcurrentCalls: 8,
  maxTotalCalls: 100,
  maxMutationCalls: 50,
  maxShellCalls: 25,
  maxAgentCalls: 5,
}

export interface ReplInnerToolRunnerOptions {
  inventory: Tools
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  promptWaitTracker: PromptWaitTracker
  caps?: Partial<ReplResourceCaps>
  onVirtualMessage?: (message: Message) => void
  onInnerToolUse?: (toolName: string) => void
  onProgress?: (message: Message) => void
  abortSignal?: AbortSignal
  onTerminalFailure?: (error: Error) => void
}

class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(count: number) {
    this.available = count
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.available += 1
    }
  }
}

class ReadWriteLock {
  private readers = 0
  private writerActive = false
  private readonly waiters: Array<{ kind: 'read' | 'write'; grant: () => void }> = []

  private pump(): void {
    if (this.waiters.length === 0 || this.writerActive || this.readers > 0) return
    if (this.waiters[0]?.kind === 'write') {
      const next = this.waiters.shift()
      this.writerActive = true
      next?.grant()
      return
    }
    while (this.waiters[0]?.kind === 'read') {
      const next = this.waiters.shift()
      this.readers += 1
      next?.grant()
    }
  }

  acquireRead(): Promise<void> {
    if (!this.writerActive && !this.waiters.some(waiter => waiter.kind === 'write')) {
      this.readers += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push({ kind: 'read', grant: resolve })
    })
  }

  releaseRead(): void {
    this.readers -= 1
    if (this.readers === 0) this.pump()
  }

  acquireWrite(): Promise<void> {
    if (!this.writerActive && this.readers === 0) {
      this.writerActive = true
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push({ kind: 'write', grant: resolve })
    })
  }

  releaseWrite(): void {
    this.writerActive = false
    this.pump()
  }
}

export class ReplToolUnavailableError extends Error {
  constructor(toolName: string) {
    super(`Tool unavailable in REPL: ${toolName}`)
    this.name = 'ReplToolUnavailableError'
  }
}

export class ReplResourceCapError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplResourceCapError'
  }
}

function isObjectInput(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function omitAttachmentPayloads(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => omitAttachmentPayloads(item, depth + 1))
  const input = value as Record<string, unknown>
  const type = typeof input.type === 'string' ? input.type : undefined
  const mimeType = typeof input.mimeType === 'string'
    ? input.mimeType
    : typeof input.mime_type === 'string'
      ? input.mime_type
      : undefined
  if (
    type === 'image' ||
    type === 'document' ||
    mimeType?.startsWith('image/') === true ||
    mimeType === 'application/pdf'
  ) {
    const out: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(input)) {
      if (key === 'data' || key === 'source' || key === 'content') {
        out[key] = '[attachment payload omitted from REPL result]'
      } else {
        out[key] = omitAttachmentPayloads(entryValue, depth + 1)
      }
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [key, entryValue] of Object.entries(input)) {
    out[key] = omitAttachmentPayloads(entryValue, depth + 1)
  }
  return out
}

const REPL_ERGONOMIC_ALIASES = new Map([
  ['Read', 'read'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['Bash', 'bash'],
  ['NotebookEdit', 'notebookEdit'],
  ['PowerShell', 'powerShell'],
  ['Agent', 'agent'],
])

function validateForegroundOnlyInput(tool: Tool, input: unknown): void {
  if (!isObjectInput(input)) return
  if ('run_in_background' in input) {
    throw new Error(`${tool.name} run_in_background is unavailable inside REPL foreground scripts`)
  }
  if (tool.name === 'Agent') {
    for (const key of ['name', 'team_name', 'mode', 'isolation', 'model'] as const) {
      if (input[key] !== undefined) {
        throw new Error(`Agent ${key} override is unavailable inside REPL foreground scripts`)
      }
    }
  }
}

function markInnerMessageVirtual(message: Message): Message {
  return message.isVirtual === true ? message : { ...message, isVirtual: true }
}


const PROVENANCE_MAX_STRING_CHARS = 4_000
const PROVENANCE_MAX_TOTAL_CHARS = 64_000
const PROVENANCE_MAX_NODES = 500
const PROVENANCE_MAX_DEPTH = 8
const PROVENANCE_MAX_ITEMS = 50

function capInnerMessageProvenance(message: Message): Message {
  return serializeBridgeValue(omitAttachmentPayloads(message), {
    maxStringLength: PROVENANCE_MAX_STRING_CHARS,
    maxTotalStringLength: PROVENANCE_MAX_TOTAL_CHARS,
    maxTotalNodes: PROVENANCE_MAX_NODES,
    maxDepth: PROVENANCE_MAX_DEPTH,
    maxArrayLength: PROVENANCE_MAX_ITEMS,
    maxObjectProperties: PROVENANCE_MAX_ITEMS,
  }) as Message
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(serializeBridgeValue(content))
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return String(block)
      const record = block as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (typeof record.content === 'string') return record.content
      return String(serializeBridgeValue(block))
    })
    .join('\n')
}

export class ReplInnerToolRunner {
  private readonly inventoryByName = new Map<string, Tool>()
  private readonly caps: ReplResourceCaps
  private readonly concurrency: Semaphore
  private readonly executionLane = new ReadWriteLock()
  private readonly childControllers = new Set<AbortController>()
  private readonly abortListener: () => void
  private readonly activeInvocations = new Set<Promise<unknown>>()
  private totalCalls = 0
  private mutationCalls = 0
  private shellCalls = 0
  private agentCalls = 0
  private aborted = false
  private terminalError: Error | undefined

  constructor(private readonly options: ReplInnerToolRunnerOptions) {
    for (const tool of options.inventory) this.inventoryByName.set(tool.name, tool)
    this.caps = { ...DEFAULT_REPL_RESOURCE_CAPS, ...options.caps }
    this.concurrency = new Semaphore(this.caps.maxConcurrentCalls)
    this.abortListener = () => this.abort(options.abortSignal?.reason)
    options.abortSignal?.addEventListener('abort', this.abortListener, { once: true })
  }

  createHostFunctions(): Record<string, QuickJSHostFunction> {
    const hostFunctions: Record<string, QuickJSHostFunction> = {}
    for (const tool of this.options.inventory) {
      if (!isLegalGuestIdentifier(tool.name)) continue
      hostFunctions[tool.name] = args => this.callTool(tool.name, args[0])
    }
    for (const tool of this.options.inventory) {
      const alias = REPL_ERGONOMIC_ALIASES.get(tool.name)
      if (!alias || hostFunctions[alias]) continue
      hostFunctions[alias] = args => this.callTool(tool.name, args[0])
    }
    hostFunctions.tool = args => {
      const name = args[0]
      if (typeof name !== 'string') throw new Error('tool(name, input) requires a string tool name')
      return this.callTool(name, args[1])
    }
    if (this.inventoryByName.has(BASH_TOOL_NAME)) {
      hostFunctions.$ = args => this.callTool(BASH_TOOL_NAME, args[0])
    }
    return hostFunctions
  }

  callTool(toolName: string, input: unknown): Promise<unknown> {
    const invocation = this.invokeTool(toolName, input)
    const tracked = invocation.finally(() => {
      this.activeInvocations.delete(tracked)
    })
    this.activeInvocations.add(tracked)
    return tracked
  }

  hasActiveInvocations(): boolean {
    return this.activeInvocations.size > 0
  }

  async quiesce(timeoutMs = 2_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.activeInvocations.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.activeInvocations]),
        new Promise(resolve => setTimeout(resolve, 25)),
      ])
    }
    return this.activeInvocations.size === 0
  }

  private async invokeTool(toolName: string, input: unknown): Promise<unknown> {
    if (toolName === REPL_TOOL_NAME) throw new ReplToolUnavailableError(toolName)
    const tool = this.inventoryByName.get(toolName)
    if (!tool) throw new ReplToolUnavailableError(toolName)
    validateForegroundOnlyInput(tool, input)
    this.reserveBudget(tool, input)

    if (this.terminalError) throw this.terminalError
    if (this.aborted) throw new Error('REPL execution aborted')
    await this.concurrency.acquire()
    const needsExclusiveLane = !tool.isConcurrencySafe(isObjectInput(input) ? input : {})
    if (needsExclusiveLane) {
      await this.executionLane.acquireWrite()
    } else {
      await this.executionLane.acquireRead()
    }
    try {
      if (this.terminalError) throw this.terminalError
      if (this.aborted) throw new Error('REPL execution aborted')
      return await this.executeCanonical(tool, input)
    } finally {
      if (needsExclusiveLane) {
        this.executionLane.releaseWrite()
      } else {
        this.executionLane.releaseRead()
      }
      this.concurrency.release()
    }
  }

  abort(reason?: unknown): void {
    if (this.aborted) return
    this.aborted = true
    for (const controller of this.childControllers) controller.abort(reason)
  }

  dispose(): void {
    this.options.abortSignal?.removeEventListener('abort', this.abortListener)
    this.abort('REPL execution disposed')
  }

  private failTerminally(error: Error): Error {
    this.terminalError ??= error
    this.abort(error)
    return this.terminalError
  }

  private reserveBudget(tool: Tool, input: unknown): void {
    this.totalCalls += 1
    if (this.totalCalls > this.caps.maxTotalCalls) {
      throw this.failTerminally(new ReplResourceCapError(`REPL total inner call cap exceeded (${this.caps.maxTotalCalls})`))
    }
    const normalizedInput = isObjectInput(input) ? input : {}
    if (!tool.isReadOnly(normalizedInput)) {
      this.mutationCalls += 1
      if (this.mutationCalls > this.caps.maxMutationCalls) {
        throw this.failTerminally(new ReplResourceCapError(`REPL mutation call cap exceeded (${this.caps.maxMutationCalls})`))
      }
    }
    if (tool.name === BASH_TOOL_NAME || tool.name === POWERSHELL_TOOL_NAME) {
      this.shellCalls += 1
      if (this.shellCalls > this.caps.maxShellCalls) {
        throw this.failTerminally(new ReplResourceCapError(`REPL shell/process call cap exceeded (${this.caps.maxShellCalls})`))
      }
    }
    if (tool.name === 'Agent') {
      this.agentCalls += 1
      if (this.agentCalls > this.caps.maxAgentCalls) {
        throw this.failTerminally(new ReplResourceCapError(`REPL Agent call cap exceeded (${this.caps.maxAgentCalls})`))
      }
    }
  }

  private wrapCanUseTool(): CanUseToolFn {
    const canUseTool = this.options.canUseTool
    return async (tool, input, context, assistantMessage, toolUseID, forceDecision) => {
      const decision = await canUseTool(tool, input, context, assistantMessage, toolUseID, forceDecision)
      validateForegroundOnlyInput(tool, decision.behavior === 'deny' ? input : (decision.updatedInput ?? input))
      if (decision.behavior === 'ask' && !decision.rejectFeedback) {
        const error = new Error(`Permission for ${tool.name} was denied without feedback; terminating REPL script`)
        this.terminalError ??= error
        queueMicrotask(() => this.options.onTerminalFailure?.(error))
      }
      return decision
    }
  }

  private async executeCanonical(tool: Tool, input: unknown): Promise<unknown> {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: `repl_tool_${randomUUID()}`,
      name: tool.name,
      input: isObjectInput(input) ? input : {},
      caller: { type: 'direct' },
    }
    this.options.onInnerToolUse?.(tool.name)
    const assistantMessage = createAssistantMessage({
      content: [toolUse],
      isVirtual: true,
    })
    this.options.onVirtualMessage?.(assistantMessage)

    const childController = createChildAbortController(this.options.toolUseContext.abortController)
    this.childControllers.add(childController)
    if (this.aborted) childController.abort(this.terminalError ?? 'REPL execution aborted')

    const childContext: ToolUseContext = {
      ...this.options.toolUseContext,
      abortController: childController,
      replInnerExecution: true,
      replPromptWaitTracker: this.options.promptWaitTracker,
      options: {
        ...this.options.toolUseContext.options,
        tools: this.options.inventory,
      },
    }

    let result: unknown
    let resultText = ''
    let isError = false
    try {
      for await (const update of runToolUse(
        toolUse,
        assistantMessage,
        this.wrapCanUseTool(),
        childContext,
      )) {
        const message = update.message
        if (message.type === 'progress') {
          this.options.onProgress?.(message)
          continue
        }
        const virtualMessage = capInnerMessageProvenance(markInnerMessageVirtual(message))
        this.options.onVirtualMessage?.(virtualMessage)
        if (message.type !== 'user') continue
        const content = message.message.content
        if (Array.isArray(content)) {
          const block = content.find(item =>
            typeof item === 'object' && item !== null &&
            (item as { type?: string }).type === 'tool_result' &&
            (item as { tool_use_id?: string }).tool_use_id === toolUse.id,
          ) as { is_error?: boolean; content?: unknown } | undefined
          if (block) {
            isError = block.is_error === true
            resultText = extractTextFromToolResultContent(block.content)
          }
        }
        if (message.toolUseResult !== undefined) result = message.toolUseResult
        // Context modifiers are deliberately not replayed into later calls in v1.
        // Context-mutating tools are excluded from the inventory; if one appears
        // through an MCP or future seam, its modifier is suppressed rather than
        // changing permissions or memory outside this script transaction.
        void update.contextModifier
      }
    } finally {
      this.childControllers.delete(childController)
    }

    if (isError) throw new Error(resultText || `${tool.name} failed`)
    const serialized = serializeBridgeValue(omitAttachmentPayloads(result ?? resultText))
    return serialized
  }
}
