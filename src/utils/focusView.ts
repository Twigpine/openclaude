import type { UUID } from 'crypto'
import { stripSystemReminders } from '../components/messageActions.js'
import { countHunkLines, isFileEditResult } from '../hooks/useTurnDiffs.js'
import {
  CANCEL_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  SYNTHETIC_MESSAGES,
} from './messages.js'
import { getGlobalConfig } from './config.js'
import { isFullscreenEnvEnabled } from './fullscreen.js'
import { deriveUUID } from './messages/normalize.js'
import type {
  SystemFocusMarkerMessage,
  SystemFocusSummaryMessage,
} from '../types/message.js'

type FocusBlock = {
  type: string
  text?: string
  id?: string
  name?: string
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

/**
 * The message shape focus view reads. Structural, like filterForBriefTool,
 * so tests can build messages by hand and real Message values fit.
 */
export type FocusMessage = {
  type: string
  subtype?: string
  uuid?: string
  timestamp?: string
  level?: string
  isMeta?: boolean
  isCompactSummary?: boolean
  isApiErrorMessage?: boolean
  origin?: unknown
  hookErrors?: unknown[]
  preventedContinuation?: boolean
  toolUseResult?: unknown
  message?: { content: string | FocusBlock[] }
  attachment?: {
    type: string
    isMeta?: boolean
    origin?: unknown
    commandMode?: string
  }
}

export type FocusSummary = {
  toolCount: number
  linesAdded: number
  linesRemoved: number
  failed: number
}

export type FocusOptions = {
  /** True while a turn is in flight. */
  isLoading?: boolean
  /** tool_use ids of the synthetic streaming rows Messages appends. */
  syntheticToolUseIds?: ReadonlySet<string>
}

export type FocusSelection<T> = {
  /**
   * Kept rows in source order. When a boundary exists, the first row is the
   * boundary (the latest prompt, or the compaction boundary row). With no
   * boundary this is the input array itself.
   */
  rows: T[]
  /** Prompt turns before the boundary. */
  hiddenTurns: number
  /** True when the boundary is a compaction with no prompt since. */
  compacted: boolean
  summary: FocusSummary
  /** The boundary row, for deriving stable ids. Undefined when none exists. */
  boundary: T | undefined
}

const EMPTY_SUMMARY: FocusSummary = {
  toolCount: 0,
  linesAdded: 0,
  linesRemoved: 0,
  failed: 0,
}

const NON_PROMPT_TAGS = [
  '<bash-input>',
  '<bash-stdout>',
  '<local-command-',
  '<task-notification>',
  '<teammate-message>',
  '<system-reminder>',
]
const COMMAND_TAG = '<command-name>'

const REJECTION_PREFIXES = [
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
  PLAN_REJECTION_PREFIX,
]

function blocksOf(m: FocusMessage): FocusBlock[] {
  const c = m.message?.content
  if (c === undefined) return []
  return typeof c === 'string' ? [{ type: 'text', text: c }] : c
}

function firstText(m: FocusMessage): string | undefined {
  return blocksOf(m).find(b => b.type === 'text')?.text
}

function toolResultOf(m: FocusMessage): FocusBlock | undefined {
  if (m.type !== 'user') return undefined
  return blocksOf(m).find(b => b.type === 'tool_result')
}

function toolUsesOf(m: FocusMessage): FocusBlock[] {
  if (m.type !== 'assistant') return []
  return blocksOf(m).filter(b => b.type === 'tool_use')
}

function resultText(b: FocusBlock): string {
  if (typeof b.content === 'string') return b.content
  if (Array.isArray(b.content)) {
    return b.content
      .map(x => (x && typeof x === 'object' && 'text' in x ? String(x.text) : ''))
      .join('')
  }
  return ''
}

function isRejection(b: FocusBlock): boolean {
  if (!b.is_error) return false
  const t = resultText(b)
  return (
    t === INTERRUPT_MESSAGE_FOR_TOOL_USE ||
    REJECTION_PREFIXES.some(p => t.startsWith(p))
  )
}

function isInterrupt(m: FocusMessage): boolean {
  if (m.type !== 'user') return false
  const t = firstText(m)
  return t === INTERRUPT_MESSAGE || t === INTERRUPT_MESSAGE_FOR_TOOL_USE
}

function isCompactBoundary(m: FocusMessage): boolean {
  return m.type === 'system' && m.subtype === 'compact_boundary'
}

function isLocalCommandOutput(m: FocusMessage): boolean {
  if (m.type === 'system') return m.subtype === 'local_command'
  if (m.type !== 'user') return false
  const t = firstText(m) ?? ''
  return (
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-stderr>')
  )
}

function hasVisibleText(m: FocusMessage): boolean {
  return blocksOf(m).some(b => b.type === 'text' && (b.text ?? '').trim() !== '')
}

type CandidateKind = 'prompt' | 'command'

/** A message that could start a turn, before slash-command classification. */
function candidateKind(m: FocusMessage): CandidateKind | undefined {
  if (m.type === 'attachment') {
    const a = m.attachment
    return a?.type === 'queued_command' &&
      a.commandMode === 'prompt' &&
      !a.isMeta &&
      a.origin === undefined
      ? 'prompt'
      : undefined
  }
  if (m.type !== 'user') return undefined
  if (m.isMeta || m.isCompactSummary || m.origin !== undefined) return undefined
  const blocks = blocksOf(m)
  if (blocks.some(b => b.type === 'tool_result')) return undefined
  const rawText = firstText(m)
  if (rawText !== undefined && SYNTHETIC_MESSAGES.has(rawText)) return undefined
  const hasImage = blocks.some(b => b.type === 'image')
  if (rawText === undefined && !hasImage) return undefined
  const text = stripSystemReminders(rawText ?? '')
  if (text.startsWith(COMMAND_TAG)) return 'command'
  if (NON_PROMPT_TAGS.some(t => text.startsWith(t))) return undefined
  if (text === '' && !hasImage) return undefined
  return 'prompt'
}

/**
 * Indices of every row that starts a prompt turn, with slash commands
 * classified: a command invocation is a prompt only when no local command
 * output follows it before the next candidate and either an assistant
 * message follows or it is the last candidate during a turn in flight.
 */
function promptBoundaryIndices(
  messages: readonly FocusMessage[],
  isLoading: boolean,
): number[] {
  const candidates: Array<{ index: number; kind: CandidateKind }> = []
  messages.forEach((m, index) => {
    const kind = candidateKind(m)
    if (kind) candidates.push({ index, kind })
  })
  const out: number[] = []
  candidates.forEach((c, n) => {
    if (c.kind === 'prompt') {
      out.push(c.index)
      return
    }
    const next = candidates[n + 1]
    const end = next ? next.index : messages.length
    let hasOutput = false
    let hasAssistant = false
    for (let j = c.index + 1; j < end; j++) {
      const m = messages[j]!
      if (isLocalCommandOutput(m)) hasOutput = true
      else if (m.type === 'assistant') hasAssistant = true
    }
    if (!hasOutput && (hasAssistant || (!next && isLoading))) out.push(c.index)
  })
  return out
}

/** Index of the last row in [from, to) that is a tool call or tool result. */
function lastToolActivityIndex(
  messages: readonly FocusMessage[],
  from: number,
  to: number,
): number {
  for (let i = to - 1; i >= from; i--) {
    const m = messages[i]!
    if (toolResultOf(m) || toolUsesOf(m).length > 0) return i
  }
  return from - 1
}

function isFinalResponseText(m: FocusMessage): boolean {
  return m.type === 'assistant' && !m.isApiErrorMessage && hasVisibleText(m)
}

function addEditLines(result: unknown, into: FocusSummary): void {
  if (!isFileEditResult(result)) return
  const isCreate = 'type' in result && result.type === 'create'
  if (isCreate && result.structuredPatch.length === 0 && 'content' in result) {
    into.linesAdded += result.content.split('\n').length
    return
  }
  const { added, removed } = countHunkLines(result.structuredPatch)
  into.linesAdded += added
  into.linesRemoved += removed
}

/**
 * Decides which rows focus view shows for the given message list: the latest
 * turn's prompt, its failures, interrupts, local command output and final
 * response, plus counts for the summary line and the hidden earlier turns.
 * Returns the input unchanged when there is no turn boundary.
 */
export function selectFocusView<T extends FocusMessage>(
  messages: T[],
  options: FocusOptions = {},
): FocusSelection<T> {
  const synthetic = options.syntheticToolUseIds
  const prompts = promptBoundaryIndices(messages, options.isLoading ?? false)
  let boundaryIdx = prompts.length > 0 ? prompts[prompts.length - 1]! : -1
  for (let i = messages.length - 1; i > boundaryIdx; i--) {
    if (isCompactBoundary(messages[i]!)) {
      boundaryIdx = i
      break
    }
  }
  if (boundaryIdx < 0) {
    return {
      rows: messages,
      hiddenTurns: 0,
      compacted: false,
      summary: { ...EMPTY_SUMMARY },
      boundary: undefined,
    }
  }
  const boundary = messages[boundaryIdx]!
  const hiddenTurns = prompts.filter(i => i < boundaryIdx).length
  const summary = { ...EMPTY_SUMMARY }
  const isSynthetic = (m: FocusMessage) =>
    toolUsesOf(m).some(b => b.id !== undefined && synthetic?.has(b.id))

  const start = boundaryIdx + 1
  const lastTool = lastToolActivityIndex(messages, start, messages.length)
  const keep = new Set<number>()
  const callLineIdx = new Map<string, number>()
  let lastInterrupt = -1
  let finalIdx = -1
  const warnings: number[] = []
  const rejections: Array<{ index: number; toolUseId: string | undefined }> = []

  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!
    if (m.type === 'assistant') {
      for (const b of toolUsesOf(m)) {
        if (b.id !== undefined && synthetic?.has(b.id)) continue
        summary.toolCount++
        if (b.id !== undefined) callLineIdx.set(b.id, i)
      }
      if (m.isApiErrorMessage) keep.add(i)
      else if (i > lastTool && isFinalResponseText(m)) {
        keep.add(i)
        finalIdx = i
      }
    } else if (m.type === 'user') {
      const tr = toolResultOf(m)
      if (tr) {
        const agentCount = (m.toolUseResult as { totalToolUseCount?: unknown } | undefined)
          ?.totalToolUseCount
        if (typeof agentCount === 'number') summary.toolCount += agentCount
        addEditLines(m.toolUseResult, summary)
        if (isRejection(tr)) rejections.push({ index: i, toolUseId: tr.tool_use_id })
        else if (tr.is_error) {
          summary.failed++
          keep.add(i)
          const call = tr.tool_use_id !== undefined ? callLineIdx.get(tr.tool_use_id) : undefined
          if (call !== undefined) keep.add(call)
        }
      } else if (isInterrupt(m)) {
        keep.add(i)
        lastInterrupt = i
      } else if (candidateKind(m) === 'command' || isLocalCommandOutput(m)) {
        keep.add(i)
      } else {
        const t = stripSystemReminders(firstText(m) ?? '')
        if (t.startsWith('<bash-input>') || t.startsWith('<bash-stdout>')) keep.add(i)
      }
    } else if (m.type === 'system') {
      if (m.subtype === 'api_error' || m.subtype === 'local_command') keep.add(i)
      else if (
        m.subtype === 'stop_hook_summary' &&
        ((m.hookErrors?.length ?? 0) > 0 || m.preventedContinuation)
      ) {
        keep.add(i)
      } else if (m.level === 'warning' || m.level === 'error') warnings.push(i)
    }
  }

  for (const w of warnings) if (finalIdx >= 0 && w > finalIdx) keep.add(w)
  for (const r of rejections) {
    if (lastInterrupt > r.index) continue
    keep.add(r.index)
    const call = r.toolUseId !== undefined ? callLineIdx.get(r.toolUseId) : undefined
    if (call !== undefined) keep.add(call)
  }

  const rows: T[] = [boundary]
  for (let i = start; i < messages.length; i++) {
    if (keep.has(i) && !isSynthetic(messages[i]!)) rows.push(messages[i]!)
  }
  return {
    rows,
    hiddenTurns,
    compacted: isCompactBoundary(boundary),
    summary,
    boundary,
  }
}

