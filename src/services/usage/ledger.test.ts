import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { appendFile, mkdir } from 'fs/promises'
import * as fsPromises from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { getSessionId } from '../../bootstrap/state.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import * as lockfile from '../../utils/lockfile.js'
import * as ledger from './ledger.js'
import {
  buildUsageEvent,
  flushUsageEvents,
  getRecordedUsageEvents,
  parseUsageEventLine,
  readUsageEventsForDay,
  recordUsageEvent,
  resetUsageLedgerForTesting,
} from './ledger.js'
import { getUsageDir, getUsageEventsDir, getUsageEventsFile, getUsageRollupFile, getUsageRollupsDir, startOfLocalDay, toLocalDateKey } from './paths.js'
import { getUsageDayRollups, readUsageRollupFile, rollUpAndPruneUsageEvents } from './rollups.js'

// Provider-selection variables that route detection reads.
const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GEMINI_VERTEX',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const
const ENV_KEYS = ['TEST_ENABLE_SESSION_PERSISTENCE', ...PROVIDER_ENV_KEYS] as const
const savedEnv = new Map<string, string | undefined>()
let configDir: string

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_input_tokens: 5000,
    cache_creation_input_tokens: 40,
    ...overrides,
  } as Usage
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  configDir = mkdtempSync(join(tmpdir(), 'usage-ledger-'))
  setClaudeConfigHomeDirForTesting(configDir)
  resetUsageLedgerForTesting()
})

afterEach(async () => {
  await flushUsageEvents()
  resetUsageLedgerForTesting()
  setClaudeConfigHomeDirForTesting(undefined)
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(configDir, { recursive: true, force: true })
})

