import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { stringWidth } from '../ink/stringWidth.js'
import sliceAnsi, { sliceAnsiCells } from './sliceAnsi.js'

const BOLD = '\x1b[1m'
const BOLD_OFF = '\x1b[22m'
const RED = '\x1b[31m'
const FG_OFF = '\x1b[39m'
const LINK_OPEN = '\x1b]8;;https://example.com\x1b\\'
const LINK_CLOSE = '\x1b]8;;\x1b\\'

const SAMPLES = [
  'hello world',
  `${BOLD}hello world${BOLD_OFF}`,
  '你好世界',
  `${BOLD}你好世界${BOLD_OFF}`,
  '👨‍👩‍👧‍👦 family',
  '🇮🇳🇺🇸 flags',
  'भारत devanagari',
  'e\u0301\u0301 combining',
]

describe('sliceAnsi', () => {
  test('slices plain text by display cells', () => {
    expect(sliceAnsi('hello world', 0, 5)).toBe('hello')
    expect(sliceAnsi('hello world', 6, 11)).toBe('world')
    expect(sliceAnsi('hello world', 6)).toBe('world')
  })

  test('returns an empty string outside the text', () => {
    expect(sliceAnsi('abc', 10, 12)).toBe('')
    expect(sliceAnsi('abc', 3, 3)).toBe('')
    expect(sliceAnsi('', 0, 4)).toBe('')
  })

  test('an empty range leaks no undo codes from styles it never opened', () => {
    // Regression: the undo sequence used to be appended even when nothing was
    // included, so an empty slice of styled text returned a stray `\x1b[22m`.
    expect(sliceAnsi(`${BOLD}abc${BOLD_OFF}`, 1, 1)).toBe('')
    expect(sliceAnsi(`${BOLD}abc${BOLD_OFF}`, 3, 3)).toBe('')
    expect(sliceAnsi(`${BOLD}abc${BOLD_OFF}`, 10, 12)).toBe('')
    expect(sliceAnsi(`${LINK_OPEN}link${LINK_CLOSE}`, 2, 2)).toBe('')
  })

  test('re-opens styles that are active at the slice start and closes them', () => {
    const out = sliceAnsi(`${RED}abcdef${FG_OFF}`, 2, 4)
    expect(stripAnsi(out)).toBe('cd')
    expect(out.startsWith(RED)).toBe(true)
    expect(out).toMatch(/\x1b\[(?:0|39)m$/)
  })

  test('closes a hyperlink that is open at the slice boundary', () => {
    const out = sliceAnsi(`${LINK_OPEN}link text${LINK_CLOSE}`, 0, 4)
    expect(stripAnsi(out)).toBe('link')
    expect(out).toContain(LINK_OPEN)
    expect(out).toContain(LINK_CLOSE)
  })

  test('keeps combining marks attached to their base character', () => {
    expect(sliceAnsi('e\u0301xyz', 0, 1)).toBe('e\u0301')
  })

  test('includes a boundary-spanning wide glyph by default', () => {
    // Default (partitioning) contract: the glyph is kept whole so that
    // slice(0, k) + slice(k) still reproduces the original text.
    const out = sliceAnsi('你好', 0, 1)
    expect(out).toBe('你')
    expect(stringWidth(out)).toBe(2)
  })

  test('fitEnd never exceeds the requested cell budget', () => {
    for (const text of SAMPLES) {
      const width = stringWidth(text)
      for (let cells = 0; cells <= width; cells++) {
        const out = sliceAnsi(text, 0, cells, { fitEnd: true })
        expect(stringWidth(out)).toBeLessThanOrEqual(cells)
        // The visible text is always a whole-grapheme prefix of the source.
        expect(stripAnsi(text).startsWith(stripAnsi(out))).toBe(true)
      }
    }
  })

  test('fitEnd drops an overflowing wide glyph instead of splitting it', () => {
    expect(sliceAnsi('你好世界', 0, 1, { fitEnd: true })).toBe('')
    expect(sliceAnsi('你好世界', 0, 3, { fitEnd: true })).toBe('你')
  })

  test('adjacent slices reproduce the visible text', () => {
    for (const text of SAMPLES) {
      const width = stringWidth(text)
      for (let k = 0; k <= width; k++) {
        expect(
          stripAnsi(sliceAnsi(text, 0, k)) + stripAnsi(sliceAnsi(text, k)),
        ).toBe(stripAnsi(text))
      }
    }
  })

  test('sliceAnsiCells reports the cells the slice consumed', () => {
    // The tokenizer marks a grapheme carrying VS16 as two cells while
    // stringWidth counts one; the reported width must follow the tokenizer, so
    // a caller that walks the string in chunks stays aligned with what the
    // slice actually consumed instead of duplicating a character.
    const text = '1\uFE0Fabcdefghij'
    const first = sliceAnsiCells(text, 0, 10, { fitEnd: true })
    expect(first.text).toBe('1\uFE0Fabcdefgh')
    expect(first.width).toBe(10)
    expect(stringWidth(first.text)).toBe(9)

    const second = sliceAnsiCells(text, first.width, first.width + 10, {
      fitEnd: true,
    })
    expect(second.text).toBe('ij')
    expect(first.text + second.text).toBe(text)
  })

  test('sliceAnsiCells counts two cells per wide glyph', () => {
    const chunk = sliceAnsiCells('你好', 0, 3, { fitEnd: true })
    expect(chunk.text).toBe('你')
    expect(chunk.width).toBe(2)
  })

  test('sliceAnsiCells reports zero width outside the text', () => {
    expect(sliceAnsiCells('abc', 10, 12)).toEqual({ text: '', width: 0 })
  })
})
