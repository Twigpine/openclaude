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

function rowKey(event: UsageEvent): string {
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

function isDayRollup(value: unknown): value is UsageDayRollup {
  if (!value || typeof value !== 'object') return false
  const day = value as Partial<UsageDayRollup>
  return (
    Array.isArray(day.rows) &&
    Array.isArray(day.sessions) &&
    typeof day.sourceBytes === 'number'
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
 * Parse rollup file text. Text that is not a JSON object reads as empty: its
 * contents are lost either way. A file of another version reads as empty, or
 * throws when `strict`, so a writer never replaces a file it cannot read.
 */
function parseRollupFile(text: string, strict: boolean): UsageRollupFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return emptyRollupFile()
  }
  if (!parsed || typeof parsed !== 'object') return emptyRollupFile()
  const file = parsed as Partial<UsageRollupFile>
  if (file.version !== USAGE_ROLLUP_VERSION) {
    if (strict) {
      throw new Error(
        `Unsupported usage rollup version: ${String(file.version)}`,
      )
    }
    return emptyRollupFile()
  }
  const days: Record<string, UsageDayRollup> = {}
  if (file.days && typeof file.days === 'object') {
    for (const [key, day] of Object.entries(file.days)) {
      if (isDateKey(key) && isDayRollup(day)) days[key] = day
    }
  }
  return { version: USAGE_ROLLUP_VERSION, days }
}

/** Read one month's rollups; a missing or unreadable file reads as empty. */
export async function readUsageRollupFile(
  monthKey: string,
  usageDir: string = getUsageDir(),
): Promise<UsageRollupFile> {
  let text: string | null
  try {
    text = await readRollupText(monthKey, usageDir)
  } catch (error) {
    logForDebugging(`Failed to read usage rollups: ${String(error)}`)
    return emptyRollupFile()
  }
  return text === null ? emptyRollupFile() : parseRollupFile(text, false)
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
 */
export async function getUsageDayRollups(
  dateKeys: readonly string[],
  options: { today: string; usageDir?: string; persist?: boolean },
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
    const file = await readUsageRollupFile(month, usageDir)
    const rebuilt: Record<string, UsageDayRollup> = {}
    let pruned = false
    for (const key of keys) {
      const size = await eventFileSize(key, usageDir)
      const existing = file.days[key]
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
    const saved = pruned ? await readUsageRollupFile(month, usageDir) : file
    for (const key of keys) {
      const day = rebuilt[key] ?? saved.days[key]
      if (day) result.set(key, day)
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
    const current =
      text === null ? emptyRollupFile() : parseRollupFile(text, true)
    for (const [key, day] of Object.entries(days)) {
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

async function deleteEventFile(
  dateKey: string,
  usageDir: string,
): Promise<boolean> {
  try {
    await unlink(getUsageEventsFile(dateKey, usageDir))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logForDebugging(`Failed to delete usage events: ${String(error)}`)
    }
    return false
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
    const size = await eventFileSize(key, usageDir)
    const rollup = rollups.get(key)
    // Only delete a file whose current contents are captured in a rollup.
    if (size === null || !rollup || rollup.sourceBytes !== size) continue
    const persisted = (await readUsageRollupFile(monthKeyOf(key), usageDir))
      .days[key]
    if (!persisted || persisted.sourceBytes !== size) continue
    if (await deleteEventFile(key, usageDir)) removed++
  }
  return { removed }
}
