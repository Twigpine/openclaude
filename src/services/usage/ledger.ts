import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomBytes } from 'crypto'
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises'

import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { lock } from '../../utils/lockfile.js'
import { shouldSkipSessionPersistence } from '../../utils/sessionPersistencePolicy.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { extractCacheMetrics } from '../api/cacheMetrics.js'
import {
  getUsageDir,
  getUsageEventsDir,
  getUsageEventsFile,
  toLocalDateKey,
} from './paths.js'
import {
  resolveUsageRouteContext,
  type UsageProviderOverride,
} from './route.js'
import { USAGE_EVENT_VERSION, type UsageEvent } from './types.js'

export type RecordUsageInput = {
  usage: Usage
  model: string
  querySource?: string
  agentId?: string
  providerOverride?: UsageProviderOverride
  /**
   * Identifies one request whose usage may be reported more than once with
   * running totals (a stream can emit several `message_delta` events). Reports
   * sharing a key update one event; the last report wins.
   */
  requestKey?: string
}

// Bounds so a long-lived process or a persistently failing disk cannot grow
// memory without limit. Oldest entries are dropped first.
const MAX_PENDING_EVENTS = 10_000
const MAX_RECORDED_EVENTS = 100_000
const MAX_FLUSH_ATTEMPTS = 3
// How long a keyed request waits for further reports before it is written.
const REQUEST_SETTLE_MS = 3_000

type OpenRequest = {
  event: UsageEvent
  persist: boolean
  timer: ReturnType<typeof setTimeout>
}

const openRequests = new Map<string, OpenRequest>()
let pendingEvents: UsageEvent[] = []
let recordedEvents: UsageEvent[] = []
let flushPromise: Promise<void> | null = null
let cleanupRegistered = false

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0
}

function pushBounded(target: UsageEvent[], event: UsageEvent, max: number): void {
  target.push(event)
  if (target.length > max) {
    target.splice(0, target.length - max)
  }
}

export function buildUsageEvent(
  input: RecordUsageInput,
  now: number = Date.now(),
): UsageEvent {
  const { usage, model } = input
  const context = resolveUsageRouteContext(model, input.providerOverride)
  const event: UsageEvent = {
    v: USAGE_EVENT_VERSION,
    id: randomBytes(6).toString('hex'),
    ts: now,
    session: getSessionId(),
    project: getOriginalCwd(),
    model,
    route: context.route,
    source: input.querySource || 'unknown',
    input: toCount(usage.input_tokens),
    output: toCount(usage.output_tokens),
    cacheRead: toCount(usage.cache_read_input_tokens),
    cacheWrite: toCount(usage.cache_creation_input_tokens),
    webSearch: toCount(usage.server_tool_use?.web_search_requests),
  }
  if (context.local) event.local = true
  if (input.agentId) event.agentId = input.agentId
  if (
    !extractCacheMetrics(
      usage as unknown as Record<string, unknown>,
      context.cacheProvider,
    ).supported
  ) {
    event.noCache = true
  }
  if (usage.speed === 'fast') event.fast = true
  if (
    event.input + event.output + event.cacheRead + event.cacheWrite ===
    0
  ) {
    event.unreported = true
  }
  return event
}

/**
 * Record one billed model request in the local usage ledger.
 *
 * Never throws and never blocks the request: the disk write happens in the
 * background. Events are kept in memory for the current process even when
 * session persistence is disabled, but are only written to disk when it is
 * allowed.
 */
export function recordUsageEvent(input: RecordUsageInput): void {
  try {
    const key = input.requestKey
    const open = key ? openRequests.get(key) : undefined
    if (open) {
      // A later report for the same request carries its running totals.
      replaceUsageEvent(open.event, buildUsageEvent(input))
      clearTimeout(open.timer)
      open.timer = settleTimer(key!)
      return
    }

    const event = buildUsageEvent(input)
    pushBounded(recordedEvents, event, MAX_RECORDED_EVENTS)
    const persist = !shouldSkipSessionPersistence()
    if (persist) registerFlushOnExit()
    if (!key) {
      if (persist) enqueueForDisk(event)
      return
    }
    openRequests.set(key, { event, persist, timer: settleTimer(key) })
  } catch (error) {
    logForDebugging(`Failed to record usage event: ${String(error)}`)
  }
}

function replaceUsageEvent(target: UsageEvent, next: UsageEvent): void {
  const { id } = target
  for (const field of Object.keys(target) as Array<keyof UsageEvent>) {
    delete target[field]
  }
  Object.assign(target, next, { id })
}

function settleTimer(key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => settleRequest(key), REQUEST_SETTLE_MS)
  // Never keep the process alive just to write usage; exit flushes instead.
  ;(timer as { unref?: () => void }).unref?.()
  return timer
}

function settleRequest(key: string): void {
  const open = openRequests.get(key)
  if (!open) return
  openRequests.delete(key)
  clearTimeout(open.timer)
  if (open.persist) enqueueForDisk(open.event)
}

function settleAllRequests(): void {
  for (const key of [...openRequests.keys()]) settleRequest(key)
}

