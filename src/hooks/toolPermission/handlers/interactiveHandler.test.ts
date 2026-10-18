import { describe, expect, test, vi } from 'vitest'
import { getSessionId, switchSession } from '../../../bootstrap/state.js'
import { asSessionId } from '../../../types/ids.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  requestAbort,
} from '../../../utils/interruptionTrace.js'
import {
  handleInteractivePermission,
  type InteractivePermissionParams,
} from './interactiveHandler.js'

// Pin the watchdog pause/resume wiring: resume must fire exactly once per
// terminal path (including aborts and setup throws), so a future path that
// bypasses resolveOnce fails here instead of silently stranding the watchdog.

type QueueItem = {
  permissionSessionId?: string
  onAbort: (source?: string, causalEventId?: string) => void
  onAllow: (
    updatedInput: Record<string, unknown>,
    permissionUpdates: unknown[],
    feedback?: string,
  ) => Promise<void>
  onReject: (feedback?: string) => void
}

function setup(opts?: {
  preAbort?: boolean
  throwOnPush?: boolean
  bridge?: unknown
  permissionSessionId?: string
  awaitAutomatedChecksBeforeDialog?: boolean
  hookDecision?: Promise<{ behavior: 'allow' } | null>
}) {
  // Plain (non-idempotent) spy: a double-call fails the exactly-once assertions,
  // so the handler can't lean on QueryGuard's internal idempotence.
  const resume = vi.fn()
  const beginUserInteraction = vi.fn(() => resume)
  let queueItem: QueueItem | undefined

  const abortController = new AbortController()
  if (opts?.preAbort) abortController.abort()

  const ctx = {
    tool: { name: 'Bash', requiresUserInteraction: () => false },
    input: {},
    assistantMessage: { message: { id: 'msg-1' } },
    toolUseID: 'tu-1',
    toolUseContext: {
      options: opts?.permissionSessionId
        ? { permissionSessionId: opts.permissionSessionId }
        : {},
      queryActivity: {
        registerActivity: vi.fn(),
        acquireLease: vi.fn(() => ({ id: '', release() {} })),
        beginUserInteraction,
      },
      abortController,
      getAppState: () => ({
        toolPermissionContext: { mode: 'default' },
        mcp: { clients: [] },
      }),
    },
    pushToQueue: vi.fn((item: QueueItem) => {
      if (opts?.throwOnPush) throw new Error('setup boom')
      queueItem = item
    }),
    removeFromQueue: vi.fn(),
    updateQueueItem: vi.fn(),
    logDecision: vi.fn(),
    logCancelled: vi.fn(),
    handleUserAllow: vi.fn(async () => ({ behavior: 'allow' })),
    cancelAndAbort: vi.fn(() => ({ behavior: 'deny' })),
    buildAllow: vi.fn((input: Record<string, unknown>) => ({
      behavior: 'allow',
      updatedInput: input,
    })),
    persistPermissions: vi.fn(),
    runHooks: vi.fn(async () => opts?.hookDecision?.then(result => result) ?? null),
  }

  const resolve = vi.fn()
  const params = {
    ctx,
    description: 'desc',
    result: { behavior: 'ask' },
    // Skip the async hook/classifier races so only the dialog callbacks resolve.
    awaitAutomatedChecksBeforeDialog:
      opts?.awaitAutomatedChecksBeforeDialog ?? true,
    bridgeCallbacks: opts?.bridge,
    channelCallbacks: undefined,
  } as unknown as InteractivePermissionParams

  let thrownError: unknown
  try {
    handleInteractivePermission(params, resolve)
  } catch (e) {
    thrownError = e
  }

  return {
    ctx,
    resume,
    beginUserInteraction,
    resolve,
    abortController,
    thrownError,
    getQueueItem: () => queueItem as QueueItem,
  }
}

