/**
 * Provider registry and selection logic.
 *
 * WEB_SEARCH_PROVIDER controls which backend to use:
 *
 *   "auto"      (default) — try providers in priority order, fall through on failure
 *   "custom"    — use WEB_SEARCH_API / WEB_PROVIDER preset only (fail loudly)
 *   "ollama"    — use Ollama local/hosted Web Search API only (fail loudly)
 *   "firecrawl" — use Firecrawl only (fail loudly)
 *   "tavily"    — use Tavily only (fail loudly)
 *   "exa"       — use Exa only (fail loudly): the keyed API when EXA_API_KEY
 *                 is set, otherwise the keyless free tier
 *   "you"       — use You.com only (fail loudly)
 *   "jina"      — use Jina only (fail loudly)
 *   "brave"     — use Brave only (fail loudly)
 *   "bing"      — use Bing only (fail loudly)
 *   "mojeek"    — use Mojeek only (fail loudly)
 *   "linkup"    — use Linkup only (fail loudly)
 *   "ddg"       — use DuckDuckGo only (fail loudly)
 *   "native"    — use Anthropic native / Codex only (fail loudly)
 *
 * "auto" mode is the only mode that silently falls through to the next provider.
 * All other modes throw on failure — no silent backend switching.
 *
 * NOTE: "custom" is NOT included in the "auto" fallback chain.
 *       It is only used when WEB_SEARCH_PROVIDER=custom is explicitly selected.
 */

import type { SearchInput, SearchProvider } from './types.js'
import type { ProviderOutput } from './types.js'

import { customProvider } from './custom.js'
import { duckduckgoProvider } from './duckduckgo.js'
import { firecrawlProvider } from './firecrawl.js'
import { tavilyProvider } from './tavily.js'
import { exaProvider } from './exa.js'
import { exaFreeProvider } from './exaFree.js'
import { youProvider } from './you.js'
import { jinaProvider } from './jina.js'
import { braveProvider } from './brave.js'
import { bingProvider } from './bing.js'
import { mojeekProvider } from './mojeek.js'
import { linkupProvider } from './linkup.js'
import { ollamaProvider } from './ollama.js'

export { type SearchInput, type SearchProvider, type ProviderOutput, type SearchHit } from './types.js'
export { applyDomainFilters, safeHostname, hostMatchesDomain } from './types.js'
export { extractHits } from './custom.js'

// ---------------------------------------------------------------------------
// All registered providers — order matters for auto mode
// ---------------------------------------------------------------------------
// Priority: exa → ollama → firecrawl → tavily → you → jina → brave → bing → mojeek → linkup → exa-free → ddg
// Exa is the default search backend: the keyed API leads the chain whenever
// EXA_API_KEY is set. Any other backend the user configured with a key comes
// next, so an explicit setup still beats a free tier. The keyless Exa free
// tier is the zero-config default (per-second and daily limits), and DDG
// stays last because its scraper is the most aggressively rate-limited.
// Brave sits ahead of Bing because it runs an independent index (not Google/Bing
// dependent) and has a usable free tier; Bing's hosted API was sunsetted in 2025
// for new users, so it's a worse fallback in practice.
// NOTE: customProvider is intentionally excluded from the auto chain.
//       It is only available when WEB_SEARCH_PROVIDER=custom is explicitly set.
//       This prevents the generic outbound provider from silently becoming the default backend.

const ALL_PROVIDERS: SearchProvider[] = [
  exaProvider,
  ollamaProvider,
  firecrawlProvider,
  tavilyProvider,
  youProvider,
  jinaProvider,
  braveProvider,
  bingProvider,
  mojeekProvider,
  linkupProvider,
  exaFreeProvider,
  duckduckgoProvider,
]

export function getAvailableProviders(): SearchProvider[] {
  return ALL_PROVIDERS.filter(p => p.isConfigured())
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type ProviderMode =
  | 'auto'
  | 'custom'
  | 'ollama'
  | 'firecrawl'
  | 'ddg'
  | 'tavily'
  | 'exa'
  | 'you'
  | 'jina'
  | 'brave'
  | 'bing'
  | 'mojeek'
  | 'linkup'
  | 'native'

const PROVIDER_BY_NAME: Record<string, SearchProvider> = {
  custom: customProvider,
  ollama: ollamaProvider,
  firecrawl: firecrawlProvider,
  ddg: duckduckgoProvider,
  tavily: tavilyProvider,
  exa: exaProvider,
  you: youProvider,
  jina: jinaProvider,
  brave: braveProvider,
  bing: bingProvider,
  mojeek: mojeekProvider,
  linkup: linkupProvider,
}

const VALID_MODES = new Set<string>(Object.keys(PROVIDER_BY_NAME).concat(['auto', 'native']))

export function getProviderMode(): ProviderMode {
  const raw = process.env.WEB_SEARCH_PROVIDER ?? 'auto'
  if (VALID_MODES.has(raw)) return raw as ProviderMode
  return 'auto'
}

/**
 * Returns the list of providers to try, in order.
 * - Specific mode → single provider
 * - Auto → priority order (ALL_PROVIDERS, filtered by isConfigured)
 */
export function getProviderChain(mode: ProviderMode): SearchProvider[] {
  if (mode === 'auto') {
    return ALL_PROVIDERS.filter(p => p.isConfigured())
  }
  if (mode === 'native') {
    return []
  }
  if (mode === 'exa' && !exaProvider.isConfigured() && exaFreeProvider.isConfigured()) {
    return [exaFreeProvider]
  }
  const provider = PROVIDER_BY_NAME[mode]
  if (!provider) return []
  return [provider]
}

/**
 * Run a search using the configured provider chain.
 *
 * - Auto mode: tries each provider in order, falls through on failure.
 *   If ALL providers fail, throws the last error.
 * - Specific mode: runs the single provider, throws immediately on failure.
 */
export async function runSearch(
  input: SearchInput,
  signal?: AbortSignal,
): Promise<ProviderOutput> {
  const mode = getProviderMode()
  const chain = getProviderChain(mode)

  if (chain.length === 0) {
    throw new Error(
      mode === 'native'
        ? 'Native web search requires firstParty/vertex/foundry provider.'
        : `No search providers available for mode "${mode}". Check your env vars.`,
    )
  }

  const errors: Error[] = []

  // Explicit provider mode: fail fast if the provider isn't configured
  if (mode !== 'auto' && mode !== 'native') {
    const provider = chain[0]
    if (provider && !provider.isConfigured()) {
      throw new Error(
        `Search provider "${mode}" is not configured. ` +
        `Set the required environment variable (e.g. ${mode.toUpperCase()}_API_KEY) ` +
        `or switch to WEB_SEARCH_PROVIDER=auto.`,
      )
    }
  }

  for (const provider of chain) {
    try {
      return await provider.search(input, signal)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))

      // Cancellation must stop immediately — don't fall through to other providers
      if (error.name === 'AbortError' || signal?.aborted) {
        throw error
      }

      errors.push(error)

      // Specific mode: fail loudly, no fallback
      if (mode !== 'auto') {
        throw error
      }

      // Auto mode: log and try next
      console.error(`[web-search] ${provider.name} failed: ${error.message}`)
    }
  }

  // All providers failed in auto mode
  const lastErr = errors[errors.length - 1]
  if (!lastErr) throw new Error('All search providers failed with no error details.')
  if (errors.length === 1) throw lastErr
  throw new Error(
    `All ${errors.length} search providers failed:\n` +
    errors.map((e, i) => `  ${i + 1}. ${e.message}`).join('\n'),
  )
}
