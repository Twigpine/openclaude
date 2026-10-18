/**
 * Compresses old tool_result content for stateless OpenAI-compatible providers
 * (Copilot, Mistral, Ollama). Preserves all conversation structure — tool_use,
 * tool_result pairing, text, thinking, and is_error all survive intact. Only
 * the BULK text of older tool_results is shrunk to delay context saturation.
 *
 * Tier sizes scale with the model's effective context window via
 * getEffectiveContextWindowSize() — same calculation used by auto-compact, so
 * the two systems stay aligned.
 *
 * Complements (does not replace) microCompact.ts:
 * - microCompact: time/cache-based, runs from query.ts, binary clear/keep,
 *   limited to Claude (cache editing) or idle gaps (time-based).
 * - compressToolHistory: size-based, runs at the shim layer, tiered
 *   compression, covers the gap for active sessions on non-Claude providers.
 *
 * Reuses isCompactableTool from microCompact to avoid touching tools the
 * project already classifies as unsafe to compress (e.g. Task, Agent).
 * Skips blocks already cleared by microCompact (TOOL_RESULT_CLEARED_MESSAGE).
 * Blocks this module already compressed are handled tier-aware: over the SAME
 * input a second pass is a no-op (stubs and mid-tier truncations are at their
 * target form), but as new exchanges age a truncated block into the old tier
 * it still upgrades to a stub — carrying the pre-truncation length recovered
 * from the marker. That idempotence-without-staleness matters because
 * claude.ts also calls this for Anthropic-native transports when prompt
 * caching is inactive — layered call sites must not re-mangle output, yet
 * aging blocks must keep shrinking.
 */
import { getEffectiveContextWindowSize } from '../compact/autoCompact.js'
import { isCompactableTool } from '../compact/microCompact.js'
import { TOOL_RESULT_CLEARED_MESSAGE } from '../../utils/toolResultStorage.js'
import { getGlobalConfig } from '../../utils/config.js'

// Mid-tier truncation budget. 2k chars ≈ 500 tokens, enough to preserve the
// shape of most tool outputs (file headers, command stderr, top grep hits)
// without ballooning context. Bump too high and the tier loses its purpose.
const MID_MAX_CHARS = 2_000

// Stub args budget. JSON.stringify of a typical tool input fits in 200 chars
// (file paths, short commands, small queries). Long inputs are rare and clamping
// here keeps the stub size bounded even when callers pass oversized arguments.
const STUB_ARGS_MAX_CHARS = 200

// Inline image payloads can be megabytes long. Older tool history must not
// retain them merely because they are structured rather than text.
const OMITTED_INLINE_IMAGE_MARKER = '[Inline image omitted from tool history]'

type AnyMessage = {
  role?: string
  message?: { role?: string; content?: unknown }
  content?: unknown
  toolUseResult?: unknown
  imagePermissionToolUseIds?: Array<string | null>
}

type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

type ToolUseBlock = {
  type: 'tool_use'
  id?: string
  name?: string
  input?: unknown
}

type Tiers = { recent: number; mid: number }

// Tier sizes scale with effective window. Targets roughly:
// - recent tier stays under ~25% of available window (full fidelity kept)
// - recent + mid tier stays under ~50% of available window (bounded bulk)
// - everything older collapses to ~15-token stubs
// Values assume ~5KB avg tool_result, which matches the Copilot default case
// (parallel_tool_calls=true means multiple Read/Bash outputs per turn). For
// ≥ 500k models the tiers are so generous that compression is effectively
// inert for any realistic session — see compressToolHistory.test.ts.
export function getTiers(effectiveWindow: number): Tiers {
  if (effectiveWindow < 16_000) return { recent: 2, mid: 3 }
  if (effectiveWindow < 32_000) return { recent: 3, mid: 5 }
  if (effectiveWindow < 64_000) return { recent: 4, mid: 8 }
  if (effectiveWindow < 128_000) return { recent: 5, mid: 10 }
  if (effectiveWindow < 256_000) return { recent: 8, mid: 15 }
  if (effectiveWindow < 500_000) return { recent: 12, mid: 25 }
  return { recent: 25, mid: 50 }
}

let toolHistoryCompressionEnabledOverrideForTest: boolean | undefined

export function setToolHistoryCompressionEnabledOverrideForTest(
  enabled: boolean | undefined,
): void {
  toolHistoryCompressionEnabledOverrideForTest = enabled
}

