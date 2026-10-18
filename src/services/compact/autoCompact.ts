import { feature } from 'bun:bundle'
import { markPostCompaction } from 'src/bootstrap/state.js'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { QuerySource } from '../../constants/querySource.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getGlobalConfig } from '../../utils/config.js'
import {
  getContextWindowForModel,
  getSessionContextWindowOverride,
} from '../../utils/context.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { partitionContext } from '../../utils/contextPartitioning.js'
import {
  normalizeCompactTailTurns,
  pruneByRelevance,
} from '../../utils/relevancePruning.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { getMaxOutputTokensForModel } from '../api/claude.js'
import { notifyCompaction } from '../api/promptCacheBreakDetection.js'
import { setLastSummarizedMessageId } from '../SessionMemory/sessionMemoryUtils.js'
import {
  type CompactionResult,
  compactConversation,
  ERROR_MESSAGE_USER_ABORT,
  type RecompactionInfo,
} from './compact.js'
import { runPostCompactCleanup } from './postCompactCleanup.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

// Reserve this many tokens for output during compaction
// Based on p99.99 of compact summary output being 17,387 tokens.
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

// Returns the context window size minus the max output tokens for the model
export function getEffectiveContextWindowSize(
  model: string,
  runtimeLimits?: { contextWindow?: number; maxOutputTokens?: number },
): number {
  const reservedTokensForSummary = Math.min(
    runtimeLimits?.maxOutputTokens ?? getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(
    model,
    getSdkBetas(),
    runtimeLimits,
  )

  // An explicit per-model session setting is more specific than the legacy
  // auto-compact cap. Otherwise that cap can silently keep a newly configured
  // large context window stuck at (for example) 100k for compaction decisions.
  const internalContextWindowOverride =
    process.env.USER_TYPE === 'ant'
      ? parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '', 10)
      : NaN
  const internalOverrideTakesPrecedence =
    Number.isFinite(internalContextWindowOverride) &&
    internalContextWindowOverride > 0
  const hasSessionOverride =
    getSessionContextWindowOverride(model) !== undefined &&
    !internalOverrideTakesPrecedence
  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow && !hasSessionOverride) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  // Floor: effective context must be at least the summary reservation plus a
  // usable buffer. If it goes lower, the auto-compact threshold becomes
  // negative and fires on every message (issue #635). This floor buffer is
  // intentionally decoupled from AUTOCOMPACT_BUFFER_TOKENS: the latter is the
  // (larger) threshold buffer used by getAutoCompactThreshold(), while this
  // stays at the conservative 13k so getEffectiveContextWindowSize() —
  // also consumed by tool-history compression — is unchanged (issue #1949).
  const autocompactBuffer = AUTOCOMPACT_FLOOR_BUFFER_TOKENS
  const effectiveContext = contextWindow - reservedTokensForSummary
  return Math.max(effectiveContext, reservedTokensForSummary + autocompactBuffer)
}

export type AutoCompactTrackingState = {
  compacted: boolean
  turnCounter: number
  // Unique ID per turn
  turnId: string
  // Consecutive autocompact failures. Reset on success.
  // Used by the cooldown circuit breaker to avoid retry storms when the
  // context is irrecoverably over the limit (e.g., prompt_too_long).
  consecutiveFailures?: number
  // Process-local retry timestamp for the cooldown breaker. This state is
  // threaded through query() callers rather than serialized into transcripts.
  nextRetryAtMs?: number
  lastFailureAtMs?: number
  // When set, bypasses the normal token threshold. Message-count and
  // provider-overflow recovery also bypass user-disable; process-memory
  // pressure respects that setting.
  forceReason?: 'memory-pressure' | 'message-count' | 'context-overflow'
}

