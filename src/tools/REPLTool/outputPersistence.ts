import {
  isPersistError,
  persistToolResult,
} from '../../utils/toolResultStorage.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { serializeBridgeValue } from './serialization.js'

/**
 * Structured REPL output can be much larger than the concise block sent to
 * the model: the script source alone may be 100k chars, while result, stdout,
 * and stderr each have independent runtime caps. Keep a small shaped excerpt
 * in toolUseResult and spill the complete serialized output to the existing
 * per-session tool-results artifact store.
 */
export const REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS = 16_000
export const REPL_OUTPUT_PERSISTED_FIELD_CHARS = 4_000
const REPL_OUTPUT_PERSISTED_CODE_CHARS = 1_000
const REPL_OUTPUT_ARTIFACT_ID_SUFFIX = '-repl-output'
const REPL_OUTPUT_ERROR_FIELD_CHARS = 2_000
const REPL_OUTPUT_TOOLS_USED_CHARS = 1_800
const REPL_OUTPUT_INLINE_OVERHEAD_RESERVE_CHARS = 1_000
const REPL_OUTPUT_INLINE_MIN_EXCERPT_CHARS = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serializeOutputForArtifact(output: unknown): string {
  try {
    const direct = jsonStringify(output, null, 2)
    if (direct !== undefined) return direct
  } catch {
    // Fall through to the circular-safe bounded serializer below.
  }
  try {
    return jsonStringify(serializeBridgeValue(output), null, 2) ?? String(output)
  } catch {
    return '[unserializable REPL output]'
  }
}

function truncationMarker(originalLength: number, retainedLength: number): string {
  return `... [truncated ${originalLength - retainedLength} chars]`
}

function boundStringField(
  value: unknown,
  maxChars: number,
  truncatedFields: string[],
  field: string,
): unknown {
  if (typeof value !== 'string') return value
  if (value.length <= maxChars) return value
  truncatedFields.push(field)
  return `${value.slice(0, maxChars)}\n${truncationMarker(value.length, maxChars)}`
}

function boundUnknownField(
  value: unknown,
  maxChars: number,
  truncatedFields: string[],
  field: string,
): unknown {
  if (value === undefined) return value
  const serialized = typeof value === 'string'
    ? value
    : jsonStringify(value, null, 2) ?? String(serializeBridgeValue(value))
  if (serialized.length <= maxChars) return value
  truncatedFields.push(field)
  return `${serialized.slice(0, maxChars)}\n${truncationMarker(serialized.length, maxChars)}`
}

function boundToolsUsed(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const names: string[] = []
  let usedChars = 2
  let omitted = 0
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const name = entry.length > 80 ? `${entry.slice(0, 80)}... [truncated]` : entry
    const cost = name.length + 4
    if (usedChars + cost > REPL_OUTPUT_TOOLS_USED_CHARS) {
      omitted += 1
      continue
    }
    names.push(name)
    usedChars += cost
  }
  if (omitted > 0) names.push(`[truncated ${omitted} tool names]`)
  return names
}

function copyBoundedError(
  value: unknown,
  truncatedFields: string[],
): unknown {
  if (!isRecord(value)) return value
  return {
    ...(typeof value.name === 'string'
      ? { name: boundStringField(value.name, 200, truncatedFields, 'error.name') }
      : {}),
    ...(typeof value.message === 'string'
      ? { message: boundStringField(value.message, REPL_OUTPUT_ERROR_FIELD_CHARS, truncatedFields, 'error.message') }
      : {}),
    ...(typeof value.stack === 'string'
      ? { stack: boundStringField(value.stack, REPL_OUTPUT_ERROR_FIELD_CHARS, truncatedFields, 'error.stack') }
      : {}),
  }
}

function copyBoundedResidualInnerWork(value: unknown): unknown {
  if (!isRecord(value)) return value
  return {
    ...value,
    ...(typeof value.warning === 'string'
      ? { warning: value.warning.slice(0, 1_000) }
      : {}),
  }
}

const TRAILING_TRUNCATION_MARKER_PATTERN = /\n\.\.\. \[truncated (\d+) chars\]$/

function serializedInlineBytes(value: unknown): number {
  return Buffer.byteLength(jsonStringify(value) ?? '', 'utf8')
}

type InlineExcerptRef = {
  read: () => string
  write: (next: string) => void
}

function collectInlineExcerpts(bounded: Record<string, unknown>): InlineExcerptRef[] {
  const refs: InlineExcerptRef[] = []
  for (const key of ['code', 'result', 'stdout', 'stderr']) {
    if (typeof bounded[key] === 'string') {
      refs.push({
        read: () => bounded[key] as string,
        write: next => {
          bounded[key] = next
        },
      })
    }
  }
  if (isRecord(bounded.error)) {
    const error = bounded.error
    for (const key of ['message', 'stack']) {
      if (typeof error[key] === 'string') {
        refs.push({
          read: () => error[key] as string,
          write: next => {
            error[key] = next
          },
        })
      }
    }
  }
  return refs
}

