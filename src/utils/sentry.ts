/**
 * Optional, env-driven Sentry error reporting.
 *
 * Disabled by default. Enabled only when SENTRY_DSN is set AND telemetry
 * is not disabled via DISABLE_TELEMETRY / CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
 *
 * Only TelemetrySafeError.telemetryMessage (never raw error.message) is sent,
 * to avoid leaking file paths or other PII into Sentry.
 */
import { isTelemetryDisabled } from './privacyLevel.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS as TelemetrySafeError } from './errors.js'

let sentryInitialized = false
let sentryModule: typeof import('@sentry/node') | null = null

export function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN) && !isTelemetryDisabled()
}

/**
 * Lazily initializes Sentry. No-op if SENTRY_DSN is unset or telemetry is disabled.
 * Safe to call multiple times; only initializes once. Async because @sentry/node
 * is loaded via dynamic import — this bundle is ESM and does not define require().
 */
export async function initializeSentry(): Promise<void> {
  if (sentryInitialized || !isSentryEnabled()) {
    return
  }
  sentryInitialized = true

  try {
    // Dynamic import so @sentry/node is never loaded (or its startup cost
    // paid) when the feature is off, and so it works under ESM where
    // require() is not defined.
    sentryModule = await import('@sentry/node')
    sentryModule.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? 'production',
      tracesSampleRate: 0,
      // Disable Sentry's automatic uncaughtException/unhandledRejection
      // integrations. Those hooks report raw error content, bypassing the
      // TelemetrySafeError sanitization in reportErrorToSentry(). Only
      // explicit reportErrorToSentry() calls should ever send data.
      defaultIntegrations: false,
    })
  } catch {
    // Never let Sentry setup crash the CLI.
    sentryModule = null
  }
}

/**
 * Reports an error to Sentry if enabled. Only sends the sanitized
 * telemetryMessage for TelemetrySafeError instances. Errors that are not
 * TelemetrySafeError are NOT reported, since their raw message may contain
 * file paths or other PII — never send an implicit raw error message.
 */
export function reportErrorToSentry(error: unknown): void {
  if (!sentryModule || !isSentryEnabled()) {
    return
  }

  try {
    if (error instanceof TelemetrySafeError) {
      sentryModule.captureMessage(error.telemetryMessage, 'error')
    }
    // Non-TelemetrySafeError errors are intentionally not reported — their
    // message has not been vetted as safe to send.
  } catch {
    // Reporting must never throw.
  }
}