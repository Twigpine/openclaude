/**
 * Message type definitions — reconstructed from runtime usage.
 *
 * The upstream Anthropic source defines a rich Message discriminated union;
 * that file is not mirrored to this open snapshot. This reconstruction
 * restores the discriminated-union SHAPE (the thing `any` stubs break —
 * narrowing via `message.type` / `message.subtype` / type predicates) while
 * keeping each variant's body permissive:
 *
 *   - every envelope variant declares its literal discriminant(s) plus the
 *     properties call sites actually read/construct, and
 *   - carries a `[key: string]: any` index signature as an escape hatch so
 *     properties not yet reconstructed never produce TS2339.
 *
 * Constructor functions (createUserMessage, createSystemMessage, … in
 * src/utils/messages.ts) are the ground truth for required vs optional
 * fields. See src/types/logs.ts SerializedMessage for the same pattern
 * applied to transcript entries, and issue #473 for the typecheck-foundation
 * effort.
 */

import type { APIError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaRawMessageStreamEvent,
  BetaToolUseBlock,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'
import type { Progress } from '../Tool.js'
import type { Attachment } from '../utils/attachments.js'
import type { HookProgress } from './hooks.js'
import type { PermissionMode } from './permissions.js'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Shared scalar types
// ---------------------------------------------------------------------------

export type SystemMessageLevel =
  | 'info'
  | 'warning'
  | 'error'
  | 'suggestion'
  | 'debug'

/** Provenance of a user message. undefined = human (keyboard). */
export type MessageOrigin =
  | { kind: 'human' }
  | { kind: 'coordinator' }
  | { kind: 'task-notification' }
  | { kind: 'channel'; server: string }

/** Direction for partial /compact: summarize up to or from a pivot message. */
export type PartialCompactDirection = 'up_to' | 'from'

export type CompactMetadata = {
  trigger: 'manual' | 'auto'
  preTokens: number
  userContext?: string
  messagesSummarized?: number
  preservedSegment?: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  }
  [key: string]: any
}

/** Per-hook info shown in stop-hook summaries (command + timing). */
export type StopHookInfo = {
  command: string
  promptText?: string
  durationMs?: number
  [key: string]: any
}

// ---------------------------------------------------------------------------
// Core envelope variants
// ---------------------------------------------------------------------------

/**
 * Generic over the content shape so NormalizedUserMessage (exactly one
 * content block per message) can share the envelope without `Omit` — Omit
 * over an index-signature type collapses keyof to `string` and silently
 * drops the `type` discriminant, breaking union narrowing.
 */
export interface UserMessage<C = string | ContentBlockParam[]> {
  type: 'user'
  uuid: UUID
  timestamp: string
  message: {
    role: 'user'
    content: C
    [key: string]: any
  }
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  /**
   * Set when a context-collapse summary placeholder is converted to (or merged
   * into) a user message. Keeps the `<collapsed>` summary non-snippable: the
   * snip-tag sweep skips these, and merges that absorb a summary inherit the
   * flag and drop any pre-baked snip id, so the only replacement for an archived
   * span can never be queued for removal.
   */
  isCollapseSummary?: boolean
  summarizeMetadata?: {
    messagesSummarized: number
    userContext?: string
    direction?: PartialCompactDirection
    [key: string]: any
  }
  /** Matches the tool's `Output` type for tool_result messages. */
  toolUseResult?: unknown
  /** Per-image tool-result owner; null marks an independent user image. */
  imagePermissionToolUseIds?: Array<string | null>
  /** Internal marker for synthetic tool_result messages created by agent step limits. */
  isAgentStepLimitToolResult?: boolean
  /** MCP protocol metadata passed through to SDK consumers. */
  mcpMeta?: {
    _meta?: Record<string, unknown>
    structuredContent?: Record<string, unknown>
  }
  imagePasteIds?: number[]
  /** UUID of the assistant message containing the matching tool_use. */
  sourceToolAssistantUUID?: UUID
  /** Keeps tool-spawned user messages transient until the tool resolves. */
  sourceToolUseID?: string
  /** Permission mode when the message was sent (for rewind restoration). */
  permissionMode?: PermissionMode
  origin?: MessageOrigin
  [key: string]: any
}

/**
 * API response body. Structural rather than the SDK's BetaMessage because
 * (a) synthetic constructors don't populate every SDK-required field
 * (e.g. stop_details), and (b) SDK-facing consumers require assignability
 * to `Record<string, unknown> & { role: 'assistant'; content: unknown[] }`,
 * which an interface without an index signature can never satisfy.
 */
