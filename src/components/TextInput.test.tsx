import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { createRoot, type Key } from '../ink.js'
import { useTextInput } from '../hooks/useTextInput.js'
import { useVimInput } from '../hooks/useVimInput.js'
import { AppStateProvider } from '../state/AppState.js'
import type {
  TextInputChangeContext,
  TextInputState,
  VimInputState,
} from '../types/textInputTypes.js'
import {
  canYankPop,
  clearKillRing,
  getKillRingSize,
  maskTextWithVisibleEdges,
  pushToKillRing,
  recordYank,
  resetKillAccumulation,
} from '../utils/Cursor.js'
import { detectModeEntry } from './PromptInput/inputModes.js'
import {
  normalizePromptInputChunk,
  resolveHelpToggleChange,
} from './PromptInput/utils.js'
import TextInput from './TextInput.js'
import VimTextInput from './VimTextInput.js'

const SYNC_START = '\x1B[?2026h'
const SYNC_END = '\x1B[?2026l'

function extractLastFrame(output: string): string {
  let lastFrame: string | null = null
  let cursor = 0

  while (cursor < output.length) {
    const start = output.indexOf(SYNC_START, cursor)
    if (start === -1) {
      break
    }

    const contentStart = start + SYNC_START.length
    const end = output.indexOf(SYNC_END, contentStart)
    if (end === -1) {
      break
    }

    const frame = output.slice(contentStart, end)
    if (frame.trim().length > 0) {
      lastFrame = frame
    }
    cursor = end + SYNC_END.length
  }

  return lastFrame ?? output
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }

  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  return {
    stdout,
    stdin,
    getOutput: () => output,
  }
}

async function waitForOutput(
  getOutput: () => string,
  predicate: (output: string) => boolean,
  timeoutMs = 2500,
): Promise<string> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const output = stripAnsi(extractLastFrame(getOutput()))
    if (predicate(output)) {
      return output
    }
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for TextInput test output')
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2500,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(5)
  }

  throw new Error('Timed out waiting for TextInput state')
}

function DelayedControlledTextInput(): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const valueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const offsetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (valueTimerRef.current) {
        clearTimeout(valueTimerRef.current)
      }
      if (offsetTimerRef.current) {
        clearTimeout(offsetTimerRef.current)
      }
    }
  }, [])

  return (
    <AppStateProvider>
      <TextInput
        value={value}
        onChange={nextValue => {
          if (valueTimerRef.current) {
            clearTimeout(valueTimerRef.current)
          }
          valueTimerRef.current = setTimeout(() => {
            setValue(nextValue)
          }, 200)
        }}
        onSubmit={() => {}}
        placeholder="Type here..."
        columns={60}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={nextOffset => {
          if (offsetTimerRef.current) {
            clearTimeout(offsetTimerRef.current)
          }
          offsetTimerRef.current = setTimeout(() => {
            setCursorOffset(nextOffset)
          }, 200)
        }}
        focus
        showCursor
        multiline
      />
    </AppStateProvider>
  )
}

function DelayedControlledVimTextInput(): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  const valueTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const offsetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    return () => {
      if (valueTimerRef.current) {
        clearTimeout(valueTimerRef.current)
      }
      if (offsetTimerRef.current) {
        clearTimeout(offsetTimerRef.current)
      }
    }
  }, [])

  return (
    <AppStateProvider>
      <VimTextInput
        value={value}
        onChange={nextValue => {
          if (valueTimerRef.current) {
            clearTimeout(valueTimerRef.current)
          }
          valueTimerRef.current = setTimeout(() => {
            setValue(nextValue)
          }, 200)
        }}
        onSubmit={() => {}}
        placeholder="Type here..."
        columns={60}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={nextOffset => {
          if (offsetTimerRef.current) {
            clearTimeout(offsetTimerRef.current)
          }
          offsetTimerRef.current = setTimeout(() => {
            setCursorOffset(nextOffset)
          }, 200)
        }}
        initialMode="INSERT"
        focus
        showCursor
        multiline
      />
    </AppStateProvider>
  )
}

