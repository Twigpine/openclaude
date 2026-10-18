import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, posix, win32 } from 'node:path'
import {
  monitorEventLoopDelay,
  type IntervalHistogram,
} from 'node:perf_hooks'
import { normalizeAbortReason } from './abortReasons.js'
import { appendDiagnosticsNoPII } from './diagLogs.js'
import { redactHomePath, redactLikelySecrets } from './redaction.js'

const TRACE_CAPACITY = 512
export const __INTERRUPTION_TRACE_CAPACITY_FOR_TESTS = TRACE_CAPACITY
const TRACE_SCHEMA_VERSION = 1
const TRACE_ENABLED_ENV = 'OPENCLAUDE_INTERRUPT_TRACE'
const TRACE_FILE_ENV = 'OPENCLAUDE_INTERRUPT_TRACE_FILE'

export type InterruptionTraceFields = {
  source?: string
  subsystem?: string
  phase?: string
  queryId?: string
  queryGeneration?: number
  querySource?: string
  parentQueryId?: string
  subagentId?: string
  providerRoute?: string
  transport?: string
  model?: string
  attemptId?: string
  controllerRole?: string
  parentControllerIds?: readonly string[]
  winningParentControllerId?: string
  causalEventId?: string
  trigger?: string
  outcome?: string
  reason?: unknown
  existingReason?: unknown
  attemptedReason?: unknown
  error?: unknown
  elapsedQueryMs?: number
  sinceLastActivityMs?: number
  sinceLastRawByteMs?: number
  sinceLastParsedFrameMs?: number
  sinceLastYieldMs?: number
  rawByteCount?: number
  parsedFrameCount?: number
  controlFrameCount?: number
  ignoredFrameCount?: number
  ignoredParsedFrameCount?: number
  yieldedEventCount?: number
  activeApiCallCount?: number
  activeToolUseCount?: number
  leaseCount?: number
  suspendCount?: number
  repeatedCount?: number
  eventLoopDelayMaxMs?: number
  eventLoopDelayMeanMs?: number
}

type SafeTraceFields = Omit<
  InterruptionTraceFields,
  | 'reason'
  | 'existingReason'
  | 'attemptedReason'
  | 'error'
  | 'parentControllerIds'
> & {
  normalizedReason?: string
  rawReasonType?: string
  existingNormalizedReason?: string
  existingRawReasonType?: string
  attemptedNormalizedReason?: string
  attemptedRawReasonType?: string
  safeErrorIdentity?: string
  parentControllerIds?: string[]
}

export type InterruptionTraceEntry = SafeTraceFields & {
  schemaVersion: number
  sequence: number
  eventId: string
  traceSessionId: string
  timestamp: string
  monotonicMs: number
  clockDeltaMs: number
  event: string
  controllerId?: string
  firstAbortEventId?: string
  abortStackFingerprint?: string
}

type ControllerTraceState = {
  id: string
  firstAbortEventId?: string
  repeatedCount: number
  fields: InterruptionTraceFields
  provisionalRole: boolean
}

type SignalTraceState = {
  id: string
  fields: InterruptionTraceFields
  getAbortFields?: () => InterruptionTraceFields
}

let traceSessionId = ''
let sequence = 0
let startedWallMs = Date.now()
let startedMonotonicMs = performance.now()
let ring: InterruptionTraceEntry[] = []
let flushedThroughSequence = 0
let controllerCounter = 0
let signalCounter = 0
let controllerStates = new WeakMap<AbortController, ControllerTraceState>()
let signalIds = new WeakMap<AbortSignal, string>()
let signalAbortEventIds = new WeakMap<AbortSignal, string>()
let signalAbortSources = new WeakMap<AbortSignal, string>()
let signalStates = new WeakMap<AbortSignal, SignalTraceState>()
let errorCausalEventIds = new WeakMap<object, string>()
let eventLoopDelay: IntervalHistogram | undefined
let flushQueue: Promise<void> = Promise.resolve()
let retryBatch:
  | {
      entries: readonly InterruptionTraceEntry[]
      marker: InterruptionTraceEntry
      logFile: string
    }
  | undefined

