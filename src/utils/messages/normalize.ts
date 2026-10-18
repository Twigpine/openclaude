import type { UUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type {
  NormalizedAssistantMessage,
  NormalizedMessage,
  NormalizedUserMessage,
  Message,
  AssistantMessage,
  UserMessage,
} from '../../types/message.js'

function createNormalizedUserBlockMessage({
  source,
  content,
  imagePasteIds,
  imagePermissionToolUseIds,
  uuid,
}: {
  source: UserMessage
  content: ContentBlockParam[]
  imagePasteIds?: number[]
  imagePermissionToolUseIds?: Array<string | null>
  uuid: UUID
}): UserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    isMeta: source.isMeta,
    isVisibleInTranscriptOnly: source.isVisibleInTranscriptOnly,
    isVirtual: source.isVirtual,
    isCollapseSummary: source.isCollapseSummary,
    uuid,
    timestamp: source.timestamp,
    toolUseResult: source.toolUseResult,
    imagePermissionToolUseIds,
    mcpMeta: source.mcpMeta,
    imagePasteIds,
    origin: source.origin,
  }
}

// Deterministic UUID derivation. Produces a stable UUID-shaped string from a
// parent UUID + content block index so that the same input always produces the
// same key across calls. Used by normalizeMessages and synthetic message creation.
export function deriveUUID(parentUUID: UUID, index: number): UUID {
  const hex = index.toString(16).padStart(12, '0')
  return `${parentUUID.slice(0, 24)}${hex}` as UUID
}

