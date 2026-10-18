import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import React from 'react'
import * as analytics from '../services/analytics/index.js'
import { createRoot } from '../ink.js'
import { KeybindingProvider } from '../keybindings/KeybindingContext.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../keybindings/types.js'
import { AppStateProvider } from '../state/AppState.js'
import {
  getDefaultAppState,
  type AppState,
} from '../state/AppStateStore.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import {
  abortPendingToolPermissionRequests,
  CancelRequestHandler,
} from './useCancelRequest.js'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../utils/interruptionTrace.js'

type HandlerRegistration = {
  action: string
  context: KeybindingContextName
  handler: () => void
}

function TestKeybindingProvider({
  children,
  registry,
}: {
  children: React.ReactNode
  registry: React.RefObject<Map<string, Set<HandlerRegistration>>>
}): React.ReactNode {
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChord] = React.useState<
    ParsedKeystroke[] | null
  >(null)
  const [activeContexts] = React.useState(
    () => new Set<KeybindingContextName>(['Chat', 'Global']),
  )
  return (
    <KeybindingProvider
      bindings={[]}
      pendingChordRef={pendingChordRef}
      pendingChord={pendingChord}
      setPendingChord={setPendingChord}
      activeContexts={activeContexts}
      registerActiveContext={context => activeContexts.add(context)}
      unregisterActiveContext={context => activeContexts.delete(context)}
      handlerRegistryRef={registry}
    >
      {children}
    </KeybindingProvider>
  )
}

function createTestStreams() {
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
  return { stdout, stdin }
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function renderCancelHandler(
  initialState: AppState,
  options: { failAfterRender?: boolean; onCleanup?: () => void } = {},
) {
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  const registry = {
    current: new Map<string, Set<HandlerRegistration>>(),
  }
  const onCancel = mock((_source: string, _causalEventId?: string) => {})
  let latestState = initialState
  const cleanup = async () => {
    root.unmount()
    await Bun.sleep(30)
    stdin.end()
    stdout.end()
    options.onCleanup?.()
  }
  try {
    root.render(
      <AppStateProvider
        initialState={initialState}
        onChangeAppState={({ newState }) => {
          latestState = newState
        }}
      >
        <TestKeybindingProvider registry={registry}>
          <CancelRequestHandler
            onCancel={onCancel}
            onAgentsKilled={() => {}}
            isMessageSelectorVisible={false}
            screen="prompt"
            abortSignal={new AbortController().signal}
          />
        </TestKeybindingProvider>
      </AppStateProvider>,
    )
    if (options.failAfterRender) throw new Error('synthetic setup failure')
    await waitFor(
      () =>
        registry.current.has('app:interrupt') &&
        (initialState.viewSelectionMode === 'viewing-agent' ||
          registry.current.has('chat:cancel')),
      'cancel keybinding registration',
    )
  } catch (error) {
    await cleanup()
    throw error
  }
  return {
    onCancel,
    invoke(action: 'chat:cancel' | 'app:interrupt') {
      const registration = registry.current.get(action)?.values().next().value
      if (!registration) throw new Error(`Missing ${action} handler`)
      registration.handler()
    },
    getState: () => latestState,
    cleanup,
  }
}

const originalInterruptionTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
let hasSharedMutationLock = false

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useCancelRequest.test.tsx')
  hasSharedMutationLock = true
})

afterEach(async () => {
  try {
    mock.restore()
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    if (originalInterruptionTrace === undefined) {
      delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    } else {
      process.env.OPENCLAUDE_INTERRUPT_TRACE = originalInterruptionTrace
    }
  } finally {
    if (hasSharedMutationLock) {
      releaseSharedMutationLock()
      hasSharedMutationLock = false
    }
  }
})

