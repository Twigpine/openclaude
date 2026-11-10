import * as React from 'react'

import { Box, Text } from '../../ink.js'
import {
  bucketValues,
  describeUsageComparison,
  formatUsageCost,
  formatUsageDate,
  formatUsageRouteLabel,
  formatUsageShare,
  LOCAL_USAGE_RANGE_ORDER,
  percentChange,
  sparkline,
  summarizeUsageProjects,
  summarizeUsageSources,
  truncateUsageText,
  type UsageShare,
} from '../../services/usage/format.js'
import type {
  LocalUsageModel,
  LocalUsageRange,
  LocalUsageSummary,
} from '../../services/usage/query.js'
import { formatNumber, formatTokens } from '../../utils/format.js'

const MAX_MODEL_ROWS = 8
const MAX_SHARES = 4
const MAX_CHART_WIDTH = 48
const MAX_MODEL_COLUMN = 40
const MAX_PROVIDER_COLUMN = 22
const TOKENS_COLUMN = 7
const REQUESTS_COLUMN = 5
const COST_COLUMN = 7
const COLUMN_GAP = '  '

export type LocalUsageViewProps = {
  range: LocalUsageRange
  /** Null while the range is loading. */
  summary: LocalUsageSummary | null
  /** Columns available to the view. */
  width: number
  /** Session persistence is off, so new usage is not saved to disk. */
  historyOff?: boolean
  error?: string | null
  now?: Date
}

/** The Local tab of `/usage`: token usage read from the local ledger. */
export function LocalUsageView({
  range,
  summary,
  width,
  historyOff = false,
  error = null,
  now = new Date(),
}: LocalUsageViewProps): React.ReactNode {
  let body: React.ReactNode
  if (error) {
    body = <Text color="error">Could not read local usage: {error}</Text>
  } else if (!summary) {
    body = <Text dimColor>Loading local usage…</Text>
  } else if (summary.totals.requests === 0) {
    body = <EmptyState summary={summary} range={range} />
  } else {
    body = (
      <>
        <Headline summary={summary} range={range} />
        <UsageChart summary={summary} range={range} width={width} now={now} />
        <ModelTable models={summary.models} width={width} />
        <Breakdowns summary={summary} />
      </>
    )
  }

  return (
    <Box flexDirection="column" gap={1} width={width}>
      <RangeSelector range={range} />
      {body}
      {summary && !error ? (
        <Footnotes summary={summary} historyOff={historyOff} now={now} />
      ) : null}
    </Box>
  )
}

function RangeSelector({ range }: { range: LocalUsageRange }): React.ReactNode {
  return (
    <Text>
      {LOCAL_USAGE_RANGE_ORDER.map((option, index) => (
        <React.Fragment key={option}>
          {index > 0 ? <Text dimColor> · </Text> : null}
          {option === range ? (
            <Text bold color="claude">
              [{option}]
            </Text>
          ) : (
            <Text dimColor>{option}</Text>
          )}
        </React.Fragment>
      ))}
    </Text>
  )
}

function EmptyState({
  summary,
  range,
}: {
  summary: LocalUsageSummary
  range: LocalUsageRange
}): React.ReactNode {
  if (range === 'session') {
    return <Text dimColor>No model requests in this session yet.</Text>
  }
  if (!summary.firstTrackedDate) {
    return (
      <Text dimColor>
        No usage recorded yet. OpenClaude now records token usage on this
        machine, so numbers appear after your next request.
      </Text>
    )
  }
  return <Text dimColor>No usage in this range.</Text>
}

function plural(count: number, noun: string): string {
  return `${formatNumber(count)} ${noun}${count === 1 ? '' : 's'}`
}

function hasPricedModels(summary: LocalUsageSummary): boolean {
  return summary.models.some(model => model.costStatus === 'priced')
}

