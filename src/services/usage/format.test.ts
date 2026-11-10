import { describe, expect, test } from 'bun:test'

import {
  bucketValues,
  categorizeUsageSource,
  describeUsageComparison,
  formatUsageCost,
  formatUsageDate,
  formatUsageProjectLabel,
  formatUsageRouteLabel,
  formatUsageShare,
  LOCAL_USAGE_RANGE_ORDER,
  nextLocalUsageRange,
  percentChange,
  sparkline,
  summarizeUsageProjects,
  summarizeUsageSources,
  truncateUsageText,
} from './format.js'

describe('ranges', () => {
  test('r cycles through every range and wraps around', () => {
    let range = LOCAL_USAGE_RANGE_ORDER[0]!
    const seen = [range]
    for (let i = 0; i < LOCAL_USAGE_RANGE_ORDER.length; i++) {
      range = nextLocalUsageRange(range)
      seen.push(range)
    }
    expect(seen).toEqual(['session', 'today', '7d', '30d', 'all', 'session'])
  })

  test('only ranges with a baseline describe a comparison', () => {
    expect(describeUsageComparison('today')).toBe('vs your average day')
    expect(describeUsageComparison('7d')).toBe('vs the previous 7 days')
    expect(describeUsageComparison('session')).toBeNull()
    expect(describeUsageComparison('all')).toBeNull()
  })

  test('percent change needs a positive baseline', () => {
    expect(percentChange(118, 100)).toBe(18)
    expect(percentChange(50, 100)).toBe(-50)
    expect(percentChange(10, null)).toBeNull()
    expect(percentChange(10, 0)).toBeNull()
  })
})

describe('sources', () => {
  test.each([
    ['repl_main_thread', 'conversation'],
    ['repl_main_thread:outputStyle:custom', 'conversation'],
    ['sdk', 'conversation'],
    ['agent:builtin:Explore', 'subagents'],
    ['agent:custom', 'subagents'],
    ['forked_agent', 'subagents'],
    ['compact', 'compaction'],
    ['advisor', 'advisor'],
    ['auto_mode', 'background'],
    ['generate_session_title', 'background'],
    ['unknown', 'background'],
  ] as const)('%s is %s', (source, category) => {
    expect(categorizeUsageSource(source)).toBe(category)
  })

  test('merges sources into categories, largest share first', () => {
    const shares = summarizeUsageSources([
      { key: 'repl_main_thread', tokens: 600, requests: 3 },
      { key: 'agent:builtin:Explore', tokens: 100, requests: 1 },
      { key: 'agent:custom', tokens: 200, requests: 1 },
      { key: 'auto_mode', tokens: 100, requests: 5 },
    ])
    expect(shares.map(share => [share.label, share.share])).toEqual([
      ['conversation', 0.6],
      ['subagents', 0.3],
      ['background', 0.1],
    ])
  })

  test('falls back to request shares when no tokens were reported', () => {
    const shares = summarizeUsageSources([
      { key: 'repl_main_thread', tokens: 0, requests: 3 },
      { key: 'compact', tokens: 0, requests: 1 },
    ])
    expect(shares.map(share => share.share)).toEqual([0.75, 0.25])
  })

  test('labels projects by directory name', () => {
    const shares = summarizeUsageProjects([
      { key: '/work/app', tokens: 30, requests: 1 },
      { key: '/work/site', tokens: 70, requests: 1 },
    ])
    expect(shares.map(share => share.label)).toEqual(['site', 'app'])
    expect(formatUsageProjectLabel('/')).toBe('/')
  })

  test('a tiny share shows as <1%, never 0%', () => {
    expect(formatUsageShare(0.712)).toBe('71%')
    expect(formatUsageShare(0.001)).toBe('<1%')
  })
})

describe('labels and numbers', () => {
  test('routes use their integration label, then a built-in name, then the id', () => {
    expect(formatUsageRouteLabel('openrouter')).toBe('OpenRouter')
    expect(formatUsageRouteLabel('codex')).toBe('Codex')
    expect(formatUsageRouteLabel('no-such-route')).toBe('no-such-route')
  })

  test('costs round to cents and never show a tiny cost as $0.00', () => {
    expect(formatUsageCost(3.414)).toBe('$3.41')
    expect(formatUsageCost(0)).toBe('$0.00')
    expect(formatUsageCost(0.001)).toBe('<$0.01')
  })

  test('dates show the year only when it is not the current one', () => {
    const now = new Date(2026, 10, 10)
    expect(formatUsageDate('2026-11-10', now)).toBe('Nov 10')
    expect(formatUsageDate('2025-12-31', now)).toBe('Dec 31, 2025')
  })

  test('long text is cut with an ellipsis', () => {
    expect(truncateUsageText('qwen/qwen3.8-max', 8)).toBe('qwen/qw…')
    expect(truncateUsageText('short', 8)).toBe('short')
    expect(truncateUsageText('anything', 0)).toBe('')
  })
})

describe('charts', () => {
  test('scales to the largest value and keeps small values visible', () => {
    expect(sparkline([0, 1, 50, 100])).toBe('▁▂▅█')
    expect(sparkline([0, 0, 0])).toBe('▁▁▁')
    expect(sparkline([])).toBe('')
  })

  test('buckets long series without losing totals', () => {
    const values = Array.from({ length: 100 }, (_, i) => i)
    const buckets = bucketValues(values, 10)
    expect(buckets).toHaveLength(10)
    expect(buckets.reduce((a, b) => a + b, 0)).toBe(4950)
    expect(bucketValues([1, 2, 3], 10)).toEqual([1, 2, 3])
    expect(bucketValues([1, 2, 3], 0)).toEqual([])
  })
})
