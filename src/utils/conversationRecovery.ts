import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { relative, resolve } from 'path'
import { getCwd } from 'src/utils/cwd.js'
import { addInvokedSkill } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import type {
  AttributionSnapshotMessage,
  ContextCollapseCommitEntry,
  ContextCollapseSnapshotEntry,
  LogOption,
  PersistedWorktreeSession,
  SerializedMessage,
} from '../types/logs.js'
import type {
  Message,
  NormalizedMessage,
  NormalizedUserMessage,
} from '../types/message.js'
import { PERMISSION_MODES } from '../types/permissions.js'
import { suppressNextSkillListing } from './attachments.js'
import {
  copyFileHistoryForResume,
  type FileHistorySnapshot,
} from './fileHistory.js'
import { logError } from './log.js'
import { getAPIProvider } from './model/providers.js'
import {
  resolveOpenAIShimRuntimeContext,
  usesAnthropicNativeMessageFormat,
} from '../integrations/runtimeMetadata.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
} from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { isDangerousPermissionMode } from './permissions/PermissionMode.js'

// Dead code elimination: internal-only tool names are conditionally required so
// their strings don't leak into external builds. Static imports always bundle.
/* eslint-disable @typescript-eslint/no-require-imports */
const BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_TOOL_NAME
    : null
const LEGACY_BRIEF_TOOL_NAME: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).LEGACY_BRIEF_TOOL_NAME
    : null
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS')
  ? (
      require('../tools/SendUserFileTool/prompt.js') as typeof import('../tools/SendUserFileTool/prompt.js')
    ).SEND_USER_FILE_TOOL_NAME
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// Hard cap for reconstructed resume payloads before REPL boot. 8 MiB keeps
// resume bounded well below the multi-GB failure mode we saw while leaving
// enough room for normal compacted sessions plus resume hook context.
const MAX_RESUME_MESSAGE_BYTES = 8 * 1024 * 1024

type PrResumeSelector = true | number | string

export class ResumeTranscriptTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
    readonly messageCount: number,
  ) {
    super(
      `Reconstructed transcript is too large to resume safely (${(
        bytes / (1024 * 1024)
      ).toFixed(1)} MiB > ${(maxBytes / (1024 * 1024)).toFixed(1)} MiB, ${messageCount} messages).`,
    )
    this.name = 'ResumeTranscriptTooLargeError'
  }
}

function assertResumeMessageSize(messages: Message[]): void {
  const bytes = Buffer.byteLength(jsonStringify(messages), 'utf8')
  if (bytes > MAX_RESUME_MESSAGE_BYTES) {
    throw new ResumeTranscriptTooLargeError(
      bytes,
      MAX_RESUME_MESSAGE_BYTES,
      messages.length,
    )
  }
}

/**
 * Transforms legacy attachment types to current types for backward compatibility
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function getAttachmentRecord(
  message: Message,
): Record<string, unknown> | null {
  if (message.type !== 'attachment') {
    return null
  }
  const attachment = (message as { attachment?: unknown }).attachment
  if (!isRecord(attachment) || typeof attachment.type !== 'string') {
    return null
  }
  return attachment
}

function migrateLegacyAttachmentTypes(message: Message): Message | null {
  if (message.type !== 'attachment') {
    return message
  }

  const attachment = getAttachmentRecord(message)
  if (!attachment) {
    return null
  }

  // Transform legacy attachment types
  if (attachment.type === 'new_file') {
    if (!isNonEmptyString(attachment.filename)) {
      return null
    }
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'file',
        displayPath: relative(getCwd(), attachment.filename),
      },
    } as SerializedMessage // Cast entire message since we know the structure is correct
  }

  if (attachment.type === 'new_directory') {
    if (!isNonEmptyString(attachment.path)) {
      return null
    }
    return {
      ...message,
      attachment: {
        ...attachment,
        type: 'directory',
        displayPath: relative(getCwd(), attachment.path),
      },
    } as SerializedMessage // Cast entire message since we know the structure is correct
  }

  // Backfill displayPath for attachments from old sessions
  if (!('displayPath' in attachment)) {
    const path =
      isNonEmptyString(attachment.filename)
        ? attachment.filename
        : isNonEmptyString(attachment.path)
          ? attachment.path
          : isNonEmptyString(attachment.skillDir)
            ? attachment.skillDir
            : undefined
    if (path) {
      return {
        ...message,
        attachment: {
          ...attachment,
          displayPath: relative(getCwd(), path),
        },
      } as Message
    }
  }

  return message
}

export type TeleportRemoteResponse = {
  log: Message[]
  branch?: string
}

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/**
 * Remove thinking/redacted_thinking content blocks from assistant messages.
 * Messages that become empty after stripping are removed entirely.
 */