// Regression for #1179: parent strips the leading `!` after entering bash
// mode (numerically: input stays "", cursor stays 0). The local mirror in
// useTextInput must resync to the parent state even though the prop values
// didn't change since lastSeen, otherwise the next keystroke lands beside the
// stale `!` and the buffer shows `!g`, `g!`, or similar instead of `g`.
function BashModeStrippingTextInput(): React.ReactNode {
  const [value, setValue] = React.useState('')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  return (
    <AppStateProvider>
      <TextInput
        value={value}
        onChange={nextValue => {
          // Mimic PromptInput.onChange: when leading `!` arrives at start,
          // strip it back to the empty buffer (mode switches in real code).
          if (nextValue.startsWith('!')) {
            setValue(nextValue.slice(1))
            setCursorOffset(nextValue.length - 1)
            return
          }
          setValue(nextValue)
        }}
        onSubmit={() => {}}
        placeholder="Type here..."
        columns={60}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        focus
        showCursor
        multiline
      />
    </AppStateProvider>
  )
}

test('TextInput resyncs local mirror after parent strips bash-mode `!` from empty input', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(<BashModeStrippingTextInput />)

  await Bun.sleep(50)
  stdin.write('!')
  await Bun.sleep(25)
  stdin.write('g')
  await Bun.sleep(25)
  stdin.write('i')
  await Bun.sleep(25)
  stdin.write('t')
  await Bun.sleep(25)

  const output = stripAnsi(extractLastFrame(getOutput()))

  root.unmount()
  stdin.end()
  stdout.end()
  await Bun.sleep(25)

  expect(output).toContain('git')
  expect(output).not.toContain('!git')
  expect(output).not.toContain('git!')
  expect(output).not.toContain('!')
})

// Regression: when the buffer is non-empty and the cursor is at offset 0,
// typing `!` must prepend `!` to the buffer rather than emit a bare `!`
// onChange (which would clobber the buffer to "").
function PrependBangTextInput(): React.ReactNode {
  const [value, setValue] = React.useState('git status')
  const [cursorOffset, setCursorOffset] = React.useState(0)
  return (
    <AppStateProvider>
      <TextInput
        value={value}
        onChange={nextValue => {
          if (nextValue.startsWith('!')) {
            setValue(nextValue.slice(1))
            setCursorOffset(0)
            return
          }
          setValue(nextValue)
        }}
        onSubmit={() => {}}
        placeholder="Type here..."
        columns={60}
        cursorOffset={cursorOffset}
        onChangeCursorOffset={setCursorOffset}
        focus
        showCursor
        multiline
      />
    </AppStateProvider>
  )
}

test('TextInput prepends `!` to existing buffer when cursor is at offset 0', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(<PrependBangTextInput />)

  await Bun.sleep(50)
  stdin.write('!')
  await Bun.sleep(25)

  const output = stripAnsi(extractLastFrame(getOutput()))

  root.unmount()
  stdin.end()
  stdout.end()
  await Bun.sleep(25)

  expect(output).toContain('git status')
  expect(output).not.toMatch(/^!\s*$/m)
})

test('TextInput renders typed characters before delayed parent value commits', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(<DelayedControlledTextInput />)

  await waitForOutput(getOutput, output => output.includes('Type here...'))
  stdin.write('a')
  stdin.write('b')

  const output = await waitForOutput(
    getOutput,
    frame => frame.includes('ab') && !frame.includes('Type here...'),
  )

  root.unmount()
  stdin.end()
  stdout.end()

  expect(output).toContain('ab')
  expect(output).not.toContain('Type here...')
})

test('maskTextWithVisibleEdges preserves only the first and last three chars', () => {
  expect(maskTextWithVisibleEdges('sk-secret-12345678', '*')).toBe(
    'sk-************678',
  )
  expect(maskTextWithVisibleEdges('abcdef', '*')).toBe('******')
})

test('VimTextInput preserves rapid typed characters before delayed parent value commits', async () => {
  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(<DelayedControlledVimTextInput />)

  await waitForOutput(getOutput, output => output.includes('Type here...'))
  stdin.write('a')
  stdin.write('s')
  stdin.write('d')
  stdin.write('f')

  const output = await waitForOutput(
    getOutput,
    frame => frame.includes('asdf') && !frame.includes('Type here...'),
  )

  root.unmount()
  stdin.end()
  stdout.end()

  expect(output).toContain('asdf')
  expect(output).not.toContain('Type here...')
})

