import { expect, test } from 'bun:test'

import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type ParsedKey,
} from './parse-keypress.ts'
import { InputEvent } from './events/input-event.ts'

function parseInputEvent(sequence: string): InputEvent {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, sequence)

  expect(items).toHaveLength(1)

  const item = items[0]
  expect(item?.kind).toBe('key')

  return new InputEvent(item as ParsedKey)
}

function parseInputEventsFromByteChunks(text: string): InputEvent[] {
  let state = INITIAL_STATE
  const events: InputEvent[] = []

  for (const byte of Buffer.from(text, 'utf8')) {
    const [items, nextState] = parseMultipleKeypresses(
      state,
      Buffer.from([byte]),
    )
    state = nextState

    for (const item of items) {
      expect(item.kind).toBe('key')
      events.push(new InputEvent(item as ParsedKey))
    }
  }

  return events
}

test('treats CSI-u modifier 0 as unmodified printable input', () => {
  const event = parseInputEvent('\x1b[47;0u')

  expect(event.input).toBe('/')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves printable Unicode CSI-u input', () => {
  const event = parseInputEvent('\x1b[231u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves printable Unicode CSI-u input with explicit modifier 0', () => {
  const event = parseInputEvent('\x1b[231;0u')

  expect(event.input).toBe('ç')
  expect(event.key.ctrl).toBe(false)
  expect(event.key.meta).toBe(false)
  expect(event.key.shift).toBe(false)
  expect(event.key.super).toBe(false)
})

test('preserves Vietnamese UTF-8 input split across stdin chunks', () => {
  const events = parseInputEventsFromByteChunks('tiếng Việt')

  expect(events.map(event => event.input).join('')).toBe('tiếng Việt')
  expect(events.some(event => event.input.includes('\uFFFD'))).toBe(false)
})

test('names precomposed Vietnamese characters typed as plain text', () => {
  const event = parseInputEvent('ă')

  expect(event.input).toBe('ă')
  expect(event.keypress.name).toBe('ă')
})

test('composes NFD Vietnamese text into a single precomposed key', () => {
  const event = parseInputEvent('a\u0306')

  expect(event.input).toBe('ă')
  expect(event.input.codePointAt(0)).toBe(0x0103)
  expect(event.keypress.name).toBe('ă')
})

test('names standalone combining marks so they reach input handlers', () => {
  const event = parseInputEvent('\u0306')

  expect(event.input).toBe('\u0306')
  expect(event.keypress.name).toBe('\u0306')
})

test('preserves multi-character Vietnamese words as one input event', () => {
  const [items] = parseMultipleKeypresses(INITIAL_STATE, 'chào')

  expect(items).toHaveLength(1)
  const item = items[0]
  expect(item?.kind).toBe('key')
  expect((item as ParsedKey).sequence).toBe('chào')
})

test('preserves Vietnamese CSI-u input', () => {
  const event = parseInputEvent('\x1b[259u')

  expect(event.input).toBe('ă')
  expect(event.keypress.name).toBe('ă')
})

test('keeps DEL plus replacement intact for downstream coalescing', () => {
  const event = parseInputEvent('\x7fă')

  expect(event.input).toBe('\x7fă')
  expect(event.key.backspace).toBe(false)
})

test('names astral-plane characters typed as plain text', () => {
  // 😀 is one code point but two UTF-16 units; the printable non-ASCII
  // branch must count code points so the key still gets a name.
  const event = parseInputEvent('😀')

  expect(event.input).toBe('😀')
  expect(event.keypress.name).toBe('😀')
})

test('InputEvent names astral sequences that reach it without a name', () => {
  const unnamedAstral: ParsedKey = {
    kind: 'key',
    fn: false,
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: '😀',
    raw: '😀',
    isPasted: false,
  }

  const event = new InputEvent(unnamedAstral)

  expect(event.input).toBe('😀')
  expect(event.keypress.name).toBe('😀')
})
