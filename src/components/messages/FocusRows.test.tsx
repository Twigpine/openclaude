import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { expect, test } from 'bun:test'
import React from 'react'

import { createRoot } from '../../ink.js'
import { isNavigableMessage } from '../messageActions.js'
import { shouldRenderStatically } from '../Messages.js'
import { FocusMarkerMessage } from './FocusMarkerMessage.js'
import { FocusSummaryMessage } from './FocusSummaryMessage.js'

// No keybinding provider is mounted, so the shortcut hook returns its ctrl+o fallback.
async function renderText(node: React.ReactNode): Promise<string> {
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
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  try {
    root.render(node)
    await Bun.sleep(100)
    return stripAnsi(output)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
    await Bun.sleep(0)
  }
}

const marker = { type: 'system', subtype: 'focus_marker', uuid: 'm', hiddenTurns: 2, compacted: false } as never
const summaryRow = {
  type: 'system',
  subtype: 'focus_summary',
  uuid: 's',
  summary: { toolCount: 1, linesAdded: 0, linesRemoved: 0, failed: 0 },
} as never

test('focus_summary renders dynamically and focus_marker statically', () => {
  const lookups = {} as never
  const args = [new Set<string>(), new Set<string>(), new Set<string>()] as const
  expect(shouldRenderStatically(summaryRow, ...args, 'prompt' as never, lookups)).toBe(false)
  expect(shouldRenderStatically(marker, ...args, 'prompt' as never, lookups)).toBe(true)
})

test('neither focus row is navigable', () => {
  expect(isNavigableMessage(marker)).toBe(false)
  expect(isNavigableMessage(summaryRow)).toBe(false)
})

test('marker renders the plural hidden-turns line', async () => {
  const out = await renderText(<FocusMarkerMessage hiddenTurns={2} compacted={false} />)
  expect(out).toContain('2 earlier turns hidden, ctrl+o for transcript, /focus to turn off')
  expect(out).not.toContain('compacted')
})

test('marker renders the singular hidden-turns line', async () => {
  const out = await renderText(<FocusMarkerMessage hiddenTurns={1} compacted={false} />)
  expect(out).toContain('1 earlier turn hidden, ctrl+o for transcript, /focus to turn off')
  expect(out).not.toContain('1 earlier turns')
})

test('compacted marker also renders the compaction notice', async () => {
  const out = await renderText(<FocusMarkerMessage hiddenTurns={3} compacted={true} />)
  expect(out).toContain('3 earlier turns hidden, ctrl+o for transcript, /focus to turn off')
  expect(out).toContain('Conversation compacted (ctrl+o for history)')
})

test('compacted marker with no hidden turns shows only the compaction notice', async () => {
  const out = await renderText(<FocusMarkerMessage hiddenTurns={0} compacted={true} />)
  expect(out).toContain('Conversation compacted (ctrl+o for history)')
  expect(out).not.toContain('earlier turn')
})

test('summary renders tool count, diffstat and failed count', async () => {
  const out = await renderText(
    <FocusSummaryMessage summary={{ toolCount: 4, linesAdded: 12, linesRemoved: 3, failed: 1 }} />,
  )
  expect(out).toContain('4 tool calls, +12/-3, 1 failed')
})

test('summary renders singular tool call with no diffstat and no failed segment', async () => {
  const out = await renderText(
    <FocusSummaryMessage summary={{ toolCount: 1, linesAdded: 0, linesRemoved: 0, failed: 0 }} />,
  )
  expect(out).toContain('1 tool call')
  expect(out).not.toContain('1 tool calls')
  expect(out).not.toContain('+0')
  expect(out).not.toContain('failed')
})
