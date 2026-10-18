import type { SystemPrompt } from '../../utils/systemPromptType.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import {
  getInterruptionSignalAbortEventId,
  traceInterruptionEvent,
} from '../../utils/interruptionTrace.js'
import { queryHaiku } from '../api/claude.js'
import type { GoalEvaluatorDecision, GoalState } from './types.js'

const GOAL_EVALUATOR_SYSTEM_PROMPT = `You evaluate whether a coding agent has completed a session goal.

Return strict JSON only:
{
  "complete": boolean,
  "confidence": number,
  "reason": string,
  "next_instruction": string | null
}

Rules:
- Mark complete only when the recent conversation shows the goal condition is satisfied.
- If verification is missing for a development task, mark incomplete.
- Keep reason and next_instruction concise.
- Do not ask questions.`

const GOAL_EVALUATOR_OUTPUT_FORMAT = {
  type: 'json_schema' as const,
  schema: {
    type: 'object',
    properties: {
      complete: { type: 'boolean' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
      next_instruction: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
      },
    },
    required: ['complete', 'confidence', 'reason', 'next_instruction'],
    additionalProperties: false,
  },
}

const MAX_CONTEXT_CHARS = 12_000
const MAX_PROMPT_CHARS = 16_000
const MAX_MESSAGE_CHARS = 1_200
const RECENT_MESSAGE_LIMIT = 20

export type GoalModelRequest = {
  systemPrompt: SystemPrompt
  userPrompt: string
  signal: AbortSignal
  isNonInteractiveSession: boolean
  tools: []
}

export type GoalModelCaller = (
  request: GoalModelRequest,
) => Promise<string>

const defaultModelCaller: GoalModelCaller = async request => {
  const response = await queryHaiku({
    systemPrompt: request.systemPrompt,
    userPrompt: request.userPrompt,
    outputFormat: GOAL_EVALUATOR_OUTPUT_FORMAT,
    signal: request.signal,
    options: {
      querySource: 'goal_evaluation',
      enablePromptCaching: false,
      agents: [],
      isNonInteractiveSession: request.isNonInteractiveSession,
      hasAppendSystemPrompt: false,
      mcpTools: [],
    },
  })

  return response.message.content
    .filter((block: { type: string }) => block.type === 'text')
    .map((block: { type: string; text?: string }) => block.text ?? '')
    .join('')
    .trim()
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars - 15).trimEnd() + '... [truncated]'
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      parts.push(record.text)
    } else if (record.type === 'tool_result') {
      const raw = record.content
      const text =
        typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? raw
                .map(item =>
                  item &&
                  typeof item === 'object' &&
                  (item as Record<string, unknown>).type === 'text' &&
                  typeof (item as Record<string, unknown>).text === 'string'
                    ? ((item as Record<string, unknown>).text as string)
                    : '',
                )
                .filter(Boolean)
                .join('\n')
            : ''
      if (text) parts.push(`Tool result: ${text}`)
    } else if (record.type === 'tool_use' && typeof record.name === 'string') {
      parts.push(`Tool use: ${record.name}`)
    }
  }
  return parts.join('\n')
}

function messageRole(message: Record<string, unknown>): string | null {
  if (message.type === 'assistant') return 'assistant'
  if (message.type === 'user') return 'user'
  if (message.type === 'system' && message.subtype === 'local_command') {
    return 'local-command'
  }
  if (message.type === 'tool_use_summary') return 'tool-summary'
  return null
}

function messageText(message: Record<string, unknown>): string {
  if (message.type === 'system' && typeof message.content === 'string') {
    return message.content
  }
  if (
    message.type === 'tool_use_summary' &&
    typeof message.summary === 'string'
  ) {
    return message.summary
  }
  const nested = message.message
  if (!nested || typeof nested !== 'object') return ''
  return contentToText((nested as Record<string, unknown>).content)
}

function recentContext(messages: unknown[]): string {
  const lines: string[] = []
  let total = 0
  const recent = messages.slice(-RECENT_MESSAGE_LIMIT).reverse()

  for (const item of recent) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const role = messageRole(record)
    if (!role) continue

    const text = truncateText(messageText(record).trim(), MAX_MESSAGE_CHARS)
    if (!text) continue

    const line = `${role}: ${text}`
    if (total + line.length > MAX_CONTEXT_CHARS) break
    lines.push(line)
    total += line.length
  }

  return lines.reverse().join('\n\n')
}

export function buildGoalEvaluatorPrompt({
  goal,
  messages,
}: {
  goal: GoalState
  messages: unknown[]
}): string {
  const prompt = [
    `Goal condition:\n${truncateText(goal.condition, 4_000)}`,
    `Current goal turn count: ${goal.turnCount}/${goal.maxTurns}`,
    `Last evaluator reason: ${goal.lastReason ?? 'none'}`,
    `Recent conversation:\n${recentContext(messages) || '(no recent text)'}`,
    'Return strict JSON now.',
  ].join('\n\n')

  return truncateText(prompt, MAX_PROMPT_CHARS)
}

function stripJsonFence(raw: string): string {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last !== -1 && last > first) {
    return text.slice(first, last + 1)
  }
  return text
}

function parseDecision(raw: string): GoalEvaluatorDecision | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonFence(raw))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const obj = parsed as Record<string, unknown>
  if (typeof obj.complete !== 'boolean') return null
  if (typeof obj.confidence !== 'number' || Number.isNaN(obj.confidence)) {
    return null
  }
  if (typeof obj.reason !== 'string') return null
  if (
    obj.next_instruction !== null &&
    typeof obj.next_instruction !== 'string'
  ) {
    return null
  }

  return {
    complete: obj.complete,
    confidence: Math.max(0, Math.min(1, obj.confidence)),
    decision: obj.complete ? 'complete' : 'incomplete',
    reason: truncateText(obj.reason.trim() || 'No reason provided.', 1_000),
    nextInstruction:
      typeof obj.next_instruction === 'string'
        ? truncateText(obj.next_instruction.trim(), 1_000) || null
        : null,
    raw,
  }
}

export async function evaluateGoal({
  goal,
  messages,
  signal,
  isNonInteractiveSession,
  modelCaller = defaultModelCaller,
}: {
  goal: GoalState
  messages: unknown[]
  signal: AbortSignal
  isNonInteractiveSession: boolean
  modelCaller?: GoalModelCaller
}): Promise<GoalEvaluatorDecision> {
  const request: GoalModelRequest = {
    systemPrompt: asSystemPrompt([GOAL_EVALUATOR_SYSTEM_PROMPT]),
    userPrompt: buildGoalEvaluatorPrompt({ goal, messages }),
    signal,
    isNonInteractiveSession,
    tools: [],
  }

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await modelCaller(request)
      const parsed = parseDecision(raw)
      if (parsed) return parsed
    }
    return {
      complete: false,
      confidence: 0,
      decision: 'malformed',
      reason:
        'Goal evaluator returned malformed JSON; pausing automatic goal continuation.',
      nextInstruction: null,
    }
  } catch (error) {
    traceInterruptionEvent('goal.evaluation_failed', {
      subsystem: 'goal',
      phase: 'evaluator',
      error,
      reason: signal.reason,
      causalEventId: getInterruptionSignalAbortEventId(signal),
    })
    return {
      complete: false,
      confidence: 0,
      decision: 'error',
      reason: 'Goal evaluator failed; pausing automatic goal continuation.',
      nextInstruction: null,
    }
  }
}
