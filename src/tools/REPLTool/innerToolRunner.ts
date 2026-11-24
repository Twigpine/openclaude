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
import { isLegalGuestIdentifier } from './toolWrappers.js'
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
  private readonly waiters: Array<() => void> = []

  private pump(): void {
    if (this.waiters.length === 0 || this.writerActive) return
    const next = this.waiters.shift()
    next?.()
  }

  acquireRead(): Promise<void> {
    if (!this.writerActive) {
      this.readers += 1
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.readers += 1
        resolve()
      })
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
      this.waiters.push(() => {
        this.writerActive = true
        resolve()
      })
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

function validateForegroundOnlyInput(tool: Tool, input: unknown): void {
  if (!isObjectInput(input)) return
  if ('run_in_background' in input) {
    throw new Error(`${tool.name} run_in_background is unavailable inside REPL foreground scripts`)
  }
  if (tool.name === 'Agent') {
    for (const key of ['team_name', 'mode', 'isolation', 'model'] as const) {
      if (input[key] !== undefined) {
        throw new Error(`Agent ${key} override is unavailable inside REPL foreground scripts`)
      }
    }
  }
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

/** Canonical inner execution bridge for one foreground REPL script. */
export class ReplInnerToolRunner {
  private readonly inventoryByName = new Map<string, Tool>()
  private readonly caps: ReplResourceCaps
  private readonly concurrency: Semaphore
  private readonly executionLane = new ReadWriteLock()
  private readonly childControllers = new Set<AbortController>()
  private readonly abortListener: () => void
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

  async callTool(toolName: string, input: unknown): Promise<unknown> {
    if (toolName === REPL_TOOL_NAME) throw new ReplToolUnavailableError(toolName)
    const tool = this.inventoryByName.get(toolName)
    if (!tool) throw new ReplToolUnavailableError(toolName)
    validateForegroundOnlyInput(tool, input)
    this.reserveBudget(tool, input)

    if (this.terminalError) throw this.terminalError
    await this.concurrency.acquire()
    const needsExclusiveLane = !tool.isConcurrencySafe(isObjectInput(input) ? input : {})
    if (needsExclusiveLane) {
      await this.executionLane.acquireWrite()
    } else {
      await this.executionLane.acquireRead()
    }
    try {
      if (this.terminalError) throw this.terminalError
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
    const tracker = this.options.promptWaitTracker
    return async (tool, input, context, assistantMessage, toolUseID, forceDecision) => {
      tracker.begin()
      try {
        const decision = await canUseTool(tool, input, context, assistantMessage, toolUseID, forceDecision)
        if (decision.behavior === 'ask' && !decision.rejectFeedback) {
          const error = new Error(`Permission for ${tool.name} was denied without feedback; terminating REPL script`)
          this.terminalError ??= error
          queueMicrotask(() => this.options.onTerminalFailure?.(error))
        }
        return decision
      } finally {
        tracker.end()
      }
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
        this.options.onVirtualMessage?.(message)
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
