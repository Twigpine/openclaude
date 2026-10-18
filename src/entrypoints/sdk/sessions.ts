/**
 * Session management functions for the SDK.
 *
 * Provides CRUD operations on sessions: list, get info, get messages,
 * rename, tag, delete, and fork.
 */

import { randomUUID } from 'crypto'
import { appendFile, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  listSessionsImpl,
  parseSessionInfoFromLite,
  type SessionInfo,
} from '../../utils/listSessionsImpl.js'
import {
  readSessionLite,
  resolveSessionFilePath,
} from '../../utils/sessionStoragePortable.js'
import { readJSONLFile } from '../../utils/json.js'
import { withTranscriptFileLock } from '../../utils/transcriptFileLock.js'
import {
  assertValidSessionId,
  type JsonlEntry,
  type SDKSessionInfo,
  type ListSessionsOptions,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type SessionMutationOptions,
  type ForkSessionOptions,
  type ForkSessionResult,
  type SessionMessage,
} from './shared.js'

// ============================================================================
// Internal: SessionInfo → SDKSessionInfo mapping
// ============================================================================

function toSDKSessionInfo(info: SessionInfo): SDKSessionInfo {
  // Internal SessionInfo already uses camelCase — matches public SDK contract
  return {
    sessionId: info.sessionId,
    summary: info.summary,
    lastModified: info.lastModified,
    fileSize: info.fileSize,
    customTitle: info.customTitle,
    firstPrompt: info.firstPrompt,
    gitBranch: info.gitBranch,
    cwd: info.cwd,
    tag: info.tag,
    createdAt: info.createdAt,
  }
}

// ============================================================================
// Session functions
// ============================================================================

/**
 * List sessions with metadata.
 *
 * When `dir` is provided, returns sessions for that project directory
 * and its git worktrees. When omitted, returns sessions across all projects.
 *
 * Use `limit` and `offset` for pagination.
 */
export async function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  const sessions = await listSessionsImpl(options)
  return sessions.map(toSDKSessionInfo)
}

/**
 * Reads metadata for a single session by ID.
 * Returns undefined if the session file is not found, is a sidechain session,
 * or has no extractable summary.
 *
 * @param sessionId - UUID of the session
 * @param options - Optional dir to narrow the search
 */
export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return undefined

  const lite = await readSessionLite(resolved.filePath)
  if (!lite) return undefined

  const info = parseSessionInfoFromLite(
    sessionId,
    lite,
    resolved.projectPath,
  )
  if (!info) return undefined

  return toSDKSessionInfo(info)
}

// ============================================================================
// Internal: helper for determining entry role
// ============================================================================

/**
 * Determine the role of a JSONL entry, or null if it's not a conversational message.
 */
function entryToRole(entry: JsonlEntry): 'user' | 'assistant' | 'system' | null {
  switch (entry.type) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'summary':
    case 'system':
      return 'system'
    default:
      return null
  }
}

/**
 * Convert a JSONL entry to a SessionMessage.
 */
function entryToSessionMessage(entry: JsonlEntry): SessionMessage {
  const role = entryToRole(entry) ?? 'system'
  return {
    role,
    content: entry.message?.content,
    timestamp: entry.timestamp,
    uuid: entry.uuid,
    parentUuid: entry.parentUuid,
  }
}

/**
 * Reads a session's conversation messages from its JSONL transcript file.
 *
 * Parses the transcript, builds the conversation chain via parentUuid links,
 * and returns user/assistant messages in chronological order. Set
 * `includeSystemMessages: true` in options to also include system messages.
 *
 * @param sessionId - UUID of the session to read
 * @param options - Optional dir, limit, offset, and includeSystemMessages
 * @returns Array of messages, or empty array if session not found
 */
export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return []

  const entries = await readJSONLFile<JsonlEntry>(resolved.filePath)
  if (entries.length === 0) return []

  // Build map of uuid → entry, filter non-message entries
  const byUuid = new Map<string, JsonlEntry>()
  for (const entry of entries) {
    if (!entry.uuid) continue
    // Skip sidechain entries
    if (entry.isSidechain) continue
    // Only include entries with a meaningful type
    const role = entryToRole(entry)
    if (role === null) continue
    byUuid.set(entry.uuid, entry)
  }

  if (byUuid.size === 0) return []

  // Find the leaf (last entry that has a uuid and valid role)
  let leaf: JsonlEntry | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.uuid && byUuid.has(entry.uuid)) {
      leaf = entry
      break
    }
  }
  if (!leaf) return []

  // Build conversation chain by walking parentUuid from leaf to root
  const chain: JsonlEntry[] = []
  const seen = new Set<string>()
  let current: JsonlEntry | undefined = leaf
  while (current) {
    if (!current.uuid || seen.has(current.uuid)) break
    seen.add(current.uuid)
    chain.push(current)
    const parentRef: string | null | undefined = current.parentUuid
    current = parentRef ? byUuid.get(parentRef) : undefined
  }
  chain.reverse()

  // Map to SessionMessage
  const includeSystem = options?.includeSystemMessages ?? false
  let messages: SessionMessage[] = chain
    .filter(entry => {
      const role = entryToRole(entry)
      if (role === 'system') return includeSystem
      return role !== null
    })
    .map(entry => entryToSessionMessage(entry))

  // Apply offset/limit
  const offset = options?.offset ?? 0
  if (offset > 0) messages = messages.slice(offset)
  const limit = options?.limit
  if (limit !== undefined && limit > 0) messages = messages.slice(0, limit)

  return messages
}

