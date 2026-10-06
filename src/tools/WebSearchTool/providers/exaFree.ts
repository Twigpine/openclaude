/**
 * Exa free-tier adapter — no API key required.
 * POST https://mcp.exa.ai/mcp  (JSON-RPC `tools/call` of `web_search_exa`)
 *
 * Exa serves its hosted MCP endpoint unauthenticated on a free tier with a
 * per-IP requests-per-second limit and a daily quota, which makes it the
 * zero-config search default. When EXA_API_KEY is set, the keyed REST adapter (exa.ts)
 * runs first; set EXA_FREE_TIER=0 to never call this endpoint.
 *
 * Protocol notes (MCP streamable HTTP):
 *   - Requests must accept BOTH application/json and text/event-stream, or the
 *     server answers 406. The reply is an SSE `message` event whose `data:`
 *     line carries the JSON-RPC response.
 *   - Free-tier exhaustion has been seen in three shapes, all handled:
 *     HTTP 429 with a JSON-RPC error (exa-mcp-server api/mcp.ts); HTTP 200
 *     with `result.isError: true` and "You've hit Exa's free MCP rate
 *     limit. …" (src/utils/errorHandler.ts); and HTTP 200 with
 *     `result._meta["ai.exa/rateLimited"]: true` and no isError (observed
 *     live). Other tool failures also arrive as HTTP 200 + isError.
 *   - `objective` is required by the tool schema alongside `query`.
 *
 * The tool returns plain text, one block per result:
 *   Title: <title>
 *   URL: <url>
 *   Published: <date|N/A>
 *   Author: <name|N/A>
 *   Highlights:
 *   <excerpt text, which can itself contain `---` lines>
 * Blocks start at a `Title:` line, then a `URL:` line, then a metadata line
 * (`Published:`/`Author:`/`Highlights:`/…), so a page excerpt that happens to
 * contain `Title:`/`URL:` lines isn't mistaken for a result. If no block
 * matches that shape, Title+URL alone is accepted, so a dropped metadata line
 * degrades gracefully. The `---` separators are deliberately ignored because
 * page excerpts (e.g. markdown front-matter) contain them too.
 *
 * Domain filters: the tool has no include/exclude parameters, so allowed
 * domains become `site:` operators in the query (which Exa honors), both
 * lists are stated in the objective, and applyDomainFilters() enforces them
 * on the parsed hits.
 */