describe('CancelRequestHandler interruption sources', () => {
  test('cleans up the Ink root and streams when setup fails', async () => {
    let cleanupCount = 0

    await expect(
      renderCancelHandler(getDefaultAppState(), {
        failAfterRender: true,
        onCleanup: () => {
          cleanupCount++
        },
      }),
    ).rejects.toThrow('synthetic setup failure')
    expect(cleanupCount).toBe(1)
  })

  test('chat:cancel preserves escape analytics and passes the precise cancel source', async () => {
    const logEvent = spyOn(analytics, 'logEvent').mockImplementation(() => {})
    const rendered = await renderCancelHandler(getDefaultAppState())
    try {
      rendered.invoke('chat:cancel')

      expect(rendered.onCancel).toHaveBeenCalledWith(
        'cancel_keybinding',
        undefined,
      )
      expect(logEvent).toHaveBeenCalledWith(
        'tengu_cancel',
        expect.objectContaining({ source: 'escape' }),
      )
    } finally {
      await rendered.cleanup()
    }
  })

  test('app:interrupt preserves escape analytics while passing ctrl_c', async () => {
    const logEvent = spyOn(analytics, 'logEvent').mockImplementation(() => {})
    const rendered = await renderCancelHandler({
      ...getDefaultAppState(),
      viewSelectionMode: 'viewing-agent',
    })
    try {
      rendered.invoke('app:interrupt')

      expect(rendered.onCancel).toHaveBeenCalledWith('ctrl_c', undefined)
      expect(rendered.getState().viewSelectionMode).toBe('none')
      expect(logEvent).toHaveBeenCalledWith(
        'tengu_cancel',
        expect.objectContaining({ source: 'escape' }),
      )
    } finally {
      await rendered.cleanup()
    }
  })

  test('app:interrupt links background-agent aborts to the Ctrl-C input', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const agentAbortController = new AbortController()
    const agentTask: LocalAgentTaskState = {
      id: 'agent-1',
      type: 'local_agent',
      status: 'running',
      description: 'trace test agent',
      startTime: Date.now(),
      outputFile: join(tmpdir(), 'openclaude-trace-test-agent.output'),
      outputOffset: 0,
      notified: false,
      agentId: 'agent-1',
      prompt: 'test',
      agentType: 'general-purpose',
      abortController: agentAbortController,
      retrieved: false,
      lastReportedToolCount: 0,
      lastReportedTokenCount: 0,
      isBackgrounded: true,
      pendingMessages: [],
      retain: false,
      diskLoaded: false,
    }
    const rendered = await renderCancelHandler({
      ...getDefaultAppState(),
      viewSelectionMode: 'viewing-agent',
      viewingAgentTaskId: 'agent-1',
      tasks: { 'agent-1': agentTask },
    })
    try {
      rendered.invoke('app:interrupt')
      await waitFor(
        () => agentAbortController.signal.aborted,
        'background-agent abort',
      )

      const trace = __getInterruptionTraceSnapshotForTests()
      const input = trace.find(entry => entry.event === 'input.ctrl_c')
      const agentAbort = trace.find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.controllerRole === 'background-agent',
      )
      expect(input).toBeDefined()
      expect(agentAbort).toMatchObject({
        source: 'ctrl_c',
        subagentId: 'agent-1',
        causalEventId: input!.eventId,
      })
    } finally {
      await rendered.cleanup()
    }
  })
})

describe('abortPendingToolPermissionRequests', () => {
  test('settles every permission request removed by parent cancellation', () => {
    const firstAbort = mock((_source?: string, _causalEventId?: string) => {})
    const secondAbort = mock((_source?: string, _causalEventId?: string) => {})
    const queue = [
      { onAbort: firstAbort },
      { onAbort: secondAbort },
    ] as Array<Pick<ToolUseConfirm, 'onAbort'>>

    abortPendingToolPermissionRequests(
      queue,
      'ctrl_c',
      'cancel-event-1',
    )

    expect(firstAbort).toHaveBeenCalledTimes(1)
    expect(firstAbort).toHaveBeenCalledWith('ctrl_c', 'cancel-event-1')
    expect(secondAbort).toHaveBeenCalledTimes(1)
    expect(secondAbort).toHaveBeenCalledWith('ctrl_c', 'cancel-event-1')
  })

  test('also aborts the distinct active parent query', () => {
    const controller = new AbortController()

    abortPendingToolPermissionRequests([], 'ctrl_c', 'cancel-event-2', controller)

    expect(controller.signal.aborted).toBe(true)
  })
})