function stripThinkingBlocks(messages: NormalizedMessage[]): NormalizedMessage[] {
  return messages.reduce<NormalizedMessage[]>((acc, msg) => {
    if (msg.type !== 'assistant' || !Array.isArray(msg.message?.content)) {
      acc.push(msg)
      return acc
    }
    const filtered = msg.message.content.filter(
      (block: { type?: string }) => block.type !== 'thinking' && block.type !== 'redacted_thinking',
    )
    if (filtered.length === 0) return acc
    acc.push({ ...msg, message: { ...msg.message, content: filtered } })
    return acc
  }, [])
}

// Some 3P providers require `reasoning_content` echoed back on assistant
// messages (DeepSeek thinking mode, Moonshot/Kimi, Z.AI GLM, MiMo, etc.). The
// openai-shim re-shapes those messages and reads the source-of-truth from the
// `thinking` block on the Anthropic side. Stripping the block leaves the shim
// with no reasoning text and the provider 400s with
// "reasoning_content in the thinking mode must be passed back" (issue #957).
//
// Vendors declare this need via `openaiShim.preserveReasoningContent: true`
// in their descriptor, so derive the answer from the resolved shim config
// instead of hardcoding model name prefixes — that automatically covers any
// future vendor that opts in without code changes here.
function shouldPreserveThinkingBlocksForProviderReplay(): boolean {
  return (
    resolveOpenAIShimRuntimeContext({
      processEnv: process.env,
      baseUrl: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
    }).openaiShimConfig.preserveReasoningContent === true
  )
}

/**
 * Strip protected-thinking blocks from history only when the active provider
 * tolerates it. Mirrors the gate used during session-resume deserialization:
 * strip for non-preserve third-party providers, leave Anthropic-native and
 * preserve-reasoning providers (DeepSeek/Kimi/Z.AI GLM — which 400 on a
 * stripped block, issue #957) untouched.
 *
 * Exposed for callers that rewrite history across a model change (e.g. smart
 * routing's per-turn model swap), so a model-bound thinking signature is never
 * replayed to a different model without re-creating the preserve-reasoning 400.
 */
export function stripThinkingBlocksIfProviderAllows(
  messages: NormalizedMessage[],
): NormalizedMessage[] {
  const provider = getAPIProvider()
  const isAnthropicNativeTransport = usesAnthropicNativeMessageFormat({
    processEnv: process.env,
    model: process.env.OPENAI_MODEL,
    providerCategory: provider as NonNullable<
      Parameters<typeof usesAnthropicNativeMessageFormat>[0]
    >['providerCategory'],
  })
  const isThirdPartyProvider = provider !== 'foundry' && !isAnthropicNativeTransport
  if (isThirdPartyProvider && !shouldPreserveThinkingBlocksForProviderReplay()) {
    return stripThinkingBlocks(messages)
  }
  return messages
}

function parsePrIdentifier(value: string): number | null {
  const directNumber = parseInt(value, 10)
  if (!isNaN(directNumber) && directNumber > 0) {
    return directNumber
  }
  const urlMatch = value.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }
  return null
}

export function findResumeLogByPrSelector(
  logs: LogOption[],
  selector: PrResumeSelector,
): LogOption | null {
  const candidates = logs.filter(log => !log.isSidechain)
  if (selector === true) {
    return candidates.find(log => log.prNumber !== undefined) ?? null
  }
  if (typeof selector === 'number') {
    return candidates.find(log => log.prNumber === selector) ?? null
  }

  const prNumber = parsePrIdentifier(selector)
  if (prNumber !== null) {
    return candidates.find(log => log.prNumber === prNumber) ?? null
  }

  return null
}

/**
 * Deserializes messages from a log file into the format expected by the REPL.
 * Filters unresolved tool uses, orphaned thinking messages, and appends a
 * synthetic assistant sentinel when the last message is from the user.
 * @internal Exported for testing - use loadConversationForResume instead
 */
