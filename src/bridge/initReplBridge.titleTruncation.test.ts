import { expect, test } from 'bun:test'

import { deriveTitle } from './initReplBridge.js'

// The bridge derives a session title from the user's first REPL message and
// PATCHes it to the claude.ai backend, where it is JSON-serialized and
// UTF-8-encoded. A raw `.slice(0, N)` cut at a UTF-16 code-unit index can split
// an emoji or astral-plane character's surrogate pair, leaving a lone surrogate
// that goes over the wire as the U+FFFD replacement character.

// A high surrogate not followed by a low one (or a low surrogate not preceded
// by a high one) is an unpaired code unit — exactly what a mid-pair slice
// leaves behind. Written without a lookbehind to match the YARR/JSC constraint
// the source regex in initReplBridge.ts documents.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/

test('never emits a lone surrogate when truncating on an emoji boundary', () => {
  // The 😀 (U+1F600, a surrogate pair) sits exactly where a 50-char slice would
  // cut, so a raw slice keeps its high surrogate and drops the low one.
  const raw = 'a'.repeat(48) + '😀😀😀 fix the login bug'
  const title = deriveTitle(raw)!

  expect(LONE_SURROGATE.test(title)).toBe(false)
  // Round-tripping through UTF-8 (what axios sends) must not introduce U+FFFD.
  expect(Buffer.from(title, 'utf8').toString('utf8')).not.toContain('�')
})

test('truncates long single-line titles with an ellipsis', () => {
  const title = deriveTitle('x'.repeat(200))!
  expect(title.endsWith('…')).toBe(true)
  expect(title.length).toBeLessThanOrEqual(50)
})

test('bounds the title in characters, not terminal columns', () => {
  // TITLE_MAX_LEN caps the session-title API field in characters. A
  // display-width measure charges 2 columns per wide glyph, so 30 CJK
  // characters — comfortably inside the 50-char field — would be cut to 24
  // plus an ellipsis and lose content.
  const cjk = deriveTitle('你'.repeat(30))!
  expect(cjk).toBe('你'.repeat(30))
  expect(cjk.endsWith('…')).toBe(false)
})

test('still bounds input whose display width is zero', () => {
  // The mirror failure: zero-width graphemes cost 0 columns, so a width-based
  // cap never triggers and the full payload is PATCHed as the title.
  const title = deriveTitle('​'.repeat(100_000))!
  expect(title.length).toBeLessThanOrEqual(50)
})

test('keeps a short title unchanged', () => {
  expect(deriveTitle('fix the login bug')).toBe('fix the login bug')
})

test('returns undefined for a pure-tag / empty message', () => {
  expect(deriveTitle('')).toBeUndefined()
})

test('collapses whitespace into a single-line title', () => {
  expect(deriveTitle('fix\n\tthe   login\nbug')).toBe('fix the login bug')
})