// Threshold buffer: auto-compact fires when token usage reaches this far below
// the effective context window. Bumped from 13_000 -> 30_000 so compaction runs
// earlier and with less accumulated history, bounding per-turn latency growth
// in a single session (issue #1949). Kept below the effective-context floor
// (AUTOCOMPACT_FLOOR_BUFFER_TOKENS) for large-context models; for small-context
// models getAutoCompactThreshold() falls back to the floor buffer so the
// threshold can never go negative (issue #635).
export const AUTOCOMPACT_BUFFER_TOKENS = 30_000

// Conservative floor buffer for getEffectiveContextWindowSize(). Must guarantee
// a non-negative auto-compact threshold for small-context models, so it stays at
// the pre-#1949 value of 13_000 and is decoupled from AUTOCOMPACT_BUFFER_TOKENS.
const AUTOCOMPACT_FLOOR_BUFFER_TOKENS = 13_000

export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

// Minimum cooldown override allowed via OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS.
// Values below this floor are rejected (function falls back to the default) so
// misconfiguration cannot effectively disable the circuit breaker.
export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000

// Pause autocompact after this many consecutive failures.
// BQ 2026-03-10: 1,279 sessions had 50+ consecutive failures (up to 3,272)
// in a single session, wasting ~250K API calls/day globally.
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export function getAutoCompactFailureCooldownMs(): number {
  const override = process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS
  if (override) {
    const trimmed = override.trim()
    const parsed = Number(trimmed)
    if (
      /^[1-9]\d*$/.test(trimmed) &&
      Number.isSafeInteger(parsed) &&
      parsed >= MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS
    ) {
      return parsed
    }
  }
  return AUTOCOMPACT_FAILURE_COOLDOWN_MS
}

export function resolveAutoCompactCircuitBreakerState(args: {
  tracking?: Pick<
    AutoCompactTrackingState,
    'consecutiveFailures' | 'nextRetryAtMs' | 'lastFailureAtMs'
  >
  nowMs: number
  cooldownMs: number
}):
  | {
      action: 'allow'
      effectiveConsecutiveFailures: number
      wasHalfOpen: boolean
    }
  | {
      action: 'skip'
      consecutiveFailures: number
      nextRetryAtMs: number
      circuitBreakerActive: true
    } {
  const { tracking, nowMs, cooldownMs } = args
  const consecutiveFailures = Math.max(0, tracking?.consecutiveFailures ?? 0)
  if (consecutiveFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      action: 'allow',
      effectiveConsecutiveFailures: consecutiveFailures,
      wasHalfOpen: false,
    }
  }

  let nextRetryAtMs = tracking?.nextRetryAtMs
  if (
    (typeof nextRetryAtMs !== 'number' ||
      !Number.isFinite(nextRetryAtMs)) &&
    typeof tracking?.lastFailureAtMs === 'number' &&
    Number.isFinite(tracking.lastFailureAtMs) &&
    Number.isFinite(cooldownMs)
  ) {
    nextRetryAtMs = tracking.lastFailureAtMs + cooldownMs
  }
  if (
    typeof nextRetryAtMs === 'number' &&
    Number.isFinite(nextRetryAtMs) &&
    nowMs < nextRetryAtMs
  ) {
    return {
      action: 'skip',
      consecutiveFailures,
      nextRetryAtMs,
      circuitBreakerActive: true,
    }
  }

  return {
    action: 'allow',
    effectiveConsecutiveFailures:
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
    wasHalfOpen: true,
  }
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)

  // Increase the buffer gradually between the old 13k and new 30k values.
  // This keeps the threshold monotonic and preserves the 20k warning/error
  // headroom consumed by calculateTokenWarningState(). A direct switch would
  // make a one-token window increase cause an earlier compact, and can make
  // the warning threshold negative for mid-sized context windows.
  const buffer = Math.min(
    AUTOCOMPACT_BUFFER_TOKENS,
    Math.max(
      AUTOCOMPACT_FLOOR_BUFFER_TOKENS,
      effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS,
    ),
  )
  const autocompactThreshold = effectiveContextWindow - buffer

  // Override for easier testing of autocompact
  const envPercent = process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export function calculateTokenWarningState(
  tokenUsage: number,
  model: string,
): {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
} {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const threshold = isAutoCompactEnabled()
    ? autoCompactThreshold
    : getEffectiveContextWindowSize(model)

  // Use the raw context window (without output reservation) for the percentage
  // display, so users see remaining context relative to the model's full capacity.
  // The threshold (which subtracts buffer) should only affect when we warn/compact,
  // not what percentage we display.
  const rawContextWindow = getContextWindowForModel(model, getSdkBetas())
  const percentLeft = Math.max(
    0,
    Math.round(((rawContextWindow - tokenUsage) / rawContextWindow) * 100),
  )

  const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = threshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveWarningThreshold = tokenUsage >= warningThreshold
  const isAboveErrorThreshold = tokenUsage >= errorThreshold

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold

  const actualContextWindow = getEffectiveContextWindowSize(model)
  const defaultBlockingLimit =
    actualContextWindow - MANUAL_COMPACT_BUFFER_TOKENS

  // Allow override for testing
  const blockingLimitOverride = process.env.CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE
  const parsedOverride = blockingLimitOverride
    ? parseInt(blockingLimitOverride, 10)
    : NaN
  const blockingLimit =
    !isNaN(parsedOverride) && parsedOverride > 0
      ? parsedOverride
      : defaultBlockingLimit

  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  // Allow disabling just auto-compact (keeps manual /compact working)
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  // Check if user has disabled auto-compact in their settings
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}

