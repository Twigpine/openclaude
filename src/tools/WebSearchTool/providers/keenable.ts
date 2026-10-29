/**
 * Keenable Search API adapter.
 * Keyless: POST https://api.keenable.ai/v1/search/public
 * Keyed:   POST https://api.keenable.ai/v1/search  (X-API-Key: <key>)
 *
 * Explicit-only: selected with WEB_SEARCH_PROVIDER=keenable (or
 * /search keenable) and never part of the auto chain. Works without a key;
 * KEENABLE_API_KEY only lifts the keyless rate limits. Keyless requests must
 * name the calling app in X-Keenable-Title.
 *
 * Results carry the page text in `snippet`, often several thousand characters
 * with newlines, so it is flattened and capped. `description` is usually
 * empty and is used only when a result has no snippet.
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { withWebSearchTimeout } from './timeout.js'

const KEENABLE_PUBLIC_URL = 'https://api.keenable.ai/v1/search/public'
const KEENABLE_KEYED_URL = 'https://api.keenable.ai/v1/search'
const KEENABLE_APP_TITLE = 'OpenClaude'
const MAX_RESULTS = 10
const MAX_DESCRIPTION_CHARS = 800
const MAX_ERROR_DETAIL_CHARS = 200

/** Flatten a snippet to one line and cap it at a word boundary. */
function describeSnippet(snippet: unknown): string | undefined {
  if (typeof snippet !== 'string') return undefined
  const excerpt = snippet.replace(/\s+/g, ' ').trim()
  if (!excerpt) return undefined
  if (excerpt.length <= MAX_DESCRIPTION_CHARS) return excerpt
  return `${excerpt.slice(0, MAX_DESCRIPTION_CHARS).replace(/\s+\S*$/, '')} …`
}

/** Trim an error body for a message, never echoing the key. */
function errorDetail(rawBody: string, key: string | undefined): string {
  let compact = rawBody.replace(/\s+/g, ' ').trim()
  if (key) compact = compact.split(key).join('[redacted]')
  if (!compact) return ''
  const clipped = compact.slice(0, MAX_ERROR_DETAIL_CHARS)
  return `: ${clipped}${compact.length > MAX_ERROR_DETAIL_CHARS ? '…' : ''}`
}

export const keenableProvider: SearchProvider = {
  name: 'keenable',

  isConfigured() {
    return true
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const key = process.env.KEENABLE_API_KEY?.trim() || undefined
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Keenable-Title': KEENABLE_APP_TITLE,
    }
    if (key) headers['X-API-Key'] = key

    const { response, rawBody } = await withWebSearchTimeout(async combinedSignal => {
      const response = await fetch(key ? KEENABLE_KEYED_URL : KEENABLE_PUBLIC_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: input.query, max_results: MAX_RESULTS }),
        signal: combinedSignal,
      })
      return { response, rawBody: await response.text() }
    }, signal, { providerName: 'Keenable' })

    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? ' (check KEENABLE_API_KEY)'
        : response.status === 429
          ? key
            ? ' (rate limit exceeded)'
            : ' (keyless rate limit exceeded; add a key with /search key keenable)'
          : ''
      throw new Error(
        `Keenable search error HTTP ${response.status}${hint}${errorDetail(rawBody, key)}`,
      )
    }

    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = undefined
    }
    const results = (body as { results?: unknown } | undefined)?.results
    if (!Array.isArray(results)) {
      throw new Error('Keenable search returned an invalid response')
    }

    const hits = (results as unknown[]).flatMap(raw => {
      const rec = (raw ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      if (!url) return []
      return [{
        title: typeof rec.title === 'string' && rec.title ? rec.title : url,
        url,
        description: describeSnippet(rec.snippet) ?? describeSnippet(rec.description),
        source: safeHostname(url),
      }]
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'keenable',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