describe('buildUsageEvent', () => {
  test('stores token counts, source, session and project but no content', () => {
    const event = buildUsageEvent(
      {
        usage: usage({ server_tool_use: { web_search_requests: 2 } } as Partial<Usage>),
        model: 'qwen/qwen3.8-max',
        querySource: 'repl_main_thread',
        agentId: 'agent-1',
        providerOverride: { baseURL: 'https://openrouter.ai/api/v1' },
      },
      1_762_682_400_000,
    )

    expect(event).toMatchObject({
      v: 1,
      ts: 1_762_682_400_000,
      session: getSessionId(),
      model: 'qwen/qwen3.8-max',
      route: 'openrouter',
      source: 'repl_main_thread',
      agentId: 'agent-1',
      input: 1200,
      output: 300,
      cacheRead: 5000,
      cacheWrite: 40,
      webSearch: 2,
    })
    expect(event.id).toMatch(/^[0-9a-f]{12}$/)
    expect(event.local).toBeUndefined()
    expect(event.unreported).toBeUndefined()
    expect(JSON.stringify(event)).not.toContain('openrouter.ai')
  })

  test('marks local endpoints and providers without cache reporting', () => {
    const event = buildUsageEvent({
      usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
      model: 'llama3.3:70b',
      providerOverride: { baseURL: 'http://localhost:11434/v1' },
    })

    expect(event.route).toBe('ollama')
    expect(event.local).toBe(true)
    expect(event.noCache).toBe(true)
    expect(event.source).toBe('unknown')
  })

  test('flags requests with no token counts and fast-mode requests', () => {
    const unreported = buildUsageEvent({
      usage: usage({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
      model: 'm',
    })
    expect(unreported.unreported).toBe(true)

    const fast = buildUsageEvent({
      usage: usage({ speed: 'fast' } as Partial<Usage>),
      model: 'claude-opus-4-8',
    })
    expect(fast.fast).toBe(true)
  })

  test('treats negative and non-numeric counts as zero', () => {
    const event = buildUsageEvent({
      usage: usage({
        input_tokens: -5,
        output_tokens: Number.NaN,
        cache_read_input_tokens: null,
      } as unknown as Partial<Usage>),
      model: 'm',
    })
    expect(event.input).toBe(0)
    expect(event.output).toBe(0)
    expect(event.cacheRead).toBe(0)
  })

  test('uses the active provider route when there is no override', () => {
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
    expect(buildUsageEvent({ usage: usage(), model: 'm' }).route).toBe(
      'openrouter',
    )
  })

  test('labels a custom Anthropic proxy as its own route', () => {
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key]
    process.env.ANTHROPIC_BASE_URL = 'https://llm-proxy.example.com'
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
    process.env.ANTHROPIC_AUTH_TOKEN = 'proxy-token'
    const event = buildUsageEvent({ usage: usage(), model: 'claude-sonnet-4-6' })
    expect(event.route).toBe('custom-anthropic')
    expect(JSON.stringify(event)).not.toContain('proxy-token')
  })
})

describe('recordUsageEvent', () => {
  test.each(['a', 'b'])('a flush of model %s waiting on pruning adds to archived totals and survives a stale rollup save', async lateModel => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const old = '2026-10-01'
    const today = '2026-11-09'
    const now = startOfLocalDay(today)
    const recordOldRequest = () => {
      const clock = spyOn(Date, 'now').mockReturnValue(startOfLocalDay(old).getTime())
      try {
        recordUsageEvent({ usage: usage(), model: getRecordedUsageEvents().length ? lateModel : 'a', requestKey: `request-${getRecordedUsageEvents().length}` })
      } finally {
        clock.mockRestore()
      }
    }
    recordOldRequest()
    await flushUsageEvents()
    const file = getUsageEventsFile(old)
    const originalBytes = statSync(file).size
    const readSnapshot = Promise.withResolvers<void>()
    const resumeReader = Promise.withResolvers<void>()
    const writerWaiting = Promise.withResolvers<void>()
    const realRead = ledger.readUsageEventsForDay
    let pauseRead = true
    const readSpy = spyOn(ledger, 'readUsageEventsForDay').mockImplementation(async (key, dir) => {
      const result = await realRead(key, dir)
      if (pauseRead && key === old) {
        pauseRead = false
        readSnapshot.resolve()
        await resumeReader.promise
      }
      return result
    })
    const realLock = lockfile.lock
    let eventLockCalls = 0
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation((target, options) => {
      if (target === file && ++eventLockCalls === 2) writerWaiting.resolve()
      return realLock(target, options)
    })
    const realUnlink = fsPromises.unlink
    let writer: Promise<void> | undefined
    const unlinkSpy = spyOn(fsPromises, 'unlink').mockImplementation(async target => {
      if (target === file) {
        recordOldRequest()
        // Both events serialize to the same size: size alone cannot identify
        // a recreated file. Start the real flush while pruning owns its lock.
        const events = getRecordedUsageEvents()
        expect(Buffer.byteLength(JSON.stringify(events[1]) + '\n')).toBe(originalBytes)
        writer = flushUsageEvents()
        await writerWaiting.promise
      }
      return realUnlink(target)
    })
    const staleRead = getUsageDayRollups([old], { today, usageDir: getUsageDir() })
    try {
      await readSnapshot.promise
      expect(await rollUpAndPruneUsageEvents(now, { now })).toEqual({ removed: 1 })
      await writer
      const saved = (await readUsageRollupFile('2026-10')).days[old]
      expect(saved?.rows).toHaveLength(lateModel === 'a' ? 1 : 2)
      expect(saved?.rows.reduce((sum, row) => sum + row.requests, 0)).toBe(2)
      expect(saved?.rows.reduce((sum, row) => sum + row.input, 0)).toBe(2400)
      expect(saved?.rows.reduce((sum, row) => sum + row.cacheRead, 0)).toBe(10000)
      expect(saved?.rows.reduce((sum, row) => sum + row.cacheWrite, 0)).toBe(80)
      expect((await readUsageEventsForDay(old)).exists).toBe(false)
      resumeReader.resolve()
      await staleRead
      expect((await getUsageDayRollups([old], { today })).get(old)).toEqual(saved!)
      expect(await rollUpAndPruneUsageEvents(now, { now })).toEqual({ removed: 0 })
    } finally {
      resumeReader.resolve()
      await staleRead.catch(() => {})
      await writer?.catch(() => {})
      readSpy.mockRestore()
      lockSpy.mockRestore()
      unlinkSpy.mockRestore()
    }
  })

  test.each(['{broken', '{"version":999,"days":{}}'])('a new raw day is writable beside an unreadable month: %s', async contents => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const today = toLocalDateKey(Date.now())
    await mkdir(getUsageRollupsDir(), { recursive: true })
    const file = getUsageRollupFile(today.slice(0, 7))
    writeFileSync(file, contents)
    recordUsageEvent({ usage: usage(), model: 'a' })
    await flushUsageEvents()
    expect((await readUsageEventsForDay(today)).events).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe(contents)
  })

  test.each(['EIO', 'invalid JSON', 'future version'])('an archived flush retries a transient %s without recreating raw history', async failure => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const old = toLocalDateKey(Date.now() - 2 * 86_400_000)
    const now = new Date()
    const recordOldRequest = () => {
      const clock = spyOn(Date, 'now').mockReturnValue(startOfLocalDay(old).getTime())
      try {
        recordUsageEvent({ usage: usage(), model: 'a', requestKey: `request-${getRecordedUsageEvents().length}` })
      } finally {
        clock.mockRestore()
      }
    }
    recordOldRequest()
    await flushUsageEvents()
    expect(await rollUpAndPruneUsageEvents(now, { now })).toEqual({ removed: 1 })
    const month = old.slice(0, 7)
    const rollupFile = getUsageRollupFile(month)
    const realRead = fsPromises.readFile
    let unreadable = true
    const readSpy = spyOn(fsPromises, 'readFile').mockImplementation((async (
      path: Parameters<typeof realRead>[0],
      options?: Parameters<typeof realRead>[1],
    ) => {
      if (path === rollupFile && unreadable) {
        unreadable = false
        if (failure === 'EIO') throw Object.assign(new Error('transient read failure'), { code: 'EIO' })
        return failure === 'invalid JSON' ? '{broken' : '{"version":999,"days":{}}'
      }
      return realRead(path, options ?? null)
    }) as typeof realRead)
    try {
      recordOldRequest()
      await flushUsageEvents()
      expect(unreadable).toBe(false)
      expect((await readUsageEventsForDay(old)).exists).toBe(false)
      expect((await readUsageRollupFile(month)).days[old]?.rows[0]).toMatchObject({
        requests: 2, input: 2400, output: 600,
      })
      expect((await getUsageDayRollups([old], { today: toLocalDateKey(now) })).get(old)?.rows[0]?.requests).toBe(2)
    } finally {
      readSpy.mockRestore()
    }
  })

  test('a completed raw append reported as failed is acknowledged before it can be archived', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const today = toLocalDateKey(Date.now())
    const realAppend = fsPromises.appendFile
    const appendSpy = spyOn(fsPromises, 'appendFile').mockImplementation(async (...args) => {
      await realAppend(...args)
      throw Object.assign(new Error('write failed after a complete line'), { code: 'EIO' })
    })
    try {
      recordUsageEvent({ usage: usage(), model: 'a' })
      await flushUsageEvents()
      // The writer acknowledges the durable ID while holding the lock,
      // rather than requeueing it after pruning has removed the raw IDs.
      expect(appendSpy).toHaveBeenCalledTimes(1)
      const tomorrow = startOfLocalDay(today)
      tomorrow.setDate(tomorrow.getDate() + 1)
      expect(await rollUpAndPruneUsageEvents(tomorrow, { now: tomorrow })).toEqual({ removed: 1 })
      await flushUsageEvents()
      expect((await readUsageRollupFile(today.slice(0, 7))).days[today]?.rows[0]?.requests).toBe(1)
      expect((await readUsageEventsForDay(today)).exists).toBe(false)
    } finally {
      appendSpy.mockRestore()
    }
  })

  test('writes one line per request to the local day file', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    recordUsageEvent({ usage: usage(), model: 'a', querySource: 'compact' })
    recordUsageEvent({ usage: usage(), model: 'b', querySource: 'sdk' })
    await flushUsageEvents()

    const today = toLocalDateKey(Date.now())
    const { events, invalidLines } = await readUsageEventsForDay(today)
    expect(invalidLines).toBe(0)
    expect(events.map(event => [event.model, event.source])).toEqual([
      ['a', 'compact'],
      ['b', 'sdk'],
    ])
    if (process.platform !== 'win32') {
      expect(statSync(getUsageEventsFile(today)).mode & 0o777).toBe(0o600)
    }
  })

  test('keeps events in memory but writes nothing when persistence is off', async () => {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    recordUsageEvent({ usage: usage(), model: 'a' })
    await flushUsageEvents()

    expect(getRecordedUsageEvents()).toHaveLength(1)
    const { events, bytes } = await readUsageEventsForDay(
      toLocalDateKey(Date.now()),
    )
    expect(events).toHaveLength(0)
    expect(bytes).toBe(0)
  })

  test('merges repeated reports for one request into a single event', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    // OpenAI-compatible streams send a finish delta before the usage chunk.
    const empty = usage({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
    recordUsageEvent({ usage: empty, model: 'a', requestKey: 'req-1' })
    recordUsageEvent({ usage: usage(), model: 'a', requestKey: 'req-1' })
    recordUsageEvent({ usage: usage(), model: 'a', requestKey: 'req-2' })

    const recorded = getRecordedUsageEvents()
    expect(recorded).toHaveLength(2)
    expect(recorded[0]).toMatchObject({ input: 1200, output: 300 })
    expect(recorded[0]?.unreported).toBeUndefined()

    await flushUsageEvents()
    const { events } = await readUsageEventsForDay(toLocalDateKey(Date.now()))
    expect(events.map(event => event.id)).toEqual(recorded.map(event => event.id))
    expect(events[0]?.unreported).toBeUndefined()
  })

  test('writes a keyed request to disk once it stops changing', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    recordUsageEvent({ usage: usage(), model: 'a', requestKey: 'req-quiet' })
    const today = toLocalDateKey(Date.now())
    expect((await readUsageEventsForDay(today)).events).toHaveLength(0)

    // Poll instead of sleeping for the settle delay, so a slow runner's
    // disk write does not fail the test.
    const deadline = Date.now() + 10_000
    let written = 0
    while (Date.now() < deadline) {
      written = (await readUsageEventsForDay(today)).events.length
      if (written > 0) break
      await Bun.sleep(100)
    }
    expect(written).toBe(1)
  }, 15_000)

  test('a failed lock release does not append the same events again', async () => {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    const lockSpy = spyOn(lockfile, 'lock').mockResolvedValue(async () => {
      throw new Error('lock compromised')
    })
    try {
      recordUsageEvent({ usage: usage(), model: 'a' })
      await flushUsageEvents()
      await flushUsageEvents()
    } finally {
      lockSpy.mockRestore()
    }

    const file = getUsageEventsFile(toLocalDateKey(Date.now()))
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  test('never throws into the request path', () => {
    expect(() =>
      recordUsageEvent({ usage: null as unknown as Usage, model: 'a' }),
    ).not.toThrow()
  })

  test('two processes appending to the same day keep every line intact', async () => {
    const ledgerPath = join(import.meta.dir, 'ledger.ts')
    const script = join(configDir, 'writer.ts')
    writeFileSync(
      script,
      [
        `import { recordUsageEvent, flushUsageEvents } from ${JSON.stringify(ledgerPath)}`,
        `for (let i = 0; i < 200; i++) {`,
        `  recordUsageEvent({ usage: { input_tokens: i + 1, output_tokens: 1 }, model: process.argv[2] })`,
        `  if (i % 20 === 0) await new Promise(resolve => setTimeout(resolve, 1))`,
        `}`,
        `await flushUsageEvents()`,
      ].join('\n'),
    )
    const env = {
      ...process.env,
      OPENCLAUDE_CONFIG_DIR: configDir,
      TEST_ENABLE_SESSION_PERSISTENCE: '1',
    }
    const writers = ['one', 'two'].map(name =>
      Bun.spawn([process.execPath, script, name], {
        env,
        stdout: 'ignore',
        stderr: 'pipe',
      }),
    )
    const codes = await Promise.all(writers.map(writer => writer.exited))
    expect(codes).toEqual([0, 0])

    const { events, invalidLines } = await readUsageEventsForDay(
      toLocalDateKey(Date.now()),
    )
    expect(invalidLines).toBe(0)
    expect(events.filter(event => event.model === 'one')).toHaveLength(200)
    expect(events.filter(event => event.model === 'two')).toHaveLength(200)
    expect(new Set(events.map(event => event.id)).size).toBe(400)
  }, 60_000)
})

