/** AI/ML API passwordless onboarding and partner-checkout HTTP client. */

import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'
import {
  AIMLAPI_SOURCE,
  isTrustedAimlapiRequestUrl,
  PARTNER_HEADER_NAME,
  resolvePartnerId,
  SOURCE_HEADER_NAME,
  type AimlapiEndpoints,
} from './config.js'

export type PartnerCheckoutSessionStatus =
  | 'pending_auth'
  | 'pending_payment'
  | 'paid'
  | 'exchanging'
  | 'exchanged'
  | 'cancelled'
  | 'expired'
  | 'failed'

export type PartnerCheckoutSession = {
  id: string
  sessionToken: string
  partnerId: string
  partnerName: string | null
  userId: number | null
  amountUsdMinor: number | null
  status: PartnerCheckoutSessionStatus
  issuedKeyId: string | null
  returnUrl: string | null
}

export type PaymentSession = {
  providerSessionId: string
  payUrl: string | null
}

export type PayResult = {
  checkout: PaymentSession
  partnerCheckout: PartnerCheckoutSession
}

export type TopUpByKeyResult = PayResult

export type ExchangeResult = { apiKey: string; apiKeyId: string }
export type AuthResult = { token: string; exp: number }
export type AccountCheckResult = {
  action: 'sign-in' | 'sign-up'
  provider?: string | null
}
export type CreatedKey = { key: string; id: string }
export type BalanceResult = {
  balance: number
  lowBalance: boolean
  lowBalanceThreshold: number
}

const REQUEST_TIMEOUT_MS = 60_000
const MAX_RESPONSE_BODY_BYTES = 1 << 20

function requestLabel(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return 'aimlapi.com endpoint'
  }
}

function redactRequestSecrets(
  message: string,
  url: string,
  bearer: string | undefined,
  extraSecrets: ReadonlyArray<string | undefined> = [],
): string {
  const secrets = new Set<string>()
  const addSecret = (value: string | undefined): void => {
    const trimmed = value?.trim()
    if (!trimmed) return
    secrets.add(trimmed)
    // A token embedded in a path is percent-encoded, and a backend reflecting a
    // credential usually re-serializes it with JSON.stringify (escaping quotes
    // and backslashes). Redact every form it can appear in.
    secrets.add(encodeURIComponent(trimmed))
    secrets.add(JSON.stringify(trimmed).slice(1, -1))
    try {
      secrets.add(decodeURIComponent(trimmed))
    } catch {
      // Keep the raw value when it is not valid percent-encoding.
    }
  }
  addSecret(bearer)
  for (const extra of extraSecrets) addSecret(extra)
  try {
    // Callers pass every short-lived token through `extraSecrets`, so this scan
    // is only a backstop for opaque ids: length is never relied on for safety.
    // Short segments are route names (`v1`, `keys`) whose redaction would mangle
    // the message without protecting anything.
    for (const segment of new URL(url).pathname.split('/')) {
      if (segment.length < 6) continue
      secrets.add(segment)
      try {
        secrets.add(decodeURIComponent(segment))
      } catch {
        // Keep the encoded segment when it is not valid percent-encoding.
      }
    }
  } catch {
    // The request label already handles malformed URLs without exposing them.
  }
  let redacted = message
  // Longest first: a shorter credential must not redact the prefix of a longer
  // one (`abc` vs `abc123`) and leave the remaining tail exposed.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
}

const PARTNER_CHECKOUT_STATUSES: ReadonlySet<string> = new Set<PartnerCheckoutSessionStatus>([
  'pending_auth',
  'pending_payment',
  'paid',
  'exchanging',
  'exchanged',
  'cancelled',
  'expired',
  'failed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * The checkout `payUrl` is opened in a browser and must be HTTPS — reject a
 * cleartext URL at the response boundary so a session is never retained with an
 * address the flow will only refuse later (matching `announceCheckout`).
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const ACCOUNT_ACTIONS: ReadonlySet<string> = new Set<AccountCheckResult['action']>([
  'sign-in',
  'sign-up',
])

function isAccountCheckResult(value: unknown): value is AccountCheckResult {
  // `action` drives the onboarding branch, so an unsupported value must fail at
  // the boundary instead of crossing it as an impossible typed value.
  return (
    isRecord(value) &&
    typeof value.action === 'string' &&
    ACCOUNT_ACTIONS.has(value.action) &&
    (value.provider === undefined ||
      value.provider === null ||
      typeof value.provider === 'string')
  )
}

function isAuthResult(value: unknown): value is AuthResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value.token) &&
    typeof value.exp === 'number' &&
    Number.isFinite(value.exp)
  )
}