// Split messages, so each content block gets its own message
export function normalizeMessages(
  messages: AssistantMessage[],
): NormalizedAssistantMessage[]
export function normalizeMessages(
  messages: UserMessage[],
): NormalizedUserMessage[]
export function normalizeMessages(
  messages: (AssistantMessage | UserMessage)[],
): (NormalizedAssistantMessage | NormalizedUserMessage)[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[]
export function normalizeMessages(messages: Message[]): NormalizedMessage[] {
  // isNewChain tracks whether we need to generate new UUIDs for messages when normalizing.
  // When a message has multiple content blocks, we split it into multiple messages,
  // each with a single content block. When this happens, we need to generate new UUIDs
  // for all subsequent messages to maintain proper ordering and prevent duplicate UUIDs.
  // This flag is set to true once we encounter a message with multiple content blocks,
  // and remains true for all subsequent messages in the normalization process.
  let isNewChain = false
  return messages.flatMap(message => {
    switch (message.type) {
      case 'assistant': {
        isNewChain = isNewChain || message.message.content.length > 1
        return message.message.content.map((_, index) => {
          const uuid = isNewChain
            ? deriveUUID(message.uuid, index)
            : message.uuid
          return {
            type: 'assistant' as const,
            timestamp: message.timestamp,
            message: {
              ...message.message,
              content: [_],
              context_management: message.message.context_management ?? null,
            },
            isMeta: message.isMeta,
            isVirtual: message.isVirtual,
            requestId: message.requestId,
            uuid,
            error: message.error,
            isApiErrorMessage: message.isApiErrorMessage,
            advisorModel: message.advisorModel,
          } as NormalizedAssistantMessage
        })
      }
      case 'attachment':
        return [message]
      case 'progress':
        return [message]
      case 'system':
        return [message]
      case 'user': {
        if (typeof message.message.content === 'string') {
          const uuid = isNewChain ? deriveUUID(message.uuid, 0) : message.uuid
          return [
            {
              ...message,
              uuid,
              message: {
                ...message.message,
                content: [{ type: 'text', text: message.message.content }],
              },
            } as NormalizedMessage,
          ]
        }
        isNewChain = isNewChain || message.message.content.length > 1
        let imageIndex = 0
        return message.message.content.map((_, index) => {
          const isImage = _.type === 'image'
          // For image content blocks, extract just the ID for this image
          const imageId =
            isImage && message.imagePasteIds
              ? message.imagePasteIds[imageIndex]
              : undefined
          const imageOwner =
            isImage ? message.imagePermissionToolUseIds?.[imageIndex] : undefined
          if (isImage) imageIndex++
          return createNormalizedUserBlockMessage({
            source: message,
            content: [_],
            imagePasteIds: imageId !== undefined ? [imageId] : undefined,
            imagePermissionToolUseIds:
              imageOwner !== undefined ? [imageOwner] : undefined,
            uuid: isNewChain ? deriveUUID(message.uuid, index) : message.uuid,
          }) as NormalizedMessage
        })
      }
    }
  })
}

// Per-element cache for normalizeMessages. The only cross-message state in
// normalizeMessages is the monotonic isNewChain flag, so each message's
// normalized output is fully determined by (message identity, entry flag).
// Caching on the message object keeps output identity stable across calls,
// which preserves downstream WeakMap caches and React.memo bailouts, and
// reduces each unchanged message to an O(1) cache hit (reused blocks, no
// re-splitting or re-allocation) instead of a full renormalization. The call
// itself still scans the message list and reassembles the output array, so it
// stays O(n) per render — this is an allocation/object-identity optimization,
// not an O(1) append. Entries GC together with their messages.
type NormalizedCacheEntry = {
  entryFlag: boolean
  exitFlag: boolean
  out: NormalizedMessage[]
}
const normalizedMessageCache = new WeakMap<Message, NormalizedCacheEntry>()

// Drop-in replacement for normalizeMessages on render hot paths. Reuses each
// message's previously normalized blocks (preserving object identity) when the
// incoming isNewChain flag matches the cached run; recomputes only changed or
// new messages. Messages are treated as immutable, matching the assumptions of
// the React.memo comparators downstream.
export function normalizeMessagesCached(
  messages: Message[],
): NormalizedMessage[] {
  const out: NormalizedMessage[] = []
  let flag = false
  for (const message of messages) {
    const cached = normalizedMessageCache.get(message)
    if (cached && cached.entryFlag === flag) {
      for (const m of cached.out) {
        out.push(m)
      }
      flag = cached.exitFlag
      continue
    }
    const entryFlag = flag
    // Reuse normalizeMessages for the actual block-splitting logic so the two
    // implementations cannot drift. isNewChain only transitions false -> true,
    // so seeding the single-element run with the current flag is equivalent to
    // running the whole list: pass a synthetic multi-block predecessor when the
    // flag is already set.
    const normalized = normalizeSingleMessageWithFlag(message, entryFlag)
    normalizedMessageCache.set(message, {
      entryFlag,
      exitFlag: normalized.exitFlag,
      out: normalized.out,
    })
    for (const m of normalized.out) {
      out.push(m)
    }
    flag = normalized.exitFlag
  }
  return out
}

function normalizeSingleMessageWithFlag(
  message: Message,
  entryFlag: boolean,
): { out: NormalizedMessage[]; exitFlag: boolean } {
  const exitFlag =
    entryFlag ||
    ((message.type === 'assistant' ||
      (message.type === 'user' && typeof message.message.content !== 'string')) &&
      message.message.content.length > 1)

  if (!entryFlag) {
    return { out: normalizeMessages([message]), exitFlag }
  }

  // normalizeMessages keys UUID derivation off its internal isNewChain flag;
  // when the chain flag is already set for this position, every produced block
  // must get a derived UUID. Recreate that by normalizing the single message
  // and re-deriving UUIDs the same way the full pass would.
  switch (message.type) {
    case 'attachment':
    case 'progress':
    case 'system':
      return { out: [message], exitFlag }
    default: {
      const normalized = normalizeMessages([message])
      return {
        out: normalized.map(
          (m, index) =>
            ({
              ...m,
              uuid: deriveUUID(message.uuid, index),
            }) as NormalizedMessage,
        ),
        exitFlag,
      }
    }
  }
}
