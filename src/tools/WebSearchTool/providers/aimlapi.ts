/**
 * AI/ML API Toolbox adapter — runs the Toolbox tool `web/search`.
 * POST https://tools.aimlapi.com/v1/tools/run
 * Auth: Authorization: Bearer <AIMLAPI_API_KEY>
 *
 * Every run is billed to the user's AI/ML API balance, so this provider is
 * explicit-only (WEB_SEARCH_PROVIDER=aimlapi): it is not in the auto chain,
 * and every run carries a max_cost_usd cap. The key is the one the AI/ML API
 * model provider already uses; it and the attribution headers go only to the
 * Toolbox host, which is fixed (no env override).
 *
 * The run returns 200 with the finished run, or 202 while it is still queued;
 * a queued run is polled at GET /v1/tools/runs/{id} until it ends. A run that
 * executed but failed comes back with `is_error: true`.
 */

import {
  AIMLAPI_SOURCE,
  isCanonicalAimlapiInferenceBaseUrl,
  PARTNER_HEADER_NAME,
  resolvePartnerId,
  SOURCE_HEADER_NAME,
} from '../../../integrations/aimlapi/config.js'
import { firstUsableCredential } from '../../../services/api/credentialPool.js'
import type { SearchHit, SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { getWebSearchTimeoutMs, toAbortError, withWebSearchTimeout } from './timeout.js'

const TOOLBOX_HOST = 'tools.aimlapi.com'
const TOOLBOX_BASE_URL = `https://${TOOLBOX_HOST}/v1/tools`
const WEB_SEARCH_TOOL = 'web/search'
const MAX_RESULTS = 10
/**
 * Spend cap per search. web/search publishes a $0.0091–$0.0221 price range
 * (2026-10; a 10-result run was charged $0.0091). The cap covers the tool's
 * published maximum; enforcement is handled by the Toolbox service.
 */
export const AIMLAPI_SEARCH_MAX_COST_USD = 0.025
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'timed_out'])
const DEFAULT_POLL_MS = 1000
const MIN_POLL_MS = 250
const MAX_POLL_MS = 5000
const MAX_ERROR_MESSAGE_LENGTH = 300

/**
 * The key the AI/ML API model provider uses: AIMLAPI_API_KEY, or the
 * OPENAI_API_KEY fallback that route accepts — but only while OPENAI_BASE_URL
 * (or its OPENAI_API_BASE alias) is the canonical AI/ML API endpoint, so another
 * provider's key is never sent.
 *
 * An aimlapi provider profile pointed at the user's own proxy exports the
 * proxy's credential as AIMLAPI_API_KEY. That credential belongs to the
 * proxy, so no key is resolved at all in that case: the backend reports
 * itself as not configured and nothing is sent to the Toolbox.
 */
function apiKey(): string | undefined {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim()
  const canonicalBaseUrl = Boolean(baseUrl && isCanonicalAimlapiInferenceBaseUrl(baseUrl))
  if (process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'aimlapi' && baseUrl && !canonicalBaseUrl) {
    return undefined
  }
  const dedicated = firstUsableCredential(process.env.AIMLAPI_API_KEY)
  if (dedicated) return dedicated
  return canonicalBaseUrl ? firstUsableCredential(process.env.OPENAI_API_KEY) : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Remove echoed credentials before error fields are clipped or displayed. */
function errorText(value: unknown, key: string): string | undefined {
  return text(value)?.split(key.trim()).join('[redacted]')
}

function clip(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_ERROR_MESSAGE_LENGTH
    ? `${compact.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`
    : compact
}

/**
 * Headers for a Toolbox request. The key and the attribution headers are
 * attached only when the URL's hostname is exactly the Toolbox host.
 */
function toolboxHeaders(url: string, key: string): Record<string, string> {
  if (new URL(url).hostname !== TOOLBOX_HOST) {
    throw new Error(`AI/ML API search refused to send credentials to ${url}`)
  }
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    [SOURCE_HEADER_NAME]: AIMLAPI_SOURCE,
    [PARTNER_HEADER_NAME]: resolvePartnerId(),
  }
}

/** Server-side wait: long enough to usually skip polling, short of our timeout. */
function waitMs(timeoutMs: number): number {
  return Math.min(30_000, Math.max(1_000, timeoutMs - 2_000))
}

