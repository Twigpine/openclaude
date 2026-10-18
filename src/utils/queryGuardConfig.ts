import {
  DEFAULT_QUERY_IDLE_TIMEOUT_MS,
} from './QueryGuard.js'
import type {
  QueryGuardMetadata,
  QueryGuardStart,
} from './queryLifecycle.js'

export const OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV =
  'OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS'
export const OPENCLAUDE_QUERY_HARD_MAX_MS_ENV =
  'OPENCLAUDE_QUERY_HARD_MAX_MS'

// setTimeout-compatible upper bound; larger values can overflow timer APIs.
export const MAX_CONFIGURABLE_QUERY_HARD_MAX_MS = 0x7fffffff

/** Preset values offered in `/config` (plus any current custom value). */
export const QUERY_IDLE_TIMEOUT_OPTIONS_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  15 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
] as const

type EnvLike = Record<string, string | undefined>
type DebugLogger = (
  message: string,
  options?: { level: 'warn' },
) => void

export type QueryGuardResolvedOptions = {
  idleTimeoutMs?: number
  hardMaxQueryMs?: number
}

type QueryStartGuard = {
  setIdleTimeoutMs(timeoutMs: number): boolean
  tryStart(metadata: QueryGuardMetadata): QueryGuardStart | null
}

function warnInvalidQueryTimeout(
  envName: string,
  defaultDescription: string,
  value: string,
  reason: string,
  log: DebugLogger,
): void {
  log(
    `${envName} invalid value "${value}" (${reason}); using default ${defaultDescription}`,
    { level: 'warn' },
  )
}

function defaultWarnLogger(message: string): void {
  console.warn(`[OpenClaude] ${message}`)
}

/** Normalize a persisted query idle timeout, preserving the five-minute default. */
export function normalizeQueryIdleTimeoutMs(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.trim())
        : Number.NaN

  return Number.isSafeInteger(parsed) &&
    parsed > 0 &&
    parsed <= MAX_CONFIGURABLE_QUERY_HARD_MAX_MS
    ? parsed
    : DEFAULT_QUERY_IDLE_TIMEOUT_MS
}

/** Format a `/config` option without losing custom millisecond precision. */
export function formatQueryIdleTimeoutMs(value: unknown): string {
  const timeoutMs = normalizeQueryIdleTimeoutMs(value)
  if (timeoutMs % 60_000 === 0) return `${timeoutMs / 60_000} min`
  if (timeoutMs % 1_000 === 0) return `${timeoutMs / 1_000} sec`
  return `${timeoutMs} ms`
}

/** Parse a human-readable `/config` option back into milliseconds. */
export function parseQueryIdleTimeoutOption(value: string): number {
  const match = /^(\d+)\s+(min|sec|ms)$/.exec(value.trim())
  if (!match) return DEFAULT_QUERY_IDLE_TIMEOUT_MS

  const amount = Number(match[1])
  const multiplier = match[2] === 'min' ? 60_000 : match[2] === 'sec' ? 1_000 : 1
  return normalizeQueryIdleTimeoutMs(amount * multiplier)
}

/**
 * Resolve the current environment override, or the persisted `/config`
 * preference when the environment does not own this setting. Invalid,
 * non-empty environment values select the default and never fall through to
 * the saved preference.
 */
export function getConfiguredQueryIdleTimeoutMs(
  env: EnvLike,
  configuredValue: unknown,
  log: DebugLogger = defaultWarnLogger,
): number {
  if (env[OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV]?.trim()) {
    return (
      getPositiveTimeoutFromEnv(
        env,
        OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV,
        'query idle timeout',
        log,
      ) ?? DEFAULT_QUERY_IDLE_TIMEOUT_MS
    )
  }
  return normalizeQueryIdleTimeoutMs(configuredValue)
}

/** Apply the current preference before atomically starting the next query. */
export function tryStartQueryWithConfiguredIdleTimeout(
  queryGuard: QueryStartGuard,
  metadata: QueryGuardMetadata,
  env: EnvLike,
  configuredValue: unknown,
): QueryGuardStart | null {
  const configuredIdleTimeoutMs = getConfiguredQueryIdleTimeoutMs(
    env,
    configuredValue,
  )
  queryGuard.setIdleTimeoutMs(configuredIdleTimeoutMs)
  return queryGuard.tryStart(metadata)
}

function getPositiveTimeoutFromEnv(
  env: EnvLike,
  envName: string,
  defaultDescription: string,
  log: DebugLogger,
): number | undefined {
  const raw = env[envName]
  const value = raw?.trim()
  if (!value) {
    return undefined
  }

  if (!/^\d+$/.test(value)) {
    warnInvalidQueryTimeout(
      envName,
      defaultDescription,
      value,
      'expected a positive integer in milliseconds',
      log,
    )
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    warnInvalidQueryTimeout(
      envName,
      defaultDescription,
      value,
      'expected a positive finite integer',
      log,
    )
    return undefined
  }

  if (parsed > MAX_CONFIGURABLE_QUERY_HARD_MAX_MS) {
    warnInvalidQueryTimeout(
      envName,
      defaultDescription,
      value,
      `maximum is ${MAX_CONFIGURABLE_QUERY_HARD_MAX_MS}`,
      log,
    )
    return undefined
  }

  return parsed
}

export function getQueryGuardOptionsFromEnv(
  env: EnvLike = process.env,
  log: DebugLogger = defaultWarnLogger,
): QueryGuardResolvedOptions {
  const idleTimeoutMs = getPositiveTimeoutFromEnv(
    env,
    OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS_ENV,
    'query idle timeout',
    log,
  )
  const hardMaxQueryMs = getPositiveTimeoutFromEnv(
    env,
    OPENCLAUDE_QUERY_HARD_MAX_MS_ENV,
    'query hard max',
    log,
  )

  return {
    ...(idleTimeoutMs !== undefined && { idleTimeoutMs }),
    ...(hardMaxQueryMs !== undefined && { hardMaxQueryMs }),
  }
}
