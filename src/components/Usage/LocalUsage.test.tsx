import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import type {
  LocalUsageRange,
  LocalUsageSummary,
} from '../../services/usage/query.js'
import { enableConfigs } from '../../utils/config.js'
import { LocalUsage } from './LocalUsage.js'

enableConfigs()

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

/** The last non-empty synchronized frame Ink wrote. */
function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0
  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) break
    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) break
    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) lastFrame = frame
    cursor = end + SYNC_END.length
  }
  return stripAnsi(lastFrame ?? output)
}

function createTestStreams() {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: () => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  return { stdout, stdin, frame: () => extractLastFrame(output) }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A summary whose headline token count identifies it. */
function usage(range: LocalUsageRange, tokens: number): LocalUsageSummary {
  return {
    range,
    today: '2026-11-10',
    fromDate: '2026-11-10',
    toDate: '2026-11-10',
    totals: {
      tokens,
      requests: 1,
      unreported: 0,
      sessions: 1,
      input: tokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      webSearch: 0,
    },
    cacheHitRate: null,
    costUSD: 0,
    unpricedModels: [],
    models: [],
    sources: [],
    projects: [],
    daily: [],
    hourly: null,
    comparisonTokens: null,
    firstTrackedDate: '2026-11-10',
    invalidLines: 0,
  }
}

type Load = (range: LocalUsageRange) => Promise<LocalUsageSummary>

async function mount(load: Load) {
  const streams = createTestStreams()
  const root = await createRoot({
    stdout: streams.stdout as unknown as NodeJS.WriteStream,
    stdin: streams.stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(<LocalUsage load={load} />)

  async function waitForFrame(predicate: (frame: string) => boolean) {
    const startedAt = Date.now()
    while (Date.now() - startedAt < 2500) {
      if (predicate(streams.frame())) return
      await Bun.sleep(10)
    }
    throw new Error(`Timed out waiting for local usage output:\n${streams.frame()}`)
  }

  return {
    frame: streams.frame,
    waitForFrame,
    press: (input: string) => streams.stdin.write(input),
    async unmount() {
      root.unmount()
      streams.stdin.end()
      streams.stdout.end()
      await Bun.sleep(0)
    },
  }
}

test('several r presses that arrive together advance one range each', async () => {
  const calls: LocalUsageRange[] = []
  const view = await mount(async range => {
    calls.push(range)
    return usage(range, range === 'all' ? 9_000_000 : 1_000_000)
  })
  try {
    await view.waitForFrame(frame => frame.includes('1m tokens'))
    view.press('rrr')
    await view.waitForFrame(frame => frame.includes('9m tokens'))
    expect(view.frame()).toContain('[all]')
    // The skipped ranges (7d, 30d) are never loaded.
    expect(calls).toEqual(['today', 'all'])
  } finally {
    await view.unmount()
  }
})

test('a range loaded once is served from the cache', async () => {
  const calls: LocalUsageRange[] = []
  const view = await mount(async range => {
    calls.push(range)
    return usage(range, range === 'today' ? 1_000_000 : 7_000_000)
  })
  try {
    await view.waitForFrame(frame => frame.includes('1m tokens'))
    view.press('r')
    await view.waitForFrame(frame => frame.includes('7m tokens'))
    // 7d → 30d → all → session → today
    view.press('rrrr')
    await view.waitForFrame(frame => frame.includes('1m tokens'))
    expect(view.frame()).toContain('[today]')
    expect(calls).toEqual(['today', '7d'])
  } finally {
    await view.unmount()
  }
})

test('a load that finishes after the range changed does not replace the view', async () => {
  const pending = new Map<LocalUsageRange, ReturnType<typeof deferred<LocalUsageSummary>>>()
  const view = await mount(range => {
    const next = deferred<LocalUsageSummary>()
    pending.set(range, next)
    return next.promise
  })
  try {
    await view.waitForFrame(frame => frame.includes('Loading local usage…'))
    view.press('r')
    await view.waitForFrame(frame => frame.includes('[7d]'))
    pending.get('7d')!.resolve(usage('7d', 7_000_000))
    await view.waitForFrame(frame => frame.includes('7m tokens'))

    pending.get('today')!.resolve(usage('today', 1_000_000))
    await Bun.sleep(50)
    expect(view.frame()).not.toContain('1m tokens')
    expect(view.frame()).not.toContain('Loading local usage…')
  } finally {
    await view.unmount()
  }
})

test('a failed load shows the error', async () => {
  const view = await mount(async () => {
    throw new Error('EACCES: permission denied')
  })
  try {
    await view.waitForFrame(frame =>
      frame.includes('Could not read local usage: EACCES: permission denied'),
    )
  } finally {
    await view.unmount()
  }
})
