/**
 * Persistent storage and auto-refresh for xAI OAuth credentials.
 *
 * Modeled after `codexCredentials.ts`. Stores tokens via secure storage so
 * they survive across sessions. Refreshes proactively when the access token
 * is within ~60s of expiry.
 */

import { isBareMode } from './envUtils.js'
import { getSecureStorage } from './secureStorage/index.js'
import {
  asTrimmedString,
  decodeJwtPayload,
  deriveExpiresMsFromJwt,
} from '../services/api/xaiOAuthShared.js'
import {
  refreshXaiAccessToken,
  type XaiOAuthTokens,
} from '../services/api/xaiOAuth.js'

export const XAI_STORAGE_KEY = 'xai' as const
const XAI_TOKEN_REFRESH_SKEW_MS = 60_000
const XAI_TOKEN_REFRESH_RETRY_COOLDOWN_MS = 60_000
const XAI_CREDENTIAL_CACHE_TTL_MS = 30_000

export type XaiCredentialBlob = {
  accessToken: string
  refreshToken: string
  // An opaque, persisted cache namespace. Unlike a bearer or a rotated refresh
  // token, it remains stable for the lifetime of one OAuth login.
  cacheIdentity?: string
  idToken?: string
  expiresAt?: number
  tokenEndpoint: string
  email?: string
  displayName?: string
  accountId?: string
  lastRefreshAt?: number
  lastRefreshFailureAt?: number
}

let inFlightXaiRefresh:
  | Promise<{ refreshed: boolean; credentials?: XaiCredentialBlob }>
  | null = null
let inMemoryLastRefreshFailureAt: number | null = null
let cachedXaiCredentials: XaiCredentialBlob | undefined
let cachedXaiCredentialsAt = 0
let xaiCredentialsGeneration = 0
let inFlightXaiCredentialRead: Promise<XaiCredentialBlob | undefined> | null =
  null

function getXaiSecureStorage() {
  return getSecureStorage({ allowPlainTextFallback: false })
}

function normalizeXaiCredentialBlob(
  value: unknown,
): XaiCredentialBlob | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const accessToken = asTrimmedString(record.accessToken)
  const refreshToken = asTrimmedString(record.refreshToken)
  const tokenEndpoint = asTrimmedString(record.tokenEndpoint)
  if (!accessToken || !refreshToken || !tokenEndpoint) return undefined
  return {
    accessToken,
    refreshToken,
    cacheIdentity: asTrimmedString(record.cacheIdentity),
    tokenEndpoint,
    idToken: asTrimmedString(record.idToken),
    email: asTrimmedString(record.email),
    displayName: asTrimmedString(record.displayName),
    accountId: asTrimmedString(record.accountId),
    expiresAt:
      typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt)
        ? record.expiresAt
        : undefined,
    lastRefreshAt:
      typeof record.lastRefreshAt === 'number' &&
      Number.isFinite(record.lastRefreshAt)
        ? record.lastRefreshAt
        : undefined,
    lastRefreshFailureAt:
      typeof record.lastRefreshFailureAt === 'number' &&
      Number.isFinite(record.lastRefreshFailureAt)
        ? record.lastRefreshFailureAt
        : undefined,
  }
}

function cacheXaiCredentials(
  credentials: XaiCredentialBlob | undefined,
): XaiCredentialBlob | undefined {
  cachedXaiCredentials = credentials
  cachedXaiCredentialsAt = credentials ? Date.now() : 0
  xaiCredentialsGeneration++
  return credentials
}

function hasFreshCachedXaiCredentials(): boolean {
  return (
    cachedXaiCredentials !== undefined &&
    Date.now() - cachedXaiCredentialsAt < XAI_CREDENTIAL_CACHE_TTL_MS
  )
}

