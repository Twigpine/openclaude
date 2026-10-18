/**
 * You.com Search API adapter.
 * GET https://api.ydc-index.io/v1/search?query=...
 * Auth: X-API-Key: <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const youProvider: SearchProvider = {
  name: 'you',

  isConfigured() {
    return Boolean(process.env.YOU_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://api.ydc-index.io/v1/search')
    url.searchParams.set('query', input.query)
    url.searchParams.set('num_web_results', '10')

    const data = (await fetchJsonWithWebSearchTimeout(
      url.toString(),
      {
        headers: { 'X-API-Key': process.env.YOU_API_KEY! },
      },
      signal,
      { providerName: 'You.com' },
    )) as { results?: { web?: unknown } | unknown } | undefined

    const resultsField = data?.results
    const nestedWeb =
      resultsField && typeof resultsField === 'object' && 'web' in resultsField
        ? (resultsField as { web?: unknown }).web
        : undefined
    const rawResults = Array.isArray(nestedWeb)
      ? nestedWeb
      : Array.isArray(resultsField)
        ? resultsField
        : []

    const hits = (rawResults as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      const snippets = Array.isArray(rec.snippets) ? rec.snippets : []
      const snippet = snippets.length > 0 && typeof snippets[0] === 'string' ? snippets[0] : undefined
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description:
          snippet ??
          (typeof rec.snippet === 'string'
            ? rec.snippet
            : typeof rec.description === 'string'
              ? rec.description
              : undefined),
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'you',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