export async function shouldAutoCompact(
  messages: Message[],
  model: string,
  querySource?: QuerySource,
  // Snip removes messages but the surviving assistant's usage still reflects
  // pre-snip context, so tokenCountWithEstimation can't see the savings.
  // Subtract the rough-delta that snip already computed.
  snipTokensFreed = 0,
  // When set, skip the token threshold but still run recursion and
  // context-collapse guards. Only message-count and provider-overflow also
  // bypass a user-disabled auto-compact setting.
  forceReason?: AutoCompactTrackingState['forceReason'],
): Promise<boolean> {
  // Recursion guards. session_memory and compact are forked agents that
  // would deadlock.
  if (querySource === 'session_memory' || querySource === 'compact') {
    return false
  }
  // marble_origami is the ctx-agent — if ITS context blows up and
  // autocompact fires, runPostCompactCleanup calls resetContextCollapse()
  // which destroys the MAIN thread's committed log (module-level state
  // shared across forks). Inside feature() so the string DCEs from
  // external builds (it's in excluded-strings.txt).
  if (feature('CONTEXT_COLLAPSE')) {
    if (querySource === 'marble_origami') {
      return false
    }
  }

  // Process memory pressure is not evidence that this conversation exhausted
  // its context. Keep cache pruning available, but honor the user's disabled
  // auto-compact choice rather than unexpectedly summarizing a short
  // conversation (#1985). Explicit message-count and provider-overflow
  // recovery remain forced compaction paths.
  if (
    !isAutoCompactEnabled() &&
    (!forceReason || forceReason === 'memory-pressure')
  ) {
    return false
  }

  // Reactive-only mode: suppress proactive autocompact, let reactive compact
  // catch the API's prompt-too-long. feature() wrapper keeps the flag string
  // out of external builds (REACTIVE_COMPACT is internal-only).
  // Note: returning false here also means autoCompactIfNeeded never reaches
  // trySessionMemoryCompaction in the query loop — the /compact call site
  // still tries session memory first. Revisit if reactive-only graduates.
  if (feature('REACTIVE_COMPACT')) {
    if (
      !forceReason &&
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false)
    ) {
      return false
    }
  }

  // Context-collapse mode: same suppression. Collapse IS the context
  // management system when it's on — the 90% commit / 95% blocking-spawn
  // flow owns the headroom problem. Autocompact firing at effective-13k
  // (~93% of effective) sits right between collapse's commit-start (90%)
  // and blocking (95%), so it would race collapse and usually win, nuking
  // granular context that collapse was about to save. Gating here rather
  // than in isAutoCompactEnabled() keeps reactiveCompact alive as the 413
  // fallback (it consults isAutoCompactEnabled directly) and leaves
  // sessionMemory + manual /compact working.
  //
  // hasActiveReduction() folds in the enablement check (so the
  // CLAUDE_CONTEXT_COLLAPSE env override is honored here too) but also
  // requires collapse to actually hold a committed/staged reduction.
  // require() inside the block breaks the init-time cycle (this file exports
  // getEffectiveContextWindowSize which collapse's index imports).
  if (feature('CONTEXT_COLLAPSE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { hasActiveReduction, isMainThreadSource } =
      require('../contextCollapse/index.js') as typeof import('../contextCollapse/index.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Suppress only when collapse actually holds the headroom (a committed or
    // staged reduction) AND this is the main thread that owns it. The store is
    // shared across in-process subagents (agent:*); a subagent must still
    // autocompact its own oversized transcript instead of being suppressed by a
    // reduction that only applies to the main transcript.
    if (isMainThreadSource(querySource) && hasActiveReduction()) {
      return false
    }
  }

  if (forceReason) {
    logForDebugging(
      `autocompact: skipping token threshold check (forced by ${forceReason})`,
    )
    return true
  }

  const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)

  logForDebugging(
    `autocompact: tokens=${tokenCount} threshold=${threshold} effectiveWindow=${effectiveWindow}${snipTokensFreed > 0 ? ` snipFreed=${snipTokensFreed}` : ''}`,
  )

  const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
    tokenCount,
    model,
  )

  return isAboveAutoCompactThreshold
}