type InputScenarioOptions = {
  initialValue: string
  chunk: string
  cursorOffset?: number
  inputFilter?: React.ComponentProps<typeof TextInput>['inputFilter']
}

async function runInputScenario({
  initialValue,
  chunk,
  cursorOffset = initialValue.length,
  inputFilter,
}: InputScenarioOptions): Promise<{
  value: string
  cursorOffset: number
  changes: string[]
  submissions: string[]
}> {
  let observedValue = initialValue
  let observedCursorOffset = cursorOffset
  let receivedInputCount = 0
  const changes: string[] = []
  const submissions: string[] = []

  function ScenarioTextInput(): React.ReactNode {
    const [value, setValue] = React.useState(initialValue)
    const [offset, setOffsetState] = React.useState(cursorOffset)
    const setOffset = (nextOffset: number): void => {
      observedCursorOffset = nextOffset
      setOffsetState(nextOffset)
    }

    return (
      <AppStateProvider>
        <TextInput
          value={value}
          onChange={nextValue => {
            observedValue = nextValue
            changes.push(nextValue)
            setValue(nextValue)
          }}
          onSubmit={nextValue => submissions.push(nextValue)}
          placeholder="Type here..."
          columns={60}
          cursorOffset={offset}
          onChangeCursorOffset={setOffset}
          inputFilter={(nextInput, key) => {
            receivedInputCount++
            return inputFilter ? inputFilter(nextInput, key) : nextInput
          }}
          focus
          showCursor
          multiline
        />
      </AppStateProvider>
    )
  }

  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(<ScenarioTextInput />)
    await waitForOutput(
      getOutput,
      output =>
        initialValue.length > 0
          ? output.includes(initialValue)
          : output.includes('Type here...'),
    )
    const previousInputCount = receivedInputCount
    stdin.write(chunk)
    await waitFor(() => receivedInputCount > previousInputCount)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }

  return {
    value: observedValue,
    cursorOffset: observedCursorOffset,
    changes,
    submissions,
  }
}

async function runPromptModeScenario({
  initialValue,
  chunk,
}: {
  initialValue: string
  chunk: string
}): Promise<{
  mode: string
  value: string
  cursorOffset: number
  rawSubmissions: string[]
  submissions: Array<{ value: string; mode: string }>
}> {
  let observedMode = 'prompt'
  let observedValue = initialValue
  let observedCursorOffset = initialValue.length
  let receivedInputCount = 0
  const rawSubmissions: string[] = []
  const submissions: Array<{ value: string; mode: string }> = []

  function PromptModeTextInput(): React.ReactNode {
    const [value, setValue] = React.useState(initialValue)
    const [offset, setOffsetState] = React.useState(initialValue.length)
    const [mode, setMode] = React.useState('prompt')
    const pendingSubmitModeRef = React.useRef<
      ReturnType<typeof detectModeEntry>
    >(null)
    const setOffset = (nextOffset: number): void => {
      observedCursorOffset = nextOffset
      setOffsetState(nextOffset)
    }

    const handleChange = (
      nextValue: string,
      context?: TextInputChangeContext,
    ): void => {
      const modeEntry = detectModeEntry({
        value: nextValue,
        prevInputLength: context?.previousValue.length ?? value.length,
        cursorOffset: context?.cursorOffset ?? offset,
      })
      if (modeEntry) {
        pendingSubmitModeRef.current = context?.willSubmit ? modeEntry : null
        observedMode = modeEntry.mode
        observedValue = modeEntry.strippedValue
        setMode(modeEntry.mode)
        setValue(modeEntry.strippedValue)
        setOffset(modeEntry.strippedValue.length)
        return
      }

      pendingSubmitModeRef.current = null
      observedValue = nextValue
      setValue(nextValue)
    }

    return (
      <AppStateProvider>
        <TextInput
          value={value}
          onChange={handleChange}
          onSubmit={nextValue => {
            rawSubmissions.push(nextValue)
            const pendingMode = pendingSubmitModeRef.current
            pendingSubmitModeRef.current = null
            submissions.push({
              value: pendingMode?.strippedValue ?? nextValue,
              mode: pendingMode?.mode ?? mode,
            })
          }}
          placeholder="Type here..."
          columns={60}
          cursorOffset={offset}
          onChangeCursorOffset={setOffset}
          inputFilter={nextInput => {
            receivedInputCount++
            return nextInput
          }}
          focus
          showCursor
          multiline
        />
      </AppStateProvider>
    )
  }

  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(<PromptModeTextInput />)
    await waitForOutput(
      getOutput,
      output =>
        initialValue.length > 0
          ? output.includes(initialValue)
          : output.includes('Type here...'),
    )
    const previousInputCount = receivedInputCount
    stdin.write(chunk)
    await waitFor(() => receivedInputCount > previousInputCount)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }

  return {
    mode: observedMode,
    value: observedValue,
    cursorOffset: observedCursorOffset,
    rawSubmissions,
    submissions,
  }
}

