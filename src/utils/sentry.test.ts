import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

const ORIGINAL_SENTRY_DSN = process.env.SENTRY_DSN
const ORIGINAL_DISABLE_TELEMETRY = process.env.DISABLE_TELEMETRY

beforeEach(() => {
  delete process.env.SENTRY_DSN
  delete process.env.DISABLE_TELEMETRY
})

afterEach(() => {
  if (ORIGINAL_SENTRY_DSN === undefined) {
    delete process.env.SENTRY_DSN
  } else {
    process.env.SENTRY_DSN = ORIGINAL_SENTRY_DSN
  }
  if (ORIGINAL_DISABLE_TELEMETRY === undefined) {
    delete process.env.DISABLE_TELEMETRY
  } else {
    process.env.DISABLE_TELEMETRY = ORIGINAL_DISABLE_TELEMETRY
  }
  mock.restore()
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

test('reportErrorToSentry only reports TelemetrySafeError, never a raw Error message', async () => {
  process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0'

  const captureMessage = mock(() => {})
  mock.module('@sentry/node', () => ({
    init: mock(() => {}),
    captureMessage,
  }))

  const { initializeSentry, reportErrorToSentry } = await import('./sentry.js')
  const { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS: TelemetrySafeError } =
    await import('./errors.js')

  await initializeSentry()

  // A plain Error must never be reported — its message may contain file paths.
  reportErrorToSentry(new Error('raw error with /some/file/path'))
  expect(captureMessage).not.toHaveBeenCalled()

  // A TelemetrySafeError reports only its sanitized telemetryMessage.
  reportErrorToSentry(
    new TelemetrySafeError('full message with /some/file/path', 'sanitized message'),
  )
  expect(captureMessage).toHaveBeenCalledWith('sanitized message', 'error')
})