/**
 * Synchronous state machine for the query lifecycle, compatible with
 * React's `useSyncExternalStore`.
 *
 * Three states:
 *   idle        -> no query, safe to dequeue and process
 *   dispatching -> an item was dequeued, async chain hasn't reached onQuery yet
 *   running     -> onQuery called tryStart(), query is executing
 *
 * Transitions:
 *   idle -> dispatching  (reserve)
 *   dispatching -> running  (tryStart)
 *   idle -> running  (tryStart, for direct user submissions)
 *   running -> idle  (end / forceEnd / timeout)
 *   dispatching -> idle  (cancelReservation, when processQueueIfReady fails)
 *
 * `isActive` returns true for both dispatching and running, preventing
 * re-entry from the queue processor during the async gap.
 *
 * Timeout:
 *   The guard uses an idle timeout for stuck work, bounded leases for active
 *   local/API work, and a hard maximum query lifetime that always wins.
 *
 * Usage with React:
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.js'
import {
  flushInterruptionTrace,
  traceInterruptionEvent,
} from './interruptionTrace.js'
import type {
  QueryActiveOperationSnapshot,
  QueryGuardMetadata,
  QueryGuardStart,
  QueryGuardTimeoutInfo,
  QueryGuardTimeoutReason,
  QueryLifecycleContext,
  QueryTerminalReason,
} from './queryLifecycle.js'

export type { QueryGuardTimeoutReason } from './queryLifecycle.js'

export const DEFAULT_QUERY_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
export const DEFAULT_QUERY_HARD_MAX_MS = 30 * 60 * 1000 // 30 minutes
export const DEFAULT_TOOL_LEASE_GRACE_MS = 5_000

/**
 * Input for a bounded unit of active work.
 *
 * `owner` identifies the subsystem taking the lease, `id` identifies the
 * specific operation, `timeoutMs` is measured from lease acquisition, and
 * `hardCapMs` is an optional lease-local upper bound that is still capped by
 * the current query's remaining hard-maximum budget.
 */
export type QueryGuardLeaseInput = {
  /** Subsystem taking the lease, used for diagnostics and unique lease ids. */
  owner: 'api' | 'tool' | 'bash' | 'subagent' | string
  /** Stable operation id, for example a tool-use id. */
  id: string
  /** Lease timeout measured from acquisition time. */
  timeoutMs?: number
  /** Optional lease-local hard cap, also bounded by the query hard max. */
  hardCapMs?: number
  /** Human-readable description for diagnostics. */
  description?: string
}

/**
 * Handle returned for an active lease. Call `release()` exactly once when the
 * bounded work finishes; stale or repeated releases are ignored.
 */
export type QueryGuardLease = {
  readonly id: string
  /** Release this lease if it still belongs to the current generation. */
  release(): void
}

type QueryTimeoutHandler = (timeout: QueryGuardTimeoutInfo) => void

type QueryGuardOptions = {
  idleTimeoutMs?: number
  hardMaxQueryMs?: number
  toolLeaseGraceMs?: number
}

type LeaseRecord = {
  leaseId: string
  owner: string
  id: string
  generation: number
  startedAt: number
  deadlineAt: number
  description?: string
}