import { sleep } from '../../../utils/sleep.js'
import { getExaNumResults, isExaFreeTierEnabled } from './exa.js'
import type { SearchHit, SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { toAbortError, withWebSearchTimeout } from './timeout.js'

const EXA_FREE_ENDPOINT = 'https://mcp.exa.ai/mcp'
const EXA_SOURCE_TAG = 'openclaude'
const MAX_OBJECTIVE_CHARS = 4096
const MAX_DESCRIPTION_CHARS = 800
const MAX_ERROR_DETAIL_CHARS = 200

// The free tier is limited per IP to a few requests per second (exa-mcp-server
// defaults RATE_LIMIT_QPS to 2). WebSearch is concurrency-safe, so agents can
// fire several searches at once — space call starts so a burst queues briefly
// instead of tripping the limit.
const MIN_CALL_SPACING_MS = 500

const RATE_LIMIT_PATTERN =
  /rate.?limit|quota|too many requests|\b429\b|limit (?:reached|exceeded)/i
const NO_RESULTS_PATTERN = /\bno (?:search )?results\b/i
const RESULT_HEADER = String.raw`^Title:[ \t]*(.*)\r?\nURL:[ \t]*(\S+)[ \t]*$`
const STRICT_RESULT_HEADER_PATTERN = new RegExp(
  `${RESULT_HEADER}(?=\\r?\\n(?:Published|Author|Highlights|Text|Summary):)`,
  'gm',
)
const LOOSE_RESULT_HEADER_PATTERN = new RegExp(RESULT_HEADER, 'gm')
const RATE_LIMITED_META_KEY = 'ai.exa/rateLimited'

// Once the free tier reports its limit, skip it for a while so auto mode goes
// straight to the next backend instead of paying a round trip (and the call
// spacing) on every search. The daily quota resets on Exa's side, so keep the
// cooldown short enough to notice.
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000

let lastCallAt = Number.NEGATIVE_INFINITY
let rateLimitedUntil = 0

/** Reset the call-spacing limiter and rate-limit cooldown (tests only). */
export function resetExaFreeRateLimiterForTests(): void {
  lastCallAt = Number.NEGATIVE_INFINITY
  rateLimitedUntil = 0
}

function rateLimitError(): Error {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
  return new Error(
    'Exa free tier limit reached. ' +
    'Add an Exa API key with /search key exa (or set EXA_API_KEY; free key at ' +
    'https://dashboard.exa.ai/api-keys) to lift the limit.',
  )
}

/**
 * Wait until MIN_CALL_SPACING_MS has passed since the last call started, then
 * claim the slot. Waiters reserve nothing while asleep, so a search that is
 * cancelled or times out in the queue never delays later ones; after waking,
 * each waiter re-checks (the first to wake claims the slot).
 */
async function waitForCallSlot(signal: AbortSignal): Promise<void> {
  for (;;) {
    const waitMs = lastCallAt + MIN_CALL_SPACING_MS - Date.now()
    if (waitMs <= 0) {
      lastCallAt = Date.now()
      return
    }
    await sleep(waitMs, signal, { abortError: () => toAbortError(signal.reason) })
  }
}

function buildQuery(input: SearchInput): string {
  const allowed = input.allowed_domains?.filter(Boolean) ?? []
  if (allowed.length === 0) return input.query
  return `${input.query} ${allowed.map(d => `site:${d}`).join(' OR ')}`
}

function buildObjective(input: SearchInput): string {
  const parts = [`Find web pages that answer: ${input.query}`]
  const allowed = input.allowed_domains?.filter(Boolean) ?? []
  const blocked = input.blocked_domains?.filter(Boolean) ?? []
  if (allowed.length) {
    parts.push(`Only include results from these domains: ${allowed.join(', ')}.`)
  }
  if (blocked.length) {
    parts.push(`Exclude results from these domains: ${blocked.join(', ')}.`)
  }
  return parts.join(' ').slice(0, MAX_OBJECTIVE_CHARS)
}

/** Trim a response body for an error message (HTML error pages can be huge). */
function errorDetail(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_DETAIL_CHARS)
}

// Exa's own rate-limit text tells MCP clients to edit their MCP server URL,
// which doesn't apply here — so rateLimitError() replaces the detail rather
// than echoing it.

function toolError(detail: string): Error {
  if (RATE_LIMIT_PATTERN.test(detail)) return rateLimitError()
  return new Error(`Exa free tier search error: ${detail.trim() || 'unknown error'}`)
}

/** Extract the JSON-RPC response from an SSE stream or a plain JSON body. */
function parseJsonRpcBody(body: string, contentType: string | null): unknown {
  if (!contentType?.includes('text/event-stream')) {
    try {
      return JSON.parse(body)
    } catch {
      throw new Error(`Exa free tier returned an unreadable response: ${errorDetail(body)}`)
    }
  }
  let message: unknown
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!data) continue
    try {
      const parsed = JSON.parse(data) as Record<string, unknown> | null
      if (parsed && typeof parsed === 'object' && ('result' in parsed || 'error' in parsed)) {
        message = parsed
      }
    } catch {
      // Non-JSON event payloads (keep-alives, comments) are skipped.
    }
  }
  if (message === undefined) {
    throw new Error('Exa free tier returned no JSON-RPC response')
  }
  return message
}

