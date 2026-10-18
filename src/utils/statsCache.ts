import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import { open } from 'fs/promises'
import { join } from 'path'
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage } from './errors.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { jsonParse, jsonStringify } from './slowOperations.js'
import type { DailyActivity, DailyModelTokens, SessionStats } from './stats.js'

export const STATS_CACHE_VERSION = 3
const MIN_MIGRATABLE_VERSION = 1
const STATS_CACHE_FILENAME = 'stats-cache.json'

/**
 * Simple in-memory lock to prevent concurrent cache operations.
 */
let statsCacheLockPromise: Promise<void> | null = null

/**
 * Execute a function while holding the stats cache lock.
 * Only one operation can hold the lock at a time.
 */
export async function withStatsCacheLock<T>(fn: () => Promise<T>): Promise<T> {
  // Wait for any existing lock to be released
  while (statsCacheLockPromise) {
    await statsCacheLockPromise
  }

  // Create our lock
  let releaseLock: (() => void) | undefined
  statsCacheLockPromise = new Promise<void>(resolve => {
    releaseLock = resolve
  })

  try {
    return await fn()
  } finally {
    // Release the lock
    statsCacheLockPromise = null
    releaseLock?.()
  }
}

/**
 * Persisted stats cache stored on disk.
 * Contains aggregated historical stats that won't change.
 * All fields are bounded to prevent unbounded file growth.
 */
export type PersistedStatsCache = {
  version: number
  // Last date that was fully computed (YYYY-MM-DD format)
  // Stats up to and including this date are considered complete
  lastComputedDate: string | null
  // Daily aggregates needed for heatmap, streaks, trends (bounded by days)
  dailyActivity: DailyActivity[]
  dailyModelTokens: DailyModelTokens[]
  // Model usage aggregated (bounded by number of models)
  modelUsage: { [modelName: string]: ModelUsage }
  // Session aggregates (replaces unbounded sessionStats array)
  totalSessions: number
  totalMessages: number
  longestSession: SessionStats | null
  // First session date ever recorded
  firstSessionDate: string | null
  // Hour counts for peak hour calculation (bounded to 24 entries)
  hourCounts: { [hour: number]: number }
  // Speculation time saved across all sessions
  totalSpeculationTimeSavedMs: number
  // Shot distribution: map of shot count → number of sessions (internal-only)
  shotDistribution?: { [shotCount: number]: number }
}

export function getStatsCachePath(): string {
  return join(getClaudeConfigHomeDir(), STATS_CACHE_FILENAME)
}

function getEmptyCache(): PersistedStatsCache {
  return {
    version: STATS_CACHE_VERSION,
    lastComputedDate: null,
    dailyActivity: [],
    dailyModelTokens: [],
    modelUsage: {},
    totalSessions: 0,
    totalMessages: 0,
    longestSession: null,
    firstSessionDate: null,
    hourCounts: {},
    totalSpeculationTimeSavedMs: 0,
    shotDistribution: {},
  }
}

/**
 * Migrate an older cache to the current schema.
 * Returns null if the version is unknown or too old to migrate.
 *
 * Preserves historical aggregates that would otherwise be lost when
 * transcript files have already aged out past cleanupPeriodDays.
 * Pre-migration days may undercount (e.g. v2 lacked subagent tokens);
 * we accept that rather than drop the history.
 */
function migrateStatsCache(
  parsed: Partial<PersistedStatsCache> & { version: number },
): PersistedStatsCache | null {
  if (
    typeof parsed.version !== 'number' ||
    parsed.version < MIN_MIGRATABLE_VERSION ||
    parsed.version > STATS_CACHE_VERSION
  ) {
    return null
  }
  if (
    !Array.isArray(parsed.dailyActivity) ||
    !Array.isArray(parsed.dailyModelTokens) ||
    typeof parsed.totalSessions !== 'number' ||
    typeof parsed.totalMessages !== 'number'
  ) {
    return null
  }
  return {
    version: STATS_CACHE_VERSION,
    lastComputedDate: parsed.lastComputedDate ?? null,
    dailyActivity: parsed.dailyActivity,
    dailyModelTokens: parsed.dailyModelTokens,
    modelUsage: parsed.modelUsage ?? {},
    totalSessions: parsed.totalSessions,
    totalMessages: parsed.totalMessages,
    longestSession: parsed.longestSession ?? null,
    firstSessionDate: parsed.firstSessionDate ?? null,
    hourCounts: parsed.hourCounts ?? {},
    totalSpeculationTimeSavedMs: parsed.totalSpeculationTimeSavedMs ?? 0,
    // Preserve undefined (don't default to {}) so the SHOT_STATS recompute
    // check in loadStatsCache fires for v1/v2 caches that lacked this field.
    shotDistribution: parsed.shotDistribution,
  }
}

