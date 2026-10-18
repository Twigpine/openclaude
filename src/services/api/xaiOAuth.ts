/**
 * xAI OAuth service.
 *
 * Two flows supported, mirroring openclaw's reference implementation:
 *
 * 1. Authorization code + PKCE with a loopback redirect on 127.0.0.1:56121.
 *    Best UX on a developer's own machine.
 * 2. Device code — for remote/VPS hosts where you can't open a browser.
 *
 * After completion the access token is sent as a Bearer to api.x.ai/v1 —
 * the same code path as `XAI_API_KEY`. The OAuth-issued credential is just
 * a refreshable substitute for the API key.
 */

import { randomBytes } from 'node:crypto'

import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../oauth/crypto.js'
import {
  startXaiOAuthCallback,
  type XaiOAuthCallbackHandle,
} from './xaiOAuthCallback.js'
import {
  asTrimmedString,
  deriveExpiresMsFromJwt,
  fetchXaiOAuthDiscovery,
  getXaiOAuthCallbackHost,
  getXaiOAuthCallbackPort,
  getXaiOAuthClientId,
  getXaiOAuthRedirectUri,
  requireTrustedXaiOAuthEndpoint,
  XAI_DEVICE_CODE_GRANT_TYPE,
  XAI_OAUTH_CALLBACK_PATH,
  XAI_OAUTH_REFERRER,
  XAI_OAUTH_SCOPE,
} from './xaiOAuthShared.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'

const XAI_OAUTH_FETCH_TIMEOUT_MS = 30_000
const XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const XAI_DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000

export type XaiOAuthTokens = {
  accessToken: string
  refreshToken: string
  idToken?: string
  expiresAt?: number
  tokenEndpoint: string
  email?: string
  displayName?: string
  accountId?: string
}

export type XaiDeviceCode = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  expiresInMs: number
  intervalMs: number
}

type XaiTokenResponse = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number | string
  token_type?: string
}

type XaiErrorResponse = {
  error?: string
  error_description?: string
}

