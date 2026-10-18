import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, jest, mock, test } from 'bun:test'

import type { ParsedKey } from '../parse-keypress.js'
import { createSelectionState } from '../selection.js'
import { PASTE_START } from '../termio/csi.js'
import App from './App.js'

type FakeStdin = NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof mock>
  ref: ReturnType<typeof mock>
  unref: ReturnType<typeof mock>
  resume: ReturnType<typeof mock>
  pause: ReturnType<typeof mock>
}

function createFakeStdin(): FakeStdin {
  const stdin = new EventEmitter() as unknown as FakeStdin
  stdin.isTTY = true
  stdin.ref = mock(() => stdin)
  stdin.unref = mock(() => stdin)
  stdin.resume = mock(() => stdin)
  stdin.pause = mock(() => stdin)
  stdin.setEncoding = mock(() => stdin) as unknown as FakeStdin['setEncoding']
  stdin.setRawMode = mock(() => stdin)
  return stdin
}

function createFakeStdout(): NodeJS.WriteStream {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  stdout.isTTY = true
  stdout.write = mock(() => true) as unknown as NodeJS.WriteStream['write']
  return stdout
}

function createApp(
  stdin: NodeJS.ReadStream,
  overrides: { dispatchKeyboardEvent?: (parsedKey: ParsedKey) => void } = {},
): App {
  return new App({
    children: null,
    stdin,
    stdout: createFakeStdout(),
    stderr: createFakeStdout(),
    exitOnCtrlC: true,
    onExit: () => {},
    terminalColumns: 80,
    terminalRows: 24,
    selection: createSelectionState(),
    onSelectionChange: () => {},
    onClickAt: () => false,
    onHoverAt: () => {},
    getHyperlinkAt: () => undefined,
    onOpenHyperlink: () => {},
    onMultiClick: () => {},
    onSelectionDrag: () => {},
    dispatchKeyboardEvent: overrides.dispatchKeyboardEvent ?? (() => {}),
  })
}

describe('App stdin mode setup', () => {
  const originalDataMode = process.env.OPENCLAUDE_USE_DATA_STDIN
  const originalReadableMode = process.env.OPENCLAUDE_USE_READABLE_STDIN

  afterEach(() => {
    if (originalDataMode === undefined) {
      delete process.env.OPENCLAUDE_USE_DATA_STDIN
    } else {
      process.env.OPENCLAUDE_USE_DATA_STDIN = originalDataMode
    }
    if (originalReadableMode === undefined) {
      delete process.env.OPENCLAUDE_USE_READABLE_STDIN
    } else {
      process.env.OPENCLAUDE_USE_READABLE_STDIN = originalReadableMode
    }
  })

  test('uses readable stdin by default without switching the stream to flowing mode', () => {
    delete process.env.OPENCLAUDE_USE_DATA_STDIN
    delete process.env.OPENCLAUDE_USE_READABLE_STDIN
    const stdin = createFakeStdin()
    const app = createApp(stdin)

    app.handleSetRawMode(true)

    expect(stdin.listeners('readable')).toContain(app.handleReadable)
    expect(stdin.listeners('data')).not.toContain(app.handleDataChunk)
    expect(stdin.resume).not.toHaveBeenCalled()

    app.handleSetRawMode(false)
  })

  test('resumes stdin only for opt-in data mode', () => {
    process.env.OPENCLAUDE_USE_DATA_STDIN = '1'
    delete process.env.OPENCLAUDE_USE_READABLE_STDIN
    const stdin = createFakeStdin()
    const app = createApp(stdin)

    app.handleSetRawMode(true)

    expect(stdin.listeners('data')).toContain(app.handleDataChunk)
    expect(stdin.listeners('readable')).not.toContain(app.handleReadable)
    expect(stdin.resume).toHaveBeenCalledTimes(1)

    app.handleSetRawMode(false)
  })

  test('uses data mode when OPENCLAUDE_USE_READABLE_STDIN=0', () => {
    delete process.env.OPENCLAUDE_USE_DATA_STDIN
    process.env.OPENCLAUDE_USE_READABLE_STDIN = '0'
    const stdin = createFakeStdin()
    const app = createApp(stdin)

    app.handleSetRawMode(true)

    expect(stdin.listeners('data')).toContain(app.handleDataChunk)
    expect(stdin.listeners('readable')).not.toContain(app.handleReadable)
    expect(stdin.resume).toHaveBeenCalledTimes(1)

    app.handleSetRawMode(false)
  })
})

