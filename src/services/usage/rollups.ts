import { randomBytes } from 'crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'

import { logForDebugging } from '../../utils/debug.js'
import { lock } from '../../utils/lockfile.js'
import { shouldSkipSessionPersistence } from '../../utils/sessionPersistencePolicy.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { readUsageEventsForDay } from './ledger.js'
import {
  getUsageDir,
  getUsageEventsDir,
  getUsageEventsFile,
  getUsageRollupFile,
  getUsageRollupsDir,
  isDateKey,
  monthKeyOf,
  toLocalDateKey,
} from './paths.js'
import {
  USAGE_ROLLUP_VERSION,
  type UsageDayRollup,
  type UsageEvent,
  type UsageRollupFile,
  type UsageRollupRow,
} from './types.js'

/** Summed fields of a rollup row. */
const ROW_COUNTERS = [
  'requests', 'unreported', 'noCacheRequests', 'noCacheInputTokens',
  'input', 'output', 'cacheRead', 'cacheWrite', 'webSearch',
] as const

function rowKey(event: Pick<UsageEvent, 'model' | 'route' | 'local' | 'source' | 'project' | 'fast'>): string {
  return [
    event.model,
    event.route,
    event.local ? '1' : '0',
    event.source,
    event.project,
    event.fast ? '1' : '0',
  ].join('\u0000')
}

/** Sum events into one row per model/route/source/project/fast combination. */
export function aggregateUsageEvents(
  events: readonly UsageEvent[],
): Omit<UsageDayRollup, 'sourceBytes'> {
  const rows = new Map<string, UsageRollupRow>()
  const sessions = new Set<string>()
  for (const event of events) {
    sessions.add(event.session)
    const key = rowKey(event)
    let row = rows.get(key)
    if (!row) {
      row = {
        model: event.model,
        route: event.route,
        source: event.source,
        project: event.project,
        requests: 0,
        unreported: 0,
        noCacheRequests: 0,
        noCacheInputTokens: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        webSearch: 0,
      }
      if (event.local) row.local = true
      if (event.fast) row.fast = true
      rows.set(key, row)
    }
    row.requests++
    if (event.unreported) row.unreported++
    if (event.noCache) {
      row.noCacheRequests++
      row.noCacheInputTokens +=
        event.input + event.cacheRead + event.cacheWrite
    }
    row.input += event.input
    row.output += event.output
    row.cacheRead += event.cacheRead
    row.cacheWrite += event.cacheWrite
    row.webSearch += event.webSearch
  }
  return { rows: [...rows.values()], sessions: [...sessions].sort() }
}

function emptyRollupFile(): UsageRollupFile {
  return { version: USAGE_ROLLUP_VERSION, days: {} }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRollupRow(value: unknown): value is UsageRollupRow {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.model === 'string' &&
    typeof row.route === 'string' &&
    typeof row.source === 'string' &&
    typeof row.project === 'string' &&
    (row.local === undefined || row.local === true) &&
    (row.fast === undefined || row.fast === true) &&
    ROW_COUNTERS.every(field => isCount(row[field]))
  )
}

/** A day exactly as `aggregateUsageEvents` builds it. */
function isDayRollup(value: unknown): value is UsageDayRollup {
  if (!value || typeof value !== 'object') return false
  const day = value as Partial<UsageDayRollup>
  return (
    Array.isArray(day.rows) &&
    day.rows.every(isRollupRow) &&
    // A merge keyed by row would silently drop a duplicate's totals.
    new Set(day.rows.map(rowKey)).size === day.rows.length &&
    Array.isArray(day.sessions) &&
    day.sessions.every(session => typeof session === 'string') &&
    isCount(day.sourceBytes)
  )
}

