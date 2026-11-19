import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { stringWidth } from '../ink/stringWidth.js'
import { isOutputLineTruncated, renderTruncatedContent } from './terminal.js'

// renderTruncatedContent reserves PADDING_TO_PREVENT_OVERFLOW (10) cells.
const WRAP_WIDTH_FOR = (terminalWidth: number) => Math.max(terminalWidth - 10, 10)

const visibleLines = (rendered: string, wrapWidth: number): string[] =>
  stripAnsi(rendered)
    .split('\n')
    .filter(line => !line.startsWith('…') && line.length <= wrapWidth)

describe('renderTruncatedContent wrapping', () => {
  test('keeps long ASCII lines within the wrap width', () => {
    const wrapWidth = WRAP_WIDTH_FOR(40)
    const rendered = renderTruncatedContent('x'.repeat(200), 40, true)
    for (const line of rendered.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(wrapWidth)
    }
  })

  test('keeps every wide glyph exactly once when a line wraps', () => {
    // 41 cells: four of the ten 30-cell-padded chunks land on a wide glyph.
    const text = `a${'你'.repeat(20)}`
    const wrapWidth = WRAP_WIDTH_FOR(40)
    const rendered = renderTruncatedContent(text, 40, true)
    const lines = rendered.split('\n')

    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(wrapWidth)
    }
    // Regression: the old loop advanced by a fixed stride, so a glyph that
    // straddled the boundary was dropped from one chunk and lost entirely.
    expect(visibleLines(rendered, wrapWidth).join('')).toBe(text)
  })

  test('does not duplicate glyphs across chunk boundaries', () => {
    const text = '你'.repeat(30)
    const wrapWidth = WRAP_WIDTH_FOR(40)
    const rendered = renderTruncatedContent(text, 40, true)
    expect(visibleLines(rendered, wrapWidth).join('')).toBe('你'.repeat(15 + 15))
  })

  test('does not duplicate a character when the tokenizer counts a grapheme fuller than stringWidth', () => {
    // '1' + VS16 is one cell for stringWidth but two for the tokenizer. The
    // cursor used to advance by the measured chunk (9 cells), so the next chunk
    // started one character early and repeated 'h'.
    const text = '1\uFE0Fabcdefghij'
    const wrapWidth = WRAP_WIDTH_FOR(20)
    const rendered = renderTruncatedContent(text, 20, true)

    for (const line of rendered.split('\n')) {
      expect(stringWidth(line)).toBeLessThanOrEqual(wrapWidth)
    }
    expect(visibleLines(rendered, wrapWidth).join('')).toBe(text)
  })

  test('stays within the line budget and reports the remainder', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line-${i}`).join('\n')
    const rendered = renderTruncatedContent(text, 80, true)
    const lines = rendered.split('\n')
    expect(lines.length).toBe(4)
    expect(lines.at(-1)).toMatch(/^… \+\d+ lines$/)
  })

  test('returns an empty string for blank content', () => {
    expect(renderTruncatedContent('   \n\n', 80)).toBe('')
  })
})

describe('isOutputLineTruncated', () => {
  test('detects content past the visible line budget only', () => {
    expect(isOutputLineTruncated('one\ntwo\nthree')).toBe(false)
    expect(isOutputLineTruncated('1\n2\n3\n4\n5')).toBe(true)
    // A trailing newline is a terminator, not an extra line.
    expect(isOutputLineTruncated('1\n2\n3\n4\n')).toBe(false)
  })
})
