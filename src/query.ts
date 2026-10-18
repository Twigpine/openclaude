// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import { isMainThreadGoalSource } from './services/goal/controller.js'
import {
  calculateTokenWarningState,
  getAutoCompactThreshold,
  isAutoCompactEnabled,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { consumeCompactionRequest } from './utils/memoryPressure.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
import type { MicrocompactResult } from './services/compact/microCompact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { isHumanTurn } from './utils/messagePredicates.js'
import { logError } from './utils/log.js'
import {
  getProviderMaxTokensCapFromMessage,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  getMissingToolResultAbortMessage,
  getQueryAbortSystemMessage,
  normalizeAbortReason,
  shouldCreateUserInterruptionMessage,
} from './utils/abortReasons.js'
import {
  flushInterruptionTrace,
  getInterruptionSignalAbortEventId,
  traceInterruptionEvent,
} from './utils/interruptionTrace.js'
import {
  createAssistantMessage,
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
} from './utils/messages.js'
import { analyzeContinuationIntent } from './utils/continuation.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
import {
  getMaxActiveMessagesHardCap,
  isAboveMaxActiveMessagesLimit,
  parseMaxActiveMessagesLimit,
  resolveMaxActiveMessagesLimit,
} from './utils/maxActiveMessages.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getDefaultMainLoopModelSetting,
  getProviderRequestModel,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { resolveNextFallbackProviderFromState } from './utils/providerFallback.js'
import { setActiveProviderProfile, getActiveProviderProfile } from './utils/providerProfiles.js'
import { getPrimaryModel } from './utils/providerModels.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import {
  createToolFailureLoopGuardState,
  updateToolFailureLoopGuard,
} from './query/toolFailureLoopGuard.js'
import { AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX } from './query/agentStepLimit.js'
import { buildQueryConfig } from './query/config.js'
import {
  MAX_MESSAGES_COMPACTION_THRESHOLDS,
  getGlobalConfig,
  isValidMaxMessagesCompactionThreshold,
  normalizeMaxMessagesCompactionThreshold,
} from './utils/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
  getSessionId,
} from './bootstrap/state.js'
import { stripThinkingBlocksIfProviderAllows } from './utils/conversationRecovery.js'
import {
  decideTurnModel,
  deriveUserTurnNumber,
  extractLatestUserText,
  isRetryableRoutedModelError,
  latestUserMessageHasNonTextContent,
  recordRoutingDecision,
  recordRoutingEscalation,
  shouldDropPinForProviderSwap,
  type TurnRoutingDecision,
} from './services/api/smartRouting/index.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

async function cleanupComputerUseAtTerminal(
  toolUseContext: ToolUseContext,
): Promise<void> {
  // feature() must remain the direct condition so external builds eliminate
  // the native Computer Use dependency at bundle time.
  if (feature('CHICAGO_MCP')) {
    if (toolUseContext.agentId) return
    try {
      const { cleanupComputerUseAfterTurn } = await import(
        './utils/computerUse/cleanup.js'
      )
      await cleanupComputerUseAfterTurn(toolUseContext)
    } catch {
      // Failures are silent — this is dogfooding cleanup, not critical path.
    }
  }
}

function traceAbortMessageSelection(
  signal: AbortSignal,
  phase: 'streaming' | 'tools' | 'post-tools',
): void {
  const abortReason = signal.reason
  const createsUserInterruption = shouldCreateUserInterruptionMessage(abortReason)
  const createsSystemWarning = getQueryAbortSystemMessage(abortReason) !== null
  traceInterruptionEvent('query.abort_classified', {
    subsystem: 'query',
    phase,
    reason: abortReason,
    causalEventId: getInterruptionSignalAbortEventId(signal),
    outcome: createsUserInterruption
      ? 'user_interruption'
      : createsSystemWarning
        ? 'system_warning'
        : 'silent',
  })
  flushInterruptionTrace('query_abort_classified')
}

async function* emitAbortedStreaming(
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
): AsyncGenerator<
  Message,
  Extract<Terminal, { reason: 'aborted_streaming' }>
> {
  await cleanupComputerUseAtTerminal(toolUseContext)
  const abortReason = signal.reason
  traceAbortMessageSelection(signal, 'streaming')
  const abortSystemMessage = getQueryAbortSystemMessage(abortReason)
  if (abortSystemMessage) {
    yield createSystemMessage(abortSystemMessage, 'warning')
  }
  if (shouldCreateUserInterruptionMessage(abortReason)) {
    yield createUserInterruptionMessage({ toolUse: false })
  }
  return { reason: 'aborted_streaming' }
}

function* emitAbortedToolsAfterCleanup(
  signal: AbortSignal,
  maxTurns: number | undefined,
  nextTurnCount: number,
  hasSharedTurnBudget: boolean,
): Generator<Message, Extract<Terminal, { reason: 'aborted_tools' }>> {
  const abortReason = signal.reason
  traceAbortMessageSelection(signal, 'tools')
  const abortSystemMessage = getQueryAbortSystemMessage(abortReason)
  if (abortSystemMessage) {
    yield createSystemMessage(abortSystemMessage, 'warning')
  }
  if (shouldCreateUserInterruptionMessage(abortReason)) {
    yield createUserInterruptionMessage({ toolUse: true })
  }
  if (
    maxTurns &&
    nextTurnCount > maxTurns &&
    (!hasSharedTurnBudget || normalizeAbortReason(abortReason) !== 'background')
  ) {
    yield createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns,
      turnCount: nextTurnCount,
    })
  }
  return { reason: 'aborted_tools' }
}

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // Extract all tool use blocks from this assistant message
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // Emit an interruption message for each tool use
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * The rules of thinking are lengthy and fortuitous. They require plenty of thinking
 * of most long duration and deep meditation for a wizard to wrap one's noggin around.
 *
 * The rules follow:
 * 1. A message that contains a thinking or redacted_thinking block must be part of a query whose max_thinking_length > 0
 * 2. A thinking block may not be the last message in a block
 * 3. Thinking blocks must be preserved for the duration of an assistant trajectory (a single turn, or if that turn includes a tool_use block then also its subsequent tool_result and the following assistant message)
 *
 * Heed these rules well, young wizard. For they are the rules of thinking, and
 * the rules of thinking are the rules of the universe. If ye does not heed these
 * rules, ye will be punished with an entire day of debugging and hair pulling.
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3
const MAX_CONTINUATION_NUDGES = 20

type AgentStepLimitConfig = {
  maxSteps: number
  agentType?: string
}

type AgentStepLimitState = AgentStepLimitConfig & {
  stepsUsed: number
  summaryRequested: boolean
}

function normalizeAgentStepLimit(
  limit: AgentStepLimitConfig | undefined,
): AgentStepLimitState | undefined {
  if (
    !limit ||
    !Number.isInteger(limit.maxSteps) ||
    limit.maxSteps <= 0
  ) {
    return undefined
  }
  return {
    maxSteps: limit.maxSteps,
    agentType: limit.agentType,
    stepsUsed: 0,
    summaryRequested: false,
  }
}

function findAssistantMessageForToolUse(
  assistantMessages: AssistantMessage[],
  toolUseId: string,
): AssistantMessage | undefined {
  return assistantMessages.find(message =>
    message.message.content.some(
      content => content.type === 'tool_use' && content.id === toolUseId,
    ),
  )
}

function createAgentStepLimitToolResult(
  toolUse: ToolUseBlock,
  assistantMessage: AssistantMessage | undefined,
  limit: AgentStepLimitState,
): UserMessage {
  const content =
    `${AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX} for '${limit.agentType ?? 'subagent'}' ` +
    `(${limit.stepsUsed}/${limit.maxSteps} tool uses). This tool call was not executed. ` +
    'Do not call more tools; provide the final summary requested next.'

  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: `<tool_use_error>${content}</tool_use_error>`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ],
    toolUseResult: content,
    isAgentStepLimitToolResult: true,
    ...(assistantMessage
      ? { sourceToolAssistantUUID: assistantMessage.uuid }
      : {}),
  })
}

function createAgentStepLimitSummaryRequest(
  limit: AgentStepLimitState,
): UserMessage {
  return createUserMessage({
    content:
      `Agent '${limit.agentType ?? 'subagent'}' reached its configured step limit ` +
      `after ${limit.stepsUsed}/${limit.maxSteps} tool uses. Stop using tools now. ` +
      'Provide a concise final summary with these sections: completed work, findings, ' +
      'remaining tasks, and whether another run is needed.',
    isMeta: true,
  })
}

function createAgentStepLimitForcedSummary(
  limit: AgentStepLimitState,
  blockedToolUseCount: number,
): AssistantMessage {
  const blockedCallText =
    blockedToolUseCount === 1
      ? '1 additional tool call was blocked'
      : `${blockedToolUseCount} additional tool calls were blocked`

  return createAssistantMessage({
    content:
      `Completed work: Agent '${limit.agentType ?? 'subagent'}' reached its configured step limit ` +
      `after ${limit.stepsUsed}/${limit.maxSteps} tool uses. ` +
      `Findings: ${blockedCallText} during the forced summary step and no more tools were run. ` +
      'Remaining tasks: continue any unfinished work in another run if more tool access is needed. ' +
      'Another run needed: yes, if the requested task is not complete.',
  })
}

function hasAssistantSummaryText(
  assistantMessage: AssistantMessage | undefined,
): boolean {
  const text = (assistantMessage?.message.content ?? [])
    .map(part =>
      part.type === 'text' && typeof part.text === 'string'
        ? part.text.toLowerCase()
        : '',
    )
    .join('\n')

  return (
    text.includes('completed') &&
    text.includes('findings') &&
    text.includes('remaining tasks') &&
    text.includes('another run')
  )
}