function extractText(content: unknown, separator: string): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter(
        (b: { type?: string; text?: string }) =>
          b?.type === 'text' && typeof b.text === 'string',
      )
      .map((b: { text?: string }) => b.text ?? '')
      .join(separator)
  }
  return ''
}

function isInlineImagePayload(part: unknown): boolean {
  if (!part || typeof part !== 'object' || (part as { type?: string }).type !== 'image') {
    return false
  }

  const source = (part as { source?: { type?: string; url?: string } }).source
  return source?.type === 'base64' ||
    (source?.type === 'url' && typeof source.url === 'string' &&
      /^data:image\//i.test(source.url))
}

function omitInlineImagePayloads(block: ToolResultBlock): ToolResultBlock {
  if (!Array.isArray(block.content)) return block

  let omittedImage = false
  const content = block.content.map(part => {
    if (isInlineImagePayload(part)) {
      omittedImage = true
      return { type: 'text', text: OMITTED_INLINE_IMAGE_MARKER }
    }
    return part
  })

  return omittedImage ? { ...block, content } : block
}

function sanitizeClearedBlock(block: ToolResultBlock): ToolResultBlock {
  if (!Array.isArray(block.content)) return block
  const content = block.content.filter(part => !isInlineImagePayload(part))
  return content.length === block.content.length ? block : { ...block, content }
}

function replaceTextContent(
  block: ToolResultBlock,
  replacementText: string,
): ToolResultBlock {
  block = omitInlineImagePayloads(block)
  if (!Array.isArray(block.content)) {
    return {
      ...block,
      content: [{ type: 'text', text: replacementText }],
    }
  }

  let replacedText = false
  const content = block.content.flatMap(part => {
    if (
      part &&
      typeof part === 'object' &&
      (part as { type?: string }).type === 'text'
    ) {
      if (replacedText) return []
      replacedText = true
      return [{ ...part, text: replacementText }]
    }
    return [part]
  })

  if (!replacedText && content.length === 0) {
    return {
      ...block,
      content: [{ type: 'text', text: replacementText }],
    }
  }

  return { ...block, content }
}

function truncateTextContent(
  block: ToolResultBlock,
  maxChars: number,
  originalLength: number,
  separator: string,
): ToolResultBlock {
  const marker = `\n[…truncated ${originalLength - maxChars} chars from tool history]`
  if (!Array.isArray(block.content)) {
    const text = typeof block.content === 'string' ? block.content : ''
    return {
      ...block,
      content: [{ type: 'text', text: `${text.slice(0, maxChars)}${marker}` }],
    }
  }

  const content: unknown[] = []
  let remaining = maxChars
  let sawText = false
  let truncated = false
  let lastTextIndex = -1

  const appendMarker = (): void => {
    const part = content[lastTextIndex] as { text?: string } | undefined
    if (part && typeof part.text === 'string') {
      content[lastTextIndex] = { ...part, text: `${part.text}${marker}` }
    }
  }

  for (const part of block.content) {
    if (
      !part ||
      typeof part !== 'object' ||
      (part as { type?: string }).type !== 'text' ||
      typeof (part as { text?: unknown }).text !== 'string'
    ) {
      content.push(part)
      continue
    }
    if (truncated) continue

    const text = (part as { text: string }).text
    const separatorChars = sawText ? separator.length : 0
    sawText = true
    if (remaining <= separatorChars) {
      appendMarker()
      truncated = true
      continue
    }

    remaining -= separatorChars
    const retained = text.slice(0, remaining)
    remaining -= retained.length
    content.push({ ...part, text: retained })
    lastTextIndex = content.length - 1
    if (retained.length < text.length || remaining === 0) {
      appendMarker()
      truncated = true
    }
  }

  return { ...block, content }
}

// Old-tier compression strategy. Replaces content entirely with a one-line
// metadata marker ~10× more token-efficient than a 500-char truncation AND
// unambiguous — partial truncations can look authoritative to the model. The
// stub format encodes tool name + args so the model can re-invoke the same
// tool if it needs the omitted output back.
function buildStub(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
  separator: string,
  // For blocks already truncated on an earlier pass: the true pre-truncation
  // length recovered from the marker, so the stub reports what the tool
  // actually returned instead of the truncated remnant's size.
  originalLengthOverride?: number,
): ToolResultBlock {
  const original = extractText(block.content, separator)
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  const name = toolUse?.name ?? 'tool'
  const args = toolUse?.input
    ? JSON.stringify(toolUse.input).slice(0, STUB_ARGS_MAX_CHARS)
    : '{}'
  return replaceTextContent(
    block,
    `[${name} args=${args} → ${originalLengthOverride ?? original.length} chars omitted]`,
  )
}

// Mid-tier compression. The trailing marker is load-bearing: without it, the
// model can't distinguish "tool returned 2000 chars" from "tool returned 20k
// chars that we cut to 2000". Distinguishing those matters for the model's
// decision to re-invoke the tool.
function truncateBlock(
  block: ToolResultBlock,
  maxChars: number,
  separator: string,
): ToolResultBlock {
  block = omitInlineImagePayloads(block)
  const text = extractText(block.content, separator)
  if (text.length <= maxChars) return block
  return truncateTextContent(block, maxChars, text.length, separator)
}

function getInner(msg: AnyMessage): { role?: string; content?: unknown } {
  return (msg.message ?? msg) as { role?: string; content?: unknown }
}

function indexToolUses(messages: AnyMessage[]): Map<string, ToolUseBlock> {
  const map = new Map<string, ToolUseBlock>()
  for (const msg of messages) {
    const content = getInner(msg).content
    if (!Array.isArray(content)) continue
    for (const b of content as Array<{ type?: string; id?: string }>) {
      if (b?.type === 'tool_use' && b.id) {
        map.set(b.id, b as ToolUseBlock)
      }
    }
  }
  return map
}

function indexToolResults(
  messages: AnyMessage[],
): Array<{ messageIndex: number; blockIndex: number }> {
  const indices: Array<{ messageIndex: number; blockIndex: number }> = []
  for (let i = 0; i < messages.length; i++) {
    const inner = getInner(messages[i])
    const role = inner.role ?? messages[i].role
    const content = inner.content
    if (role !== 'user' || !Array.isArray(content)) continue
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      if ((content[blockIndex] as { type?: string })?.type === 'tool_result') {
        indices.push({ messageIndex: i, blockIndex })
      }
    }
  }
  return indices
}

