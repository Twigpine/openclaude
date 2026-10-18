/**
 * Mojeek Search API adapter.
 * GET https://www.mojeek.com/search?q=...&fmt=json
 * Auth: optional Bearer for API tier
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const mojeekProvider: SearchProvider = {
  name: 'mojeek',

  isConfigured() {
    return Boolean(process.env.MOJEEK_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://www.mojeek.com/search')
    url.searchParams.set('q', input.query)
    url.searchParams.set('fmt', 'json')
    url.searchParams.set('t', '10')

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    }
    if (process.env.MOJEEK_API_KEY) {
      headers['Authorization'] = `Bearer ${process.env.MOJEEK_API_KEY}`
    }

    const data = (await fetchJsonWithWebSearchTimeout(
      url.toString(),
      {
        headers,
      },
      signal,
      { providerName: 'Mojeek' },
    )) as { response?: { results?: unknown }; results?: unknown } | undefined

    const nestedResults = data?.response?.results
    const rawResults = Array.isArray(nestedResults)
      ? nestedResults
      : Array.isArray(data?.results)
        ? data.results
        : []

    const hits = (rawResults as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description:
          typeof rec.snippet === 'string'
            ? rec.snippet
            : typeof rec.desc === 'string'
              ? rec.desc
              : undefined,
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'mojeek',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