function isCreatedKey(value: unknown): value is CreatedKey {
  return isRecord(value) && isNonEmptyString(value.key) && isNonEmptyString(value.id)
}

function isExchangeResult(value: unknown): value is ExchangeResult {
  return isRecord(value) && isNonEmptyString(value.apiKey) && isNonEmptyString(value.apiKeyId)
}

function isPaymentSession(value: unknown): value is PaymentSession {
  return (
    isRecord(value) &&
    isNonEmptyString(value.providerSessionId) &&
    (value.payUrl === null ||
      (isNonEmptyString(value.payUrl) && isHttpsUrl(value.payUrl)))
  )
}

function isPayResult(value: unknown): value is PayResult {
  // The charge has already been requested by the time this lands, so validate
  // the whole receipt: a non-string `payUrl` would otherwise be opened as a URL,
  // silently fail, and leave the flow polling until it times out.
  return (
    isRecord(value) &&
    isPaymentSession(value.checkout) &&
    isPartnerCheckoutSession(value.partnerCheckout)
  )
}

function isPartnerCheckoutSession(value: unknown): value is PartnerCheckoutSession {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Record<string, unknown>
  return (
    isNonEmptyString(session.id) &&
    isNonEmptyString(session.sessionToken) &&
    isNonEmptyString(session.partnerId) &&
    typeof session.status === 'string' &&
    PARTNER_CHECKOUT_STATUSES.has(session.status) &&
    // Nullable-but-required fields are part of the exported type, so validate
    // them too rather than letting a wrong-typed value cross the boundary.
    isNullableString(session.partnerName) &&
    isNullableFiniteNumber(session.userId) &&
    isNullableFiniteNumber(session.amountUsdMinor) &&
    isNullableString(session.issuedKeyId) &&
    isNullableString(session.returnUrl)
  )
}

function isBalanceResult(value: unknown): value is BalanceResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return (
    typeof result.balance === 'number' &&
    Number.isFinite(result.balance) &&
    typeof result.lowBalance === 'boolean' &&
    typeof result.lowBalanceThreshold === 'number' &&
    Number.isFinite(result.lowBalanceThreshold)
  )
}

class AimlapiResponseTooLargeError extends Error {
  constructor() {
    super(`aimlapi.com response body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes.`)
    this.name = 'AimlapiResponseTooLargeError'
  }
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // Keep the deterministic size-limit error if stream cancellation fails.
        }
        throw new AimlapiResponseTooLargeError()
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export class AimlapiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message)
    this.name = 'AimlapiApiError'
  }
}

export class AimlapiClient {
  constructor(private readonly endpoints: AimlapiEndpoints) {}


  async checkAccount(email: string, signal?: AbortSignal): Promise<AccountCheckResult> {
    const url = `${this.endpoints.authBaseUrl}/v1/auth/account`
    const result = await this.request<unknown>(url, {
      method: 'PATCH',
      body: { email },
      signal,
    })
    if (!isAccountCheckResult(result)) {
      throw new AimlapiApiError(`PATCH ${requestLabel(url)} returned an invalid account response`, 200, '')
    }
    return result
  }

  async sendSignInCode(email: string, signal?: AbortSignal): Promise<void> {
    await this.request<void>(`${this.endpoints.authBaseUrl}/v1/auth/sign-in/code`, {
      method: 'POST',
      body: { email },
      signal,
      expectJson: false,
    })
  }