// ============================================================================
// Internal: append a JSONL entry to a session file (portable, no heavy deps)
// ============================================================================

async function appendJsonlEntry(
  filePath: string,
  entry: Record<string, unknown>,
): Promise<void> {
  const line = JSON.stringify(entry) + '\n'
  await mkdir(dirname(filePath), { mode: 0o700, recursive: true })
  await withTranscriptFileLock(filePath, async signal => {
    signal.throwIfAborted()
    await appendFile(filePath, line, { mode: 0o600 })
  })
}

// ============================================================================
// Session mutation functions
// ============================================================================

/**
 * Rename a session. Appends a custom-title entry to the session's JSONL file.
 *
 * @param sessionId - UUID of the session
 * @param title - New title
 * @param options - Optional dir to narrow the search
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  await appendJsonlEntry(resolved.filePath, {
    type: 'custom-title',
    customTitle: title,
    sessionId,
  })
}

/**
 * Tag a session. Pass null to clear the tag.
 *
 * @param sessionId - UUID of the session
 * @param tag - Tag string, or null to clear
 * @param options - Optional dir to narrow the search
 */
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  await appendJsonlEntry(resolved.filePath, {
    type: 'tag',
    tag: tag ?? '',
    sessionId,
  })
}

/**
 * Delete a session by removing its JSONL file from disk.
 *
 * @param sessionId - UUID of the session to delete
 * @param options - Optional dir to narrow the search
 * @throws If sessionId is invalid or session file is not found
 */
export async function deleteSession(
  sessionId: string,
  options?: SessionMutationOptions,
): Promise<void> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  await unlink(resolved.filePath)
}

// ============================================================================
// forkSession
// ============================================================================

/**
 * Fork a session into a new branch with fresh UUIDs.
 *
 * Copies transcript messages from the source session into a new session file,
 * remapping every message UUID and preserving the parentUuid chain. Supports
 * `upToMessageId` for branching from a specific point in the conversation.
 *
 * Forked sessions start without undo history (file-history snapshots are not
 * copied).
 *
 * @param sessionId - UUID of the source session
 * @param options - Optional dir, upToMessageId, title
 * @returns Object with the new sessionId
 */
export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  assertValidSessionId(sessionId)
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) {
    throw new Error(`Session not found: ${sessionId}`)
  }

  // Read all JSONL entries
  const entries = await readJSONLFile<JsonlEntry>(resolved.filePath)
  if (entries.length === 0) {
    throw new Error(`Session is empty: ${sessionId}`)
  }

  // Generate new session ID and UUID remapping
  const forkSessionId = randomUUID()

  // Determine the target directory: same as source
  const targetDir = dirname(resolved.filePath)
  const forkPath = join(targetDir, `${forkSessionId}.jsonl`)

  // UUID remapping: old UUID → new UUID
  const uuidMap = new Map<string, string>()

  // Filter to main conversation entries only (no sidechains)
  // If upToMessageId is specified, stop at that message
  const mainEntries: JsonlEntry[] = []
  const metadataEntries: JsonlEntry[] = []
  let hitUpTo = false
  for (const entry of entries) {
    if (entry.isSidechain) continue

    if (!entry.uuid) {
      // Metadata entries without uuid (custom-title, tag, etc.)
      metadataEntries.push(entry)
      continue
    }

    const role = entryToRole(entry)
    if (role === null) {
      // Has uuid but no conversational role — still metadata, preserve it
      metadataEntries.push(entry)
      continue
    }

    const newUuid = randomUUID()
    uuidMap.set(entry.uuid, newUuid)

    mainEntries.push(entry)

    if (options?.upToMessageId && entry.uuid === options.upToMessageId) {
      hitUpTo = true
      break
    }
  }

  if (mainEntries.length === 0) {
    throw new Error(`No conversational messages to fork in session: ${sessionId}`)
  }

  if (options?.upToMessageId && !hitUpTo) {
    throw new Error(
      `upToMessageId ${options.upToMessageId} not found in session ${sessionId}`,
    )
  }

  // Build forked entries — metadata first, then conversational
  const lines: string[] = []

  // Metadata entries: copy with new sessionId, no UUID remapping
  for (const entry of metadataEntries) {
    lines.push(JSON.stringify({ ...entry, sessionId: forkSessionId }))
  }

  // Conversational entries: remap UUIDs and parentUuid chains
  for (const entry of mainEntries) {
    const oldUuid = entry.uuid!
    const newUuid = uuidMap.get(oldUuid)!
    const oldParent = entry.parentUuid ?? null
    const newParent = oldParent ? (uuidMap.get(oldParent) ?? null) : null

    const forkedEntry: JsonlEntry & {
      sessionId: string
      forkedFrom: { sessionId: string; messageUuid: string }
    } = {
      ...entry,
      uuid: newUuid,
      parentUuid: newParent,
      sessionId: forkSessionId,
      isSidechain: false,
      forkedFrom: {
        sessionId,
        messageUuid: oldUuid,
      },
    }

    lines.push(JSON.stringify(forkedEntry))
  }

  // Write fork session file
  await writeFile(forkPath, lines.join('\n') + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })

  // Apply title if provided
  if (options?.title) {
    await appendJsonlEntry(forkPath, {
      type: 'custom-title',
      customTitle: options.title,
      sessionId: forkSessionId,
    })
  }

  return { sessionId: forkSessionId }
}
