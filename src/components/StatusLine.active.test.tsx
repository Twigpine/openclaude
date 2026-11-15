import { PassThrough } from 'node:stream'
import { afterAll, expect, jest, test } from 'bun:test'
import { type RefObject, useEffect, useLayoutEffect } from 'react'
import {
  getSessionTrustAccepted,
  setSessionTrustAccepted,
} from '../bootstrap/state.js'
import { createRoot } from '../ink.js'
import {
  AppStateProvider,
  type AppState,
  getDefaultAppState,
  useSetAppState,
} from '../state/AppState.js'
import type { Message } from '../types/message.js'
import type { StatusLineCommandInput } from '../types/statusLine.js'
import type { executeStatusLineCommand } from '../utils/hooks.js'
import { createUserMessage } from '../utils/messages.js'
import { createCompactBoundaryMessage } from '../utils/messages/systemFactories.js'
import { getLastAssistantMessageId, StatusLine } from './StatusLine.js'

type MacroGlobal = typeof globalThis & { MACRO?: { VERSION: string } }
const macroGlobal = globalThis as MacroGlobal
const originalMacro = macroGlobal.MACRO
macroGlobal.MACRO = {
  VERSION: 'test-version',
}
afterAll(() => {
  if (originalMacro === undefined) delete macroGlobal.MACRO
  else macroGlobal.MACRO = originalMacro
})

type PendingExecution = {
  input: StatusLineCommandInput
  signal: AbortSignal
  resolve: (value: string | undefined) => void
}

