import { describe, expect, test } from 'bun:test'
import React from 'react'

import type {
  LocalUsageModel,
  LocalUsageSummary,
} from '../../services/usage/query.js'
import { enableConfigs } from '../../utils/config.js'
import { renderToString } from '../../utils/staticRender.js'
import { LocalUsageView, type LocalUsageViewProps } from './LocalUsageView.js'

enableConfigs()

const NOW = new Date(2026, 10, 10, 15)

function model(overrides: Partial<LocalUsageModel>): LocalUsageModel {
  return {
    model: 'm',
    route: 'anthropic',
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
    costStatus: 'priced',
    ...overrides,
  }
}

function summary(overrides: Partial<LocalUsageSummary> = {}): LocalUsageSummary {
  return {
    range: 'today',
    today: '2026-11-10',
    fromDate: '2026-11-10',
    toDate: '2026-11-10',
    totals: {
      tokens: 1_240_000,
      requests: 412,
      unreported: 0,
      sessions: 6,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      webSearch: 0,
    },
    cacheHitRate: 0.64,
    costUSD: 3.41,
    unpricedModels: ['qwen/qwen3.8-max'],
    models: [
      model({
        model: 'claude-sonnet-4-6',
        tokens: 820_000,
        requests: 210,
        costUSD: 3.41,
      }),
      model({
        model: 'qwen/qwen3.8-max',
        route: 'openrouter',
        tokens: 390_000,
        requests: 190,
        costStatus: 'unpriced',
      }),
      model({
        model: 'llama3.3:70b',
        route: 'ollama',
        local: true,
        tokens: 30_000,
        requests: 12,
        costStatus: 'local',
      }),
    ],
    sources: [
      { key: 'repl_main_thread', tokens: 880_000, requests: 300 },
      { key: 'agent:builtin:Explore', tokens: 223_000, requests: 60 },
      { key: 'auto_mode', tokens: 137_000, requests: 52 },
    ],
    projects: [
      { key: '/work/openclaude', tokens: 990_000, requests: 330 },
      { key: '/work/site', tokens: 250_000, requests: 82 },
    ],
    daily: [],
    hourly: Array.from({ length: 24 }, (_, hour) =>
      hour >= 9 && hour <= 17 ? 100_000 : 0,
    ),
    comparisonTokens: 1_050_000,
    firstTrackedDate: '2026-11-01',
    invalidLines: 0,
    unreadableMonths: [],
    ...overrides,
  }
}

async function render(props: Partial<LocalUsageViewProps> = {}): Promise<string> {
  const width = props.width ?? 96
  return renderToString(
    <LocalUsageView
      range="today"
      summary={summary()}
      width={width}
      now={NOW}
      {...props}
    />,
    width + 4,
  )
}

describe('LocalUsageView', () => {
  test('shows totals, the comparison, models with cost status, and breakdowns', async () => {
    const out = await render()
    expect(out).toContain('session · [today] · 7d · 30d · all')
    expect(out).toContain('1.2m tokens')
    expect(out).toContain('↑ 18% vs your average day')
    expect(out).toContain('412 requests · 6 sessions · cache hit 64% · ~$3.41*')
    expect(out).toMatch(/claude-sonnet-4-6\s+Anthropic\s+820k\s+210\s+\$3\.41/)
    expect(out).toMatch(/qwen\/qwen3\.8-max\s+OpenRouter\s+390k\s+190\s+—/)
    expect(out).toMatch(/llama3\.3:70b\s+Ollama\s+30k\s+12\s+local/)
    expect(out).toContain('Sources   conversation 71% · subagents 18% · background 11%')
    expect(out).toContain('Projects  openclaude 80% · site 20%')
    expect(out).toContain('No known price for qwen/qwen3.8-max')
    expect(out).toContain('Tracking since Nov 1.')
  })

  test('draws today by hour with an hour axis', async () => {
    const out = await render()
    expect(out).toMatch(/▁+█+▁+/)
    expect(out).toMatch(/00\s+06\s+12\s+18/)
  })

  test('draws longer ranges by day, from the first day to today', async () => {
    const daily = Array.from({ length: 7 }, (_, i) => ({
      date: `2026-11-0${i + 4}`,
      tokens: (i + 1) * 1000,
    }))
    const out = await render({
      range: '7d',
      summary: summary({ range: '7d', hourly: null, daily }),
    })
    expect(out).toContain('session · today · [7d] · 30d · all')
    expect(out).toMatch(/Nov 4\s+today/)
    expect(out).toContain('vs the previous 7 days')
  })

  test('hides the comparison without a baseline and cost when nothing is priced', async () => {
    const out = await render({
      summary: summary({
        comparisonTokens: null,
        costUSD: 0,
        models: [
          model({
            model: 'qwen/qwen3.8-max',
            route: 'openrouter',
            tokens: 1_240_000,
            requests: 412,
            costStatus: 'unpriced',
          }),
        ],
      }),
    })
    expect(out).not.toContain('vs your average day')
    expect(out).not.toContain('~$')
    expect(out).toContain('No cost shown')
  })

  test('the session range has no session count or chart', async () => {
    const out = await render({
      range: 'session',
      summary: summary({ range: 'session', hourly: null, comparisonTokens: null }),
    })
    expect(out).toContain('412 requests · cache hit 64%')
    expect(out).not.toContain('sessions')
    expect(out).not.toContain('█')
  })

  test('narrow terminals drop the provider and request columns', async () => {
    const wide = await render({ width: 96 })
    const narrow = await render({ width: 50 })
    expect(wide).toContain('Provider')
    expect(narrow).not.toContain('Provider')
    expect(narrow).not.toContain('Req')
    expect(narrow).toMatch(/claude-sonnet-4-6\s+820k\s+\$3\.41/)
  })

  test('lists at most eight models', async () => {
    const models = Array.from({ length: 10 }, (_, i) =>
      model({ model: `model-${i}`, tokens: 100 - i, requests: 1, costUSD: 0 }),
    )
    const out = await render({ summary: summary({ models }) })
    expect(out).toContain('model-7')
    expect(out).not.toContain('model-8')
    expect(out).toContain('+2 more models')
  })

  test('explains an empty ledger and that history is off', async () => {
    const empty = summary({
      totals: { ...summary().totals, tokens: 0, requests: 0, sessions: 0 },
      models: [],
      sources: [],
      projects: [],
      firstTrackedDate: null,
    })
    const out = await render({ summary: empty, historyOff: true })
    expect(out).toContain('No usage recorded yet.')
    expect(out).toContain('Usage history is off')
    expect(out).not.toContain('Tracking since')
  })

  test('says when saved history could not be read', async () => {
    expect(await render()).not.toContain('Could not read saved usage')
    const out = await render({
      summary: summary({ unreadableMonths: ['2026-09', '2026-10'] }),
    })
    expect(out).toContain(
      'Could not read saved usage for Sep 2026, Oct 2026, so these totals may',
    )
  })

  test('loading and error states', async () => {
    expect(await render({ summary: null })).toContain('Loading local usage…')
    const failed = await render({ summary: null, error: 'EACCES' })
    expect(failed).toContain('Could not read local usage: EACCES')
  })
})
