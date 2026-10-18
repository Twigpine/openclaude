import { normalizeAbortReason } from './abortReasons.js'

export type QueryTerminalReason =
  | 'ok'
  | 'query-timeout'
  | 'hard-max-query-timeout'
  | 'user-abort'
  | 'api-error'
  | 'tool-error'
  | 'budget-exhausted'
  | 'parent-ended'
  | 'unknown'

export type QueryGuardTimeoutReason = 'idle' | 'hard_max' | 'lease_expired'

export type QueryTerminalOutcome = 'aborted' | 'failed' | 'completed'

export type QueryActiveApiCall = {
  clientRequestId?: string
  requestId?: string | null
  model?: string
  querySource?: string
  startedAt: number
}

export type QueryActiveToolUse = {
  toolUseId: string
  toolName: string
  startedAt: number
  isBash?: boolean
  timeoutMs?: number
}

export type QueryActiveOperationSnapshot = {
  apiCalls: QueryActiveApiCall[]
  toolUses: QueryActiveToolUse[]
}

export type QueryLifecycleContext = {
  queryId: string
  queryGeneration: number
  querySource: string
  parentQueryId?: string
  subagentId?: string
  startedAt: number
  terminalReason?: QueryTerminalReason
  abortReason?: string
}

export type QueryGuardMetadata = {
  queryId: string
  querySource: string
  parentQueryId?: string
  subagentId?: string
  startedAt?: number
  getActiveOperations?: () => QueryActiveOperationSnapshot
}

export type QueryGuardStart = {
  generation: number
  context: QueryLifecycleContext
}

export type QueryGuardTimeoutInfo = {
  generation: number
  reason: QueryGuardTimeoutReason
  timeoutMs: number
  /** Monotonic milliseconds since query start; do not compare with context.startedAt. */
  elapsedMs: number
  context: QueryLifecycleContext
  activeOperations: QueryActiveOperationSnapshot
  causalEventId?: string
}

export function getQueryTerminalReason(
  signal: Pick<AbortSignal, 'aborted' | 'reason'>,
  didThrow: boolean,
): QueryTerminalReason {
  if (!signal.aborted) return didThrow ? 'unknown' : 'ok'
  switch (normalizeAbortReason(signal.reason)) {
    case 'query-timeout':
      return 'query-timeout'
    case 'hard-max-query-timeout':
      return 'hard-max-query-timeout'
    case 'user-abort':
    case 'interrupt':
      return 'user-abort'
    case 'background':
    case 'parent-ended':
    case 'side-task-cancelled':
    case 'agent-summary-superseded':
    case 'memory-extraction-superseded':
      return 'parent-ended'
    default:
      return 'unknown'
  }
}

export function getQueryTerminalOutcome(
  signal: Pick<AbortSignal, 'aborted'>,
  didThrow: boolean,
): QueryTerminalOutcome {
  if (signal.aborted) return 'aborted'
  return didThrow ? 'failed' : 'completed'
}

export function formatQueryLifecycleAbortSignalReason(reason: string): string {
  return `abortSignalReason=${reason}`
}

export function formatQueryLifecycleLogMessage(
  event: string,
  context: QueryLifecycleContext,
  extras = '',
): string {
  const parent = context.parentQueryId ? ` parentQueryId=${context.parentQueryId}` : ''
  const subagent = context.subagentId ? ` subagentId=${context.subagentId}` : ''
  const terminal = context.terminalReason ? ` terminalReason=${context.terminalReason}` : ''
  const abort = context.abortReason ? ` abortReason=${context.abortReason}` : ''
  return `query.${event} queryId=${context.queryId} generation=${context.queryGeneration} source=${context.querySource}${parent}${subagent}${terminal}${abort}${extras ? ` ${extras}` : ''}`
}

// Rebuild snapshots from an allowlist so debug logging cannot leak runtime extras.
function toSafeApiCallSnapshot(call: QueryActiveApiCall): QueryActiveApiCall {
  return {
    ...(call.clientRequestId !== undefined ? { clientRequestId: call.clientRequestId } : {}),
    ...(call.requestId !== undefined ? { requestId: call.requestId } : {}),
    ...(call.model !== undefined ? { model: call.model } : {}),
    ...(call.querySource !== undefined ? { querySource: call.querySource } : {}),
    startedAt: call.startedAt,
  }
}

function toDefinedApiCallUpdate(update: Partial<QueryActiveApiCall>): Partial<QueryActiveApiCall> {
  return {
    ...(update.clientRequestId !== undefined ? { clientRequestId: update.clientRequestId } : {}),
    ...(update.requestId !== undefined ? { requestId: update.requestId } : {}),
    ...(update.model !== undefined ? { model: update.model } : {}),
    ...(update.querySource !== undefined ? { querySource: update.querySource } : {}),
    ...(update.startedAt !== undefined ? { startedAt: update.startedAt } : {}),
  }
}

// Keep tool snapshots on the same explicit allowlist boundary as API calls.
function toSafeToolUseSnapshot(toolUse: QueryActiveToolUse): QueryActiveToolUse {
  return {
    toolUseId: toolUse.toolUseId,
    toolName: toolUse.toolName,
    startedAt: toolUse.startedAt,
    ...(toolUse.isBash !== undefined ? { isBash: toolUse.isBash } : {}),
    ...(toolUse.timeoutMs !== undefined ? { timeoutMs: toolUse.timeoutMs } : {}),
  }
}

export class QueryLifecycleOperationTracker {
  private apiCalls = new Map<string, QueryActiveApiCall>()
  private toolUses = new Map<string, QueryActiveToolUse>()
  private apiCallSeq = 0

  startApiCall(call: QueryActiveApiCall): string {
    const key = call.clientRequestId ?? call.requestId ?? `api-call-${++this.apiCallSeq}`
    this.apiCalls.set(key, toSafeApiCallSnapshot(call))
    return key
  }

  updateApiCall(key: string, update: Partial<QueryActiveApiCall>): void {
    const current = this.apiCalls.get(key)
    if (!current) return
    this.apiCalls.set(key, toSafeApiCallSnapshot({ ...current, ...toDefinedApiCallUpdate(update) }))
  }

  endApiCall(key: string): void {
    this.apiCalls.delete(key)
  }

  startToolUse(toolUse: QueryActiveToolUse): void {
    this.toolUses.set(toolUse.toolUseId, toSafeToolUseSnapshot(toolUse))
  }

  updateToolUse(toolUse: QueryActiveToolUse): void {
    if (!this.toolUses.has(toolUse.toolUseId)) return
    this.toolUses.set(toolUse.toolUseId, toSafeToolUseSnapshot(toolUse))
  }

  endToolUse(toolUseId: string): void {
    this.toolUses.delete(toolUseId)
  }

  clear(): void {
    this.apiCalls.clear()
    this.toolUses.clear()
  }

  snapshot(): QueryActiveOperationSnapshot {
    return {
      apiCalls: [...this.apiCalls.values()].map(toSafeApiCallSnapshot),
      toolUses: [...this.toolUses.values()].map(toSafeToolUseSnapshot),
    }
  }
}
