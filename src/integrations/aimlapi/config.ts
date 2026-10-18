/**
 * AI/ML API (aimlapi.com) integration - endpoint configuration.
 *
 * Wires OpenClaude to the AI/ML API "partner checkout" flow so a user can log
 * in, top up their balance, and have the issued key written back into
 * OpenClaude's provider profile automatically. Usage attributes to the Twigpine
 * rebate partner (see the partner id below).
 *
 * Override any single URL via the corresponding `AIMLAPI_*_URL` env var.
 */

export type AimlapiEndpoints = {
  /** app/auth service - mints the user access (Bearer) token. */
  authBaseUrl: string
  /** app/gateway BFF - hosts `/v3/partner-checkout/*`. */
  appBaseUrl: string
  /** hosted checkout frontend base URL (return URLs redirect here). */
  payBaseUrl: string
  /** OpenAI-compatible inference base URL written into the provider profile. */
  inferenceBaseUrl: string
  /** browser landing page after checkout / consent completes. */
  verificationBaseUrl: string
}

const DEFAULT_ENDPOINTS: AimlapiEndpoints = {
  authBaseUrl: 'https://auth.aimlapi.com',
  appBaseUrl: 'https://app.aimlapi.com',
  payBaseUrl: 'https://pay.aimlapi.com',
  inferenceBaseUrl: 'https://api.aimlapi.com/v1',
  verificationBaseUrl: 'https://aimlapi.com/app',
}

/**
 * Partner id (`^part_[A-Za-z0-9]{1,64}$`) - rebate attribution. Must EXACTLY
 * match an active row in the backend `rebate_partners` table. This is the
 * Twigpine partner that all OpenClaude AI/ML API usage is credited to; it is the
 * same value sent as the `X-AIMLAPI-Partner-ID` inference header (see
 * `integrations/gateways/aimlapi.ts`).
 */
export const DEFAULT_PARTNER_ID = 'part_62yQoGYDq4Yqnrj2R1iGrDNJ'
export const DEFAULT_PARTNER_NAME = 'Twigpine'
export const PARTNER_HEADER_NAME = 'X-AIMLAPI-Partner-ID'
export const SOURCE_HEADER_NAME = 'X-AIMLAPI-Source'
export const INTEGRATION_REPO_HEADER_NAME = 'X-AIMLAPI-Integration-Repo'
export const INTEGRATION_VERSION_HEADER_NAME = 'X-AIMLAPI-Integration-Version'
export const REFERER_HEADER_NAME = 'HTTP-Referer'
export const TITLE_HEADER_NAME = 'X-Title'

/**
 * HTTP field names OpenClaude manages for AIMLAPI attribution. Fetch treats
 * header names as case-insensitive, so every spelling of these names is
 * stripped before a single canonical value is written back.
 */
const MANAGED_ATTRIBUTION_HEADER_CANONICAL_NAMES = {
  [PARTNER_HEADER_NAME.toLowerCase()]: PARTNER_HEADER_NAME,
  [SOURCE_HEADER_NAME.toLowerCase()]: SOURCE_HEADER_NAME,
  [INTEGRATION_REPO_HEADER_NAME.toLowerCase()]: INTEGRATION_REPO_HEADER_NAME,
  [INTEGRATION_VERSION_HEADER_NAME.toLowerCase()]:
    INTEGRATION_VERSION_HEADER_NAME,
  [REFERER_HEADER_NAME.toLowerCase()]: REFERER_HEADER_NAME,
  [TITLE_HEADER_NAME.toLowerCase()]: TITLE_HEADER_NAME,
} as const

export const AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES = new Set<string>(
  Object.keys(MANAGED_ATTRIBUTION_HEADER_CANONICAL_NAMES),
)

function isManagedAttributionHeaderName(name: string): boolean {
  return AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES.has(name.trim().toLowerCase())
}

function omitManagedAttributionHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (isManagedAttributionHeaderName(name)) continue
    resolved[name] = value
  }
  return resolved
}

function collectManagedAttributionValues(
  headers: Readonly<Record<string, string>>,
): Map<string, string> {
  const collected = new Map<string, string>()
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase()
    if (AIMLAPI_MANAGED_ATTRIBUTION_HEADER_NAMES.has(key)) {
      collected.set(key, value)
    }
  }
  return collected
}

/**
 * Attribution `source` sent on EVERY aimlapi request (inference, catalog, auth,
 * checkout) alongside the partner id — identifies OpenClaude as the integration
 * client, matching the `agent/<client>` convention (e.g. `agent/zero`).
 */
export const AIMLAPI_SOURCE = 'agent/openclaude'

