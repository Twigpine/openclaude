import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

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
import type { Notification } from '../../../context/notifications.js'
import { getDefaultAppState } from '../../../state/AppStateStore.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../../tools/ExitPlanModeTool/constants.js'

const nonce = `${Date.now()}-${Math.random()}`
const realPlans = {
  ...await import(`../../../utils/plans.js?real=${nonce}`),
}
const realPermissionRuleExplanation = {
  ...await import(`../PermissionRuleExplanation.js?real=${nonce}`),
}
const realMarkdown = {
  ...await import(`../../Markdown.js?real=${nonce}`),
}
const realNotifications = {
  ...await import(`../../../context/notifications.js?real=${nonce}`),
}

// A real path whose parent directory does not exist, so writeFile rejects with
// a genuine ENOENT — no fs/promises mock needed.
const unwritablePlanPath = join(
  tmpdir(),
  `oc-plan-render-missing-${Date.now()}-${Math.random()}`,
  'plan.md',
)

const addNotification = mock((_notification: Notification) => {})

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for ExitPlanMode render test condition')
}

function TestKeybindingProvider({ children }: { children: React.ReactNode }): React.ReactNode {
  const bindings = React.useMemo(() => parseBindings(DEFAULT_BINDINGS), [])
  const pendingChordRef = React.useRef<ParsedKeystroke[] | null>(null)
  const [pendingChord, setPendingChordState] = React.useState<ParsedKeystroke[] | null>(null)
  const activeContextsRef = React.useRef<Set<KeybindingContextName>>(new Set())
  const handlerRegistryRef = React.useRef(
    new Map<string, Set<{ action: string; context: KeybindingContextName; handler: () => void }>>(),
  )
  const setPendingChord = React.useCallback((pending: ParsedKeystroke[] | null) => {
    pendingChordRef.current = pending
    setPendingChordState(pending)
  }, [])
  const registerActiveContext = React.useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.add(context)
  }, [])
  const unregisterActiveContext = React.useCallback((context: KeybindingContextName) => {
    activeContextsRef.current.delete(context)
  }, [])
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

function createToolUseConfirm() {
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
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    tool: { name: EXIT_PLAN_MODE_V2_TOOL_NAME },
    description: 'exit plan mode',
    input: {},
    toolUseContext: {},
    toolUseID: 'toolu_exitplan',
    permissionResult: { behavior: 'ask', message: 'Exit plan mode?' },
    permissionPromptStartTimeMs: Date.now(),
    onUserInteraction: mock(() => {}),
    onAbort: mock(() => {}),
    onAllow: mock(() => {}),
    onReject: mock(() => {}),
    recheckPermission: mock(async () => {}),
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock(
    'components/permissions/ExitPlanModePermissionRequest.render.test.tsx',
  )
  addNotification.mockClear()
  mock.module('../PermissionRuleExplanation.js', () => ({
    PermissionRuleExplanation: () => null,
  }))
  mock.module('../../Markdown.js', () => ({
    Markdown: ({ children }: { children: string }) => children,
  }))
  // Capture notifications without a provider.
  mock.module('src/context/notifications.js', () => ({
    useNotifications: () => ({ addNotification, removeNotification: () => {} }),
  }))
  // V2 plan-file path points at a missing parent dir → real ENOENT on write.
  mock.module('../../../utils/plans.js', () => ({
    ...realPlans,
    getPlanFilePath: () => unwritablePlanPath,
    getPlan: () => '# A plan\n- step one',
    persistFileSnapshotIfRemote: () => Promise.resolve(),
  }))
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../../../utils/plans.js', () => realPlans)
    mock.module('../PermissionRuleExplanation.js', () => realPermissionRuleExplanation)
    mock.module('../../Markdown.js', () => realMarkdown)
    mock.module('src/context/notifications.js', () => realNotifications)
  } finally {
    releaseSharedMutationLock()
  }
})

describe('ExitPlanModePermissionRequest write guard (rendered)', () => {
  test('aborts the plan-exit and does not call onAllow/onReject when the plan write fails', async () => {
    const { stdout, stdin, getOutput } = createTestStreams()
    const { AppStateProvider } = await import('../../../state/AppState.js')
    const { ExitPlanModePermissionRequest } = await import(
      './ExitPlanModePermissionRequest.tsx'
    )

    const toolUseConfirm = createToolUseConfirm()
    const onDone = mock(() => {})
    const onReject = mock(() => {})

    const base = getDefaultAppState()
    const initialState = {
      ...base,
      toolPermissionContext: {
        ...base.toolPermissionContext,
        mode: 'plan',
      },
    }

    const root = await createRoot({
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      patchConsole: false,
    })

    root.render(
      <AppStateProvider initialState={initialState as never}>
        <TestKeybindingProvider>
          <ExitPlanModePermissionRequest
            toolUseConfirm={toolUseConfirm as never}
            toolUseContext={{} as never}
            onDone={onDone}
            onReject={onReject}
            verbose={false}
            workerBadge={undefined}
            setStickyFooter={undefined as never}
          />
        </TestKeybindingProvider>
      </AppStateProvider>,
    )

    try {
      await waitFor(() => stripAnsi(getOutput()).includes('Would you like to proceed?'))

      // Confirm the first (accept) option; its handler tries to persist the
      // plan file, which fails (missing parent dir).
      stdin.write('\r')

      // The write-failure guard must queue the plan-save-error notification…
      await waitFor(() =>
        addNotification.mock.calls.some(
          call => call[0]?.key === 'plan-save-error',
        ),
      )

      // …and must NOT advance the plan exit.
      expect(toolUseConfirm.onAllow).not.toHaveBeenCalled()
      expect(toolUseConfirm.onReject).not.toHaveBeenCalled()
      expect(onDone).not.toHaveBeenCalled()
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
    }
  })
})