// This is deliberately memory-only: callers on synchronous request-planning
// paths can use a recently loaded OAuth identity without blocking on keychain,
// libsecret, or Credential Locker I/O.
export function getCachedXaiCredentials(): XaiCredentialBlob | undefined {
  return hasFreshCachedXaiCredentials() ? cachedXaiCredentials : undefined
}

export function getXaiDiscoveryCacheIdentity(
  credentials: XaiCredentialBlob | undefined,
): string | undefined {
  return (
    credentials?.cacheIdentity ??
    credentials?.accountId ??
    credentials?.refreshToken ??
    credentials?.accessToken
  )
}

function effectiveExpiresAt(blob: XaiCredentialBlob): number | undefined {
  return blob.expiresAt ?? deriveExpiresMsFromJwt(blob.accessToken)
}

function shouldRefreshXaiToken(blob: XaiCredentialBlob): boolean {
  const expiresAt = effectiveExpiresAt(blob)
  if (expiresAt === undefined) return false
  return expiresAt <= Date.now() + XAI_TOKEN_REFRESH_SKEW_MS
}

function isWithinRefreshFailureCooldown(
  blob: XaiCredentialBlob,
  now = Date.now(),
): boolean {
  const lastFailure = Math.max(
    blob.lastRefreshFailureAt ?? 0,
    inMemoryLastRefreshFailureAt ?? 0,
  )
  if (!lastFailure) return false
  return now - lastFailure < XAI_TOKEN_REFRESH_RETRY_COOLDOWN_MS
}

export function readXaiCredentials(): XaiCredentialBlob | undefined {
  if (isBareMode()) return undefined
  const cached = getCachedXaiCredentials()
  if (cached) return cached
  try {
    const data = getXaiSecureStorage().read()
    const credentials = normalizeXaiCredentialBlob(data?.[XAI_STORAGE_KEY])
    return credentials ? cacheXaiCredentials(credentials) : undefined
  } catch {
    return undefined
  }
}

export async function readXaiCredentialsAsync(): Promise<
  XaiCredentialBlob | undefined
> {
  if (isBareMode()) return undefined
  const cached = getCachedXaiCredentials()
  if (cached) return cached
  if (inFlightXaiCredentialRead) {
    return inFlightXaiCredentialRead
  }

  const generation = xaiCredentialsGeneration
  const read = getXaiSecureStorage()
    .readAsync()
    .then(data => {
      const credentials = normalizeXaiCredentialBlob(data?.[XAI_STORAGE_KEY])
      if (generation !== xaiCredentialsGeneration) {
        return getCachedXaiCredentials()
      }
      return credentials ? cacheXaiCredentials(credentials) : undefined
    })
    .catch(() => undefined)

  inFlightXaiCredentialRead = read
  void read.finally(() => {
    if (inFlightXaiCredentialRead === read) {
      inFlightXaiCredentialRead = null
    }
  })
  return read
}

export function saveXaiCredentials(
  blob: XaiCredentialBlob,
): { success: boolean; warning?: string } {
  if (isBareMode()) {
    return {
      success: false,
      warning: 'Bare mode: secure storage is disabled.',
    }
  }
  const normalized = normalizeXaiCredentialBlob(blob)
  if (!normalized) {
    return { success: false, warning: 'xAI credentials are incomplete.' }
  }
  const storage = getXaiSecureStorage()
  const previous = storage.read() || {}
  const next = {
    ...(previous as Record<string, unknown>),
    [XAI_STORAGE_KEY]: {
      ...normalized,
      lastRefreshAt: normalized.lastRefreshAt ?? Date.now(),
    },
  }
  const result = storage.update(next as typeof previous)
  if (result.success) {
    const stored = normalizeXaiCredentialBlob(next[XAI_STORAGE_KEY])
    cacheXaiCredentials(stored)
    inMemoryLastRefreshFailureAt = stored?.lastRefreshFailureAt ?? null
  }
  return result
}

