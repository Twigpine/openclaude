/**
 * AI/ML API Toolbox backend for WebFetch: fetches a page as Markdown through a
 * Toolbox tool run instead of raw HTTP, the same role Firecrawl's scrape
 * endpoint plays.
 *
 * Every run is billed to the user's AI/ML API balance, so this backend is
 * opt-in only: it runs when WEB_FETCH_PROVIDER=aimlapi is set, never just
 * because an AI/ML API key is present.
 */

import { randomUUID } from 'node:crypto'

import {
  AIMLAPI_SOURCE,
  isCanonicalAimlapiInferenceBaseUrl,
  PARTNER_HEADER_NAME,
  resolvePartnerId,
  SOURCE_HEADER_NAME,
} from '../../integrations/aimlapi/config.js'
import { sleep } from '../../integrations/aimlapi/transport.js'
import { firstUsableCredential } from '../../services/api/credentialPool.js'
import { createCombinedAbortSignal } from '../../utils/combinedAbortSignal.js'

/**
 * Fixed and not user-overridable, so the AI/ML API key and the attribution
 * headers can only ever be sent to tools.aimlapi.com.
 */
export const AIMLAPI_TOOLBOX_BASE_URL = 'https://tools.aimlapi.com/v1/tools'

/**
 * The Toolbox tool WebFetch runs. Picked by measurement (2026-10-19) against
 * context-dev/web-scrape-markdown, octen/extract, mrscraper/scrape-markdown,
 * exa/contents, keenable/v1-fetch, surf/web-fetch and
 * dataforseo/onpage-content-parsing on a plain article, a JavaScript-rendered
 * page and a large Wikipedia article:
 * - the lowest fixed price, $0.0013 per run (context-dev $0.003293, keenable
 *   $0.0052); octen and mrscraper are priced only after the run;
 * - main-content Markdown that keeps links, like Firecrawl's scrape. It
 *   rendered the JavaScript-only page, and on the large page it fit more of the
 *   article into WebFetch's 100k-character window than the other Markdown
 *   tools did;
 * - a 404 or an unresolvable host comes back as an unbilled `is_error` run,
 *   where exa and octen report success with an empty result.
 * It was slower than context-dev (3.9-10.8 s against 2.4-10.2 s).
 */
export const AIMLAPI_WEB_FETCH_TOOL_ID = 'search1api/crawl'

/**
 * Spending cap sent with every run. The tool costs $0.0013 per run; the cap
 * leaves room for a small price change, and a run priced above it is refused
 * before it starts (400 max_cost_exceeded) instead of being charged.
 */
export const AIMLAPI_WEB_FETCH_MAX_COST_USD = 0.005

// How long POST /run may hold the request open before answering 202.
const RUN_WAIT_MS = 30_000
// Upper bound for the whole scrape, polling included.
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 500
const MAX_RETRY_DELAY_MS = 10_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MIN_POLL_INTERVAL_MS = 250
const MAX_POLL_INTERVAL_MS = 5_000
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'stopped', 'timed_out'])
// Rate limits and gateway errors. Retrying them reuses the idempotency key, so
// a run that did start is returned again instead of being charged twice.
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504])

interface ToolboxRun {
  id?: string
  status?: string
  is_error?: boolean
  error?: { message?: string; kind?: string; retryable?: boolean }
  output?: unknown
  cost?: { quoted_usd?: number; actual_usd?: number; over_max?: boolean }
  next_poll_hint_ms?: number
}

interface ToolboxErrorBody {
  error?: { message?: string; code?: string }
}

interface AimlapiScrapeOptions {
  apiKey?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  maxAttempts?: number
  backoffMs?: number
}

/** True when the user explicitly chose the AI/ML API backend for WebFetch. */
export function isAimlapiWebFetchSelected(): boolean {
  return process.env.WEB_FETCH_PROVIDER?.trim().toLowerCase() === 'aimlapi'
}

/**
 * An aimlapi provider profile pointed at the user's own proxy exports the
 * proxy's credential as AIMLAPI_API_KEY. That key belongs to the proxy, so it
 * must never be sent to tools.aimlapi.com: treat it as no key at all.
 */
function isProxiedAimlapiProfileKey(): boolean {
  const baseUrl = process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim()
  return (
    process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID === 'aimlapi' &&
    Boolean(baseUrl) &&
    !isCanonicalAimlapiInferenceBaseUrl(baseUrl!)
  )
}

/**
 * A provider profile can export a comma-separated credential pool as
 * AIMLAPI_API_KEY. Use its first usable key, as the web search backend does;
 * there is no rotation or retry across keys for billed runs.
 */
function resolveApiKey(options: AimlapiScrapeOptions): string {
  const ambientKey = isProxiedAimlapiProfileKey()
    ? undefined
    : firstUsableCredential(process.env.AIMLAPI_API_KEY)
  const apiKey = (options.apiKey ?? ambientKey ?? '').trim()
  if (!apiKey) {
    throw new Error(
      'WEB_FETCH_PROVIDER=aimlapi needs an AI/ML API key. Set AIMLAPI_API_KEY, or unset WEB_FETCH_PROVIDER to fetch pages directly.',
    )
  }
  return apiKey
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    [SOURCE_HEADER_NAME]: AIMLAPI_SOURCE,
    [PARTNER_HEADER_NAME]: resolvePartnerId(),
  }
}

