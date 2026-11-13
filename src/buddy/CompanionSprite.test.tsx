import { PassThrough } from 'node:stream'
import { afterAll, expect, mock, test } from 'bun:test'
import chalk from 'chalk'
import React, { useEffect } from 'react'
import { createRoot } from '../ink.js'
import { type Clock, ClockContext } from '../ink/components/ClockContext.js'
import {
  type AppState,
  AppStateProvider,
  getDefaultAppState,
  useSetAppState,
} from '../state/AppState.js'
import { robinhood } from './types.js'

// Deterministic companion fixture (complete-config mock, cache-busted real
// module — see companion.test.ts for the pattern and why).
const actualConfig = await import(`../utils/config.js?real=${Date.now()}`)
mock.module('../utils/config.js', () => ({
  ...actualConfig,
  getGlobalConfig: () => ({
    ...actualConfig.getGlobalConfig(),
    userID: 'sprite-test-user',
    oauthAccount: undefined,
    companionMuted: false,
    companion: {
      name: 'Testbud',
      personality: 'Test personality.',
      hatchedAt: 1,
      speciesOverride: robinhood,
    },
  }),
}))

const { CompanionSprite } = await import('./CompanionSprite.js')

// The fade check reads colors; pin chalk to truecolor so the SGR assertions
// below can never silently pass in a color-stripped environment.
const originalChalkLevel = chalk.level
chalk.level = 3

afterAll(() => {
  chalk.level = originalChalkLevel
  mock.module('../utils/config.js', () => actualConfig)
  mock.restore()
})

const TICK_MS = 500
const FADE_AT_MS = (20 - 6) * TICK_MS // BUBBLE_SHOW - FADE_WINDOW ticks

function createFakeClock(): Clock & { advance: (ms: number) => void } {
  const subscribers = new Set<() => void>()
  let now = 0
  return {
    now: () => now,
    setTickInterval: () => {},
    subscribe(onChange) {
      subscribers.add(onChange)
      return () => subscribers.delete(onChange)
    },
    advance(ms: number) {
      now += ms
      for (const onChange of [...subscribers]) onChange()
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

test('a newly displayed bubble starts at age zero instead of inheriting the previous reaction age', async () => {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & {
    columns: number
    rows: number
  }
  tty.columns = 120
  tty.rows = 40
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const clock = createFakeClock()
  let updateAppState: ReturnType<typeof useSetAppState> | undefined
  function StateController(): null {
    const setAppState = useSetAppState()
    useEffect(() => {
      updateAppState = setAppState
    }, [setAppState])
    return null
  }

  const initialState: AppState = {
    ...getDefaultAppState(),
    companionReaction: 'first words',
  }

  const root = await createRoot({
    stdout: tty,
    patchConsole: false,
  })
  root.render(
    <ClockContext.Provider value={clock}>
      <AppStateProvider initialState={initialState}>
        <CompanionSprite />
        <StateController />
      </AppStateProvider>
    </ClockContext.Provider>,
  )

  try {
    await waitFor(
      () => output.includes('first words') && updateAppState !== undefined,
      'initial bubble render',
    )

    // Fading is observable structurally, independent of the active theme's
    // exact colors: a FRESH bubble draws its border in the species color and
    // its text in a different (dim-blended) color, while a FADING bubble
    // collapses both to the same `inactive` color. Compare the border's
    // foreground SGR with the quip text's.
    const borderAndTextColors = (text: string): [string, string] => {
      const line = output
        .split('\n')
        .reverse()
        .find(l => l.includes(text))
      expect(line, `no rendered line contains "${text}"`).toBeDefined()
      const border = /\x1b\[38;2;(\d+;\d+;\d+)m/.exec(line!)
      const quip = /\x1b\[38;2;(\d+;\d+;\d+)m\x1b\[3m/.exec(line!)
      expect(border, 'bubble border color missing').not.toBeNull()
      expect(quip, 'bubble text color missing').not.toBeNull()
      return [border![1]!, quip![1]!]
    }
    {
      const [border, text] = borderAndTextColors('first words')
      expect(border).not.toBe(text) // fresh: species border, dimmed text
    }

    // Age the first bubble past the fade threshold: it turns inactive.
    output = ''
    clock.advance(FADE_AT_MS + TICK_MS)
    await waitFor(() => output.includes('first words'), 'faded re-render')
    {
      const [border, text] = borderAndTextColors('first words')
      expect(border).toBe(text) // faded: everything inactive
    }

    // Change the reaction WITHOUT advancing the clock. Before the fix, the
    // render still read the previous bubble's age, so the fresh bubble
    // appeared pre-faded; now its age resets to zero synchronously.
    output = ''
    updateAppState!(prev => ({ ...prev, companionReaction: 'second words' }))
    await waitFor(() => output.includes('second words'), 'fresh bubble render')
    {
      const [border, text] = borderAndTextColors('second words')
      expect(border).not.toBe(text) // age reset: fresh styling again
    }
  } finally {
    root.unmount()
  }
})

test('/buddy dance is visible in the line-art fallback, not only in hero art', async () => {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & {
    columns: number
    rows: number
  }
  tty.columns = 120
  tty.rows = 40
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  // Below level 2 the sprite falls back to line art.
  chalk.level = 1
  const clock = createFakeClock()
  let updateAppState: ReturnType<typeof useSetAppState> | undefined
  function StateController(): null {
    const setAppState = useSetAppState()
    useEffect(() => {
      updateAppState = setAppState
    }, [setAppState])
    return null
  }

  const root = await createRoot({ stdout: tty, patchConsole: false })
  root.render(
    <ClockContext.Provider value={clock}>
      <AppStateProvider initialState={getDefaultAppState()}>
        <CompanionSprite />
        <StateController />
      </AppStateProvider>
    </ClockContext.Provider>,
  )

  try {
    await waitFor(
      () => output.includes('Testbud') && updateAppState !== undefined,
      'line-art render',
    )
    expect(output).not.toContain('▀')
    expect(output).not.toContain('♪')

    output = ''
    updateAppState!(prev => ({ ...prev, companionDanceAt: 1 }))
    await waitFor(() => output.includes('♪') || output.includes('♫'), 'dance notes')
  } finally {
    root.unmount()
    chalk.level = 3
  }
})
