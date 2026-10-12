import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { createRoot } from '../ink.js'
import { DEFAULT_BINDINGS } from '../keybindings/defaultBindings.js'
import { KeybindingProvider } from '../keybindings/KeybindingContext.js'
import { parseBindings } from '../keybindings/parser.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../keybindings/types.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { DeleteSessionConfirm } from './DeleteSessionConfirm.js'

const sessionId = '550e8400-e29b-41d4-a716-446655440000'

function createTestStreams() {
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
  return { stdout, stdin, getOutput: () => output }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for DeleteSessionConfirm render test')
}

function TestKeybindingProvider({
  children,
}: {
  children: React.ReactNode
}): React.ReactNode {
  const bindings = React.useMemo(() => parseBindings(DEFAULT_BINDINGS), [])
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = React.useState<
    ParsedKeystroke[] | null
  >(null)
  const activeContextsRef = React.useRef<Set<KeybindingContextName>>(new Set())
  const handlerRegistryRef = React.useRef(
    new Map<
      string,
      Set<{
        action: string
        context: KeybindingContextName
        handler: () => void
      }>
    >(),
  )
  const setPendingChord = React.useCallback(
    (pending: ParsedKeystroke[] | null) => {
      pendingChordRef.current = pending
      setPendingChordState(pending)
    },
    [],
  )
  const registerActiveContext = React.useCallback(
    (context: KeybindingContextName) => {
      activeContextsRef.current.add(context)
    },
    [],
  )
  const unregisterActiveContext = React.useCallback(
    (context: KeybindingContextName) => {
      activeContextsRef.current.delete(context)
    },
    [],
  )
  return (
    <KeybindingProvider
      bindings={bindings}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContextsRef.current}
      registerActiveContext={registerActiveContext}
      unregisterActiveContext={unregisterActiveContext}
      handlerRegistryRef={handlerRegistryRef}
    >
      {children}
    </KeybindingProvider>
  )
}

async function renderConfirm(onConfirm: () => void, onCancel: () => void) {
  const { stdout, stdin, getOutput } = createTestStreams()
  const { AppStateProvider } = await import('../state/AppState.js')
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(
    <AppStateProvider initialState={getDefaultAppState() as never}>
      <TestKeybindingProvider>
        <DeleteSessionConfirm
          sessionTitle="Fix the login bug"
          sessionId={sessionId}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </TestKeybindingProvider>
    </AppStateProvider>,
  )
  return { stdout, stdin, getOutput, root }
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/DeleteSessionConfirm.render.test.tsx',
  )
})

afterEach(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('DeleteSessionConfirm (rendered)', () => {
  test('shows title, short id, and irreversibility warning', async () => {
    const { stdout, stdin, getOutput, root } = await renderConfirm(
      mock(() => {}),
      mock(() => {}),
    )
    try {
      await waitFor(() =>
        stripAnsi(getOutput()).includes('Delete session?'),
      )
      const output = stripAnsi(getOutput())
      expect(output).toContain('Fix the login bug')
      expect(output).toContain('550e8400')
      expect(output).toContain('440000')
      expect(output).toContain('cannot be undone')
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('Enter confirms without cancelling', async () => {
    const onConfirm = mock(() => {})
    const onCancel = mock(() => {})
    const { stdout, stdin, getOutput, root } = await renderConfirm(
      onConfirm,
      onCancel,
    )
    try {
      await waitFor(() =>
        stripAnsi(getOutput()).includes('Delete session?'),
      )
      stdin.write('\r')
      await waitFor(() => onConfirm.mock.calls.length > 0)
      expect(onCancel).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })

  test('Escape cancels without confirming', async () => {
    const onConfirm = mock(() => {})
    const onCancel = mock(() => {})
    const { stdout, stdin, getOutput, root } = await renderConfirm(
      onConfirm,
      onCancel,
    )
    try {
      await waitFor(() =>
        stripAnsi(getOutput()).includes('Delete session?'),
      )
      stdin.write('\x1b')
      await waitFor(() => onCancel.mock.calls.length > 0)
      expect(onConfirm).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