export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
  nextRetryAtMs?: number
  lastFailureAtMs?: number
  circuitBreakerActive?: boolean
  circuitBreakerTripped?: boolean
}> {
  const model = toolUseContext.options.mainLoopModel
  // Force compaction if a pressure/count signal set forceReason.
  // Intentionally consume the caller-owned flag in place so the same tracking
  // object cannot force multiple compaction cycles in one query loop pass.
  // Message-count and provider-overflow bypass user-disable gates; memory
  // pressure does not. All forced paths preserve recursion/collapse guards.
  const forcedBy = tracking?.forceReason
  if (tracking?.forceReason) {
    tracking.forceReason = undefined
  }
  if (!forcedBy && isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
    forcedBy,
  )

  if (!shouldCompact) {
    if ((tracking?.consecutiveFailures ?? 0) > 0 || tracking?.nextRetryAtMs) {
      return {
        wasCompacted: false,
        consecutiveFailures: 0,
        circuitBreakerActive: false,
        circuitBreakerTripped: false,
      }
    }
    return { wasCompacted: false }
  }

  const now = Date.now()
  const cooldownMs = getAutoCompactFailureCooldownMs()
  const breakerState = resolveAutoCompactCircuitBreakerState({
    tracking,
    nowMs: now,
    cooldownMs,
  })

  if (breakerState.action === 'skip') {
    return {
      wasCompacted: false,
      consecutiveFailures: breakerState.consecutiveFailures,
      nextRetryAtMs: breakerState.nextRetryAtMs,
      circuitBreakerActive: true,
      circuitBreakerTripped: false,
    }
  }

  const effectiveTracking: AutoCompactTrackingState | undefined =
    tracking && breakerState.wasHalfOpen
      ? {
          ...tracking,
          consecutiveFailures: breakerState.effectiveConsecutiveFailures,
          nextRetryAtMs: undefined,
        }
      : tracking

  const contextWindow = getContextWindowForModel(model, getSdkBetas())

  const partitioned = partitionContext(messages, {
    contextWindow,
    recentCount: 5,
  })
  const availableSpace = partitioned.canFitInWindow
    ? contextWindow - partitioned.totalTokens
    : Math.floor(contextWindow * 0.1)

  if (!partitioned.canFitInWindow && availableSpace > 1000) {
    // Preserve system messages
    const systemMessages = messages.filter(m => m.message?.role === 'system')
    const nonSystemMessages = messages.filter(m => m.message?.role !== 'system')
    
    // Config may be hand-edited; normalizeCompactTailTurns is the single
    // rule (shared with the /config UI) — a stray `0.5` must not floor to a
    // zero-message tail, and invalid values fall back to the default.
    const pruned = pruneByRelevance(nonSystemMessages, {
      targetTokens: availableSpace,
      preserveRecent: normalizeCompactTailTurns(getGlobalConfig().compactTailTurns),
      preserveTools: true,
      preserveErrors: true,
    })
    
    // Combine preserved system + pruned
    const finalMessages = [...systemMessages, ...pruned]
    
    if (finalMessages.length > 0 && finalMessages.length < messages.length) {
      logForDebugging(
        `partition+prune: ${messages.length} -> ${finalMessages.length} messages`,
      )
      messages = finalMessages
    }
  }

  const recompactionInfo: RecompactionInfo = {
    isRecompactionInChain: effectiveTracking?.compacted === true,
    turnsSincePreviousCompact: effectiveTracking?.turnCounter ?? -1,
    previousCompactTurnId: effectiveTracking?.turnId,
    autoCompactThreshold: getAutoCompactThreshold(model),
    querySource,
  }

  // EXPERIMENT: Try session memory compaction first
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    // Reset lastSummarizedMessageId since session memory compaction prunes messages
    // and the old message UUID will no longer exist after the REPL replaces messages
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    // Reset cache read baseline so the post-compact drop isn't flagged as a
    // break. compactConversation does this internally; SM-compact doesn't.
    // BQ 2026-03-01: missing this made 20% of tengu_prompt_cache_break events
    // false positives (systemPromptChanged=true, timeSinceLastAssistantMsg=-1).
    if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
      notifyCompaction(querySource ?? 'compact', toolUseContext.agentId)
    }
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
      consecutiveFailures: 0,
    }
  }

  try {
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true, // Suppress user questions for autocompact
      undefined, // No custom instructions for autocompact
      true, // isAutoCompact
      recompactionInfo,
    )

    // Reset lastSummarizedMessageId since legacy compaction replaces all messages
    // and the old message UUID will no longer exist in the new messages array
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      // Reset failure count on success
      consecutiveFailures: 0,
    }
  } catch (error) {
    const wasUserAbort = hasExactErrorMessage(error, ERROR_MESSAGE_USER_ABORT)
    if (wasUserAbort) {
      return {
        wasCompacted: false,
        consecutiveFailures: breakerState.effectiveConsecutiveFailures,
        nextRetryAtMs: breakerState.wasHalfOpen
          ? undefined
          : tracking?.nextRetryAtMs,
        circuitBreakerActive: false,
        circuitBreakerTripped: false,
      }
    }

    logError(error)
    // Increment consecutive failure count for circuit breaker.
    // The caller threads this through autoCompactTracking so the
    // next query loop iteration can skip futile retry attempts until cooldown.
    const nextFailures = Math.min(
      breakerState.effectiveConsecutiveFailures + 1,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    )
    const circuitBreakerTripped =
      nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    const failureAtMs = Date.now()
    const nextRetryAtMs = circuitBreakerTripped
      ? failureAtMs + cooldownMs
      : undefined
    if (circuitBreakerTripped) {
      logForDebugging(
        `autocompact: circuit breaker tripped after ${nextFailures} consecutive failures — retrying after cooldown`,
        { level: 'warn' },
      )
    }
    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      nextRetryAtMs,
      lastFailureAtMs: failureAtMs,
      circuitBreakerActive: circuitBreakerTripped,
      circuitBreakerTripped,
    }
  }
}
