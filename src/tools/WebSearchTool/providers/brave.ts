/**
 * Brave Search API adapter.
 * GET https://api.search.brave.com/res/v1/web/search?q=...
 * Auth: X-Subscription-Token: <key>   (bare token — no "Bearer" prefix)
 *
 * Brave runs an independent web index (~30B pages) — useful as a non-Google,
 * non-Bing fallback in the auto chain.
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const braveProvider: SearchProvider = {
  name: 'brave',

  isConfigured() {
    return Boolean(process.env.BRAVE_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://api.search.brave.com/res/v1/web/search')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', '15')

    const data = (await fetchJsonWithWebSearchTimeout(
      url.toString(),
      {
        headers: {
          'X-Subscription-Token': process.env.BRAVE_API_KEY!,
          Accept: 'application/json',
        },
      },
      signal,
      { providerName: 'Brave' },
    )) as { web?: { results?: unknown } } | undefined

    const rawResults = data?.web?.results
    const results = Array.isArray(rawResults) ? rawResults : []
    const hits = (results as unknown[]).map((r) => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description: typeof rec.description === 'string' ? rec.description : undefined,
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'brave',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