function isEnabled(): boolean {
  const value = process.env[TRACE_ENABLED_ENV]?.toLowerCase()
  return value === '1' || value === 'true'
}

export function isInterruptionTraceEnabled(): boolean {
  return isEnabled()
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const clipped = value.slice(0, 160)
  const redacted = redactLikelySecrets(redactHomePath(clipped))
  if (
    redacted !== clipped ||
    posix.isAbsolute(clipped) ||
    win32.isAbsolute(clipped) ||
    /(?:^|[^a-z0-9_])(?:[a-z]:[\\/]|[/\\]{1,2})/i.test(clipped)
  ) {
    return '[redacted]'
  }
  return clipped
}

function safeEventName(value: string): string {
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(value) ? value : 'unknown'
}

function safeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const BUILTIN_ERROR_NAMES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
])

const STANDARD_DOM_EXCEPTION_NAMES = new Set([
  'AbortError',
  'DataCloneError',
  'DataError',
  'EncodingError',
  'HierarchyRequestError',
  'InUseAttributeError',
  'IndexSizeError',
  'InvalidAccessError',
  'InvalidCharacterError',
  'InvalidModificationError',
  'InvalidNodeTypeError',
  'InvalidStateError',
  'NamespaceError',
  'NetworkError',
  'NoDataAllowedError',
  'NoModificationAllowedError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'NotSupportedError',
  'OperationError',
  'QuotaExceededError',
  'ReadOnlyError',
  'SecurityError',
  'TimeoutError',
  'TransactionInactiveError',
  'UnknownError',
  'URLMismatchError',
  'VersionError',
  'WrongDocumentError',
])

function getSafeErrorName(error: Error): string {
  if (error instanceof DOMException) {
    return STANDARD_DOM_EXCEPTION_NAMES.has(error.name)
      ? `DOMException:${error.name}`
      : 'DOMException'
  }
  return BUILTIN_ERROR_NAMES.has(error.name) ? error.name : 'Error'
}

function getRawReasonType(reason: unknown): string {
  if (reason === null) return 'null'
  if (reason instanceof DOMException) return getSafeErrorName(reason)
  if (reason instanceof Error) return `Error:${getSafeErrorName(reason)}`
  if (Array.isArray(reason)) return 'array'
  return typeof reason
}

function getSafeErrorIdentity(error: unknown): string | undefined {
  if (error instanceof Error) return getSafeErrorName(error)
  return error === undefined ? undefined : typeof error
}

function toSafeFields(fields: InterruptionTraceFields): SafeTraceFields {
  const reason = fields.reason
  const safe: SafeTraceFields = {}
  const stringFields = [
    'source',
    'subsystem',
    'phase',
    'queryId',
    'querySource',
    'parentQueryId',
    'subagentId',
    'providerRoute',
    'transport',
    'model',
    'attemptId',
    'controllerRole',
    'winningParentControllerId',
    'causalEventId',
    'trigger',
    'outcome',
  ] as const
  for (const key of stringFields) {
    const value = safeString(fields[key])
    if (value !== undefined) safe[key] = value
  }
  const numberFields = [
    'queryGeneration',
    'elapsedQueryMs',
    'sinceLastActivityMs',
    'sinceLastRawByteMs',
    'sinceLastParsedFrameMs',
    'sinceLastYieldMs',
    'rawByteCount',
    'parsedFrameCount',
    'controlFrameCount',
    'ignoredFrameCount',
    'ignoredParsedFrameCount',
    'yieldedEventCount',
    'activeApiCallCount',
    'activeToolUseCount',
    'leaseCount',
    'suspendCount',
    'repeatedCount',
    'eventLoopDelayMaxMs',
    'eventLoopDelayMeanMs',
  ] as const
  for (const key of numberFields) {
    const value = safeFiniteNumber(fields[key])
    if (value !== undefined) safe[key] = value
  }
  if (fields.parentControllerIds) {
    safe.parentControllerIds = fields.parentControllerIds
      .map(safeString)
      .filter((value): value is string => value !== undefined)
      .slice(0, 4)
  }
  if (reason !== undefined) {
    safe.normalizedReason = safeString(normalizeAbortReason(reason))
    safe.rawReasonType = getRawReasonType(reason)
  }
  if (fields.existingReason !== undefined) {
    safe.existingNormalizedReason = safeString(
      normalizeAbortReason(fields.existingReason),
    )
    safe.existingRawReasonType = getRawReasonType(fields.existingReason)
  }
  if (fields.attemptedReason !== undefined) {
    safe.attemptedNormalizedReason = safeString(
      normalizeAbortReason(fields.attemptedReason),
    )
    safe.attemptedRawReasonType = getRawReasonType(fields.attemptedReason)
  }
  const safeErrorIdentity = getSafeErrorIdentity(fields.error)
  if (safeErrorIdentity !== undefined) safe.safeErrorIdentity = safeErrorIdentity
  return safe
}