function Headline({
  summary,
  range,
}: {
  summary: LocalUsageSummary
  range: LocalUsageRange
}): React.ReactNode {
  const { totals } = summary
  const comparison = describeUsageComparison(range)
  const change = percentChange(totals.tokens, summary.comparisonTokens)
  const details = [plural(totals.requests, 'request')]
  if (range !== 'session') details.push(plural(totals.sessions, 'session'))
  if (summary.cacheHitRate !== null) {
    details.push(`cache hit ${Math.round(summary.cacheHitRate * 100)}%`)
  }
  if (hasPricedModels(summary)) {
    const marker = summary.unpricedModels.length > 0 ? '*' : ''
    details.push(`~${formatUsageCost(summary.costUSD)}${marker}`)
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{formatTokens(totals.tokens)} tokens</Text>
        {comparison && change !== null ? (
          <Text dimColor>
            {'   '}
            {change > 0 ? '↑' : change < 0 ? '↓' : '±'} {Math.abs(change)}%{' '}
            {comparison}
          </Text>
        ) : null}
      </Text>
      <Text dimColor>{details.join(' · ')}</Text>
    </Box>
  )
}

/** A line of `length` spaces with labels placed at the given columns. */
function placeLabels(
  length: number,
  labels: Array<{ at: number; text: string }>,
): string {
  const line = new Array<string>(length).fill(' ')
  for (const { at, text } of labels) {
    const start = Math.max(0, Math.min(at, length - text.length))
    for (let i = 0; i < text.length && start + i < length; i++) {
      line[start + i] = text[i]!
    }
  }
  return line.join('').trimEnd()
}

function UsageChart({
  summary,
  range,
  width,
  now,
}: {
  summary: LocalUsageSummary
  range: LocalUsageRange
  width: number
  now: Date
}): React.ReactNode {
  const available = Math.max(8, Math.min(width - 2, MAX_CHART_WIDTH))
  let values: number[]
  let axis: (stretch: number, length: number) => string

  if (range === 'today' && summary.hourly) {
    values = summary.hourly
    axis = (stretch, length) =>
      placeLabels(
        length,
        [0, 6, 12, 18].map(hour => ({
          at: hour * stretch,
          text: String(hour).padStart(2, '0'),
        })),
      )
  } else if (summary.daily.length > 1) {
    values = bucketValues(
      summary.daily.map(day => day.tokens),
      available,
    )
    const first = formatUsageDate(summary.daily[0]!.date, now)
    axis = (_stretch, length) =>
      placeLabels(length, [
        { at: 0, text: first },
        { at: length - 'today'.length, text: 'today' },
      ])
  } else {
    return null
  }
  if (!values.some(value => value > 0)) return null

  const stretch = Math.max(1, Math.floor(available / values.length))
  const bars = [...sparkline(values)]
    .map(bar => bar.repeat(stretch))
    .join('')
  return (
    <Box flexDirection="column">
      <Text color="claude">{bars}</Text>
      <Text dimColor>{axis(stretch, bars.length)}</Text>
    </Box>
  )
}

function costCell(model: LocalUsageModel): string {
  switch (model.costStatus) {
    case 'priced':
      return formatUsageCost(model.costUSD ?? 0)
    case 'local':
      return 'local'
    default:
      return '—'
  }
}

