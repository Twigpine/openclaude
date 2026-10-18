/**
 * Linkup Search API adapter.
 * POST https://api.linkup.so/v1/search
 * Auth: Authorization: Bearer <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const linkupProvider: SearchProvider = {
  name: 'linkup',

  isConfigured() {
    return Boolean(process.env.LINKUP_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const data = (await fetchJsonWithWebSearchTimeout(
      'https://api.linkup.so/v1/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LINKUP_API_KEY}`,
        },
        body: JSON.stringify({
          q: input.query,
          search_type: 'standard',
          depth: 'standard',
        }),
      },
      signal,
      { providerName: 'Linkup' },
    )) as { results?: unknown } | undefined

    const rawResults = Array.isArray(data?.results) ? data.results : []
    const hits = (rawResults as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      const desc =
        typeof rec.snippet === 'string'
          ? rec.snippet
          : typeof rec.description === 'string'
            ? rec.description
            : typeof rec.content === 'string'
              ? rec.content
              : undefined
      return {
        title: typeof rec.name === 'string' ? rec.name : (typeof rec.title === 'string' ? rec.title : ''),
        url,
        description: desc,
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'linkup',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
