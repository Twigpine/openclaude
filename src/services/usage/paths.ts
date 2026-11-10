import { join } from 'path'

import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function getUsageDir(): string {
  return join(getClaudeConfigHomeDir(), 'usage')
}

export function getUsageEventsDir(usageDir: string = getUsageDir()): string {
  return join(usageDir, 'events')
}

export function getUsageRollupsDir(usageDir: string = getUsageDir()): string {
  return join(usageDir, 'rollups')
}

export function getUsageEventsFile(
  dateKey: string,
  usageDir: string = getUsageDir(),
): string {
  return join(getUsageEventsDir(usageDir), `${dateKey}.jsonl`)
}

export function getUsageRollupFile(
  monthKey: string,
  usageDir: string = getUsageDir(),
): string {
  return join(getUsageRollupsDir(usageDir), `${monthKey}.json`)
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local calendar day (YYYY-MM-DD) for an epoch-ms timestamp or Date. */
export function toLocalDateKey(value: number | Date): string {
  const date = typeof value === 'number' ? new Date(value) : value
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function monthKeyOf(dateKey: string): string {
  return dateKey.slice(0, 7)
}

export function isDateKey(value: string): boolean {
  return DATE_KEY_PATTERN.test(value)
}

/** Local midnight at the start of a YYYY-MM-DD key. */
export function startOfLocalDay(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year!, month! - 1, day!)
}

/** The local date key `days` calendar days before `dateKey` (DST-safe). */
export function shiftDateKey(dateKey: string, days: number): string {
  const date = startOfLocalDay(dateKey)
  date.setDate(date.getDate() + days)
  return toLocalDateKey(date)
}

/** Inclusive list of local date keys from `from` to `to`. */
export function listDateKeys(from: string, to: string): string[] {
  const keys: string[] = []
  for (let key = from; key <= to; key = shiftDateKey(key, 1)) {
    keys.push(key)
  }
  return keys
}