function rewriteMessage<T extends AnyMessage>(
  msg: T,
  newContent: unknown[],
): T {
  if (msg.message) {
    return { ...msg, message: { ...msg.message, content: newContent } }
  }
  return { ...msg, content: newContent }
}

// microCompact.maybeTimeBasedMicrocompact may have already replaced old
// tool_result content with TOOL_RESULT_CLEARED_MESSAGE before we see it.
// Re-compressing produces a stub over a marker (e.g. `[Read args={} → 40
// chars omitted]`), wasteful and less informative than the canonical marker.
function isAlreadyCleared(block: ToolResultBlock): boolean {
  const text = extractText(block.content, '\n\n')
  return text === TOOL_RESULT_CLEARED_MESSAGE
}

// Output of buildStub / truncateBlock from a previous pass. Idempotency across
// layered call sites (claude.ts + the shim can both run this) is TIER-AWARE,
// not a blanket skip: a stub is the terminal form and is never re-stubbed
// (that would replace `→ 45000 chars omitted` with a misleading `→ 58 chars
// omitted`), and a truncated block is left alone only while it is still in
// the mid tier — when later exchanges age it into the old tier it upgrades to
// a stub, with the omitted-chars count recovered from the truncation marker
// so it reflects the ORIGINAL output length, not the truncated remnant.
const STUB_MARKER_RE = /^\[[^\n]* args=[^\n]* → \d+ chars omitted\]$/
const TRUNCATION_MARKER_RE = /\n\[…truncated (\d+) chars from tool history\]$/

type CompressedState =
  | { kind: 'fresh' }
  | { kind: 'stub' }
  | { kind: 'truncated'; originalLength: number }

function getCompressedState(
  block: ToolResultBlock,
  separator: string,
): CompressedState {
  const text = extractText(block.content, separator)
  if (STUB_MARKER_RE.test(text)) return { kind: 'stub' }
  const truncation = text.match(TRUNCATION_MARKER_RE)
  if (truncation) {
    // truncateTextContent kept `original - omitted` visible chars and encodes
    // the omitted remainder in the marker; stripping the marker text itself
    // recovers the pre-truncation length exactly.
    const omitted = Number(truncation[1])
    const visible = text.replace(TRUNCATION_MARKER_RE, '').length
    return { kind: 'truncated', originalLength: visible + omitted }
  }
  return { kind: 'fresh' }
}

