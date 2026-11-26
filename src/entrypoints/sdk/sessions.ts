/**
 * Session management functions for the SDK.
 *
 * Provides CRUD operations on sessions: list, get info, get messages,
 * rename, tag, delete, and fork.
 *
 * Host contract for delete vs portable JSONL mutations: `deleteSession`
 * marks a transcript deleted before removing it, but the portable appends
 * used by `renameSession`, `tagSession`, and `forkSession` (title) do not
 * consult that mark. Hosts must serialize a delete with any
 * rename/tag/fork title append on the same resolved transcript, or accept
 * that only internal/sessionStorage writers honor the deletion mark today.
 */

import { randomUUID, type UUID } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { appendFile, mkdir, unlink, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  CODE_MODE_ENV_VAR,
  isReplModeEligibleForSession,
  setReplModeForConversation,
} from '../../tools/REPLTool/constants.js'
import {
  listSessionsImpl,
  parseSessionInfoFromLite,
  type SessionInfo,
} from '../../utils/listSessionsImpl.js'
import {
  finishDeletedSession,
  forgetDeletedSession,
  restoreSessionWrites,
} from '../../utils/sessionStorage.js'
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
// Internal: Code Mode transcript boundary enforcement
// ============================================================================

export class CodeModeTranscriptCompatibilityError extends Error {
  constructor() {
    super(
      `This session was created in Code Mode and cannot be resumed with direct tools. Restart with ${CODE_MODE_ENV_VAR}=1 to resume it.`,
    )
    this.name = 'CodeModeTranscriptCompatibilityError'
  }
}

function codeModeFromEntries(
  entries: JsonlEntry[],
  sessionId: string,
): boolean | undefined {
  let codeMode: boolean | undefined
  for (const entry of entries) {
    if (entry.type !== 'code-mode' || entry.sessionId !== sessionId) continue
    if (typeof entry.codeMode === 'boolean') codeMode = entry.codeMode
  }
  return codeMode
}

const CODE_MODE_MARKER = Buffer.from('"type":"code-mode"')
const NEWLINE = 0x0a
const MAX_METADATA_CARRY_BYTES = 64 * 1024

function parseCodeModeLine(line: string, sessionId: string): boolean | undefined {
  if (!line.includes('"type":"code-mode"')) return undefined
  try {
    const entry = JSON.parse(line) as JsonlEntry
    if (entry.type !== 'code-mode' || entry.sessionId !== sessionId) {
      return undefined
    }
    return typeof entry.codeMode === 'boolean' ? entry.codeMode : undefined
  } catch {
    return undefined
  }
}

/**
 * Scan the bytes before a compact boundary for code-mode metadata. This is
 * the SDK-local equivalent of sessionStorage's metadata scan. It stays small
 * because importing the interactive resume module here would pull in UI and
 * hook modules that cycle back through SDK types.
 */
async function scanPreBoundaryCodeMode(
  filePath: string,
  endOffset: number,
  sessionId: string,
): Promise<boolean | undefined> {
  if (endOffset <= 0) return undefined

  let codeMode: boolean | undefined
  let carry: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  const stream = createReadStream(filePath, { end: endOffset - 1 })
  for await (const chunk of stream) {
    const chunkBuf = chunk as Buffer
    const buf = carry.length > 0 ? Buffer.concat([carry, chunkBuf]) : chunkBuf
    let lineStart = 0
    let newline = buf.indexOf(NEWLINE)
    while (newline !== -1) {
      const markerIndex = buf.indexOf(CODE_MODE_MARKER, lineStart)
      if (markerIndex !== -1 && markerIndex < newline) {
        const parsed = parseCodeModeLine(
          buf.toString('utf8', lineStart, newline),
          sessionId,
        )
        if (parsed !== undefined) codeMode = parsed
      }
      lineStart = newline + 1
      newline = buf.indexOf(NEWLINE, lineStart)
    }
    carry = buf.subarray(lineStart)
    // Metadata entries are small. A larger carry is message content, and its
    // continuation cannot parse as a complete metadata line anyway.
    if (carry.length > MAX_METADATA_CARRY_BYTES) carry = Buffer.alloc(0)
  }

  if (carry.length > 0) {
    const parsed = parseCodeModeLine(carry.toString('utf8'), sessionId)
    if (parsed !== undefined) codeMode = parsed
  }
  return codeMode
}

