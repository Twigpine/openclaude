import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'

import type { AttachmentMessage, UserMessage } from '../types/message.js'
import { getMissingToolResultAbortMessage } from '../utils/abortReasons.js'

const DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD = 3
const MAX_FALLBACK_CATEGORY_LENGTH = 120
// Parent-query aborts are synthetic cleanup results, not tool failures.
// Deliberately exclude tool-timeout: that is the tool's own failure mode.
const SYNTHETIC_ABORT_TOOL_RESULT_PREFIXES = [
  getMissingToolResultAbortMessage('interrupt'),
  getMissingToolResultAbortMessage('query-timeout'),
  getMissingToolResultAbortMessage('hard-max-query-timeout'),
  getMissingToolResultAbortMessage('background'),
  getMissingToolResultAbortMessage('side-task-cancelled'),
  getMissingToolResultAbortMessage('agent-summary-superseded'),
  getMissingToolResultAbortMessage('memory-extraction-superseded'),
  getMissingToolResultAbortMessage('parent-ended'),
  getMissingToolResultAbortMessage('unknown-abort'),
].map(message => message.toLowerCase())

export type ToolFailureLoopGuardState = {
  persistentSignatureCounts: Map<string, number>
  signatureCounts: Map<string, number>
  categoryCounts: Map<string, number>
  pathCounts: Map<string, number>
}

type ToolFailureLoopGuardAdvisory = {
  message: string
  threshold: number
  toolName: string
  errorCategory: string
}

export type ToolFailureLoopGuardDecision =
  | { tripped: false; advisories?: undefined }
  | {
      tripped: false
      advisories: ToolFailureLoopGuardAdvisory[]
    }
  | {
      tripped: true
      message: string
      threshold: number
      kind: 'signature' | 'category' | 'path'
      toolName?: string
      errorCategory?: string
      path?: string
    }

export function createToolFailureLoopGuardState(): ToolFailureLoopGuardState {
  return {
    persistentSignatureCounts: new Map(),
    signatureCounts: new Map(),
    categoryCounts: new Map(),
    pathCounts: new Map(),
  }
}

export function getToolFailureLoopThreshold(
  value = process.env.CLAUDE_CODE_TOOL_FAILURE_LOOP_THRESHOLD,
): number {
  if (value === undefined) {
    return DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD
  }

  const trimmed = value.trim()
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD
  }

  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed)
    ? parsed
    : DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD
}

export function updateToolFailureLoopGuard(params: {
  state: ToolFailureLoopGuardState
  toolUseBlocks: ToolUseBlock[]
  toolResults: (UserMessage | AttachmentMessage)[]
  threshold?: number
}): ToolFailureLoopGuardDecision {
  const threshold = normalizeThreshold(params.threshold)
  if (threshold === 0) {
    return { tripped: false }
  }

  const toolUseById = new Map(
    params.toolUseBlocks.map(block => [block.id, block]),
  )
  const failures: FailureInfo[] = []
  let hasSuccess = false
  const successfulToolNames = new Set<string>()
  const successfulMutationPaths = new Set<string>()

  for (const block of getToolResultBlocks(params.toolResults)) {
    const content = toolResultContentToString(block.content)
    const toolUse = toolUseById.get(String(block.tool_use_id ?? ''))

    if (block.is_error !== true) {
      hasSuccess = true
      if (toolUse?.name) {
        successfulToolNames.add(toolUse.name)
      }
      if (toolUse && isMutatingFileTool(toolUse.name)) {
        const path = extractNormalizedPath(toolUse.input)
        if (path) {
          successfulMutationPaths.add(path)
        }
      }
      continue
    }

    if (
      block.isAgentStepLimitToolResult ||
      isIgnoredSyntheticToolResult(content)
    ) {
      continue
    }

    const toolName = toolUse?.name ?? 'unknown'
    const errorCategory = normalizeErrorCategory(content)
    failures.push({
      toolName,
      errorCategory,
      path: extractNormalizedPath(toolUse?.input),
    })
  }

  for (const toolName of successfulToolNames) {
    resetPersistentToolSignatures(params.state, toolName)
  }

  // Parallel failures in one model turn must only count once per key so the
  // model can observe the batch and adapt. Cross-turn accumulation still trips.
  const seenPersistentSignatures = new Set<string>()
  const seenPaths = new Set<string>()
  const seenSignatures = new Set<string>()
  const seenCategories = new Set<string>()

  const advisories: ToolFailureLoopGuardAdvisory[] = []
  for (const failure of failures) {
    const persistentSignature = `${failure.toolName}\0${failure.errorCategory}`
    const isNewPersistentSignature = !seenPersistentSignatures.has(
      persistentSignature,
    )
    const persistentSignatureCount = incrementCounterOnce(
      params.state.persistentSignatureCounts,
      persistentSignature,
      seenPersistentSignatures,
    )

    if (persistentSignatureCount >= threshold) {
      return {
        tripped: true,
        kind: 'signature',
        threshold,
        toolName: failure.toolName,
        errorCategory: failure.errorCategory,
        message: createTripMessage({
          kind: 'signature',
          threshold,
          toolName: failure.toolName,
          errorCategory: failure.errorCategory,
        }),
      }
    }

    if (
      isNewPersistentSignature &&
      threshold > 1 &&
      persistentSignatureCount === threshold - 1
    ) {
      advisories.push({
        threshold,
        toolName: failure.toolName,
        errorCategory: failure.errorCategory,
        message: createAdvisoryMessage({
          threshold,
          toolName: failure.toolName,
          errorCategory: failure.errorCategory,
        }),
      })
    }
  }

  for (const failure of failures) {
    if (!failure.path || successfulMutationPaths.has(failure.path)) {
      continue
    }

    const pathCount = incrementCounterOnce(
      params.state.pathCounts,
      failure.path,
      seenPaths,
    )
    if (pathCount >= threshold) {
      return {
        tripped: true,
        kind: 'path',
        threshold,
        path: failure.path,
        message: createTripMessage({
          kind: 'path',
          threshold,
          path: failure.path,
        }),
      }
    }
  }

  if (hasSuccess) {
    resetToolFailureLoopGuard(params.state, successfulMutationPaths)
    return advisories.length > 0
      ? { tripped: false, advisories }
      : { tripped: false }
  }

  for (const failure of failures) {
    const signature = `${failure.toolName}\0${failure.errorCategory}`
    const signatureCount = incrementCounterOnce(
      params.state.signatureCounts,
      signature,
      seenSignatures,
    )
    const categoryCount = incrementCounterOnce(
      params.state.categoryCounts,
      failure.errorCategory,
      seenCategories,
    )
    if (signatureCount >= threshold) {
      return {
        tripped: true,
        kind: 'signature',
        threshold,
        toolName: failure.toolName,
        errorCategory: failure.errorCategory,
        message: createTripMessage({
          kind: 'signature',
          threshold,
          toolName: failure.toolName,
          errorCategory: failure.errorCategory,
        }),
      }
    }

    if (categoryCount >= threshold) {
      return {
        tripped: true,
        kind: 'category',
        threshold,
        errorCategory: failure.errorCategory,
        message: createTripMessage({
          kind: 'category',
          threshold,
          errorCategory: failure.errorCategory,
        }),
      }
    }
  }

  return advisories.length > 0
    ? { tripped: false, advisories }
    : { tripped: false }
}