/**
 * Load the stats cache from disk.
 * Returns an empty cache if the file doesn't exist or is invalid.
 */
export async function loadStatsCache(): Promise<PersistedStatsCache> {
  const fs = getFsImplementation()
  const cachePath = getStatsCachePath()

  try {
    const content = await fs.readFile(cachePath, { encoding: 'utf-8' })
    const parsed = jsonParse(content) as PersistedStatsCache

    // Validate version
    if (parsed.version !== STATS_CACHE_VERSION) {
      const migrated = migrateStatsCache(parsed)
      if (!migrated) {
        logForDebugging(
          `Stats cache version ${parsed.version} not migratable (expected ${STATS_CACHE_VERSION}), returning empty cache`,
        )
        return getEmptyCache()
      }
      logForDebugging(
        `Migrated stats cache from v${parsed.version} to v${STATS_CACHE_VERSION}`,
      )
      // Persist migration so we don't re-migrate on every load.
      // aggregateClaudeCodeStats() skips its save when lastComputedDate is
      // already current, so without this the on-disk file stays at the old
      // version indefinitely.
      await saveStatsCache(migrated)
      if (feature('SHOT_STATS') && !migrated.shotDistribution) {
        logForDebugging(
          'Migrated stats cache missing shotDistribution, forcing recomputation',
        )
        return getEmptyCache()
      }
      return migrated
    }

    // Basic validation
    if (
      !Array.isArray(parsed.dailyActivity) ||
      !Array.isArray(parsed.dailyModelTokens) ||
      typeof parsed.totalSessions !== 'number' ||
      typeof parsed.totalMessages !== 'number'
    ) {
      logForDebugging(
        'Stats cache has invalid structure, returning empty cache',
      )
      return getEmptyCache()
    }

    // If SHOT_STATS is enabled but cache doesn't have shotDistribution,
    // force full recomputation to get historical shot data
    if (feature('SHOT_STATS') && !parsed.shotDistribution) {
      logForDebugging(
        'Stats cache missing shotDistribution, forcing recomputation',
      )
      return getEmptyCache()
    }

    return parsed
  } catch (error) {
    logForDebugging(`Failed to load stats cache: ${errorMessage(error)}`)
    return getEmptyCache()
  }
}

/**
 * Save the stats cache to disk atomically.
 * Uses a temp file + rename pattern to prevent corruption.
 */