function assistantMessage(id: string): Message {
  return {
    type: 'assistant',
    uuid: id,
    timestamp: '2026-07-14T00:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [{ type: 'text', text: 'test' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as Message
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

function CommitProbe({
  token,
  onCommit,
  onLayoutCommit,
}: {
  token: number
  onCommit: (token: number) => void
  onLayoutCommit: (token: number) => void
}): null {
  useLayoutEffect(() => {
    onLayoutCommit(token)
  }, [onLayoutCommit, token])
  useEffect(() => {
    onCommit(token)
  }, [onCommit, token])
  return null
}

test('cancels hidden statusline work and refreshes once reactivated', async () => {
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  const originalTrust = getSessionTrustAccepted()
  const calls: PendingExecution[] = []
  const commits: number[] = []
  const layoutCommits: Array<{ token: number; commandAborted: boolean }> = []
  let updateAppState: ReturnType<typeof useSetAppState> | undefined
  const messagesRef: RefObject<Message[]> = { current: [] }
  const initialState: AppState = {
    ...getDefaultAppState(),
    settings: {
      statusLine: { type: 'command', command: 'test-statusline' },
    },
  }
  let latestState = initialState
  const executeCommand: typeof executeStatusLineCommand = async (
    input,
    signal,
  ) =>
    new Promise(resolve => {
      expect(signal).toBeInstanceOf(AbortSignal)
      const pending = { input, signal: signal!, resolve }
      calls.push(pending)
      signal?.addEventListener('abort', () => resolve(undefined), { once: true })
    })
  const onCommit = (token: number) => commits.push(token)
  const onLayoutCommit = (token: number) => {
    layoutCommits.push({
      token,
      commandAborted: calls[0]?.signal.aborted ?? false,
    })
  }
  function StateController(): null {
    const setAppState = useSetAppState()
    useEffect(() => {
      updateAppState = setAppState
    }, [setAppState])
    return null
  }
  const render = (
    active: boolean,
    lastAssistantMessageId: string | null,
    token: number,
  ) => {
    messagesRef.current = lastAssistantMessageId
      ? [assistantMessage(lastAssistantMessageId)]
      : []
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <StatusLine
          active={active}
          executeCommand={executeCommand}
          messagesRef={messagesRef}
          lastAssistantMessageId={lastAssistantMessageId}
        />
        <CommitProbe
          token={token}
          onCommit={onCommit}
          onLayoutCommit={onLayoutCommit}
        />
        <StateController />
      </AppStateProvider>,
    )
  }

  setSessionTrustAccepted(true)
  try {
    render(true, null, 1)
    await waitFor(
      () => calls.length === 1 && updateAppState !== undefined,
      'initial statusline execution and state controller',
    )

    render(false, null, 2)
    await waitFor(() => commits.includes(2), 'inactive commit')
    expect(layoutCommits.find(commit => commit.token === 2)?.commandAborted).toBe(
      true,
    )
    expect(calls[0]!.signal.aborted).toBe(true)

    await Bun.sleep(10)
    render(true, null, 3)
    await waitFor(() => calls.length === 2, 'refresh after aborted execution')
    calls[1]!.resolve('refreshed-after-abort')
    await waitFor(
      () => latestState.statusLineText === 'refreshed-after-abort',
      'statusline text after aborted execution',
    )

    render(false, null, 4)
    await waitFor(() => commits.includes(4), 'second inactive commit')

    render(false, 'message-while-hidden', 5)
    await waitFor(() => commits.includes(5), 'hidden state-change commit')
    expect(calls).toHaveLength(2)

    render(true, 'message-while-hidden', 6)
    await waitFor(() => calls.length === 3, 'reactivation refresh')
    calls[2]!.resolve('reactivated')
    await waitFor(
      () => latestState.statusLineText === 'reactivated',
      'reactivated statusline text',
    )

    updateAppState!(prev => ({
      ...prev,
      settings: { ...prev.settings, outputStyle: 'Explanatory' },
    }))
    await waitFor(() => calls.length === 4, 'output-style refresh')
    expect(calls[3]!.input.output_style.name).toBe('Explanatory')
    calls[3]!.resolve('output-style')
    await waitFor(
      () => latestState.statusLineText === 'output-style',
      'output-style statusline text',
    )

    const addedDirectory = '/tmp/statusline-added-directory'
    updateAppState!(prev => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        additionalWorkingDirectories: new Map([
          ...prev.toolPermissionContext.additionalWorkingDirectories,
          [addedDirectory, { path: addedDirectory, source: 'session' as const }],
        ]),
      },
    }))
    await waitFor(() => calls.length === 5, 'workspace-directory refresh')
    expect(calls[4]!.input.workspace.added_dirs).toContain(addedDirectory)
    calls[4]!.resolve('workspace-directory')
    await waitFor(
      () => latestState.statusLineText === 'workspace-directory',
      'workspace-directory statusline text',
    )

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout')
    render(true, 'debounced-message', 7)
    await waitFor(
      () => setTimeoutSpy.mock.calls.some(call => call[1] === 300),
      'debounced statusline timer',
    )
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === 300)
    const timer = setTimeoutSpy.mock.results[timerIndex]!.value

    render(false, 'debounced-message', 8)
    await waitFor(() => commits.includes(8), 'timer cancellation commit')
    expect(clearTimeoutSpy).toHaveBeenCalledWith(timer)
  } finally {
    jest.restoreAllMocks()
    root.unmount()
    stdout.end()
    setSessionTrustAccepted(originalTrust)
  }
})