type ToolResultBlockLike = {
  type: 'tool_result'
  tool_use_id?: unknown
  content?: unknown
  is_error?: unknown
  isAgentStepLimitToolResult?: boolean
}

type FailureInfo = {
  toolName: string
  errorCategory: string
  path: string | undefined
}

function normalizeThreshold(threshold: number | undefined): number {
  if (threshold === undefined) {
    return getToolFailureLoopThreshold()
  }
  if (!Number.isSafeInteger(threshold) || threshold < 0) {
    return DEFAULT_TOOL_FAILURE_LOOP_THRESHOLD
  }
  return threshold
}

function resetToolFailureLoopGuard(
  state: ToolFailureLoopGuardState,
  successfulMutationPaths: Set<string>,
): void {
  state.signatureCounts.clear()
  state.categoryCounts.clear()
  for (const path of successfulMutationPaths) {
    state.pathCounts.delete(path)
  }
}

function resetPersistentToolSignatures(
  state: ToolFailureLoopGuardState,
  toolName: string,
): void {
  const prefix = `${toolName}\0`
  for (const key of state.persistentSignatureCounts.keys()) {
    if (key.startsWith(prefix)) {
      state.persistentSignatureCounts.delete(key)
    }
  }
}

function isMutatingFileTool(toolName: string): boolean {
  return (
    toolName === 'Edit' ||
    toolName === 'MultiEdit' ||
    toolName === 'Write' ||
    toolName === 'NotebookEdit'
  )
}

function getToolResultBlocks(
  messages: (UserMessage | AttachmentMessage)[],
): ToolResultBlockLike[] {
  const blocks: ToolResultBlockLike[] = []

  for (const message of messages) {
    if (message?.type !== 'user' || !Array.isArray(message.message?.content)) {
      continue
    }

    for (const block of message.message.content) {
      if (isToolResultBlock(block)) {
        blocks.push({
          ...block,
          isAgentStepLimitToolResult: message.isAgentStepLimitToolResult,
        })
      }
    }
  }

  return blocks
}

function isToolResultBlock(block: unknown): block is ToolResultBlockLike {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'tool_result'
  )
}

function toolResultContentToString(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map(toolResultContentToString).join(' ')
  }

  if (typeof content === 'object' && content !== null) {
    const block = content as { text?: unknown; content?: unknown }
    if (block.text !== undefined) {
      return toolResultContentToString(block.text)
    }
    if (block.content !== undefined) {
      return toolResultContentToString(block.content)
    }
  }

  if (content === undefined || content === null) {
    return ''
  }

  return String(content)
}

