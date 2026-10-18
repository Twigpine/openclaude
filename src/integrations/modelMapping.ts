/**
 * Type guard: returns true when the value is a non-null object.
 * Used to safely narrow unknown payloads before reading keys.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Returns a trimmed string from a record, or undefined if the key is
 * missing or the value is not a string. Trims whitespace from both ends.
 */
export function getTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : undefined
}

/**
 * Returns the first finite positive number from the variadic arguments.
 * Skips non-numbers, NaN, Infinity, and values <= 0.
 */
export function firstPositiveNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return undefined
}

/**
 * Heuristic check for model IDs that are clearly not coding-capable chat models.
 * Matches common embedding, audio, image, moderation, and speech model name patterns.
 */
export function isKnownNonCodingModelId(id: string): boolean {
  return /(audio|dall-e|embedding|image|moderation|realtime|rerank|sora|speech|transcribe|translate|tts|whisper)/i.test(
    id,
  )
}

/**
 * Detects whether a model is free-tier based on common OpenRouter/OpenGateway
 * conventions: an ID ending with `:free`, or a `free`/`is_free` boolean flag
 * in the raw payload.
 */
export function isFreeModel(
  id: string,
  raw: Record<string, unknown>,
): boolean {
  return (
    id.toLowerCase().endsWith(':free') ||
    raw.free === true ||
    raw.is_free === true
  )
}
