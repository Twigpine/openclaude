import { afterAll, describe, expect, test } from 'bun:test'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import chalk from 'chalk'
import * as React from 'react'
import {
  WORDMARK_ACCENT_LEFT,
  WORDMARK_ACCENT_RIGHT,
  WORDMARK_CLAUDE,
  WORDMARK_OPEN,
} from '../../constants/brand.js'
import { renderToAnsiString, renderToString } from '../../utils/staticRender.js'
import { WordmarkRow } from './WordmarkRow.js'

// The color-split check reads SGR codes; pin chalk to truecolor so they are
// emitted even though test stdout is not a TTY (precedent: CompanionSprite).
const originalChalkLevel = chalk.level
chalk.level = 3
afterAll(() => {
  chalk.level = originalChalkLevel
})

const FG_COLOR_ESCAPE = /\x1b\[38;2;\d+;\d+;\d+m/g

/** The last truecolor foreground escape emitted before `segment` appears. */
function colorBefore(ansiOutput: string, segment: string): string {
  const idx = ansiOutput.indexOf(segment)
  expect(idx).toBeGreaterThan(-1)
  const escapes = ansiOutput.slice(0, idx).match(FG_COLOR_ESCAPE)
  expect(escapes).not.toBeNull()
  return escapes![escapes!.length - 1]!
}

describe('WordmarkRow', () => {
  test('renders all segments in order on a single row', async () => {
    const out = await renderToString(<WordmarkRow />, 80)
    const plain = stripAnsi(out).trimEnd()
    expect(plain).toBe(
      `${WORDMARK_ACCENT_LEFT} ${WORDMARK_OPEN} ${WORDMARK_CLAUDE} ${WORDMARK_ACCENT_RIGHT}`,
    )
    expect(plain).not.toContain('\n')
  })

  test('left accent + OPEN use the shimmer accent, CLAUDE + right accent the brand accent', async () => {
    const out = (await renderToAnsiString(<WordmarkRow />, 80)).trimEnd()

    const leftAccentColor = colorBefore(out, WORDMARK_ACCENT_LEFT)
    const openColor = colorBefore(out, WORDMARK_OPEN)
    const claudeColor = colorBefore(out, WORDMARK_CLAUDE)
    const rightAccentColor = colorBefore(out, WORDMARK_ACCENT_RIGHT)

    expect(openColor).toBe(leftAccentColor)
    expect(rightAccentColor).toBe(claudeColor)
    expect(claudeColor).not.toBe(leftAccentColor)
  })
})