describe('App incomplete-sequence flush timers', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  function createDispatchCollector(): {
    dispatched: ParsedKey[]
    dispatchKeyboardEvent: (parsedKey: ParsedKey) => void
  } {
    const dispatched: ParsedKey[] = []
    return {
      dispatched,
      dispatchKeyboardEvent: key => {
        dispatched.push(key)
      },
    }
  }

  test('holds a lone Escape, then flushes it exactly at NORMAL_TIMEOUT', () => {
    jest.useFakeTimers()
    const { dispatched, dispatchKeyboardEvent } = createDispatchCollector()
    const app = createApp(createFakeStdin(), { dispatchKeyboardEvent })

    // The bare ESC is buffered, not emitted as an instant Escape keypress.
    app.processInput('\x1b')
    expect(dispatched).toEqual([])

    jest.advanceTimersByTime(app.NORMAL_TIMEOUT - 1)
    expect(dispatched).toEqual([])

    jest.advanceTimersByTime(1)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.name).toBe('escape')
  })

  test('holds an Alt-prefixed half and composes it when the rest arrives before the flush', () => {
    jest.useFakeTimers()
    const { dispatched, dispatchKeyboardEvent } = createDispatchCollector()
    const app = createApp(createFakeStdin(), { dispatchKeyboardEvent })

    app.processInput('\x1b')
    expect(dispatched).toEqual([])

    // Continuation lands inside the hold window: ESC + b composes Alt+b.
    app.processInput('b')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.sequence).toBe('\x1bb')
    expect(dispatched[0]?.meta).toBe(true)

    // The satisfied hold must not leak a phantom Escape when its timer fires.
    jest.advanceTimersByTime(app.NORMAL_TIMEOUT)
    expect(dispatched).toHaveLength(1)
  })

  test('composes a delayed CSI-u chunk that arrives before the flush', () => {
    jest.useFakeTimers()
    const { dispatched, dispatchKeyboardEvent } = createDispatchCollector()
    const app = createApp(createFakeStdin(), { dispatchKeyboardEvent })

    app.processInput('\x1b[98')
    expect(dispatched).toEqual([])

    // IME/CSI-u second half arrives within the hold window: parses as
    // kitty Alt+b instead of garbage after a premature flush (#2018).
    app.processInput(';3u')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.name).toBe('b')
    expect(dispatched[0]?.meta).toBe(true)

    jest.advanceTimersByTime(app.NORMAL_TIMEOUT)
    expect(dispatched).toHaveLength(1)
  })

  test('holds an incomplete bracketed paste past PASTE_TIMEOUT, then flushes it as one paste', () => {
    jest.useFakeTimers()
    const { dispatched, dispatchKeyboardEvent } = createDispatchCollector()
    const app = createApp(createFakeStdin(), { dispatchKeyboardEvent })

    // Paste start + content + truncated CSI tail: tokenizer stays buffered
    // and App stays in paste mode, so nothing is emitted yet.
    app.processInput(`${PASTE_START}hello\x1b[2`)
    expect(dispatched).toEqual([])

    jest.advanceTimersByTime(app.PASTE_TIMEOUT - 1)
    expect(dispatched).toEqual([])

    jest.advanceTimersByTime(1)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.isPasted).toBe(true)
    expect(dispatched[0]?.sequence).toBe('hello\x1b[2')

    // The flush consumed both the paste buffer and the incomplete tail.
    expect(app.keyParseState.incomplete).toBe('')
    expect(app.keyParseState.mode).toBe('NORMAL')
  })
})
