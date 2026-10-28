import { afterEach, beforeEach, expect, test } from 'bun:test'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { snapshotEnv } from '../test/envSnapshot.js'

let restoreEnv: () => void

beforeEach(() => {
  restoreEnv = snapshotEnv([
    'SENTRY_DSN',
    'DISABLE_TELEMETRY',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  ], { clear: true })
})

afterEach(() => {
  restoreEnv()
})

test('isSentryEnabled is false when SENTRY_DSN is unset', async () => {
  const { isSentryEnabled } = await import('./sentry.js')
  expect(isSentryEnabled()).toBe(false)
})

test('isSentryEnabled is true when SENTRY_DSN is set and telemetry is not disabled', async () => {
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
  const { isSentryEnabled } = await import('./sentry.js')
  expect(isSentryEnabled()).toBe(true)
})

test('isSentryEnabled is false when SENTRY_DSN is set but DISABLE_TELEMETRY is set', async () => {
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
  process.env.DISABLE_TELEMETRY = '1'
  const { isSentryEnabled } = await import('./sentry.js')
  expect(isSentryEnabled()).toBe(false)
})

test('isSentryEnabled is false when SENTRY_DSN is set but CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set', async () => {
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const { isSentryEnabled } = await import('./sentry.js')
  expect(isSentryEnabled()).toBe(false)
})

test('reportErrorToSentry does not throw when Sentry is disabled', async () => {
  const { reportErrorToSentry } = await import('./sentry.js')
  const { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: TelemetrySafeError } =
    await import('./errors.js')

  expect(() =>
    reportErrorToSentry(
      new TelemetrySafeError('full message with /some/file/path', 'sanitized message'),
    ),
  ).not.toThrow()
})

test('reportErrorToSentry does not throw for a plain (non-sanitized) Error', async () => {
  const { reportErrorToSentry } = await import('./sentry.js')

  expect(() =>
    reportErrorToSentry(new Error('raw error with /some/file/path')),
  ).not.toThrow()
})

test('reportErrorToSentry only reports sanitized messages without stacks using the real SDK', async () => {
  // A fresh process avoids shared SDK state and module mocks from other tests.
  // Leave time for the child deadline and reading its output during cleanup.
  const child = Bun.spawn([process.execPath, '--eval', `
    import * as Sentry from '@sentry/node'
    import { flushSentry, initializeSentry, reportErrorToSentry } from '${new URL('./sentry.ts', import.meta.url).href}'
    import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as TelemetrySafeError } from '${new URL('./errors.ts', import.meta.url).href}'

    await initializeSentry()
    const client = Sentry.getClient()
    if (!client) throw new Error('SDK was not initialized')
    const transport = client.getTransport()
    if (!transport) throw new Error('SDK transport was not initialized')
    const events = []
    // Inspect outgoing envelopes without sending any network requests.
    transport.send = async envelope => {
      for (const [header, event] of envelope[1]) {
        if (header.type === 'event') events.push(event)
      }
      return { statusCode: 200 }
    }
    reportErrorToSentry(new Error('raw error with /some/file/path'))
    reportErrorToSentry(new TelemetrySafeError('full message with /some/file/path', 'sanitized message'))
    await flushSentry()
    const options = client.getOptions()
    console.log(JSON.stringify({ events, integrations: options.integrations.map(i => i.name), tracesSampleRate: options.tracesSampleRate }))
    await Sentry.close(1000)
  `], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, SENTRY_DSN: 'https://example@o0.ingest.sentry.io/0' },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  const result = JSON.parse(stdout)
  expect(result.integrations).toEqual([])
  expect(result.tracesSampleRate).toBeUndefined()
  expect(result.events).toHaveLength(1)
  expect(result.events[0].message).toBe('sanitized message')
  expect(result.events[0].level).toBe('error')
  expect(result.events[0].exception).toBeUndefined()
  expect(result.events[0].stacktrace).toBeUndefined()
  expect(result.events[0].user).toBeUndefined()
  expect(result.events[0].request).toBeUndefined()
  expect(result.events[0].server_name).toBeUndefined()
  expect(result.events[0].hostname).toBeUndefined()
  expect(stdout).not.toContain(hostname())
  expect(stdout).not.toContain('/some/file/path')
}, 15_000)