async function readJson<T>(response: Response): Promise<T | undefined> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

function retryDelayMs(response: Response, attempt: number, backoffMs: number): number {
  const retryAfterSeconds = Number(response.headers.get('retry-after'))
  const delay =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : backoffMs * Math.pow(2, attempt)
  return Math.min(delay, MAX_RETRY_DELAY_MS)
}

function pollDelayMs(run: ToolboxRun): number {
  const hint = run.next_poll_hint_ms
  if (typeof hint !== 'number' || !Number.isFinite(hint)) return DEFAULT_POLL_INTERVAL_MS
  return Math.min(Math.max(hint, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS)
}

/** Remove an echoed credential before error text is shown. */
function redact(value: string | undefined, apiKey: string): string | undefined {
  return value?.split(apiKey).join('[redacted]')
}

async function requestError(response: Response, action: string, apiKey: string): Promise<Error> {
  const body = await readJson<ToolboxErrorBody>(response)
  const code = body?.error?.code ? ` (${redact(body.error.code, apiKey)})` : ''
  const message = body?.error?.message ? `: ${redact(body.error.message, apiKey)}` : ''
  return new Error(`AI/ML API Toolbox ${action} error ${response.status}${code}${message}`)
}

async function startRun(
  url: string,
  apiKey: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  maxAttempts: number,
  backoffMs: number,
): Promise<ToolboxRun> {
  const body = JSON.stringify({
    tool: AIMLAPI_WEB_FETCH_TOOL_ID,
    input: { url },
    max_cost_usd: AIMLAPI_WEB_FETCH_MAX_COST_USD,
    wait_ms: RUN_WAIT_MS,
    idempotency_key: randomUUID(),
  })

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${AIMLAPI_TOOLBOX_BASE_URL}/run`, {
      method: 'POST',
      headers,
      body,
      // Never follow a redirect: the key and attribution headers must not
      // reach any host but the Toolbox.
      redirect: 'error',
      signal,
    })
    if (response.ok) {
      const run = await readJson<ToolboxRun>(response)
      if (!run) throw new Error('AI/ML API Toolbox run returned an invalid response')
      return run
    }
    if (!RETRYABLE_HTTP_STATUSES.has(response.status) || attempt >= maxAttempts - 1) {
      throw await requestError(response, 'run', apiKey)
    }
    await response.body?.cancel()
    await sleep(retryDelayMs(response, attempt, backoffMs), signal)
  }
}

async function waitForRun(
  run: ToolboxRun,
  apiKey: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ToolboxRun> {
  let current = run
  while (!TERMINAL_RUN_STATUSES.has(current.status ?? '')) {
    if (!current.id) throw new Error('AI/ML API Toolbox run is still pending but has no run id')
    await sleep(pollDelayMs(current), signal)
    const response = await fetch(
      `${AIMLAPI_TOOLBOX_BASE_URL}/runs/${encodeURIComponent(current.id)}`,
      { method: 'GET', headers, redirect: 'error', signal },
    )
    if (RETRYABLE_HTTP_STATUSES.has(response.status)) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) throw await requestError(response, 'run status', apiKey)
    const next = await readJson<ToolboxRun>(response)
    if (!next) throw new Error('AI/ML API Toolbox run status returned an invalid response')
    current = { ...next, id: next.id ?? current.id }
  }
  return current
}

function extractMarkdown(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const results = (output as { results?: unknown }).results
  if (typeof results !== 'object' || results === null) return undefined
  const content = (results as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

function capNote(run: ToolboxRun): string {
  return run.cost?.over_max
    ? ` The run hit the $${AIMLAPI_WEB_FETCH_MAX_COST_USD} max_cost_usd cap.`
    : ''
}

/**
 * Scrape a page to Markdown with the AI/ML API Toolbox. Throws on any failure,
 * like the Firecrawl scrape: WebFetch reports the error rather than silently
 * fetching the page another way.
 */
export async function scrapeWithAimlapi(
  url: string,
  options: AimlapiScrapeOptions = {},
): Promise<{ markdown: string; bytes: number }> {
  if (!url.trim()) {
    throw new Error('AI/ML API Toolbox URL cannot be empty')
  }
  const apiKey = resolveApiKey(options)
  const headers = buildHeaders(apiKey)
  const { signal, cleanup } = createCombinedAbortSignal(options.signal, {
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })

  try {
    const started = await startRun(
      url,
      apiKey,
      headers,
      signal,
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      options.backoffMs ?? DEFAULT_BACKOFF_MS,
    )
    const run = await waitForRun(started, apiKey, headers, signal)

    if (run.is_error || run.status !== 'completed') {
      const reason = redact(run.error?.message, apiKey) ?? `run ended with status ${redact(run.status, apiKey)}`
      const retry = run.error?.retryable ? ' (retryable)' : ''
      throw new Error(
        `AI/ML API Toolbox ${AIMLAPI_WEB_FETCH_TOOL_ID} failed for ${url}: ${reason}${retry}.${capNote(run)}`,
      )
    }

    const markdown = extractMarkdown(run.output)
    if (!markdown) {
      throw new Error(
        `AI/ML API Toolbox ${AIMLAPI_WEB_FETCH_TOOL_ID} returned no page content for ${url}.${capNote(run)}`,
      )
    }
    return { markdown, bytes: Buffer.byteLength(markdown) }
  } finally {
    cleanup()
  }
}
