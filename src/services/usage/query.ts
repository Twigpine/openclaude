import { getSessionId } from '../../bootstrap/state.js'
import { getRecordedUsageEvents, readUsageEventsForDay } from './ledger.js'
import {
  getUsageDir,
  listDateKeys,
  monthKeyOf,
  shiftDateKey,
  toLocalDateKey,
} from './paths.js'
import { estimateUsageRowCostUSD } from './pricing.js'
import {
  aggregateUsageEvents,
  getUsageDayRollups,
  listUsageEventDays,
  listUsageRollupMonths,
  readUsageRollupFile,
} from './rollups.js'
import type { UsageEvent, UsageRollupRow, UsageTokenCounts } from './types.js'

export type LocalUsageRange = 'session' | 'today' | '7d' | '30d' | 'all'

export const LOCAL_USAGE_RANGES: readonly LocalUsageRange[] = [
  'session',
  'today',
  '7d',
  '30d',
  'all',
]

export type LocalUsageTotals = UsageTokenCounts & {
  /** input + output + cache read + cache write */
  tokens: number
  requests: number
  /** Requests whose provider returned no token counts. */
  unreported: number
  sessions: number
}

/**
 * `priced`: every request has a known price. `local`: no known price, served
 * by an endpoint on this machine. `unpriced`: no known price.
 */
export type LocalUsageCostStatus = 'priced' | 'local' | 'unpriced'

export type LocalUsageModel = UsageTokenCounts & {
  model: string
  route: string
  local: boolean
  tokens: number
  requests: number
  unreported: number
  /** Sum of the priced part; null unless costStatus is `priced`. */
  costUSD: number | null
  costStatus: LocalUsageCostStatus
}

export type LocalUsageGroup = {
  key: string
  tokens: number
  requests: number
}

export type LocalUsageSummary = {
  range: LocalUsageRange
  today: string
  /** First local day in the range; null for the session range. */
  fromDate: string | null
  toDate: string
  totals: LocalUsageTotals
  /** Share of input-side tokens served from cache, where providers report it. */
  cacheHitRate: number | null
  /** Estimated cost of the priced requests only. */
  costUSD: number
  /** Models with requests but no known price (excluding local endpoints). */
  unpricedModels: string[]
  models: LocalUsageModel[]
  sources: LocalUsageGroup[]
  projects: LocalUsageGroup[]
  /** Tokens per local day across the range (not used for session/today). */
  daily: Array<{ date: string; tokens: number }>
  /** Tokens per local hour of today (today range only). */
  hourly: number[] | null
  /**
   * The comparable baseline for the headline number: today's range compares
   * with the average day over the previous week, 7d/30d with the window just
   * before it. Null when there is not a full comparable window of tracking.
   */
  comparisonTokens: number | null
  /** Earliest local day with recorded usage, or null when none yet. */
  firstTrackedDate: string | null
  /** Ledger lines that could not be parsed (for example a torn write). */
  invalidLines: number
}

export type QueryLocalUsageOptions = {
  now?: Date
  usageDir?: string
  sessionId?: string
}

function tokensOf(counts: UsageTokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheWrite
}

function sumTokens(rows: readonly UsageRollupRow[]): number {
  let total = 0
  for (const row of rows) total += tokensOf(row)
  return total
}

async function findFirstTrackedDate(usageDir: string): Promise<string | null> {
  const [eventDays, months] = await Promise.all([
    listUsageEventDays(usageDir),
    listUsageRollupMonths(usageDir),
  ])
  let first: string | null = eventDays[0] ?? null
  // Event files can be pruned, so older history may only exist in rollups.
  for (const month of months) {
    if (first && month > monthKeyOf(first)) break
    const { days } = await readUsageRollupFile(month, usageDir)
    const tracked = Object.entries(days)
      .filter(([, day]) => day.rows.length > 0)
      .map(([key]) => key)
      .sort()
    if (tracked[0]) {
      if (!first || tracked[0] < first) first = tracked[0]
      break
    }
  }
  return first
}

