import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdtempSync, rmSync } from 'fs'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId } from '../../bootstrap/state.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import {
  flushUsageEvents,
  recordUsageEvent,
  resetUsageLedgerForTesting,
} from './ledger.js'
import {
  getUsageDir,
  getUsageEventsDir,
  getUsageEventsFile,
  getUsageRollupFile,
  shiftDateKey,
  startOfLocalDay,
} from './paths.js'
import { queryLocalUsage } from './query.js'
import { getUsageDayRollups } from './rollups.js'
import type { UsageEvent } from './types.js'

const TODAY = '2026-11-09'
const NOW = (() => {
  const date = startOfLocalDay(TODAY)
  date.setHours(14, 30)
  return date
})()

let usageDir: string
let configDir: string
let seq = 0
const savedPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  seq++
  return {
    v: 1,
    id: `q${String(seq).padStart(11, '0')}`,
    ts: NOW.getTime(),
    session: 's1',
    project: '/work/app',
    model: 'qwen/qwen3.8-max',
    route: 'gitlawb-opengateway',
    source: 'repl_main_thread',
    input: 1000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    webSearch: 0,
    ...overrides,
  }
}

function at(dateKey: string, hour = 12): number {
  const date = startOfLocalDay(dateKey)
  date.setHours(hour)
  return date.getTime()
}

async function writeDay(
  dateKey: string,
  events: UsageEvent[],
  dir = usageDir,
): Promise<void> {
  await mkdir(getUsageEventsDir(dir), { recursive: true })
  await appendFile(
    getUsageEventsFile(dateKey, dir),
    events.map(item => JSON.stringify({ ...item, ts: item.ts }) + '\n').join(''),
  )
}

/** One event per day for `days` days ending yesterday. */
async function writeHistory(days: number, tokensPerDay: number): Promise<void> {
  for (let offset = days; offset >= 1; offset--) {
    const key = shiftDateKey(TODAY, -offset)
    await writeDay(key, [
      event({ ts: at(key), input: tokensPerDay, output: 0 }),
    ])
  }
}

beforeEach(() => {
  usageDir = mkdtempSync(join(tmpdir(), 'usage-query-'))
  configDir = mkdtempSync(join(tmpdir(), 'usage-query-config-'))
  setClaudeConfigHomeDirForTesting(configDir)
  resetUsageLedgerForTesting()
})

afterEach(async () => {
  await flushUsageEvents()
  resetUsageLedgerForTesting()
  setClaudeConfigHomeDirForTesting(undefined)
  if (savedPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedPersistence
  }
  rmSync(usageDir, { recursive: true, force: true })
  rmSync(configDir, { recursive: true, force: true })
})

describe('today', () => {
  test('totals, hourly buckets, models and cost', async () => {
    await writeDay(TODAY, [
      event({ ts: at(TODAY, 9), session: 'a' }),
      event({ ts: at(TODAY, 9), session: 'b', cacheRead: 4000, cacheWrite: 100 }),
      event({
        ts: at(TODAY, 13),
        model: 'claude-sonnet-4-6',
        route: 'anthropic',
        input: 1_000_000,
        output: 1_000_000,
      }),
      event({
        ts: at(TODAY, 13),
        model: 'llama3.3:70b',
        route: 'ollama',
        local: true,
        noCache: true,
        input: 500,
        output: 50,
      }),
      event({ ts: at(TODAY, 14), unreported: true, input: 0, output: 0 }),
    ])

    const summary = await queryLocalUsage('today', { now: NOW, usageDir })

    expect(summary.fromDate).toBe(TODAY)
    expect(summary.totals).toMatchObject({
      requests: 5,
      unreported: 1,
      sessions: 3,
      input: 1_002_500,
      output: 1_000_250,
      cacheRead: 4000,
      cacheWrite: 100,
    })
    expect(summary.totals.tokens).toBe(1_002_500 + 1_000_250 + 4000 + 100)
    expect(summary.hourly?.[9]).toBe(1100 + 5200)
    expect(summary.hourly?.[13]).toBe(2_000_000 + 550)
    expect(summary.daily).toEqual([])

    expect(summary.models.map(model => [model.model, model.costStatus])).toEqual([
      ['claude-sonnet-4-6', 'priced'],
      ['qwen/qwen3.8-max', 'unpriced'],
      ['llama3.3:70b', 'local'],
    ])
    expect(summary.costUSD).toBeCloseTo(18, 6)
    expect(summary.unpricedModels).toEqual(['qwen/qwen3.8-max'])
    expect(summary.models[0]?.costUSD).toBeCloseTo(18, 6)
    expect(summary.models[1]?.costUSD).toBeNull()
    expect(summary.models[2]?.local).toBe(true)
  })

  test('no baseline until a full week has been tracked', async () => {
    await writeHistory(2, 1000)
    await writeDay(TODAY, [event()])
    const summary = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(summary.firstTrackedDate).toBe(shiftDateKey(TODAY, -2))
    expect(summary.comparisonTokens).toBeNull()
  })

  test('compares with the average day of the previous week', async () => {
    await writeHistory(10, 700)
    await writeDay(TODAY, [event()])
    const summary = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(summary.comparisonTokens).toBe(700)
  })

  test('merges events not yet on disk without counting any twice', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const usage = { input_tokens: 10, output_tokens: 1 } as Usage
    recordUsageEvent({ usage, model: 'a' })
    recordUsageEvent({ usage, model: 'a' })
    await flushUsageEvents()
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    recordUsageEvent({ usage, model: 'a' })

    const summary = await queryLocalUsage('today', { usageDir: getUsageDir() })
    expect(summary.totals.requests).toBe(3)
  })
})