test('TextInput preserves replacement text coalesced after raw DEL', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7fă',
  })

  expect(result.value).toBe('ă')
})

test('TextInput applies text and multiple raw DEL bytes in source order', async () => {
  const result = await runInputScenario({
    initialValue: 'abc',
    chunk: 'xy\x7f\x7fă',
  })

  expect(result.value).toBe('abcă')
})

test('TextInput honors a filter that removes raw DEL', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7fă',
    inputFilter: input => input.replaceAll('\x7f', ''),
  })

  expect(result.value).toBe('aă')
})

test('TextInput honors a filter that changes replacement text', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7fă',
    inputFilter: input => input.replace('ă', 'ș'),
  })

  expect(result.value).toBe('ș')
})

test('TextInput keeps the cursor aligned after filtering a coalesced tab', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7f\tfoo',
    inputFilter: (input, key) => normalizePromptInputChunk(input, key, false),
  })

  expect(result.value).toBe('    foo')
  expect(result.cursorOffset).toBe(7)
})

test('TextInput restores state and suppresses submission for coalesced help', async () => {
  let observedValue = 'a'
  let observedCursorOffset = 1
  let helpToggleCount = 0
  let receivedInputCount = 0
  const submissions: string[] = []

  function HelpToggleTextInput(): React.ReactNode {
    const [value, setValue] = React.useState('a')
    const [offset, setOffsetState] = React.useState(1)
    const suppressNextSubmitRef = React.useRef(false)
    const setOffset = (nextOffset: number): void => {
      observedCursorOffset = nextOffset
      setOffsetState(nextOffset)
    }

    return (
      <AppStateProvider>
        <TextInput
          value={value}
          onChange={(nextValue, context) => {
            const helpToggleChange = resolveHelpToggleChange(nextValue, context)
            if (helpToggleChange) {
              helpToggleCount++
              suppressNextSubmitRef.current = helpToggleChange.suppressSubmit
              if (helpToggleChange.restore) {
                observedValue = helpToggleChange.restore.value
                setValue(helpToggleChange.restore.value)
                setOffset(helpToggleChange.restore.cursorOffset)
              }
              return
            }
            observedValue = nextValue
            setValue(nextValue)
          }}
          onSubmit={nextValue => {
            if (suppressNextSubmitRef.current) {
              suppressNextSubmitRef.current = false
              return
            }
            submissions.push(nextValue)
          }}
          placeholder="Type here..."
          columns={60}
          cursorOffset={offset}
          onChangeCursorOffset={setOffset}
          inputFilter={input => {
            receivedInputCount++
            return input
          }}
          focus
          showCursor
          multiline
        />
      </AppStateProvider>
    )
  }

  const { stdout, stdin, getOutput } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(<HelpToggleTextInput />)
    await waitForOutput(getOutput, output => output.includes('a'))
    const previousInputCount = receivedInputCount
    stdin.write('\x7f?\r')
    await waitFor(
      () =>
        receivedInputCount > previousInputCount && helpToggleCount === 1,
    )
    await Bun.sleep(25)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }

  expect(observedValue).toBe('')
  expect(observedCursorOffset).toBe(0)
  expect(helpToggleCount).toBe(1)
  expect(submissions).toEqual([])
})