function shouldCompressBlock(
  block: ToolResultBlock,
  toolUsesById: Map<string, ToolUseBlock>,
): boolean {
  if (isAlreadyCleared(block)) return false
  const toolUse = toolUsesById.get(block.tool_use_id ?? '')
  // Unknown tool name (orphan tool_result with no matching tool_use) falls
  // through to compression with a generic "tool" stub. Safer default: the
  // original tool_use vanished so there's no downstream use for the output.
  if (!toolUse?.name) return true
  // Respect microCompact's curated safe-to-compress set (Read/Bash/Grep/…/
  // mcp__*) so user-facing flow tools (Task, Agent, custom) stay intact.
  return isCompactableTool(toolUse.name)
}

export function compressToolHistory<T extends AnyMessage>(
  messages: T[],
  model: string,
  options: {
    effectiveContextWindowSize?: number
    textBlockSeparator?: string
    runtimeLimits?: { contextWindow?: number; maxOutputTokens?: number }
  } = {},
): T[] {
  // Master kill-switch. Returns the original reference so callers skip a
  // defensive copy when the feature is disabled.
  const compressionEnabled =
    toolHistoryCompressionEnabledOverrideForTest ??
    getGlobalConfig().toolHistoryCompressionEnabled
  if (!compressionEnabled) return messages

  const tiers = getTiers(
    options.effectiveContextWindowSize ?? getEffectiveContextWindowSize(
      model,
      options.runtimeLimits,
    ),
  )
  const textBlockSeparator = options.textBlockSeparator ?? '\n\n'

  const toolResults = indexToolResults(messages)
  const total = toolResults.length
  // If every tool-result fits in the recent tier, no boundary crosses; return
  // the same reference for the same copy-elision reason.
  if (total <= tiers.recent) return messages

  // O(1) lookup within each carrier message: blockIndex → tool-result position
  // (0 = oldest). Parallel results share a message but receive distinct tiers.
  const positionsByMessage = new Map<number, Map<number, number>>()
  for (let pos = 0; pos < toolResults.length; pos++) {
    const { messageIndex, blockIndex } = toolResults[pos]
    let positions = positionsByMessage.get(messageIndex)
    if (!positions) {
      positions = new Map<number, number>()
      positionsByMessage.set(messageIndex, positions)
    }
    positions.set(blockIndex, pos)
  }

  const toolUsesById = indexToolUses(messages)

  return messages.map((msg, i) => {
    const positions = positionsByMessage.get(i)
    if (!positions) return msg
    const firstPos = positions.values().next().value
    if (firstPos === undefined || total - 1 - firstPos < tiers.recent) return msg

    const content = getInner(msg).content as unknown[]
    const pendingImagePermissionToolUseIds = [
      ...(msg.imagePermissionToolUseIds ?? []),
    ]
    const omittedPermissionImageToolUseIds = new Set<string>()
    const newContent = content.map((block, blockIndex) => {
      if ((block as { type?: string })?.type === 'image') {
        const toolUseId = pendingImagePermissionToolUseIds.shift()
        if (
          toolUseId &&
          omittedPermissionImageToolUseIds.has(toolUseId) &&
          isInlineImagePayload(block)
        ) {
          return { type: 'text', text: OMITTED_INLINE_IMAGE_MARKER }
        }
        return block
      }

      const pos = positions.get(blockIndex)
      if (pos === undefined) return block
      const fromEnd = total - 1 - pos
      if (fromEnd < tiers.recent) return block

      const tr = block as ToolResultBlock
      if (tr.tool_use_id) omittedPermissionImageToolUseIds.add(tr.tool_use_id)
      if (isAlreadyCleared(tr)) {
        return sanitizeClearedBlock(tr)
      }
      if (!shouldCompressBlock(tr, toolUsesById)) return block
      const inMidTier = fromEnd < tiers.recent + tiers.mid
      const state = getCompressedState(tr, textBlockSeparator)
      // Stubs are terminal. Truncated blocks are at target while mid-tier;
      // once aged into the old tier they upgrade to a stub carrying the
      // recovered pre-truncation length.
      if (state.kind === 'stub') return block
      if (state.kind === 'truncated') {
        return inMidTier
          ? block
          : buildStub(tr, toolUsesById, textBlockSeparator, state.originalLength)
      }
      return inMidTier
        ? truncateBlock(tr, MID_MAX_CHARS, textBlockSeparator)
        : buildStub(tr, toolUsesById, textBlockSeparator)
    })

    return rewriteMessage(msg, newContent)
  })
}
