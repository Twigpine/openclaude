/**
 * Maximum tool-call id length accepted by the OpenAI Responses API (the
 * Anthropic API shares the same practical bound).
 */
export const MAX_WIRE_TOOL_ID_LENGTH = 64

/**
 * Sanitize a history tool_use id for an outgoing wire.
 *
 * The Gemini Vertex client smuggles Gemini thought signatures into tool_use
 * ids (`toolu_vertex_x~~sig~~<base64>`, up to ~1.8k chars) so they survive
 * session persistence. Other wires must never see them: OpenAI rejects ids
 * over the length limit and Anthropic rejects ids outside [A-Za-z0-9_-].
 * Cut at the first foreign character (no legitimate id contains one), then
 * cap deterministically with a hash tail so distinct overlong ids stay
 * distinct. Dependency-free so shims and message normalization can share it.
 */
export function sanitizeToolUseIdForWire(
  value: string,
  maxLength = MAX_WIRE_TOOL_ID_LENGTH,
): string {
  const clean = value.replace(/[^A-Za-z0-9_-][\s\S]*$/, '')
  if (clean.length > 0 && clean.length <= maxLength) {
    return clean
  }
  // Deterministic non-cryptographic hash of the FULL original value (FNV-1a)
  // — keeps distinct ids distinct even when their clean prefixes collide.
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const tail = `_${hash.toString(36)}`
  if (clean.length === 0) {
    return `tool${tail}`
  }
  // Defensive: keep at least one prefix char if a caller ever passes a
  // maxLength smaller than the hash tail (all current call sites use >= 40).
  const prefixLength = Math.max(1, maxLength - tail.length)
  return clean.slice(0, prefixLength) + tail
}
