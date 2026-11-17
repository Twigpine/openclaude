import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import React from 'react'

// Hook mock registered before the useCanUseTool import so the permission
// context resolves the stub: yields a PermissionRequest allow when set.
let hookDecision: { behavior: 'allow' } | undefined
const realHooks = await import(
  `../utils/hooks.js?interactiveSuppressionActual=${Date.now()}-${Math.random()}`
)
mock.module('../utils/hooks.js', () => ({
  ...realHooks,
  executePermissionRequestHooks: async function* () {
    if (hookDecision) {
      yield { permissionRequestResult: hookDecision }
    }
  },
}))

let denyInsteadOfPrompting = false
const realSettings = await import(
  `../utils/settings/settings.js?interactiveSuppressionSettings=${Date.now()}-${Math.random()}`
)
mock.module('../utils/settings/settings.js', () => ({
  ...realSettings,
  getInitialSettings: () => ({
    permissions: { denyInsteadOfPrompting },
  }),
}))

const { getSessionId } = await import('../bootstrap/state.js')
const { createRoot, Text } = await import('../ink.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} = await import('../test/sharedMutationLock.js')
const { DENY_INSTEAD_OF_PROMPTING_REASON } = await import(
  '../utils/permissions/permissions.js'
)
const useCanUseTool = (await import('./useCanUseTool.js')).default

import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import type { CanUseToolFn } from './useCanUseTool.js'

let canUseTool: CanUseToolFn | undefined

function HookProbe({
  setQueue,
}: {
  setQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
}) {
  canUseTool = useCanUseTool(setQueue, () => {})
  return React.createElement(Text, null, 'probe')
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

const suppressionDeny = {
  behavior: 'deny',
  message: `Tool requires permission, but ${DENY_INSTEAD_OF_PROMPTING_REASON}`,
  decisionReason: {
    type: 'other',
    reason: DENY_INSTEAD_OF_PROMPTING_REASON,
  },
} as unknown as PermissionDecision

async function mount(): Promise<{
  root: Awaited<ReturnType<typeof createRoot>>
  canUseTool: CanUseToolFn
}> {
  let queue: ToolUseConfirm[] = []
  const setQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>> =
    update => {
      queue = typeof update === 'function' ? update(queue) : update
    }
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(React.createElement(HookProbe, { setQueue }))
  await Bun.sleep(10)
  if (!canUseTool) throw new Error('useCanUseTool did not mount')
  return { root, canUseTool }
}

function context(): ToolUseContext {
  const appState = getDefaultAppState()
  return {
    options: {
      permissionSessionId: getSessionId(),
      isNonInteractiveSession: false,
      tools: [],
    },
    abortController: new AbortController(),
    getAppState: () => appState,
  } as unknown as ToolUseContext
}

const tool = {
  name: 'SuppressionProbeTool',
  description: async () => 'probe',
  requiresUserInteraction: () => false,
} as unknown as Tool

const assistantMessage = {
  message: { id: 'suppression-message' },
} as unknown as AssistantMessage

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useCanUseTool.suppression.test.tsx')
  canUseTool = undefined
  hookDecision = undefined
})

afterEach(() => {
  releaseSharedMutationLock()
})

test('a suppression denial lets a PermissionRequest hook answer on the interactive path', async () => {
  const { root, canUseTool: fn } = await mount()
  try {
    hookDecision = { behavior: 'allow' }
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-suppression-hook',
      suppressionDeny,
    )
    // The hook gets its chance before the denial stands, matching the
    // headless and structured-IO ordering.
    expect(result.behavior).toBe('allow')
  } finally {
    hookDecision = undefined
    root.unmount()
  }
})

test('the suppression denial stands on the interactive path when no hook decides', async () => {
  const { root, canUseTool: fn } = await mount()
  try {
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-suppression-nohook',
      suppressionDeny,
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('denyInsteadOfPrompting')
    }
  } finally {
    root.unmount()
  }
})

test('a forced ask is suppressed on the interactive path when prompts are disabled', async () => {
  const { root, canUseTool: fn } = await mount()
  denyInsteadOfPrompting = true
  try {
    // The forced ask must pass through suppression before reaching the
    // interactive dialog; this promise resolving at all proves no prompt
    // was enqueued, since nothing here answers one.
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-forced-ask',
      {
        behavior: 'ask',
        message: 'SuppressionProbeTool requires permission',
      } as unknown as PermissionDecision,
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toContain('denyInsteadOfPrompting')
    }
  } finally {
    denyInsteadOfPrompting = false
    root.unmount()
  }
})

test('a forced ask under suppression still lets a PermissionRequest hook answer', async () => {
  const { root, canUseTool: fn } = await mount()
  denyInsteadOfPrompting = true
  hookDecision = { behavior: 'allow' }
  try {
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-forced-ask-hook',
      {
        behavior: 'ask',
        message: 'SuppressionProbeTool requires permission',
      } as unknown as PermissionDecision,
    )
    expect(result.behavior).toBe('allow')
  } finally {
    denyInsteadOfPrompting = false
    hookDecision = undefined
    root.unmount()
  }
})

test('a forced allow passes through unchanged when prompts are disabled', async () => {
  const { root, canUseTool: fn } = await mount()
  denyInsteadOfPrompting = true
  try {
    // Only asks are prompts: a forced allow must not become a suppression
    // denial.
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-forced-allow',
      {
        behavior: 'allow',
        updatedInput: {},
      } as unknown as PermissionDecision,
    )
    expect(result.behavior).toBe('allow')
  } finally {
    denyInsteadOfPrompting = false
    root.unmount()
  }
})

test('a forced deny keeps its reason when prompts are disabled', async () => {
  const { root, canUseTool: fn } = await mount()
  denyInsteadOfPrompting = true
  hookDecision = { behavior: 'allow' }
  try {
    // A forced deny is not a prompt either: suppression must not rewrite
    // its reason, and it must not enter the suppression-denial hook pass
    // that could turn it into an allow.
    const result = await fn(
      tool,
      {},
      context(),
      assistantMessage,
      'interactive-forced-deny',
      {
        behavior: 'deny',
        message: 'denied by host policy',
        decisionReason: { type: 'other', reason: 'host policy' },
      } as unknown as PermissionDecision,
    )
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') {
      expect(result.message).toBe('denied by host policy')
    }
  } finally {
    denyInsteadOfPrompting = false
    hookDecision = undefined
    root.unmount()
  }
})