function readErrorMessage(
  context: string,
  status: number,
  body: unknown,
): string {
  const json = (body ?? {}) as XaiErrorResponse
  const err = asTrimmedString(json.error)
  const desc = asTrimmedString(json.error_description)
  if (err && desc) return `${context} failed (${status}): ${err} (${desc})`
  if (err) return `${context} failed (${status}): ${err}`
  return `${context} failed (${status})`
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function normalizeExpiresAt(
  expiresIn: unknown,
  now: number,
): number | undefined {
  const seconds =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string'
        ? Number.parseFloat(expiresIn)
        : Number.NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return now + seconds * 1000
}

function decodeJwt(token: string | undefined): Record<string, unknown> {
  if (!token) return {}
  const part = token.split('.')[1]
  if (!part) return {}
  try {
    const json = Buffer.from(part, 'base64url').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function extractIdentity(tokens: { idToken?: string; accessToken: string }): {
  email?: string
  displayName?: string
  accountId?: string
} {
  const payload = decodeJwt(tokens.idToken ?? tokens.accessToken)
  return {
    email: asTrimmedString(payload.email),
    displayName: asTrimmedString(payload.name),
    accountId: asTrimmedString(payload.sub),
  }
}

function parseTokenResponse(
  body: unknown,
  tokenEndpoint: string,
  options: {
    requireRefreshToken?: boolean
    previousRefreshToken?: string
  } = {},
): XaiOAuthTokens {
  const json = (body ?? {}) as XaiTokenResponse
  const accessToken = asTrimmedString(json.access_token)
  if (!accessToken) {
    throw new Error('xAI OAuth token response is missing access_token')
  }
  const refreshToken =
    asTrimmedString(json.refresh_token) ?? options.previousRefreshToken
  if (options.requireRefreshToken && !refreshToken) {
    throw new Error(
      'xAI OAuth token response is missing refresh_token. The offline_access scope may have been rejected.',
    )
  }
  const idToken = asTrimmedString(json.id_token)
  const now = Date.now()
  // RFC 6749 expires_in is preferred; fall back to the access-token JWT exp
  // so callers get an absolute expiry even when xAI omits expires_in. The
  // id-token exp reflects OIDC session lifetime, not the access token, so we
  // don't use it here.
  const expiresAt =
    normalizeExpiresAt(json.expires_in, now) ??
    deriveExpiresMsFromJwt(accessToken)
  const identity = extractIdentity({ idToken, accessToken })
  return {
    accessToken,
    refreshToken: refreshToken ?? '',
    ...(idToken ? { idToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    tokenEndpoint,
    ...identity,
  }
}

function buildXaiAuthorizeUrl(params: {
  authorizationEndpoint: string
  state: string
  nonce: string
  codeChallenge: string
  redirectUri: string
}): string {
  const url = new URL(
    requireTrustedXaiOAuthEndpoint(
      params.authorizationEndpoint,
      'authorization endpoint',
    ),
  )
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', getXaiOAuthClientId())
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', XAI_OAUTH_SCOPE)
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('plan', 'generic')
  url.searchParams.set('referrer', XAI_OAUTH_REFERRER)
  return url.toString()
}

async function exchangeXaiToken(params: {
  tokenEndpoint: string
  body: Record<string, string>
  context: string
  requireRefreshToken?: boolean
  previousRefreshToken?: string
  signal?: AbortSignal
}): Promise<XaiOAuthTokens> {
  const { signal, cleanup } = createCombinedAbortSignal(params.signal, {
    timeoutMs: XAI_OAUTH_FETCH_TIMEOUT_MS,
  })
  try {
    const response = await fetch(
      requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, 'token endpoint'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(params.body).toString(),
        signal,
      },
    )
    const body = await readJson(response)
    if (!response.ok) {
      throw new Error(readErrorMessage(params.context, response.status, body))
    }
    return parseTokenResponse(body, params.tokenEndpoint, {
      requireRefreshToken: params.requireRefreshToken,
      previousRefreshToken: params.previousRefreshToken,
    })
  } finally {
    cleanup()
  }
}

type XaiOAuthServiceOptions = {
  callbackPort?: number
  callbackHost?: string
  startCallbackServer?: typeof startXaiOAuthCallback
}

export type XaiOAuthFlowHandle = {
  /** The authorize URL the user must open in a browser. */
  authUrl: string
  /**
   * Resolves with tokens once xAI completes the flow — either by hitting the
   * loopback redirect or by the caller providing the code via
   * `submitManualCode`.
   */
  waitForTokens: () => Promise<XaiOAuthTokens>
  /**
   * Recover from a failed loopback push. xAI's auth page shows the user a
   * code when its CORS push to the loopback fails; pass that code here to
   * complete the flow without a redirect.
   */
  submitManualCode: (code: string) => void
  cancel: () => void
}

export class XaiOAuthService {
  private callbackHandle: XaiOAuthCallbackHandle | null = null
  private tokenAbortController: AbortController | null = null
  private manualResolver: ((code: string) => void) | null = null
  private manualRejecter: ((error: Error) => void) | null = null
  private cancellationError: Error | null = null

  constructor(private readonly options: XaiOAuthServiceOptions = {}) {}

  private buildCancellationError(): Error {
    return this.cancellationError ?? new Error('xAI OAuth flow was cancelled.')
  }

  /**
   * Begin the OAuth flow. Returns a handle the caller can use to start the
   * browser, wait for tokens, or recover with a manual code paste.
   *
   * The loopback callback server stays open until tokens are obtained, the
   * caller submits a manual code, or `cancel()` is invoked. CORS preflight
   * from `auth.x.ai` is echoed so xAI's browser-side fetch can reach us.
   * Callbacks with missing or mismatched state leave the login pending.
   */
  async beginOAuthFlow(): Promise<XaiOAuthFlowHandle> {
    // Reset cross-flow state so a reused service instance starts clean.
    this.cancellationError = null

    const discovery = await fetchXaiOAuthDiscovery()
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    const state = generateState()
    const nonce = randomBytes(16).toString('hex')
    const callbackPort =
      this.options.callbackPort ?? getXaiOAuthCallbackPort()
    const callbackHost =
      this.options.callbackHost ?? getXaiOAuthCallbackHost()
    const startCallback =
      this.options.startCallbackServer ?? startXaiOAuthCallback

    let callbackHandle: XaiOAuthCallbackHandle
    try {
      callbackHandle = await startCallback({
        port: callbackPort,
        host: callbackHost,
        callbackPath: XAI_OAUTH_CALLBACK_PATH,
        expectedState: state,
        successTitle: 'xAI OAuth complete',
      })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code === 'EADDRINUSE') {
        throw new Error(
          `xAI OAuth needs ${callbackHost}:${callbackPort} for its callback. Close the app using that port (or use device-code login) and try again.`,
        )
      }
      throw error
    }
    this.callbackHandle = callbackHandle

    const redirectUri = `http://${callbackHost}:${callbackHandle.port}${XAI_OAUTH_CALLBACK_PATH}`
    const authUrl = buildXaiAuthorizeUrl({
      authorizationEndpoint: discovery.authorizationEndpoint,
      state,
      nonce,
      codeChallenge,
      redirectUri,
    })

    // Manual paste path: a separate promise that resolves with the code if
    // the user pastes one (recovery when the loopback CORS push fails).
    // Reject path so cleanup() can actively unblock callers waiting on
    // waitForTokens — otherwise cancel() would hang forever.
    type ManualOutcome = { kind: 'code'; code: string }
    let manualResolver: ((outcome: ManualOutcome) => void) | null = null
    let manualRejecter: ((error: Error) => void) | null = null
    const manualPromise = new Promise<ManualOutcome>((resolve, reject) => {
      manualResolver = resolve
      manualRejecter = reject
    })
    this.manualResolver = (code: string) => manualResolver?.({ kind: 'code', code })
    this.manualRejecter = manualRejecter

    const waitForTokens = async (): Promise<XaiOAuthTokens> => {
      // Wrap the loopback promise so its rejection after the manual path wins
      // (e.g. server closed by cleanup) is swallowed instead of bubbling as
      // an unhandledRejection.
      const callbackOutcome: Promise<ManualOutcome | null> = callbackHandle
        .waitForCallback()
        .then(result => {
          if (result.state !== state) {
            throw new Error('xAI OAuth callback returned a mismatched state.')
          }
          return { kind: 'code', code: result.code } as ManualOutcome
        })
      // Ensure no unhandledRejection if the loopback rejects after we've
      // already resolved via manual paste.
      callbackOutcome.catch(() => undefined)

      const outcome = await Promise.race([callbackOutcome, manualPromise])
      if (!outcome) {
        throw new Error('xAI OAuth produced no authorization code.')
      }

      const tokenAbortController = new AbortController()
      this.tokenAbortController = tokenAbortController
      try {
        return await exchangeXaiToken({
          tokenEndpoint: discovery.tokenEndpoint,
          context: 'xAI OAuth token exchange',
          requireRefreshToken: true,
          signal: tokenAbortController.signal,
          body: {
            grant_type: 'authorization_code',
            code: outcome.code,
            redirect_uri: redirectUri,
            client_id: getXaiOAuthClientId(),
            code_verifier: codeVerifier,
            // xAI re-validates these PKCE fields at token exchange.
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
          },
        })
      } finally {
        if (this.tokenAbortController === tokenAbortController) {
          this.tokenAbortController = null
        }
        this.cleanup()
      }
    }

    return {
      authUrl,
      waitForTokens,
      submitManualCode: (code: string) => {
        const trimmed = code.trim()
        if (!trimmed) return
        // Manual paste skips state validation by design: in xAI's OOB
        // recovery flow the user reads the code directly from auth.x.ai
        // (not an attacker-controlled redirect), and PKCE + one-shot codes
        // prevent the code from being redeemed by anyone without our
        // code_verifier. The redirect_uri at exchange is the same one xAI
        // bound the code to, so a swapped code fails the exchange.
        this.manualResolver?.(trimmed)
        this.manualResolver = null
        this.manualRejecter = null
      },
      cancel: () => {
        this.cancellationError = new Error('xAI OAuth flow was cancelled.')
        this.cleanup()
      },
    }
  }

  /**
   * Legacy callback-style entry point — kicks off the flow, opens the
   * browser via `authUrlHandler`, and returns tokens. No manual-code
   * recovery; use `beginOAuthFlow` for richer UX.
   */
  async startOAuthFlow(
    authUrlHandler: (authUrl: string) => Promise<void>,
  ): Promise<XaiOAuthTokens> {
    const handle = await this.beginOAuthFlow()
    await authUrlHandler(handle.authUrl)
    return handle.waitForTokens()
  }

  cleanup(): void {
    const cancellation = this.buildCancellationError()
    this.tokenAbortController?.abort(cancellation)
    this.tokenAbortController = null
    // Actively reject any pending waitForTokens — without this a `cancel()`
    // mid-flight (or component unmount) would leave the promise hanging
    // forever because Promise.race never settles.
    this.manualRejecter?.(cancellation)
    this.manualRejecter = null
    this.manualResolver = null
    this.callbackHandle?.close()
    this.callbackHandle = null
  }
}

export async function requestXaiDeviceCode(options?: {
  signal?: AbortSignal
}): Promise<{ code: XaiDeviceCode; tokenEndpoint: string }> {
  const discovery = await fetchXaiOAuthDiscovery({ signal: options?.signal })
  if (!discovery.deviceAuthorizationEndpoint) {
    throw new Error(
      'xAI OAuth discovery did not advertise a device authorization endpoint.',
    )
  }
  const { signal, cleanup } = createCombinedAbortSignal(options?.signal, {
    timeoutMs: XAI_OAUTH_FETCH_TIMEOUT_MS,
  })
  try {
    const response = await fetch(
      requireTrustedXaiOAuthEndpoint(
        discovery.deviceAuthorizationEndpoint,
        'device authorization endpoint',
      ),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: getXaiOAuthClientId(),
          scope: XAI_OAUTH_SCOPE,
        }).toString(),
        signal,
      },
    )
    const body = await readJson(response)
    if (!response.ok) {
      throw new Error(
        readErrorMessage('xAI device code request', response.status, body),
      )
    }
    const json = (body ?? {}) as Record<string, unknown>
    const deviceCode = asTrimmedString(json.device_code)
    const userCode = asTrimmedString(json.user_code)
    const verificationUri = asTrimmedString(json.verification_uri)
    const verificationUriComplete = asTrimmedString(
      json.verification_uri_complete,
    )
    if (!deviceCode || !userCode || !verificationUri) {
      throw new Error(
        'xAI device code response missing device_code, user_code, or verification_uri',
      )
    }
    const expiresIn =
      typeof json.expires_in === 'number'
        ? json.expires_in
        : typeof json.expires_in === 'string'
          ? Number.parseFloat(json.expires_in)
          : Number.NaN
    const interval =
      typeof json.interval === 'number'
        ? json.interval
        : typeof json.interval === 'string'
          ? Number.parseFloat(json.interval)
          : Number.NaN
    return {
      code: {
        deviceCode,
        userCode,
        verificationUri: requireTrustedXaiOAuthEndpoint(
          verificationUri,
          'device verification URI',
        ),
        ...(verificationUriComplete
          ? {
              verificationUriComplete: requireTrustedXaiOAuthEndpoint(
                verificationUriComplete,
                'complete device verification URI',
              ),
            }
          : {}),
        expiresInMs: Number.isFinite(expiresIn) && expiresIn > 0
          ? expiresIn * 1000
          : 5 * 60 * 1000,
        intervalMs: Number.isFinite(interval) && interval > 0
          ? interval * 1000
          : XAI_DEVICE_CODE_DEFAULT_INTERVAL_MS,
      },
      tokenEndpoint: discovery.tokenEndpoint,
    }
  } finally {
    cleanup()
  }
}