test('refreshes mounted statusline with null usage after full compaction', async () => {
  const stdout = new PassThrough()
  ;(stdout as unknown as { columns: number }).columns = 80
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  const originalTrust = getSessionTrustAccepted()
  const calls: StatusLineCommandInput[] = []
  const archived = assistantMessage('archived-response')
  if (archived.type !== 'assistant') throw new Error('Expected assistant fixture')
  archived.message.usage.input_tokens = 90000
  const boundary = createCompactBoundaryMessage('manual', 90000)
  const summary = createUserMessage({
    content: 'Compacted conversation summary.',
    isCompactSummary: true,
  })
  const messagesRef: RefObject<Message[]> = { current: [archived] }
  const initialState: AppState = {
    ...getDefaultAppState(),
    settings: {
      statusLine: { type: 'command', command: 'test-statusline' },
    },
  }
  let latestState = initialState
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  const executeCommand: typeof executeStatusLineCommand = async input => {
    calls.push(input)
    return input.context_window.current_usage === null ? 'compacted' : 'archived'
  }
  const render = (messages: Message[]) => {
    messagesRef.current = messages
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <StatusLine
          messagesRef={messagesRef}
          lastAssistantMessageId={getLastAssistantMessageId(messages)}
          executeCommand={executeCommand}
        />
      </AppStateProvider>,
    )
  }

  setSessionTrustAccepted(true)
  try {
    render([archived])
    await waitFor(
      () => calls.length === 1 && latestState.statusLineText === 'archived',
      'initial statusline with archived usage',
    )
    expect(calls[0]!.context_window.current_usage?.input_tokens).toBe(90000)

    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout')
    render([archived, boundary, summary])
    await waitFor(
      () => setTimeoutSpy.mock.calls.some(call => call[1] === 300),
      'debounced compact statusline refresh',
    )
    const timerIndex = setTimeoutSpy.mock.calls.findIndex(call => call[1] === 300)
    debounceTimer = setTimeoutSpy.mock.results[timerIndex]!
      .value as ReturnType<typeof setTimeout>
    expect(calls).toHaveLength(1)

    await waitFor(
      () => calls.length === 2 && latestState.statusLineText === 'compacted',
      'statusline execution after full compaction',
    )
    expect(calls[1]!.context_window.current_usage).toBeNull()
    expect(calls[1]!.context_window.used_percentage).toBeNull()
    expect(calls[1]!.context_window.remaining_percentage).toBeNull()
  } finally {
    root.unmount()
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    jest.restoreAllMocks()
    stdout.end()
    setSessionTrustAccepted(originalTrust)
  }
})

test(
  'reruns the status line command periodically on the refresh interval',
  async () => {
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 80
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    const originalTrust = getSessionTrustAccepted()
    const calls: StatusLineCommandInput[] = []
    const messagesRef: RefObject<Message[]> = { current: [] }
    const initialState: AppState = {
      ...getDefaultAppState(),
      settings: {
        statusLine: {
          type: 'command',
          command: 'test-statusline',
          refreshInterval: 0.1,
        },
      },
    }
    let latestState = initialState
    const executeCommand: typeof executeStatusLineCommand = async input => {
      calls.push(input)
      return `tick-${calls.length}`
    }
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <StatusLine
          active={true}
          executeCommand={executeCommand}
          messagesRef={messagesRef}
          lastAssistantMessageId={null}
        />
      </AppStateProvider>,
    )

    setSessionTrustAccepted(true)
    try {
      await waitFor(() => calls.length === 1, 'initial statusline execution')
      await waitFor(
        () => calls.length >= 3,
        'periodic statusline runs',
        5000,
      )
      await waitFor(
        () => latestState.statusLineText?.startsWith('tick-') === true,
        'statusline text from a stubbed run',
      )
      expect(latestState.statusLineText).toMatch(/^tick-\d+$/)
    } finally {
      root.unmount()
      stdout.end()
      setSessionTrustAccepted(originalTrust)
    }
  },
  20000,
)

test(
  'skips interval ticks while a status line run is in flight without aborting it',
  async () => {
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 80
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    const originalTrust = getSessionTrustAccepted()
    const calls: PendingExecution[] = []
    const messagesRef: RefObject<Message[]> = { current: [] }
    const initialState: AppState = {
      ...getDefaultAppState(),
      settings: {
        statusLine: {
          type: 'command',
          command: 'test-statusline',
          refreshInterval: 0.15,
        },
      },
    }
    let latestState = initialState
    const executeCommand: typeof executeStatusLineCommand = async (
      input,
      signal,
    ) =>
      new Promise(resolve => {
        const pending = { input, signal: signal!, resolve }
        calls.push(pending)
        signal?.addEventListener('abort', () => resolve(undefined), {
          once: true,
        })
      })
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <StatusLine
          active={true}
          executeCommand={executeCommand}
          messagesRef={messagesRef}
          lastAssistantMessageId={null}
        />
      </AppStateProvider>,
    )

    setSessionTrustAccepted(true)
    try {
      await waitFor(() => calls.length === 1, 'initial statusline execution')
      await Bun.sleep(1000)
      expect(calls.length).toBe(1)
      expect(calls[0]!.signal.aborted).toBe(false)

      calls[0]!.resolve('after-flight')
      await waitFor(
        () => calls.length === 2,
        'next tick after in-flight run resolves',
        5000,
      )
      expect(calls[0]!.signal.aborted).toBe(false)
      calls[1]!.resolve('second-run')
      await waitFor(
        () => latestState.statusLineText === 'second-run',
        'statusline text after the in-flight run',
      )
    } finally {
      root.unmount()
      stdout.end()
      setSessionTrustAccepted(originalTrust)
    }
  },
  20000,
)

