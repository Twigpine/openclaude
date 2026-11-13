import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { appendFile, mkdir, writeFile } from 'fs/promises'
import * as fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { setSessionPersistenceDisabled } from '../../bootstrap/state.js'
import * as settingsModule from '../../utils/settings/settings.js'
import * as lockfile from '../../utils/lockfile.js'
import * as ledger from './ledger.js'
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

const savedPersistenceEnv = process.env.TEST_ENABLE_SESSION_PERSISTENCE

beforeEach(() => {
  usageDir = mkdtempSync(join(tmpdir(), 'usage-rollups-'))
  // Rollups are only saved while session persistence is allowed.
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
})

afterEach(() => {
  if (savedPersistenceEnv === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = savedPersistenceEnv
  }
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

  test.each([
    ['corrupt JSON', '{not json'],
    ['a newer version', JSON.stringify({ version: 999, days: {} })],
  ])(
    'reports an unreadable rollup (%s) only when a requested day has no event file',
    async (_label, contents) => {
      const old = '2026-11-01'
      const unreadable: string[] = []
      const read = (keys: string[]) =>
        getUsageDayRollups(keys, {
          today,
          usageDir,
          persist: false,
          onUnreadableMonth: month => unreadable.push(month),
        })

      // A month with no rollup file has nothing to lose.
      await read([old])
      expect(unreadable).toEqual([])

      await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
      await mkdir(getUsageRollupsDir(usageDir), { recursive: true })
      await writeFile(getUsageRollupFile('2026-11', usageDir), contents)
      // Every requested day can be rebuilt from its event file.
      await read([yesterday])
      expect(unreadable).toEqual([])
      // Only the rollup could hold the usage for `old`.
      const rollups = await read([old, yesterday])
      expect(unreadable).toEqual(['2026-11'])
      expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)
    },
  )

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a rollup file it has no permission to read',
    async () => {
      const old = '2026-11-01'
      await writeDay(old, [makeUsageEvent({ ts: at(old) })])
      await getUsageDayRollups([old], { today, usageDir })
      rmSync(getUsageEventsFile(old, usageDir))

      const unreadable: string[] = []
      const file = getUsageRollupFile('2026-11', usageDir)
      chmodSync(file, 0o000)
      try {
        const rollups = await getUsageDayRollups([old], {
          today,
          usageDir,
          onUnreadableMonth: month => unreadable.push(month),
        })
        expect(rollups.has(old)).toBe(false)
      } finally {
        chmodSync(file, 0o600)
      }
      expect(unreadable).toEqual(['2026-11'])
    },
  )

  test('keeps the saved day when cleanup deletes the file between stat and read', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await getUsageDayRollups([yesterday], { today, usageDir })
    // The file grows, so the next read has to rebuild the day.
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday, 23) })])

    const realRead = ledger.readUsageEventsForDay
    const readSpy = spyOn(ledger, 'readUsageEventsForDay')
    readSpy.mockImplementationOnce(async (dateKey, dir) => {
      readSpy.mockRestore()
      // Another process's cleanup rolls the whole file up and deletes it.
      const { removed } = await rollUpAndPruneUsageEvents(
        startOfLocalDay(today),
        { now: startOfLocalDay(today), usageDir },
      )
      expect(removed).toBe(1)
      return realRead(dateKey, dir)
    })
    try {
      const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
      expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(2)
    } finally {
      readSpy.mockRestore()
    }
    const persisted = await readUsageRollupFile('2026-11', usageDir)
    expect(persisted.days[yesterday]?.rows[0]?.requests).toBe(2)
  })

  test('never replaces a saved day with one built from fewer bytes', async () => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])

    const realRead = ledger.readUsageEventsForDay
    const readSpy = spyOn(ledger, 'readUsageEventsForDay')
    readSpy.mockImplementationOnce(async (dateKey, dir) => {
      readSpy.mockRestore()
      const stale = await realRead(dateKey, dir)
      // Before this read is saved, more events land and another process
      // saves a rollup of the longer file.
      await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday, 23) })])
      await getUsageDayRollups([yesterday], { today, usageDir })
      return stale
    })
    try {
      await getUsageDayRollups([yesterday], { today, usageDir })
    } finally {
      readSpy.mockRestore()
    }
    const persisted = await readUsageRollupFile('2026-11', usageDir)
    expect(persisted.days[yesterday]?.rows[0]?.requests).toBe(2)
  })

  test('rolls up an empty event file and rebuilds it once it grows', async () => {
    await mkdir(getUsageEventsDir(usageDir), { recursive: true })
    await writeFile(getUsageEventsFile(yesterday, usageDir), '')

    const empty = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(empty.get(yesterday)).toEqual({ rows: [], sessions: [], sourceBytes: 0 })

    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    const grown = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(grown.get(yesterday)?.rows[0]?.requests).toBe(1)
  })

  test.each([
    ['written by another version', JSON.stringify({ version: 99, days: { '2026-11-01': {} } })],
    ['holding corrupt JSON', '{"version":1,"days":{"2026-11-01":'],
    ['holding JSON that is not an object', '42'],
  ])('never overwrites or prunes against a rollup file %s', async (_label, contents) => {
    await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
    await mkdir(getUsageRollupsDir(usageDir), { recursive: true })
    await writeFile(getUsageRollupFile('2026-11', usageDir), contents)

    const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
    expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)
    // With no saved totals for the day, its event file must survive cleanup.
    const { removed } = await rollUpAndPruneUsageEvents(
      startOfLocalDay(today),
      { now: startOfLocalDay(today), usageDir },
    )
    expect(removed).toBe(0)
    expect(existsSync(getUsageEventsFile(yesterday, usageDir))).toBe(true)
    expect(readFileSync(getUsageRollupFile('2026-11', usageDir), 'utf8')).toBe(
      contents,
    )
  })

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'never rewrites a month whose rollup file cannot be read',
    async () => {
      const old = '2026-11-01'
      await writeDay(old, [makeUsageEvent({ ts: at(old) })])
      await getUsageDayRollups([old], { today, usageDir })
      rmSync(getUsageEventsFile(old, usageDir))
      await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])

      const file = getUsageRollupFile('2026-11', usageDir)
      chmodSync(file, 0o000)
      try {
        await getUsageDayRollups([yesterday], { today, usageDir })
      } finally {
        chmodSync(file, 0o600)
      }
      const persisted = await readUsageRollupFile('2026-11', usageDir)
      expect(persisted.days[old]?.rows[0]?.requests).toBe(1)
    },
  )

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
  test('skips a locked day and prunes later days, then retries it next sweep', async () => {
    const now = startOfLocalDay('2026-11-09')
    const busy = '2026-10-01'
    const later = '2026-10-02'
    await writeDay(busy, [makeUsageEvent({ ts: at(busy) })])
    await writeDay(later, [makeUsageEvent({ ts: at(later) })])
    const file = getUsageEventsFile(busy, usageDir)
    const realLock = lockfile.lock
    const releaseWriter = await realLock(file)
    // Exercise proper-lockfile's real contention error without its backoff.
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) =>
      realLock(target, target === file ? { ...options, retries: 0 } : options),
    )
    try {
      expect(await rollUpAndPruneUsageEvents(now, { now, usageDir })).toEqual({ removed: 1 })
      expect(existsSync(file)).toBe(true)
      expect(existsSync(getUsageEventsFile(later, usageDir))).toBe(false)
      expect((await readUsageRollupFile('2026-10', usageDir)).days[later]?.rows[0]?.requests).toBe(1)
    } finally {
      lockSpy.mockRestore()
      await releaseWriter()
    }
    expect(await rollUpAndPruneUsageEvents(now, { now, usageDir })).toEqual({ removed: 1 })
  })

  test('propagates unexpected event-lock failures', async () => {
    const now = startOfLocalDay('2026-11-09')
    const old = '2026-10-01'
    await writeDay(old, [makeUsageEvent({ ts: at(old) })])
    const file = getUsageEventsFile(old, usageDir)
    const realLock = lockfile.lock
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) =>
      target === file ? Promise.reject(failure) : realLock(target, options),
    )
    try {
      await expect(rollUpAndPruneUsageEvents(now, { now, usageDir })).rejects.toBe(failure)
      expect(existsSync(file)).toBe(true)
    } finally {
      lockSpy.mockRestore()
    }
  })

  test('keeps a writer append that arrives before pruning can acquire the event lock', async () => {
    const old = '2026-10-01'
    const now = startOfLocalDay('2026-11-09')
    await writeDay(old, [makeUsageEvent({ ts: at(old) })])
    await getUsageDayRollups([old], { today: '2026-11-09', usageDir })
    const file = getUsageEventsFile(old, usageDir)
    const realLock = lockfile.lock
    const realUnlink = fsPromises.unlink
    const releaseWriter = await realLock(file)
    const reachedPrune = Promise.withResolvers<void>()
    const writerDone = Promise.withResolvers<void>()
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) => {
      if (target === file) reachedPrune.resolve()
      return realLock(target, options)
    })
    // The old implementation skips the event lock and reaches unlink instead.
    // Pause either path until the writer finishes, without racing real timers.
    const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async target => {
      if (target === file) {
        reachedPrune.resolve()
        await writerDone.promise
      }
      return realUnlink(target)
    })
    const pruning = rollUpAndPruneUsageEvents(now, { now, usageDir })
    try {
      try {
        await Promise.race([
          reachedPrune.promise,
          pruning.then(() => { throw new Error('Pruning completed before the writer barrier') }),
        ])
        await writeDay(old, [makeUsageEvent({ ts: at(old, 23) })])
      } finally {
        await releaseWriter()
        writerDone.resolve()
      }
      expect(await pruning).toEqual({ removed: 0 })
      expect((await ledger.readUsageEventsForDay(old, usageDir)).events).toHaveLength(2)
    } finally {
      await pruning.catch(() => {})
      lockSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
    // The next pass saves both requests before deleting their raw event file.
    expect(await rollUpAndPruneUsageEvents(now, { now, usageDir })).toEqual({ removed: 1 })
    expect((await readUsageRollupFile('2026-10', usageDir)).days[old]?.rows[0]?.requests).toBe(2)
  })

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

  test('without keepTotals deletes expired files and writes no rollup', async () => {
    const now = startOfLocalDay('2026-11-09')
    now.setHours(10)
    const old = '2026-11-01'
    await writeDay(old, [makeUsageEvent({ ts: at(old) })])
    await writeDay('2026-11-09', [makeUsageEvent({ ts: now.getTime() })])

    const { removed } = await rollUpAndPruneUsageEvents(now, {
      now,
      usageDir,
      keepTotals: false,
    })
    expect(removed).toBe(1)
    expect(existsSync(getUsageEventsFile(old, usageDir))).toBe(false)
    expect(existsSync(getUsageEventsFile('2026-11-09', usageDir))).toBe(true)
    expect(existsSync(getUsageRollupsDir(usageDir))).toBe(false)
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

describe('session persistence opt-outs', () => {
  const today = '2026-11-09'
  const yesterday = '2026-11-08'
  type SettingsSpy = { mockReturnValue(value: never): unknown }
  const optOuts: Array<[string, (settings: SettingsSpy) => () => void]> = [
    ['cleanupPeriodDays is 0', settings => {
      settings.mockReturnValue({ cleanupPeriodDays: 0 } as never)
      return () => {}
    }],
    ['--no-session-persistence', () => {
      setSessionPersistenceDisabled(true)
      return () => setSessionPersistenceDisabled(false)
    }],
    ['CLAUDE_CODE_SKIP_PROMPT_HISTORY', () => {
      process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
      return () => delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    }],
  ]

  for (const [name, apply] of optOuts) {
    test(`${name}: rollups are computed but nothing is written or deleted`, async () => {
      await writeDay(yesterday, [makeUsageEvent({ ts: at(yesterday) })])
      const savedNodeEnv = process.env.NODE_ENV
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
      // Outside the test environment, so only the opt-out under test applies.
      process.env.NODE_ENV = 'production'
      const settingsSpy = spyOn(settingsModule, 'getSettings_DEPRECATED')
      settingsSpy.mockReturnValue({} as never)
      const undo = apply(settingsSpy)
      try {
        const rollups = await getUsageDayRollups([yesterday], { today, usageDir })
        expect(rollups.get(yesterday)?.rows[0]?.requests).toBe(1)
        const { removed } = await rollUpAndPruneUsageEvents(
          startOfLocalDay(today),
          { now: startOfLocalDay(today), usageDir },
        )
        expect(removed).toBe(0)
      } finally {
        undo()
        settingsSpy.mockRestore()
        process.env.NODE_ENV = savedNodeEnv
      }
      expect(existsSync(getUsageRollupsDir(usageDir))).toBe(false)
      expect(existsSync(getUsageEventsFile(yesterday, usageDir))).toBe(true)
    })
  }
})

describe('local date keys', () => {
  test('count calendar days across daylight-saving changes', () => {
    expect(listDateKeys('2026-03-07', '2026-03-10')).toHaveLength(4)
    expect(listDateKeys('2026-10-31', '2026-11-03')).toHaveLength(4)
    expect(shiftDateKey('2026-03-08', 1)).toBe('2026-03-09')
    expect(shiftDateKey('2026-01-01', -1)).toBe('2025-12-31')
  })
})