test('TextInput honors a filter that rejects the complete chunk', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7fă',
    inputFilter: () => '',
  })

  expect(result.value).toBe('a')
  expect(result.changes).toEqual([])
})

test('TextInput submits the final value for raw DEL plus trailing CR', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7f\r',
  })

  expect(result.value).toBe('')
  expect(result.submissions).toEqual([''])
})

test('TextInput submits replacement text after raw DEL plus trailing CR', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7fă\r',
  })

  expect(result.value).toBe('ă')
  expect(result.submissions).toEqual(['ă'])
})

test('TextInput preserves embedded CR semantics across a raw DEL boundary', async () => {
  const result = await runInputScenario({
    initialValue: '',
    chunk: 'a\r\x7fb',
  })

  expect(result.value).toBe('ab')
  expect(result.submissions).toEqual([])
})

test('TextInput preserves backslash plus CR semantics after raw DEL', async () => {
  const result = await runInputScenario({
    initialValue: 'a',
    chunk: '\x7f\\\r',
  })

  expect(result.value).toBe('\\\n')
  expect(result.submissions).toEqual([])
})

test('TextInput preserves ordinary coalesced Enter behavior', async () => {
  const result = await runInputScenario({ initialValue: '', chunk: 'o\r' })

  expect(result.value).toBe('o')
  expect(result.submissions).toEqual(['o'])
})

test('TextInput preserves lone carriage-return submission', async () => {
  const result = await runInputScenario({ initialValue: 'a', chunk: '\r' })

  expect(result.value).toBe('a')
  expect(result.submissions).toEqual(['a'])
})

test('TextInput preserves mode entry plus coalesced Enter submission', async () => {
  const result = await runPromptModeScenario({
    initialValue: '',
    chunk: '!\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('')
  expect(result.cursorOffset).toBe(0)
  expect(result.submissions).toEqual([{ value: '', mode: 'bash' }])
})

test('TextInput enters bash mode after DEL removes the last character', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'a',
    chunk: '\x7f!',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('')
})

test('TextInput submits fully transformed DEL plus mode text plus CR', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'a',
    chunk: '\x7f!\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('')
  expect(result.submissions).toEqual([{ value: '', mode: 'bash' }])
})

test('TextInput carries DEL-coalesced bash text into submission mode', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'a',
    chunk: '\x7f!ls\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('ls')
  expect(result.cursorOffset).toBe(2)
  expect(result.submissions).toEqual([{ value: 'ls', mode: 'bash' }])
})

test('TextInput keeps later keys in one stdin batch on the stripped mode value', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'a',
    chunk: '\x7f!ls\x1b[Dx',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('lxs')
  expect(result.cursorOffset).toBe(2)
})

test('TextInput retains mode entry across later edits in one submitted chunk', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'a',
    chunk: '\x7f!x\x7fy\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('y')
  expect(result.submissions).toEqual([{ value: 'y', mode: 'bash' }])
})

test('TextInput retains mode after a later DEL consumes its sentinel', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'b',
    chunk: '\x7f!\x7fa\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('a')
  expect(result.rawSubmissions).toEqual(['a'])
  expect(result.submissions).toEqual([{ value: 'a', mode: 'bash' }])
})

test('TextInput preserves a literal mode character typed after consuming the sentinel', async () => {
  const result = await runPromptModeScenario({
    initialValue: 'b',
    chunk: '\x7f!\x7f!a\r',
  })

  expect(result.mode).toBe('bash')
  expect(result.value).toBe('!a')
  expect(result.rawSubmissions).toEqual(['!a'])
  expect(result.submissions).toEqual([{ value: '!a', mode: 'bash' }])
})