function isIgnoredSyntheticToolResult(content: string): boolean {
  const normalized = normalizeToolResultText(content).toLowerCase()
  const unbracketed = normalized.replace(/^\[(.*)\]$/, '$1').trim()
  const withoutErrorPrefix = unbracketed.replace(/^error:\s*/, '').trim()

  return (
    withoutErrorPrefix === 'interrupted by user' ||
    withoutErrorPrefix.startsWith('request interrupted by user') ||
    withoutErrorPrefix === 'user rejected tool use' ||
    withoutErrorPrefix.startsWith(
      "the user doesn't want to proceed with this tool use",
    ) ||
    withoutErrorPrefix.startsWith(
      "the user doesn't want to take this action right now",
    ) ||
    SYNTHETIC_ABORT_TOOL_RESULT_PREFIXES.some(prefix =>
      withoutErrorPrefix.startsWith(prefix),
    ) ||
    withoutErrorPrefix === 'streaming fallback - tool execution discarded' ||
    withoutErrorPrefix.startsWith('cancelled: parallel tool call')
  )
}

function normalizeErrorCategory(content: string): string {
  const normalized = normalizeToolResultText(content)

  if (/\bInputValidationError\b/i.test(normalized)) {
    return 'InputValidationError'
  }
  if (/Invalid tool parameters/i.test(normalized)) {
    return 'InputValidationError'
  }
  if (/No such tool available/i.test(normalized)) {
    return 'NoSuchTool'
  }
  if (/\b(EACCES|EPERM)\b/i.test(normalized)) {
    return 'PermissionError'
  }
  if (/permission denied/i.test(normalized)) {
    return 'PermissionError'
  }
  if (/\bENOENT\b/i.test(normalized) || /not found/i.test(normalized)) {
    return 'NotFound'
  }
  if (/Error writing file/i.test(normalized)) {
    return 'FileWriteError'
  }

  return (
    normalized.toLowerCase().slice(0, MAX_FALLBACK_CATEGORY_LENGTH) ||
    'unknown error'
  )
}

function normalizeToolResultText(content: string): string {
  return content
    .replace(/<\/?tool_use_error[^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractNormalizedPath(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }

  const record = input as Record<string, unknown>
  for (const field of ['file_path', 'path', 'notebook_path']) {
    const value = record[field]
    if (typeof value !== 'string') {
      continue
    }
    const normalized = normalizePath(value)
    if (normalized) {
      return normalized
    }
  }

  return undefined
}

function normalizePath(path: string): string {
  const normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/g, '')

  return normalized === '' && path.trim().startsWith('/') ? '/' : normalized
}

function incrementCounter(counts: Map<string, number>, key: string): number {
  const next = (counts.get(key) ?? 0) + 1
  counts.set(key, next)
  return next
}

function incrementCounterOnce(
  counts: Map<string, number>,
  key: string,
  seenThisTurn: Set<string>,
): number {
  if (seenThisTurn.has(key)) {
    return counts.get(key) ?? 0
  }
  seenThisTurn.add(key)
  return incrementCounter(counts, key)
}

function createTripMessage(
  detail:
    | { kind: 'path'; threshold: number; path: string }
    | {
        kind: 'signature'
        threshold: number
        toolName: string
        errorCategory: string
      }
    | { kind: 'category'; threshold: number; errorCategory: string },
): string {
  let reason: string
  if (detail.kind === 'path') {
    reason = `The path \`${getTripPath(detail.path)}\` failed ${detail.threshold} times.`
  } else if (detail.kind === 'signature') {
    reason = `\`${getAdvisoryToolName(detail.toolName)}\` failed ${detail.threshold} times with \`${getAdvisoryErrorCategory(detail.errorCategory)}\`.`
  } else {
    reason = `Tool calls failed ${detail.threshold} times with \`${getAdvisoryErrorCategory(detail.errorCategory)}\`.`
  }

  return [
    'Stopped: repeated tool failures detected.',
    '',
    `${reason} Please inspect permissions, path, or tool schema before retrying.`,
  ].join('\n')
}

function createAdvisoryMessage({
  threshold,
  toolName,
  errorCategory,
}: {
  threshold: number
  toolName: string
  errorCategory: string
}): string {
  return [
    'Warning: repeated tool failures are close to stopping this query.',
    '',
    `\`${getAdvisoryToolName(toolName)}\` failed ${threshold - 1}/${threshold} times with \`${getAdvisoryErrorCategory(errorCategory)}\`. ` +
      'One more matching failure will stop the query. Try a different tool, or verify the path, permissions, and tool inputs before retrying.',
  ].join('\n')
}

function getAdvisoryToolName(toolName: string): string {
  return /^[A-Za-z0-9_.:-]+$/.test(toolName) ? toolName : 'unknown tool'
}

function getAdvisoryErrorCategory(errorCategory: string): string {
  return [
    'InputValidationError',
    'NoSuchTool',
    'PermissionError',
    'NotFound',
    'FileWriteError',
  ].includes(errorCategory)
    ? errorCategory
    : 'unknown error'
}

function getTripPath(path: string): string {
  const sanitized = path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`]/gu, '')
  return sanitized === '' ? 'unknown path' : sanitized
}
