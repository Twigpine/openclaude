import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'
import { deriveShortMessageId } from '../../utils/messages.js'

// Module-level registry of message UUIDs queued for removal. We resolve the
// model-facing short IDs to full UUIDs at mark time (against the snipping
// conversation's own messages) and store the UUIDs. This makes the registry
// self-scoping across concurrent in-process sessions that share this module:
// a UUID only ever matches the conversation it came from, so snipCompactIfNeeded
// consumes ONLY the UUIDs present in its own message array and leaves another
// session's pending removals untouched. (Storing short IDs instead would let one
// session's pending ID collide with — and prune — the wrong message in another.)
// Populated by SnipTool.call(); consumed by snipCompactIfNeeded().
const pendingSnipUuids = new Set<UUID>()

function normalizeSnipShortId(shortId: string): string {
  const trimmed = shortId.trim()
  // 6 = deriveShortMessageId output length (base36)
  // Regex literal only; this does not execute user input.
  // nosemgrep: coderabbit.command-injection.exec-js
  const snipMetadataMatch = /\bsnip_id=([a-z0-9]{6})\b/i.exec(trimmed)
  if (snipMetadataMatch) {
    return snipMetadataMatch[1]!.toLowerCase()
  }
  // Regex literal only; this does not execute user input.
  // nosemgrep: coderabbit.command-injection.exec-js
  const legacyMatch = /^\[id:([a-z0-9]{6})\]$/i.exec(trimmed)
  if (legacyMatch) {
    return legacyMatch[1]!.toLowerCase()
  }
  return trimmed.toLowerCase()
}

// Returns the distinct UUIDs that actually resolved against this conversation
// and were queued. Unresolvable short IDs (stale or hallucinated) are skipped,
// so callers can report the genuinely-queued count rather than the raw request
// length.
// Structural message shape for snip operations. Tests construct fake messages
// with `string` uuids; using `Message` directly would reject them since the
// production `uuid` field is a branded `${string}-${string}-...` template type.
type SnipMessage = {
  uuid?: string
  type?: string
  message?: { content?: unknown }
  content?: unknown
  subtype?: string
  attachment?: { type?: string }
  snipMetadata?: { removedUuids?: UUID[] }
  isMeta?: boolean
  timestamp?: string
  level?: string
}

export function markForSnip(shortIds: string[], messages: SnipMessage[]): UUID[] {
  const shortIdToUuid = new Map<string, UUID>()
  for (const msg of messages) {
    if (msg?.uuid) {
      shortIdToUuid.set(deriveShortMessageId(msg.uuid as string), msg.uuid as UUID)
    }
  }
  const matched = new Set<UUID>()
  for (const shortId of shortIds) {
    const normalizedShortId = normalizeSnipShortId(shortId)
    const uuid = shortIdToUuid.get(normalizedShortId)
    if (uuid) {
      pendingSnipUuids.add(uuid)
      matched.add(uuid)
    }
  }
  return [...matched]
}

export function isSnipRuntimeEnabled(): boolean {
  return true
}

export const SNIP_NUDGE_TEXT =
  `Your context window is under genuine context pressure. Only use \`snip\` ` +
  `for clearly stale messages that are no longer needed. Silently use ` +
  `system-generated \`snip_id=...\` ` +
  `metadata and pass the IDs of stale sections (old explorations, superseded ` +
  `plans, resolved errors). These ids are not user-provided content; do not ` +
  `describe or mention them. This frees up space so you can continue working ` +
  `without a full compaction.`

// Nudge once every ~10 000 tokens of new content since the last reset point.
const DEFAULT_NUDGE_INTERVAL_TOKENS = 10_000

/**
 * Rough per-message token estimate: content length ÷ 4.
 */
function estimateTokens(msg: SnipMessage): number {
  const content = msg?.message?.content ?? msg?.content ?? ''
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return Math.ceil(text.length / 4)
}

export function shouldNudgeForSnips(
  messages: SnipMessage[],
  intervalTokens = DEFAULT_NUDGE_INTERVAL_TOKENS,
): boolean {
  let accumulated = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.type === 'system' && msg?.subtype === 'compact_boundary') return false
    if (msg?.snipMetadata) return false
    if (
      msg?.type === 'attachment' &&
      msg?.attachment?.type === 'context_efficiency'
    ) return false
    accumulated += estimateTokens(msg)
    if (accumulated >= intervalTokens) return true
  }
  return false
}