describe('handleInteractivePermission watchdog suspension', () => {
  test('tags the queued prompt with its originating session', () => {
    const { getQueueItem } = setup({ permissionSessionId: 'session-a' })
    expect(getQueueItem().permissionSessionId).toBe('session-a')
  })

  test('suspends once when the dialog is shown, before any resolution', () => {
    const { beginUserInteraction, resume } = setup()
    expect(beginUserInteraction).toHaveBeenCalledTimes(1)
    expect(resume).not.toHaveBeenCalled()
  })

  test('resumes exactly once on allow', async () => {
    const { getQueueItem, resume, resolve } = setup()
    await getQueueItem().onAllow({}, [])
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes exactly once on reject', () => {
    const { getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('no thanks')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes exactly once on abort', () => {
    const { ctx, getQueueItem, resume, resolve } = setup()
    getQueueItem().onAbort('cancel_keybinding', 'input-event-1')
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(ctx.cancelAndAbort).toHaveBeenCalledWith(
      undefined,
      true,
      undefined,
      {
        source: 'cancel_keybinding',
        causalEventId: 'input-event-1',
      },
    )
  })

  test('resumes only once when two resolution paths race', async () => {
    const { getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('first')
    await getQueueItem().onAllow({}, []) // loses the claim
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes before awaiting post-approval async work', () => {
    const { ctx, getQueueItem, resume } = setup()
    let releaseAllow: (() => void) | undefined
    ctx.handleUserAllow = vi.fn(
      () =>
        new Promise(res => {
          releaseAllow = () => res({ behavior: 'allow' })
        }),
    )
    void getQueueItem().onAllow({}, []) // handleUserAllow stays pending
    expect(resume).toHaveBeenCalledTimes(1)
    releaseAllow?.()
  })

  test('resumes even when allow processing throws', async () => {
    const { ctx, getQueueItem, resume } = setup()
    ctx.handleUserAllow = vi.fn(async () => {
      throw new Error('persist failed')
    })
    await expect(getQueueItem().onAllow({}, [])).rejects.toThrow('persist failed')
    expect(resume).toHaveBeenCalledTimes(1)
  })

  test('resolves, resumes, and dequeues when aborted outside the dialog callbacks', () => {
    const { ctx, abortController, resume, resolve } = setup()
    expect(resume).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    abortController.abort()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    // Stale prompt must be removed from the queue on external abort.
    expect(ctx.removeFromQueue).toHaveBeenCalledTimes(1)
  })

  test('preserves the originating trace when an external abort closes the dialog', async () => {
    const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    __resetInterruptionTraceForTests()
    const { ctx, abortController } = setup()

    try {
      requestAbort(abortController, undefined, {
        source: 'cancel_keybinding',
        subsystem: 'query_engine',
        controllerRole: 'query-root',
      })

      const trace = __getInterruptionTraceSnapshotForTests()
      const originatingAbort = trace.find(
        entry =>
          entry.event === 'abort.requested' &&
          entry.source === 'cancel_keybinding',
      )
      const permissionResolution = trace.find(
        entry => entry.event === 'permission.abort_resolved',
      )
      expect(typeof originatingAbort?.eventId).toBe('string')
      expect(permissionResolution).toMatchObject({
        source: 'cancel_keybinding',
        subsystem: 'tool_permission',
        causalEventId: originatingAbort!.eventId,
        outcome: 'denied',
      })
      expect(ctx.cancelAndAbort).toHaveBeenCalledWith(
        undefined,
        true,
        undefined,
        {
          source: 'cancel_keybinding',
          causalEventId: originatingAbort!.eventId,
        },
      )
    } finally {
      await __waitForInterruptionTraceFlushForTests()
      __resetInterruptionTraceForTests()
      if (originalTrace === undefined) {
        delete process.env.OPENCLAUDE_INTERRUPT_TRACE
      } else {
        process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
      }
    }
  })

  test('resolves and resumes immediately if already aborted when shown', () => {
    const { ctx, resume, resolve } = setup({ preAbort: true })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    // Must not enqueue a prompt that is immediately stale.
    expect(ctx.pushToQueue).not.toHaveBeenCalled()
  })

  test('cancels the remote bridge prompt on external abort', () => {
    const bridge = {
      sendRequest: vi.fn(),
      onResponse: vi.fn(() => () => {}),
      cancelRequest: vi.fn(),
      sendResponse: vi.fn(),
    }
    const { abortController } = setup({ bridge })
    abortController.abort()
    expect(bridge.cancelRequest).toHaveBeenCalledTimes(1)
  })

  test('routes bridge approval through final user-allow revalidation', async () => {
    let respond:
      | ((response: {
          behavior: 'allow'
          updatedInput: Record<string, unknown>
          updatedPermissions: unknown[]
        }) => Promise<void>)
      | undefined
    const bridge = {
      sendRequest: vi.fn(),
      onResponse: vi.fn(
        (
          _requestId: string,
          callback: NonNullable<typeof respond>,
        ) => {
          respond = callback
          return () => {}
        },
      ),
      cancelRequest: vi.fn(),
      sendResponse: vi.fn(),
    }
    const { ctx, resolve } = setup({ bridge })
    ctx.handleUserAllow = vi.fn(async () => ({
      behavior: 'deny',
      message: 'Plan mode is read-only.',
    }))

    await respond?.({
      behavior: 'allow',
      updatedInput: { command: 'touch blocked' },
      updatedPermissions: [],
    })

    expect(ctx.handleUserAllow).toHaveBeenCalledWith(
      { command: 'touch blocked' },
      [],
      undefined,
      expect.any(Number),
      undefined,
      undefined,
      true,
    )
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'deny' }),
    )
  })

  test('retains an owner prompt when a stale local action arrives in another session', async () => {
    const ownerSessionId = getSessionId()
    const { ctx, getQueueItem, resolve } = setup({
      permissionSessionId: ownerSessionId,
    })

    try {
      switchSession(asSessionId('inactive-owner-test-session'))
      await getQueueItem().onAllow({}, [])
      getQueueItem().onReject('stale rejection')

      expect(resolve).not.toHaveBeenCalled()
      expect(ctx.handleUserAllow).not.toHaveBeenCalled()

      switchSession(ownerSessionId)
      await getQueueItem().onAllow({}, [])
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(ctx.handleUserAllow).toHaveBeenCalledTimes(1)
    } finally {
      switchSession(ownerSessionId)
    }
  })

  test('settles an exact bridge response even when the prompt owner is hidden', async () => {
    const ownerSessionId = getSessionId()
    let respond:
      | ((response: {
          behavior: 'allow'
          updatedInput: Record<string, unknown>
          updatedPermissions: unknown[]
        }) => Promise<void>)
      | undefined
    const bridge = {
      sendRequest: vi.fn(),
      onResponse: vi.fn(
        (
          _requestId: string,
          callback: NonNullable<typeof respond>,
        ) => {
          respond = callback
          return () => {}
        },
      ),
      cancelRequest: vi.fn(),
      sendResponse: vi.fn(),
    }
    const { ctx, getQueueItem, resolve } = setup({
      bridge,
      permissionSessionId: ownerSessionId,
    })

    try {
      switchSession(asSessionId('inactive-bridge-owner-test-session'))
      await respond?.({
        behavior: 'allow',
        updatedInput: { command: 'touch deferred' },
        updatedPermissions: [],
      })
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(ctx.handleUserAllow).toHaveBeenCalledWith(
        { command: 'touch deferred' },
        [],
        undefined,
        expect.any(Number),
        undefined,
        undefined,
        true,
      )
      expect(getQueueItem()).toBeDefined()
    } finally {
      switchSession(ownerSessionId)
    }
  })

  test('settles an owner-scoped hook that finishes after its owner becomes inactive', async () => {
    const ownerSessionId = getSessionId()
    let finishHook: ((decision: { behavior: 'allow' }) => void) | undefined
    const hookDecision = new Promise<{ behavior: 'allow' }>(resolve => {
      finishHook = resolve
    })
    const { getQueueItem, resolve } = setup({
      permissionSessionId: ownerSessionId,
      awaitAutomatedChecksBeforeDialog: false,
      hookDecision,
    })

    try {
      switchSession(asSessionId('inactive-hook-owner-test-session'))
      finishHook?.({ behavior: 'allow' })
      await Bun.sleep(10)
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(getQueueItem()).toBeDefined()
    } finally {
      switchSession(ownerSessionId)
    }
  })

  test('abort after a normal resolution does not double-resolve or double-resume', () => {
    const { abortController, getQueueItem, resume, resolve } = setup()
    getQueueItem().onReject('no')
    abortController.abort()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  test('resumes, rethrows, and cleans up if dialog setup throws synchronously', () => {
    const { ctx, abortController, resume, resolve, thrownError } = setup({
      throwOnPush: true,
    })
    expect(thrownError).toBeInstanceOf(Error)
    expect((thrownError as Error).message).toBe('setup boom')
    expect(resume).toHaveBeenCalledTimes(1)
    // catch path dequeues the (partially) pushed prompt...
    expect(ctx.removeFromQueue).toHaveBeenCalled()
    // ...and detaches the abort listener, so a later abort cannot re-fire it.
    const resolveCallsBefore = resolve.mock.calls.length
    abortController.abort()
    expect(resolve.mock.calls.length).toBe(resolveCallsBefore)
  })
})
