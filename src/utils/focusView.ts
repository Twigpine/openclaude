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
  message?: { id?: string; content: string | FocusBlock[] }
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
  /**
   * Tools whose result is the reply the user reads (SendUserMessage). Their
   * call and successful result stay visible and are not counted as tool use.
   */
  replyToolNames?: ReadonlySet<string>
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
  '<bash-stderr>',
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

function isScheduledFire(m: FocusMessage): boolean {
  return m.type === 'system' && m.subtype === 'scheduled_task_fire'
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
 * normalizeMessages splits one submitted message into a row per content block
 * and derives every row's uuid from the original, keeping its first 24
 * characters. Rows with the same prefix therefore come from one submission.
 */
function sourceKey(m: FocusMessage): string | undefined {
  return m.type === 'user' && m.uuid ? m.uuid.slice(0, 24) : undefined
}

/** user rows of the list grouped by the submission they were split from. */
function submissionGroups(
  messages: readonly FocusMessage[],
): Map<string, number[]> {
  const groups = new Map<string, number[]>()
  messages.forEach((m, i) => {
    const key = sourceKey(m)
    if (key === undefined) return
    const g = groups.get(key)
    if (g) g.push(i)
    else groups.set(key, [i])
  })
  return groups
}

/**
 * Indices of every row that starts a prompt turn, with slash commands
 * classified: a command invocation is a prompt only when no local command
 * output follows it before the next candidate and either an assistant
 * message follows or it is the last candidate during a turn in flight.
 * Rows split from one submission count once, at the group's first row, and a
 * submission that carries a tool_result (permission feedback) is not a prompt.
 */
function promptBoundaryIndices(
  messages: readonly FocusMessage[],
  isLoading: boolean,
): number[] {
  const groups = submissionGroups(messages)
  const candidates: Array<{ index: number; kind: CandidateKind }> = []
  messages.forEach((m, index) => {
    const kind = candidateKind(m)
    if (!kind) return
    const key = sourceKey(m)
    const group = key === undefined ? undefined : groups.get(key)
    if (group) {
      if (group.some(j => toolResultOf(messages[j]!))) return
      const first = group.find(j => candidateKind(messages[j]!))
      if (first !== index) return
      const kinds = group.map(j => candidateKind(messages[j]!))
      candidates.push({ index, kind: kinds.includes('command') ? 'command' : kind })
      return
    }
    candidates.push({ index, kind })
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

/**
 * ids of API responses that called a tool. Tools run after their response
 * completes, so text from such a response was emitted before the results and
 * is narration whatever position display reordering gave it.
 */
function toolCallingResponseIds(messages: readonly FocusMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    const id = m.message?.id
    if (id !== undefined && toolUsesOf(m).length > 0) ids.add(id)
  }
  return ids
}

function isFinalResponseText(
  m: FocusMessage,
  toolResponses: ReadonlySet<string>,
): boolean {
  if (m.type !== 'assistant' || m.isApiErrorMessage || !hasVisibleText(m)) return false
  const id = m.message?.id
  return id === undefined || !toolResponses.has(id)
}

/**
 * Compact boundaries that end a turn. A boundary the query emits while the
 * latest prompt is still unanswered (auto or reactive compaction) belongs to
 * that turn and is not a boundary here. A boundary with no earlier prompt
 * (restored history) or after a finished turn (idle or manual) is one.
 */
function turnEndingCompactions(
  messages: readonly FocusMessage[],
  prompts: readonly number[],
): number[] {
  const out: number[] = []
  const toolResponses = toolCallingResponseIds(messages)
  messages.forEach((m, c) => {
    if (!isCompactBoundary(m)) return
    let p = -1
    for (const i of prompts) if (i < c) p = i
    const prev = out.length > 0 ? out[out.length - 1]! : -1
    if (p === -1 || p < prev) {
      out.push(c)
      return
    }
    const lastTool = lastToolActivityIndex(messages, p + 1, c)
    for (let i = c - 1; i > lastTool; i--) {
      if (isFinalResponseText(messages[i]!, toolResponses)) {
        out.push(c)
        return
      }
    }
  })
  return out
}

function addEditLines(result: unknown, into: FocusSummary): void {
  if (!isFileEditResult(result)) return
  const isCreate = 'type' in result && result.type === 'create'
  if (isCreate && result.structuredPatch.length === 0 && 'content' in result) {
    // Same convention as the diff path: a trailing newline ends the last line
    // instead of starting another, and empty content adds nothing.
    const c = result.content
    into.linesAdded += c === '' ? 0 : c.split('\n').length - (c.endsWith('\n') ? 1 : 0)
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
  const compactions = turnEndingCompactions(messages, prompts)
  const lastCompaction = compactions.length > 0 ? compactions[compactions.length - 1]! : -1
  if (lastCompaction > boundaryIdx) boundaryIdx = lastCompaction
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
  const boundaryKey = sourceKey(boundary)
  const siblings = new Set<number>(
    boundaryKey === undefined
      ? []
      : (submissionGroups(messages).get(boundaryKey) ?? []).filter(
          j => j > boundaryIdx && candidateKind(messages[j]!) !== undefined,
        ),
  )
  const hiddenTurns = prompts.filter(i => i < boundaryIdx).length
  const summary = { ...EMPTY_SUMMARY }
  const isSynthetic = (m: FocusMessage) =>
    toolUsesOf(m).some(b => b.id !== undefined && synthetic?.has(b.id))

  const start = boundaryIdx + 1
  // A scheduled run's marker splits the rows after the boundary: tool activity
  // and final-response rules apply per segment, and only the typed segment
  // feeds the summary.
  const fires: number[] = []
  for (let i = start; i < messages.length; i++) {
    if (isScheduledFire(messages[i]!)) fires.push(i)
  }
  const edges = [start, ...fires, messages.length]
  const segmentLastTool = edges
    .slice(0, -1)
    .map((from, k) => lastToolActivityIndex(messages, from, edges[k + 1]!))
  const lastTool = segmentLastTool[segmentLastTool.length - 1]!
  const toolResponses = toolCallingResponseIds(messages)
  const replyTools = options.replyToolNames
  const replyCalls = new Map<string, number>()
  const keep = new Set<number>()
  const callLineIdx = new Map<string, number>()
  let lastInterrupt = -1
  let finalIdx = -1
  let segment = 0
  const warnings: number[] = []
  const rejections: Array<{ index: number; toolUseId: string | undefined }> = []

  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!
    while (segment < fires.length && i > fires[segment]!) segment++
    const typed = segment === 0
    if (siblings.has(i)) keep.add(i)
    if (m.type === 'assistant') {
      for (const b of toolUsesOf(m)) {
        if (b.id !== undefined && synthetic?.has(b.id)) continue
        if (b.id !== undefined && b.name !== undefined && replyTools?.has(b.name)) {
          replyCalls.set(b.id, i)
          continue
        }
        if (typed) summary.toolCount++
        if (b.id !== undefined) callLineIdx.set(b.id, i)
      }
      if (m.isApiErrorMessage) keep.add(i)
      else if (i > segmentLastTool[segment]! && isFinalResponseText(m, toolResponses)) {
        keep.add(i)
        finalIdx = i
      }
    } else if (m.type === 'user') {
      const tr = toolResultOf(m)
      if (tr) {
        const reply = tr.tool_use_id !== undefined ? replyCalls.get(tr.tool_use_id) : undefined
        if (reply !== undefined && !tr.is_error) {
          keep.add(i)
          keep.add(reply)
          continue
        }
        const agentCount = (m.toolUseResult as { totalToolUseCount?: unknown } | undefined)
          ?.totalToolUseCount
        if (typed) {
          if (typeof agentCount === 'number') summary.toolCount += agentCount
          addEditLines(m.toolUseResult, summary)
        }
        if (isRejection(tr)) rejections.push({ index: i, toolUseId: tr.tool_use_id })
        else if (tr.is_error) {
          if (typed) summary.failed++
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
    } else if (m.type === 'attachment') {
      if (m.attachment?.type === 'max_turns_reached') keep.add(i)
    } else if (m.type === 'system') {
      if (m.subtype === 'api_error' || m.subtype === 'local_command') keep.add(i)
      else if (
        m.subtype === 'stop_hook_summary' &&
        ((m.hookErrors?.length ?? 0) > 0 || m.preventedContinuation)
      ) {
        keep.add(i)
      } else if (m.level === 'error') keep.add(i)
      else if (m.level === 'warning') warnings.push(i)
    }
  }

  // A warning that ends the turn is the reason it stopped. One followed by
  // more tool work or a final response is routine.
  for (const w of warnings) if (w > finalIdx && w > lastTool) keep.add(w)
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
 * Block indices normalizeMessages uses count up from 0 and never reach these,
 * so synthetic row ids cannot equal a normalized row id with the same prefix.
 */
const FOCUS_MARKER_SUFFIX = 0xf0c5_0000_0000
const FOCUS_SUMMARY_SUFFIX = FOCUS_MARKER_SUFFIX + 1

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
      uuid: deriveUUID(parent, FOCUS_MARKER_SUFFIX),
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
      uuid: deriveUUID(parent, FOCUS_SUMMARY_SUFFIX),
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
  const prompts = promptBoundaryIndices(messages, options.isLoading ?? false)
  const starts = [...prompts, ...turnEndingCompactions(messages, prompts)]
  messages.forEach((m, i) => {
    if (isScheduledFire(m)) starts.push(i)
  })
  starts.sort((a, b) => a - b)
  const toolResponses = toolCallingResponseIds(messages)
  const edges = [-1, ...starts, messages.length]
  let count = 0
  for (let n = 0; n < edges.length - 1; n++) {
    const from = edges[n]! + 1
    const to = edges[n + 1]!
    const lastTool = lastToolActivityIndex(messages, from, to)
    for (let i = Math.max(lastTool + 1, from, dividerIndex); i < to; i++) {
      if (isFinalResponseText(messages[i]!, toolResponses)) {
        count++
        break
      }
    }
  }
  return count
}

/**
 * Whether focus view applies right now: the stored setting is on and the
 * fullscreen renderer is active, and nothing else owns the display. Read at render time because /tui can switch
 * the renderer mid-session while the stored setting stays on.
 */
export function isFocusViewActive(
  blockers: {
    /** Brief-only owns the display and bypasses focus filtering. */
    isBriefOnly?: boolean
    /** /focus is unavailable, so the stored setting cannot be undone. */
    disableSlashCommands?: boolean
    /** Commands run on the remote host, not against this config. */
    isRemoteSession?: boolean
  } = {},
): boolean {
  if (blockers.isBriefOnly || blockers.disableSlashCommands || blockers.isRemoteSession) {
    return false
  }
  return isFullscreenEnvEnabled() && (getGlobalConfig().focusView ?? false)
}