function enqueueForDisk(event: UsageEvent): void {
  pushBounded(pendingEvents, event, MAX_PENDING_EVENTS)
  scheduleUsageFlush()
}

function registerFlushOnExit(): void {
  if (cleanupRegistered) return
  cleanupRegistered = true
  registerCleanup(async () => {
    await flushUsageEvents()
  })
}

function scheduleUsageFlush(): void {
  if (flushPromise) return
  flushPromise = (async () => {
    let failures = 0
    try {
      while (pendingEvents.length > 0 && failures < MAX_FLUSH_ATTEMPTS) {
        if (await flushPendingOnce()) {
          failures = 0
        } else {
          failures++
          await sleep(500)
        }
      }
    } finally {
      flushPromise = null
    }
  })()
}

async function appendEventsToDay(
  dateKey: string,
  events: UsageEvent[],
  usageDir: string,
): Promise<void> {
  const file = getUsageEventsFile(dateKey, usageDir)
  // proper-lockfile needs the target to exist before it can lock it.
  await writeFile(file, '', { encoding: 'utf8', mode: 0o600, flag: 'a' })
  const release = await lock(file, {
    stale: 10_000,
    retries: { retries: 5, minTimeout: 25 },
  })
  try {
    await appendFile(
      file,
      events.map(event => jsonStringify(event) + '\n').join(''),
      { encoding: 'utf8', mode: 0o600 },
    )
  } finally {
    await release()
  }
}

async function flushPendingOnce(): Promise<boolean> {
  if (pendingEvents.length === 0) return true
  const batch = pendingEvents
  pendingEvents = []
  const usageDir = getUsageDir()

  const byDay = new Map<string, UsageEvent[]>()
  for (const event of batch) {
    const key = toLocalDateKey(event.ts)
    const dayEvents = byDay.get(key)
    if (dayEvents) dayEvents.push(event)
    else byDay.set(key, [event])
  }

  const failed: UsageEvent[] = []
  try {
    await mkdir(getUsageEventsDir(usageDir), { recursive: true, mode: 0o700 })
  } catch (error) {
    logForDebugging(`Failed to create usage directory: ${String(error)}`)
    pendingEvents = batch.concat(pendingEvents)
    return false
  }
  for (const [dateKey, events] of byDay) {
    try {
      await appendEventsToDay(dateKey, events, usageDir)
    } catch (error) {
      logForDebugging(`Failed to write usage events: ${String(error)}`)
      failed.push(...events)
    }
  }
  if (failed.length > 0) {
    pendingEvents = failed.concat(pendingEvents)
    if (pendingEvents.length > MAX_PENDING_EVENTS) {
      pendingEvents.splice(0, pendingEvents.length - MAX_PENDING_EVENTS)
    }
    return false
  }
  return true
}

/** Wait for queued usage events to reach disk. Safe to call any time. */
export async function flushUsageEvents(): Promise<void> {
  settleAllRequests()
  if (flushPromise) {
    await flushPromise
  }
  if (pendingEvents.length > 0) {
    await flushPendingOnce()
  }
}

/** Events this process recorded, oldest first (includes unflushed events). */
export function getRecordedUsageEvents(): readonly UsageEvent[] {
  return recordedEvents
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Parse one ledger line, returning null for torn or foreign lines. */
export function parseUsageEventLine(line: string): UsageEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const event = value as Partial<UsageEvent>
  if (
    event.v !== USAGE_EVENT_VERSION ||
    typeof event.id !== 'string' ||
    !isNonNegativeNumber(event.ts) ||
    typeof event.session !== 'string' ||
    typeof event.project !== 'string' ||
    typeof event.model !== 'string' ||
    typeof event.route !== 'string' ||
    typeof event.source !== 'string' ||
    !isNonNegativeNumber(event.input) ||
    !isNonNegativeNumber(event.output) ||
    !isNonNegativeNumber(event.cacheRead) ||
    !isNonNegativeNumber(event.cacheWrite) ||
    !isNonNegativeNumber(event.webSearch)
  ) {
    return null
  }
  return event as UsageEvent
}

export type UsageDayEvents = {
  events: UsageEvent[]
  /** File size in bytes, or 0 when the day has no event file. */
  bytes: number
  invalidLines: number
}

export async function readUsageEventsForDay(
  dateKey: string,
  usageDir: string = getUsageDir(),
): Promise<UsageDayEvents> {
  let raw: Buffer
  try {
    raw = await readFile(getUsageEventsFile(dateKey, usageDir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { events: [], bytes: 0, invalidLines: 0 }
    }
    throw error
  }
  // Size of exactly what was parsed: a separate stat() could include a line
  // appended after the read, and a rollup would then never notice it.
  const bytes = raw.byteLength

  const events: UsageEvent[] = []
  let invalidLines = 0
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    const event = parseUsageEventLine(line)
    if (event) events.push(event)
    else invalidLines++
  }
  return { events, bytes, invalidLines }
}

export function resetUsageLedgerForTesting(): void {
  for (const open of openRequests.values()) clearTimeout(open.timer)
  openRequests.clear()
  pendingEvents = []
  recordedEvents = []
  flushPromise = null
}