async function readTodayEvents(
  today: string,
  usageDir: string,
): Promise<{ events: UsageEvent[]; invalidLines: number }> {
  const { events, invalidLines } = await readUsageEventsForDay(today, usageDir)
  const seen = new Set(events.map(event => event.id))
  // Add this process's events that have not reached disk yet.
  for (const event of getRecordedUsageEvents()) {
    if (!seen.has(event.id) && toLocalDateKey(event.ts) === today) {
      events.push(event)
      seen.add(event.id)
    }
  }
  return { events, invalidLines }
}

function groupBy(
  rows: readonly UsageRollupRow[],
  keyOf: (row: UsageRollupRow) => string,
): LocalUsageGroup[] {
  const groups = new Map<string, LocalUsageGroup>()
  for (const row of rows) {
    const key = keyOf(row)
    const group = groups.get(key) ?? { key, tokens: 0, requests: 0 }
    group.tokens += tokensOf(row)
    group.requests += row.requests
    groups.set(key, group)
  }
  return [...groups.values()].sort(
    (a, b) => b.tokens - a.tokens || b.requests - a.requests,
  )
}

function summarizeModels(rows: readonly UsageRollupRow[]): {
  models: LocalUsageModel[]
  costUSD: number
  unpricedModels: string[]
} {
  type Acc = LocalUsageModel & { priced: number; unpricedRemote: number }
  const models = new Map<string, Acc>()
  let costUSD = 0
  for (const row of rows) {
    const key = `${row.model}\u0000${row.route}`
    let model = models.get(key)
    if (!model) {
      model = {
        model: row.model,
        route: row.route,
        local: false,
        tokens: 0,
        requests: 0,
        unreported: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        webSearch: 0,
        costUSD: null,
        costStatus: 'local',
        priced: 0,
        unpricedRemote: 0,
      }
      models.set(key, model)
    }
    model.local = model.local || Boolean(row.local)
    model.tokens += tokensOf(row)
    model.requests += row.requests
    model.unreported += row.unreported
    model.input += row.input
    model.output += row.output
    model.cacheRead += row.cacheRead
    model.cacheWrite += row.cacheWrite
    model.webSearch += row.webSearch

    // Requests without token counts cost nothing we can see; skip pricing.
    if (tokensOf(row) === 0 && row.webSearch === 0) continue
    const cost = estimateUsageRowCostUSD(row)
    if (cost !== null) {
      model.priced++
      model.costUSD = (model.costUSD ?? 0) + cost
      costUSD += cost
    } else if (!row.local) {
      model.unpricedRemote++
    }
  }

  const unpricedModels: string[] = []
  const result: LocalUsageModel[] = []
  for (const { priced, unpricedRemote, ...model } of models.values()) {
    if (unpricedRemote > 0) {
      model.costStatus = 'unpriced'
      model.costUSD = null
      unpricedModels.push(model.model)
    } else if (priced > 0) {
      model.costStatus = 'priced'
    } else {
      model.costStatus = model.local ? 'local' : 'priced'
      if (!model.local) model.costUSD = 0
    }
    result.push(model)
  }
  result.sort((a, b) => b.tokens - a.tokens || b.requests - a.requests)
  return {
    models: result,
    costUSD,
    unpricedModels: [...new Set(unpricedModels)].sort(),
  }
}

function cacheHitRateOf(rows: readonly UsageRollupRow[]): number | null {
  let inputSide = 0
  let cacheRead = 0
  for (const row of rows) {
    inputSide +=
      row.input + row.cacheRead + row.cacheWrite - row.noCacheInputTokens
    cacheRead += row.cacheRead
  }
  return inputSide > 0 ? cacheRead / inputSide : null
}

function buildSummary(input: {
  range: LocalUsageRange
  today: string
  fromDate: string | null
  rows: UsageRollupRow[]
  sessions: Set<string>
  daily: Array<{ date: string; tokens: number }>
  hourly: number[] | null
  comparisonTokens: number | null
  firstTrackedDate: string | null
  invalidLines: number
}): LocalUsageSummary {
  const totals: LocalUsageTotals = {
    tokens: 0,
    requests: 0,
    unreported: 0,
    sessions: input.sessions.size,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    webSearch: 0,
  }
  for (const row of input.rows) {
    totals.tokens += tokensOf(row)
    totals.requests += row.requests
    totals.unreported += row.unreported
    totals.input += row.input
    totals.output += row.output
    totals.cacheRead += row.cacheRead
    totals.cacheWrite += row.cacheWrite
    totals.webSearch += row.webSearch
  }
  const { models, costUSD, unpricedModels } = summarizeModels(input.rows)
  return {
    range: input.range,
    today: input.today,
    fromDate: input.fromDate,
    toDate: input.today,
    totals,
    cacheHitRate: cacheHitRateOf(input.rows),
    costUSD,
    unpricedModels,
    models,
    sources: groupBy(input.rows, row => row.source),
    projects: groupBy(input.rows, row => row.project),
    daily: input.daily,
    hourly: input.hourly,
    comparisonTokens: input.comparisonTokens,
    firstTrackedDate: input.firstTrackedDate,
    invalidLines: input.invalidLines,
  }
}