function formatAutoCompactRetryDelay(delayMs: number): string {
  const totalSeconds = Math.max(1, Math.ceil(delayMs / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`
  }
  const totalMinutes = Math.ceil(totalSeconds / 60)
  return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`
}

function createAutoCompactDiagnosticMessage(args: {
  consecutiveFailures?: number
  nextRetryAtMs?: number
  circuitBreakerActive?: boolean
  circuitBreakerTripped?: boolean
}): Message | undefined {
  const {
    consecutiveFailures,
    nextRetryAtMs,
    circuitBreakerActive,
    circuitBreakerTripped,
  } = args

  if (circuitBreakerActive || circuitBreakerTripped) {
    const retryDelayMs =
      nextRetryAtMs !== undefined ? nextRetryAtMs - Date.now() : undefined
    const retryText =
      retryDelayMs !== undefined && retryDelayMs > 0
        ? ` It will retry after ${formatAutoCompactRetryDelay(retryDelayMs)}.`
        : ''
    return createSystemMessage(
      `Automatic compaction is paused after repeated failures.${retryText} OpenClaude will stop before sending oversized requests while the guard is active.`,
      'warning',
    )
  }

  if (
    consecutiveFailures !== undefined &&
    consecutiveFailures > 0
  ) {
    return createSystemMessage(
      `Automatic compaction failed (${consecutiveFailures}/${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES}); OpenClaude will retry compaction on the next eligible turn.`,
      'warning',
    )
  }

  return undefined
}

/**
 * Is this a max_output_tokens error message? If so, the streaming loop should
 * withhold it from SDK callers until we know whether the recovery loop can
 * continue. Yielding early leaks an intermediate error to SDK callers (e.g.
 * cowork/desktop) that terminate the session on any `error` field — the
 * recovery loop keeps running but nobody is listening.
 *
 * Mirrors reactiveCompact.isWithheldPromptTooLong.
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

function isWithheldContextOverflow(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'context_overflow'
}

function shouldRecoverContextOverflow(
  msg: Message | StreamEvent | undefined,
  hasAttemptedContextOverflowRecovery: boolean,
  querySource: QuerySource,
): boolean {
  return (
    !hasAttemptedContextOverflowRecovery &&
    querySource !== 'compact' &&
    querySource !== 'session_memory' &&
    isWithheldContextOverflow(msg)
  )
}

function createContextOverflowRecoveryMessage(): UserMessage {
  return createUserMessage({
    content:
      'The previous provider request exceeded the context window. OpenClaude compacted the conversation and is retrying this turn once; continue from the compacted context, avoid repeating the oversized request shape, and use narrower tool reads if more detail is needed.',
    isMeta: true,
  })
}

function isWithheldProviderMaxTokensCap(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return (
    msg?.type === 'assistant' &&
    getProviderMaxTokensCapFromMessage(msg) !== undefined
  )
}

export type QueryParams = {
  messages: Message[]
  /**
   * Model-visible context for this query call only. Never compacted, yielded,
   * exposed to tools, or written to transcript state.
   */
  requestOnlyMessages?: Message[]
  /** Called around each outbound model request, including retries. */
  onModelRequestStart?: () => void
  onModelRequestEnd?: () => void
  /** Called once provider dispatch is accepted for the current attempt. */
  onProviderDispatchAccepted?: () => void
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  /**
   * Mutable per-prompt budget shared by query() calls that continue the same
   * logical prompt (for example, when a local REPL query is backgrounded).
   */
  turnBudget?: QueryTurnBudget
  skipCacheWrite?: boolean
  autoCompactTracking?: AutoCompactTrackingState
  onAutoCompactTrackingChange?: (
    tracking: AutoCompactTrackingState | undefined,
  ) => void
  // API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
  // Distinct from the tokenBudget +500k auto-continue feature. `total` is the
  // budget for the whole agentic turn; `remaining` is computed per iteration
  // from cumulative API usage. See configureTaskBudgetParams in claude.ts.
  taskBudget?: { total: number }
  agentStepLimit?: AgentStepLimitConfig
  deps?: QueryDeps
}

export type QueryTurnBudget = {
  readonly maxTurns: number | undefined
  turnsStarted: number
}

export function createQueryTurnBudget(
  maxTurns?: number,
): QueryTurnBudget {
  return { maxTurns, turnsStarted: 0 }
}

/**
 * `ultrathink_effort` is emitted while processing the current user input.
 * Its attachment is deliberately transient, but the request-level effort
 * setting must follow it for providers that expose reasoning effort as a wire
 * parameter. The attachment must follow the newest human turn without an
 * intervening meta user message: historical attachments and system-generated
 * prompts must not affect the request's effort. Image metadata is appended
 * after attachments, so it remains eligible.
 */
function hasUltrathinkEffortForCurrentTurn(messages: readonly Message[]): boolean {
  const latestHumanTurn = messages.findLastIndex(isHumanTurn)
  if (latestHumanTurn === -1) {
    return false
  }

  const ultrathinkAttachment = messages.findIndex(
    (message, index) =>
      index > latestHumanTurn &&
      message.type === 'attachment' &&
      message.attachment.type === 'ultrathink_effort',
  )
  if (ultrathinkAttachment === -1) {
    return false
  }

  return !messages
    .slice(latestHumanTurn + 1, ultrathinkAttachment)
    .some(
      message =>
        message.type === 'user' &&
        message.isMeta &&
        message.toolUseResult === undefined,
    )
}

function injectRequestOnlyMessages(
  messages: readonly Message[],
  requestOnlyMessages: readonly Message[] | undefined,
): Message[] {
  if (!requestOnlyMessages?.length) return [...messages]
  const latestUserIndex = messages.findLastIndex(isHumanTurn)
  const insertionIndex = latestUserIndex === -1
    ? messages.length
    : latestUserIndex
  return [
    ...messages.slice(0, insertionIndex),
    ...requestOnlyMessages,
    ...messages.slice(insertionIndex),
  ]
}

// -- query loop state

// Mutable state carried between loop iterations
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  hasAttemptedContextOverflowRecovery: boolean
  maxOutputTokensOverride: number | undefined
  providerMaxOutputTokensCap: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  // One-shot guard for the provider-fallback recovery branch (issue #768).
  // Set when we swap active provider in response to a rate-limit assistant
  // error, cleared at next_turn / continuation_nudge / token_budget_continuation
  // so a fresh user turn can fall back again.
  hasAttemptedProviderFallback: boolean
  turnCount: number
  // Count of consecutive continuation nudges within the current turn.
  // Capped at MAX_CONTINUATION_NUDGES to prevent infinite nudge loops
  // when the model keeps matching continuation signals without tool calls.
  continuationNudgeCount: number
  // Why the previous iteration continued. Undefined on first iteration.
  // Lets tests assert recovery paths fired without inspecting message contents.
  transition: Continue | undefined
  agentStepLimit: AgentStepLimitState | undefined
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // Only reached if queryLoop returned normally. Skipped on throw (error
  // propagates through yield*) and on .return() (Return completion closes
  // both generators). This gives the same asymmetric started-without-completed
  // signal as print.ts's drainCommandQueue when the turn fails.
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // Reset this agent's doom loop detection at the start of each query turn.
  // Keyed by agentId so a subagent starting mid-turn doesn't wipe the main
  // thread's counter (or a sibling agent's).
  const { resetDoomLoop } = await import('./utils/doomLoop.js')
  resetDoomLoop(params.toolUseContext.agentId)

  // Start a new turn for multi-turn context tracking
  if (
    feature('MULTI_TURN_CONTEXT') &&
    getGlobalConfig().knowledgeGraphEnabled
  ) {
    const { startNewTurn } = await import('./utils/multiTurnContext.js')
    startNewTurn()
  }

  // Immutable params — never reassigned during the query loop.
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    skipCacheWrite,
  } = params
  const maxTurns = params.turnBudget
    ? params.turnBudget.maxTurns
    : params.maxTurns
  const initialTurnCount = params.turnBudget
    ? params.turnBudget.turnsStarted + 1
    : 1
  const deps = params.deps ?? productionDeps()
  const ultrathinkEffortForCurrentTurn = hasUltrathinkEffortForCurrentTurn(
    params.messages,
  )

  // Mutable cross-iteration state. The loop body destructures this at the top
  // of each iteration so reads stay bare-name (`messages`, `toolUseContext`).
  // Continue sites write `state = { ... }` instead of 9 separate assignments.
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    providerMaxOutputTokensCap: undefined,
    autoCompactTracking: params.autoCompactTracking,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    hasAttemptedContextOverflowRecovery: false,
    hasAttemptedProviderFallback: false,
    turnCount: initialTurnCount,
    continuationNudgeCount: 0,
    pendingToolUseSummary: undefined,
    transition: undefined,
    agentStepLimit: normalizeAgentStepLimit(params.agentStepLimit),
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  const updateAutoCompactTracking = (
    tracking: AutoCompactTrackingState | undefined,
  ) => {
    params.onAutoCompactTrackingChange?.(tracking)
  }

  // task_budget.remaining tracking across compaction boundaries. Undefined
  // until first compact fires — while context is uncompacted the server can
  // see the full history and handles the countdown from {total} itself (see
  // api/api/sampling/prompt/renderer.py:292). After a compact, the server sees
  // only the summary and would under-count spend; remaining tells it the
  // pre-compact final window that got summarized away. Cumulative across
  // multiple compacts: each subtracts the final context at that compact's
  // trigger point. Loop-local (not on State) to avoid touching the 7 continue
  // sites.
  let taskBudgetRemaining: number | undefined = undefined
  // Request-only context can be invalidated by a full conversation rewrite.
  // Keep it outside the loop so that invalidation survives every retry state.
  let requestOnlyMessages = params.requestOnlyMessages
  let pendingToolFailureAdvisories: {
    message: ReturnType<typeof createUserMessage>
    threshold: number
  }[] = []
  // Smart-routing decision, pinned once per user turn (transition===undefined)
  // and reused on every continuation pass. Loop-local (not on State) so it
  // survives the State rebuilds at the continue sites for free — mirrors
  // taskBudgetRemaining above.
  let pinnedTurnRoute: TurnRoutingDecision | undefined = undefined
  // Provider profile the pinned route's model was resolved against. If a
  // mid-turn provider-fallback swap changes the active provider, the pinned
  // model (a model-only route keyed to the old provider) must not be replayed
  // at the new endpoint — KTD6 in the plan.
  let pinnedRouteProviderId: string | undefined = undefined
  const toolFailureGuardState = createToolFailureLoopGuardState()
  // Identifies the turn this queryLoop invocation claimed in a shared budget.
  // Retries for that turn are allowed; a different invocation that snapped the
  // same next turn is stale and must not dispatch a duplicate provider call.
  let reservedTurnCount: number | undefined = undefined

  // Snapshot immutable env/statsig/session state once at entry. See QueryConfig
  // for what's included and why feature() gates are intentionally excluded.
  const config = buildQueryConfig()

  // Ctrl+B can abort the foreground while it is still preparing query
  // context. Let the background continuation reserve the turn in that race;
  // the aborted invocation never reached a provider request and must not
  // consume the shared prompt budget.
  if (
    params.turnBudget &&
    state.toolUseContext.abortController.signal.aborted
  ) {
    return yield* emitAbortedStreaming(
      state.toolUseContext.abortController.signal,
      state.toolUseContext,
    )
  }

  // Reject an invocation that cannot start another provider turn. Do not
  // reserve it here: context preparation below can await, and Ctrl+B may hand
  // the prompt off before any provider request is dispatched.
  if (maxTurns && state.turnCount > maxTurns) {
    await cleanupComputerUseAtTerminal(state.toolUseContext)
    yield createAttachmentMessage({
      type: 'max_turns_reached',
      maxTurns,
      turnCount: state.turnCount,
    })
    return { reason: 'max_turns', turnCount: state.turnCount }
  }

  // Fired once per user turn — the prompt is invariant across loop iterations,
  // so per-iteration firing would ask sideQuery the same question N times.
  // Consume point polls settledAt (never blocks). `using` disposes on all
  // generator exit paths — see MemoryPrefetch for dispose/telemetry semantics.
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  const activeGoal = state.toolUseContext.getAppState().goal
  if (
    activeGoal?.status === 'active' &&
    isMainThreadGoalSource(querySource, state.toolUseContext)
  ) {
    traceInterruptionEvent('goal.main_turn_started', {
      subsystem: 'goal',
      phase: 'main_query',
      querySource,
      attemptId: activeGoal.id,
    })
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Destructure state at the top of each iteration. toolUseContext alone
    // is reassigned within an iteration (queryTracking, messages updates);
    // the rest are read-only between continue sites.
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      hasAttemptedContextOverflowRecovery,
      hasAttemptedProviderFallback,
      maxOutputTokensOverride,
      providerMaxOutputTokensCap,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
      agentStepLimit,
    } = state
    const effectiveMaxOutputTokensOverride =
      maxOutputTokensOverride === undefined
        ? providerMaxOutputTokensCap
        : providerMaxOutputTokensCap === undefined
          ? maxOutputTokensOverride
          : Math.min(maxOutputTokensOverride, providerMaxOutputTokensCap)

    // Skill discovery prefetch — per-iteration (uses findWritePivot guard
    // that returns early on non-write iterations). Discovery runs while the
    // model streams and tools execute; awaited post-tools alongside the
    // memory prefetch consume. Replaces the blocking assistant_turn path
    // that ran inside getAttachmentMessages (97% of those calls found
    // nothing in prod). Turn-0 user-input discovery still blocks in
    // userInputAttachments — that's the one signal where there's no prior
    // work to hide under.
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // Record query start for headless latency tracking (skip for subagents)
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // Initialize or increment query chain tracking
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]
    if (pendingToolFailureAdvisories.length > 0) {
      messagesForQuery.push(
        ...pendingToolFailureAdvisories.map(advisory => advisory.message),
      )
    }

    // Extract facts and update phase from the latest message (user input or tool result)
    if (
      feature('CONVERSATION_ARC') &&
      getGlobalConfig().knowledgeGraphEnabled &&
      messagesForQuery.length > 0
    ) {
      const { updateArcPhase } = await import('./utils/conversationArc.js')
      await updateArcPhase([messagesForQuery[messagesForQuery.length - 1]])
    }

    let tracking = autoCompactTracking
    const configuredMaxMessagesCompactionThreshold =
      getGlobalConfig().maxMessagesCompactionThreshold
    const maxMessagesCompactionThreshold =
      normalizeMaxMessagesCompactionThreshold(
        configuredMaxMessagesCompactionThreshold,
      )

    // Enforce per-message budget on aggregate tool result size. Runs BEFORE
    // microcompact — cached MC operates purely by tool_use_id (never inspects
    // content), so content replacement is invisible to it and the two compose
    // cleanly. No-ops when contentReplacementState is undefined (feature off).
    // Persist only for querySources that read records back on resume: agentId
    // routes to sidechain file (AgentTool resume) or session file (/resume).
    // Ephemeral runForkedAgent callers (agent_summary etc.) don't persist.
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    const toolResultBudgetResult = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )
    messagesForQuery = toolResultBudgetResult.messages
    if (toolResultBudgetResult.newlyReplaced.length > 0) {
      toolUseContext.syncToolResultReplacements?.(
        toolUseContext.contentReplacementState?.replacements ?? new Map(),
      )
    }

    // Apply snip before microcompact (both may run — they are not mutually exclusive).
    // snipTokensFreed is plumbed to autocompact so its threshold check reflects
    // what snip removed; tokenCountWithEstimation alone can't see it (reads usage
    // from the protected-tail assistant, which survives snip unchanged).
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage as Message
      }
      queryCheckpoint('query_snip_end')
    }

    // Apply microcompact before autocompact
    queryCheckpoint('query_microcompact_start')
    let microcompactResult: MicrocompactResult | undefined
    if (
      querySource === 'compact' ||
      configuredMaxMessagesCompactionThreshold !== 'off'
    ) {
      microcompactResult = await deps.microcompact(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = microcompactResult.messages
    }
    // For cached microcompact (cache editing), defer boundary message until after
    // the API response so we can use actual cache_deleted_input_tokens.
    // Gated behind feature() so the string is eliminated from external builds.
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult?.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // Project the collapsed context view and maybe commit more collapses.
    // Runs BEFORE autocompact so that if collapse gets us under the
    // autocompact threshold, autocompact is a no-op and we keep granular
    // context instead of a single summary.
    //
    // Nothing is yielded — the collapsed view is a read-time projection
    // over the REPL's full history. Summary messages live in the collapse
    // store, not the REPL array. This is what makes collapses persist
    // across turns: projectView() replays the commit log on every entry.
    // Within a turn, the view flows forward via state.messages at the
    // continue site (query.ts:1192), and the next projectView() no-ops
    // because the archived messages are already gone from its input.
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    // arcSummary must be a separate array element; concatenating it into a
    // template string makes [...systemPrompt] spread chars, shredding the prompt.
    let promptWithArc: readonly string[] = systemPrompt
    if (feature('CONVERSATION_ARC')) {
      const { appendArcToSystemPrompt } = await import('./utils/conversationArc.js')
      promptWithArc = await appendArcToSystemPrompt(systemPrompt, messagesForQuery)
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(asSystemPrompt(promptWithArc), systemContext),
    )

    // Force compaction if memory pressure detected or message count exceeded.
    // Sets forceReason on tracking so autoCompactIfNeeded bypasses the
    // token-threshold check. Consumed once (one-shot) inside autocompact.
    // Skip for compact/session_memory sources — those run inside an existing
    // compaction and forcing would deadlock via recursive autocompaction.
    const canForceCompact =
      querySource !== 'compact' && querySource !== 'session_memory'
    // An unset UI setting keeps the legacy environment override. Without that
    // override, enforce the new effective 200-message default.
    const hasValidLegacyActiveMessageLimit =
      parseMaxActiveMessagesLimit(process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES) > 0
    const maxMessagesLimitSetting =
      configuredMaxMessagesCompactionThreshold === undefined &&
      hasValidLegacyActiveMessageLimit
        ? undefined
        : maxMessagesCompactionThreshold
    const hasExplicitMessageCountThreshold =
      configuredMaxMessagesCompactionThreshold !== undefined &&
      isValidMaxMessagesCompactionThreshold(configuredMaxMessagesCompactionThreshold) &&
      configuredMaxMessagesCompactionThreshold !== 'off'
    const hasActiveMessageLimitOverride =
      hasExplicitMessageCountThreshold ||
      ((configuredMaxMessagesCompactionThreshold === undefined ||
        configuredMaxMessagesCompactionThreshold === 'off') &&
        hasValidLegacyActiveMessageLimit)
    const activeMessageLimit = canForceCompact
      ? resolveMaxActiveMessagesLimit(
          maxMessagesLimitSetting,
          process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES,
        )
      : 0
    if (canForceCompact) {
      if (
        isAboveMaxActiveMessagesLimit(messagesForQuery.length, activeMessageLimit) &&
        (isAutoCompactEnabled() ||
          hasActiveMessageLimitOverride ||
          isAboveMaxActiveMessagesLimit(
            messagesForQuery.length,
            getMaxActiveMessagesHardCap(),
          ))
      ) {
        tracking = {
          ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
          forceReason: 'message-count',
        }
      }
      if (consumeCompactionRequest()) {
        tracking = {
          ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
          forceReason: tracking?.forceReason ?? 'memory-pressure',
        }
      }
    }

    queryCheckpoint('query_autocompact_start')
    const {
      compactionResult,
      consecutiveFailures,
      nextRetryAtMs,
      lastFailureAtMs,
      circuitBreakerActive,
      circuitBreakerTripped,
    } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      // A full rewrite removes the interrupted turn this correction context
      // refers to, so it cannot be valid for the compacted request.
      requestOnlyMessages = undefined
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget: capture pre-compact final context window before
      // messagesForQuery is replaced with postCompactMessages below.
      // iterations[-1] is the authoritative final window (post server tool
      // loops); see #304930.
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // Reset on every compact so turnCounter/turnId reflect the MOST RECENT
      // compact. recompactionInfo (autoCompact.ts:190) already captured the
      // old values for turnsSincePreviousCompact/previousCompactTurnId before
      // the call, so this reset doesn't lose those.
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }
      updateAutoCompactTracking(tracking)

      const postCompactMessages = buildPostCompactMessages(compactionResult)
      const messagesAfterCompact =
        state.transition?.reason === 'context_overflow_compact_retry'
          ? [...postCompactMessages, createContextOverflowRecoveryMessage()]
          : postCompactMessages

      for (const message of postCompactMessages) {
        yield message
      }

      // Continue on with the current query call using the post compact messages
      messagesForQuery = [
        ...messagesAfterCompact,
        ...pendingToolFailureAdvisories
          .filter(
            advisory =>
              !messagesAfterCompact.some(
                message => message.uuid === advisory.message.uuid,
              ),
          )
          .map(advisory => advisory.message),
      ]
    } else if (
      consecutiveFailures !== undefined ||
      nextRetryAtMs !== undefined ||
      lastFailureAtMs !== undefined ||
      circuitBreakerActive !== undefined ||
      circuitBreakerTripped !== undefined
    ) {
      // Autocompact returned breaker metadata. Thread it through the loop so
      // cooldown can skip retry storms, expire, and then half-open retry.
      const nextTracking: AutoCompactTrackingState = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
      }
      if (consecutiveFailures !== undefined) {
        nextTracking.consecutiveFailures = consecutiveFailures
      }
      if (nextRetryAtMs !== undefined) {
        nextTracking.nextRetryAtMs = nextRetryAtMs
      } else {
        delete nextTracking.nextRetryAtMs
      }
      if (lastFailureAtMs !== undefined) {
        nextTracking.lastFailureAtMs = lastFailureAtMs
      }
      tracking = nextTracking
      updateAutoCompactTracking(tracking)

      const diagnosticMessage = createAutoCompactDiagnosticMessage({
        consecutiveFailures,
        nextRetryAtMs,
        circuitBreakerActive,
        circuitBreakerTripped,
      })
      if (diagnosticMessage) {
        yield diagnosticMessage
      }
    }

    //TODO: no need to set toolUseContext.messages during set-up since it is updated here
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see https://docs.claude.com/en/docs/build-with-claude/tool-use
    // Note: stop_reason === 'tool_use' is unreliable -- it's not always set correctly.
    // Set during streaming whenever a tool_use block arrives — the sole
    // loop-exit signal. If false after streaming, we're done (modulo stop-hook retry).
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution =
      config.gates.streamingToolExecution && agentStepLimit === undefined
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    const appStateMainLoopModel =
      appState.mainLoopModelForSession ??
      appState.mainLoopModel ??
      getDefaultMainLoopModelSetting()
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: parseUserSpecifiedModel(appStateMainLoopModel),
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    // Smart routing (opt-in): classify once per user turn (transition===undefined)
    // and pin the decision; reuse the pin on every continuation pass. Applied
    // BEFORE the blocking-limit math below so the token-budget guard and the
    // model call agree on the model. Disabled/misconfigured → pin is `routed:false`
    // and currentModel keeps today's resolution (byte-for-byte unchanged).
    if (state.transition === undefined) {
      pinnedTurnRoute = decideTurnModel({
        settings: appState.settings as unknown as Parameters<typeof decideTurnModel>[0]['settings'],
        parentModel: currentModel,
        permissionMode,
        input: {
          userText: extractLatestUserText(messagesForQuery),
          hasNonTextContent: latestUserMessageHasNonTextContent(messagesForQuery),
          turnNumber: deriveUserTurnNumber(messagesForQuery),
        },
        sessionId: getSessionId(),
      })
      if (pinnedTurnRoute.routed === false && pinnedTurnRoute.justDisabledForSession) {
        yield createSystemMessage(
          'Smart routing disabled for this session: both configured models are outside the org allowlist. Using the default model.',
          'warning',
        )
      }
      if (pinnedTurnRoute.routed) {
        recordRoutingDecision(pinnedTurnRoute.complexity)
        pinnedRouteProviderId = getActiveProviderProfile()?.id
      }
    } else if (
      shouldDropPinForProviderSwap(
        pinnedTurnRoute,
        pinnedRouteProviderId,
        getActiveProviderProfile()?.id,
      )
    ) {
      // A provider-fallback swap happened mid-turn: the pinned model belongs to
      // the previous provider. Drop the pin and let today's resolution (already
      // re-derived to the new provider's model above) stand for the rest of the
      // turn rather than sending a stale model id to the new endpoint.
      pinnedTurnRoute = undefined
    }
    // Apply whatever pin survived the guard above (may be undefined after an
    // invalidation, in which case currentModel keeps today's resolution).
    if (pinnedTurnRoute?.routed) {
      const priorModel = currentModel
      currentModel = pinnedTurnRoute.model
      toolUseContext.options.mainLoopModel = pinnedTurnRoute.model
      // A model change at the turn boundary would replay a prior model's
      // thinking signature; strip it under the provider gate (never for
      // preserve-reasoning providers, which 400 on a stripped block).
      if (pinnedTurnRoute.model !== priorModel) {
        messagesForQuery = stripThinkingBlocksIfProviderAllows(
          messagesForQuery as unknown as Parameters<typeof stripThinkingBlocksIfProviderAllows>[0],
        ) as unknown as typeof messagesForQuery
      }
    }

    queryCheckpoint('query_setup_end')

    // Create fetch wrapper once per query session to avoid memory retention.
    // Each call to createDumpPromptsFetch creates a closure that captures the request body.
    const dumpPromptsFetch = undefined

    // Block if we've hit the hard blocking limit (only applies when auto-compact is OFF)
    // This reserves space so users can still run /compact manually
    // Skip this check if compaction just happened - the compaction result is already
    // validated to be under the threshold, and tokenCountWithEstimation would use
    // stale input_tokens from kept messages that reflect pre-compaction context size.
    // Same staleness applies to snip: subtract snipTokensFreed (otherwise we'd
    // falsely block in the window where snip brought us under autocompact threshold
    // but the stale usage is still above blocking limit — before this PR that
    // window never existed because autocompact always fired on the stale count).
    // Also skip for compact/session_memory queries — these are forked agents that
    // inherit the full conversation and would deadlock if blocked here (the compact
    // agent needs to run to REDUCE the token count).
    // Also skip when reactive compact is enabled and automatic compaction is
    // allowed — the preempt's synthetic error returns before the API call,
    // so reactive compact would never see a prompt-too-long to react to.
    // Widened to walrus so RC can act as fallback when proactive fails.
    //
    // Same skip for context-collapse: its recoverFromOverflow drains
    // staged collapses on a REAL API 413, then falls through to
    // reactiveCompact. A synthetic preempt here would return before the
    // API call and starve both recovery paths. The isAutoCompactEnabled()
    // conjunct preserves the user's explicit "no automatic anything"
    // config — if they set DISABLE_AUTO_COMPACT, they get the preempt.
    // hasActiveReduction() (not mere enablement) means a turn where collapse
    // could not reduce anything still hits the blocking preempt instead of
    // sending an oversized request that only a real 413 could recover.
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      // Only the main thread that owns the reduction may skip the blocking
      // preempt: the store is shared with in-process subagents (agent:*), and a
      // subagent must still preempt its own oversized turn rather than defer to
      // a reduction that does not apply to its messages.
      collapseOwnsIt =
        (contextCollapse?.isMainThreadSource(querySource) ?? false) &&
        (contextCollapse?.hasActiveReduction() ?? false) &&
        isAutoCompactEnabled()
    }
    // Hoist media-recovery gate once per turn. Withholding (inside the
    // stream loop) and recovery (after) must agree; CACHED_MAY_BE_STALE can
    // flip during the 5-30s stream, and withhold-without-recover would eat
    // the message. PTL doesn't hoist because its withholding is ungated —
    // it predates the experiment and is already the control-arm baseline.
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    if (
      state.transition?.reason === 'context_overflow_compact_retry' &&
      !compactionResult
    ) {
      yield createAssistantAPIErrorMessage({
        content:
          'The provider reported a context-window overflow, but automatic compaction could not reduce the conversation before retry. Run /compact, undo recent large output, or start a new session with /new.',
        apiError: 'context_overflow',
        error: 'invalid_request',
      })
      return { reason: 'blocking_limit' }
    }

    // Safety net: when auto-compact's circuit breaker has tripped, the normal
    // blocking check above may be gated on reactiveCompact. If compaction is
    // cooling down or otherwise exhausted and context or message count is still
    // over the safety threshold, block immediately with a clear message instead
    // of burning an oversized API call.
    const isAboveActiveMessageHardCap = isAboveMaxActiveMessagesLimit(
      messagesForQuery.length,
      getMaxActiveMessagesHardCap(),
    )
    const shouldEnforceActiveMessageLimit =
      (!collapseOwnsIt && isAutoCompactEnabled()) ||
      hasActiveMessageLimitOverride ||
      isAboveActiveMessageHardCap
    if (
      tracking?.consecutiveFailures !== undefined &&
      tracking.consecutiveFailures >=
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES &&
      (isAutoCompactEnabled() ||
        circuitBreakerActive === true ||
        circuitBreakerTripped === true)
    ) {
      const model = toolUseContext.options.mainLoopModel
      const tokenUsage = tokenCountWithEstimation(messagesForQuery) - snipTokensFreed
      const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
        tokenUsage,
        model,
      )
      const isAboveActiveMessageSafetyLimit =
        isAboveMaxActiveMessagesLimit(
          messagesForQuery.length,
          activeMessageLimit,
        ) && shouldEnforceActiveMessageLimit
      const isAboveBreakerThreshold =
        isAboveAutoCompactThreshold ||
        ((circuitBreakerActive === true || circuitBreakerTripped === true) &&
          tokenUsage >= getAutoCompactThreshold(model)) ||
        isAboveActiveMessageSafetyLimit
      if (isAboveBreakerThreshold) {
        const nowMs = Date.now()
        const retryDelayMs =
          tracking.nextRetryAtMs !== undefined
            ? tracking.nextRetryAtMs - nowMs
            : undefined
        const content =
          retryDelayMs !== undefined && retryDelayMs > 0
            ? 'The conversation is over the auto-compact safety threshold, but automatic compaction is cooling down after repeated failures. ' +
              'OpenClaude stopped before sending another oversized request. ' +
              `Retry after ${formatAutoCompactRetryDelay(retryDelayMs)}, run /compact, or start a new session with /new.`
            : 'The conversation is over the auto-compact safety threshold and automatic compaction has failed repeatedly. ' +
              'OpenClaude stopped before sending another oversized request. Run /compact, undo recent large tool output, or start a new session with /new.'
        yield createAssistantAPIErrorMessage({
          content,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    if (
      shouldEnforceActiveMessageLimit &&
      isAboveMaxActiveMessagesLimit(
        messagesForQuery.length,
        activeMessageLimit,
      )
    ) {
      yield createAssistantAPIErrorMessage({
        content:
          'The conversation is over the active-message safety limit, but automatic compaction could not reduce it before the next provider request. OpenClaude stopped before sending another oversized request. Run /compact, undo recent large tool output, or start a new session with /new.',
        error: 'invalid_request',
      })
      return { reason: 'blocking_limit' }
    }

    let attemptWithFallback = true
    const toolsForModel = agentStepLimit?.summaryRequested
      ? []
      : toolUseContext.options.tools
    // The blocking-limit returns above are terminal, so an advisory cannot be
    // surfaced or retained for a later model turn on those paths.
    const advisoriesForCurrentRequest = pendingToolFailureAdvisories
    for (const advisory of advisoriesForCurrentRequest) {
      logForDebugging(
        `Tool failure loop guard advisory: threshold=${advisory.threshold} hasToolName=true hasErrorCategory=true`,
      )
      logEvent('tengu_tool_failure_loop_guard_advisory', {
        threshold: advisory.threshold,
        hasToolName: true,
        hasErrorCategory: true,
        queryDepth: queryTracking.depth,
      })
    }
    pendingToolFailureAdvisories = []
    // Once-only guard for the smart-routing routed-error fallback (U4): a
    // simple-routed call that errors retries once on the strong model; a second
    // failure propagates normally rather than re-routing. Intentionally scoped
    // per user turn (here, outside the while(attemptWithFallback) retry loop) —
    // moving it inside would reset it every attempt and defeat the once-only
    // guarantee.
    let routedFallbackUsed = false

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          // queryModel performs provider-specific asynchronous preparation.
          // Claim the turn from its callback immediately before the actual
          // request is dispatched, not merely when callModel is entered.
          let providerDispatchRejected = false
          let providerDispatchAccepted = false
          let modelRequestLifecycleStarted = false
          try {
            // Arm interruption correction and other per-attempt hooks before
            // callModel performs async provider preparation.
            params.onModelRequestStart?.()
            modelRequestLifecycleStarted = true
            for await (const message of deps.callModel({
            messages: prependUserContext(
              injectRequestOnlyMessages(
                messagesForQuery,
                requestOnlyMessages,
              ),
              userContext,
            ),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolsForModel,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              requestModel: pinnedTurnRoute?.routed
                ? currentModel
                : getProviderRequestModel(appStateMainLoopModel, currentModel),
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride: effectiveMaxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              queryLifecycle: toolUseContext.queryLifecycle,
              onProviderRequestStart: () => {
                if (toolUseContext.abortController.signal.aborted) {
                  providerDispatchRejected = true
                  return false
                }
                // Retries reuse this turn's reservation, but they must still
                // prove the foreground owns dispatch after any asynchronous
                // credential refresh or client recreation.
                if (providerDispatchAccepted) return true
                if (
                  params.turnBudget &&
                  params.turnBudget.turnsStarted >= turnCount &&
                  reservedTurnCount !== turnCount
                ) {
                  providerDispatchRejected = true
                  return false
                }
                // Fallback attempts reuse turnCount. The local reservation
                // makes retries idempotent while rejecting a stale claimant.
                if (
                  params.turnBudget &&
                  params.turnBudget.turnsStarted < turnCount
                ) {
                  params.turnBudget.turnsStarted = turnCount
                  reservedTurnCount = turnCount
                }
                providerDispatchAccepted = true
                params.onProviderDispatchAccepted?.()
                return true
              },
              // Explicit /effort selection wins. When it is unset, carry the
              // current turn's ultrathink attachment through to the API client
              // so OpenAI-compatible providers receive reasoning_effort=high
              // instead of only a natural-language system reminder.
              effortValue:
                appState.effortValue ??
                (ultrathinkEffortForCurrentTurn ? 'high' : undefined),
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              providerOverride: toolUseContext.options.providerOverride,
              ...(toolsForModel !== toolUseContext.options.tools && {
                messageNormalizationTools: toolUseContext.options.tools,
              }),
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
            })) {
            // We won't use the tool_calls from the first attempt
            // We could.. but then we'd have to merge assistant messages
            // with different ids and double up on full the tool_results
            if (streamingFallbackOccured) {
              // Yield tombstones for orphaned messages so they're removed from UI and transcript.
              // These partial messages (especially thinking blocks) have invalid signatures
              // that would cause "thinking blocks cannot be modified" API errors.
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // Discard pending results from the failed streaming attempt and create
              // a fresh executor. This prevents orphan tool_results (with old tool_use_ids)
              // from being yielded after the fallback response arrives.
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // Backfill tool_use inputs on a cloned message before yield so
            // SDK stream output and transcript serialization see legacy/derived
            // fields. The original `message` is left untouched for
            // assistantMessages.push below — it flows back to the API and
            // mutating it would break prompt caching (byte mismatch).
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // Only yield a clone when backfill ADDED fields; skip if
                    // it only OVERWROTE existing ones (e.g. file tools
                    // expanding file_path). Overwrites change the serialized
                    // transcript and break VCR fixture hashes on resume,
                    // while adding nothing the SDK stream needs — hooks get
                    // the expanded path via toolExecution.ts separately.
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // Withhold recoverable errors (prompt-too-long, max-output-tokens)
            // until we know whether recovery (collapse drain / reactive
            // compact / truncation retry) can succeed. Still pushed to
            // assistantMessages so the recovery checks below find them.
            // Either subsystem's withhold is sufficient — they're
            // independent so turning one off doesn't break the other's
            // recovery path.
            //
            // feature() only works in if/ternary conditions (bun:bundle
            // tree-shaking constraint), so the collapse check is nested
            // rather than composed.
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (
              shouldRecoverContextOverflow(
                message,
                hasAttemptedContextOverflowRecovery,
                querySource,
              )
            ) {
              withheld = true
            }
            if (isWithheldProviderMaxTokensCap(message)) {
              withheld = true
            }
            // Withhold rate-limit errors when a providerFallbackChain entry is
            // still available, so SDK consumers that terminate on yielded
            // errors don't see the original 429 before queryLoop has a chance
            // to switch providers and retry (jatmn review on #1176). The
            // recovery branch below mirrors the same querySource / one-shot
            // guards. If no fallback resolves, the recovery branch falls
            // through to the standard error-termination path which yields
            // the original error so the user still sees it.
            if (
              !hasAttemptedProviderFallback &&
              querySource !== 'compact' &&
              querySource !== 'session_memory' &&
              message.type === 'assistant' &&
              message.isApiErrorMessage === true &&
              message.error === 'rate_limit' &&
              resolveNextFallbackProviderFromState() !== null
            ) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
            }
            if (providerDispatchRejected) {
              if (toolUseContext.abortController.signal.aborted) {
                return yield* emitAbortedStreaming(
                  toolUseContext.abortController.signal,
                  toolUseContext,
                )
              }
              return { reason: 'aborted_streaming' }
            }
          } finally {
            if (modelRequestLifecycleStarted) params.onModelRequestEnd?.()
          }
          queryCheckpoint('query_api_streaming_end')

          // Yield deferred microcompact boundary message using actual API-reported
          // token deletion count instead of client-side estimates.
          // Entire block gated behind feature() so the excluded string
          // is eliminated from external builds.
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // The API field is cumulative/sticky across requests, so we
            // subtract the baseline captured before this request to get the delta.
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // Fallback was triggered - switch model and retry
            currentModel = fallbackModel
            attemptWithFallback = true

            // Clear assistant messages since we'll retry the entire request
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // Discard pending results from the failed attempt and create a
            // fresh executor. This prevents orphan tool_results (with old
            // tool_use_ids) from leaking into the retry.
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // Update tool use context with new model
            toolUseContext.options.mainLoopModel = fallbackModel

            // Thinking signatures are model-bound: replaying a protected-thinking
            // block (e.g. capybara) to an unprotected fallback (e.g. opus) 400s.
            // Strip before retry so the fallback model gets clean history.

            // Log the fallback event
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // Yield system message about fallback — use 'warning' level so
            // users see the notification without needing verbose mode
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          // Smart-routing routed-error fallback (U4): a simple-routed call that
          // errors retries once on the strong model. Reuses this same
          // attemptWithFallback retry loop — not a new retry mechanism. Aborts
          // and 4xx client errors (auth/permission/bad-request) are NOT retried.
          if (
            pinnedTurnRoute?.routed &&
            pinnedTurnRoute.complexity === 'simple' &&
            !routedFallbackUsed &&
            !(innerError instanceof FallbackTriggeredError) &&
            !toolUseContext.abortController.signal.aborted &&
            isRetryableRoutedModelError(innerError)
          ) {
            const strongModel = pinnedTurnRoute.strongModel
            routedFallbackUsed = true
            attemptWithFallback = true
            recordRoutingEscalation()
            // Re-pin to strong so this turn's later continuation passes (next_turn)
            // don't re-route to the failing simple model and fall back again.
            pinnedTurnRoute = {
              routed: true,
              model: strongModel,
              complexity: 'strong',
              reason: 'fell back from simple model',
              strongModel,
            }

            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Smart-routing fallback to strong model',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            currentModel = strongModel
            toolUseContext.options.mainLoopModel = strongModel
            // Strip prior-model thinking before retrying on the strong model,
            // under the provider gate (never for preserve-reasoning providers).
            messagesForQuery = stripThinkingBlocksIfProviderAllows(
              messagesForQuery as unknown as Parameters<typeof stripThinkingBlocksIfProviderAllows>[0],
            ) as unknown as typeof messagesForQuery

            yield createSystemMessage(
              `Smart routing: retrying on ${renderModelName(strongModel)} after the simple model failed`,
              'warning',
            )
            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // Handle image size/resize errors with user-friendly messages
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // Generally queryModelWithStreaming should not throw errors but instead
      // yield them as synthetic assistant messages. However if it does throw
      // due to a bug, we may end up in a state where we have already emitted
      // a tool_use block but will stop before emitting the tool_result.
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // Surface the real error instead of a misleading "[Request interrupted
      // by user]" — this path is a model/runtime failure, not a user action.
      // SDK consumers were seeing phantom interrupts on unsupported runtimes
      // with missing built-ins, masking the actual cause.
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // To help track down bugs, log loudly for ants
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // Execute post-sampling hooks after model response is complete
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // We need to handle a streaming abort before anything else.
    // When using streamingToolExecutor, we must consume getRemainingResults() so the
    // executor can generate synthetic tool_result blocks for queued/in-progress tools.
    // Without this, tool_use blocks would lack matching tool_result blocks.
    if (toolUseContext.abortController.signal.aborted) {
      const abortReason = toolUseContext.abortController.signal.reason
      traceAbortMessageSelection(toolUseContext.abortController.signal, 'post-tools')
      if (streamingToolExecutor) {
        // Consume remaining results - executor generates synthetic tool_results for
        // aborted tools since it checks the abort signal in executeTool()
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          getMissingToolResultAbortMessage(abortReason),
        )
      }
      // chicago MCP: auto-unhide + lock release on interrupt. Same cleanup
      // as the natural turn-end path in stopHooks.ts. Main thread only —
      // see stopHooks.ts for the subagent-releasing-main's-lock rationale.
      await cleanupComputerUseAtTerminal(toolUseContext)

      const abortSystemMessage = getQueryAbortSystemMessage(abortReason)
      if (abortSystemMessage) {
        yield createSystemMessage(abortSystemMessage, 'warning')
      }

      if (shouldCreateUserInterruptionMessage(abortReason)) {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // Yield tool use summary from previous turn — haiku (~1s) resolved during model streaming (5-30s)
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long recovery: the streaming loop withheld the error
      // (see withheldByCollapse / withheldByReactive above). Try collapse
      // drain first (cheap, keeps granular context), then reactive compact
      // (full summary). Single-shot on each — if a retry still 413's,
      // the next stage handles it or the error surfaces.
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // Media-size rejections (image/PDF/many-image) are recoverable via
      // reactive compact's strip-retry. Unlike PTL, media errors skip the
      // collapse drain — collapse doesn't strip images. mediaRecoveryEnabled
      // is the hoisted gate from before the stream loop (same value as the
      // withholding check — these two must agree or a withheld message is
      // lost). If the oversized media is in the preserved tail, the
      // post-compact turn will media-error again; hasAttemptedReactiveCompact
      // prevents a spiral and the error surfaces.
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // First: drain all staged context-collapses. Gated on the PREVIOUS
        // transition not being collapse_drain_retry — if we already drained
        // and the retry still 413'd, fall through to reactive compact.
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            // Draining replaces archived history with a summary, so a reminder
            // about the pre-collapse interrupted turn is no longer valid.
            requestOnlyMessages = undefined
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              hasAttemptedContextOverflowRecovery,
              hasAttemptedProviderFallback,
              maxOutputTokensOverride: undefined,
              providerMaxOutputTokensCap,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              continuationNudgeCount: state.continuationNudgeCount,
              agentStepLimit,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // The reactive path also replaces the complete conversation; do not
          // re-inject request-only context whose referent was compacted away.
          requestOnlyMessages = undefined
          // task_budget: same carryover as the proactive path above.
          // messagesForQuery still holds the pre-compact array here (the
          // 413-failed attempt's input).
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          const messagesAfterCompact = [
            ...postCompactMessages,
            ...advisoriesForCurrentRequest
              .filter(
                advisory =>
                  !postCompactMessages.some(
                    message => message.uuid === advisory.message.uuid,
                  ),
              )
              .map(advisory => advisory.message),
          ]
          for (const msg of postCompactMessages) {
            yield msg
          }
          updateAutoCompactTracking(undefined)
          const next: State = {
            messages: messagesAfterCompact,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            hasAttemptedContextOverflowRecovery,
            hasAttemptedProviderFallback,
            maxOutputTokensOverride: undefined,
            providerMaxOutputTokensCap,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            continuationNudgeCount: state.continuationNudgeCount,
            agentStepLimit,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // No recovery — surface the withheld error and exit. Do NOT fall
        // through to stop hooks: the model never produced a valid response,
        // so hooks have nothing meaningful to evaluate. Running stop hooks
        // on prompt-too-long creates a death spiral: error → hook blocking
        // → retry → error → … (the hook injects more tokens each cycle).
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact compiled out but contextCollapse withheld and
        // couldn't recover (staged queue empty/stale). Surface. Same
        // early-return rationale — don't fall through to stop hooks.
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      if (
        shouldRecoverContextOverflow(
          lastMessage,
          hasAttemptedContextOverflowRecovery,
          querySource,
        )
      ) {
        yield createSystemMessage(
          'Provider context limit reached; compacting conversation and retrying turn.',
          'warning',
        )
        const nextTracking: AutoCompactTrackingState = {
          ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
          forceReason: 'context-overflow',
        }
        const next: State = {
          messages: messagesForQuery,
          toolUseContext,
          autoCompactTracking: nextTracking,
          maxOutputTokensRecoveryCount,
          hasAttemptedReactiveCompact,
          hasAttemptedContextOverflowRecovery: true,
          hasAttemptedProviderFallback,
          maxOutputTokensOverride: undefined,
          providerMaxOutputTokensCap,
          pendingToolUseSummary: undefined,
          stopHookActive: undefined,
          turnCount,
          continuationNudgeCount: state.continuationNudgeCount,
          agentStepLimit,
          transition: { reason: 'context_overflow_compact_retry' },
        }
        state = next
        continue
      }

      if (isWithheldProviderMaxTokensCap(lastMessage)) {
        const providerMaxTokensCap =
          getProviderMaxTokensCapFromMessage(lastMessage)
        const shouldRetryWithProviderCap =
          providerMaxTokensCap !== undefined &&
          state.transition?.reason !== 'provider_max_tokens_retry' &&
          (effectiveMaxOutputTokensOverride === undefined ||
            providerMaxTokensCap < effectiveMaxOutputTokensOverride)

        if (shouldRetryWithProviderCap) {
          const nextProviderMaxOutputTokensCap =
            providerMaxOutputTokensCap === undefined
              ? providerMaxTokensCap
              : Math.min(providerMaxOutputTokensCap, providerMaxTokensCap)
          logEvent('tengu_provider_max_tokens_cap_retry', {
            cap: providerMaxTokensCap,
            ...(effectiveMaxOutputTokensOverride !== undefined && {
              previousMaxOutputTokensOverride:
                effectiveMaxOutputTokensOverride,
            }),
          })
          yield createSystemMessage(
            `Provider maximum output tokens limit is ${providerMaxTokensCap.toLocaleString('en-US')}; retrying with that cap.`,
            'warning',
          )
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            hasAttemptedContextOverflowRecovery,
            hasAttemptedProviderFallback,
            maxOutputTokensOverride,
            providerMaxOutputTokensCap: nextProviderMaxOutputTokensCap,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            continuationNudgeCount: state.continuationNudgeCount,
            agentStepLimit,
            transition: {
              reason: 'provider_max_tokens_retry',
              cap: providerMaxTokensCap,
            },
          }
          state = next
          continue
        }

        yield lastMessage
      }

      // Check for max_output_tokens and inject recovery message. The error
      // was withheld from the stream above; only surface it if recovery
      // exhausts.
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // Escalating retry: if we used the capped 8k default and hit the
        // limit, retry the SAME request at 64k — no meta message, no
        // multi-turn dance. This fires once per turn (guarded by the
        // override check), then falls through to multi-turn recovery if
        // 64k also hits the cap.
        // 3P default: false (not validated on Bedrock/Vertex)
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          effectiveMaxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            hasAttemptedContextOverflowRecovery,
            hasAttemptedProviderFallback,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            providerMaxOutputTokensCap,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            continuationNudgeCount: state.continuationNudgeCount,
            agentStepLimit,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            hasAttemptedContextOverflowRecovery,
            hasAttemptedProviderFallback,
            maxOutputTokensOverride: undefined,
            providerMaxOutputTokensCap,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            continuationNudgeCount: state.continuationNudgeCount,
            agentStepLimit,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // Recovery exhausted — surface the withheld error now.
        yield lastMessage
      }

      // Provider-fallback recovery (#768). When the active provider returns
      // a rate-limit error and the user has configured an ordered
      // `providerFallbackChain`, swap to the next chain entry and retry the
      // turn once instead of bubbling the error to the UI. Skip for
      // compact / session_memory fork queries — those are forked workers
      // operating on the original conversation's tail; switching the active
      // provider mid-fork would change the credentials the outer turn just
      // committed to. Mirrors the pre-flight blocking-limit guard at
      // ~query.ts:691.
      const isWithheldRateLimit =
        !hasAttemptedProviderFallback &&
        querySource !== 'compact' &&
        querySource !== 'session_memory' &&
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage === true &&
        lastMessage.error === 'rate_limit'
      if (isWithheldRateLimit) {
        const fallback = resolveNextFallbackProviderFromState()
        if (fallback !== null) {
          const activated = setActiveProviderProfile(fallback.nextProfileId)
          if (activated) {
            const fromLabel = fallback.fromProfileId ?? 'previous provider'
            // Update the in-session model to the activated profile's primary
            // model so the retry doesn't keep sending the rate-limited
            // provider's model id against the new endpoint. Without this, the
            // outer loop re-derives `currentModel` from
            // `appState.mainLoopModelForSession ?? appState.mainLoopModel`,
            // which still holds the previous provider's model (e.g. a Claude
            // id), and `resolveProviderRequest` lets that explicit
            // `options.model` win over the new profile's OPENAI_MODEL. Mirror
            // the model_fallback branch above which updates both
            // `toolUseContext.options.mainLoopModel` and the in-session app
            // state.
            const activatedModel = getPrimaryModel(activated.model)
            if (activatedModel) {
              toolUseContext.setAppState(prev => ({
                ...prev,
                mainLoopModel: activatedModel,
                mainLoopModelForSession: null,
              }))
              toolUseContext.options.mainLoopModel = activatedModel
            }
            // System informational, NOT an assistant API error. The original
            // 429 is still withheld upstream, so SDK hosts that terminate on
            // `error: 'rate_limit'` assistant messages don't see one for this
            // retry path — they only get the final tagged message if the
            // entire fallback chain is exhausted (handled by `yield
            // lastMessage` below). Mirrors the existing model-fallback notice
            // at the model_fallback recovery branch.
            yield createSystemMessage(
              `Provider ${fromLabel} rate-limited — switched to ${activated.name}. Retrying turn.`,
              'warning',
            )
            const next: State = {
              messages: messagesForQuery,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              hasAttemptedContextOverflowRecovery,
              hasAttemptedProviderFallback: true,
              maxOutputTokensOverride: undefined,
              providerMaxOutputTokensCap: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              continuationNudgeCount: state.continuationNudgeCount,
              agentStepLimit,
              transition: { reason: 'provider_fallback_retry' },
            }
            state = next
            continue
          }
        }
        // No fallback configured / chain exhausted / activation failed — yield
        // the original rate-limit message now (the streaming withhold gate
        // suppressed it so SDK consumers wouldn't see it before we knew a
        // fallback was possible) and fall through to the standard API-error
        // termination below.
        yield lastMessage
      }

      // Skip stop hooks when the last message is an API error (rate limit,
      // prompt-too-long, auth failure, etc.). The model never produced a
      // real response — hooks evaluating it create a death spiral:
      // error → hook blocking → retry → error → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
        deps.goalEvaluationDeps,
        deps.stopHookExecutionDeps,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // Preserve the reactive compact guard — if compact already ran and
          // couldn't recover from prompt-too-long, retrying after a stop-hook
          // blocking error will produce the same result. Resetting to false
          // here caused an infinite loop: compact → still too long → error →
          // stop hook blocking → compact → … burning thousands of API calls.
          hasAttemptedReactiveCompact,
          hasAttemptedContextOverflowRecovery,
          // Same logic for the provider-fallback guard — a stop-hook blocking
          // error after a fallback switch is unrelated to which provider is
          // active, so preserve rather than re-fall-back.
          hasAttemptedProviderFallback,
          maxOutputTokensOverride: undefined,
          providerMaxOutputTokensCap,
          pendingToolUseSummary: undefined,
          stopHookActive: stopHookResult.stopHookActive,
          turnCount,
          continuationNudgeCount: state.continuationNudgeCount,
          agentStepLimit,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            hasAttemptedContextOverflowRecovery: false,
            hasAttemptedProviderFallback: false,
            maxOutputTokensOverride: undefined,
            providerMaxOutputTokensCap,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            continuationNudgeCount: state.continuationNudgeCount,
            agentStepLimit,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      // Continuation nudge: detect when the model signals intent to continue
      // (e.g., "so now I have to do it", "let me now...", "I'll need to...")
      // but returned no tool calls. This prevents premature task completion.
      //
      // Guard: capped at MAX_CONTINUATION_NUDGES to prevent infinite loops
      // when the model keeps matching signals without ever calling tools.
      if (
        assistantMessages.length > 0 &&
        !agentStepLimit?.summaryRequested &&
        turnCount < (maxTurns ?? Infinity) &&
        state.continuationNudgeCount < MAX_CONTINUATION_NUDGES
      ) {
        const lastAssistant = assistantMessages.at(-1)
        if (lastAssistant?.type === 'assistant') {
          const lastText = lastAssistant.message.content
            .filter(
              (b): b is Extract<typeof b, { type: 'text' }> =>
                b.type === 'text',
            )
            .map(b => b.text)
            .join(' ')
            .toLowerCase()

          const { shouldNudge, reason: nudgeReason } = analyzeContinuationIntent(
            lastText,
          )

          if (shouldNudge) {
            logForDebugging(
              `Continuation nudge triggered (${state.continuationNudgeCount + 1}/${MAX_CONTINUATION_NUDGES}): ${nudgeReason} detected in "${lastText.slice(-120)}" without tool calls`,
            )
            const nudge = createUserMessage({
              content:
                'Continue with the task. If you were interrupted, resume your thought. Otherwise, use the appropriate tools to proceed to the next step.',
              isMeta: true,
            })
            const next: State = {
              messages: [...messagesForQuery, ...assistantMessages, nudge],
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount: 0,
              hasAttemptedReactiveCompact: false,
              hasAttemptedContextOverflowRecovery: false,
              hasAttemptedProviderFallback: false,
              maxOutputTokensOverride: undefined,
              providerMaxOutputTokensCap,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              continuationNudgeCount: state.continuationNudgeCount + 1,
              agentStepLimit,
              transition: { reason: 'continuation_nudge' },
            }
            state = next
            continue
          }
        }
      }

      if (agentStepLimit?.summaryRequested) {
        return {
          reason: 'agent_step_limit',
          turnCount,
          stepsUsed: agentStepLimit.stepsUsed,
          maxSteps: agentStepLimit.maxSteps,
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')

    let toolUseBlocksToExecute = toolUseBlocks
    let blockedToolUseBlocks: ToolUseBlock[] = []
    let nextAgentStepLimit = agentStepLimit
    let shouldRequestAgentStepSummary = false
    const shouldTerminateAgentStepSummary =
      agentStepLimit?.summaryRequested === true && toolUseBlocks.length > 0

    if (agentStepLimit) {
      if (agentStepLimit.summaryRequested) {
        toolUseBlocksToExecute = []
        blockedToolUseBlocks = toolUseBlocks
      } else {
        const remainingSteps = Math.max(
          0,
          agentStepLimit.maxSteps - agentStepLimit.stepsUsed,
        )
        toolUseBlocksToExecute = toolUseBlocks.slice(0, remainingSteps)
        blockedToolUseBlocks = toolUseBlocks.slice(remainingSteps)
        const stepsUsed =
          agentStepLimit.stepsUsed + toolUseBlocksToExecute.length
        const summaryRequested =
          stepsUsed >= agentStepLimit.maxSteps ||
          blockedToolUseBlocks.length > 0

        nextAgentStepLimit = {
          ...agentStepLimit,
          stepsUsed,
          summaryRequested,
        }
        shouldRequestAgentStepSummary = summaryRequested
      }
    }

    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(
          toolUseBlocksToExecute,
          assistantMessages,
          canUseTool,
          toolUseContext,
        )

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }

    if (nextAgentStepLimit && blockedToolUseBlocks.length > 0) {
      for (const toolUse of blockedToolUseBlocks) {
        const message = createAgentStepLimitToolResult(
          toolUse,
          findAssistantMessageForToolUse(assistantMessages, toolUse.id),
          nextAgentStepLimit,
        )
        yield message
        toolResults.push(message)
      }
    }

    if (shouldTerminateAgentStepSummary && nextAgentStepLimit) {
      if (!hasAssistantSummaryText(assistantMessages.at(-1))) {
        yield createAgentStepLimitForcedSummary(
          nextAgentStepLimit,
          blockedToolUseBlocks.length,
        )
      }
      return {
        reason: 'agent_step_limit',
        turnCount,
        stepsUsed: nextAgentStepLimit.stepsUsed,
        maxSteps: nextAgentStepLimit.maxSteps,
      }
    }

    queryCheckpoint('query_tool_execution_end')

    // Track multi-turn context after tool execution
    if (
      feature('MULTI_TURN_CONTEXT') &&
      getGlobalConfig().knowledgeGraphEnabled
    ) {
      const { addMessageToTurn, addToolCallToTurn } = await import(
        './utils/multiTurnContext.js'
      )
      for (const assistantMessage of assistantMessages) {
        addMessageToTurn(assistantMessage)
      }
      for (const toolUse of toolUseBlocks) {
        addToolCallToTurn({
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input as Record<string, unknown>,
          timestamp: Date.now(),
        })
      }
    }

    // Update conversation arc phase
    if (
      feature('CONVERSATION_ARC') &&
      getGlobalConfig().knowledgeGraphEnabled
    ) {
      const { updateArcPhase, finalizeArcTurn } = await import(
        './utils/conversationArc.js'
      )
      await updateArcPhase(assistantMessages)
      await finalizeArcTurn()
    }

    // We were aborted during tool calls
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP: auto-unhide + lock release when aborted mid-tool-call.
      // This is the most likely Ctrl+C path for CU (e.g. slow screenshot).
      // Main thread only — see stopHooks.ts for the subagent rationale.
      await cleanupComputerUseAtTerminal(toolUseContext)
      return yield* emitAbortedToolsAfterCleanup(
        toolUseContext.abortController.signal,
        maxTurns,
        turnCount + 1,
        params.turnBudget !== undefined,
      )
    }

    // If a hook indicated to prevent continuation, stop here
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    const toolFailureLoopDecision = updateToolFailureLoopGuard({
      state: toolFailureGuardState,
      toolUseBlocks,
      toolResults,
    })
    if (toolFailureLoopDecision.tripped) {
      logForDebugging(
        `Tool failure loop guard tripped: kind=${toolFailureLoopDecision.kind} ` +
          `threshold=${toolFailureLoopDecision.threshold} ` +
          `hasToolName=${toolFailureLoopDecision.toolName !== undefined} ` +
          `hasErrorCategory=${toolFailureLoopDecision.errorCategory !== undefined} ` +
          `hasPath=${toolFailureLoopDecision.path !== undefined}`,
      )
      logEvent('tengu_tool_failure_loop_guard_tripped', {
        threshold: toolFailureLoopDecision.threshold,
        isPathTrip: toolFailureLoopDecision.kind === 'path',
        isSignatureTrip: toolFailureLoopDecision.kind === 'signature',
        isCategoryTrip: toolFailureLoopDecision.kind === 'category',
        hasToolName: toolFailureLoopDecision.toolName !== undefined,
        hasErrorCategory:
          toolFailureLoopDecision.errorCategory !== undefined,
        hasPath: toolFailureLoopDecision.path !== undefined,
        queryDepth: queryTracking.depth,
      })
      yield createAssistantAPIErrorMessage({
        content: toolFailureLoopDecision.message,
      })
      return { reason: 'tool_failure_loop' }
    }

    if (shouldRequestAgentStepSummary && nextAgentStepLimit) {
      const summaryRequest =
        createAgentStepLimitSummaryRequest(nextAgentStepLimit)
      yield summaryRequest
      toolResults.push(summaryRequest)
      logForDebugging(
        `[Agent: ${nextAgentStepLimit.agentType ?? 'subagent'}] Reached maxSteps limit (${nextAgentStepLimit.stepsUsed}/${nextAgentStepLimit.maxSteps}); requesting final summary`,
      )
      logEvent('tengu_agent_step_limit_reached', {
        agent_type:
          (nextAgentStepLimit.agentType ??
            'subagent') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        steps_used: nextAgentStepLimit.stepsUsed,
        max_steps: nextAgentStepLimit.maxSteps,
        blocked_tool_uses: blockedToolUseBlocks.length,
      })
    }

    // Generate tool use summary after tool batch completes — passed to next recursive call
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagents don't surface in mobile UI — skip the Haiku call
    ) {
      // Extract the last assistant text block for context
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // Collect tool info for summary generation
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // Find the corresponding tool result
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // Fire off summary generation without blocking the next API call
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    if (tracking?.compacted) {
      tracking = {
        ...tracking,
        turnCounter: tracking.turnCounter + 1,
      }
      updateAutoCompactTracking(tracking)
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // Be careful to do this after tool calls are done, because the API
    // will error if we interleave tool_result messages with regular user messages.

    // Instrumentation: Track message count before attachments
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // Get queued commands snapshot before processing attachments.
    // These will be sent as attachments so Claude can respond to them in the current turn.
    //
    // Drain pending notifications. LocalShellTask completions are 'next'
    // (when MONITOR_TOOL is on) and drain without Sleep. Other task types
    // (agent/workflow/framework) still default to 'later' — the Sleep flush
    // covers those. If all task types move to 'next', this branch could go.
    //
    // Slash commands are excluded from mid-turn drain — they must go through
    // processSlashCommand after the turn ends (via useQueueProcessor), not be
    // sent to the model as text. Bash-mode commands are already excluded by
    // INLINE_NOTIFICATION_MODES in getQueuedCommandAttachments.
    //
    // Agent scoping: the queue is a process-global singleton shared by the
    // coordinator and all in-process subagents. Each loop drains only what's
    // addressed to it — main thread drains agentId===undefined, subagents
    // drain their own agentId. User prompts (mode:'prompt') still go to main
    // only; subagents never see the prompt stream.
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // Subagents only drain task-notifications addressed to them — never
      // user prompts, even if someone stamps an agentId on one.
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // Memory prefetch consume: only if settled and not already consumed on
    // an earlier iteration. If not settled yet, skip (zero-wait) and retry
    // next iteration — the prefetch gets as many chances as there are loop
    // iterations before the turn ends. readFileState (cumulative across
    // iterations) filters out memories the model already Read/Wrote/Edited
    // — including in earlier iterations, which the per-iteration
    // toolUseBlocks array would miss.
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // Inject prefetched skill discovery. collectSkillDiscoveryPrefetch emits
    // hidden_by_main_turn — true when the prefetch resolved before this point
    // (should be >98% at AKI@250ms / Haiku@573ms vs turn durations of 2-30s).
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // Remove only commands that were actually consumed as attachments.
    // Prompt and task-notification commands are converted to attachments above.
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // Instrumentation: Track file change attachments after they're added
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // Refresh tools between turns so newly-connected MCP servers become available
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // Each time we have tool results and are about to recurse, that's a turn
    const nextTurnCount = turnCount + 1

    // Periodic task summary for `claude ps` — fires mid-turn so a
    // long-running agent still refreshes what it's working on. Gated
    // only on !agentId so every top-level conversation (REPL, SDK, HFI,
    // remote) generates summaries; subagents/forks don't.
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // Check if we've reached the max turns limit
    if (
      maxTurns &&
      nextTurnCount > maxTurns &&
      !nextAgentStepLimit?.summaryRequested
    ) {
      await cleanupComputerUseAtTerminal(toolUseContext)
      // Attachment/memory/skill collection above can await after the earlier
      // post-tool abort check. Re-check immediately before emitting the cap so
      // a Ctrl+B handoff cannot make both owners persist the terminal record.
      if (toolUseContext.abortController.signal.aborted) {
        return yield* emitAbortedToolsAfterCleanup(
          toolUseContext.abortController.signal,
          maxTurns,
          nextTurnCount,
          params.turnBudget !== undefined,
        )
      }
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    if (!nextAgentStepLimit?.summaryRequested) {
      pendingToolFailureAdvisories = (
        toolFailureLoopDecision.advisories ?? []
      ).map(advisoryDecision => ({
        message: createUserMessage({
          content: advisoryDecision.message,
          isMeta: true,
        }),
        threshold: advisoryDecision.threshold,
      }))
    }

    queryCheckpoint('query_recursive_call')

    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      hasAttemptedContextOverflowRecovery: false,
      hasAttemptedProviderFallback: false,
      continuationNudgeCount: 0,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      providerMaxOutputTokensCap,
      stopHookActive,
      agentStepLimit: nextAgentStepLimit,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