/**
 * Turns a selection into the final list: the hidden-turns marker directly
 * before the boundary row and the summary row directly after it, then the
 * kept rows. Both synthetic uuids derive from the boundary uuid, so they stay
 * the same while the summary content changes. Returns the input array when
 * there is no boundary.
 */
export function assembleFocusRows<T extends FocusMessage>(
  selection: FocusSelection<T>,
): Array<T | SystemFocusMarkerMessage | SystemFocusSummaryMessage> {
  const { rows, boundary, hiddenTurns, compacted, summary } = selection
  if (boundary === undefined) return rows
  const parent = (boundary.uuid ?? '') as UUID
  const timestamp = boundary.timestamp ?? ''
  const out: Array<T | SystemFocusMarkerMessage | SystemFocusSummaryMessage> = []
  if (hiddenTurns > 0 || compacted) {
    out.push({
      type: 'system',
      subtype: 'focus_marker',
      uuid: deriveUUID(parent, 0),
      timestamp,
      hiddenTurns,
      compacted,
    })
  }
  out.push(rows[0]!)
  if (summary.toolCount > 0) {
    out.push({
      type: 'system',
      subtype: 'focus_summary',
      uuid: deriveUUID(parent, 1),
      timestamp,
      summary,
    })
  }
  for (let i = 1; i < rows.length; i++) out.push(rows[i]!)
  return out
}

