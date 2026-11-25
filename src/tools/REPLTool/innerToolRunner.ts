import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'node:crypto'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import type { Message } from '../../types/message.js'
import { createAssistantMessage } from '../../utils/messages.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { serializeBridgeValue } from './serialization.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { PromptWaitTracker, QuickJSHostFunction } from './quickjsRuntime.js'
import { isLegalGuestIdentifier } from './guestIdentifiers.js'
import { validateReplForegroundOnlyInput } from './foregroundValidation.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { REPL_ERGONOMIC_ALIASES, REPL_TOOL_NAME } from './constants.js'

export interface ReplResourceCaps {
  maxConcurrentCalls: number
  maxTotalCalls: number
  maxMutationCalls: number
  maxShellCalls: number
  maxAgentCalls: number
  /**
   * Aggregate UTF-8 byte budget for virtual audit messages emitted by one
   * REPL invocation. Part of the budget is reserved for a compact elision
   * summary so the transcript stays bounded even at maximal fanout.
   */
  maxProvenanceBytes: number
}

export const DEFAULT_REPL_PROVENANCE_BUDGET_BYTES = 256 * 1024

export const DEFAULT_REPL_RESOURCE_CAPS: ReplResourceCaps = {
  maxConcurrentCalls: 8,
  maxTotalCalls: 100,
  maxMutationCalls: 50,
  maxShellCalls: 25,
  maxAgentCalls: 5,
  maxProvenanceBytes: DEFAULT_REPL_PROVENANCE_BUDGET_BYTES,
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
  private readonly waiters: Array<{
    grant: () => void
    reject: (error: Error) => void
  }> = []

  constructor(count: number) {
    this.available = count
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ grant: resolve, reject })
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next.grant()
    } else {
      this.available += 1
    }
  }

  rejectPending(error: Error): void {
    const pending = this.waiters.splice(0)
    for (const waiter of pending) waiter.reject(error)
  }
}

class ReadWriteLock {
  private readers = 0
  private writerActive = false
  private readonly waiters: Array<{
    kind: 'read' | 'write'
    grant: () => void
    reject: (error: Error) => void
  }> = []

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
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'read', grant: resolve, reject })
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
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: 'write', grant: resolve, reject })
    })
  }

  releaseWrite(): void {
    this.writerActive = false
    this.pump()
  }

  rejectPending(error: Error): void {
    const pending = this.waiters.splice(0)
    for (const waiter of pending) waiter.reject(error)
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

const OMIT_ATTACHMENT_MAX_DEPTH = 8
const OMIT_ATTACHMENT_MAX_ITEMS = 200
const OMIT_ATTACHMENT_MAX_NODES = 2_000

interface OmitAttachmentState {
  nodes: number
  seen: WeakSet<object>
}

function omitAttachmentObjectEntries(
  input: Record<string, unknown>,
  state: OmitAttachmentState,
  depth: number,
  isAttachment: boolean,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let hasOmittedProperties = false
  let copiedProperties = 0
  for (const key in input) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    if (copiedProperties >= OMIT_ATTACHMENT_MAX_ITEMS) {
      hasOmittedProperties = true
      break
    }
    copiedProperties += 1
    const entryValue = input[key]
    if (
      isAttachment &&
      (key === 'data' || key === 'source' || key === 'content' || key === 'base64')
    ) {
      out[key] = '[attachment payload omitted from REPL result]'
    } else if (isAttachment && key === 'file' && typeof entryValue === 'object' && entryValue !== null) {
      out[key] = omitAttachmentFilePayloads(entryValue as Record<string, unknown>, state, depth + 1)
    } else {
      out[key] = omitAttachmentPayloads(entryValue, depth + 1, state)
    }
  }
  if (hasOmittedProperties) {
    out.__truncated__ = '1 or more properties omitted'
  }
  return out
}