function getAbortStackEvidence(): { abortStackFingerprint?: string } {
  const rawStack = new Error().stack
  if (!rawStack) return {}
  const sites = rawStack
    .split('\n')
    .slice(2, 7)
    .map(line => {
      const functionMatch = line.match(/^\s*at\s+([^\s(]+)/)
      const candidate = safeString(functionMatch?.[1])
      return candidate && !/[\\/:]/.test(candidate)
        ? candidate
        : '<anonymous>'
    })
  const fingerprint = createHash('sha256').update(sites.join('>')).digest('hex').slice(0, 16)
  return { abortStackFingerprint: fingerprint }
}

function buildEntry(
  event: string,
  fields: InterruptionTraceFields,
  nextSequence: number,
  extra: Partial<InterruptionTraceEntry> = {},
  allowDisabled = false,
): InterruptionTraceEntry | undefined {
  if (!allowDisabled && !isEnabled()) return undefined
  if (!traceSessionId) traceSessionId = randomUUID()
  if (!eventLoopDelay) {
    eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
    eventLoopDelay.enable()
  }
  const monotonicMs = performance.now() - startedMonotonicMs
  const wallElapsedMs = Date.now() - startedWallMs
  const entry: InterruptionTraceEntry = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    sequence: nextSequence,
    eventId: `${traceSessionId}:${nextSequence}`,
    traceSessionId,
    timestamp: new Date().toISOString(),
    monotonicMs,
    clockDeltaMs: wallElapsedMs - monotonicMs,
    event: safeEventName(event),
    ...toSafeFields({
      ...fields,
      eventLoopDelayMaxMs: Number.isFinite(eventLoopDelay.max)
        ? eventLoopDelay.max / 1_000_000
        : 0,
      eventLoopDelayMeanMs: Number.isFinite(eventLoopDelay.mean)
        ? eventLoopDelay.mean / 1_000_000
        : 0,
    }),
    ...extra,
  }
  return entry
}

function addEntry(
  event: string,
  fields: InterruptionTraceFields,
  extra: Partial<InterruptionTraceEntry> = {},
): InterruptionTraceEntry | undefined {
  if (!isEnabled()) return undefined
  try {
    const entry = buildEntry(event, fields, sequence + 1, extra)
    if (!entry) return undefined
    sequence = entry.sequence
    ring.push(entry)
    if (ring.length > TRACE_CAPACITY) ring = ring.slice(-TRACE_CAPACITY)
    return entry
  } catch {
    // Diagnostics must be total for arbitrary abort reasons and metadata.
    return undefined
  }
}

export function traceInterruptionEvent(
  event: string,
  fields: InterruptionTraceFields = {},
): string | undefined {
  return addEntry(event, fields)?.eventId
}

export function setInterruptionErrorCausalEventId(
  error: unknown,
  eventId: string | undefined,
): void {
  if (
    eventId &&
    ((typeof error === 'object' && error !== null) ||
      typeof error === 'function')
  ) {
    errorCausalEventIds.set(error, eventId)
  }
}