function shrinkExcerpt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const existingMarker = value.match(TRAILING_TRUNCATION_MARKER_PATTERN)
  const base = value.replace(TRAILING_TRUNCATION_MARKER_PATTERN, '')
  // A previously truncated excerpt's marker records how much of the original
  // field was omitted. Recover that original length so further shrinking does
  // not under-report the total omission.
  const originalLength = base.length + (existingMarker ? Number(existingMarker[1]) : 0)

  // Fit the marker inside maxChars. The marker length depends on the omitted
  // digit count, which itself depends on the retained length, so iterate to a
  // fixed point. If even the shortest useful marker cannot fit, fall back to a
  // plain bounded slice rather than exceeding the reserve.
  let retained = maxChars
  for (let attempt = 0; attempt < 8; attempt++) {
    const marker = `\n${truncationMarker(originalLength, retained)}`
    const nextRetained = Math.max(0, maxChars - marker.length)
    if (nextRetained === retained) {
      if (retained === 0 && marker.length > maxChars) return base.slice(0, maxChars)
      return `${base.slice(0, retained)}${marker}`
    }
    retained = nextRetained
  }
  return base.slice(0, maxChars)
}

/**
 * The per-field caps bound raw characters, but the inline result is consumed
 * as serialized JSON: escaping can double a field, and the truncation
 * markers, metadata, and artifact preview add overhead the caps never
 * account for. Measure the serialized inline result and shrink the largest
 * excerpts until the total fits under the artifact threshold with headroom.
 */
function enforceInlineSizeBudget(bounded: Record<string, unknown>): void {
  const budget = REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS - REPL_OUTPUT_INLINE_OVERHEAD_RESERVE_CHARS
  for (let attempt = 0; attempt < 32; attempt++) {
    const excess = serializedInlineBytes(bounded) - budget
    if (excess <= 0) return
    const largest = collectInlineExcerpts(bounded)
      .filter(ref => ref.read().length > REPL_OUTPUT_INLINE_MIN_EXCERPT_CHARS)
      .sort((a, b) => b.read().length - a.read().length)[0]
    if (!largest) return
    const current = largest.read()
    const nextLength = Math.max(
      REPL_OUTPUT_INLINE_MIN_EXCERPT_CHARS,
      current.length - excess,
    )
    if (nextLength >= current.length) return
    largest.write(shrinkExcerpt(current, nextLength))
  }
}

/**
 * Return a bounded representation suitable for live state and transcript
 * persistence. The input object remains unchanged for model mapping, hooks,
 * and direct in-process callers; this function is applied only when the
 * canonical tool runner commits the user message.
 */
export async function boundReplToolUseResultForPersistence(
  output: unknown,
  toolUseID: string,
): Promise<unknown> {
  if (!isRecord(output)) return output
  const serialized = serializeOutputForArtifact(output)
  if (serialized.length <= REPL_OUTPUT_ARTIFACT_THRESHOLD_CHARS) return output

  const persisted = await persistToolResult(
    serialized,
    `${toolUseID}${REPL_OUTPUT_ARTIFACT_ID_SUFFIX}`,
  )
  const originalSizeBytes = Buffer.byteLength(serialized, 'utf8')
  const truncatedFields: string[] = []
  const bounded: Record<string, unknown> = {}

  if (output.status !== undefined) bounded.status = output.status
  if (output.code !== undefined) {
    bounded.code = boundStringField(
      output.code,
      REPL_OUTPUT_PERSISTED_CODE_CHARS,
      truncatedFields,
      'code',
    )
  }
  if (output.result !== undefined) {
    bounded.result = boundUnknownField(
      output.result,
      REPL_OUTPUT_PERSISTED_FIELD_CHARS,
      truncatedFields,
      'result',
    )
  }
  if (output.error !== undefined) {
    bounded.error = copyBoundedError(output.error, truncatedFields)
  }
  if (output.stdout !== undefined) {
    bounded.stdout = boundStringField(
      output.stdout,
      REPL_OUTPUT_PERSISTED_FIELD_CHARS,
      truncatedFields,
      'stdout',
    )
  }
  if (output.stderr !== undefined) {
    bounded.stderr = boundStringField(
      output.stderr,
      REPL_OUTPUT_PERSISTED_FIELD_CHARS,
      truncatedFields,
      'stderr',
    )
  }
  if (output.durationMs !== undefined) bounded.durationMs = output.durationMs
  if (output.toolsUsed !== undefined) bounded.toolsUsed = boundToolsUsed(output.toolsUsed)
  if (output.residualInnerWork !== undefined) {
    bounded.residualInnerWork = copyBoundedResidualInnerWork(output.residualInnerWork)
  }

  bounded.persistedOutputSize = originalSizeBytes
  bounded.persistedOutputTruncatedFields = truncatedFields
  if (isPersistError(persisted)) {
    bounded.persistedOutputError = persisted.error
  } else {
    bounded.persistedOutputPath = persisted.filepath
    bounded.persistedOutputPreview = persisted.preview
    if (persisted.truncated === true) bounded.persistedOutputTruncated = true
  }
  enforceInlineSizeBudget(bounded)
  return bounded
}
