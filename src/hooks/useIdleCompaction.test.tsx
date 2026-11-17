import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React, { useEffect, useState } from 'react'
import { createRoot } from '../ink.js'
import type { Message } from '../types/message.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'

const savedEnv = {
  minTokens: process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS,
  disableCompact: process.env.DISABLE_COMPACT,
}
const savedIdleCompaction = getGlobalConfig().idleCompaction

function setKnownBaseline(): void {
  saveGlobalConfig(current => ({ ...current, idleCompaction: true }))
  delete process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
  delete process.env.DISABLE_COMPACT
}

function restoreIsolation(): void {
  saveGlobalConfig(current => ({ ...current, idleCompaction: savedIdleCompaction }))
  for (const [key, value] of [
    ['CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS', savedEnv.minTokens],
    ['DISABLE_COMPACT', savedEnv.disableCompact],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const realIdleCompaction = {
  ...(await import(
    `../services/compact/idleCompaction.js?real=${Date.now()}-${Math.random()}`
  )),
}
const IDLE_DELAY_MS = 80
mock.module('../services/compact/idleCompaction.js', () => ({
  ...realIdleCompaction,
  IDLE_COMPACT_DELAY_MS: IDLE_DELAY_MS,
}))
const { useIdleCompaction } = await import(
  `../hooks/useIdleCompaction.ts?test=${Date.now()}-${Math.random()}`
)

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

function makeTty(): NodeJS.WriteStream {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & {
    columns: number
    rows: number
  }
  tty.columns = 120
  tty.rows = 40
  stdout.on('data', () => {})
  return tty
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`)
    }
    await new Promise(r => setTimeout(r, 10))
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms))
}

type Harness = {
  root: Awaited<ReturnType<typeof createRoot>>
  setLoading: (v: boolean) => void
  renders: () => number
}

async function mount(
  initialLoading: boolean,
  onIdle: (messages: readonly Message[]) => Promise<boolean>,
): Promise<Harness> {
  const controls: { setLoading?: (v: boolean) => void } = {}
  let renders = 0
  function Probe(): React.ReactNode {
    const [messages] = useState<Message[]>(() => [userMessage('hello')])
    const [loading, setLoading] = useState(initialLoading)
    useIdleCompaction(messages, loading, onIdle)
    renders++
    useEffect(() => {
      controls.setLoading = setLoading
    }, [])
    return null
  }
  const root = await createRoot({ stdout: makeTty(), patchConsole: false })
  root.render(<Probe />)
  await waitFor(() => controls.setLoading !== undefined, 'mount')
  return {
    root,
    setLoading: v => controls.setLoading!(v),
    renders: () => renders,
  }
}

describe('useIdleCompaction', () => {
  beforeEach(setKnownBaseline)
  afterEach(restoreIsolation)

  test('fires after the idle delay when the session is over the minimum', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const calls: (readonly Message[])[] = []
    const onIdle = mock(async (m: readonly Message[]) => {
      calls.push(m)
      return true
    })
    const { root } = await mount(false, onIdle)
    try {
      await waitFor(() => calls.length === 1, 'idle fire')
      expect(calls[0]![0]!.type).toBe('user')
    } finally {
      root.unmount()
    }
  })

  test('does not arm while a turn is loading', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => true)
    const { root } = await mount(true, onIdle)
    try {
      await settle(IDLE_DELAY_MS * 3)
      expect(onIdle).not.toHaveBeenCalled()
    } finally {
      root.unmount()
    }
  })

  test('a loading flip cancels the pending timer and re-arms after it ends', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => true)
    const { root, setLoading, renders } = await mount(false, onIdle)
    try {
      // Flip to loading before the timer fires; the pending timer is cancelled.
      const before = renders()
      setLoading(true)
      await waitFor(() => renders() > before, 'loading render')
      await settle(IDLE_DELAY_MS * 3)
      expect(onIdle).not.toHaveBeenCalled()
      // Going idle again arms a fresh timer.
      const after = renders()
      setLoading(false)
      await waitFor(() => renders() > after, 'idle render')
      await waitFor(() => onIdle.mock.calls.length === 1, 'idle fire')
    } finally {
      root.unmount()
    }
  })

  test('a successful compaction does not re-arm at the same estimate', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => true)
    const { root, setLoading, renders } = await mount(false, onIdle)
    try {
      await waitFor(() => onIdle.mock.calls.length === 1, 'idle fire')
      const before = renders()
      setLoading(true)
      await waitFor(() => renders() > before, 'loading render')
      const after = renders()
      setLoading(false)
      await waitFor(() => renders() > after, 'idle render')
      await settle(IDLE_DELAY_MS * 3)
      expect(onIdle).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
    }
  })

  test('an unapplied callback does not dedupe the estimate', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => false)
    const { root, setLoading, renders } = await mount(false, onIdle)
    try {
      await waitFor(() => onIdle.mock.calls.length === 1, 'idle fire')
      const before = renders()
      setLoading(true)
      await waitFor(() => renders() > before, 'loading render')
      const after = renders()
      setLoading(false)
      await waitFor(() => renders() > after, 'idle render')
      await waitFor(() => onIdle.mock.calls.length === 2, 'second fire')
    } finally {
      root.unmount()
    }
  })

  test('a rejected callback is logged and does not dedupe the estimate', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => {
      throw new Error('compaction failed')
    })
    const { root, setLoading, renders } = await mount(false, onIdle)
    try {
      await waitFor(() => onIdle.mock.calls.length === 1, 'idle fire')
      await settle(10)
      const before = renders()
      setLoading(true)
      await waitFor(() => renders() > before, 'loading render')
      const after = renders()
      setLoading(false)
      await waitFor(() => renders() > after, 'idle render')
      await waitFor(() => onIdle.mock.calls.length === 2, 'second fire')
    } finally {
      root.unmount()
    }
  })

  test('unmount clears the pending timer', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    const onIdle = mock(async () => true)
    const { root } = await mount(false, onIdle)
    root.unmount()
    await settle(IDLE_DELAY_MS * 3)
    expect(onIdle).not.toHaveBeenCalled()
  })

  test('does not arm when idle compaction is disabled', async () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1'
    saveGlobalConfig(current => ({ ...current, idleCompaction: false }))
    const onIdle = mock(async () => true)
    const { root } = await mount(false, onIdle)
    try {
      await settle(IDLE_DELAY_MS * 3)
      expect(onIdle).not.toHaveBeenCalled()
    } finally {
      root.unmount()
    }
  })
})
