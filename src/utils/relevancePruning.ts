/**
 * Relevance-Based Context Pruning - Production Grade
 * 
 * Prunes context to keep only messages relevant to current task.
 */

import { roughTokenCountEstimation } from '../services/tokenEstimation.js'
import type { Message } from '../types/message.js'

/**
 * Default number of recent messages preserved verbatim by relevance pruning.
 * Shared by autoCompact's `compactTailTurns` config plumbing and the /config
 * UI display so a future default change stays in sync everywhere.
 */
export const DEFAULT_COMPACT_TAIL_TURNS = 3

/**
 * Single normalization rule for the hand-editable `compactTailTurns` config:
 * any finite value ≥ 1 floors to an integer; everything else (0, negatives,
 * fractions below 1, NaN, non-numbers) falls back to the default. The /config
 * UI displays and persists through this SAME rule, so what the picker shows
 * is exactly what autoCompact preserves — a raw `0.5` must not floor to a
 * tail of zero, and a displayed `2.5` must not silently behave as 2.
 */
export function normalizeCompactTailTurns(value: unknown): number {
  // Only numbers (persisted config) and strings (the /config picker's value
  // channel) are coercible; other hand-edited shapes (true → 1, [2] → 2 via
  // Number()) must not smuggle in a tiny tail — they fall back instead.
  const num =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN
  return Number.isFinite(num) && num >= 1
    ? Math.floor(num)
    : DEFAULT_COMPACT_TAIL_TURNS
}

export interface PruningOptions {
  targetTokens: number
  taskContext?: string
  minRelevanceScore?: number
  preserveRecent?: number
  preserveTools?: boolean
  preserveErrors?: boolean
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'they', 'will', 'would',
])

function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/\s+/)
  const keywords = new Set<string>()

  for (const word of words) {
    const cleaned = word.replace(/[^a-z]/g, '')
    if (cleaned.length > 3 && !STOP_WORDS.has(cleaned)) {
      keywords.add(cleaned)
    }
  }

  return keywords
}

function calculateKeywordOverlap(text1: string, text2: string): number {
  const keywords1 = extractKeywords(text1)
  const keywords2 = extractKeywords(text2)

  let overlap = 0
  for (const keyword of keywords1) {
    if (keywords2.has(keyword)) {
      overlap++
    }
  }

  const total = keywords1.size + keywords2.size
  return total > 0 ? (2 * overlap) / total : 0
}

export function hasToolCalls(message: Message): boolean {
  const content = message.message?.content
  if (Array.isArray(content)) {
    return content.some(
      block => typeof block === 'object' && 
      ('type' in block) && 
      (block.type === 'tool_use' || block.type === 'tool_use_block' || block.type === 'function_call')
    )
  }
  
  const textContent = typeof content === 'string' ? content : ''
  return textContent.includes('tool_use') || textContent.includes('function_call')
}

export function hasErrors(message: Message): boolean {
  const content = message.message?.content
  if (Array.isArray(content)) {
    return content.some(
      block => typeof block === 'object' && 
      'type' in block && 
      block.type === 'tool_result' &&
      'is_error' in block &&
      block.is_error === true
    )
  }
  
  const textContent = typeof content === 'string' ? content : ''
  return textContent.includes('error') || textContent.includes('fail') || textContent.includes('exception')
}

/**
 * Chronological key for a message, in epoch milliseconds. Reads the envelope
 * `timestamp` (an ISO-8601 string present on every Message variant), NOT
 * `message.message.created_at` — that nested API-body field is never populated
 * on our Message objects, so the old code always saw `undefined` and its
 * recency scoring, tie-break and final chronological sort were all no-ops.
 * Returns 0 for a missing/unparseable timestamp (sorts as oldest).
 */
function messageTimeMs(message: Message | undefined): number {
  const parsed = message?.timestamp ? Date.parse(message.timestamp) : NaN
  return Number.isNaN(parsed) ? 0 : parsed
}

export function calculateRelevance(
  message: Message,
  options: PruningOptions,
): number {
  const content = typeof message.message?.content === 'string'
    ? message.message.content
    : ''

  let score = 0.5

  const keywordOverlap = options.taskContext
    ? calculateKeywordOverlap(content, options.taskContext)
    : 0

  score += keywordOverlap * 0.3

  if (hasToolCalls(message) && options.preserveTools) {
    score += 0.25
  }

  if (hasErrors(message) && options.preserveErrors) {
    score += 0.3
  }

  const ageHours = (Date.now() - messageTimeMs(message)) / (1000 * 60 * 60)
  if (ageHours < 1) {
    score += 0.15
  }

  if (message.message?.role === 'user') {
    score += 0.1
  }

  return Math.min(1, score)
}

function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined

  for (const msg of messages) {
    if (
      msg.type === 'assistant' &&
      msg.message.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

export function pruneByRelevance(
  messages: Message[],
  options: PruningOptions,
): Message[] {
  const targetTokens = options.targetTokens ?? 5000
  const preserveRecent = options.preserveRecent ?? DEFAULT_COMPACT_TAIL_TURNS

  if (messages.length <= preserveRecent) {
    return messages
  }

  const recentMessages = messages.slice(-preserveRecent)
  const olderMessages = messages.slice(0, -preserveRecent)

  const olderGroups = groupMessagesByApiRound(olderMessages)

  const scored: Array<{ group: Message[]; score: number }> = []
  for (const group of olderGroups) {
    const avgScore =
      group.reduce((sum, m) => sum + calculateRelevance(m, options), 0) /
      group.length
    scored.push({ group, score: avgScore })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const aTime = messageTimeMs(a.group[0])
    const bTime = messageTimeMs(b.group[0])
    return bTime - aTime
  })

  const result: Message[] = [...recentMessages]
  let totalTokens = 0

  for (const { group } of scored) {
    const content = group
      .map(m => (typeof m.message?.content === 'string' ? m.message.content : ''))
      .join('')
    const tokens = roughTokenCountEstimation(content)

    if (totalTokens + tokens > targetTokens) {
      continue
    }

    result.push(...group)
    totalTokens += tokens
  }

  return result.sort((a, b) => messageTimeMs(a) - messageTimeMs(b))
}

export function getTopRelevantMessages(
  messages: Message[],
  options: PruningOptions,
  limit: number = 10,
): Message[] {
  const scored = messages.map(msg => ({
    msg,
    score: calculateRelevance(msg, options),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map(s => s.msg)
}

export function getRelevanceStats(
  messages: Message[],
  options: PruningOptions,
): {
  averageScore: number
  highRelevanceCount: number
  toolCallCount: number
  errorCount: number
} {
  const scores = messages.map(msg => calculateRelevance(msg, options))

  const averageScore = scores.length > 0
    ? scores.reduce((sum, s) => sum + s, 0) / scores.length
    : 0

  return {
    averageScore,
    highRelevanceCount: scores.filter(s => s > 0.7).length,
    toolCallCount: messages.filter(hasToolCalls).length,
    errorCount: messages.filter(hasErrors).length,
  }
}