import { PassThrough } from 'node:stream'

import { afterAll, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { createRoot, Text, useTheme } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { ThemeProvider } from './design-system/ThemeProvider.js'

await acquireSharedMutationLock('components/ThemePicker.test.tsx')

mock.module('./StructuredDiff.js', () => ({
  StructuredDiff: function StructuredDiffPreview(): React.ReactNode {
    const [theme] = useTheme()
    return <Text>{`Preview theme: ${theme}`}</Text>
  },
}))

mock.module('./StructuredDiff/colorDiff.js', () => ({
  getColorModuleUnavailableReason: () => 'env',
  getSyntaxTheme: () => null,
}))

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
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

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for ThemePicker test condition')
}

async function waitForFrame(
  getOutput: () => string,
  predicate: (frame: string) => boolean,
): Promise<string> {
  let frame = ''

  await waitForCondition(() => {
    frame = stripAnsi(extractLastFrame(getOutput()))
    return predicate(frame)
  })

  return frame
}

afterAll(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

test('updates the preview when keyboard focus moves to another theme', async () => {
  const { ThemePicker } = await import(`./ThemePicker.js?theme-picker=${Date.now()}-${Math.random()}`)
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <KeybindingSetup>
        <ThemeProvider initialState="dark">
          <ThemePicker onThemeSelect={() => {}} />
        </ThemeProvider>
      </KeybindingSetup>
    </AppStateProvider>,
  )

  try {
    const initialFrame = await waitForFrame(
      getOutput,
      frame => frame.includes('Preview theme: dark'),
    )
    expect(initialFrame).toContain('Preview theme: dark')

    stdin.write('j')

    const updatedFrame = await waitForFrame(
      getOutput,
      frame => frame.includes('Preview theme: light'),
    )
    expect(updatedFrame).toContain('Preview theme: light')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
})
