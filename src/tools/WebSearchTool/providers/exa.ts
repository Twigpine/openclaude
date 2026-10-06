/**
 * Exa Search API adapter.
 * POST https://api.exa.ai/search
 * Auth: x-api-key: <key>
 *
 * Canonical reference:
 *   https://docs.exa.ai/reference/search-api-guide-for-coding-agents
 *
 * We request `contents.highlights: true` because the Exa docs explicitly
 * recommend highlights for agent workflows (10x fewer tokens than full text,
 * with the most query-relevant excerpts). Without `contents`, Exa returns
 * results with no excerpts at all — descriptions would be empty for every hit.
 *
 * Response shape (relevant fields):
 *   results[].title           string
 *   results[].url             string
 *   results[].highlights      string[]   (when contents.highlights requested)
 *   results[].highlightScores number[]   (cosine similarity per highlight)
 *   results[].text            string     (only when contents.text requested)
 *
 * Tuning (env):
 *   EXA_SEARCH_TYPE  auto (default) | instant | fast | deep-lite | deep |
 *                    deep-reasoning (https://exa.ai/docs/reference/search)
 *   EXA_NUM_RESULTS  results per search, 1–50 (default 15); also used by the
 *                    keyless free-tier adapter (exaFree.ts)
 *   EXA_FREE_TIER    0/false/off disables the keyless free-tier fallback
 */

import { isEnvDefinedFalsy } from '../../../utils/envUtils.js'
import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const DEFAULT_EXA_NUM_RESULTS = 15
const MAX_EXA_NUM_RESULTS = 50

const EXA_SEARCH_TYPES = new Set([
  'auto',
  'instant',
  'fast',
  'deep-lite',
  'deep',
  'deep-reasoning',
])

/** EXA_NUM_RESULTS clamped to 1–50; invalid or empty values use the default. */
export function getExaNumResults(env: NodeJS.ProcessEnv = process.env): number {
  const trimmed = env.EXA_NUM_RESULTS?.trim()
  if (!trimmed || !/^\d+$/.test(trimmed)) return DEFAULT_EXA_NUM_RESULTS
  const count = Number(trimmed)
  if (count < 1) return DEFAULT_EXA_NUM_RESULTS
  return Math.min(count, MAX_EXA_NUM_RESULTS)
}

/** EXA_SEARCH_TYPE when it names a known Exa search type, otherwise "auto". */
export function getExaSearchType(env: NodeJS.ProcessEnv = process.env): string {
  const normalized = env.EXA_SEARCH_TYPE?.trim().toLowerCase()
  return normalized && EXA_SEARCH_TYPES.has(normalized) ? normalized : 'auto'
}

/** The keyless free tier is on unless EXA_FREE_TIER is explicitly falsy. */
export function isExaFreeTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isEnvDefinedFalsy(env.EXA_FREE_TIER)
}

/** Join up to 3 highlight excerpts with an ellipsis separator. */
function describeFromHighlights(r: unknown): string | undefined {
  if (!r || typeof r !== 'object') return undefined
  const rec = r as Record<string, unknown>
  const highlights = Array.isArray(rec.highlights) ? rec.highlights : null
  if (highlights && highlights.length > 0) {
    return (highlights as unknown[]).slice(0, 3).filter((s): s is string => typeof s === 'string').join(' … ')
  }
  if (typeof rec.text === 'string' && rec.text) return rec.text
  return undefined
}

export const exaProvider: SearchProvider = {
  name: 'exa',

  isConfigured() {
    return Boolean(process.env.EXA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const body: Record<string, unknown> = {
      query: input.query,
      numResults: getExaNumResults(),
      type: getExaSearchType(),
      contents: { highlights: true },
    }

    if (input.allowed_domains?.length) body.includeDomains = input.allowed_domains
    if (input.blocked_domains?.length) body.excludeDomains = input.blocked_domains

    const data = (await fetchJsonWithWebSearchTimeout(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.EXA_API_KEY!,
        },
        body: JSON.stringify(body),
      },
      signal,
      { providerName: 'Exa' },
    )) as { results?: unknown }

    const results = Array.isArray(data.results) ? data.results : []
    const hits = (results as unknown[]).map((r): {
      title: string
      url: string
      description: string | undefined
      source: string | undefined
    } => {
      const rec = (r ?? {}) as Record<string, unknown>
      const url = typeof rec.url === 'string' ? rec.url : ''
      return {
        title: typeof rec.title === 'string' ? rec.title : '',
        url,
        description: describeFromHighlights(r),
        source: url ? safeHostname(url) : undefined,
      }
    })

    return {
      // Exa handles domain filtering server-side via includeDomains/excludeDomains
      hits,
      providerName: 'exa',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