/**
 * Apply the CLI Code Mode resume contract before transcript messages enter an
 * SDK engine. A post-boundary marker is newer than anything before the last
 * compact boundary, so only scan pre-boundary bytes when no marker survives in
 * the parsed entries.
 */
export async function enforceSdkCodeModeTranscriptCompatibility(input: {
  filePath: string
  entries: JsonlEntry[]
  sessionId: string
  preBoundaryEndOffset?: number
}): Promise<boolean> {
  let codeMode = codeModeFromEntries(input.entries, input.sessionId)
  if (codeMode === undefined && input.preBoundaryEndOffset) {
    codeMode = await scanPreBoundaryCodeMode(
      input.filePath,
      input.preBoundaryEndOffset,
      input.sessionId,
    )
  }

  const transcriptUsedCodeMode = codeMode === true
  if (transcriptUsedCodeMode && !isReplModeEligibleForSession()) {
    throw new CodeModeTranscriptCompatibilityError()
  }
  setReplModeForConversation(transcriptUsedCodeMode)
  return transcriptUsedCodeMode
}

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
    ...(typeof entry.isVirtual === 'boolean'
      ? { isVirtual: entry.isVirtual }
      : {}),
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
//
// Note: this append does not consult the deletion mark set by
// forgetDeletedSession, so callers must not interleave it with an in-flight
// deleteSession on the same resolved transcript (see deleteSession).
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
 * Blocks later Project-tracked writes to it first (see
 * forgetDeletedSession): a pending AI title, task summary, or metadata
 * append would otherwise recreate the file and the session would come
 * back. That also drops the deleted session's per-context caches, so a
 * later query reusing its id and cwd starts clean instead of inheriting
 * its cached title/tag (#2489).
 *
 * This blocking covers internal/sessionStorage writers only. The portable
 * JSONL appends used by `renameSession`, `tagSession`, and `forkSession`
 * (title) do not consult the deletion mark, so a host must serialize a
 * delete with any rename/tag/fork title append on the same resolved
 * transcript — otherwise metadata can land during the mark-before-`unlink`
 * window and recreate the file. If hosts later need fully concurrent
 * lifecycle on one transcript, the append path needs a central guard
 * (see `appendJsonlEntry`).
 *
 * A query that starts while the deletion is still in flight waits for
 * it to settle (see waitForDeletionToSettle in sessionStorage.ts) instead
 * of materializing into the marked path and losing its first message to
 * the removal: once the file is gone it starts clean at the recycled
 * path, and if the removal fails the surviving transcript keeps
 * receiving writes.
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

  try {
    await forgetDeletedSession(sessionId as UUID, resolved.filePath)
  } catch (error) {
    // Nothing was removed (a pending write failed while settling): undo the
    // mark so the still-present transcript keeps receiving writes.
    restoreSessionWrites(resolved.filePath)
    finishDeletedSession(resolved.filePath)
    throw error
  }

  try {
    await unlink(resolved.filePath)
  } catch (error) {
    // The transcript survived (e.g. EBUSY on Windows): stop dropping writes
    // to it, or disk and this process disagree until restart.
    if (existsSync(resolved.filePath)) {
      restoreSessionWrites(resolved.filePath)
    }
    finishDeletedSession(resolved.filePath)
    throw error
  }
  // Removed: drop the metadata snapshot forgetDeletedSession kept for the
  // failure path, or one snapshot lingers per deletion.
  finishDeletedSession(resolved.filePath)
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