export function getInterruptionErrorCausalEventId(
  error: unknown,
): string | undefined {
  return (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
    ? errorCausalEventIds.get(error)
    : undefined
}

export function tracePermissionAbortResolution(
  source: string | undefined,
  causalEventId: string | undefined,
  subsystem: string,
): string | undefined {
  return traceInterruptionEvent('permission.abort_resolved', {
    source: source ?? 'unknown',
    subsystem,
    causalEventId,
    outcome: 'denied',
  })
}

export function registerInterruptionController(
  controller: AbortController,
  fields: InterruptionTraceFields = {},
  options: {
    provisionalRole?: boolean
    refreshQueryContext?: boolean
  } = {},
): string | undefined {
  if (!isEnabled()) return undefined
  const existing = controllerStates.get(controller)
  if (existing) {
    // Registration metadata describes controller identity. Later callers may
    // add missing context, but must not relabel an established query root as a
    // parent/tool/controller role merely because they are observing it there.
    existing.fields = { ...fields, ...existing.fields }
    if (
      existing.provisionalRole &&
      fields.controllerRole !== undefined &&
      !options.provisionalRole
    ) {
      existing.fields.controllerRole = fields.controllerRole
      existing.provisionalRole = false
    }
    if (options.refreshQueryContext) {
      existing.fields = {
        ...existing.fields,
        ...(fields.queryId !== undefined && { queryId: fields.queryId }),
        ...(fields.queryGeneration !== undefined && {
          queryGeneration: fields.queryGeneration,
        }),
        ...(fields.querySource !== undefined && {
          querySource: fields.querySource,
        }),
        ...(fields.parentQueryId !== undefined && {
          parentQueryId: fields.parentQueryId,
        }),
      }
    }
    return existing.id
  }

  const id = `controller-${++controllerCounter}`
  controllerStates.set(controller, {
    id,
    repeatedCount: 0,
    fields,
    provisionalRole: options.provisionalRole === true,
  })
  signalIds.set(controller.signal, id)
  addEntry('controller.registered', fields, { controllerId: id })
  const observeAbort = () => {
    const state = controllerStates.get(controller)
    const observed = addEntry(
      'signal.observed',
      { ...state?.fields, reason: controller.signal.reason },
      {
        controllerId: id,
        ...(state?.firstAbortEventId && {
          firstAbortEventId: state.firstAbortEventId,
        }),
      },
    )
    if (observed && !signalAbortEventIds.has(controller.signal)) {
      signalAbortEventIds.set(controller.signal, observed.eventId)
    }
    if (
      observed &&
      state?.fields.source &&
      !signalAbortSources.has(controller.signal)
    ) {
      signalAbortSources.set(controller.signal, state.fields.source)
    }
    if (observed && state && !state.firstAbortEventId) {
      state.firstAbortEventId = observed.eventId
    }
    if (state?.fields.controllerRole === 'query-root') {
      flushInterruptionTrace('root_abort_observed')
    }
  }
  if (controller.signal.aborted) observeAbort()
  else controller.signal.addEventListener('abort', observeAbort, { once: true })
  return id
}

function preserveControllerIdentity(
  fields: InterruptionTraceFields,
  state: ControllerTraceState | undefined,
): InterruptionTraceFields {
  const identity = state?.fields
  if (!identity) return fields
  return {
    ...fields,
    ...(identity.queryId !== undefined && { queryId: identity.queryId }),
    ...(identity.queryGeneration !== undefined && {
      queryGeneration: identity.queryGeneration,
    }),
    ...(identity.querySource !== undefined && {
      querySource: identity.querySource,
    }),
    ...(identity.parentQueryId !== undefined && {
      parentQueryId: identity.parentQueryId,
    }),
    ...(identity.subagentId !== undefined && {
      subagentId: identity.subagentId,
    }),
    ...(identity.controllerRole !== undefined && {
      controllerRole: identity.controllerRole,
    }),
    ...(identity.parentControllerIds !== undefined && {
      parentControllerIds: identity.parentControllerIds,
    }),
  }
}

export function getInterruptionSignalId(signal: AbortSignal): string | undefined {
  return isEnabled() ? signalIds.get(signal) : undefined
}

export function getInterruptionSignalAbortEventId(
  signal: AbortSignal,
): string | undefined {
  return isEnabled() ? signalAbortEventIds.get(signal) : undefined
}

export function getInterruptionSignalAbortTrace(
  signal: AbortSignal,
): { source?: string; causalEventId?: string } {
  if (!isEnabled()) return {}
  return {
    source: signalAbortSources.get(signal),
    causalEventId: signalAbortEventIds.get(signal),
  }
}

export function registerInterruptionSignal(
  signal: AbortSignal,
  fields: InterruptionTraceFields = {},
  getAbortFields?: () => InterruptionTraceFields,
): string | undefined {
  if (!isEnabled()) return undefined
  const existing = signalIds.get(signal)
  if (existing) return existing
  const id = `signal-${++signalCounter}`
  signalIds.set(signal, id)
  signalStates.set(signal, { id, fields, getAbortFields })
  addEntry('signal.registered', fields, { controllerId: id })
  const observeAbort = () => observeRegisteredSignal(signal)
  if (signal.aborted) observeAbort()
  else signal.addEventListener('abort', observeAbort, { once: true })
  return id
}

function observeRegisteredSignal(signal: AbortSignal): string | undefined {
  const existingEventId = signalAbortEventIds.get(signal)
  if (existingEventId) return existingEventId
  const state = signalStates.get(signal)
  if (!state) return undefined
  const observed = addEntry(
    'signal.observed',
    { ...state.fields, ...state.getAbortFields?.(), reason: signal.reason },
    { controllerId: state.id },
  )
  if (observed) signalAbortEventIds.set(signal, observed.eventId)
  return observed?.eventId
}

export function traceCombinedAbortSignal(
  combinedSignal: AbortSignal,
  parents: readonly AbortSignal[],
  fields: InterruptionTraceFields = {},
): string | undefined {
  if (!isEnabled()) return undefined
  const parentControllerIds = parents
    .map(parent =>
      registerInterruptionSignal(parent, {
        subsystem: fields.subsystem,
        controllerRole: 'combined-parent',
      }),
    )
    .filter((value): value is string => value !== undefined)
  return registerInterruptionSignal(
    combinedSignal,
    {
      ...fields,
      parentControllerIds,
    },
    () => {
      const winner = parents.find(parent => parent.aborted)
      if (!winner) return {}
      // AbortSignal.any can abort the combined signal before ordinary listeners
      // on the winning parent run. Record the parent synchronously here so the
      // combined observation carries the causal edge on the native path.
      observeRegisteredSignal(winner)
      return {
        winningParentControllerId: getInterruptionSignalId(winner),
        causalEventId: getInterruptionSignalAbortEventId(winner),
      }
    },
  )
}

export function requestAbort(
  controller: AbortController,
  reason: unknown,
  fields: InterruptionTraceFields,
): void {
  if (!isEnabled()) {
    controller.abort(reason)
    return
  }

  let shouldFlushRoot = fields.controllerRole === 'query-root'
  try {
    const controllerId =
      registerInterruptionController(controller, fields) ?? 'controller-unknown'
    const state = controllerStates.get(controller)
    const requestFields = preserveControllerIdentity(fields, state)
    shouldFlushRoot ||= state?.fields.controllerRole === 'query-root'
    if (controller.signal.aborted) {
      if (state) state.repeatedCount++
      addEntry(
        'abort.repeated',
        {
          ...requestFields,
          existingReason: controller.signal.reason,
          attemptedReason: reason,
          outcome: 'ignored_first_abort_wins',
          repeatedCount: state?.repeatedCount ?? 1,
        },
        {
          controllerId,
          ...(state?.firstAbortEventId && {
            firstAbortEventId: state.firstAbortEventId,
          }),
        },
      )
    } else {
      const entry = addEntry(
        'abort.requested',
        { ...requestFields, reason },
        { controllerId, ...getAbortStackEvidence() },
      )
      if (entry && state) {
        state.firstAbortEventId = entry.eventId
        signalAbortEventIds.set(controller.signal, entry.eventId)
        if (fields.source) {
          signalAbortSources.set(controller.signal, fields.source)
        }
      }
    }
  } catch {
    // Best-effort diagnostics must never interfere with the native abort.
  } finally {
    controller.abort(reason)
  }
  if (shouldFlushRoot) flushInterruptionTrace('root_abort_observed')
}

export function traceCombinedSignal(
  combinedController: AbortController,
  parents: readonly (AbortSignal | undefined)[],
  fields: InterruptionTraceFields = {},
): string | undefined {
  if (!isEnabled()) return undefined
  const parentControllerIds = parents
    .map(parent =>
      parent
        ? registerInterruptionSignal(parent, {
            subsystem: fields.subsystem,
            controllerRole: 'combined-parent',
          })
        : undefined,
    )
    .filter((value): value is string => value !== undefined)
  return registerInterruptionController(combinedController, {
    ...fields,
    parentControllerIds,
  })
}

async function performInterruptionTraceFlush(
  trigger: string,
  logFile: string,
): Promise<void> {
  try {
    while (true) {
      let batch = retryBatch
      if (!batch) {
        const pending = ring.filter(
          entry => entry.sequence > flushedThroughSequence,
        )
        if (pending.length === 0) return
        const marker = buildEntry(
          'trace.flush',
          { trigger, repeatedCount: pending.length },
          sequence + 1,
          {},
          true,
        )
        if (!marker) return
        // Reserve the marker before awaiting. Later events get larger IDs, and
        // this immutable batch remains reachable even if the ring wraps.
        sequence = marker.sequence
        batch = { entries: [...pending, marker], marker, logFile }
      }

      const result = await appendDiagnosticsNoPII(batch.logFile, batch.entries)
      if (result === 'retryable_failure') {
        retryBatch = batch
        return
      }

      retryBatch = undefined
      flushedThroughSequence = batch.marker.sequence
      if (result === 'committed') {
        ring = [...ring, batch.marker]
          .sort((left, right) => left.sequence - right.sequence)
          .slice(-TRACE_CAPACITY)
      }
      // Keep draining: events can be recorded while an append is in flight,
      // including during graceful shutdown after the caller requested a flush.
    }
  } catch {
    // A trace flush is never allowed to affect request cleanup.
  }
}

export function flushInterruptionTrace(trigger: string): void {
  if (!isEnabled()) return
  const logFile = process.env[TRACE_FILE_ENV]
  if (!logFile || !isAbsolute(logFile)) return
  flushQueue = flushQueue
    .then(() => performInterruptionTraceFlush(trigger, logFile))
    .catch(() => {
      // Diagnostics are deliberately detached from request cancellation.
    })
}

export async function waitForInterruptionTraceFlush(): Promise<void> {
  await flushQueue
}

export async function __waitForInterruptionTraceFlushForTests(): Promise<void> {
  await waitForInterruptionTraceFlush()
}

export function __getInterruptionTraceSnapshotForTests(): readonly InterruptionTraceEntry[] {
  return [...ring]
}

export function __resetInterruptionTraceForTests(): void {
  traceSessionId = ''
  sequence = 0
  startedWallMs = Date.now()
  startedMonotonicMs = performance.now()
  ring = []
  flushedThroughSequence = 0
  controllerCounter = 0
  signalCounter = 0
  controllerStates = new WeakMap()
  signalIds = new WeakMap()
  signalAbortEventIds = new WeakMap()
  signalAbortSources = new WeakMap()
  signalStates = new WeakMap()
  errorCausalEventIds = new WeakMap()
  retryBatch = undefined
  flushQueue = Promise.resolve()
  eventLoopDelay?.disable()
  eventLoopDelay = undefined
}
