/**
 * Client for the Twigpine Ads service (ads.gitlawb.com).
 *
 * openclaude shows opt-in "sponsored tips" during inference waits; a viewer who
 * dwells on one earns opengateway credits. This module is the thin HTTP client:
 * fetch the next tip, then confirm it after the dwell so the viewer is credited.
 * The viewer is identified by an earn code (issued in the opengateway Earn tab,
 * stored in openclaude config), sent as the `x-earn-code` header.
 *
 * Earning is bounded and server-authoritative — the gateway/ads service signs
 * the impression token and measures dwell itself; this client just relays it.
 */
import { fetchWithProxyRetry } from './api/fetchWithProxyRetry.js'

const DEFAULT_ADS_BASE_URL = 'https://ads.gitlawb.com'

export function adsBaseUrl(): string {
  return (process.env.ADS_BASE_URL ?? DEFAULT_ADS_BASE_URL).replace(/\/$/, '')
}

export type SponsoredTip = {
  impressionId: string
  token: string
  text: string
  name: string
  link: string
  label: string
  dwellMs: number
}

export type ConfirmResult = {
  status: string
  earnedMicro: number
  balanceMicro?: number
}

const COMMON_HEADERS = (earnCode: string): Record<string, string> => ({
  'content-type': 'application/json',
  'user-agent': 'gitlawb-openclaude-ads',
  'x-earn-code': earnCode,
})

// Hard deadline on each ads request. fetchNextTip runs in the spinner-tip path,
// so a stalled connection must never hang it — "ads never block" is the rule.
const ADS_REQUEST_TIMEOUT_MS = 5_000

/**
 * An AbortSignal that fires after `ms`. fetchWithProxyRetry spreads `init` into
 * fetch (so the signal is honored) and treats AbortError as non-retryable. The
 * timer is unref'd so it never keeps a short-lived CLI process alive.
 *
 * Note: this is a per-CALL deadline, not per-attempt — the one signal covers all
 * of fetchWithProxyRetry's retries, so a slow first attempt leaves the retry
 * less time. That's intentional: the whole request is bounded so ads can never
 * block the spinner path.
 */
function withAbortTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  ;(timer as { unref?: () => void }).unref?.()
  return { signal: controller.signal, cancel: () => clearTimeout(timer) }
}

// Cap on how much of the prompt we ever share, and best-effort redaction of the
// obvious secret/PII shapes. Heuristic — bias toward over-redaction. The ads
// service re-bounds size server-side too.
const MAX_CONTEXT_CHARS = 500

export function sanitizeForAds(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{8,}\b/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[redacted-jwt]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]')
    // base64-ish blobs: \b is unreliable around + and / (both \W), so bound the
    // run with explicit look-around on the base64 alphabet instead.
    .replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CONTEXT_CHARS)
}

/**
 * Fetch the next sponsored tip for this viewer. When the viewer has enabled
 * sponsored tips (which discloses prompt sharing), the sanitized latest prompt
 * is POSTed for contextual ad matching; otherwise we GET (identity-only).
 * Returns null on empty inventory / no contextual match / any error — ads must
 * never break or block the host CLI, so failures degrade silently to "no tip".
 */
export async function fetchNextTip(
  earnCode: string,
  surface = 'openclaude',
  userMessage?: string,
): Promise<SponsoredTip | null> {
  const { signal, cancel } = withAbortTimeout(ADS_REQUEST_TIMEOUT_MS)
  try {
    const url = `${adsBaseUrl()}/api/ads/next?surface=${encodeURIComponent(surface)}`
    const sanitized = userMessage ? sanitizeForAds(userMessage) : ''
    const init: RequestInit = sanitized
      ? {
          method: 'POST',
          headers: COMMON_HEADERS(earnCode),
          body: JSON.stringify({
            context: { messages: [{ role: 'user', content: sanitized }] },
          }),
          signal,
        }
      : { method: 'GET', headers: COMMON_HEADERS(earnCode), signal }
    const resp = await fetchWithProxyRetry(url, init, { maxAttempts: 2 })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    // A real tip is identified by a string `token` (the signed impression). The
    // empty-slot response is `{ ad: null }` and a malformed one has no token —
    // both lack a string token, so this single check covers them. We deliberately
    // don't gate on an `ad` field: a served tip carries no `ad` key at all, so a
    // `data.ad == null` test would (wrongly) suppress every valid tip.
    if (!data || typeof data.token !== 'string') return null
    // Clamp dwell to a finite, non-negative integer — a malformed dwell_ms must
    // not yield NaN/Infinity and break the confirm-delay math downstream.
    const rawDwell = Number(data.dwell_ms ?? 5000)
    const dwellMs =
      Number.isFinite(rawDwell) && rawDwell >= 0 ? Math.trunc(rawDwell) : 5000
    return {
      impressionId: String(data.impression_id),
      token: String(data.token),
      text: String(data.tip_text ?? ''),
      name: String(data.name ?? ''),
      link: String(data.link ?? ''),
      label: String(data.label ?? 'Sponsored'),
      dwellMs,
    }
  } catch {
    return null
  } finally {
    cancel()
  }
}

/** Coerce an API number to a finite integer, or undefined when malformed. */
function toFiniteInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

/**
 * Confirm a shown tip after its dwell elapsed, crediting the viewer. Returns the
 * settle status + amount earned. Throws only on transport failure; callers in
 * the render path should swallow that (earning is best-effort).
 */
export async function confirmTip(
  earnCode: string,
  token: string,
): Promise<ConfirmResult> {
  const { signal, cancel } = withAbortTimeout(ADS_REQUEST_TIMEOUT_MS)
  try {
    const resp = await fetchWithProxyRetry(
      `${adsBaseUrl()}/api/ads/confirm`,
      {
        method: 'POST',
        headers: COMMON_HEADERS(earnCode),
        body: JSON.stringify({ token }),
        signal,
      },
      { maxAttempts: 2 },
    )
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>
    return {
      status: String(data.status ?? (resp.ok ? 'unknown' : 'error')),
      earnedMicro: toFiniteInt(data.earned_micro) ?? 0,
      balanceMicro: toFiniteInt(data.balance_micro),
    }
  } finally {
    cancel()
  }
}