describe('reading the ledger', () => {
  test('skips torn and foreign lines and counts them', async () => {
    const today = toLocalDateKey(Date.now())
    const good = buildUsageEvent({ usage: usage(), model: 'a' })
    await mkdir(getUsageEventsDir(), { recursive: true })
    await appendFile(
      getUsageEventsFile(today),
      [
        JSON.stringify(good),
        '{"v":1,"id":"x","ts":1,"mod',
        JSON.stringify({ v: 2, id: 'future' }),
        '',
      ].join('\n'),
    )

    const { events, invalidLines } = await readUsageEventsForDay(today)
    expect(events.map(event => event.id)).toEqual([good.id])
    expect(invalidLines).toBe(2)
  })

  test('counts a line appended twice only once', async () => {
    const today = toLocalDateKey(Date.now())
    const event = JSON.stringify(buildUsageEvent({ usage: usage(), model: 'a' }))
    await mkdir(getUsageEventsDir(), { recursive: true })
    await appendFile(getUsageEventsFile(today), `${event}\n${event}\n`)

    const { events, invalidLines } = await readUsageEventsForDay(today)
    expect(events).toHaveLength(1)
    expect(invalidLines).toBe(0)
  })

  test('returns an empty day when there is no file', async () => {
    expect(await readUsageEventsForDay('2001-01-01')).toEqual({
      events: [],
      exists: false,
      bytes: 0,
      invalidLines: 0,
    })
  })

  test('parseUsageEventLine rejects negative counts', () => {
    const event = buildUsageEvent({ usage: usage(), model: 'a' })
    expect(parseUsageEventLine(JSON.stringify(event))).not.toBeNull()
    expect(
      parseUsageEventLine(JSON.stringify({ ...event, output: -1 })),
    ).toBeNull()
  })
})
