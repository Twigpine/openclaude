/**
 * Tavily Search API adapter.
 * POST https://api.tavily.com/search
 * Auth: Authorization: Bearer tvly-xxxx
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const tavilyProvider: SearchProvider = {
  name: 'tavily',

  isConfigured() {
    return Boolean(process.env.TAVILY_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const data = (await fetchJsonWithWebSearchTimeout(
      'https://api.tavily.com/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: input.query,
          max_results: 15,
          include_answer: false,
        }),
      },
      signal,
      { providerName: 'Tavily' },
    )) as { results?: unknown } | undefined

    const rawResults = Array.isArray(data?.results) ? data.results : []
    const hits = (rawResults as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description:
          typeof rec.content === 'string'
            ? rec.content
            : typeof rec.snippet === 'string'
              ? rec.snippet
              : undefined,
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'tavily',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