test(
  'clears the periodic timer when the interval changes, the row hides, or the component unmounts',
  async () => {
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 80
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    const originalTrust = getSessionTrustAccepted()
    const calls: StatusLineCommandInput[] = []
    const commits: number[] = []
    let updateAppState: ReturnType<typeof useSetAppState> | undefined
    const messagesRef: RefObject<Message[]> = { current: [] }
    const initialState: AppState = {
      ...getDefaultAppState(),
      settings: {
        statusLine: {
          type: 'command',
          command: 'test-statusline',
          refreshInterval: 0.1,
        },
      },
    }
    let latestState = initialState
    const executeCommand: typeof executeStatusLineCommand = async input => {
      calls.push(input)
      return `tick-${calls.length}`
    }
    const onCommit = (token: number) => commits.push(token)
    function StateController(): null {
      const setAppState = useSetAppState()
      useEffect(() => {
        updateAppState = setAppState
      }, [setAppState])
      return null
    }
    const render = (active: boolean, token: number) => {
      root.render(
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={({ newState }) => {
            latestState = newState
          }}
        >
          <StatusLine
            active={active}
            executeCommand={executeCommand}
            messagesRef={messagesRef}
            lastAssistantMessageId={null}
          />
          <CommitProbe token={token} onCommit={onCommit} onLayoutCommit={() => {}} />
          <StateController />
        </AppStateProvider>,
      )
    }

    setSessionTrustAccepted(true)
    try {
      render(true, 1)
      await waitFor(
        () => calls.length === 1 && updateAppState !== undefined,
        'initial statusline execution and state controller',
      )

      updateAppState!(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          statusLine: {
            type: 'command',
            command: 'test-statusline',
            refreshInterval: 5,
          },
        },
      }))
      // Let any debounce armed by an old-interval tick settle first.
      await Bun.sleep(500)
      const callsAfterIntervalChange = calls.length
      await Bun.sleep(1500)
      expect(calls.length).toBe(callsAfterIntervalChange)

      render(false, 2)
      await waitFor(() => commits.includes(2), 'inactive commit')
      await Bun.sleep(1000)
      expect(calls.length).toBe(callsAfterIntervalChange)

      // Re-arm the periodic timer so unmounting exercises its cleanup.
      render(true, 3)
      await waitFor(() => commits.includes(3), 'reactivated commit')
      const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval')
      root.unmount()
      expect(clearIntervalSpy).toHaveBeenCalled()
    } finally {
      root.unmount()
      jest.restoreAllMocks()
      stdout.end()
      setSessionTrustAccepted(originalTrust)
    }
  },
  20000,
)

test(
  'does not run periodically when no refresh interval is configured',
  async () => {
    const stdout = new PassThrough()
    ;(stdout as unknown as { columns: number }).columns = 80
    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    const originalTrust = getSessionTrustAccepted()
    const calls: StatusLineCommandInput[] = []
    const messagesRef: RefObject<Message[]> = { current: [] }
    const initialState: AppState = {
      ...getDefaultAppState(),
      settings: {
        statusLine: { type: 'command', command: 'test-statusline' },
      },
    }
    let latestState = initialState
    const executeCommand: typeof executeStatusLineCommand = async input => {
      calls.push(input)
      return 'initial-only'
    }
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <StatusLine
          active={true}
          executeCommand={executeCommand}
          messagesRef={messagesRef}
          lastAssistantMessageId={null}
        />
      </AppStateProvider>,
    )

    setSessionTrustAccepted(true)
    try {
      await waitFor(
        () => calls.length === 1 && latestState.statusLineText === 'initial-only',
        'initial statusline execution',
      )
      await Bun.sleep(1200)
      expect(calls.length).toBe(1)
    } finally {
      root.unmount()
      stdout.end()
      setSessionTrustAccepted(originalTrust)
    }
  },
  20000,
)