const EMPTY_ACTIVE_OPERATIONS: QueryActiveOperationSnapshot = {
  apiCalls: [],
  toolUses: [],
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function terminalReasonForTimeout(
  reason: QueryGuardTimeoutReason,
): QueryTerminalReason {
  return reason === 'hard_max'
    ? 'hard-max-query-timeout'
    : 'query-timeout'
}

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()
  private _timeoutId: ReturnType<typeof setTimeout> | null = null
  private _timeoutHandler: QueryTimeoutHandler | null = null
  // Deadline arithmetic is monotonic so NTP/manual wall-clock jumps cannot
  // manufacture an immediate timeout or postpone an already-scheduled one.
  private _queryStartedAt = 0
  private _lastActivityAt = 0
  private _suspendCount = 0
  private _suspendedAt = 0
  private _totalSuspendedMs = 0
  private _leaseCounter = 0
  private _traceActivityCount = 0
  private _lastTraceActivityAt = 0
  private _activeLeases = new Map<string, LeaseRecord>()
  private _context: QueryLifecycleContext | null = null
  private _lastContext: QueryLifecycleContext | null = null
  private _getActiveOperations: (() => QueryActiveOperationSnapshot) | null =
    null
  private _idleTimeoutMs: number
  private readonly _hardMaxQueryMs: number
  private readonly _toolLeaseGraceMs: number

  constructor(options: QueryGuardOptions = {}) {
    this._idleTimeoutMs = positiveOrDefault(
      options.idleTimeoutMs,
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    this._hardMaxQueryMs = positiveOrDefault(
      options.hardMaxQueryMs,
      DEFAULT_QUERY_HARD_MAX_MS,
    )
    this._toolLeaseGraceMs = Math.max(
      0,
      positiveOrDefault(options.toolLeaseGraceMs, DEFAULT_TOOL_LEASE_GRACE_MS),
    )
  }

  /**
   * Update the idle deadline for the next query. Active queries retain the
   * timeout they started with so a concurrent submission cannot mutate them.
   */
  setIdleTimeoutMs(idleTimeoutMs: number | undefined): boolean {
    if (this._status === 'running') return false
    this._idleTimeoutMs = positiveOrDefault(
      idleTimeoutMs,
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    return true
  }

  /**
   * Reserve the guard for queue processing. Transitions idle -> dispatching.
   * Returns false if not idle (another query or dispatch in progress).
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * Cancel a reservation when processQueueIfReady had nothing to process.
   * Transitions dispatching -> idle.
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * Start a query. Returns the generation number on success,
   * or null if a query is already running (concurrent guard).
   * Accepts transitions from both idle (direct user submit)
   * and dispatching (queue processor path).
   */
  tryStart(): number | null
  tryStart(metadata: QueryGuardMetadata): QueryGuardStart | null
  tryStart(metadata?: QueryGuardMetadata): number | QueryGuardStart | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    this._lastContext = null
    this._queryStartedAt = performance.now()
    this._traceActivityCount = 0
    this._lastTraceActivityAt = 0
    this._lastActivityAt = this._queryStartedAt
    this._context = this._createContext(metadata)
    traceInterruptionEvent('query_guard.started', {
      subsystem: 'query_guard',
      phase: 'running',
      queryId: this._context.queryId,
      queryGeneration: this._generation,
      querySource: this._context.querySource,
    })
    this._getActiveOperations = metadata?.getActiveOperations ?? null
    this._startTimeout()
    this._notify()
    if (metadata) {
      return {
        generation: this._generation,
        context: this._context,
      }
    }
    return this._generation
  }

  /**
   * End a query. Returns true if this generation is still current
   * (meaning the caller should perform cleanup). Returns false if a
   * newer query has started (stale finally block from a cancelled query).
   */
  end(
    generation: number,
    terminalReason: QueryTerminalReason = 'ok',
    abortReason?: string,
  ): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._clearTimeout()
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    const context = this._context
    this._completeContext(terminalReason, abortReason)
    traceInterruptionEvent('query_guard.ended', {
      subsystem: 'query_guard',
      phase: terminalReason,
      queryId: context?.queryId,
      queryGeneration: generation,
      querySource: context?.querySource,
      reason: abortReason,
    })
    this._status = 'idle'
    this._getActiveOperations = null
    this._notify()
    return true
  }

  /**
   * Force-end the current query regardless of generation.
   * Used by onCancel where any running query should be terminated.
   * Increments generation so stale finally blocks from the cancelled
   * query's promise rejection will see a mismatch and skip cleanup.
   */
  forceEnd(
    terminalReason: QueryTerminalReason = 'unknown',
    abortReason?: string,
  ): void {
    if (this._status === 'idle') return
    this._clearTimeout()
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    const context = this._context
    this._completeContext(terminalReason, abortReason)
    traceInterruptionEvent('query_guard.force_ended', {
      subsystem: 'query_guard',
      phase: terminalReason,
      queryId: context?.queryId,
      queryGeneration: this._generation,
      querySource: context?.querySource,
      reason: abortReason,
    })
    this._status = 'idle'
    this._getActiveOperations = null
    ++this._generation
    this._notify()
  }

  /**
   * Record forward progress for the current query. Stale generation-scoped
   * events are ignored so a cancelled query cannot extend a newer turn. Call
   * this when API chunks, tool progress, or other observable work arrives.
   */
  registerActivity(reason: string, generation?: number): void {
    void reason
    if (this._status !== 'running') return
    if (generation !== undefined && generation !== this._generation) return
    const now = performance.now()
    this._lastActivityAt = now
    this._traceActivityCount++
    if (
      this._traceActivityCount === 1 ||
      now - this._lastTraceActivityAt >= 5_000
    ) {
      this._lastTraceActivityAt = now
      traceInterruptionEvent('query_guard.activity', {
        subsystem: 'query_guard',
        queryId: this._context?.queryId,
        queryGeneration: this._generation,
        querySource: this._context?.querySource,
        yieldedEventCount: this._traceActivityCount,
      })
    }
    this._scheduleTimeout()
  }

  /**
   * Allow bounded active work to outlive the idle timeout without converting
   * QueryGuard into an inactivity-only watchdog. Pass the generation when the
   * lease is acquired from async callbacks so stale work cannot protect a newer
   * query. Without an explicit generation, the current generation is used.
   */
  acquireLease(
    input: QueryGuardLeaseInput,
    generation = this._generation,
  ): QueryGuardLease {
    if (this._status !== 'running' || generation !== this._generation) {
      return {
        id: '',
        release() {},
      }
    }

    const now = performance.now()
    const leaseTimeoutMs =
      typeof input.timeoutMs === 'number' &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? input.timeoutMs
        : undefined
    const leaseHardCapMs =
      typeof input.hardCapMs === 'number' &&
      Number.isFinite(input.hardCapMs) &&
      input.hardCapMs > 0
        ? input.hardCapMs
        : this._hardMaxQueryMs
    const queryHardDeadlineAt = this._getHardMaxDeadlineAt(now)
    const queryRemainingMs = Math.max(0, queryHardDeadlineAt - now)
    const effectiveHardCapMs = Math.min(leaseHardCapMs, queryRemainingMs)
    const leaseDeadlineAt =
      leaseTimeoutMs === undefined
        ? now + effectiveHardCapMs
        : Math.min(
            now + leaseTimeoutMs + this._toolLeaseGraceMs,
            now + effectiveHardCapMs,
          )
    const leaseId = `${generation}:${input.owner}:${input.id}:${++this._leaseCounter}`
    this._activeLeases.set(leaseId, {
      leaseId,
      owner: input.owner,
      id: input.id,
      generation,
      startedAt: now,
      deadlineAt: leaseDeadlineAt,
      description: input.description,
    })
    traceInterruptionEvent('query_guard.lease_acquired', {
      subsystem: 'query_guard',
      queryId: this._context?.queryId,
      queryGeneration: this._generation,
      source: input.owner,
      leaseCount: this._activeLeases.size,
    })
    this._lastActivityAt = now
    this._scheduleTimeout()

    return {
      id: leaseId,
      release: () => this.releaseLease(leaseId, generation),
    }
  }

  /**
   * Release a lease by id. Stale generation releases and repeated releases are
   * ignored, so old async cleanup cannot affect a newer query.
   */
  releaseLease(leaseId: string, generation = this._generation): void {
    const lease = this._activeLeases.get(leaseId)
    if (!lease || lease.generation !== generation) return
    this._activeLeases.delete(leaseId)
    traceInterruptionEvent('query_guard.lease_released', {
      subsystem: 'query_guard',
      queryId: this._context?.queryId,
      queryGeneration: this._generation,
      source: lease.owner,
      leaseCount: this._activeLeases.size,
    })
    this._scheduleTimeout()
  }

  /**
   * Suspend idle and hard-max timeouts while the query is blocked on a human
   * decision. Lease deadlines still run because they bound active program work.
   * Reference-counted so concurrent or nested interactions are safe.
   *
   * Pass the generation when suspending from an async callback so a stale
   * interaction cannot pause a newer query. Returns a resume function; call it
   * exactly once (a good fit for a `finally` block). Repeated or stale-
   * generation resume calls are ignored.
   */
  beginUserInteraction(generation = this._generation): () => void {
    if (this._status !== 'running' || generation !== this._generation) {
      return () => {}
    }
    if (this._suspendCount === 0) {
      this._suspendedAt = performance.now()
    }
    this._suspendCount++
    traceInterruptionEvent('query_guard.suspended', {
      subsystem: 'query_guard',
      queryId: this._context?.queryId,
      queryGeneration: this._generation,
      suspendCount: this._suspendCount,
    })
    this._scheduleTimeout()

    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      // A superseded query already reset the counter; ignore stale resumes.
      if (generation !== this._generation) return
      if (this._suspendCount === 0) return
      this._suspendCount--
      traceInterruptionEvent('query_guard.resumed', {
        subsystem: 'query_guard',
        queryId: this._context?.queryId,
        queryGeneration: this._generation,
        suspendCount: this._suspendCount,
      })
      if (this._suspendCount === 0) {
        this._resumeAfterInteraction()
      }
    }
  }

  /**
   * Restart idle/hard-max accounting after the last concurrent human interaction
   * ends. Lease deadlines are not shifted; they bound active program work even
   * while the prompt is open.
   */
  private _resumeAfterInteraction(): void {
    if (this._status !== 'running') return
    const now = performance.now()
    const suspendedStartedAt = this._suspendedAt
    const suspendedMs = Math.max(0, now - suspendedStartedAt)
    this._suspendedAt = 0
    this._totalSuspendedMs += suspendedMs
    this._lastActivityAt = now
    this._scheduleTimeout()
  }

  /**
   * Is the guard active (dispatching or running)?
   * Always synchronous - not subject to React state batching delays.
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  get activeContext(): QueryLifecycleContext | null {
    return this._context ? { ...this._context } : null
  }

  get lastContext(): QueryLifecycleContext | null {
    return this._lastContext ? { ...this._lastContext } : null
  }

  /**
   * Register a single owner callback for watchdog timeouts. The callback runs
   * before forceEnd(), so callers can abort in-flight work while the timed-out
   * generation is still current.
   */
  setTimeoutHandler(handler: QueryTimeoutHandler | null): () => void {
    this._timeoutHandler = handler
    return () => {
      if (this._timeoutHandler === handler) {
        this._timeoutHandler = null
      }
    }
  }

  // --
  // useSyncExternalStore interface

  /** Subscribe to state changes. Stable reference - safe as useEffect dep. */
  subscribe = this._changed.subscribe

  /** Snapshot for useSyncExternalStore. Returns `isActive`. */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  private _notify(): void {
    this._changed.emit()
  }

  private _createContext(
    metadata: QueryGuardMetadata | undefined,
  ): QueryLifecycleContext {
    return {
      queryId: metadata?.queryId ?? `generation-${this._generation}`,
      queryGeneration: this._generation,
      querySource: metadata?.querySource ?? 'unknown',
      ...(metadata?.parentQueryId && { parentQueryId: metadata.parentQueryId }),
      ...(metadata?.subagentId && { subagentId: metadata.subagentId }),
      startedAt: metadata?.startedAt ?? Date.now(),
    }
  }

  private _completeContext(
    terminalReason: QueryTerminalReason,
    abortReason?: string,
  ): void {
    if (!this._context) return
    const completed = {
      ...this._context,
      terminalReason,
      ...(abortReason !== undefined && { abortReason }),
    }
    this._context = null
    this._lastContext = completed
  }

  private _activeContextWithTerminalReason(
    terminalReason: QueryTerminalReason,
    abortReason?: string,
  ): QueryLifecycleContext {
    const context = this._context ?? this._createContext(undefined)
    return {
      ...context,
      terminalReason,
      ...(abortReason !== undefined && { abortReason }),
    }
  }

  private _snapshotActiveOperations(): QueryActiveOperationSnapshot {
    if (!this._getActiveOperations) return EMPTY_ACTIVE_OPERATIONS
    try {
      return this._getActiveOperations()
    } catch (error) {
      console.error('[QueryGuard] Active operation snapshot failed', error)
      return EMPTY_ACTIVE_OPERATIONS
    }
  }

  /**
   * Start a watchdog timer. Stuck work aborts after the idle timeout, active
   * bounded work can continue while its lease is valid, and the hard maximum
   * aborts the query regardless of activity.
   */
  private _startTimeout(): void {
    this._scheduleTimeout()
  }

  private _scheduleTimeout(): void {
    this._clearTimeout()
    if (this._status !== 'running') return

    const now = performance.now()
    const reason = this._getTimeoutReason(now)
    if (reason) {
      this._timeoutId = setTimeout(() => this._handleTimeout(), 0)
      return
    }

    const nextDeadlineAt = this._getNextDeadlineAt(now)
    if (nextDeadlineAt === null) return
    this._timeoutId = setTimeout(
      () => this._handleTimeout(),
      Math.max(0, nextDeadlineAt - now),
    )
  }

  private _handleTimeout(): void {
    this._timeoutId = null
    if (this._status !== 'running') return

    const now = performance.now()
    const reason = this._getTimeoutReason(now)
    if (!reason) {
      this._scheduleTimeout()
      return
    }

    const terminalReason = terminalReasonForTimeout(reason)
    const context = this._activeContextWithTerminalReason(
      terminalReason,
      reason,
    )
    const timeout: QueryGuardTimeoutInfo = {
      generation: this._generation,
      reason,
      timeoutMs: this._getTimeoutMsForReason(reason, now),
      elapsedMs: now - this._queryStartedAt,
      context,
      activeOperations: this._snapshotActiveOperations(),
    }
    const causalEventId = traceInterruptionEvent('query_guard.fired', {
      subsystem: 'query_guard',
      phase: terminalReason,
      queryId: context.queryId,
      queryGeneration: context.queryGeneration,
      querySource: context.querySource,
      trigger: reason,
      elapsedQueryMs: timeout.elapsedMs,
      sinceLastActivityMs: now - this._lastActivityAt,
      activeApiCallCount: timeout.activeOperations.apiCalls.length,
      activeToolUseCount: timeout.activeOperations.toolUses.length,
      leaseCount: this._activeLeases.size,
      suspendCount: this._suspendCount,
    })
    if (causalEventId) timeout.causalEventId = causalEventId

    console.error(
      `[QueryGuard] Query ${reason} timeout - force-ending to prevent infinite spinner`,
    )
    try {
      this._timeoutHandler?.(timeout)
    } catch (error) {
      console.error('[QueryGuard] Timeout handler failed', error)
    } finally {
      this.forceEnd(terminalReason, reason)
      flushInterruptionTrace('query_guard_timeout')
    }
  }

  private _getCurrentSuspendedMs(now: number): number {
    return this._suspendCount > 0
      ? Math.max(0, now - this._suspendedAt)
      : 0
  }

  private _getHardMaxDeadlineAt(now: number): number {
    return (
      this._queryStartedAt +
      this._hardMaxQueryMs +
      this._totalSuspendedMs +
      this._getCurrentSuspendedMs(now)
    )
  }

  private _getTimeoutReason(now: number): QueryGuardTimeoutReason | null {
    const isSuspended = this._suspendCount > 0
    if (!isSuspended && now >= this._getHardMaxDeadlineAt(now)) {
      return 'hard_max'
    }

    let hasValidLease = false
    for (const lease of this._activeLeases.values()) {
      if (lease.deadlineAt <= now) {
        return 'lease_expired'
      }
      hasValidLease = true
    }

    if (
      !isSuspended &&
      !hasValidLease &&
      now >= this._lastActivityAt + this._idleTimeoutMs
    ) {
      return 'idle'
    }

    return null
  }

  private _getTimeoutMsForReason(
    reason: QueryGuardTimeoutReason,
    now: number,
  ): number {
    if (reason === 'hard_max') return this._hardMaxQueryMs
    if (reason === 'idle') return this._idleTimeoutMs

    const expiredLease = [...this._activeLeases.values()].find(
      lease => lease.deadlineAt <= now,
    )
    if (!expiredLease) return this._idleTimeoutMs
    return Math.max(0, expiredLease.deadlineAt - expiredLease.startedAt)
  }

  private _getNextDeadlineAt(now: number): number | null {
    if (this._status !== 'running') return null

    const isSuspended = this._suspendCount > 0
    const deadlines = isSuspended ? [] : [this._getHardMaxDeadlineAt(now)]
    const leaseDeadlines = [...this._activeLeases.values()]
      .map(lease => lease.deadlineAt)
      .filter(deadline => deadline > now)

    if (leaseDeadlines.length > 0) {
      deadlines.push(Math.min(...leaseDeadlines))
    } else if (!isSuspended) {
      deadlines.push(this._lastActivityAt + this._idleTimeoutMs)
    }

    if (deadlines.length === 0) return null
    return Math.min(...deadlines)
  }

  private _clearTimeout(): void {
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }
  }
}