function omitAttachmentFilePayloads(
  file: Record<string, unknown>,
  state: OmitAttachmentState,
  depth: number,
): unknown {
  if (state.nodes >= OMIT_ATTACHMENT_MAX_NODES) return '[SerializationBudget]'
  state.nodes += 1
  if (state.seen.has(file)) return '[Circular]'
  if (depth >= OMIT_ATTACHMENT_MAX_DEPTH) return '[MaxDepth]'
  state.seen.add(file)
  const out: Record<string, unknown> = {}
  let hasOmittedProperties = false
  let copiedProperties = 0
  for (const key in file) {
    if (!Object.prototype.hasOwnProperty.call(file, key)) continue
    if (copiedProperties >= OMIT_ATTACHMENT_MAX_ITEMS) {
      hasOmittedProperties = true
      break
    }
    copiedProperties += 1
    out[key] = key === 'base64'
      ? '[attachment payload omitted from REPL result]'
      : omitAttachmentPayloads(file[key], depth + 1, state)
  }
  if (hasOmittedProperties) {
    out.__truncated__ = '1 or more properties omitted'
  }
  return out
}

function omitAttachmentPayloads(
  value: unknown,
  depth = 0,
  state: OmitAttachmentState = { nodes: 0, seen: new WeakSet<object>() },
): unknown {
  if (value === null || typeof value !== 'object') return value
  if (state.nodes >= OMIT_ATTACHMENT_MAX_NODES) return '[SerializationBudget]'
  state.nodes += 1
  if (state.seen.has(value)) return '[Circular]'
  if (depth >= OMIT_ATTACHMENT_MAX_DEPTH) return '[MaxDepth]'
  state.seen.add(value)
  if (Array.isArray(value)) {
    const items = value
      .slice(0, OMIT_ATTACHMENT_MAX_ITEMS)
      .map(item => omitAttachmentPayloads(item, depth + 1, state))
    if (value.length > OMIT_ATTACHMENT_MAX_ITEMS) {
      items.push(`[truncated ${value.length - OMIT_ATTACHMENT_MAX_ITEMS} items]`)
    }
    return items
  }
  const input = value as Record<string, unknown>
  const type = typeof input.type === 'string' ? input.type : undefined
  const file = typeof input.file === 'object' && input.file !== null
    ? input.file as Record<string, unknown>
    : undefined
  const mimeType = typeof input.mimeType === 'string'
    ? input.mimeType
    : typeof input.mime_type === 'string'
      ? input.mime_type
      : typeof file?.type === 'string'
        ? file.type
        : undefined
  const isAttachment = type === 'image' ||
    type === 'document' ||
    type === 'pdf' ||
    mimeType?.startsWith('image/') === true ||
    mimeType === 'application/pdf'
  return omitAttachmentObjectEntries(input, state, depth, isAttachment)
}

function validateForegroundOnlyInput(tool: Tool, input: unknown): void {
  validateReplForegroundOnlyInput(tool.name, input)
}

function markInnerMessageVirtual(message: Message): Message {
  return message.isVirtual === true ? message : { ...message, isVirtual: true }
}


const PROVENANCE_MAX_STRING_CHARS = 4_000
const PROVENANCE_MAX_TOTAL_CHARS = 64_000
const PROVENANCE_MAX_NODES = 500
const PROVENANCE_MAX_DEPTH = 8
const PROVENANCE_MAX_ITEMS = 50