/** Default model id written into the profile - override with `--model`. */
export const DEFAULT_MODEL = 'gpt-4o'
/** Fallback browser landing page after checkout when no override applies. */
export const DEFAULT_RETURN_URL = 'https://aimlapi.com/app'

/** Top-up bounds enforced by the backend DTO (USD minor units / cents). */
export const MIN_AMOUNT_USD_MINOR = 2000 // $20
export const MAX_AMOUNT_USD_MINOR = 1_000_000 // $10,000
export const DEFAULT_AMOUNT_USD_MINOR = 2500 // $25

export function resolveEndpoints(): AimlapiEndpoints {
  return {
    authBaseUrl: process.env.AIMLAPI_AUTH_URL?.trim() || DEFAULT_ENDPOINTS.authBaseUrl,
    appBaseUrl: process.env.AIMLAPI_APP_URL?.trim() || DEFAULT_ENDPOINTS.appBaseUrl,
    payBaseUrl: process.env.AIMLAPI_PAY_URL?.trim() || DEFAULT_ENDPOINTS.payBaseUrl,
    inferenceBaseUrl:
      process.env.AIMLAPI_INFERENCE_URL?.trim() || DEFAULT_ENDPOINTS.inferenceBaseUrl,
    verificationBaseUrl:
      process.env.AIMLAPI_VERIFICATION_BASE_URL?.trim() ||
      DEFAULT_ENDPOINTS.verificationBaseUrl,
  }
}

/**
 * The partner id is locked to OpenClaude's own attribution id. It is
 * deliberately NOT user-overridable (no CLI flag, no env var): letting a caller
 * change it would redirect rebate/revenue-share attribution away from OpenClaude.
 */
export function resolvePartnerId(): string {
  return DEFAULT_PARTNER_ID
}

/**
 * Return a header copy carrying the fixed partner id. Header matching is
 * case-insensitive so it replaces the catalog spelling instead of creating a
 * duplicate header.
 */
export function withResolvedPartnerHeader(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name.trim().toLowerCase() === PARTNER_HEADER_NAME.toLowerCase()) continue
    resolved[name] = value
  }
  resolved[PARTNER_HEADER_NAME] = resolvePartnerId()
  return resolved
}

function parseCanonicalUrl(
  value: string,
): { origin: string; pathname: string } | null {
  try {
    const trimmed = value.trim()
    const url = new URL(trimmed)
    // Credentials, a query, or a fragment (even a bare `?`/`#`) make this
    // non-canonical: it is written verbatim as OPENAI_BASE_URL and the OpenAI
    // shim concatenates `/chat/completions` onto the raw string, which a trailing
    // `?x`/`#x` would push into the query/fragment (server then sees only `/v1`).
    if (url.username || url.password) return null
    if (trimmed.includes('?') || trimmed.includes('#')) return null
    // `origin` already lowercases protocol and host. Collapse only a single
    // trailing slash so `/v1` and `/v1/` match, while `/v1//`, `/V1`, or
    // `/v1/anything` stay distinct from the canonical `/v1` path.
    return { origin: url.origin, pathname: url.pathname.replace(/\/$/, '') }
  } catch {
    return null
  }
}

/**
 * Catalog attribution and existing-key preflight are production-only. This
 * predicate gates ambient-credential forwarding, so it compares parsed origins
 * (host/protocol case-insensitive) and a case-sensitive path: a look-alike like
 * `/V1` or `/v1////` must NOT be treated as the canonical endpoint.
 */
export function isCanonicalAimlapiInferenceBaseUrl(value: string): boolean {
  const canonical = parseCanonicalUrl(DEFAULT_ENDPOINTS.inferenceBaseUrl)
  const candidate = parseCanonicalUrl(value)
  return (
    canonical !== null &&
    candidate !== null &&
    candidate.origin === canonical.origin &&
    candidate.pathname === canonical.pathname
  )
}

/**
 * True when an outbound client request targets an AI/ML API-controlled host
 * (production or staging under `aimlapi.com`, over HTTPS). The auth/app/pay/
 * inference base URLs are all env-overridable, so the mandatory attribution
 * headers are gated on this: a request pointed at a user proxy must not carry
 * OpenClaude's partner/source identity, mirroring the inference/catalog
 * stripping contract in `resolveAimlapiAttributionHeaders`.
 */
export function isTrustedAimlapiRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'aimlapi.com' || host.endsWith('.aimlapi.com')
  } catch {
    return false
  }
}

/**
 * Resolve the aimlapi catalog headers for an outbound request. On the canonical
 * inference endpoint the partner id is resolved and attribution is sent; on any
 * other base URL (a user-controlled proxy) every attribution header is stripped,
 * so a third-party host never receives OpenClaude's partner identity.
 *
 * Both the inference (openai shim) and the model-discovery request paths route
 * through here, so the two cannot drift apart. A missing base URL means the
 * caller falls back to the route default, which is canonical.
 *
 * Managed names are compared case-insensitively. Fetch combines duplicate
 * field names, so a caller `x-aimlapi-source` would otherwise ride alongside
 * the canonical `X-AIMLAPI-Source`.
 */