/** Rollup file text, or null when the month has no file. */
async function readRollupText(
  monthKey: string,
  usageDir: string,
): Promise<string | null> {
  try {
    return await readFile(getUsageRollupFile(monthKey, usageDir), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Parse rollup file text. Throws when the text is not a rollup file of this
 * version (malformed JSON, not an object, another version, or any day that
 * is not a valid rollup), so a writer never replaces a file it cannot read:
 * it may hold the only copy of days whose event files were pruned. Skipping
 * just the bad days would let the next write delete them.
 */
function parseRollupFile(text: string): UsageRollupFile {
  const parsed: unknown = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Usage rollup file is not a JSON object')
  }
  const file = parsed as Partial<UsageRollupFile>
  if (file.version !== USAGE_ROLLUP_VERSION) {
    throw new Error(`Unsupported usage rollup version: ${String(file.version)}`)
  }
  if (!file.days || typeof file.days !== 'object' || Array.isArray(file.days)) {
    throw new Error('Usage rollup file has no days object')
  }
  const days: Record<string, UsageDayRollup> = {}
  for (const [key, day] of Object.entries(file.days)) {
    if (!isDateKey(key) || !isDayRollup(day)) {
      throw new Error(`Invalid usage rollup day: ${key}`)
    }
    days[key] = day
  }
  return { version: USAGE_ROLLUP_VERSION, days }
}

/**
 * One month's rollups. A missing file reads as empty; a file that exists but
 * cannot be read or parsed also reads as empty, with `unreadable` set.
 */
async function readRollupFileChecked(
  monthKey: string,
  usageDir: string,
): Promise<{ file: UsageRollupFile; unreadable: boolean }> {
  try {
    const text = await readRollupText(monthKey, usageDir)
    if (text === null) return { file: emptyRollupFile(), unreadable: false }
    return { file: parseRollupFile(text), unreadable: false }
  } catch (error) {
    logForDebugging(`Failed to read usage rollups: ${String(error)}`)
    return { file: emptyRollupFile(), unreadable: true }
  }
}

/** Read one month's rollups; a missing or unreadable file reads as empty. */
export async function readUsageRollupFile(
  monthKey: string,
  usageDir: string = getUsageDir(),
): Promise<UsageRollupFile> {
  return (await readRollupFileChecked(monthKey, usageDir)).file
}

async function writeUsageRollupFile(
  monthKey: string,
  file: UsageRollupFile,
  usageDir: string,
): Promise<void> {
  const target = getUsageRollupFile(monthKey, usageDir)
  const temp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temp, jsonStringify(file), { encoding: 'utf8', mode: 0o600 })
  try {
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

async function eventFileSize(
  dateKey: string,
  usageDir: string,
): Promise<number | null> {
  try {
    return (await stat(getUsageEventsFile(dateKey, usageDir))).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Rollups for finished days, rebuilding any day whose event file is new or
 * has grown since its rollup was built. Days on or after `today` are never
 * rolled up. Days with neither an event file nor a rollup are omitted.
 *
 * Rebuilt days are saved only while session persistence is allowed (or when
 * `persist` says so); otherwise they are computed in memory only.
 *
 * `onUnreadableMonth` is called for a month whose rollup file exists but
 * cannot be read while some requested day of it has no event file to rebuild
 * from, so that day's usage may be missing from the result.
 */
export async function getUsageDayRollups(
  dateKeys: readonly string[],
  options: {
    today: string
    usageDir?: string
    persist?: boolean
    onUnreadableMonth?: (monthKey: string) => void
  },
): Promise<Map<string, UsageDayRollup>> {
  const usageDir = options.usageDir ?? getUsageDir()
  const persist = options.persist ?? !shouldSkipSessionPersistence()
  const closedKeys = dateKeys.filter(key => key < options.today)
  const byMonth = new Map<string, string[]>()
  for (const key of closedKeys) {
    const month = monthKeyOf(key)
    const keys = byMonth.get(month)
    if (keys) keys.push(key)
    else byMonth.set(month, [key])
  }

  const result = new Map<string, UsageDayRollup>()
  for (const [month, keys] of byMonth) {
    const read = await readRollupFileChecked(month, usageDir)
    const rebuilt: Record<string, UsageDayRollup> = {}
    let pruned = false
    for (const key of keys) {
      const size = await eventFileSize(key, usageDir)
      const existing = read.file.days[key]
      if (size !== null && (!existing || existing.sourceBytes !== size)) {
        const day = await readUsageEventsForDay(key, usageDir)
        if (day.exists) {
          rebuilt[key] = {
            ...aggregateUsageEvents(day.events),
            sourceBytes: day.bytes,
          }
        } else {
          // Deleted after the stat by another process's cleanup, which saves
          // the day's totals before deleting its file.
          pruned = true
        }
      }
    }
    const saved = pruned ? await readRollupFileChecked(month, usageDir) : read
    for (const key of keys) {
      const day = rebuilt[key] ?? saved.file.days[key]
      if (day) result.set(key, day)
    }
    if (saved.unreadable && keys.some(key => !rebuilt[key])) {
      options.onUnreadableMonth?.(month)
    }
    if (persist && Object.keys(rebuilt).length > 0) {
      try {
        await saveUsageDayRollups(month, rebuilt, usageDir)
      } catch (error) {
        // The numbers above are still correct; the next read rebuilds them.
        logForDebugging(`Failed to save usage rollups: ${String(error)}`)
      }
    }
  }
  return result
}

async function saveUsageDayRollups(
  month: string,
  days: Record<string, UsageDayRollup>,
  usageDir: string,
): Promise<void> {
  const rollupsDir = getUsageRollupsDir(usageDir)
  await mkdir(rollupsDir, { recursive: true, mode: 0o700 })
  const release = await lock(rollupsDir, {
    stale: 10_000,
    retries: { retries: 5, minTimeout: 25 },
  })
  try {
    // Re-read under the lock so a concurrent writer's days are kept. The read
    // is strict: if the file cannot be read, rewriting it would drop days
    // whose event files are already gone, so the save fails instead.
    const text = await readRollupText(month, usageDir)
    const current = text === null ? emptyRollupFile() : parseRollupFile(text)
    for (const [key, day] of Object.entries(days)) {
      // A reader may have captured raw events before pruning, then waited
      // here while a late writer added to the archived totals. Once the raw
      // file is gone its snapshot must never replace the saved day.
      if (await eventFileSize(key, usageDir) === null) continue
      // Event files only grow, so a day built from fewer bytes is older than
      // the saved one and must not replace it.
      const saved = current.days[key]
      if (!saved || saved.sourceBytes <= day.sourceBytes) current.days[key] = day
    }
    await writeUsageRollupFile(month, current, usageDir)
  } finally {
    await release()
  }
}

/**
 * Add a delayed flush to a day whose raw file was already pruned. The caller
 * holds the event-path lock and has checked that the raw file is absent.
 * Return false for a new day, which should still get a raw event file.
 */
export async function appendToPrunedUsageDay(
  dateKey: string,
  events: readonly UsageEvent[],
  usageDir: string,
): Promise<boolean> {
  // Today and future days are never archived. Their first raw write must
  // remain independent of unrelated historical rollup failures.
  if (dateKey >= toLocalDateKey(new Date())) return false
  const month = monthKeyOf(dateKey)
  const read = await readRollupFileChecked(month, usageDir)
  // Missing history and unreadable history are different: recreating a raw
  // suffix here would let sourceBytes hide it or replace archived totals.
  if (read.unreadable) throw new Error('Cannot append to unreadable usage rollups')
  if (!read.file.days[dateKey]) return false
  const release = await lock(getUsageRollupsDir(usageDir), {
    stale: 10_000,
    retries: { retries: 5, minTimeout: 25 },
  })
  try {
    const text = await readRollupText(month, usageDir)
    if (text === null) throw new Error('Cannot append to unreadable usage rollups')
    const file = parseRollupFile(text)
    const saved = file.days[dateKey]
    if (!saved) return false
    const added = aggregateUsageEvents(events)
    const rows = new Map(saved.rows.map(row => [rowKey(row), row]))
    for (const row of added.rows) {
      const key = rowKey(row)
      const existing = rows.get(key)
      if (!existing) rows.set(key, row)
      else {
        for (const field of ROW_COUNTERS) existing[field] += row[field]
      }
    }
    saved.rows = [...rows.values()]
    saved.sessions = [...new Set([...saved.sessions, ...added.sessions])].sort()
    await writeUsageRollupFile(month, file, usageDir)
    return true
  } finally {
    // The write committed; an unlock error must not cause a duplicate flush.
    await release().catch(error => {
      logForDebugging(`Failed to release usage rollup lock: ${String(error)}`)
    })
  }
}

/** Date keys of every day that has an event file. */
export async function listUsageEventDays(
  usageDir: string = getUsageDir(),
): Promise<string[]> {
  try {
    const names = await readdir(getUsageEventsDir(usageDir))
    return names
      .filter(name => name.endsWith('.jsonl'))
      .map(name => name.slice(0, -'.jsonl'.length))
      .filter(isDateKey)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Month keys of every rollup file. */
export async function listUsageRollupMonths(
  usageDir: string = getUsageDir(),
): Promise<string[]> {
  try {
    const names = await readdir(getUsageRollupsDir(usageDir))
    return names
      .filter(name => /^\d{4}-\d{2}\.json$/.test(name))
      .map(name => name.slice(0, -'.json'.length))
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * Delete a day's event file while holding the event-path lock that appenders
 * use, so no append can land in the file as it is removed. `shouldDelete`
 * runs under the same lock. A busy or already-removed day is skipped and
 * left for a later sweep.
 */
async function deleteEventFile(
  dateKey: string,
  usageDir: string,
  shouldDelete: () => Promise<boolean> = async () => true,
): Promise<boolean> {
  const file = getUsageEventsFile(dateKey, usageDir)
  let release: () => Promise<void>
  try {
    release = await lock(file, {
      realpath: false,
      stale: 10_000,
      retries: { retries: 5, minTimeout: 25 },
    })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOCKED') return false
    throw error
  }
  try {
    if (!(await shouldDelete())) return false
    try {
      await unlink(file)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logForDebugging(`Failed to delete usage events: ${String(error)}`)
      }
      return false
    }
  } finally {
    await release()
  }
}

/**
 * Delete event files older than `cutoff`. Today's file is never deleted.
 *
 * Each day is rolled up first so its totals survive, unless `keepTotals` is
 * false (a cleanup period of 0 keeps no history, so no rollup is written).
 * A file is only deleted once its rollup is saved, so while session
 * persistence is off nothing is deleted except with `keepTotals: false`.
 */
export async function rollUpAndPruneUsageEvents(
  cutoff: Date,
  options: { now?: Date; usageDir?: string; keepTotals?: boolean } = {},
): Promise<{ removed: number }> {
  const usageDir = options.usageDir ?? getUsageDir()
  const today = toLocalDateKey(options.now ?? new Date())
  const cutoffKey = toLocalDateKey(cutoff)
  const expired = (await listUsageEventDays(usageDir)).filter(
    key => key < cutoffKey && key < today,
  )
  if (expired.length === 0) return { removed: 0 }

  let removed = 0
  if (options.keepTotals === false) {
    for (const key of expired) {
      if (await deleteEventFile(key, usageDir)) removed++
    }
    return { removed }
  }

  const rollups = await getUsageDayRollups(expired, { today, usageDir })
  for (const key of expired) {
    const rollup = rollups.get(key)
    if (!rollup) continue
    // Validate the current file and saved totals under the appenders' lock,
    // so an unrolled append cannot be deleted.
    const deleted = await deleteEventFile(key, usageDir, async () => {
      const size = await eventFileSize(key, usageDir)
      if (size === null || rollup.sourceBytes !== size) return false
      const persisted = (await readUsageRollupFile(monthKeyOf(key), usageDir))
        .days[key]
      return persisted?.sourceBytes === size
    })
    if (deleted) removed++
  }
  return { removed }
}
