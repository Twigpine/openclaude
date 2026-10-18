import { PassThrough } from 'node:stream'

import { describe, expect, test } from 'bun:test'
import { createElement, useState } from 'react'

import { createRoot, type Key } from '../ink.js'
import { AppStateProvider } from '../state/AppState.js'
import type { TextInputState } from '../types/textInputTypes.js'
import { Cursor } from '../utils/Cursor.js'
import {
  applyCoalescedDelInput,
  applyPrintableInput,
  composeCombiningMark,
  prepareTextInputEvent,
  replacePreviousWithChar,
  useTextInput,
} from './useTextInput.js'

const insert = (cursor: Cursor, text: string): Cursor => cursor.insert(text)

test('applyPrintableInput detects an ANSI-wrapped mode character', () => {
  const notifications: string[] = []
  const result = applyPrintableInput(
    Cursor.fromText('', 80, 0),
    '\x1b[0m!',
    {
      onModeCharacter: text => notifications.push(text),
    },
  )

  expect(result).toBeUndefined()
  expect(notifications).toEqual(['!'])
})

test('applyPrintableInput inserts NFD input fully composed', () => {
  const result = applyPrintableInput(Cursor.fromText('', 80, 0), 'a\u0306')

  expect(result?.text).toBe('ă')
  expect(result?.offset).toBe(1)
})

describe('composeCombiningMark', () => {
  test('composes a standalone breve onto the preceding vowel', () => {
    expect(composeCombiningMark('a', 1, '\u0306')).toEqual({
      text: 'ă',
      offset: 1,
    })
  })

  test('composes sequential IME marks into a single precomposed char', () => {
    // tiếng: e + circumflex → ê, then acute → ế (U+1EBF, one code unit)
    const stepOne = composeCombiningMark('tie', 3, '\u0302')
    expect(stepOne?.text).toBe('tiê')

    const stepTwo = composeCombiningMark(stepOne!.text, stepOne!.offset, '\u0301')
    expect(stepTwo?.text).toBe('tiế')
    expect([...(stepTwo?.text ?? '')].length).toBe(3)
  })

  test('composes mid-text without disturbing trailing characters', () => {
    // Offset 1 = cursor right after the base vowel "a", mirroring real NFD
    // arrival: the mark composes onto the character before the cursor.
    expect(composeCombiningMark('ab c', 1, '\u0306')).toEqual({
      text: 'ăb c',
      offset: 1,
    })
  })

  test('composes a mark outside the old U+0300-U+036F range (Hebrew point)', () => {
    // HEBREW POINT SHEVA (U+05B0, general category Mn) sits outside the
    // previous [\u0300-\u036f] matcher; \p{M} must still compose it.
    expect(composeCombiningMark('בית', 1, '\u05B0')).toEqual({
      text: 'ב\u05B0ית',
      offset: 2,
    })
  })

  test('returns null when nothing precedes the cursor', () => {
    expect(composeCombiningMark('', 0, '\u0306')).toBeNull()
  })

  test('returns null for non-mark input', () => {
    expect(composeCombiningMark('a', 1, 'w')).toBeNull()
  })
})

describe('replacePreviousWithChar', () => {
  test('replaces the previous character with the composed replacement', () => {
    expect(replacePreviousWithChar('xin cha', 7, 'à')).toEqual({
      text: 'xin chà',
      offset: 7,
    })
  })

  test('replaces mid-text preserving surrounding characters', () => {
    expect(replacePreviousWithChar('abc', 2, 'ă')).toEqual({
      text: 'aăc',
      offset: 2,
    })
  })

  test('returns null when nothing precedes the cursor', () => {
    expect(replacePreviousWithChar('a', 0, 'ă')).toBeNull()
  })

  test('ignores ASCII replacements', () => {
    expect(replacePreviousWithChar('a', 1, 'b')).toBeNull()
  })
})

function apply(
  text: string,
  input: string,
  offset = text.length,
): ReturnType<typeof applyCoalescedDelInput> {
  return applyCoalescedDelInput(
    Cursor.fromText(text, 80, offset),
    input,
    insert,
  )
}

