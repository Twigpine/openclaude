import assert from 'node:assert/strict'
import { jest } from 'bun:test'
import * as Sentry from '@sentry/node'
import { snapshotEnv } from '../envSnapshot.js'
import { gracefulShutdown, resetShutdownState } from '../../utils/gracefulShutdown.js'
import { initializeSentry } from '../../utils/sentry.js'

const mode = process.argv[2]
const restoreEnv = snapshotEnv([
  'NODE_ENV',
  'SENTRY_DSN',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
], { clear: true })
const originalExit = process.exit
const exitError = new Error('mocked process exit')
let exitCode: number | undefined
let flushCalls = 0
let flushTimeout: number | undefined
let flushed = false
let flushedBeforeExit = false
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

  process.exit = ((code?: number) => {
    exitCode = code
    flushedBeforeExit = flushed
    throw exitError
  }) as typeof process.exit

  const shutdown = gracefulShutdown(7).catch(error => {
    if (error !== exitError) throw error
  })
  if (mode === 'enabled' || mode === 'blocked') {
    await Promise.race([
      flushStarted,
      shutdown.then(() => { throw new Error('exited without flushing Sentry') }),
    ])
    assert.equal(exitCode, undefined, 'shutdown must wait for flush')
    jest.advanceTimersByTime(1999)
    // Let an incorrectly early deadline propagate through the awaited helpers.
    for (let i = 0; i < 5; i++) await Promise.resolve()
    assert.equal(exitCode, undefined, 'flush deadline must not expire early')
    if (mode === 'enabled') releaseFlush()
    else jest.advanceTimersByTime(1)
  }
  await shutdown
  console.log(JSON.stringify({ flushCalls, flushTimeout, exitCode, flushedBeforeExit }))
} finally {
  jest.useRealTimers()
  process.exit = originalExit
  process.exitCode = 0
  resetShutdownState()
  restoreEnv()
}