function capProvenanceString(
  value: string,
  state: { nodes: number; stringChars: number; seen: WeakSet<object> },
): string {
  const remaining = Math.max(0, PROVENANCE_MAX_TOTAL_CHARS - state.stringChars)
  const maxLength = Math.min(PROVENANCE_MAX_STRING_CHARS, remaining)
  const capped = value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`
  state.stringChars += capped.length
  return capped
}

function capProvenanceValue(
  value: unknown,
  state: { nodes: number; stringChars: number; seen: WeakSet<object> },
  depth = 0,
): unknown {
  if (state.nodes >= PROVENANCE_MAX_NODES) return '[SerializationBudget]'
  state.nodes += 1
  if (value === null || typeof value === 'undefined') return value
  if (typeof value === 'string') {
    return capProvenanceString(value, state)
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value !== 'object') return String(value)
  if (state.seen.has(value)) return '[Circular]'
  if (depth >= PROVENANCE_MAX_DEPTH) return '[MaxDepth]'
  state.seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, PROVENANCE_MAX_ITEMS).map(item =>
      capProvenanceValue(item, state, depth + 1),
    )
    if (value.length > PROVENANCE_MAX_ITEMS) {
      items.push(`[truncated ${value.length - PROVENANCE_MAX_ITEMS} items]`)
    }
    return items
  }
  const out: Record<string, unknown> = {}
  let hasOmittedProperties = false
  let copiedProperties = 0
  for (const key in value as Record<string, unknown>) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (copiedProperties >= PROVENANCE_MAX_ITEMS) {
      hasOmittedProperties = true
      break
    }
    copiedProperties += 1
    out[capProvenanceString(key, state)] = capProvenanceValue(
      (value as Record<string, unknown>)[key],
      state,
      depth + 1,
    )
  }
  if (hasOmittedProperties) {
    out.__truncated__ = '1 or more properties omitted'
  }
  return out
}

function capInnerMessageProvenance(message: Message): Message {
  return capProvenanceValue(omitAttachmentPayloads(message), {
    nodes: 0,
    stringChars: 0,
    seen: new WeakSet<object>(),
  }) as Message
}

const PROVENANCE_ELISION_RESERVE_MAX_BYTES = 32 * 1024
const PROVENANCE_ELISION_MAX_STORED_ENTRIES = 256
const PROVENANCE_EVIDENCE_CHARS = 140
const PROVENANCE_SUMMARY_STRUCTURE_BYTES = 512

function splitProvenanceBudget(maxBytes: number): {
  fullBytes: number
  summaryReserveBytes: number
} {
  const normalized = Math.max(1, Math.floor(maxBytes))
  const desiredReserve = Math.min(
    PROVENANCE_ELISION_RESERVE_MAX_BYTES,
    Math.max(256, Math.floor(normalized / 8)),
  )
  const summaryReserveBytes = Math.min(normalized, desiredReserve)
  return {
    fullBytes: normalized - summaryReserveBytes,
    summaryReserveBytes,
  }
}

function provenanceMessageBytes(message: Message): number {
  try {
    return Buffer.byteLength(jsonStringify(message) ?? '', 'utf8')
  } catch {
    return PROVENANCE_MAX_TOTAL_CHARS
  }
}

function escapedJsonStringBytes(value: string): number {
  const serialized = jsonStringify(value)
  return Math.max(0, Buffer.byteLength(serialized ?? '', 'utf8') - 2)
}

function compactEvidenceText(value: unknown, maxChars = PROVENANCE_EVIDENCE_CHARS): string {
  const serialized = typeof value === 'string'
    ? value
    : jsonStringify(value) ?? String(serializeBridgeValue(value))
  const compact = serialized.replace(/\s+/g, ' ').trim()
  return compact.length <= maxChars
    ? compact
    : `${compact.slice(0, maxChars)}... [truncated ${compact.length - maxChars} chars]`
}

interface ReplProvenanceElisionDetail {
  marker: 'repl-provenance-elision-v1'
  budgetBytes: number
  retainedBytes: number
  elidedMessages: number
  elidedBytes: number
  omittedEntries: number
}

interface ReplProvenanceElisionState {
  elidedMessages: number
  elidedBytes: number
  entries: Array<{ text: string; escapedBytes: number; isError: boolean }>
  entriesNotStored: number
  summaryMessage?: Message
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

interface ReplInvocationLaneState {
  lane: 'read' | 'write' | undefined
  lateMutationCharged: boolean
}

export class ReplInnerToolRunner {
  private readonly inventoryByName = new Map<string, Tool>()
  private readonly caps: ReplResourceCaps
  private readonly concurrency: Semaphore
  private readonly executionLane = new ReadWriteLock()
  private readonly childControllers = new Set<AbortController>()
  private readonly abortListener: () => void
  private readonly activeInvocations = new Set<Promise<unknown>>()
  private readonly toolNamesByUseId = new Map<string, string>()
  private readonly mutationByUseId = new Map<string, boolean>()
  private readonly provenanceFullBudgetBytes: number
  private readonly provenanceSummaryReserveBytes: number
  private readonly provenanceElision: ReplProvenanceElisionState = {
    elidedMessages: 0,
    elidedBytes: 0,
    entries: [],
    entriesNotStored: 0,
  }
  private provenanceBytesUsed = 0
  private totalCalls = 0
  private mutationCalls = 0
  private shellCalls = 0
  private agentCalls = 0
  private aborted = false
  private terminalError: Error | undefined

  constructor(private readonly options: ReplInnerToolRunnerOptions) {
    for (const tool of options.inventory) this.inventoryByName.set(tool.name, tool)
    this.caps = { ...DEFAULT_REPL_RESOURCE_CAPS, ...options.caps }
    const provenanceBudget = splitProvenanceBudget(this.caps.maxProvenanceBytes)
    this.provenanceFullBudgetBytes = provenanceBudget.fullBytes
    this.provenanceSummaryReserveBytes = provenanceBudget.summaryReserveBytes
    this.concurrency = new Semaphore(this.caps.maxConcurrentCalls)
    this.abortListener = () => this.abort(options.abortSignal?.reason)
    if (options.abortSignal?.aborted) {
      this.abort(options.abortSignal.reason)
    } else {
      options.abortSignal?.addEventListener('abort', this.abortListener, { once: true })
    }
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

  getActiveInvocationCount(): number {
    return this.activeInvocations.size
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
    // Lane state is per-invocation and mutable: permission decisions and
    // passthrough hooks can rewrite the input into one that needs the
    // exclusive lane, and wrapCanUseTool upgrades this lane before execution.
    const laneState: ReplInvocationLaneState = { lane: undefined, lateMutationCharged: false }
    try {
      // Classification can throw for provider or MCP tools; keep it inside the
      // try so the concurrency slot acquired above is always released.
      const needsExclusiveLane = !tool.isConcurrencySafe(isObjectInput(input) ? input : {})
      if (needsExclusiveLane) {
        await this.executionLane.acquireWrite()
        laneState.lane = 'write'
      } else {
        await this.executionLane.acquireRead()
        laneState.lane = 'read'
      }
      if (this.terminalError) throw this.terminalError
      if (this.aborted) throw new Error('REPL execution aborted')
      return await this.executeCanonical(tool, input, laneState)
    } finally {
      if (laneState.lane === 'write') {
        this.executionLane.releaseWrite()
      } else if (laneState.lane === 'read') {
        this.executionLane.releaseRead()
      }
      laneState.lane = undefined
      this.concurrency.release()
    }
  }

  abort(reason?: unknown): void {
    if (this.aborted) return
    this.aborted = true
    const error = this.terminalError ?? (reason instanceof Error ? reason : new Error('REPL execution aborted'))
    this.concurrency.rejectPending(error)
    this.executionLane.rejectPending(error)
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

  private wrapCanUseTool(
    originalInput: unknown,
    laneState: ReplInvocationLaneState,
  ): CanUseToolFn {
    const canUseTool = this.options.canUseTool
    return async (tool, input, context, assistantMessage, toolUseID, forceDecision) => {
      const decision = await canUseTool(tool, input, context, assistantMessage, toolUseID, forceDecision)
      const finalInput = decision.behavior === 'deny' ? input : (decision.updatedInput ?? input)
      validateForegroundOnlyInput(tool, finalInput)
      if (decision.behavior !== 'deny') {
        // `input` already carries passthrough-hook rewrites and
        // `decision.updatedInput` carries permission rewrites, so the final
        // input the tool will execute with can differ from the input the lane
        // reservation and mutation charge were based on.
        await this.reconcileFinalInputClassification(tool, originalInput, finalInput, laneState)
      }
      if (decision.behavior === 'ask' && !decision.rejectFeedback) {
        const error = new Error(`Permission for ${tool.name} was denied without feedback; terminating REPL script`)
        this.terminalError ??= error
        queueMicrotask(() => this.options.onTerminalFailure?.(error))
      }
      return decision
    }
  }

  private async reconcileFinalInputClassification(
    tool: Tool,
    originalInput: unknown,
    finalInput: unknown,
    laneState: ReplInvocationLaneState,
  ): Promise<void> {
    const normalizedOriginal = isObjectInput(originalInput) ? originalInput : {}
    const normalizedFinal = isObjectInput(finalInput) ? finalInput : {}
    const wasMutation = !tool.isReadOnly(normalizedOriginal)
    const isMutation = !tool.isReadOnly(normalizedFinal)
    if (isMutation && !wasMutation && !laneState.lateMutationCharged) {
      laneState.lateMutationCharged = true
      this.mutationCalls += 1
      if (this.mutationCalls > this.caps.maxMutationCalls) {
        throw this.failTerminally(new ReplResourceCapError(`REPL mutation call cap exceeded (${this.caps.maxMutationCalls})`))
      }
    }
    const wasConcurrencySafe = tool.isConcurrencySafe(normalizedOriginal)
    const isConcurrencySafe = tool.isConcurrencySafe(normalizedFinal)
    if (!isConcurrencySafe && wasConcurrencySafe && laneState.lane === 'read') {
      // Upgrade the lane before execution. The read lane is released before
      // waiting for write access so concurrent readers upgrading at the same
      // time cannot deadlock; the tool has not executed yet, so no execution
      // escapes serialization. Downgrades are not applied: holding the write
      // lane for a concurrency-safe final input is conservative.
      laneState.lane = undefined
      this.executionLane.releaseRead()
      await this.executionLane.acquireWrite()
      laneState.lane = 'write'
    }
  }

  private isMutationToolUse(toolName: string, input: unknown): boolean {
    const inventoryTool = this.inventoryByName.get(toolName)
    if (!inventoryTool) return false
    try {
      return !inventoryTool.isReadOnly(isObjectInput(input) ? input : {})
    } catch {
      return false
    }
  }

  private summarizeElidedVirtualMessage(message: Message, bytes: number): string {
    if (message.type === 'assistant' && Array.isArray(message.message.content)) {
      const toolUseBlock = message.message.content.find(block =>
        typeof block === 'object' && block !== null &&
        (block as { type?: string }).type === 'tool_use',
      ) as { id?: string; name?: string; input?: unknown } | undefined
      if (toolUseBlock?.id && toolUseBlock.name) {
        const mutation = this.isMutationToolUse(toolUseBlock.name, toolUseBlock.input)
        return `${toolUseBlock.id} use ${toolUseBlock.name}${mutation ? ' mutation' : ''} input=${compactEvidenceText(toolUseBlock.input)} (${bytes} bytes)`
      }
    }

    if (message.type === 'user' && Array.isArray(message.message.content)) {
      const resultBlock = message.message.content.find(block =>
        typeof block === 'object' && block !== null &&
        (block as { type?: string }).type === 'tool_result',
      ) as { tool_use_id?: string; is_error?: boolean; content?: unknown } | undefined
      if (resultBlock?.tool_use_id) {
        const toolName = this.toolNamesByUseId.get(resultBlock.tool_use_id) ?? 'unknown-tool'
        const mutation = this.mutationByUseId.get(resultBlock.tool_use_id) === true
        const isError = resultBlock.is_error === true
        const resultText = extractTextFromToolResultContent(resultBlock.content)
        const evidence = isError || mutation
          ? ` content=${compactEvidenceText(resultText || '[empty tool result]')}`
          : ''
        return `${resultBlock.tool_use_id} result ${toolName}${mutation ? ' mutation' : ''} ${isError ? 'error' : 'ok'}${evidence} (${bytes} bytes)`
      }
    }

    const toolUseID = 'toolUseID' in message && typeof message.toolUseID === 'string'
      ? ` toolUseID=${message.toolUseID}`
      : ''
    const subtype = 'subtype' in message && typeof message.subtype === 'string'
      ? ` ${message.subtype}`
      : ''
    const content = 'content' in message
      ? compactEvidenceText(message.content, 100)
      : '[no content field]'
    return `${message.type}${subtype}${toolUseID} content=${content} (${bytes} bytes)`
  }

  private measureElisionMarkerBytes(content: string, detail: ReplProvenanceElisionDetail): number {
    // UUID and ISO timestamp strings are fixed length, so measuring a
    // fixed-shape template matches the encoded size of the published message.
    const template = {
      type: 'system',
      subtype: 'informational',
      content,
      level: 'warning',
      isMeta: false,
      isVirtual: true,
      timestamp: '0000-00-00T00:00:00.000Z',
      uuid: '00000000-0000-0000-0000-000000000000',
      replProvenanceElision: detail,
    } as unknown as Message
    return provenanceMessageBytes(template)
  }

  private buildProvenanceElisionMarker(): {
    content: string
    detail: ReplProvenanceElisionDetail
  } | undefined {
    const prefix = [
      `REPL virtual provenance elided: ${this.provenanceElision.elidedMessages} messages `,
      `(${this.provenanceElision.elidedBytes} bytes) exceeded the aggregate budget `,
      `of ${this.caps.maxProvenanceBytes} bytes. Compact audit entries:`,
    ].join('')
    const orderedEntries = [...this.provenanceElision.entries].sort((left, right) =>
      Number(right.isError) - Number(left.isError),
    )
    const escapedPrefixBytes = escapedJsonStringBytes(prefix)
    const escapedNewlineBytes = escapedJsonStringBytes('\n')
    const escapedEntryPrefixSums = [0]
    for (const entry of orderedEntries) {
      escapedEntryPrefixSums.push(
        (escapedEntryPrefixSums.at(-1) ?? 0) + entry.escapedBytes,
      )
    }

    const summaryBytes = (entryCount: number): number => {
      const omittedEntries = this.provenanceElision.entriesNotStored +
        orderedEntries.length - entryCount
      const suffix = omittedEntries > 0
        ? `\n${omittedEntries} additional compact audit entries omitted to keep this marker bounded.`
        : ''
      const entrySeparatorBytes = entryCount > 0
        ? (entryCount - 1) * escapedNewlineBytes
        : 0
      return PROVENANCE_SUMMARY_STRUCTURE_BYTES +
        escapedPrefixBytes +
        escapedNewlineBytes +
        (escapedEntryPrefixSums[entryCount] ?? 0) +
        entrySeparatorBytes +
        escapedJsonStringBytes(suffix)
    }

    const omittedEntriesFor = (entryCount: number): number =>
      this.provenanceElision.entriesNotStored + orderedEntries.length - entryCount
    const buildContent = (entryCount: number): string => {
      const omittedEntries = omittedEntriesFor(entryCount)
      const suffix = omittedEntries > 0
        ? `\n${omittedEntries} additional compact audit entries omitted to keep this marker bounded.`
        : ''
      return `${prefix}\n${orderedEntries.slice(0, entryCount).map(entry => entry.text).join('\n')}${suffix}`
    }
    const buildDetail = (entryCount: number): ReplProvenanceElisionDetail => ({
      marker: 'repl-provenance-elision-v1',
      budgetBytes: this.caps.maxProvenanceBytes,
      retainedBytes: this.provenanceBytesUsed,
      elidedMessages: this.provenanceElision.elidedMessages,
      elidedBytes: this.provenanceElision.elidedBytes,
      omittedEntries: omittedEntriesFor(entryCount),
    })
    const encodedBytes = (entryCount: number): number =>
      this.measureElisionMarkerBytes(buildContent(entryCount), buildDetail(entryCount))

    // Entry strings are immutable once stored, so their escaped sizes can be
    // reused. The fixed envelope reserve covers message metadata and numeric
    // count growth while avoiding repeated serialization of the whole marker.
    let low = 0
    let high = orderedEntries.length
    let bestEntryCount = 0
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (summaryBytes(middle) <= this.provenanceSummaryReserveBytes) {
        bestEntryCount = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    // The estimator prices the envelope with a fixed structure reserve, so
    // verify the real encoded marker size and trim any entries that push it
    // over the summary budget.
    while (bestEntryCount > 0 && encodedBytes(bestEntryCount) > this.provenanceSummaryReserveBytes) {
      bestEntryCount -= 1
    }
    if (encodedBytes(bestEntryCount) <= this.provenanceSummaryReserveBytes) {
      return { content: buildContent(bestEntryCount), detail: buildDetail(bestEntryCount) }
    }

    // Even an empty full marker exceeds the reserve. Fall back to a minimal
    // single-line representation, or omit the marker entirely when the
    // configured budget cannot hold even that.
    const compactContent = [
      `REPL virtual provenance elided: ${this.provenanceElision.elidedMessages} messages `,
      `(${this.provenanceElision.elidedBytes} bytes) exceeded the aggregate budget `,
      `of ${this.caps.maxProvenanceBytes} bytes.`,
    ].join('')
    const compactDetail = buildDetail(0)
    if (this.measureElisionMarkerBytes(compactContent, compactDetail) <= this.provenanceSummaryReserveBytes) {
      return { content: compactContent, detail: compactDetail }
    }
    return undefined
  }

  private rebuildProvenanceElisionSummary(): void {
    const summaryMessage = this.provenanceElision.summaryMessage
    if (!summaryMessage) return
    // Counts only grow after publication; when the marker no longer fits, the
    // last bounded content is kept rather than exceeding the reserve.
    const marker = this.buildProvenanceElisionMarker()
    if (!marker) return
    const mutableSummary = summaryMessage as unknown as Record<string, unknown>
    mutableSummary.content = marker.content
    mutableSummary.replProvenanceElision = marker.detail
  }

  private recordProvenanceElision(message: Message, bytes: number): void {
    this.provenanceElision.elidedMessages += 1
    this.provenanceElision.elidedBytes += bytes
    const entry = this.summarizeElidedVirtualMessage(message, bytes)
    const isError = message.type === 'user' && Array.isArray(message.message.content) &&
      message.message.content.some(block =>
        typeof block === 'object' && block !== null &&
        (block as { type?: string }).type === 'tool_result' &&
        (block as { is_error?: boolean }).is_error === true,
      )
    if (this.provenanceElision.entries.length < PROVENANCE_ELISION_MAX_STORED_ENTRIES) {
      this.provenanceElision.entries.push({
        text: entry,
        escapedBytes: escapedJsonStringBytes(entry),
        isError,
      })
    } else {
      this.provenanceElision.entriesNotStored += 1
    }

    if (!this.provenanceElision.summaryMessage) {
      // Build the complete marker before publishing so consumers that copy or
      // serialize the message at emission time never see a partial record.
      const marker = this.buildProvenanceElisionMarker()
      if (!marker) return
      const summaryMessage = {
        type: 'system',
        subtype: 'informational',
        content: marker.content,
        level: 'warning',
        isMeta: false,
        isVirtual: true,
        timestamp: new Date().toISOString(),
        uuid: randomUUID(),
        replProvenanceElision: marker.detail,
      } as Message
      this.provenanceElision.summaryMessage = summaryMessage
      this.options.onVirtualMessage?.(summaryMessage)
      return
    }
    this.rebuildProvenanceElisionSummary()
  }

  private emitVirtualMessage(message: Message): void {
    const capped = capInnerMessageProvenance(message)
    const bytes = provenanceMessageBytes(capped)
    if (this.provenanceBytesUsed + bytes <= this.provenanceFullBudgetBytes) {
      this.provenanceBytesUsed += bytes
      this.options.onVirtualMessage?.(capped)
      if (this.provenanceElision.summaryMessage) {
        this.rebuildProvenanceElisionSummary()
      }
      return
    }
    this.recordProvenanceElision(capped, bytes)
  }

  private async executeCanonical(
    tool: Tool,
    input: unknown,
    laneState: ReplInvocationLaneState,
  ): Promise<unknown> {
    const toolUse: ToolUseBlock = {
      type: 'tool_use',
      id: `repl_tool_${randomUUID()}`,
      name: tool.name,
      input: isObjectInput(input) ? input : {},
      caller: { type: 'direct' },
    }
    this.options.onInnerToolUse?.(tool.name)
    this.toolNamesByUseId.set(toolUse.id, tool.name)
    this.mutationByUseId.set(toolUse.id, this.isMutationToolUse(tool.name, toolUse.input))
    const assistantMessage = createAssistantMessage({
      content: [toolUse],
      isVirtual: true,
    })
    this.emitVirtualMessage(assistantMessage)

    const childController = createChildAbortController(this.options.toolUseContext.abortController)
    this.childControllers.add(childController)
    if (this.aborted) childController.abort(this.terminalError ?? 'REPL execution aborted')

    const runner = this
    const executionTool = new Proxy(tool, {
      get(target, property, receiver) {
        if (property !== 'call') return Reflect.get(target, property, receiver)
        const originalCall = target.call.bind(target)
        return async (
          finalInput: unknown,
          context: ToolUseContext,
          canUseTool: CanUseToolFn,
          parentMessage: typeof assistantMessage,
          onProgress?: Parameters<Tool['call']>[4],
        ) => {
          validateForegroundOnlyInput(target, finalInput)
          await runner.reconcileFinalInputClassification(target, input, finalInput, laneState)
          return originalCall(
            finalInput as never,
            context,
            canUseTool,
            parentMessage,
            onProgress,
          )
        }
      },
    }) as Tool

    const childContext: ToolUseContext = {
      ...this.options.toolUseContext,
      abortController: childController,
      replInnerExecution: true,
      replPromptWaitTracker: this.options.promptWaitTracker,
      options: {
        ...this.options.toolUseContext.options,
        tools: this.options.inventory.map(candidate => candidate === tool ? executionTool : candidate),
      },
    }

    let result: unknown
    let resultText = ''
    let isError = false
    try {
      for await (const update of runToolUse(
        toolUse,
        assistantMessage,
        this.wrapCanUseTool(input, laneState),
        childContext,
      )) {
        const message = update.message
        if (message.type === 'progress') {
          this.options.onProgress?.({
            ...message,
            data: {
              ...message.data,
              replInnerToolName: this.toolNamesByUseId.get(message.parentToolUseID),
            },
          })
          continue
        }
        this.emitVirtualMessage(markInnerMessageVirtual(message))
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