export type AssistantMessageContent<T = BetaContentBlock> = {
  role: 'assistant'
  content: T[]
  id: string
  model: string
  usage: BetaUsage
  type?: 'message'
  stop_reason?: any
  stop_sequence?: any
  container?: any
  context_management?: any
  [key: string]: any
}

/** Generic over the content-block type — see UserMessage for why no Omit. */
export interface AssistantMessage<T = BetaContentBlock> {
  type: 'assistant'
  uuid: UUID
  timestamp: string
  /** Full API response body (synthetic messages use SYNTHETIC_MODEL). */
  message: AssistantMessageContent<T>
  requestId?: string
  /** Coarse error tag, e.g. 'max_output_tokens' | 'max_tokens_too_high'. */
  apiError?: string
  /** SDKAssistantMessageError — kept permissive to avoid an entrypoint dep. */
  error?: any
  errorDetails?: string
  isApiErrorMessage?: boolean
  isVirtual?: boolean
  isMeta?: boolean
  advisorModel?: string
  [key: string]: any
}

export interface AttachmentMessage<T = Attachment> {
  type: 'attachment'
  attachment: T
  uuid: UUID
  timestamp: string
  [key: string]: any
}

export interface ProgressMessage<T = Progress> {
  type: 'progress'
  data: T
  toolUseID: string
  parentToolUseID: string
  uuid: UUID
  timestamp: string
  [key: string]: any
}

// ---------------------------------------------------------------------------
// System message family (discriminated on `subtype`)
// ---------------------------------------------------------------------------

interface SystemMessageBase {
  type: 'system'
  uuid: UUID
  timestamp: string
  level?: SystemMessageLevel
  isMeta?: boolean
  content?: string
  toolUseID?: string
  preventContinuation?: boolean
  [key: string]: any
}

export interface SystemInformationalMessage extends SystemMessageBase {
  subtype: 'informational'
  content: string
  /**
   * Marks a context-collapse summary placeholder. The transcript renders it
   * like any informational notice, but normalizeMessagesForAPI converts it into
   * a user message so the `<collapsed>` summary still reaches the model after
   * the archived span is removed.
   */
  isCollapseSummary?: boolean
}

export interface SystemPermissionRetryMessage extends SystemMessageBase {
  subtype: 'permission_retry'
  content: string
  commands: string[]
}

export interface SystemBridgeStatusMessage extends SystemMessageBase {
  subtype: 'bridge_status'
  content: string
  url: string
  upgradeNudge?: string
}

export interface SystemScheduledTaskFireMessage extends SystemMessageBase {
  subtype: 'scheduled_task_fire'
  content: string
}

export interface SystemStopHookSummaryMessage extends SystemMessageBase {
  subtype: 'stop_hook_summary'
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  /** Hook event label, e.g. 'PreToolUse' (defaults to Stop hooks). */
  hookLabel?: string
  totalDurationMs?: number
}

