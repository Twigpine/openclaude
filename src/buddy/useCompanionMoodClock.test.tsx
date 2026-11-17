import { PassThrough } from 'node:stream'
import { expect, test } from 'bun:test'
import React, { useEffect, useState } from 'react'
import { createRoot } from '../ink.js'
import { type Clock, ClockContext } from '../ink/components/ClockContext.js'
import {
  BIG_TASK_MS,
  type CompanionActivity,
  type MoodClock,
  resolveMood,
} from './heroMoods.js'
import { useCompanionMoodClock } from './useCompanionMoodClock.js'

function createFakeClock(): Clock & { set: (ms: number) => void } {
  let now = 0
  return {
    now: () => now,
    setTickInterval: () => {},
    subscribe: () => () => {},
    set(ms: number) {
      now = ms
    },
  }
}

async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

const cues = (now: number) => ({
  now,
  shooting: false,
  petting: false,
  dancing: false,
  speaking: false,
  reducedMotion: false,
})

// Mirrors the REPL: the clock hook stays mounted while the sprite it feeds
// is hidden by a permission dialog ('waiting').
test('a long turn interrupted by a permission prompt still ends in a celebration', async () => {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & { columns: number; rows: number }
  tty.columns = 120
  tty.rows = 40
  stdout.on('data', () => {})

  const clock = createFakeClock()
  let setActivity: ((a: CompanionActivity) => void) | undefined
  let latest: MoodClock | undefined
  let renders = 0

  function Probe(): React.ReactNode {
    const [activity, set] = useState<CompanionActivity>('idle')
    const moodClock = useCompanionMoodClock(activity, false)
    latest = moodClock
    renders++
    useEffect(() => {
      setActivity = set
    }, [set])
    return null
  }

  const root = await createRoot({ stdout: tty, patchConsole: false })
  root.render(
    <ClockContext.Provider value={clock}>
      <Probe />
    </ClockContext.Provider>,
  )
  const step = async (ms: number, activity: CompanionActivity) => {
    clock.set(ms)
    const before = renders
    setActivity!(activity)
    await waitFor(() => renders > before && latest?.activity === activity, activity)
  }

  try {
    await waitFor(() => setActivity !== undefined, 'mount')
    await step(1_000, 'working')
    await step(30_000, 'waiting')
    await step(30_000 + BIG_TASK_MS, 'working')
    await step(35_000 + BIG_TASK_MS, 'idle')
    expect(latest!.busySince).toBeNull()
    expect(resolveMood(latest!, cues(35_100 + BIG_TASK_MS))).toBe('celebrate')
  } finally {
    root.unmount()
  }
})