test('useTextInput notifies mode entry when one raw chunk returns to the initial cursor', async () => {
  let inputState: TextInputState | undefined
  let observedMode = 'prompt'
  const submissions: Array<{ value: string; mode: string }> = []

  function EqualCursorModeInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)
    const [mode, setMode] = React.useState('prompt')
    const pendingSubmitModeRef = React.useRef<
      ReturnType<typeof detectModeEntry>
    >(null)

    inputState = useTextInput({
      value,
      onChange: (nextValue, context) => {
        const modeEntry = detectModeEntry({
          value: nextValue,
          prevInputLength: context?.previousValue.length ?? value.length,
          cursorOffset: context?.cursorOffset ?? cursorOffset,
        })
        if (modeEntry) {
          pendingSubmitModeRef.current = context?.willSubmit
            ? modeEntry
            : null
          observedMode = modeEntry.mode
          setMode(modeEntry.mode)
          setValue(modeEntry.strippedValue)
          setCursorOffset(modeEntry.strippedValue.length)
          return
        }
        setValue(nextValue)
      },
      onSubmit: nextValue => {
        const pendingMode = pendingSubmitModeRef.current
        submissions.push({
          value: pendingMode?.strippedValue ?? nextValue,
          mode: pendingMode?.mode ?? mode,
        })
      },
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 60,
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <EqualCursorModeInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('!\x7f\r', {} as Key)
    await waitFor(() => submissions.length === 1)

    expect(observedMode).toBe('bash')
    expect(submissions).toEqual([{ value: '', mode: 'bash' }])
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('TextInput leaves ordinary Backspace and Delete key events unchanged', async () => {
  const backspace = await runInputScenario({
    initialValue: 'abc',
    chunk: '\x7f',
  })
  const del = await runInputScenario({
    initialValue: 'abc',
    cursorOffset: 1,
    chunk: '\x1b[3~',
  })

  expect(backspace.value).toBe('ab')
  expect(del.value).toBe('ac')
})

describe('raw DEL kill and yank state', () => {
  beforeEach(clearKillRing)
  afterEach(clearKillRing)

  test('TextInput resets kill accumulation once for a raw DEL event', async () => {
    pushToKillRing('first')

    await runInputScenario({ initialValue: 'a', chunk: '\x7fă' })
    pushToKillRing('second')

    expect(getKillRingSize()).toBe(2)
  })

  test('TextInput resets yank-pop state for a raw DEL event', async () => {
    pushToKillRing('first')
    resetKillAccumulation()
    pushToKillRing('second')
    recordYank(0, 'second'.length)
    expect(canYankPop()).toBe(true)

    await runInputScenario({ initialValue: 'a', chunk: '\x7fă' })

    expect(canYankPop()).toBe(false)
  })
})

test('VimTextInput dot-repeat does not record a raw DEL byte', async () => {
  let observedValue = ''
  let inputState: VimInputState | undefined

  function RawDelVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
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
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <RawDelVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('a', {} as Key)
    await waitFor(() => observedValue === 'a')
    inputState!.onInput('\x7fb', {} as Key)
    await waitFor(() => observedValue === 'b')
    inputState!.onInput('', { escape: true } as Key)
    inputState!.onInput('.', {} as Key)
    await waitFor(() => observedValue === 'bb')

    expect(observedValue).toBe('bb')
    expect(observedValue).not.toContain('\x7f')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('VimTextInput dot-repeat does not record a post-DEL mode sentinel', async () => {
  let observedMode = 'prompt'
  let observedValue = ''
  let inputState: VimInputState | undefined

  function RawDelModeVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
      value,
      onChange: (nextValue, context?: TextInputChangeContext) => {
        const modeEntry = detectModeEntry({
          value: nextValue,
          prevInputLength: context?.previousValue.length ?? value.length,
          cursorOffset: context?.cursorOffset ?? cursorOffset,
        })
        if (modeEntry) {
          observedMode = modeEntry.mode
          observedValue = modeEntry.strippedValue
          setValue(modeEntry.strippedValue)
          setCursorOffset(modeEntry.strippedValue.length)
          return
        }

        observedValue = nextValue
        setValue(nextValue)
      },
      onSubmit: () => {},
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 60,
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <RawDelModeVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('a', {} as Key)
    await waitFor(() => observedValue === 'a')
    inputState!.onInput('\x7f!ls', {} as Key)
    await waitFor(() => observedMode === 'bash' && observedValue === 'ls')
    inputState!.onInput('', { escape: true } as Key)
    inputState!.onInput('.', {} as Key)
    await waitFor(() => observedValue === 'llss')

    expect(observedMode).toBe('bash')
    expect(observedValue).toBe('llss')
    expect(observedValue).not.toContain('!')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('VimTextInput dot-repeat excludes a mode sentinel entered before raw DEL', async () => {
  let observedMode = 'prompt'
  let observedValue = ''
  let inputState: VimInputState | undefined

  function OrdinaryModeThenDelVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
      value,
      onChange: (nextValue, context?: TextInputChangeContext) => {
        const modeEntry = detectModeEntry({
          value: nextValue,
          prevInputLength: context?.previousValue.length ?? value.length,
          cursorOffset: context?.cursorOffset ?? cursorOffset,
        })
        if (modeEntry) {
          observedMode = modeEntry.mode
          observedValue = modeEntry.strippedValue
          setValue(modeEntry.strippedValue)
          setCursorOffset(modeEntry.strippedValue.length)
          return
        }

        observedValue = nextValue
        setValue(nextValue)
      },
      onSubmit: () => {},
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 60,
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <OrdinaryModeThenDelVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('!', {} as Key)
    await waitFor(() => observedMode === 'bash')
    inputState!.onInput('ls', {} as Key)
    await waitFor(() => observedValue === 'ls')
    inputState!.onInput('\x7fb', {} as Key)
    await waitFor(() => observedValue === 'lb')
    inputState!.onInput('', { escape: true } as Key)
    inputState!.onInput('.', {} as Key)
    await waitFor(() => observedValue === 'llbb')

    expect(observedMode).toBe('bash')
    expect(observedValue).toBe('llbb')
    expect(observedValue).not.toContain('!')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('VimTextInput records post-DEL text from the live cursor in one batch', async () => {
  let observedValue = ''
  let inputState: VimInputState | undefined

  function BatchedVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
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
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <BatchedVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('ab', {} as Key)
    inputState!.onInput('', { leftArrow: true } as Key)
    inputState!.onInput('\x7f!', {} as Key)
    inputState!.onInput('', { escape: true } as Key)
    inputState!.onInput('.', {} as Key)
    await waitFor(() => observedValue === 'a!!b')

    expect(observedValue).toBe('a!!b')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('VimTextInput Escape uses the live cursor after same-batch insertion', async () => {
  let inputState: VimInputState | undefined
  let observedOffset = 0

  function BatchedEscapeVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
      value,
      onChange: setValue,
      onSubmit: () => {},
      cursorChar: ' ',
      invert: text => text,
      themeText: text => text,
      columns: 60,
      externalOffset: cursorOffset,
      onOffsetChange: nextOffset => {
        observedOffset = nextOffset
        setCursorOffset(nextOffset)
      },
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <BatchedEscapeVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.onInput('ab', {} as Key)
    inputState!.onInput('', { escape: true } as Key)
    await waitFor(() => observedOffset === 1)

    expect(observedOffset).toBe(1)
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})

test('VimTextInput operators use one live snapshot within a parser batch', async () => {
  let observedValue = 'abc'
  let inputState: VimInputState | undefined

  function BatchedOperatorVimInputHook(): React.ReactNode {
    const [value, setValue] = React.useState('abc')
    const [cursorOffset, setCursorOffset] = React.useState(0)

    inputState = useVimInput({
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
      externalOffset: cursorOffset,
      onOffsetChange: setCursorOffset,
      multiline: true,
    })

    return null
  }

  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  try {
    root.render(
      <AppStateProvider>
        <BatchedOperatorVimInputHook />
      </AppStateProvider>,
    )
    await waitFor(() => inputState !== undefined)
    inputState!.setMode('NORMAL')
    inputState!.onInput('x', {} as Key)
    inputState!.onInput('', { rightArrow: true } as Key)
    inputState!.onInput('x', {} as Key)
    await waitFor(() => observedValue === 'b')

    expect(observedValue).toBe('b')
  } finally {
    root.unmount()
    stdin.end()
    stdout.end()
  }
})