/** Concatenate the text parts of a JSON-RPC tools/call result. */
function extractResultText(rpc: unknown): string {
  const record = (rpc ?? {}) as Record<string, unknown>
  const error = record.error as { message?: unknown } | undefined
  if (error) {
    throw toolError(typeof error.message === 'string' ? error.message : '')
  }
  const result = (record.result ?? {}) as Record<string, unknown>
  const meta = (result._meta ?? {}) as Record<string, unknown>
  if (meta[RATE_LIMITED_META_KEY] === true) throw rateLimitError()
  const content = Array.isArray(result.content) ? result.content : []
  const text = (content as unknown[])
    .map(part => {
      const p = (part ?? {}) as Record<string, unknown>
      return p.type === 'text' && typeof p.text === 'string' ? p.text : ''
    })
    .filter(Boolean)
    .join('\n')
  if (result.isError === true) throw toolError(text)
  return text
}

function describeResultBody(body: string): string | undefined {
  const contentAt = body.search(/^(?:Highlights|Text|Summary):[ \t]*/m)
  const raw =
    contentAt >= 0
      ? body.slice(contentAt).replace(/^(?:Highlights|Text|Summary):[ \t]*\r?\n?/, '')
      : body.replace(/^(?:Published|Author):.*$/gm, '')
  let excerpt = raw
    .split(/\r?\n/)
    .filter(line => !/^\s*-{3,}\s*$/.test(line))
    .map(line => (line.trim() === '...' ? '…' : line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!excerpt) return undefined
  if (excerpt.length > MAX_DESCRIPTION_CHARS) {
    excerpt = `${excerpt.slice(0, MAX_DESCRIPTION_CHARS).replace(/\s+\S*$/, '')} …`
  }
  return excerpt
}

/**
 * Parse the free tier's plain-text result blocks into hits. Returns an empty
 * array only when the text has no result headers.
 */
export function parseExaFreeResults(text: string): SearchHit[] {
  let headers = [...text.matchAll(STRICT_RESULT_HEADER_PATTERN)]
  if (headers.length === 0) headers = [...text.matchAll(LOOSE_RESULT_HEADER_PATTERN)]
  const hits: SearchHit[] = []
  headers.forEach((match, i) => {
    const url = match[2] ?? ''
    if (!/^https?:\/\//i.test(url)) return
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = headers[i + 1]?.index ?? text.length
    hits.push({
      title: match[1]?.trim() || url,
      url,
      description: describeResultBody(text.slice(bodyStart, bodyEnd)),
      source: safeHostname(url),
    })
  })
  return hits
}

export const exaFreeProvider: SearchProvider = {
  name: 'exa-free',

  isConfigured() {
    return isExaFreeTierEnabled()
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    if (Date.now() < rateLimitedUntil) {
      throw new Error(
        'Exa free tier limit reached recently; skipping it for a few minutes. ' +
        'Add an Exa API key with /search key exa to lift the limit.',
      )
    }

    const text = await withWebSearchTimeout(
      async combinedSignal => {
        await waitForCallSlot(combinedSignal)
        const res = await fetch(EXA_FREE_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'x-exa-source': EXA_SOURCE_TAG,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'web_search_exa',
              arguments: {
                query: buildQuery(input),
                objective: buildObjective(input),
                numResults: getExaNumResults(),
              },
            },
          }),
          signal: combinedSignal,
        })

        const body = await res.text()
        if (res.status === 429) throw rateLimitError()
        if (!res.ok) {
          throw new Error(`Exa free tier search error ${res.status}: ${errorDetail(body)}`)
        }
        return extractResultText(parseJsonRpcBody(body, res.headers.get('content-type')))
      },
      signal,
      { providerName: 'Exa free tier' },
    )

    const hits = parseExaFreeResults(text)
    // A non-empty reply with no recognizable result blocks means the text
    // format changed — throw so auto mode falls through to the next backend
    // instead of reporting a misleading "no results".
    if (hits.length === 0 && text.trim() && !NO_RESULTS_PATTERN.test(text)) {
      if (RATE_LIMIT_PATTERN.test(text)) throw rateLimitError()
      throw new Error('Exa free tier returned an unrecognized response format')
    }

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'exa-free',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
