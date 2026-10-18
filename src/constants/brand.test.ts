import { describe, expect, test } from 'bun:test'
import {
  BRAND_ACCENT_RGB,
  WORDMARK_ACCENT_LEFT,
  WORDMARK_ACCENT_RIGHT,
  WORDMARK_CLAUDE,
  WORDMARK_OPEN,
  WORDMARK_WIDTH,
} from './brand.js'

describe('wordmark', () => {
  test('every segment is a single row', () => {
    for (const segment of [
      WORDMARK_ACCENT_LEFT,
      WORDMARK_OPEN,
      WORDMARK_CLAUDE,
      WORDMARK_ACCENT_RIGHT,
    ]) {
      expect(segment).not.toContain('\n')
      expect(segment.length).toBeGreaterThan(0)
    }
  })

  test('WORDMARK_WIDTH matches the rendered row', () => {
    const row = `${WORDMARK_ACCENT_LEFT} ${WORDMARK_OPEN} ${WORDMARK_CLAUDE} ${WORDMARK_ACCENT_RIGHT}`
    expect(row.length).toBe(WORDMARK_WIDTH)
  })

  test('gradient accents are mirror images of each other', () => {
    expect([...WORDMARK_ACCENT_RIGHT].reverse().join('')).toBe(WORDMARK_ACCENT_LEFT)
  })

  test('row fits the narrowest full-logo panel', () => {
    // The full welcome panel renders at LEFT_PANEL_MAX_WIDTH-ish widths; keep
    // the wordmark comfortably under 40 columns so it never wraps there.
    expect(WORDMARK_WIDTH).toBeLessThanOrEqual(40)
  })
})

describe('brand accent', () => {
  test('stays in rgb() form required by parseRGB consumers', () => {
    expect(BRAND_ACCENT_RGB).toMatch(/^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/)
  })
})