describe('windows', () => {
  test('7 days includes today and the six days before it', async () => {
    await writeHistory(8, 100)
    await writeDay(TODAY, [event({ input: 5, output: 0 })])

    const summary = await queryLocalUsage('7d', { now: NOW, usageDir })
    expect(summary.fromDate).toBe(shiftDateKey(TODAY, -6))
    expect(summary.daily).toHaveLength(7)
    expect(summary.daily.at(-1)).toEqual({ date: TODAY, tokens: 5 })
    expect(summary.totals.tokens).toBe(6 * 100 + 5)
    // Tracking began 8 days ago, so the previous 7-day window is incomplete.
    expect(summary.comparisonTokens).toBeNull()
  })

  test('30 days compares with the 30 days before it when fully tracked', async () => {
    await writeHistory(60, 10)
    const summary = await queryLocalUsage('30d', { now: NOW, usageDir })
    expect(summary.totals.tokens).toBe(29 * 10)
    expect(summary.comparisonTokens).toBe(30 * 10)
  })

  test('all time starts at the first tracked day and survives pruned events', async () => {
    const old = shiftDateKey(TODAY, -90)
    await writeDay(old, [event({ ts: at(old), input: 40, output: 0 })])
    // An earlier run, with persistence on, saved the day before pruning it.
    await getUsageDayRollups([old], { today: TODAY, usageDir, persist: true })
    rmSync(getUsageEventsFile(old, usageDir))
    await writeDay(TODAY, [event({ input: 2, output: 0 })])

    const summary = await queryLocalUsage('all', { now: NOW, usageDir })
    expect(summary.firstTrackedDate).toBe(old)
    expect(summary.fromDate).toBe(old)
    expect(summary.daily).toHaveLength(91)
    expect(summary.totals.tokens).toBe(42)
    expect(summary.unreadableMonths).toEqual([])
  })

  test('names a month whose saved totals cannot be read once its events are pruned', async () => {
    const old = shiftDateKey(TODAY, -10)
    await writeDay(old, [event({ ts: at(old), input: 40, output: 0 })])
    await getUsageDayRollups([old], { today: TODAY, usageDir, persist: true })
    rmSync(getUsageEventsFile(old, usageDir))
    await writeFile(getUsageRollupFile('2026-10', usageDir), '{not json')
    await writeDay(TODAY, [event({ input: 2, output: 0 })])

    const summary = await queryLocalUsage('30d', { now: NOW, usageDir })
    expect(summary.totals.tokens).toBe(2)
    expect(summary.unreadableMonths).toEqual(['2026-10'])

    const today = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(today.unreadableMonths).toEqual([])
  })

  test('an empty ledger returns zeros', async () => {
    const summary = await queryLocalUsage('all', { now: NOW, usageDir })
    expect(summary.firstTrackedDate).toBeNull()
    expect(summary.totals.requests).toBe(0)
    expect(summary.cacheHitRate).toBeNull()
    expect(summary.models).toEqual([])
  })
})

describe('cache hit rate', () => {
  test('ignores input from providers that do not report caching', async () => {
    await writeDay(TODAY, [
      event({ input: 200, cacheRead: 600, cacheWrite: 200 }),
      event({ input: 5000, noCache: true }),
    ])
    const summary = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(summary.cacheHitRate).toBeCloseTo(0.6, 6)
  })

  test('is unknown when no provider reports caching', async () => {
    await writeDay(TODAY, [event({ noCache: true })])
    const summary = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(summary.cacheHitRate).toBeNull()
  })
})

describe('groups', () => {
  test('sources and projects are sorted by tokens', async () => {
    await writeDay(TODAY, [
      event({ source: 'compact', input: 10, output: 0 }),
      event({ source: 'agent:builtin:Explore', input: 500, output: 0 }),
      event({ project: '/work/other', input: 30, output: 0 }),
    ])
    const summary = await queryLocalUsage('today', { now: NOW, usageDir })
    expect(summary.sources.map(group => group.key)).toEqual([
      'agent:builtin:Explore',
      'repl_main_thread',
      'compact',
    ])
    expect(summary.projects.map(group => [group.key, group.tokens])).toEqual([
      ['/work/app', 510],
      ['/work/other', 30],
    ])
  })
})

describe('session', () => {
  test('counts only this session, including events never written to disk', async () => {
    const usage = { input_tokens: 10, output_tokens: 2 } as Usage
    recordUsageEvent({ usage, model: 'a' })
    recordUsageEvent({ usage, model: 'b' })

    const summary = await queryLocalUsage('session', { usageDir })
    expect(summary.fromDate).toBeNull()
    expect(summary.totals).toMatchObject({ requests: 2, tokens: 24, sessions: 1 })

    const other = await queryLocalUsage('session', {
      usageDir,
      sessionId: `${getSessionId()}-other`,
    })
    expect(other.totals.requests).toBe(0)
  })
})
