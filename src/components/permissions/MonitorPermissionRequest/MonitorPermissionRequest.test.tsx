import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import { getOriginalCwd, setOriginalCwd } from '../../../bootstrap/state.js'
import { handleInteractivePermission } from '../../../hooks/toolPermission/handlers/interactiveHandler.js'
import { createPermissionContext } from '../../../hooks/toolPermission/PermissionContext.js'
import { createRoot } from '../../../ink.js'
import { DEFAULT_BINDINGS } from '../../../keybindings/defaultBindings.js'
import { KeybindingProvider } from '../../../keybindings/KeybindingContext.js'
import { parseBindings } from '../../../keybindings/parser.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../../test/sharedMutationLock.js'
import type {
  KeybindingContextName,
  ParsedKeystroke,
} from '../../../keybindings/types.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../../state/AppStateStore.js'
import type { ToolUseContext } from '../../../Tool.js'
import { MonitorTool } from '../../../tools/MonitorTool/MonitorTool.js'
import type {
  PermissionAllowDecision,
  PermissionDecision,
} from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../../../utils/interruptionTrace.js'

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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }

  throw new Error('Timed out waiting for Monitor permission test condition')
}

function expectAllowDecision(
  decision: PermissionDecision,
): asserts decision is PermissionAllowDecision {
  expect(decision.behavior).toBe('allow')
  if (decision.behavior !== 'allow') {
    throw new Error(`Expected allow decision, received ${decision.behavior}`)
  }
}

function createToolUseConfirm(
  overrides: Partial<ToolUseConfirm> = {},
): ToolUseConfirm {
  return {
    assistantMessage: {
      type: 'assistant',
      uuid: 'assistant-uuid',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'test-model',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
      // Minimal fixture — partial usage/uuid, cast type-side only.
    } as unknown as ToolUseConfirm['assistantMessage'],
    tool: MonitorTool,
    description: 'watch log',
    input: {
      command: 'tail -f app.log',
      description: 'watch log',
    },
    toolUseContext: {} as ToolUseConfirm['toolUseContext'],
    toolUseID: 'toolu_monitor',
    permissionResult: {
      behavior: 'ask',
      message: 'Permission required',
    },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: mock(() => {}),
    onAbort: mock(() => {}),
    onAllow: mock(() => {}),
    onReject: mock(() => {}),
    recheckPermission: mock(async () => {}),
    ...overrides,
  }
}

function createToolUseContext(): {
  toolUseContext: ToolUseContext
} {
  let appState = getDefaultAppState()

  const toolUseContext = {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'test-model',
      tools: [MonitorTool],
      verbose: false,
      thinkingConfig: {},
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(),
    readFileState: {},
    messages: [],
    getAppState: () => appState,
    setAppState: (updater: (prev: AppState) => AppState) => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext

  return {
    toolUseContext,
  }
}

function createInteractiveMonitorPermission(): {
  toolUseConfirm: ToolUseConfirm
  toolUseContext: ToolUseContext
  decisionPromise: Promise<PermissionDecision>
} {
  const { toolUseContext } = createToolUseContext()
  const base = createToolUseConfirm({ toolUseContext })
  let queue: ToolUseConfirm[] = []

  const ctx = createPermissionContext(
    MonitorTool,
    base.input,
    toolUseContext,
    base.assistantMessage,
    base.toolUseID,
    toolPermissionContext => {
      toolUseContext.setAppState(prev => ({
        ...prev,
        toolPermissionContext,
      }))
    },
    {
      push(item) {
        queue = [...queue, item]
      },
      remove(toolUseID, permissionSessionId, agentId) {
        queue = queue.filter(
          item =>
            item.toolUseID !== toolUseID ||
            item.permissionSessionId !== permissionSessionId ||
            item.toolUseContext.agentId !== agentId,
        )
      },
      update(toolUseID, permissionSessionId, agentId, patch) {
        queue = queue.map(item =>
          item.toolUseID === toolUseID &&
          item.permissionSessionId === permissionSessionId &&
          item.toolUseContext.agentId === agentId
            ? { ...item, ...patch }
            : item,
        )
      },
    },
  )

  const decisionPromise = new Promise<PermissionDecision>(resolve => {
    handleInteractivePermission(
      {
        ctx,
        description: base.description,
        result: base.permissionResult as PermissionDecision & {
          behavior: 'ask'
        },
        awaitAutomatedChecksBeforeDialog: true,
      },
      resolve,
    )
  })

  if (!queue[0]) {
    throw new Error('Expected handleInteractivePermission to queue a prompt')
  }

  return {
    toolUseConfirm: queue[0],
    toolUseContext,
    decisionPromise,
  }
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

async function renderMonitorPermission(
  toolUseConfirm: ToolUseConfirm,
  callbacks: {
    onDone?: () => void
    onReject?: () => void
  } = {},
): Promise<{
  stdin: ReturnType<typeof createTestStreams>['stdin']
  cleanup: () => void
}> {
  const { stdout, stdin, getOutput } = createTestStreams()
  const { AppStateProvider } = await import('../../../state/AppState.js')
  const { MonitorPermissionRequest } = await import(
    './MonitorPermissionRequest.js'
  )
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })

  root.render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <TestKeybindingProvider>
        <MonitorPermissionRequest
          toolUseConfirm={toolUseConfirm}
          toolUseContext={toolUseConfirm.toolUseContext}
          onDone={callbacks.onDone ?? (() => {})}
          onReject={callbacks.onReject ?? (() => {})}
          verbose={false}
          workerBadge={undefined}
        />
      </TestKeybindingProvider>
    </AppStateProvider>,
  )

  await waitFor(() =>
    stripAnsi(getOutput()).includes('Do you want to proceed?'),
  )

  return {
    stdin,
    cleanup: () => {
      root.unmount()
      stdin.end()
      stdout.end()
    },
  }
}

const originalInterruptionTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/permissions/MonitorPermissionRequest.test.tsx',
  )
  mock.module('../PermissionRuleExplanation.js', () => ({
    PermissionRuleExplanation: () => null,
  }))
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
    releaseSharedMutationLock()
  }
})

describe('MonitorPermissionRequest', () => {
  test('allow once resolves the real pending permission promise and closes the dialog', async () => {
    const onDone = mock(() => {})
    const { toolUseConfirm, decisionPromise } =
      createInteractiveMonitorPermission()
    const mounted = await renderMonitorPermission(toolUseConfirm, { onDone })

    try {
      mounted.stdin.write('\r')

      await waitFor(() => onDone.mock.calls.length === 1)
      const decision = await decisionPromise

      expectAllowDecision(decision)
      expect(decision.updatedInput).toEqual(toolUseConfirm.input)
    } finally {
      mounted.cleanup()
    }
  })

  test('allow persistently resolves the permission with a Bash allow rule and closes the dialog', async () => {
    const onDone = mock(() => {})
    const toolUseConfirm = createToolUseConfirm()
    const mounted = await renderMonitorPermission(toolUseConfirm, { onDone })

    try {
      mounted.stdin.write('2')

      await waitFor(() => onDone.mock.calls.length === 1)

      expect(toolUseConfirm.onAllow).toHaveBeenCalledWith(
        toolUseConfirm.input,
        [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'tail -f:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
        undefined,
      )
      expect(toolUseConfirm.onReject).not.toHaveBeenCalled()
    } finally {
      mounted.cleanup()
    }
  })

  test('rendered persistent allow resolves the real pending permission promise with a Bash allow rule', async () => {
    const originalCwd = getOriginalCwd()
    const tempCwd = mkdtempSync(join(tmpdir(), 'monitor-permission-'))
    const onDone = mock(() => {})

    setOriginalCwd(tempCwd)
    const { toolUseConfirm, toolUseContext, decisionPromise } =
      createInteractiveMonitorPermission()
    const mounted = await renderMonitorPermission(toolUseConfirm, { onDone })

    try {
      mounted.stdin.write('2')

      await waitFor(() => onDone.mock.calls.length === 1)
      const decision = await decisionPromise

      expectAllowDecision(decision)
      expect(decision.updatedInput).toEqual(toolUseConfirm.input)
      expect(
        toolUseContext.getAppState().toolPermissionContext.alwaysAllowRules
          .localSettings,
      ).toContain('Bash(tail -f:*)')
    } finally {
      mounted.cleanup()
      setOriginalCwd(originalCwd)
      rmSync(tempCwd, { recursive: true, force: true })
    }
  })

  test('permission continuation resolves when approval includes permission updates', async () => {
    const { toolUseConfirm, toolUseContext, decisionPromise } =
      createInteractiveMonitorPermission()
    const permissionUpdates: PermissionUpdate[] = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'tail -f:*' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]

    toolUseConfirm.onAllow(toolUseConfirm.input, permissionUpdates)
    const decision = await decisionPromise

    expectAllowDecision(decision)
    expect(decision.updatedInput).toEqual(toolUseConfirm.input)
    expect(
      toolUseContext.getAppState().toolPermissionContext.alwaysAllowRules
        .session,
    ).toContain('Bash(tail -f:*)')
  })

  test('deny resolves rejection, runs the reject continuation, and closes the dialog', async () => {
    const onDone = mock(() => {})
    const onReject = mock(() => {})
    const { toolUseConfirm, toolUseContext, decisionPromise } =
      createInteractiveMonitorPermission()
    const mounted = await renderMonitorPermission(toolUseConfirm, {
      onDone,
      onReject,
    })

    try {
      mounted.stdin.write('3')

      await waitFor(() => onDone.mock.calls.length === 1)
      const decision = await decisionPromise

      expect(decision.behavior).toBe('ask')
      expect(toolUseContext.abortController.signal.aborted).toBe(true)
      expect(onReject).toHaveBeenCalledTimes(1)
    } finally {
      mounted.cleanup()
    }
  })

  test('escape cancels the pending permission request and closes the dialog', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const onDone = mock(() => {})
    const onReject = mock(() => {})
    const { toolUseConfirm, toolUseContext, decisionPromise } =
      createInteractiveMonitorPermission()
    const mounted = await renderMonitorPermission(toolUseConfirm, {
      onDone,
      onReject,
    })

    try {
      mounted.stdin.write('\u001B')

      await waitFor(() => onDone.mock.calls.length === 1)
      const decision = await decisionPromise

      expect(decision.behavior).toBe('ask')
      expect(toolUseContext.abortController.signal.aborted).toBe(true)
      expect(onReject).toHaveBeenCalledTimes(1)
      expect(
        __getInterruptionTraceSnapshotForTests().find(
          entry =>
            entry.event === 'abort.requested' &&
            entry.source === 'permission_abort',
        ),
      ).toMatchObject({
        subsystem: 'tool_permission',
        controllerRole: 'query-root',
      })
    } finally {
      mounted.cleanup()
    }
  })
})