export interface SystemTurnDurationMessage extends SystemMessageBase {
  subtype: 'turn_duration'
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export interface SystemAwaySummaryMessage extends SystemMessageBase {
  subtype: 'away_summary'
  content: string
}

export interface SystemMemorySavedMessage extends SystemMessageBase {
  subtype: 'memory_saved'
  writtenPaths: string[]
}

export interface SystemAgentsKilledMessage extends SystemMessageBase {
  subtype: 'agents_killed'
}

export interface SystemApiMetricsMessage extends SystemMessageBase {
  subtype: 'api_metrics'
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export interface SystemLocalCommandMessage extends SystemMessageBase {
  subtype: 'local_command'
  content: string
}

export interface SystemCompactBoundaryMessage extends SystemMessageBase {
  subtype: 'compact_boundary'
  compactMetadata: CompactMetadata
  /** Preserves logical parent when parentUuid is nullified at the boundary. */
  logicalParentUuid?: UUID | null
}

export interface SystemMicrocompactBoundaryMessage extends SystemMessageBase {
  subtype: 'microcompact_boundary'
  content: string
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
    [key: string]: any
  }
}

export interface SystemAPIErrorMessage extends SystemMessageBase {
  subtype: 'api_error'
  error: APIError
  cause?: Error
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

/** Snapshot of session files (plan, todos) persisted for remote sessions. */
export interface SystemFileSnapshotMessage extends SystemMessageBase {
  subtype: 'file_snapshot'
  content: string
  snapshotFiles: { key: string; path: string; content: string }[]
}

/** Rendered as null in the transcript (placeholder for thinking state). */
export interface SystemThinkingMessage extends SystemMessageBase {
  subtype: 'thinking'
}

/** Boundary marker written when HISTORY_SNIP removes messages from context. */
export interface SystemSnipBoundaryMessage extends SystemMessageBase {
  subtype: 'snip_boundary'
  content: string
  snipMetadata: {
    removedUuids: UUID[]
    [key: string]: any
  }
}

export type SystemMessage =
  | SystemInformationalMessage
  | SystemPermissionRetryMessage
  | SystemBridgeStatusMessage
  | SystemScheduledTaskFireMessage
  | SystemStopHookSummaryMessage
  | SystemTurnDurationMessage
  | SystemAwaySummaryMessage
  | SystemMemorySavedMessage
  | SystemAgentsKilledMessage
  | SystemApiMetricsMessage
  | SystemLocalCommandMessage
  | SystemCompactBoundaryMessage
  | SystemMicrocompactBoundaryMessage
  | SystemAPIErrorMessage
  | SystemFileSnapshotMessage
  | SystemThinkingMessage
  | SystemSnipBoundaryMessage

// ---------------------------------------------------------------------------
// The Message union
// ---------------------------------------------------------------------------

export type Message =
  | UserMessage
  | AssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// Stream / control envelopes (yielded alongside Message, not part of it)
// ---------------------------------------------------------------------------

export interface StreamEvent {
  type: 'stream_event'
  event: BetaRawMessageStreamEvent
  /** Set on message_start events for API-metrics reporting. */
  ttftMs?: number
  [key: string]: any
}

export interface RequestStartEvent {
  type: 'stream_request_start'
  [key: string]: any
}

/** Removes the targeted message from the UI instead of appending. */
export interface TombstoneMessage {
  type: 'tombstone'
  message: Message
  [key: string]: any
}

/** SDK-only human-readable progress summary after tool batches complete. */
export interface ToolUseSummaryMessage {
  type: 'tool_use_summary'
  summary: string
  precedingToolUseIds: string[]
  uuid: UUID
  timestamp: string
  [key: string]: any
}

/** Message produced by a hook (yielded into the conversation stream). */
export type HookResultMessage = AttachmentMessage | ProgressMessage<HookProgress>

// ---------------------------------------------------------------------------
// Normalized messages (one content block per message; see normalizeMessages)
// ---------------------------------------------------------------------------

export type NormalizedUserMessage = UserMessage<ContentBlockParam[]>

export type NormalizedAssistantMessage<T = BetaContentBlock> =
  AssistantMessage<T>

export type NormalizedMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | AttachmentMessage
  | ProgressMessage
  | SystemMessage

// ---------------------------------------------------------------------------
// UI-only synthetic wrappers (grouping / collapsing for rendering)
// ---------------------------------------------------------------------------

/** Two or more tool_uses of the same tool from one API response. */
export interface GroupedToolUseMessage {
  type: 'grouped_tool_use'
  toolName: string
  messages: NormalizedAssistantMessage<BetaToolUseBlock>[]
  results: NormalizedUserMessage[]
  displayMessage: NormalizedAssistantMessage<BetaToolUseBlock>
  /** `grouped-${firstMsg.uuid}` — synthetic, not a real UUID. */
  uuid: string
  timestamp: string
  messageId: string
  [key: string]: any
}

/** Messages eligible for read/search collapsing (see collapseReadSearch). */
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | NormalizedUserMessage
  | GroupedToolUseMessage

/** Consecutive read/search operations collapsed into a summary row. */
export interface CollapsedReadSearchGroup {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: CollapsibleMessage[]
  displayMessage: CollapsibleMessage
  uuid: UUID
  timestamp: string
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: { sha: string; kind: any }[]
  pushes?: { branch: string }[]
  branches?: { ref: string; action: any }[]
  prs?: { number: number; url?: string; action: any }[]
  hookTotalMs?: number
  hookCount?: number
  hookInfos?: StopHookInfo[]
  relevantMemories?: { path: string; content: string; mtimeMs: number }[]
  [key: string]: any
}

/** Everything the transcript renderer can receive (no progress messages). */
export type RenderableMessage =
  | Exclude<NormalizedMessage, ProgressMessage>
  | GroupedToolUseMessage
  | CollapsedReadSearchGroup
