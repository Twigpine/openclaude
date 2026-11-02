import { describe, expect, test } from 'bun:test'
import wrapAnsiNpm from 'wrap-ansi'

// The shipped CLI runs on Node, where ./wrapAnsi.ts falls back to the npm
// package; this suite runs on Bun, where it uses Bun.wrapAnsi. Exercise the
// npm package directly so a release that changes its output fails here rather
// than only in the shipped CLI. wrap-ansi 10 expands tabs into spaces, which
// made Cursor throw "Failed to find wrapped line in text" for any tab typed
// into a text input and exited the session.
const OPTIONS = { hard: true, trim: false } as const

const SAMPLES: ReadonlyArray<readonly [string, number]> = [
  ['foo\tbar', 80],
  ['\t\tindented', 80],
  [`${'x'.repeat(78)}\tyy\tzz`, 80],
  ['a\tb c\td e\tf g\th', 8],
  ['\u001b[31mred\tword\u001b[39m tail', 6],
  ['日本\t語の文章です', 6],
  ['plain words wrap here', 7],
]

describe('npm wrap-ansi (the Node runtime path)', () => {
  test('keeps tab characters instead of expanding them', () => {
    expect(wrapAnsiNpm('foo\tbar', 80, OPTIONS)).toBe('foo\tbar')
    expect(wrapAnsiNpm('\t\tindented', 80, OPTIONS)).toBe('\t\tindented')
  })

  test('matches Bun.wrapAnsi, which the Bun-run tests exercise', () => {
    for (const [input, columns] of SAMPLES) {
      expect(wrapAnsiNpm(input, columns, OPTIONS)).toBe(
        Bun.wrapAnsi(input, columns, OPTIONS),
      )
    }
  })
})