export function clearXaiCredentials(): {
  success: boolean
  warning?: string
} {
  if (isBareMode()) return { success: true }
  const storage = getXaiSecureStorage()
  const previous = storage.read() || {}
  const next = { ...(previous as Record<string, unknown>) }
  delete next[XAI_STORAGE_KEY]
  const result = storage.update(next as typeof previous)
  if (result.success) {
    cacheXaiCredentials(undefined)
    inMemoryLastRefreshFailureAt = null
  }
  return result
}

function persistRefreshFailure(
  blob: XaiCredentialBlob,
  occurredAt: number,
): void {
  const result = saveXaiCredentials({
    ...blob,
    lastRefreshFailureAt: occurredAt,
  })
  if (!result.success) inMemoryLastRefreshFailureAt = occurredAt
}

function toBlob(
  tokens: XaiOAuthTokens,
  previous?: XaiCredentialBlob,
  options?: { preserveCacheIdentity?: boolean },
): XaiCredentialBlob {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken || previous?.refreshToken || '',
    cacheIdentity: options?.preserveCacheIdentity
      ? getXaiDiscoveryCacheIdentity(previous)
      : tokens.accountId ?? tokens.refreshToken,
    tokenEndpoint: tokens.tokenEndpoint,
    idToken: tokens.idToken ?? previous?.idToken,
    email: tokens.email ?? previous?.email,
    displayName: tokens.displayName ?? previous?.displayName,
    accountId: tokens.accountId ?? previous?.accountId,
    expiresAt: tokens.expiresAt,
    lastRefreshAt: Date.now(),
  }
}

export function persistXaiOAuthTokens(
  tokens: XaiOAuthTokens,
): { success: boolean; warning?: string } {
  return saveXaiCredentials(toBlob(tokens, readXaiCredentials()))
}

export async function refreshXaiAccessTokenIfNeeded(options?: {
  force?: boolean
}): Promise<{ refreshed: boolean; credentials?: XaiCredentialBlob }> {
  if (isBareMode()) return { refreshed: false }

  const current = await readXaiCredentialsAsync()
  if (!current) return { refreshed: false }
  if (!current.refreshToken) return { refreshed: false, credentials: current }
  if (!options?.force && !shouldRefreshXaiToken(current)) {
    return { refreshed: false, credentials: current }
  }
  if (!options?.force && isWithinRefreshFailureCooldown(current)) {
    return { refreshed: false, credentials: current }
  }
  if (inFlightXaiRefresh) return inFlightXaiRefresh

  inFlightXaiRefresh = (async () => {
    const attemptedAt = Date.now()
    try {
      const tokens = await refreshXaiAccessToken({
        refreshToken: current.refreshToken,
        tokenEndpoint: current.tokenEndpoint,
      })
      const next = toBlob(tokens, current, { preserveCacheIdentity: true })
      const save = saveXaiCredentials(next)
      if (!save.success) {
        throw new Error(
          save.warning ??
            'xAI token refresh succeeded but credentials could not be saved.',
        )
      }
      return { refreshed: true, credentials: next }
    } catch (error) {
      persistRefreshFailure(current, attemptedAt)
      throw error
    } finally {
      inFlightXaiRefresh = null
    }
  })()

  return inFlightXaiRefresh
}

/**
 * Resolve a usable xAI Bearer access token. Returns undefined if no
 * credentials are stored or if a refresh is needed but failed.
 */
export async function resolveXaiAccessToken(): Promise<string | undefined> {
  if (isBareMode()) return undefined
  try {
    const { credentials } = await refreshXaiAccessTokenIfNeeded()
    const blob = credentials ?? (await readXaiCredentialsAsync())
    return blob?.accessToken
  } catch {
    const blob = await readXaiCredentialsAsync()
    return blob?.accessToken
  }
}

// Exported only for tests/debugging.
export function _decodeAccessTokenPayload(
  blob: XaiCredentialBlob,
): Record<string, unknown> | undefined {
  return decodeJwtPayload(blob.accessToken)
}
