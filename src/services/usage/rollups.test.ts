import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getUsageEventsDir,
  getUsageEventsFile,
  getUsageRollupFile,
  getUsageRollupsDir,
  listDateKeys,
  shiftDateKey,
  startOfLocalDay,
  toLocalDateKey,
} from './paths.js'
import {
  aggregateUsageEvents,
  getUsageDayRollups,
  readUsageRollupFile,
  rollUpAndPruneUsageEvents,
} from './rollups.js'
import type { UsageEvent } from './types.js'

let usageDir: string
let seq = 0

function makeUsageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  seq++
  return {
    v: 1,
    id: `e${String(seq).padStart(11, '0')}`,
    ts: Date.now(),
    session: 's1',
    project: '/work/app',
    model: 'qwen/qwen3.8-max',
    route: 'gitlawb-opengateway',
    source: 'repl_main_thread',
    input: 100,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    webSearch: 0,
    ...overrides,
  }
}

async function writeDay(dateKey: string, events: UsageEvent[]): Promise<void> {
  await mkdir(getUsageEventsDir(usageDir), { recursive: true })
  await appendFile(
    getUsageEventsFile(dateKey, usageDir),
    events.map(event => JSON.stringify(event) + '\n').join(''),
  )
}

function at(dateKey: string, hour = 12): number {
  const date = startOfLocalDay(dateKey)
  date.setHours(hour)
  return date.getTime()
}

beforeEach(() => {
  usageDir = mkdtempSync(join(tmpdir(), 'usage-rollups-'))
})

afterEach(() => {
  rmSync(usageDir, { recursive: true, force: true })
})

describe('aggregateUsageEvents', () => {
  test('groups by model, route, source, project and fast mode', () => {
    const { rows, sessions } = aggregateUsageEvents([
      makeUsageEvent({ session: 'b' }),
      makeUsageEvent({ session: 'a', input: 50 }),
      makeUsageEvent({ source: 'compact' }),
      makeUsageEvent({ fast: true }),
      makeUsageEvent({
        unreported: true,
        input: 0,
        output: 0,
      }),
    ])
    expect(sessions).toEqual(['a', 'b', 's1'])
    expect(rows).toHaveLength(3)
    const main = rows.find(row => row.source === 'repl_main_thread' && !row.fast)
    expect(main).toMatchObject({ requests: 3, unreported: 1, input: 150, output: 20 })
    expect(rows.find(row => row.fast)?.requests).toBe(1)
  })

  test('tracks input of providers that do not report cache use', () => {
    const { rows } = aggregateUsageEvents([
      makeUsageEvent({ noCache: true, input: 70, cacheRead: 0, cacheWrite: 0 }),
      makeUsageEvent({ input: 30, cacheRead: 60 }),
    ])
    expect(rows[0]).toMatchObject({ noCacheRequests: 1, noCacheInputTokens: 70 })
  })
})

describe('getUsageDayRollups', () => {
  const today = '2026-11-09'
  const yesterday = '2026-11-08'

  test('rolls up finished days, persists them and never rolls up today', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await writeDay(today, [makeUsageEvent({ ts: at(today) })])

    const rollups = await getUsageDayRollups([yesterday, today], {
      today,
      usageDir,
    })
    expect([...rollups.keys()]).toEqual([yesterday])
    expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)

    const persisted = await readUsageRollupFile('2026-11', usageDir)
    expect(Object.keys(persisted.days)).toEqual([yesterday])
  })

  test('rebuilds a day whose event file grew after it was rolled up', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await getUsageDayRollups([yesterday], { today, usageDir })

    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday, 23) })])
    const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(2)
  })

  test('keeps a rollup after its event file is gone', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await getUsageDayRollups([yesterday], { today, usageDir })
    rmSync(getUsageEventsFile(yesterday, usageDir))

    const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)
  })

  test('treats a corrupt rollup file as empty and rebuilds from events', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await mkdir(getUsageRollupsDir(usageDir), { recursive: true })
    await writeFile(getUsageRollupFile('2026-11', usageDir), '{not json')

    const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)
  })

  test('builds the same rollup every time', async () => {
    await writeDay(yesterday, [
      makeUsageEvent({ ts: at(yesterday) }),
      makeUsageEvent({ ts: at(yesterday), model: 'other' }),
    ])
    const first = await getUsageDayRollups([yesterday], { today, usageDir })
    rmSync(getUsageRollupFile('2026-11', usageDir))
    const second = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(second.get(yesterday)).toEqual(first.get(yesterday)!)
  })
})

describe('rollUpAndPruneUsageEvents', () => {
  test('deletes expired event files only after their totals are saved', async () => {
    const now = startOfLocalDay('2026-11-09')
    now.setHours(10)
    const old = '2026-10-01'
    const recent = '2026-11-05'
    await writeDay(old, [makeUsageEvent({ ts: at(old) })])
    await writeDay(recent, [makeUsageEvent({ ts: at(recent) })])
    await writeDay('2026-11-09', [makeUsageEvent({ ts: now.getTime() })])

    const cutoff = startOfLocalDay('2026-10-10')
    const { removed } = await rollUpAndPruneUsageEvents(cutoff, {
      now,
      usageDir,
    })
    expect(removed).toBe(1)
    expect(existsSync(getUsageEventsFile(old, usageDir))).toBe(false)
    expect(existsSync(getUsageEventsFile(recent, usageDir))).toBe(true)
    expect(existsSync(getUsageEventsFile('2026-11-09', usageDir))).toBe(true)

    const october = await readUsageRollupFile('2026-10', usageDir)
    expect(october.days[old]?.rows[0]?.requests).toBe(1)
  })

  test('never deletes today even with a cutoff in the future', async () => {
    const now = new Date()
    const today = toLocalDateKey(now)
    await writeDay(today, [makeUsageEvent()])
    const { removed } = await rollUpAndPruneUsageEvents(
      new Date(now.getTime() + 86_400_000),
      { now, usageDir },
    )
    expect(removed).toBe(0)
    expect(existsSync(getUsageEventsFile(today, usageDir))).toBe(true)
  })
})

describe('local date keys', () => {
  test('count calendar days across daylight-saving changes', () => {
    expect(listDateKeys('2026-03-07', '2026-03-10')).toHaveLength(4)
    expect(listDateKeys('2026-10-31', '2026-11-03')).toHaveLength(4)
    expect(shiftDateKey('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31')
  })
})
