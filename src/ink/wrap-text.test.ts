import { describe, expect, test } from 'bun:test'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { stringWidth } from './stringWidth.js'
import wrapText from './wrap-text.js'

const WIDE_SAMPLES = [
  'hello world',
  '你好世界',
  '👨‍👩‍👧‍👦 family 👨‍👩‍👧‍👦',
  '🇮🇳🇺🇸 flags',
  'भारत devanagari',
  '\x1b[31mabcdefghij\x1b[39m',
]

const POSITIONS = ['truncate', 'truncate-middle', 'truncate-start'] as const

const hasLoneSurrogate = (text: string): boolean =>
  [...text].some(char => {
    const codePoint = char.codePointAt(0)!
    return codePoint >= 0xd800 && codePoint <= 0xdfff
  })

describe('wrapText truncate', () => {
  test('every truncation position fits the column budget', () => {
    for (const text of WIDE_SAMPLES) {
      for (const position of POSITIONS) {
        for (let columns = 1; columns <= 16; columns++) {
          const out = wrapText(text, columns, position)
          expect(stringWidth(out)).toBeLessThanOrEqual(columns)
          expect(hasLoneSurrogate(out)).toBe(false)
        }
      }
    }
  })

  test('returns the text unchanged when it already fits', () => {
    for (const position of POSITIONS) {
      expect(wrapText('abc', 3, position)).toBe('abc')
      expect(wrapText('abc', 10, position)).toBe('abc')
    }
  })

  test('a zero or negative budget truncates to nothing', () => {
    expect(wrapText('hello', 0, 'truncate')).toBe('')
    expect(wrapText('hello', -3, 'truncate')).toBe('')
  })

  test('a one-column budget is the ellipsis', () => {
    for (const position of POSITIONS) {
      expect(wrapText('hello', 1, position)).toBe('…')
    }
  })

  test('truncate drops a wide glyph rather than overflowing', () => {
    expect(wrapText('你好世界', 3, 'truncate')).toBe('你…')
  })

  test('truncate-middle keeps both edges', () => {
    const out = wrapText('abcdefghij', 6, 'truncate-middle')
    expect(stripAnsi(out)).toBe('abc…ij')
    expect(stringWidth(out)).toBe(6)
  })

  test('truncate-start keeps the tail', () => {
    expect(stripAnsi(wrapText('abcdefghij', 6, 'truncate-start'))).toBe('…fghij')
  })

  test('closes styles it re-opens', () => {
    const out = wrapText('\x1b[31mabcdefghij\x1b[39m', 6, 'truncate')
    expect(stripAnsi(out)).toBe('abcde…')
    expect(out).toMatch(/\x1b\[(?:0|39)m…$/)
  })
})

describe('wrapText wrap', () => {
  test('wraps without splitting wide glyphs', () => {
    const out = wrapText('你好你好', 3, 'wrap')
    const lines = out.split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(3)
    }
    expect(lines.join('')).toBe('你好你好')
  })

  test('wrap-trim trims the wrap points', () => {
    expect(wrapText('aaa bbb', 4, 'wrap-trim').split('\n')).toEqual(['aaa', 'bbb'])
  })
})
