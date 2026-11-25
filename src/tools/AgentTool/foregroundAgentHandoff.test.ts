import { describe, expect, test } from 'bun:test'
import { createPermissionSessionStateGetter } from '../../hooks/toolPermission/permissionSessionOwnership.js'
import { asSessionId } from '../../types/ids.js'
import {
  closeForegroundAgentForBackground,
  createForegroundAgentAbortController,
  getReplAgentConcurrencyBudget,
  REPL_FOREGROUND_AGENT_CONCURRENCY_CAP,
  resolveReplAgentConcurrencyBudget,
} from './foregroundAgentHandoff.js'

describe('foreground agent background handoff', () => {
  test('aborts the outgoing execution before closing its iterator', async () => {
    const parent = new AbortController()
    const foreground = createForegroundAgentAbortController(parent)
    let wasAbortedWhenCloseStarted = false

    await closeForegroundAgentForBackground(foreground, async () => {
      wasAbortedWhenCloseStarted = foreground.signal.aborted
    })

    expect(wasAbortedWhenCloseStarted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })

  test('still propagates a parent interruption to the foreground execution', () => {
    const parent = new AbortController()
    const foreground = createForegroundAgentAbortController(parent)

    parent.abort('user-cancel')

    expect(foreground.signal.aborted).toBe(true)
    expect(foreground.signal.reason).toBe('user-cancel')
  })

  test('preserves ordinary foreground abort propagation to the parent', () => {
    const parent = new AbortController()
    const foreground = createForegroundAgentAbortController(parent)

    foreground.abort('permission-rejected')

    expect(parent.signal.aborted).toBe(true)
    expect(parent.signal.reason).toBe('permission-rejected')
  })

  test('keeps the spawning permission snapshot across a delayed restart', async () => {
    const parent = new AbortController()
    const foreground = createForegroundAgentAbortController(parent)
    let releaseClose: (() => void) | undefined
    let closeStarted: (() => void) | undefined
    const closeStartedPromise = new Promise<void>(resolve => {
      closeStarted = resolve
    })
    const closeGate = new Promise<void>(resolve => {
      releaseClose = resolve
    })
    let activeSessionId = asSessionId('session-a')
    let liveAppState = { mode: 'default' }
    let liveRootState = { mode: 'dontAsk' }
    const permissionSessionState = {
      appState: liveAppState,
      rootAppState: liveRootState,
    }

    const closePromise = closeForegroundAgentForBackground(
      foreground,
      async () => {
        closeStarted?.()
        await closeGate
      },
    )
    await closeStartedPromise

    activeSessionId = asSessionId('session-b')
    liveAppState = { mode: 'fullAccess' }
    liveRootState = { mode: 'fullAccess' }
    releaseClose?.()
    await closePromise

    const getOriginAppState = createPermissionSessionStateGetter(
      asSessionId('session-a'),
      permissionSessionState.appState,
      () => liveAppState,
      () => activeSessionId,
    )
    const getOriginRootState = createPermissionSessionStateGetter(
      asSessionId('session-a'),
      permissionSessionState.rootAppState,
      () => liveRootState,
      () => activeSessionId,
    )

    expect(getOriginAppState()).toEqual({ mode: 'default' })
    expect(getOriginRootState()).toEqual({ mode: 'dontAsk' })

    activeSessionId = asSessionId('session-a')
    liveAppState = { mode: 'acceptEdits' }
    liveRootState = { mode: 'acceptEdits' }
    expect(getOriginAppState()).toEqual({ mode: 'acceptEdits' })
    expect(getOriginRootState()).toEqual({ mode: 'acceptEdits' })
  })
})

describe('repl agent concurrency budget', () => {
  test('caps concurrent acquisitions at the shared limit and fails fast', () => {
    const tracker = { begin: () => {}, end: () => {} }
    const budget = getReplAgentConcurrencyBudget(tracker)
    expect(budget.cap).toBe(REPL_FOREGROUND_AGENT_CONCURRENCY_CAP)

    for (let i = 0; i < REPL_FOREGROUND_AGENT_CONCURRENCY_CAP; i += 1) {
      budget.tryAcquire()
    }
    expect(() => budget.tryAcquire()).toThrow(/concurrency limit/)
  })

  test('keys the budget by tracker identity', () => {
    const trackerA = { begin: () => {}, end: () => {} }
    const trackerB = { begin: () => {}, end: () => {} }

    expect(getReplAgentConcurrencyBudget(trackerA)).toBe(
      getReplAgentConcurrencyBudget(trackerA),
    )
    expect(getReplAgentConcurrencyBudget(trackerA)).not.toBe(
      getReplAgentConcurrencyBudget(trackerB),
    )
  })

  test('release reopens a slot for a later acquisition', () => {
    const tracker = { begin: () => {}, end: () => {} }
    const budget = getReplAgentConcurrencyBudget(tracker)

    for (let i = 0; i < REPL_FOREGROUND_AGENT_CONCURRENCY_CAP; i += 1) {
      budget.tryAcquire()
    }
    budget.release()
    expect(() => budget.tryAcquire()).not.toThrow()
  })

  test('release underflow is ignored instead of inflating the budget', () => {
    const tracker = { begin: () => {}, end: () => {} }
    const budget = getReplAgentConcurrencyBudget(tracker)

    budget.release()
    budget.release()
    for (let i = 0; i < REPL_FOREGROUND_AGENT_CONCURRENCY_CAP; i += 1) {
      budget.tryAcquire()
    }
    expect(() => budget.tryAcquire()).toThrow(/concurrency limit/)
  })

  test('resolve prefers the pinned budget over the tracker lookup', () => {
    const tracker = { begin: () => {}, end: () => {} }
    const pinned = {
      cap: 8,
      tryAcquire: () => {},
      release: () => {},
    }

    expect(
      resolveReplAgentConcurrencyBudget({
        replAgentConcurrencyBudget: pinned,
        replPromptWaitTracker: tracker,
      }),
    ).toBe(pinned)
    expect(resolveReplAgentConcurrencyBudget({ replPromptWaitTracker: tracker })).toBe(
      getReplAgentConcurrencyBudget(tracker),
    )
    expect(resolveReplAgentConcurrencyBudget({})).toBeUndefined()
  })
})