function rangeSpanDays(range: LocalUsageRange): number | null {
  switch (range) {
    case 'today':
      return 1
    case '7d':
      return 7
    case '30d':
      return 30
    default:
      return null
  }
}

/** Local token usage for one range, read from the usage ledger. */
export async function queryLocalUsage(
  range: LocalUsageRange,
  options: QueryLocalUsageOptions = {},
): Promise<LocalUsageSummary> {
  const now = options.now ?? new Date()
  const usageDir = options.usageDir ?? getUsageDir()
  const today = toLocalDateKey(now)
  const firstTrackedDate = await findFirstTrackedDate(usageDir)

  if (range === 'session') {
    const sessionId = options.sessionId ?? getSessionId()
    const day = aggregateUsageEvents(
      getRecordedUsageEvents().filter(event => event.session === sessionId),
    )
    return buildSummary({
      range,
      today,
      fromDate: null,
      rows: day.rows,
      sessions: new Set(day.sessions),
      daily: [],
      hourly: null,
      comparisonTokens: null,
      firstTrackedDate: firstTrackedDate ?? (day.rows.length ? today : null),
      invalidLines: 0,
    })
  }

  const span = rangeSpanDays(range)
  const fromDate =
    span !== null
      ? shiftDateKey(today, -(span - 1))
      : firstTrackedDate && firstTrackedDate < today
        ? firstTrackedDate
        : today
  const windowKeys = listDateKeys(fromDate, today)

  // The baseline window just before the range (one week of days for today).
  const comparisonKeys =
    range === 'today'
      ? listDateKeys(shiftDateKey(today, -7), shiftDateKey(today, -1))
      : span !== null
        ? listDateKeys(shiftDateKey(fromDate, -span), shiftDateKey(fromDate, -1))
        : []

  const [closed, todayData] = await Promise.all([
    getUsageDayRollups([...comparisonKeys, ...windowKeys], {
      today,
      usageDir,
    }),
    readTodayEvents(today, usageDir),
  ])
  const todayRollup = aggregateUsageEvents(todayData.events)

  const rows: UsageRollupRow[] = []
  const sessions = new Set<string>()
  const daily: Array<{ date: string; tokens: number }> = []
  for (const key of windowKeys) {
    const day = key === today ? todayRollup : closed.get(key)
    if (day) {
      rows.push(...day.rows)
      for (const session of day.sessions) sessions.add(session)
    }
    daily.push({ date: key, tokens: day ? sumTokens(day.rows) : 0 })
  }

  let hourly: number[] | null = null
  if (range === 'today') {
    hourly = new Array<number>(24).fill(0)
    for (const event of todayData.events) {
      const hour = new Date(event.ts).getHours()
      hourly[hour]! += tokensOf(event)
    }
  }

  // Only compare against a window that tracking fully covers.
  let comparisonTokens: number | null = null
  const trackedSince = firstTrackedDate ?? today
  if (comparisonKeys.length > 0 && comparisonKeys[0]! >= trackedSince) {
    let total = 0
    for (const key of comparisonKeys) {
      const day = closed.get(key)
      if (day) total += sumTokens(day.rows)
    }
    if (total > 0) {
      comparisonTokens =
        range === 'today' ? total / comparisonKeys.length : total
    }
  }

  return buildSummary({
    range,
    today,
    fromDate,
    rows,
    sessions,
    daily: range === 'today' ? [] : daily,
    hourly,
    comparisonTokens,
    firstTrackedDate:
      firstTrackedDate ?? (todayRollup.rows.length ? today : null),
    invalidLines: todayData.invalidLines,
  })
}
