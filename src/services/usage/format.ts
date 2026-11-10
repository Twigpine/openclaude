import { basename } from 'path'

import { getRouteLabel } from '../../integrations/routeMetadata.js'
import { startOfLocalDay } from './paths.js'
import type { LocalUsageGroup, LocalUsageRange } from './query.js'

/** Cycle order for the `r` key in the Local usage view. */
export const LOCAL_USAGE_RANGE_ORDER: readonly LocalUsageRange[] = [
  'session',
  'today',
  '7d',
  '30d',
  'all',
]

/** The range after `range` in the cycle order. */
export function nextLocalUsageRange(range: LocalUsageRange): LocalUsageRange {
  const index = LOCAL_USAGE_RANGE_ORDER.indexOf(range)
  return LOCAL_USAGE_RANGE_ORDER[(index + 1) % LOCAL_USAGE_RANGE_ORDER.length]!
}

/** What the headline compares against, or null when the range has none. */
export function describeUsageComparison(range: LocalUsageRange): string | null {
  switch (range) {
    case 'today':
      return 'vs your average day'
    case '7d':
      return 'vs the previous 7 days'
    case '30d':
      return 'vs the previous 30 days'
    default:
      return null
  }
}

/** Whole-number percent change from `baseline`, or null without a baseline. */
export function percentChange(
  current: number,
  baseline: number | null,
): number | null {
  if (baseline === null || baseline <= 0) return null
  return Math.round(((current - baseline) / baseline) * 100)
}

export type UsageSourceCategory =
  | 'conversation'
  | 'subagents'
  | 'compaction'
  | 'advisor'
  | 'background'

export const USAGE_SOURCE_CATEGORY_LABELS: Record<UsageSourceCategory, string> =
  {
    conversation: 'conversation',
    subagents: 'subagents',
    compaction: 'compaction',
    advisor: 'advisor',
    background: 'background',
  }

/**
 * Group a ledger query source into what a user would recognise: their own
 * conversation, subagents, compaction, advisor calls, or background helpers
 * such as titles, summaries, memory and auto-mode checks.
 */
export function categorizeUsageSource(source: string): UsageSourceCategory {
  if (
    source.startsWith('repl_main_thread') ||
    source === 'repl' ||
    source === 'sdk'
  ) {
    return 'conversation'
  }
  if (
    source.startsWith('agent:') ||
    source === 'subagent' ||
    source === 'forked_agent'
  ) {
    return 'subagents'
  }
  if (source === 'compact') return 'compaction'
  if (source === 'advisor') return 'advisor'
  return 'background'
}

export type UsageShare = {
  label: string
  tokens: number
  /** 0..1 share of the group's tokens (of requests when no tokens). */
  share: number
}

/** Shares of a list of groups, largest first, without empty entries. */
export function toUsageShares(
  groups: ReadonlyArray<{ label: string; tokens: number; requests: number }>,
): UsageShare[] {
  const totalTokens = groups.reduce((sum, group) => sum + group.tokens, 0)
  const totalRequests = groups.reduce((sum, group) => sum + group.requests, 0)
  const byTokens = totalTokens > 0
  const total = byTokens ? totalTokens : totalRequests
  if (total <= 0) return []
  return groups
    .map(group => ({
      label: group.label,
      tokens: group.tokens,
      share: (byTokens ? group.tokens : group.requests) / total,
    }))
    .filter(entry => entry.share > 0)
    .sort((a, b) => b.share - a.share)
}

/** Source groups merged into user-facing categories. */
export function summarizeUsageSources(
  sources: readonly LocalUsageGroup[],
): UsageShare[] {
  const categories = new Map<
    UsageSourceCategory,
    { tokens: number; requests: number }
  >()
  for (const source of sources) {
    const category = categorizeUsageSource(source.key)
    const entry = categories.get(category) ?? { tokens: 0, requests: 0 }
    entry.tokens += source.tokens
    entry.requests += source.requests
    categories.set(category, entry)
  }
  return toUsageShares(
    [...categories].map(([category, entry]) => ({
      label: USAGE_SOURCE_CATEGORY_LABELS[category],
      ...entry,
    })),
  )
}

/** Project groups labelled by directory name. */
export function summarizeUsageProjects(
  projects: readonly LocalUsageGroup[],
): UsageShare[] {
  return toUsageShares(
    projects.map(project => ({
      label: formatUsageProjectLabel(project.key),
      tokens: project.tokens,
      requests: project.requests,
    })),
  )
}

/** "71%", or "<1%" for a share that would otherwise round to zero. */
export function formatUsageShare(share: number): string {
  const percent = Math.round(share * 100)
  return percent === 0 && share > 0 ? '<1%' : `${percent}%`
}

/** The project's directory name, falling back to the full path. */
export function formatUsageProjectLabel(project: string): string {
  return basename(project) || project
}

// Runtime routes that have no integration descriptor of their own.
const RUNTIME_ROUTE_LABELS: Record<string, string> = {
  codex: 'Codex',
  foundry: 'Microsoft Foundry',
}

/** Display name of a ledger route id, e.g. `openrouter` → "OpenRouter". */
export function formatUsageRouteLabel(route: string): string {
  try {
    const label = getRouteLabel(route)
    if (label) return label
  } catch {
    // Fall through to the static names when integrations cannot load.
  }
  return RUNTIME_ROUTE_LABELS[route] ?? route
}

/** "$3.41", or "<$0.01" for a cost too small to show. */
export function formatUsageCost(costUSD: number): string {
  if (costUSD > 0 && costUSD < 0.005) return '<$0.01'
  return `$${costUSD.toFixed(2)}`
}

const SPARK_LEVELS = '▁▂▃▄▅▆▇█'

/**
 * One block character per value, scaled to the largest. Empty buckets use the
 * lowest block and any non-empty bucket is at least one step above it, so a
 * small value is never mistaken for none.
 */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values)
  if (max <= 0) return SPARK_LEVELS[0]!.repeat(values.length)
  const top = SPARK_LEVELS.length - 1
  return values
    .map(value => {
      if (value <= 0) return SPARK_LEVELS[0]
      return SPARK_LEVELS[Math.max(1, Math.round((value / max) * top))]
    })
    .join('')
}

/** Sum `values` into at most `buckets` consecutive buckets. */
export function bucketValues(
  values: readonly number[],
  buckets: number,
): number[] {
  if (buckets <= 0) return []
  if (values.length <= buckets) return [...values]
  const result = new Array<number>(buckets).fill(0)
  values.forEach((value, index) => {
    result[Math.floor((index * buckets) / values.length)]! += value
  })
  return result
}

/** "Nov 10", with the year when it is not the current one. */
export function formatUsageDate(dateKey: string, now: Date = new Date()): string {
  const date = startOfLocalDay(dateKey)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  })
}

/** Fit `text` into `width` columns, ending in "…" when cut. */
export function truncateUsageText(text: string, width: number): string {
  if (width <= 0) return ''
  if (text.length <= width) return text
  if (width === 1) return '…'
  return `${text.slice(0, width - 1)}…`
}
