import { expect, test } from 'bun:test'

import { resolveOutputStyle } from './outputStyles.js'

// `settings.outputStyle` is a free-form `z.string()` with no enum, and the
// style maps are plain object literals, so the name reaches a bare index. The
// resolved value flows into the model-facing system prompt
// (`# Output Style: ${config.name}\n${config.prompt}`) and the output-style
// system reminder, so a non-config must resolve to null rather than be rendered.
const STYLES = {
  default: { name: 'Default', prompt: 'be concise' },
  explanatory: { name: 'Explanatory', prompt: 'explain more' },
}

const PROTO_NAMES = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
]

test('resolves a real style by name', () => {
  expect(resolveOutputStyle(STYLES, 'explanatory')).toEqual({
    name: 'Explanatory',
    prompt: 'explain more',
  })
})

test('returns null for an unconfigured style name', () => {
  expect(resolveOutputStyle(STYLES, 'nonexistent-style')).toBeNull()
})

test('returns null for Object.prototype member names', () => {
  // Before the fix each of these resolved to an inherited member. `?? null`
  // did not neutralize it — the Object constructor is not nullish — so
  // `outputStyle: "constructor"` injected "# Output Style: Object\nundefined"
  // into the system prompt instead of falling back to the default.
  for (const name of PROTO_NAMES) {
    expect(resolveOutputStyle(STYLES, name)).toBeNull()
  }
})

test('returns null for an explicitly null entry', () => {
  // The map type allows null values; those are not usable configs either.
  expect(resolveOutputStyle({ broken: null }, 'broken')).toBeNull()
})