function pollDelayMs(run: Record<string, unknown>): number {
  const hint = run.next_poll_hint_ms
  if (typeof hint !== 'number' || !Number.isFinite(hint)) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, hint))
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(toAbortError(signal.reason))
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(toAbortError(signal.reason))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text()
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Error text for a refused request (4xx/5xx). Never includes the key. */
function httpError(status: number, body: unknown, key: string): Error {
  const envelope = record(body)
  const error = record(envelope?.error)
  const code = errorText(error?.code, key)
  const message = errorText(error?.message, key) ?? errorText(envelope?.message, key)
  const requestId = errorText(error?.request_id, key) ?? errorText(envelope?.requestId, key)
  const hint =
    status === 401
      ? ' (check AIMLAPI_API_KEY)'
      : code === 'insufficient_funds'
        ? ' (top up your AI/ML API balance)'
        : status === 429
          ? ' (rate limited)'
          : ''
  return new Error(
    `AI/ML API search error HTTP ${status}${code ? ` ${code}` : ''}${hint}` +
    `${message ? `: ${clip(message)}` : ''}${requestId ? ` (request_id: ${requestId})` : ''}`,
  )
}

/** Turn a finished run into hits, or throw if the run failed. */
function runResults(run: Record<string, unknown>, key: string): unknown[] {
  const status = text(run.status) ?? 'unknown'
  if (run.is_error === true || status !== 'completed') {
    const error = record(run.error)
    const message = errorText(error?.message, key)
    const retry = error?.retryable === true ? ' (retryable)' : ''
    throw new Error(
      `AI/ML API ${WEB_SEARCH_TOOL} run ${errorText(status, key)}${message ? `: ${clip(message)}` : ''}${retry}`,
    )
  }
  const output = record(run.output)
  if (!Array.isArray(output?.results)) {
    throw new Error(`AI/ML API ${WEB_SEARCH_TOOL} returned no results list`)
  }
  return output.results
}

/**
 * Map a Toolbox result ({url, title, snippet, published_at}) onto a SearchHit.
 * Results are untrusted web content: only these string fields are read, and
 * they are passed through as data like every other backend's results.
 */
function toHit(raw: unknown): SearchHit | null {
  const result = record(raw)
  const url = text(result?.url)
  if (!url) return null
  const snippet = text(result?.snippet)
  const published = text(result?.published_at)
  const date = published && !Number.isNaN(Date.parse(published))
    ? new Date(published).toISOString().slice(0, 10)
    : undefined
  const description = date
    ? snippet ? `(${date}) ${snippet}` : `(${date})`
    : snippet
  return {
    title: text(result?.title) ?? url,
    url,
    ...(description ? { description } : {}),
    source: safeHostname(url),
  }
}

export const aimlapiProvider: SearchProvider = {
  name: 'aimlapi',

  isConfigured() {
    return Boolean(apiKey())
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const key = apiKey()
    if (!key) throw new Error('AI/ML API search needs AIMLAPI_API_KEY')

    const toolInput: Record<string, unknown> = {
      query: input.query,
      max_results: MAX_RESULTS,
    }
    const allowed = input.allowed_domains?.map(d => d.trim()).filter(Boolean)
    // The tool filters allowed domains server-side; it has no exclude field,
    // so blocked domains are applied to the results below.
    if (allowed?.length) toolInput.include_domains = allowed

    const timeoutMs = getWebSearchTimeoutMs()
    const results = await withWebSearchTimeout(async combinedSignal => {
      const runUrl = `${TOOLBOX_BASE_URL}/run`
      const response = await fetch(runUrl, {
        method: 'POST',
        headers: { ...toolboxHeaders(runUrl, key), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: WEB_SEARCH_TOOL,
          input: toolInput,
          max_cost_usd: AIMLAPI_SEARCH_MAX_COST_USD,
          wait_ms: waitMs(timeoutMs),
        }),
        // Never follow a redirect: the key and attribution headers must not
        // reach any host but the Toolbox.
        redirect: 'error',
        signal: combinedSignal,
      })
      let body = await readJson(response)
      if (!response.ok) throw httpError(response.status, body, key)

      let run = record(body)
      if (!run) throw new Error('AI/ML API search returned an invalid response')

      while (!TERMINAL_STATUSES.has(text(run.status) ?? '') && run.is_error !== true) {
        const id = text(run.id)
        if (!id) throw new Error('AI/ML API search returned a queued run without an id')
        await sleep(pollDelayMs(run), combinedSignal)
        const statusUrl = `${TOOLBOX_BASE_URL}/runs/${encodeURIComponent(id)}`
        const poll = await fetch(statusUrl, {
          headers: toolboxHeaders(statusUrl, key),
          redirect: 'error',
          signal: combinedSignal,
        })
        body = await readJson(poll)
        if (!poll.ok) throw httpError(poll.status, body, key)
        run = record(body)
        if (!run) throw new Error('AI/ML API search returned an invalid run status')
      }
      return runResults(run, key)
    }, signal, { providerName: 'AI/ML API', timeoutMs })

    const hits = results.map(toHit).filter((h): h is SearchHit => h !== null)
    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'aimlapi',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
