import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { withWebSearchTimeout } from './timeout.js'

const ANYSEARCH_URL = 'https://api.anysearch.com/v1/search'
const DEFAULT_MAX_RESULTS = 10
const MAX_ERROR_SNIPPET_LENGTH = 200

function maxResults(): number {
  const raw = process.env.ANYSEARCH_MAX_RESULTS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_MAX_RESULTS
  const value = Number(raw)
  return Number.isInteger(value) && value >= 1 && value <= 10
    ? value
    : DEFAULT_MAX_RESULTS
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function errorDetail(envelope: Record<string, unknown> | undefined): string {
  const requestId = envelope?.request_id
  return typeof requestId === 'string' && requestId
    ? ` (request_id: ${requestId})`
    : ''
}

function errorBodySnippet(rawBody: string): string {
  const compact = rawBody
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return ''

  const sanitized = compact
    .replace(
      /((?:api[_ -]?key|authorization|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      '$1[redacted]',
    )
    .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
  const clipped = sanitized.slice(0, MAX_ERROR_SNIPPET_LENGTH)
  return ` (response: ${clipped}${sanitized.length > MAX_ERROR_SNIPPET_LENGTH ? '…' : ''})`
}

export const anysearchProvider: SearchProvider = {
  name: 'anysearch',

  isConfigured() {
    return true
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const key = process.env.ANYSEARCH_API_KEY?.trim()
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Anysearch-Client': 'openclaude/anysearch-v1',
    }
    if (key) headers.Authorization = `Bearer ${key}`

    const { response, body, rawBody } = await withWebSearchTimeout(async combinedSignal => {
      const response = await fetch(ANYSEARCH_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: input.query, max_results: maxResults() }),
        signal: combinedSignal,
      })
      const rawBody = await response.text()
      let body: unknown
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = undefined
      }
      return { response, body, rawBody }
    }, signal, { providerName: 'AnySearch' })

    const envelope = record(body)
    const detail = errorDetail(envelope)
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? ' (check ANYSEARCH_API_KEY)'
        : response.status === 429
          ? ' (rate limit or quota exceeded)'
          : ''
      const responseDetail = body === undefined ? errorBodySnippet(rawBody) : ''
      throw new Error(`AnySearch search error HTTP ${response.status}${hint}${detail}${responseDetail}`)
    }
    if (!envelope || typeof envelope.code !== 'number') {
      throw new Error('AnySearch search returned an invalid response')
    }
    if (envelope.code !== 0) {
      throw new Error(`AnySearch search error code ${envelope.code}${detail}`)
    }
    const data = record(envelope.data)
    if (!Array.isArray(data?.results)) {
      throw new Error(`AnySearch search returned an invalid results list${detail}`)
    }

    const hits = data.results.map((raw: unknown) => {
      const result = record(raw)
      const title = result?.title
      const url = result?.url
      if (typeof title !== 'string' || !title || typeof url !== 'string' || !url) {
        throw new Error(`AnySearch search returned an invalid result${detail}`)
      }
      const description = typeof result.content === 'string' && result.content
        ? result.content
        : typeof result.snippet === 'string' && result.snippet
          ? result.snippet
          : undefined
      return {
        title,
        url,
        description,
        source: safeHostname(url),
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'anysearch',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