/**
 * Number of turns with a final response at or after dividerIndex, using the
 * same turn and final-response rules as selectFocusView. Narration runs do
 * not count.
 */
export function countUnseenFocusTurns(
  messages: readonly FocusMessage[],
  dividerIndex: number,
  options: FocusOptions = {},
): number {
  const starts = promptBoundaryIndices(messages, options.isLoading ?? false)
  messages.forEach((m, i) => {
    if (isCompactBoundary(m)) starts.push(i)
  })
  starts.sort((a, b) => a - b)
  const edges = [-1, ...starts, messages.length]
  let count = 0
  for (let n = 0; n < edges.length - 1; n++) {
    const from = edges[n]! + 1
    const to = edges[n + 1]!
    const lastTool = lastToolActivityIndex(messages, from, to)
    for (let i = Math.max(lastTool + 1, from, dividerIndex); i < to; i++) {
      if (isFinalResponseText(messages[i]!)) {
        count++
        break
      }
    }
  }
  return count
}

/**
 * Whether focus view applies right now: the stored setting is on and the
 * fullscreen renderer is active. Read at render time because /tui can switch
 * the renderer mid-session while the stored setting stays on.
 */
export function isFocusViewActive(): boolean {
  return isFullscreenEnvEnabled() && (getGlobalConfig().focusView ?? false)
}