export async function saveStatsCache(
  cache: PersistedStatsCache,
): Promise<void> {
  const fs = getFsImplementation()
  const cachePath = getStatsCachePath()
  const tempPath = `${cachePath}.${randomBytes(8).toString('hex')}.tmp`

  try {
    // Ensure the directory exists
    const configDir = getClaudeConfigHomeDir()
    try {
      await fs.mkdir(configDir)
    } catch {
      // Directory already exists or other error - proceed
    }

    // Write to temp file with fsync for atomic write safety
    const content = jsonStringify(cache, null, 2)
    const handle = await open(tempPath, 'w', 0o600)
    try {
      await handle.writeFile(content, { encoding: 'utf-8' })
      await handle.sync()
    } finally {
      await handle.close()
    }

    // Atomic rename
    await fs.rename(tempPath, cachePath)
    logForDebugging(
      `Stats cache saved successfully (lastComputedDate: ${cache.lastComputedDate})`,
    )
  } catch (error) {
    logError(error)
    // Clean up temp file
    try {
      await fs.unlink(tempPath)
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Merge new stats into an existing cache.
 * Used when incrementally adding new days to the cache.
 */
export function mergeCacheWithNewStats(
  existingCache: PersistedStatsCache,
  newStats: {
    dailyActivity: DailyActivity[]
    dailyModelTokens: DailyModelTokens[]
    modelUsage: { [modelName: string]: ModelUsage }
    sessionStats: SessionStats[]
    hourCounts: { [hour: number]: number }
    totalSpeculationTimeSavedMs: number
    shotDistribution?: { [shotCount: number]: number }
  },
  newLastComputedDate: string,
): PersistedStatsCache {
  // Merge daily activity - combine by date
  const dailyActivityMap = new Map<string, DailyActivity>()
  for (const day of existingCache.dailyActivity) {
    dailyActivityMap.set(day.date, { ...day })
  }
  for (const day of newStats.dailyActivity) {
    const existing = dailyActivityMap.get(day.date)
    if (existing) {
      existing.messageCount += day.messageCount
      existing.sessionCount += day.sessionCount
      existing.toolCallCount += day.toolCallCount
    } else {
      dailyActivityMap.set(day.date, { ...day })
    }
  }

  // Merge daily model tokens - combine by date
  const dailyModelTokensMap = new Map<string, { [model: string]: number }>()
  for (const day of existingCache.dailyModelTokens) {
    dailyModelTokensMap.set(day.date, { ...day.tokensByModel })
  }
  for (const day of newStats.dailyModelTokens) {
    const existing = dailyModelTokensMap.get(day.date)
    if (existing) {
      for (const [model, tokens] of Object.entries(day.tokensByModel)) {
        existing[model] = (existing[model] || 0) + tokens
      }
    } else {
      dailyModelTokensMap.set(day.date, { ...day.tokensByModel })
    }
  }

  // Merge model usage
  const modelUsage = { ...existingCache.modelUsage }
  for (const [model, usage] of Object.entries(newStats.modelUsage)) {
    if (modelUsage[model]) {
      modelUsage[model] = {
        inputTokens: modelUsage[model]!.inputTokens + usage.inputTokens,
        outputTokens: modelUsage[model]!.outputTokens + usage.outputTokens,
        cacheReadInputTokens:
          modelUsage[model]!.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens:
          modelUsage[model]!.cacheCreationInputTokens +
          usage.cacheCreationInputTokens,
        webSearchRequests:
          modelUsage[model]!.webSearchRequests + usage.webSearchRequests,
        costUSD: modelUsage[model]!.costUSD + usage.costUSD,
        contextWindow: Math.max(
          modelUsage[model]!.contextWindow,
          usage.contextWindow,
        ),
        maxOutputTokens: Math.max(
          modelUsage[model]!.maxOutputTokens,
          usage.maxOutputTokens,
        ),
      }
    } else {
      modelUsage[model] = { ...usage }
    }
  }

  // Merge hour counts
  const hourCounts = { ...existingCache.hourCounts }
  for (const [hour, count] of Object.entries(newStats.hourCounts)) {
    const hourNum = parseInt(hour, 10)
    hourCounts[hourNum] = (hourCounts[hourNum] || 0) + count
  }

  // Update session aggregates
  const totalSessions =
    existingCache.totalSessions + newStats.sessionStats.length
  const totalMessages =
    existingCache.totalMessages +
    newStats.sessionStats.reduce((sum, s) => sum + s.messageCount, 0)

  // Find longest session (compare existing with new)
  let longestSession = existingCache.longestSession
  for (const session of newStats.sessionStats) {
    if (!longestSession || session.duration > longestSession.duration) {
      longestSession = session
    }
  }

  // Find first session date. Compared chronologically, not lexically: an
  // offset-qualified timestamp does not sort by the instant it denotes, and
  // this value is what a later cached run reads back. There is no session list
  // to correct it at that point, so a wrong first date here reports one total
  // day for activity that spans two UTC dates.
  // The seed comes from a previously persisted cache and may itself be corrupt.
  // A garbage seed that sorts lexically before every real timestamp (e.g. "1")
  // is never displaced by comparePersistedDates alone, so the corruption -- and
  // the wrong totalDays it produces -- persists across every later run. Treat an
  // unparseable seed as absent so the first valid session date replaces it.
  let firstSessionDate = existingCache.firstSessionDate
  for (const session of newStats.sessionStats) {
    if (
      !firstSessionDate ||
      Number.isNaN(parsePersistedDateMs(firstSessionDate)) ||
      comparePersistedDates(session.timestamp, firstSessionDate) < 0
    ) {
      firstSessionDate = session.timestamp
    }
  }

  const result: PersistedStatsCache = {
    version: STATS_CACHE_VERSION,
    lastComputedDate: newLastComputedDate,
    dailyActivity: Array.from(dailyActivityMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
    dailyModelTokens: Array.from(dailyModelTokensMap.entries())
      .map(([date, tokensByModel]) => ({ date, tokensByModel }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    modelUsage,
    totalSessions,
    totalMessages,
    longestSession,
    firstSessionDate,
    hourCounts,
    totalSpeculationTimeSavedMs:
      existingCache.totalSpeculationTimeSavedMs +
      newStats.totalSpeculationTimeSavedMs,
  }

  if (feature('SHOT_STATS')) {
    const shotDistribution: { [shotCount: number]: number } = {
      ...(existingCache.shotDistribution || {}),
    }
    for (const [count, sessions] of Object.entries(
      newStats.shotDistribution || {},
    )) {
      const key = parseInt(count, 10)
      shotDistribution[key] = (shotDistribution[key] || 0) + sessions
    }
    result.shotDistribution = shotDistribution
  }

  return result
}

/**
 * Extract the date portion (YYYY-MM-DD) from a Date object.
 */
export function toDateString(date: Date): string {
  const parts = date.toISOString().split('T')
  const dateStr = parts[0]
  if (!dateStr) {
    throw new Error('Invalid ISO date string')
  }
  return dateStr
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDateString(): string {
  return toDateString(new Date())
}

/**
 * Get yesterday's date in YYYY-MM-DD format.
 */
export function getYesterdayDateString(): string {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return toDateString(yesterday)
}

/**
 * Check if a date string is before another date string.
 * Both should be in YYYY-MM-DD format.
 */
export function isDateBefore(date1: string, date2: string): boolean {
  return date1 < date2
}

/**
 * The two shapes this pipeline actually persists: a bare `dailyActivity` date
 * key, or a complete timezone-qualified ISO instant (from `session.timestamp`).
 * Anything else is corruption. `Date.parse` alone is far too lenient to detect
 * it — "2026-07", "2026", "123" and "01/01/2026" all parse to real dates, so a
 * truncated or foreign-format value would silently yield a
 * plausible-but-wrong span instead of being rejected.
 *
 * The match is anchored at both ends and, once a time is present, a zone
 * designator is required. A space-delimited "2026-07-13 23:30:00" is neither
 * shape, and `Date.parse` would read it as a host-local time — making the
 * computed span depend on the machine's timezone (2 under UTC, 1 under
 * America/Los_Angeles) rather than falling back to 0 for corrupt input.
 *
 * What it must NOT do is narrow the timestamp contract the ingestion path
 * already accepts. `processSessionFiles` persists whatever original string
 * `new Date(...)` accepted, and SDK callers may supply their own, so valid ISO
 * spellings reach this validator: seconds are optional (`T12:00Z`) and a numeric
 * offset may omit its colon (`+0000`). Rejecting those would count the session
 * in `dailyActivity` yet return a 0 span, so `/stats` reads zero total days for
 * real multi-day activity. The seconds group and the offset colon are therefore
 * optional here.
 */
const PERSISTED_DATE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2})))?$/

export function parsePersistedDateMs(value: string): number {
  const match = PERSISTED_DATE_PATTERN.exec(value)
  if (!match) {
    return NaN
  }
  const [, yearStr, monthStr, dayStr, hour, minute, second, offsetHour, offsetMinute] =
    match
  // The clock components need the same treatment as the calendar ones below.
  // `Date.parse` normalizes an out-of-range time instead of rejecting it, so
  // "2026-07-13T24:00:00.000Z" becomes midnight on July 14 -- a corrupt
  // persisted timestamp silently shifting the span by a day rather than
  // falling back to 0.
  if (hour !== undefined) {
    if (Number(hour) > 23 || Number(minute) > 59) {
      return NaN
    }
    if (second !== undefined && Number(second) > 59) {
      return NaN
    }
  }
  if (offsetHour !== undefined) {
    if (Number(offsetHour) > 23 || Number(offsetMinute) > 59) {
      return NaN
    }
  }
  // A date-shaped prefix is not enough: Date.parse silently normalizes
  // impossible calendar values (2026-02-30 parses as March 2), which would turn
  // a corrupt persisted date into a fabricated span instead of the 0 fallback.
  // Validate the spelled components against the real calendar. Use the explicit
  // leap rule rather than `Date.UTC(year, ...)`, which maps years 0-99 to
  // 1900-1999 and would judge year 0000's Feb 29 inconsistently with the
  // Date.parse this returns.
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)
  if (month < 1 || month > 12) {
    return NaN
  }
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const daysInMonth = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]
  if (day < 1 || day > daysInMonth) {
    return NaN
  }
  return Date.parse(value)
}

/**
 * Chronological ordering for the persisted date shapes, for picking the first
 * and last session out of a set.
 *
 * These endpoints cannot be compared as strings. An offset-qualified instant
 * does not sort lexicographically by the moment it denotes:
 * "2026-07-13T23:30:00-10:00" is later than "2026-07-14T00:00:00+14:00", but
 * sorts earlier, so it would be picked as the first endpoint and the span would
 * come out as 0 for two sessions that occupy different UTC days.
 *
 * Falls back to string order only when a value is not parseable, which keeps
 * the selection deterministic for a corrupt cache -- the span helper rejects it
 * separately.
 *
 * Exported for testing.
 */
export function comparePersistedDates(a: string, b: string): number {
  const aMs = parsePersistedDateMs(a)
  const bMs = parsePersistedDateMs(b)
  if (Number.isNaN(aMs) || Number.isNaN(bMs)) {
    return a < b ? -1 : a > b ? 1 : 0
  }
  return aMs - bMs
}