function ModelTable({
  models,
  width,
}: {
  models: readonly LocalUsageModel[]
  width: number
}): React.ReactNode {
  const shown = models.slice(0, MAX_MODEL_ROWS)
  const hidden = models.length - shown.length
  const providers = shown.map(model => formatUsageRouteLabel(model.route))
  // Columns fit their contents, so a short table stays compact.
  const showProvider = width >= 76
  const showRequests = width >= 56
  const providerWidth = Math.min(
    MAX_PROVIDER_COLUMN,
    Math.max('Provider'.length, ...providers.map(label => label.length)),
  )
  const fixed =
    (showProvider ? providerWidth + COLUMN_GAP.length : 0) +
    TOKENS_COLUMN +
    COLUMN_GAP.length +
    (showRequests ? REQUESTS_COLUMN + COLUMN_GAP.length : 0) +
    COST_COLUMN +
    COLUMN_GAP.length
  const modelWidth = Math.max(
    10,
    Math.min(
      width - fixed,
      MAX_MODEL_COLUMN,
      Math.max('Model'.length, ...shown.map(model => model.model.length)),
    ),
  )

  const row = (cells: {
    model: string
    provider: string
    tokens: string
    requests: string
    cost: string
  }): string =>
    [
      truncateUsageText(cells.model, modelWidth).padEnd(modelWidth),
      showProvider
        ? truncateUsageText(cells.provider, providerWidth).padEnd(providerWidth)
        : null,
      cells.tokens.padStart(TOKENS_COLUMN),
      showRequests ? cells.requests.padStart(REQUESTS_COLUMN) : null,
      cells.cost.padStart(COST_COLUMN),
    ]
      .filter(cell => cell !== null)
      .join(COLUMN_GAP)
      .trimEnd()

  return (
    <Box flexDirection="column">
      <Text dimColor>
        {row({
          model: 'Model',
          provider: 'Provider',
          tokens: 'Tokens',
          requests: 'Req',
          cost: 'Cost',
        })}
      </Text>
      {shown.map((model, index) => (
        <Text key={`${model.model}\u0000${model.route}`}>
          {row({
            model: model.model,
            provider: providers[index]!,
            tokens: formatTokens(model.tokens),
            requests: formatNumber(model.requests),
            cost: costCell(model),
          })}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text dimColor>
          +{hidden} more model{hidden === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Box>
  )
}

function ShareLine({
  label,
  shares,
}: {
  label: string
  shares: UsageShare[]
}): React.ReactNode {
  const shown = shares.slice(0, MAX_SHARES)
  const parts = shown.map(
    share => `${share.label} ${formatUsageShare(share.share)}`,
  )
  if (shares.length > shown.length) {
    parts.push(`+${shares.length - shown.length} more`)
  }
  return (
    <Text>
      <Text dimColor>{label.padEnd(10)}</Text>
      {parts.join(' · ')}
    </Text>
  )
}

function Breakdowns({ summary }: { summary: LocalUsageSummary }): React.ReactNode {
  const sources = summarizeUsageSources(summary.sources)
  const projects = summarizeUsageProjects(summary.projects)
  return (
    <Box flexDirection="column">
      {sources.length > 0 ? <ShareLine label="Sources" shares={sources} /> : null}
      {projects.length > 1 ? (
        <ShareLine label="Projects" shares={projects} />
      ) : null}
    </Box>
  )
}

function listModels(models: readonly string[]): string {
  const shown = models.slice(0, 3).join(', ')
  return models.length > 3 ? `${shown} and ${models.length - 3} more` : shown
}

function Footnotes({
  summary,
  historyOff,
  now,
}: {
  summary: LocalUsageSummary
  historyOff: boolean
  now: Date
}): React.ReactNode {
  const notes: string[] = []
  if (summary.totals.requests > 0) {
    if (hasPricedModels(summary)) {
      notes.push(
        summary.unpricedModels.length > 0
          ? `* Cost covers priced models only. No known price for ${listModels(summary.unpricedModels)}; set modelPricing to include them.`
          : 'Cost is an estimate from known model prices.',
      )
    } else if (summary.unpricedModels.length > 0) {
      notes.push(
        'No cost shown: these models have no known price. Set modelPricing to add one.',
      )
    }
    if (summary.totals.unreported > 0) {
      notes.push(
        `${plural(summary.totals.unreported, 'request')} had no token counts from the provider.`,
      )
    }
  }
  if (historyOff) {
    notes.push(
      'Usage history is off, so new requests are not saved after this session.',
    )
  }
  if (summary.invalidLines > 0) {
    notes.push(
      `Skipped ${plural(summary.invalidLines, 'unreadable ledger line')}.`,
    )
  }
  if (summary.firstTrackedDate) {
    notes.push(`Tracking since ${formatUsageDate(summary.firstTrackedDate, now)}.`)
  }
  if (notes.length === 0) return null
  return (
    <Box flexDirection="column">
      {notes.map(note => (
        <Text key={note} dimColor>
          {note}
        </Text>
      ))}
    </Box>
  )
}