describe('applyCoalescedDelInput', () => {
  test('preserves the raw DEL workaround', () => {
    expect(apply('abc', '\x7f').cursor.text).toBe('ab')
  })

  test('treats Ctrl-H backspace bytes like DEL', () => {
    expect(apply('a', '\bă').cursor.text).toBe('ă')
  })

  test('handles mixed DEL and Ctrl-H runs before inserting', () => {
    expect(apply('abc', '\x7f\bă').cursor.text).toBe('aă')
  })

  test('inserts replacement text after DEL', () => {
    expect(apply('a', '\x7fă').cursor.text).toBe('ă')
  })

  test('applies text before and after DEL in source order', () => {
    expect(apply('', 'ab\x7fc').cursor.text).toBe('ac')
  })

  test('applies multiple DEL bytes in source order', () => {
    expect(apply('abc', '\x7f\x7fă').cursor.text).toBe('aă')
  })

  test('preserves text after a middle cursor', () => {
    const result = apply('abXY', '\x7fă', 2)

    expect(result.cursor.text).toBe('aăXY')
    expect(result.cursor.offset).toBe(2)
  })

  test('deletes one complete Unicode grapheme before inserting', () => {
    const graphemes = ['ă', 'a\u0306', '😀', '👨‍👩‍👧‍👦', '🇷🇴', '👍🏽']

    for (const grapheme of graphemes) {
      const initialCursor = Cursor.fromText(`${grapheme}X`, 80)
      const cursorBeforeX = Cursor.fromText(
        initialCursor.text,
        80,
        initialCursor.text.length - 1,
      )
      const result = applyCoalescedDelInput(
        cursorBeforeX,
        '\x7fă',
        insert,
      )

      expect(result.cursor.text).toBe('ăX')
      expect(result.cursor.offset).toBe(1)
    }
  })

  test('prefers token-aware deletion before inserting', () => {
    expect(apply('x [Pasted text #1]', '\x7fă').cursor.text).toBe('x ă')
  })

  test('preserves sequential token and grapheme deletion across a DEL run', () => {
    expect(apply('a [Pasted text #1]', '\x7f\x7f').cursor.text).toBe('a')
  })

  test('bulk DEL runs match repeated token-aware grapheme deletion', () => {
    const cases = [
      { text: 'abc', offset: 3 },
      { text: 'a [Pasted text #1]', offset: 'a [Pasted text #1]'.length },
      { text: 'a [Pasted text #1] X', offset: 'a [Pasted text #1]'.length },
      { text: 'a [Image #1] b', offset: 2 },
      { text: 'a [Image #1] b', offset: 'a [Image #1] '.length },
      {
        text: '👨‍👩‍👧‍👦👍🏽X',
        offset: '👨‍👩‍👧‍👦👍🏽'.length,
      },
      { text: 'a\n\u0301', offset: 2 },
      { text: 'abXY', offset: 2 },
    ]

    for (const testCase of cases) {
      for (let count = 1; count <= 4; count++) {
        let sequential = Cursor.fromText(
          testCase.text,
          80,
          testCase.offset,
        )
        for (let index = 0; index < count; index++) {
          sequential =
            sequential.deleteTokenBefore() ?? sequential.backspace()
        }

        const bulk = Cursor.fromText(
          testCase.text,
          80,
          testCase.offset,
        ).deleteManyBefore(count)
        expect({ text: bulk.text, offset: bulk.offset }).toEqual({
          text: sequential.text,
          offset: sequential.offset,
        })
      }
    }
  })

  test('bulk DEL at offset zero preserves selected image-chip deletion', () => {
    const initial = Cursor.fromText('[Image #1]x', 80, 0)
    const sequential = initial.deleteTokenBefore() ?? initial.backspace()
    const bulk = initial.deleteManyBefore(1)

    expect({ text: bulk.text, offset: bulk.offset }).toEqual({
      text: sequential.text,
      offset: sequential.offset,
    })
  })

  test('reports every deletion in a coalesced DEL run', () => {
    let deletedCount = 0
    applyCoalescedDelInput(
      Cursor.fromText('abc', 80, 3),
      '\x7f\x7f',
      insert,
      count => {
        deletedCount += count
      },
    )

    expect(deletedCount).toBe(2)
  })

  test('preserves a final insertion callback no-commit result', () => {
    const notifications: string[] = []
    const result = applyCoalescedDelInput(
      Cursor.fromText('a', 80, 1),
      '\x7f!',
      (cursor, text) => {
        notifications.push(text)
        return undefined
      },
    )

    expect(result.cursor.text).toBe('')
    expect(result.shouldCommit).toBe(false)
    expect(notifications).toEqual(['!'])
  })

  test('recommits after a DEL that follows a rejected insertion', () => {
    const notifications: string[] = []
    const result = applyCoalescedDelInput(
      Cursor.fromText('', 80, 0),
      '!\x7f',
      (_cursor, text) => {
        notifications.push(text)
        return undefined
      },
    )

    expect(notifications).toEqual(['!'])
    expect(result.cursor.text).toBe('')
    expect(result.shouldCommit).toBe(true)
  })
})