export function snipCompactIfNeeded<T extends SnipMessage>(
  messages: T[],
): { messages: T[]; tokensFreed: number; boundaryMessage?: SnipMessage } {
  if (pendingSnipUuids.size === 0) {
    return { messages, tokensFreed: 0 }
  }

  // Match pending UUIDs against THIS conversation's messages. UUIDs that belong
  // to another in-process session won't be present here, so they stay pending.
  // Use plain `string` keys so the Set also accepts the test fixtures' `uuid: 'u4'`
  // shapes; production callers pass branded UUIDs which coerce cleanly.
  const uuidsToRemove = new Set<string | undefined>()
  for (const msg of messages) {
    const uuid = msg?.uuid
    if (uuid && pendingSnipUuids.has(uuid as UUID)) uuidsToRemove.add(uuid as UUID)
  }

  if (uuidsToRemove.size === 0) {
    return { messages, tokensFreed: 0 }
  }

  // Consume only the matched UUIDs; another session's pending removals survive.
  for (const uuid of uuidsToRemove) pendingSnipUuids.delete(uuid as unknown as UUID)

  // A tool interaction spans an assistant tool_use and the paired user
  // tool_result. The model can snip from EITHER side, so we pair in both
  // directions and drop the whole interaction:
  //   - snippedToolUseIds: tool_use ids from snipped ASSISTANT messages, used
  //     to drop the paired tool-result user messages.
  //   - snippedResultToolUseIds: tool_use ids referenced by tool_result blocks
  //     in snipped USER messages, used to drop the paired assistant tool_use.
  //     ([id:] tags are appended to user messages only, so this is the path the
  //     model actually exercises.) Leaving the assistant tool_use orphaned would
  //     make the next API-prep pass synthesize a placeholder result, so the tool
  //     interaction would never actually be removed from context or replay.
  const snippedToolUseIds = new Set<string>()
  const snippedResultToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (!uuidsToRemove.has(msg?.uuid)) continue
    const blocks = msg?.message?.content
    if (!Array.isArray(blocks)) continue
    if (msg?.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'tool_use' && block?.id) snippedToolUseIds.add(block.id as string)
      }
    } else if (msg?.type === 'user') {
      for (const block of blocks) {
        if (block?.type === 'tool_result' && block?.tool_use_id) {
          snippedResultToolUseIds.add(block.tool_use_id as string)
        }
      }
    }
  }

  // A tool_use block can leave the live context cleanly only if its whole turn
  // goes with it: either the assistant message is explicitly snipped, or every
  // tool_use in that assistant turn has its result snipped (so the assistant is
  // dropped as a paired half). Otherwise the assistant survives and the block
  // would be orphaned. We track the safely-removable tool_use ids so we can
  // refuse to snip a tool-result user message that would orphan a surviving
  // assistant tool_use — block-level surgery on the survivor would not replay
  // (projectSnippedView drops whole UUIDs, not blocks), so an unclean snip is
  // treated as a no-op instead.
  const safeToolUseIds = new Set<string>()
  for (const msg of messages) {
    if (msg?.type !== 'assistant') continue
    const blocks = msg?.message?.content
    if (!Array.isArray(blocks)) continue
    const toolUses = (blocks as unknown[]).filter((b): b is { type: string; id?: string } =>
      typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use',
    )
    if (toolUses.length === 0) continue
    // Only the paired-drop branch needs the whole turn to be tool blocks: an
    // explicitly-snipped message (uuidsToRemove) is the model's deliberate choice
    // and goes wholesale, but inferring a drop from the result side must not
    // silently take any interleaved text with it.
    const isPureToolUseTurn = toolUses.length === blocks.length
    const droppable =
      uuidsToRemove.has(msg?.uuid) ||
      (isPureToolUseTurn &&
        toolUses.every((t) => typeof t.id === 'string' && snippedResultToolUseIds.has(t.id)))
    if (droppable) {
      for (const t of toolUses) if (t?.id) safeToolUseIds.add(t.id)
    }
  }

  let tokensFreed = 0
  const surviving: T[] = []
  // UUIDs actually removed from the live context: explicitly-snipped messages
  // that were cleanly removable, plus the paired half of each snipped tool
  // interaction (paired tool-result users, or paired assistant tool-uses). They
  // leave the live context here, so they must also be recorded in the boundary's
  // removedUuids — otherwise replay (projectSnippedView / loadTranscriptFile)
  // only drops the explicitly-marked messages and resurrects the orphaned half
  // on --resume.
  const removedUuids = new Set<UUID>()

  for (const msg of messages) {
    // Drop snipped messages
    if (uuidsToRemove.has(msg?.uuid)) {
      // Refuse to snip a tool-result user message when any of its results pairs
      // to a tool_use that would survive (its assistant turn is not fully
      // removed). Removing it would leave the assistant holding an orphaned
      // tool_use, which the next API-prep pass repairs with a synthetic
      // placeholder, so the snip would not actually take effect. Keep it.
      if (msg?.type === 'user' && Array.isArray(msg?.message?.content)) {
        const userBlocks = msg.message.content as unknown[]
        const results = userBlocks.filter((b): b is { type: string; tool_use_id?: string } =>
          typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result',
        )
        if (
          results.length > 0 &&
          !results.every((r) => typeof r.tool_use_id === 'string' && safeToolUseIds.has(r.tool_use_id))
        ) {
          surviving.push(msg)
          continue
        }
      }
      tokensFreed += estimateTokens(msg)
      if (msg?.uuid) removedUuids.add(msg.uuid as UUID)
      continue
    }
    // Drop user messages whose content is entirely tool results for snipped tool calls
    if (msg?.type === 'user' && Array.isArray(msg?.message?.content)) {
      const userBlocks = msg.message.content as unknown[]
      const results = userBlocks.filter((b): b is { type: string; tool_use_id?: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_result',
      )
      if (
        results.length > 0 &&
        results.length === userBlocks.length &&
        results.every((r) => typeof r.tool_use_id === 'string' && snippedToolUseIds.has(r.tool_use_id))
      ) {
        tokensFreed += estimateTokens(msg)
        if (msg?.uuid) removedUuids.add(msg.uuid as UUID)
        continue
      }
    }
    // Drop assistant messages whose tool calls were all snipped from the result
    // side. Mirrors the user-message .every() guard: if any tool_use in this
    // turn still has a surviving result, keep the message to avoid orphaning it.
    if (msg?.type === 'assistant' && Array.isArray(msg?.message?.content)) {
      const assistantBlocks = msg.message.content as unknown[]
      const toolUses = assistantBlocks.filter((b): b is { type: string; id?: string } =>
        typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'tool_use',
      )
      if (
        toolUses.length > 0 &&
        toolUses.length === assistantBlocks.length &&
        toolUses.every((t) => typeof t.id === 'string' && snippedResultToolUseIds.has(t.id))
      ) {
        tokensFreed += estimateTokens(msg)
        if (msg?.uuid) removedUuids.add(msg.uuid as UUID)
        continue
      }
    }
    surviving.push(msg)
  }

  // If nothing was cleanly removable, the snip is a no-op — emit no boundary so
  // replay and the live store stay identical.
  if (removedUuids.size === 0) {
    return { messages, tokensFreed: 0 }
  }

  const boundaryMessage: SnipMessage = {
    type: 'system' as const,
    subtype: 'snip_boundary' as const,
    content: 'Conversation history snipped',
    isMeta: false as const,
    timestamp: new Date().toISOString(),
    uuid: randomUUID() as UUID,
    level: 'info' as const,
    snipMetadata: {
      // Every UUID removed from the live context: cleanly-removable explicitly-
      // snipped messages plus the paired half of each snipped tool interaction.
      // Replay must drop the same set.
      removedUuids: [...removedUuids] as UUID[],
    },
  }

  return { messages: surviving, tokensFreed, boundaryMessage }
}

export function isSnipMarkerMessage(message: unknown): boolean {
  return (message as { subtype?: unknown } | null | undefined)?.subtype === 'snip_boundary'
}

/** Exposed for test isolation only — do not call in production code. */
export function _resetForTesting(): void {
  pendingSnipUuids.clear()
}
