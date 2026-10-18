import { PassThrough } from 'node:stream'

import { expect, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { AppStateProvider } from '../state/AppState.js'
import { createRoot } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'

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

async function renderFrame(node: React.ReactNode): Promise<string> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider>
      <KeybindingSetup>{node}</KeybindingSetup>
    </AppStateProvider>,
  )

  try {
    return await waitForOutput(
      getOutput,
      output => output.includes('Select login method:') || output.includes('Set up provider'),
    )
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
}

async function waitForOutput(
  getOutput: () => string,
  predicate: (output: string) => boolean,
  timeoutMs = 2500,
): Promise<string> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const output = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(output)) {
      return output
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for ConsoleOAuthFlow test output')
}

test('login picker shows the third-party platform option', async () => {
  const output = await renderFrame(<ConsoleOAuthFlow onDone={() => {}} />)

  expect(output).toContain('Select login method:')
  expect(output).toContain('3rd-party platform')
})

test('third-party provider branch opens the first-run provider manager', async () => {
  const output = await renderFrame(
    <ConsoleOAuthFlow
      initialStatus={{ state: 'platform_setup' }}
      onDone={() => {}}
    />,
  )

  expect(output).toContain('Set up provider')
  // Keep the sentinels near the top of the preset list so adding another
  // provider does not push the assertion outside the 13-row test frame.
  expect(output).toContain('aimlapi.com')
  expect(output).toContain('Anthropic')
  expect(output).toContain('Azure OpenAI')
  expect(output).toContain('Command Code')
  // The Cloudflare Workers AI preset must be offered in the first-run picker
  // (it sorts ahead of DeepSeek, so it is within the visible frame).
  expect(output).toContain('Cloudflare Workers AI')
})
