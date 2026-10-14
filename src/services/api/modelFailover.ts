/**
 * Auto model failover decision logic.
 *
 * When the current model cannot serve a turn — API errors after retries are
 * exhausted, a hung stream (watchdog abort), or an unacceptably slow first
 * token — this decides whether and where to retry the turn on an alternative
 * model. It is pure decision logic: candidate ranking lives in
 * `src/utils/model/failoverCandidates.ts` and the retry mechanics in
 * `src/query.ts`, which replays the same turn-reset sequence used by the
 * existing `FallbackTriggeredError` path.
 *
 * Opt-in via the `autoModelFailover` setting; off by default so behavior is
 * unchanged for everyone else.
 */

import { CannotRetryError } from './withRetry.js'

export type FailoverTriggerReason =
  | 'retries-exhausted'
  | 'stream-idle-timeout'
  | 'slow-ttft'

export type FailoverTrigger = {
  reason: FailoverTriggerReason
  originalModel: string
  ttftMs?: number
}

export type FailoverDecision = {
  shouldFailover: boolean
  reason?: FailoverTriggerReason
  nextModel?: string
  /** Short user-facing explanation of why the switch happened (or didn't). */
  message?: string
}

export type FailoverDecisionContext = {
  currentModel: string
  alreadyTried: string[]
  failoverCount: number
  autoModelFailover?: boolean
  failoverTtftThresholdMs?: number
  failoverMaxPerTurn?: number
  /** Ranked, filtered candidate models to try, best first. */
  candidates: string[]
  signal?: AbortSignal
}

/**
 * Enriched-error markers attached by `queryModelWithStreaming()`. They survive
 * `withRetry` because it rethrows the original error when retries are spent.
 */
const FAILOVER_SLOW_TTFT_KEY = 'failoverSlowTtftMs'
const STREAM_IDLE_ABORTED_KEY = 'streamIdleAborted'

function errorMarker(error: unknown, key: string): unknown {
  if (!(error instanceof Error)) {
    return undefined
  }
  return (error as unknown as Record<string, unknown>)[key]
}

/**
 * Our own user aborts are never failover triggers: the user asked to stop, not
 * to switch models.
 */
export function isUserAbort(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const name = error.name
  const code = (error as NodeJS.ErrnoException).code
  return name === 'AbortError' || code === 'ABORT_ERR' || error.message === 'Request was aborted.'
}

/**
 * Map a thrown turn error onto a failover trigger, or null when the error is
 * not a failover candidate at all (user aborts, plain timeouts surfaced as
 * aborts, and any error already flagged as a fallback the existing mechanism
 * will handle).
 */
export function classifyFailoverTrigger(error: unknown): FailoverTriggerReason | null {
  if (isUserAbort(error)) {
    return null
  }
  if (errorMarker(error, STREAM_IDLE_ABORTED_KEY) === true) {
    return 'stream-idle-timeout'
  }
  const ttft = errorMarker(error, FAILOVER_SLOW_TTFT_KEY)
  if (typeof ttft === 'number' && Number.isFinite(ttft)) {
    return 'slow-ttft'
  }
  // API errors after withRetry exhausted its attempts arrive wrapped in
  // CannotRetryError. Everything else (tool errors, parsing bugs) is not a
  // model-health problem.
  if (error instanceof CannotRetryError) {
    return 'retries-exhausted'
  }
  return null
}

export const DEFAULT_FAILOVER_TTFT_THRESHOLD_MS = 30_000
export const DEFAULT_FAILOVER_MAX_PER_TURN = 1

/**
 * Single decision point for the whole feature. Returns `shouldFailover: false`
 * with a message whenever any guard declines; the caller only needs to check
 * the flag.
 */
export function resolveFailoverDecision(
  error: unknown,
  ctx: FailoverDecisionContext,
): FailoverDecision {
  if (ctx.autoModelFailover !== true) {
    return { shouldFailover: false, message: 'autoModelFailover is disabled' }
  }
  const reason = classifyFailoverTrigger(error)
  if (reason === null) {
    return { shouldFailover: false, message: 'error is not a failover trigger' }
  }
  const maxPerTurn = ctx.failoverMaxPerTurn ?? DEFAULT_FAILOVER_MAX_PER_TURN
  if (ctx.failoverCount >= maxPerTurn) {
    return {
      shouldFailover: false,
      message: `failover limit reached (${ctx.failoverCount}/${maxPerTurn})`,
    }
  }
  if (ctx.signal?.aborted) {
    return { shouldFailover: false, message: 'request was aborted' }
  }
  const nextModel = ctx.candidates.find(
    candidate =>
      candidate !== ctx.currentModel && !ctx.alreadyTried.includes(candidate),
  )
  if (nextModel === undefined) {
    return {
      shouldFailover: false,
      message: 'no alternative model available',
    }
  }
  const ttftMs = errorMarker(error, FAILOVER_SLOW_TTFT_KEY)
  return {
    shouldFailover: true,
    reason,
    nextModel,
    message:
      reason === 'slow-ttft' && typeof ttftMs === 'number'
        ? `model was slow to respond (${Math.round(ttftMs / 1000)}s to first token)`
        : reason === 'stream-idle-timeout'
          ? 'model stopped responding'
          : 'model kept failing',
  }
}