  async verifySignInCode(
    email: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<AuthResult> {
    const result = await this.request<unknown>(
      `${this.endpoints.authBaseUrl}/v1/auth/sign-in/code/verify`,
      { method: 'POST', body: { email, code }, signal, secrets: [code] },
    )
    if (!isAuthResult(result)) {
      throw new AimlapiApiError('aimlapi.com did not return an auth token.', 200, '')
    }
    return result
  }

  async createPasswordlessAccount(email: string, signal?: AbortSignal): Promise<AuthResult> {
    const result = await this.request<unknown>(
      `${this.endpoints.authBaseUrl}/v1/auth/account/passwordless`,
      { method: 'POST', body: { email }, signal },
    )
    if (!isAuthResult(result)) {
      throw new AimlapiApiError('aimlapi.com did not return an auth token.', 200, '')
    }
    return result
  }

  async createKey(
    bearer: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<CreatedKey> {
    const result = await this.request<unknown>(`${this.endpoints.appBaseUrl}/v1/keys`, {
      method: 'POST',
      bearer,
      body: name.trim() ? { name: name.trim() } : {},
      signal,
    })
    if (!isCreatedKey(result)) {
      throw new AimlapiApiError('aimlapi.com did not return an API key.', 200, '')
    }
    return result
  }

  async getBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceResult> {
    const url = `${this.endpoints.inferenceBaseUrl.replace(/\/+$/, '')}/billing/balance`
    const result = await this.request<unknown>(
      url,
      { method: 'GET', bearer: apiKey, signal },
    )
    if (!isBalanceResult(result)) {
      throw new AimlapiApiError(
        `GET ${requestLabel(url)} returned invalid balance response`,
        200,
        '',
      )
    }
    return result
  }

  async createSession(
    input: { partnerId: string; partnerName?: string | null; returnUrl?: string | null },
    signal?: AbortSignal,
  ): Promise<PartnerCheckoutSession> {
    const url = `${this.endpoints.appBaseUrl}/v3/partner-checkout/sessions`
    const result = await this.request<unknown>(url, {
      method: 'POST',
      body: {
        partnerId: input.partnerId,
        ...(input.partnerName ? { partnerName: input.partnerName } : {}),
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      },
      signal,
    })
    if (!isPartnerCheckoutSession(result)) {
      throw new AimlapiApiError(`POST ${requestLabel(url)} returned an invalid session`, 200, '')
    }
    return result
  }

  async getSession(
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<PartnerCheckoutSession> {
    const url = `${this.endpoints.appBaseUrl}/v3/partner-checkout/sessions/${encodeURIComponent(sessionToken)}`
    const result = await this.request<unknown>(url, {
      method: 'GET',
      signal,
      secrets: [sessionToken],
    })
    // A malformed/empty 200 must not read as an unknown status: that would let
    // callers clear the retained payment identity or take an ambiguous retry.
    // Surface it as a non-terminal error so retained state is preserved.
    if (!isPartnerCheckoutSession(result)) {
      throw new AimlapiApiError(`GET ${requestLabel(url)} returned an invalid session`, 200, '')
    }
    return result
  }

  async pay(
    bearer: string,
    sessionToken: string,
    input: {
      amountUsdMinor: number
      /** Supplied by the passwordless flow to make the charge idempotent. */
      paymentSessionId?: string
      successUrl?: string
      cancelUrl?: string
      autoTopUp?: boolean
    },
    signal?: AbortSignal,
  ): Promise<PayResult> {
    const url = `${this.endpoints.appBaseUrl}/v3/partner-checkout/sessions/${encodeURIComponent(sessionToken)}/pay`
    const result = await this.request<unknown>(url, {
      method: 'POST',
      bearer,
      body: {
        amountUsdMinor: input.amountUsdMinor,
        ...(input.paymentSessionId
          ? { paymentSessionId: input.paymentSessionId }
          : {}),
        // Card is the only supported rail; the backend still expects the field.
        method: 'card',
        ...(input.successUrl ? { successUrl: input.successUrl } : {}),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.autoTopUp ? { autoTopUp: true } : {}),
      },
      signal,
      secrets: [sessionToken],
    })
    if (!isPayResult(result)) {
      throw new AimlapiApiError(`POST ${requestLabel(url)} returned an invalid checkout`, 200, '')
    }
    return result
  }

  async topUpByKey(
    apiKey: string,
    input: {
      sessionToken: string
      amountUsdMinor: number
      paymentSessionId: string
      successUrl?: string
      cancelUrl?: string
      autoTopUp?: boolean
    },
    signal?: AbortSignal,
  ): Promise<TopUpByKeyResult> {
    const inferenceBase = this.endpoints.inferenceBaseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/i, '')
    const url = `${inferenceBase}/v2/billing/topup`
    const result = await this.request<unknown>(url, {
      method: 'POST',
      bearer: apiKey,
      body: {
        sessionToken: input.sessionToken,
        amountUsdMinor: input.amountUsdMinor,
        paymentSessionId: input.paymentSessionId,
        ...(input.successUrl ? { successUrl: input.successUrl } : {}),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
        ...(input.autoTopUp ? { autoTopUp: true } : {}),
      },
      signal,
      secrets: [input.sessionToken],
    })
    if (!isPayResult(result)) {
      throw new AimlapiApiError(`POST ${requestLabel(url)} returned an invalid checkout`, 200, '')
    }
    return result
  }

  async exchange(
    bearer: string,
    sessionToken: string,
    signal?: AbortSignal,
  ): Promise<ExchangeResult> {
    const url = `${this.endpoints.appBaseUrl}/v3/partner-checkout/sessions/${encodeURIComponent(sessionToken)}/exchange`
    const result = await this.request<unknown>(url, {
      method: 'POST',
      bearer,
      signal,
      secrets: [sessionToken],
    })
    if (!isExchangeResult(result)) {
      throw new AimlapiApiError(`POST ${requestLabel(url)} returned an invalid exchange response`, 200, '')
    }
    return result
  }

  private async request<T>(
    url: string,
    options: {
      method: 'GET' | 'POST' | 'PUT' | 'PATCH'
      body?: unknown
      bearer?: string
      signal?: AbortSignal
      expectJson?: boolean
      /**
       * Short-lived tokens this request embeds (path or body). Redacted from
       * every error message and body, independent of their length.
       */
      secrets?: ReadonlyArray<string | undefined>
    },
  ): Promise<T> {
    const label = requestLabel(url)
    const redact = (value: string): string =>
      redactRequestSecrets(value, url, options.bearer, options.secrets)
    // A cancelled request still rethrows the transport error, whose message can
    // carry the request URL and its token. Keep the cancellation identity (the
    // error name, alongside the caller's own signal) but redact the message.
    const redactCancellation = (error: unknown): unknown => {
      if (!(error instanceof Error)) return error
      const redacted = new Error(redact(error.message))
      redacted.name = error.name
      return redacted
    }
    // Both mandatory attribution headers (integration source + partner id) ride
    // on every request to an AI/ML API host — auth, checkout, and the balance
    // probe. The auth/app/pay/inference base URLs are all env-overridable, so a
    // request pointed at a user-controlled proxy must NOT carry OpenClaude's
    // partner/source identity — mirroring the inference/catalog stripping
    // contract in resolveAimlapiAttributionHeaders.
    const headers: Record<string, string> = {
      Accept: 'application/json',
    }
    if (isTrustedAimlapiRequestUrl(url)) {
      headers[SOURCE_HEADER_NAME] = AIMLAPI_SOURCE
      headers[PARTNER_HEADER_NAME] = resolvePartnerId()
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.bearer) headers.Authorization = `Bearer ${options.bearer.trim()}`

    const combined = createCombinedAbortSignal(options.signal, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
    let response: Response
    try {
      response = await fetch(url, {
        method: options.method,
        headers,
        signal: combined.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      })
    } catch (error) {
      combined.cleanup()
      if (options.signal?.aborted) throw redactCancellation(error)
      const reason = redact(error instanceof Error ? error.message : String(error))
      throw new AimlapiApiError(`Network request to ${label} failed: ${reason}`, 0, '')
    }

    let text: string
    try {
      text = await readResponseText(response)
    } catch (error) {
      if (options.signal?.aborted) throw redactCancellation(error)
      if (error instanceof AimlapiResponseTooLargeError) {
        throw new AimlapiApiError(
          `${options.method} ${label} response body exceeds ${MAX_RESPONSE_BODY_BYTES} bytes`,
          response.status,
          '',
        )
      }
      const reason = redact(error instanceof Error ? error.message : String(error))
      throw new AimlapiApiError(`Network response from ${label} failed: ${reason}`, 0, '')
    } finally {
      combined.cleanup()
    }

    if (!response.ok) {
      // A proxy or backend can reflect the bearer or session token in a 4xx/5xx
      // body, and CLI handlers print `body` verbatim — redact before exposing.
      throw new AimlapiApiError(
        `${options.method} ${label} -> ${response.status}`,
        response.status,
        redact(text),
      )
    }
    // The caller opted out of a JSON payload, so any successful body counts as
    // an acknowledgement — including a non-empty plain-text one. Parsing it
    // would fail a request that already delivered the one-time code and push the
    // user into a retry that can invalidate or rate-limit it.
    if (options.expectJson === false) return undefined as T
    if (!text.trim()) {
      throw new AimlapiApiError(
        `${options.method} ${label} returned empty body`,
        response.status,
        '',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AimlapiApiError(
        `${options.method} ${label} returned non-JSON body`,
        response.status,
        redact(text),
      )
    }
    // Every endpoint returns a JSON object. Reject null/non-object bodies here so
    // no method dereferences a null/primitive success payload (which would throw
    // a raw TypeError instead of a controlled, non-terminal error); endpoint
    // guards below still validate structural completeness.
    if (typeof parsed !== 'object' || parsed === null) {
      throw new AimlapiApiError(
        `${options.method} ${label} returned an unexpected body`,
        response.status,
        '',
      )
    }
    return parsed as T
  }
}
