/**
 * Jina Search API adapter.
 * GET https://s.jina.ai/?q=...
 * Auth: Authorization: Bearer <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const jinaProvider: SearchProvider = {
  name: 'jina',

  isConfigured() {
    return Boolean(process.env.JINA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://s.jina.ai/')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', '10')

    const data = (await fetchJsonWithWebSearchTimeout(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.JINA_API_KEY}`,
          Accept: 'application/json',
        },
      },
      signal,
      { providerName: 'Jina' },
    )) as { data?: unknown; results?: unknown } | undefined

    const rawResults = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.results) ? data.results : [])
    const hits = (rawResults as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      const desc =
        typeof rec.description === 'string'
          ? rec.description
          : typeof rec.snippet === 'string'
            ? rec.snippet
            : typeof rec.content === 'string'
              ? rec.content
              : undefined
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description: desc,
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'jina',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