describe('prepareTextInputEvent', () => {
  test('marks text plus one trailing CR as coalesced Enter', () => {
    expect(prepareTextInputEvent('o\r')).toEqual({
      input: 'o',
      shouldSubmit: true,
    })
  })

  test('keeps lone CR as a newline without coalesced submission', () => {
    expect(prepareTextInputEvent('\r')).toEqual({
      input: '\n',
      shouldSubmit: false,
    })
  })

  test('removes a trailing CR adjacent to DEL before sequential editing', () => {
    expect(prepareTextInputEvent('\x7f\r')).toEqual({
      input: '\x7f',
      shouldSubmit: true,
    })
  })

  test('keeps replacement text and removes its coalesced trailing CR', () => {
    expect(prepareTextInputEvent('\x7fă\r')).toEqual({
      input: '\x7fă',
      shouldSubmit: true,
    })
  })

  test('converts a globally embedded CR before a later DEL', () => {
    expect(prepareTextInputEvent('a\r\x7fb')).toEqual({
      input: 'a\n\x7fb',
      shouldSubmit: false,
    })
  })

  test('strips a final CR from embedded multiline paste without submitting', () => {
    expect(prepareTextInputEvent('a\rb\r')).toEqual({
      input: 'a\nb',
      shouldSubmit: false,
    })
  })

  test('preserves backslash plus CR as a newline insertion', () => {
    expect(prepareTextInputEvent('\\\r')).toEqual({
      input: '\\\n',
      shouldSubmit: false,
    })
  })

  test('classifies backslash plus ANSI plus CR by visible text', () => {
    expect(prepareTextInputEvent('\\\x1b[0m\r')).toEqual({
      input: '\\\x1b[0m\n',
      shouldSubmit: false,
    })
  })
})

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2500,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }

  throw new Error('Timed out waiting for useTextInput state')
}

// Renders useTextInput through its public onInput API (same probe pattern
// as components/TextInput.test.tsx) so IME composition paths can be
// exercised end-to-end against user-visible text and cursor outcomes.
async function runOnInputScenario(options: {
  initialValue: string
  input: string
  key?: Partial<Key>
}): Promise<{ value: string; cursorOffset: number }> {
  const { initialValue, input } = options
  const key = options.key ?? {}
  let inputState: TextInputState | undefined
  let observedValue = initialValue
  let observedCursorOffset = initialValue.length

  function ImeProbe(): null {
    const [value, setValue] = useState(initialValue)
    const [offset, setOffset] = useState(initialValue.length)

    inputState = useTextInput({
      value,
      onChange: nextValue => {
        observedValue = nextValue
        setValue(nextValue)
      },
      onSubmit: () => {},
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 60,
      externalOffset: offset,
      onOffsetChange: nextOffset => {
        observedCursorOffset = nextOffset
        setOffset(nextOffset)
      },
      multiline: true,
    })

    return null
  }

  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })

  try {
    root.render(createElement(AppStateProvider, null, createElement(ImeProbe)))
    await waitFor(() => inputState !== undefined)
    inputState!.onInput(input, key as Key)
    await Bun.sleep(25)
  } finally {
    root.unmount()
  }

  return { value: observedValue, cursorOffset: observedCursorOffset }
}

describe('useTextInput IME composition regression (#2018)', () => {
  test('composes a backspace-flagged replacement into user-visible text', async () => {
    // Telex/VNI compose events arrive flagged as backspace while carrying
    // the precomposed replacement character; the visible result is the
    // composed word, not a deleted character plus stray text.
    const result = await runOnInputScenario({
      initialValue: 'xin cha',
      input: 'à',
      key: { backspace: true },
    })

    expect(result.value).toBe('xin chà')
    expect(result.cursorOffset).toBe(7)
  })

  test('composes a delayed standalone combining mark onto its base character', async () => {
    // NFD path: the base vowel commits first and the tone mark arrives
    // later as its own standalone text event.
    const result = await runOnInputScenario({
      initialValue: 'tiê',
      input: '\u0301',
    })

    expect(result.value).toBe('tiế')
    expect(result.cursorOffset).toBe(3)
  })
})