export function deserializeMessages(serializedMessages: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serializedMessages).messages
}

/**
 * Like deserializeMessages, but also detects whether the session was
 * interrupted mid-turn. Used by the SDK resume path to auto-continue
 * interrupted turns after a gateway-triggered restart.
 * @internal Exported for testing
 */
export function deserializeMessagesWithInterruptDetection(
  serializedMessages: Message[],
): DeserializeResult {
  try {
    // Transform legacy attachment types before processing
    const migratedMessages = serializedMessages.flatMap(message => {
      const migratedMessage = migrateLegacyAttachmentTypes(message)
      return migratedMessage ? [migratedMessage] : []
    })

    // Strip invalid or dangerous permissionMode values from deserialized user
    // messages. The field is unvalidated JSON from disk and only
    // non-dangerous modes are eligible for rewind restoration.
    const validModes = new Set<string>(PERMISSION_MODES)
    for (const msg of migratedMessages) {
      if (
        msg.type === 'user' &&
        msg.permissionMode !== undefined &&
        (!validModes.has(msg.permissionMode) ||
          isDangerousPermissionMode(msg.permissionMode))
      ) {
        msg.permissionMode = undefined
      }
    }

    // Filter out unresolved tool uses and any synthetic messages that follow them
    const filteredToolUses = filterUnresolvedToolUses(
      migratedMessages,
    ) as NormalizedMessage[]

    // Filter out orphaned thinking-only assistant messages that can cause API errors
    // during resume. These occur when streaming yields separate messages per content
    // block and interleaved user messages prevent proper merging by message.id.
    const filteredThinking = filterOrphanedThinkingOnlyMessages(
      filteredToolUses,
    ) as NormalizedMessage[]

    // Strip thinking/redacted_thinking content blocks from assistant messages
    // when resuming against a 3P provider. These Anthropic-specific blocks cause
    // 400 errors or context corruption on OpenAI-compatible providers (issue #248 finding 5).
    //
    // Exception: providers that require `reasoning_content` echoed back on
    // assistant messages (DeepSeek thinking mode, Moonshot/Kimi, Z.AI GLM, etc.)
    // read the source-of-truth from the `thinking` block when re-shaping the
    // outgoing OpenAI-format message. Stripping the block leaves the shim with
    // no reasoning text to attach, and the provider 400s with
    // "reasoning_content in the thinking mode must be passed back" (issue #957).
    const thinkingStripped = stripThinkingBlocksIfProviderAllows(filteredThinking)

    // Filter out assistant messages with only whitespace text content.
    // This can happen when model outputs "\n\n" before thinking, user cancels mid-stream.
    const filteredMessages = filterWhitespaceOnlyAssistantMessages(
      thinkingStripped,
    ) as NormalizedMessage[]

    const internalState = detectTurnInterruption(filteredMessages)

    // Transform mid-turn interruptions into interrupted_prompt by appending
    // a synthetic continuation message. This unifies both interruption kinds
    // so the consumer only needs to handle interrupted_prompt.
    let turnInterruptionState: TurnInterruptionState
    if (internalState.kind === 'interrupted_turn') {
      const [continuationMessage] = normalizeMessages([
        createUserMessage({
          content: 'Continue from where you left off.',
          isMeta: true,
        }),
      ])
      filteredMessages.push(continuationMessage!)
      turnInterruptionState = {
        kind: 'interrupted_prompt',
        message: continuationMessage!,
      }
    } else {
      turnInterruptionState = internalState
    }

    // Append a synthetic assistant sentinel after the last user message so
    // the conversation is API-valid if no resume action is taken. Skip past
    // trailing system/progress messages and insert right after the user
    // message so removeInterruptedMessage's splice(idx, 2) removes the
    // correct pair.
    const lastRelevantIdx = filteredMessages.findLastIndex(
      m => m.type !== 'system' && m.type !== 'progress',
    )
    if (
      lastRelevantIdx !== -1 &&
      filteredMessages[lastRelevantIdx]!.type === 'user'
    ) {
      filteredMessages.splice(
        lastRelevantIdx + 1,
        0,
        createAssistantMessage({
          content: NO_RESPONSE_REQUESTED,
        }) as NormalizedMessage,
      )
    }

    return { messages: filteredMessages, turnInterruptionState }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

type UdsClientModule = typeof import('./udsClient.js')
type BgRegistryModule = typeof import('../cli/bgRegistry.js')

type CollectLiveBackgroundSessionIdsDeps = {
  listAllLiveSessions?: UdsClientModule['listAllLiveSessions']
  refreshBackgroundSessionStatuses?: BgRegistryModule['refreshBackgroundSessionStatuses']
  isTerminalBackgroundSession?: BgRegistryModule['isTerminalBackgroundSession']
}

export async function collectLiveBackgroundSessionIds(
  deps: CollectLiveBackgroundSessionIdsDeps = {},
): Promise<Set<string>> {
  const skip = new Set<string>()
  try {
    const listAllLiveSessions =
      deps.listAllLiveSessions ??
      (await import('./udsClient.js')).listAllLiveSessions
    const live = await listAllLiveSessions()
    for (const session of live) {
      if (session.kind && session.kind !== 'interactive' && session.sessionId) {
        skip.add(session.sessionId)
      }
    }
  } catch {
    // UDS unavailable — local registry below still protects local bg sessions.
  }

  try {
    let refreshBackgroundSessionStatuses =
      deps.refreshBackgroundSessionStatuses
    let isTerminalBackgroundSession = deps.isTerminalBackgroundSession
    if (!refreshBackgroundSessionStatuses || !isTerminalBackgroundSession) {
      const bgRegistry = await import('../cli/bgRegistry.js')
      refreshBackgroundSessionStatuses ??=
        bgRegistry.refreshBackgroundSessionStatuses
      isTerminalBackgroundSession ??= bgRegistry.isTerminalBackgroundSession
    }
    const sessions = await refreshBackgroundSessionStatuses()
    for (const session of sessions) {
      if (!isTerminalBackgroundSession(session)) {
        skip.add(session.sessionId)
      }
    }
  } catch {
    // Registry unavailable or unreadable — fall back to UDS-only results.
  }

  return skip
}

/**
 * Internal 3-way result from detection, before transforming interrupted_turn
 * into interrupted_prompt with a synthetic continuation message.
 */
type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

/**
 * Determines whether the conversation was interrupted mid-turn based on the
 * last message after filtering. An assistant as last message (after filtering
 * unresolved tool_uses) is treated as a completed turn because stop_reason is
 * always null on persisted messages in the streaming path.
 *
 * System and progress messages are skipped when finding the last turn-relevant
 * message — they are bookkeeping artifacts that should not mask a genuine
 * interruption. Attachments are kept as part of the turn.
 */
function detectTurnInterruption(
  messages: NormalizedMessage[],
): InternalInterruptionState {
  if (messages.length === 0) {
    return { kind: 'none' }
  }

  // Find the last turn-relevant message, skipping system/progress and
  // synthetic API error assistants. Error assistants are already filtered
  // before API send (normalizeMessagesForAPI) — skipping them here lets
  // auto-resume fire after retry exhaustion instead of reading the error as
  // a completed turn.
  const lastMessageIdx = messages.findLastIndex(
    m =>
      m.type !== 'system' &&
      m.type !== 'progress' &&
      !(m.type === 'assistant' && m.isApiErrorMessage),
  )
  const lastMessage =
    lastMessageIdx !== -1 ? messages[lastMessageIdx] : undefined

  if (!lastMessage) {
    return { kind: 'none' }
  }

  if (lastMessage.type === 'assistant') {
    // In the streaming path, stop_reason is always null on persisted messages
    // because messages are recorded at content_block_stop time, before
    // message_delta delivers the stop_reason. After filterUnresolvedToolUses
    // has removed assistant messages with unmatched tool_uses, an assistant as
    // the last message means the turn most likely completed normally.
    return { kind: 'none' }
  }

  if (lastMessage.type === 'user') {
    if (lastMessage.isMeta || lastMessage.isCompactSummary) {
      return { kind: 'none' }
    }
    if (isToolUseResultMessage(lastMessage)) {
      // Brief mode (#20467) drops the trailing assistant text block, so a
      // completed brief-mode turn legitimately ends on SendUserMessage's
      // tool_result. Without this check, resume misclassifies every
      // brief-mode session as interrupted mid-turn and injects a phantom
      // "Continue from where you left off." before the user's real next
      // prompt. Look back one step for the originating tool_use.
      if (isTerminalToolResult(lastMessage, messages, lastMessageIdx)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    // Plain text user prompt — CC hadn't started responding
    return { kind: 'interrupted_prompt', message: lastMessage }
  }

  if (lastMessage.type === 'attachment') {
    // Attachments are part of the user turn — the user provided context but
    // the assistant never responded.
    return { kind: 'interrupted_turn' }
  }

  return { kind: 'none' }
}

/**
 * Is this tool_result the output of a tool that legitimately terminates a
 * turn? SendUserMessage is the canonical case: in brief mode, calling it is
 * the turn's final act — there is no follow-up assistant text (#20467
 * removed it). A transcript ending here means the turn COMPLETED, not that
 * it was killed mid-tool.
 *
 * Walks back to find the assistant tool_use that this result belongs to and
 * checks its name. The matching tool_use is typically the immediately
 * preceding relevant message (filterUnresolvedToolUses has already dropped
 * unpaired ones), but we walk just in case system/progress noise is
 * interleaved.
 */
function isTerminalToolResult(
  result: NormalizedUserMessage,
  messages: NormalizedMessage[],
  resultIdx: number,
): boolean {
  const content = result.message.content
  if (!Array.isArray(content)) return false
  const block = content[0]
  if (block?.type !== 'tool_result') return false
  const toolUseId = block.tool_use_id

  for (let i = resultIdx - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (msg.type !== 'assistant') continue
    for (const b of msg.message.content) {
      if (b.type === 'tool_use' && b.id === toolUseId) {
        return (
          b.name === BRIEF_TOOL_NAME ||
          b.name === LEGACY_BRIEF_TOOL_NAME ||
          b.name === SEND_USER_FILE_TOOL_NAME
        )
      }
    }
  }
  return false
}

/**
 * Restores skill state from invoked_skills attachments in messages.
 * This ensures that skills are preserved across resume after compaction.
 * Without this, if another compaction happens after resume, the skills would be lost
 * because STATE.invokedSkills would be empty.
 * @internal Exported for testing - use loadConversationForResume instead
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  for (const message of messages) {
    if (message.type !== 'attachment') {
      continue
    }
    const attachment = getAttachmentRecord(message)
    if (!attachment) {
      continue
    }
    if (attachment.type === 'invoked_skills') {
      if (!Array.isArray(attachment.skills)) {
        continue
      }
      for (const skill of attachment.skills) {
        if (
          isRecord(skill) &&
          isNonEmptyString(skill.name) &&
          isNonEmptyString(skill.path) &&
          isNonEmptyString(skill.content)
        ) {
          // Resume only happens for the main session, so agentId is null
          addInvokedSkill(skill.name, skill.path, skill.content, null)
        }
      }
    }
    // A prior process already injected the skills-available reminder — it's
    // in the transcript the model is about to see. sentSkillNames is
    // process-local, so without this every resume re-announces the same
    // ~600 tokens. Fire-once latch; consumed on the first attachment pass.
    if (attachment.type === 'skill_listing') {
      suppressNextSkillListing()
    }
  }
}

/**
 * Loads a conversation for resume from various sources.
 * This is the centralized function for loading and deserializing conversations.
 *
 * @param source - The source to load from:
 *   - undefined: load most recent conversation
 *   - string: session ID to load
 *   - LogOption: already loaded conversation
 * @param sourceJsonlFile - Alternate: path to a transcript jsonl.
 *   Used when --resume receives a .jsonl path (cli/print.ts routes
 *   on suffix), typically for cross-directory resume where the
 *   transcript lives outside the current project dir.
 * @returns Object containing the deserialized messages and the original log, or null if not found
 */
export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<{
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  fileHistorySnapshots?: FileHistorySnapshot[]
  attributionSnapshots?: AttributionSnapshotMessage[]
  contentReplacements?: ContentReplacementRecord[]
  contextCollapseCommits?: ContextCollapseCommitEntry[]
  contextCollapseSnapshot?: ContextCollapseSnapshotEntry
  sessionId: UUID | undefined
  // Session metadata for restoring agent context
  agentName?: string
  agentColor?: string
  agentSetting?: string
  customTitle?: string
  tag?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
  goal?: LogOption['goal']
  // Full path to the session file (for cross-directory resume)
  fullPath?: string
} | null> {
  try {
    let log: LogOption | null = null
    let messages: Message[] | null = null
    let sessionId: UUID | undefined
    let goal: LogOption['goal'] | undefined

    if (source === undefined) {
      // --continue: most recent session, skipping live --bg/daemon sessions
      // that are actively writing their own transcript.
      const logsPromise = loadMessageLogs()
      let skip = new Set<string>()
      if (feature('BG_SESSIONS')) {
        skip = await collectLiveBackgroundSessionIds()
      }
      const logs = await logsPromise
      log =
        logs.find(l => {
          const id = getSessionIdFromLog(l)
          return !id || !skip.has(id)
        }) ?? null
    } else if (sourceJsonlFile) {
      // Preserve metadata and the source directory so continuation appends
      // to the selected transcript even when another runtime hashes cwd differently.
      log = await loadFullLog(resolve(sourceJsonlFile))
    } else if (typeof source === 'string') {
      // Load specific session by ID
      log = await getLastSessionLog(source as UUID)
      sessionId = source as UUID
    } else {
      // Already have a LogOption
      log = source
    }

    if (!log && !messages) {
      return null
    }

    if (log) {
      // Load full messages for lite logs
      if (isLiteLog(log)) {
        log = await loadFullLog(log)
      }

      // Determine sessionId first so we can pass it to copy functions
      if (!sessionId) {
        sessionId = getSessionIdFromLog(log) as UUID
      }
      goal = log.goal
      // Pass the original session ID to ensure the plan slug is associated with
      // the session we're resuming, not the temporary session ID before resume
      if (sessionId) {
        await copyPlanForResume(log, asSessionId(sessionId))
      }

      // Copy file history for resume
      void copyFileHistoryForResume(log)

      messages = log.messages
      checkResumeConsistency(messages)
    }

    // Restore skill state from invoked_skills attachments before deserialization.
    // This ensures skills survive multiple compaction cycles after resume.
    restoreSkillStateFromMessages(messages!)

    // Deserialize messages to handle unresolved tool uses and ensure proper format
    const deserialized = deserializeMessagesWithInterruptDetection(messages!)
    messages = deserialized.messages

    // Reject oversized resumes before running side-effectful resume hooks.
    assertResumeMessageSize(messages)

    // Process session start hooks for resume
    const hookMessages = await processSessionStartHooks('resume', { sessionId })

    // Append hook messages to the conversation and guard again in case hook
    // output itself pushes the session over the safe resume limit.
    messages.push(...hookMessages)
    assertResumeMessageSize(messages)

    return {
      messages,
      turnInterruptionState: deserialized.turnInterruptionState,
      fileHistorySnapshots: log?.fileHistorySnapshots,
      attributionSnapshots: log?.attributionSnapshots,
      contentReplacements: log?.contentReplacements,
      contextCollapseCommits: log?.contextCollapseCommits,
      contextCollapseSnapshot: log?.contextCollapseSnapshot,
      sessionId,
      // Include session metadata for restoring agent context on resume
      agentName: log?.agentName,
      agentColor: log?.agentColor,
      agentSetting: log?.agentSetting,
      customTitle: log?.customTitle,
      tag: log?.tag,
      mode: log?.mode,
      worktreeSession: log?.worktreeSession,
      prNumber: log?.prNumber,
      prUrl: log?.prUrl,
      prRepository: log?.prRepository,
      goal,
      // Include full path for cross-directory resume
      fullPath: log?.fullPath,
    }
  } catch (error) {
    logError(error as Error)
    throw error
  }
}

export async function loadConversationForResumeFromPr(
  selector: true | string,
): ReturnType<typeof loadConversationForResume> {
  const log = findResumeLogByPrSelector(await loadMessageLogs(), selector)
  if (!log) return null
  return loadConversationForResume(log, undefined)
}

export async function findResumeSessionIdByPrSelector(
  selector: true | string,
): Promise<UUID | null> {
  const log = findResumeLogByPrSelector(await loadMessageLogs(), selector)
  if (!log) return null
  return getSessionIdFromLog(log) ?? null
}
