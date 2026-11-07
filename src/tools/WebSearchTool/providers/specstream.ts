/**
 * SpecStream Search API adapter.
 * GET https://api.specstream.ai/v1/web-search?q=...
 * Auth: Authorization: Bearer <SPECSTREAM_API_KEY>
 *
 * Explicit-only: selected with WEB_SEARCH_PROVIDER=specstream (or
 * /search specstream) and never part of the auto chain.
 *
 * Replies are wrapped as { data: { sources: [{ title, url, snippet, published }] } }.
 * The API has no result count parameter, so the list is trimmed here, and the
 * question is capped at the 2000 characters the API accepts.
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

const SPECSTREAM_SEARCH_URL = 'https://api.specstream.ai/v1/web-search'
const MAX_QUERY_CHARS = 2000
const MAX_RESULTS = 10

export const specstreamProvider: SearchProvider = {
  name: 'specstream',

  isConfigured() {
    return Boolean(process.env.SPECSTREAM_API_KEY?.trim())
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const params = new URLSearchParams({
      q: Array.from(input.query).slice(0, MAX_QUERY_CHARS).join(''),
    })

    const body = (await fetchJsonWithWebSearchTimeout(
      `${SPECSTREAM_SEARCH_URL}?${params.toString()}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${process.env.SPECSTREAM_API_KEY?.trim() ?? ''}`,
        },
      },
      signal,
      { providerName: 'SpecStream' },
    )) as { data?: { sources?: unknown } } | undefined

    const sources = body?.data?.sources
    if (!Array.isArray(sources)) {
      throw new Error('SpecStream search returned an invalid response')
    }

    const hits = (sources as unknown[]).flatMap(raw => {
      const rec = (raw ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      if (!url) return []
      return [{
        title: typeof rec.title === 'string' && rec.title ? rec.title : url,
        url,
        description: typeof rec.snippet === 'string' && rec.snippet ? rec.snippet : undefined,
        source: safeHostname(url),
      }]
    })

    return {
      hits: applyDomainFilters(hits, input).slice(0, MAX_RESULTS),
      providerName: 'specstream',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
