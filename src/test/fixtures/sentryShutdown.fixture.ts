import assert from 'node:assert/strict'
import { jest, spyOn } from 'bun:test'
import * as Sentry from '@sentry/node'
import { snapshotEnv } from '../envSnapshot.js'
import {
  getPendingShutdownForTesting,
  gracefulShutdown,
  gracefulShutdownSync,
  resetShutdownState,
} from '../../utils/gracefulShutdown.js'
import { initializeSentry } from '../../utils/sentry.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { sleep } from '../../utils/sleep.js'

const mode = process.argv[2]
const restoreEnv = snapshotEnv([
  'NODE_ENV',
  'SENTRY_DSN',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS',
], { clear: true })
const originalExit = process.exit
const exitError = new Error('mocked process exit')
let exitCode: number | undefined
let flushCalls = 0
let flushTimeout: number | undefined
let flushed = false
let flushedBeforeExit = false
let unregisterCleanup: (() => void) | undefined
let restoreHooks: (() => void) | undefined
let sessionEndHooksStarted = false
let notifyExit!: () => void
const exitObserved = new Promise<void>(resolve => { notifyExit = resolve })
let notifyFlushStarted!: () => void
const flushStarted = new Promise<void>(resolve => { notifyFlushStarted = resolve })
let releaseFlush!: () => void
const pendingFlush = new Promise<boolean>(resolve => {
  releaseFlush = () => {
    flushed = true
    resolve(true)
  }
})

try {
  process.env.NODE_ENV = 'test'
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
  await initializeSentry()
  const client = Sentry.getClient()
  assert(client, 'SDK was not initialized')
  // Keep the real SDK and application modules, replacing only the flush I/O.
  // No events are sent to the network in this fixture.
  client.flush = timeout => {
    flushCalls++
    flushTimeout = timeout
    if (mode === 'enabled' || mode === 'blocked') jest.useFakeTimers()
    notifyFlushStarted()
    if (mode === 'throws') throw new Error('flush threw')
    if (mode === 'rejects') return Promise.reject(new Error('flush rejected'))
    return pendingFlush
  }
  if (mode === 'dsn-unset') delete process.env.SENTRY_DSN
  if (mode === 'telemetry-disabled') process.env.DISABLE_TELEMETRY = '1'
  if (mode === 'nonessential-disabled') {
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  }
  if (mode === 'default-budget') {
    const hooks = await import('../../utils/hooks.js')
    assert.equal(hooks.getSessionEndHookTimeoutMs(), 1500)
    // Consume the real cleanup and default hook budgets before the Sentry drain.
    const hookSpy = spyOn(hooks, 'executeSessionEndHooks')
      .mockImplementation(() => sleep(1500))
    restoreHooks = () => { hookSpy.mockRestore() }
    unregisterCleanup = registerCleanup(() => sleep(2000))
    jest.useFakeTimers()
  }
  if (mode === 'failsafe' || mode === 'sync-rejection') {
    const hooks = await import('../../utils/hooks.js')
    if (mode === 'failsafe') {
      // A hook that ignores its abort signal leaves only the failsafe able to exit.
      const hookSpy = spyOn(hooks, 'executeSessionEndHooks').mockImplementation(() => {
        sessionEndHooksStarted = true
        return new Promise<void>(() => {})
      })
      restoreHooks = () => { hookSpy.mockRestore() }
    } else {
      // Fail before the failsafe is armed or the normal-path flush can run.
      const timeoutSpy = spyOn(hooks, 'getSessionEndHookTimeoutMs').mockImplementation(() => {
        throw new Error('shutdown setup failed')
      })
      restoreHooks = () => { timeoutSpy.mockRestore() }
    }
    jest.useFakeTimers()
  }

  process.exit = ((code?: number) => {
    exitCode = code
    flushedBeforeExit = flushed
    notifyExit()
    // The failsafe runs in an async timer callback; avoid an unhandled rejection.
    if (mode === 'failsafe') return undefined as never
    throw exitError
  }) as typeof process.exit

  let shutdown: Promise<void>
  if (mode === 'sync-rejection') {
    gracefulShutdownSync(7)
    const pending = getPendingShutdownForTesting()
    assert(pending, 'sync shutdown must expose its catch-handler completion')
    shutdown = pending
  } else {
    shutdown = gracefulShutdown(7).catch(error => {
      if (error !== exitError) throw error
    })
  }
  if (mode === 'failsafe') {
    // Drive the actual armed timer while the normal shutdown stays in its hook.
    for (let elapsed = 0; elapsed < 10_000 && flushCalls === 0; elapsed += 10) {
      jest.advanceTimersByTime(10)
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    assert(sessionEndHooksStarted, 'normal shutdown must be stuck in its hook')
    assert.equal(flushCalls, 1, 'failsafe must begin a Sentry drain')
  }
  if (mode === 'default-budget') {
    // Advance through shutdown until the normal-path flush signals readiness.
    // Yield between ticks so each awaited shutdown stage can schedule its timers.
    for (let elapsed = 0; elapsed < 5000 && flushCalls === 0; elapsed += 10) {
      jest.advanceTimersByTime(10)
      for (let i = 0; i < 20; i++) await Promise.resolve()
    }
    assert.equal(flushCalls, 1, 'normal-path Sentry flush must start')
    assert.equal(exitCode, undefined, 'shutdown must wait for flush')
    // Cross the old 5s failsafe deadline while the normal flush is still pending.
    jest.advanceTimersByTime(1999)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(flushCalls, 1, 'failsafe must not start another flush during the normal drain')
    assert.equal(exitCode, undefined, 'shutdown must not exit before the normal flush finishes')
    releaseFlush()
  }
  if (mode === 'enabled' || mode === 'blocked' || mode === 'failsafe' || mode === 'sync-rejection') {
    await Promise.race([
      flushStarted,
      shutdown.then(() => { throw new Error('exited without flushing Sentry') }),
    ])
    assert.equal(exitCode, undefined, 'shutdown must wait for flush')
    jest.advanceTimersByTime(1999)
    // Let an incorrectly early deadline propagate through the awaited helpers.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(exitCode, undefined, 'flush deadline must not expire early')
    if (mode === 'blocked') jest.advanceTimersByTime(1)
    else releaseFlush()
  }
  // The failsafe exits despite the deliberately hung hook in normal shutdown.
  if (mode === 'failsafe') await exitObserved
  else await shutdown
  console.log(JSON.stringify({ flushCalls, flushTimeout, exitCode, flushedBeforeExit }))
} finally {
  unregisterCleanup?.()
  restoreHooks?.()
  jest.useRealTimers()
  process.exit = originalExit
  process.exitCode = 0
  resetShutdownState()
  restoreEnv()
}
