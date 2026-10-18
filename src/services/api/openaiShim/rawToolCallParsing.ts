import { normalizeToolArguments } from '../toolArgumentNormalization.js'

export const JSON_REPAIR_SUFFIXES = [
  '}',
  '"}',
  ']}',
  '"]}',
  '}}',
  '"}}',
  ']}}',
  '"]}}',
  '"]}]}',
  '}]}',
]

const RAW_TOOL_CALLS_REQUESTED_PREFIX = 'Tool calls requested:'
const FENCED_TOOL_CALL_START_RE = /```(?:json)?\s*\n?\s*\{/g
const BARE_TOOL_CALL_START_RE = /\{\s*"(?:name|type)"\s*:/g

export type ParsedRawToolCall = {
  id: string
  name: string
  argumentsJson: string
}

export interface ParsedTextToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

let toolCallCounter = 0

export function nextToolCallSequence(): number {
  return ++toolCallCounter
}

export function couldBeRawToolCallsRequestedPrefix(text: string): boolean {
  const trimmedStart = text.trimStart()
  return (
    RAW_TOOL_CALLS_REQUESTED_PREFIX.startsWith(trimmedStart) ||
    trimmedStart.startsWith(RAW_TOOL_CALLS_REQUESTED_PREFIX)
  )
}

export function parseRawToolCallsRequestedText(
  text: string,
): ParsedRawToolCall[] | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith(RAW_TOOL_CALLS_REQUESTED_PREFIX)) return null

  const lines = trimmed
    .slice(RAW_TOOL_CALLS_REQUESTED_PREFIX.length)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return null

  const toolCalls: ParsedRawToolCall[] = []
  for (const line of lines) {
    const match = line.match(
      /^-\s*([A-Za-z_][A-Za-z0-9_.-]*)\(([\s\S]*)\)\s*\[id:\s*([^\]\s]+)\]\s*$/,
    )
    if (!match) return null

    const [, name, rawArguments, id] = match
    if (!name || !id || rawArguments === undefined) return null

    const normalizedArguments = normalizeToolArguments(name, rawArguments)
    toolCalls.push({
      id,
      name,
      argumentsJson: JSON.stringify(normalizedArguments ?? {}),
    })
  }

  return toolCalls
}

export function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? raw : null
  } catch {
    for (const suffix of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + suffix
        const parsed: unknown = JSON.parse(repaired)
        if (isRecord(parsed)) return repaired
      } catch {
        // Try the next bounded suffix.
      }
    }
    return null
  }
}

export function extractBalancedJson(text: string, start: number): string | null {
  let depth = 0
  let inString = false
  let escape = false

  for (let index = start; index < text.length; index++) {
    const character = text[index]!
    if (escape) {
      escape = false
      continue
    }
    if (character === '\\' && inString) {
      escape = true
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '{') depth++
    else if (character === '}') {
      depth--
      if (depth === 0) return text.slice(start, index + 1)
    }
  }

  return null
}

export function stripRanges(
  text: string,
  ranges: Array<[number, number]>,
): string {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0])
  let result = ''
  let position = 0
  for (const [start, end] of sorted) {
    result += text.slice(position, start)
    position = end
  }
  return result + text.slice(position)
}

export function parseTextToolCalls(
  text: string,
  nextSequence: () => number = nextToolCallSequence,
): {
  calls: ParsedTextToolCall[]
  toolCallRanges: Array<[number, number]>
} {
  const results: ParsedTextToolCall[] = []
  const seen = new Set<string>()
  const fencedRanges: Array<[number, number]> = []
  const acceptedRanges: Array<[number, number]> = []

  for (const match of text.matchAll(FENCED_TOOL_CALL_START_RE)) {
    const fenceStart = match.index!
    const rawStart = fenceStart + match[0].length - 1
    const raw = extractBalancedJson(text, rawStart)
    if (!raw) continue

    const closingFence = text.slice(rawStart + raw.length).match(/^\s*```/)
    if (!closingFence) continue

    const fenceEnd = rawStart + raw.length + closingFence[0].length
    const after = text.slice(fenceEnd).trimStart()
    if (after.length > 0 && !after.startsWith('{')) continue
    const range: [number, number] = [fenceStart, fenceEnd]
    fencedRanges.push(range)
    if (parseAndAdd(raw, results, seen, nextSequence)) acceptedRanges.push(range)
  }

  const processedRanges: Array<[number, number]> = [...fencedRanges]
  for (const match of text.matchAll(BARE_TOOL_CALL_START_RE)) {
    const start = match.index!
    if (processedRanges.some(([rangeStart, rangeEnd]) =>
      start >= rangeStart && start < rangeEnd
    )) {
      continue
    }

    const raw = extractBalancedJson(text, start)
    if (!raw) continue
    const after = text.slice(start + raw.length).trimStart()
    if (after.length > 0 && !after.startsWith('{')) continue

    const range: [number, number] = [start, start + raw.length]
    processedRanges.push(range)
    if (parseAndAdd(raw, results, seen, nextSequence)) acceptedRanges.push(range)
  }

  return { calls: results, toolCallRanges: acceptedRanges }
}

function parseAndAdd(
  raw: string,
  results: ParsedTextToolCall[],
  seen: Set<string>,
  nextSequence: () => number,
): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (!isRecord(parsed)) return false

  let name: string | undefined
  let argumentsValue: Record<string, unknown> = {}

  if (typeof parsed.name === 'string') {
    name = parsed.name
    argumentsValue = parseArguments(parsed.arguments)
  } else if (parsed.type === 'function' && isRecord(parsed.function)) {
    const functionValue = parsed.function
    if (typeof functionValue.name !== 'string') return false
    name = functionValue.name
    argumentsValue = parseArguments(functionValue.arguments)
  }

  if (!name) return false
  const deduplicationKey = `${name}:${JSON.stringify(argumentsValue)}`
  if (seen.has(deduplicationKey)) return false
  seen.add(deduplicationKey)
  results.push({
    id: `ollama_tc_${nextSequence()}`,
    name,
    arguments: argumentsValue,
  })
  return true
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return isRecord(value) ? value : {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