export function resolveAimlapiAttributionHeaders(
  headers: Readonly<Record<string, string>>,
  baseUrl: string | undefined,
): Record<string, string> {
  const rest = omitManagedAttributionHeaders(headers)
  if (!baseUrl || isCanonicalAimlapiInferenceBaseUrl(baseUrl)) {
    const collected = collectManagedAttributionValues(headers)
    const managed: Record<string, string> = {
      [PARTNER_HEADER_NAME]: resolvePartnerId(),
      [SOURCE_HEADER_NAME]: AIMLAPI_SOURCE,
    }
    for (const [key, canonical] of Object.entries(
      MANAGED_ATTRIBUTION_HEADER_CANONICAL_NAMES,
    )) {
      if (
        key === PARTNER_HEADER_NAME.toLowerCase() ||
        key === SOURCE_HEADER_NAME.toLowerCase()
      ) {
        continue
      }
      const value = collected.get(key)
      if (value !== undefined) {
        managed[canonical] = value
      }
    }
    return { ...rest, ...managed }
  }

  return rest
}

/**
 * Build the co-branded checkout return URLs the hosted payment page redirects
 * to after the user pays or cancels. Carrying `sessionToken` + `partnerCheckout=1`
 * makes the AI/ML API `/checkout` page resolve the partner (name + logo + amount)
 * and render the co-branded success / failure screen instead of the
 * generic top-up result. Without these params the backend falls back to a bare
 * `/checkout?checkout=success` that is NOT co-branded.
 */
export function buildPartnerCheckoutReturnUrls(
  payBaseUrl: string,
  sessionToken: string,
): { successUrl: string; cancelUrl: string } {
  // The return URLs carry the resumable sessionToken, so the checkout base MUST
  // be a credential-free HTTPS URL — a cleartext callback would hand the payment
  // provider a browser link containing the checkout credential.
  const base = requireHttpsBaseUrl(payBaseUrl, 'AIMLAPI_PAY_URL').replace(/\/+$/, '')
  const token = encodeURIComponent(sessionToken)
  const query = (status: string): string =>
    `checkout=${status}&partnerCheckout=1&sessionToken=${token}`
  return {
    successUrl: `${base}/checkout?${query('success')}`,
    cancelUrl: `${base}/checkout?${query('cancel')}`,
  }
}

/**
 * Browser landing URL after checkout. OpenClaude learns success by polling, so
 * this must be an ordinary HTTP(S) page rather than an unregistered custom
 * scheme. Precedence: the `AIMLAPI_RETURN_URL` override, then the resolved
 * frontend base URL, then the packaged default.
 */
export function buildPartnerReturnUrl(frontendBaseUrl: string): string {
  return (
    safeHttpsBaseUrl(process.env.AIMLAPI_RETURN_URL) ??
    safeHttpsBaseUrl(frontendBaseUrl) ??
    DEFAULT_RETURN_URL
  )
}

/** A trimmed https:// base URL without embedded credentials, or null. */
function safeHttpsBaseUrl(value: string | undefined): string | null {
  const candidate = value?.trim()
  if (!candidate) return null
  try {
    const url = new URL(candidate)
    // The setup guide promises an HTTPS return target; a cleartext landing page
    // is not honored. Embedded credentials are never legitimate here either.
    if (url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    // Reject any raw `?`/`#` — a bare delimiter leaves url.search/url.hash empty
    // yet still swallows the appended `/checkout?...sessionToken`.
    if (candidate.includes('?') || candidate.includes('#')) return null
    return candidate
  } catch {
    return null
  }
}

/**
 * Require a credential-free https:// base URL, throwing otherwise. Used for the
 * checkout base, whose return URLs embed the resumable session token and must
 * never be sent over cleartext.
 */
function requireHttpsBaseUrl(value: string, label: string): string {
  const candidate = value.trim()
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`${label} must be a valid https:// URL.`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(
      `${label} must use https:// so the checkout callback carrying the session token is not sent in cleartext.`,
    )
  }
  if (url.username || url.password) {
    throw new Error(`${label} must not embed credentials.`)
  }
  // Reject any raw `?`/`#` — a bare delimiter (e.g. `https://pay.aimlapi.com/?`)
  // leaves url.search/url.hash empty yet still swallows the appended
  // `/checkout?...sessionToken=...` into the query/fragment.
  if (candidate.includes('?') || candidate.includes('#')) {
    throw new Error(`${label} must not include a query string or fragment.`)
  }
  return candidate
}