export async function pollXaiDeviceCode(params: {
  deviceCode: XaiDeviceCode
  tokenEndpoint: string
  signal?: AbortSignal
}): Promise<XaiOAuthTokens> {
  const deadline = Date.now() + params.deviceCode.expiresInMs
  let intervalMs = params.deviceCode.intervalMs

  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      throw new Error('xAI device authorization was cancelled.')
    }
    const { signal, cleanup } = createCombinedAbortSignal(params.signal, {
      timeoutMs: XAI_OAUTH_FETCH_TIMEOUT_MS,
    })
    let body: unknown
    let status: number
    try {
      const response = await fetch(
        requireTrustedXaiOAuthEndpoint(params.tokenEndpoint, 'token endpoint'),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body: new URLSearchParams({
            grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
            client_id: getXaiOAuthClientId(),
            device_code: params.deviceCode.deviceCode,
          }).toString(),
          signal,
        },
      )
      status = response.status
      body = await readJson(response)
      if (response.ok) {
        return parseTokenResponse(body, params.tokenEndpoint, {
          requireRefreshToken: true,
        })
      }
    } finally {
      cleanup()
    }

    const error = asTrimmedString(
      ((body ?? {}) as XaiErrorResponse).error,
    )
    if (error === 'authorization_pending') {
      await sleep(Math.max(intervalMs, XAI_DEVICE_CODE_MIN_INTERVAL_MS))
      continue
    }
    if (error === 'slow_down') {
      intervalMs += XAI_DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(intervalMs)
      continue
    }
    if (error === 'access_denied' || error === 'authorization_denied') {
      throw new Error('xAI device authorization was denied.')
    }
    if (error === 'expired_token') {
      throw new Error('xAI device code expired. Re-run the login.')
    }
    throw new Error(readErrorMessage('xAI device token exchange', status, body))
  }
  throw new Error('xAI device authorization timed out.')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function refreshXaiAccessToken(params: {
  refreshToken: string
  tokenEndpoint: string
  signal?: AbortSignal
}): Promise<XaiOAuthTokens> {
  return exchangeXaiToken({
    tokenEndpoint: params.tokenEndpoint,
    context: 'xAI OAuth refresh',
    signal: params.signal,
    // Some OAuth servers omit refresh_token on a refresh response (the same
    // refresh token stays valid). Carry it forward so callers never get an
    // empty refreshToken back from a successful refresh.
    previousRefreshToken: params.refreshToken,
    body: {
      grant_type: 'refresh_token',
      client_id: getXaiOAuthClientId(),
      refresh_token: params.refreshToken,
    },
  })
}
