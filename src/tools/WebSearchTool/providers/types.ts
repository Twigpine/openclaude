/**
 * Search provider adapter types.
 *
 * Every backend implements SearchProvider. WebSearchTool.selectProvider()
 * picks the right one; shared logic (domain filtering, snippet formatting,
 * result-block construction) lives in the tool layer, not in adapters.
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface SearchHit {
  title: string
  url: string
  description?: string
  source?: string
}

export interface SearchInput {
  query: string
  allowed_domains?: string[]
  blocked_domains?: string[]
}

export interface ProviderOutput {
  hits: SearchHit[]
  /** Provider name for logging / tool_use_id */
  providerName: string
  /** Duration of the provider call in seconds */
  durationSeconds: number
  /**
   * In auto mode, continue to the next provider instead of returning this
   * output — e.g. when client-side domain filtering removed every hit and a
   * later backend may honor the filter server-side. Explicit modes return
   * the output as-is.
   */
  fallbackInAuto?: boolean
}

export interface SearchProvider {
  /** Human-readable label (used in tool_use_id, logs) */
  readonly name: string
  /** Returns true when the env vars / config needed for this provider are present */
  isConfigured(): boolean
  /** Perform the search. Throw on unrecoverable errors. */
  search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput>
}

// ---------------------------------------------------------------------------
// Flexible response parsing helpers
// ---------------------------------------------------------------------------

const TITLE_KEYS = ['title', 'headline', 'name', 'heading'] as const
const URL_KEYS = ['url', 'link', 'href', 'uri', 'permalink'] as const
const DESC_KEYS = [
  'description', 'snippet', 'content', 'preview', 'summary', 'text', 'body',
] as const
const SOURCE_KEYS = [
  'source', 'domain', 'displayLink', 'displayed_link', 'engine',
] as const

function firstMatch(obj: unknown, keys: readonly string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined
  const record = obj as Record<string, unknown>
  for (const k of keys) {
    const v = record[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/** Extract a SearchHit from any object shape using well-known field aliases. */
export function normalizeHit(raw: unknown): SearchHit | null {
  if (!raw || typeof raw !== 'object') return null
  const title = firstMatch(raw, TITLE_KEYS)
  const url = firstMatch(raw, URL_KEYS)
  if (!title && !url) return null
  const hit: SearchHit = { title: title ?? url!, url: url ?? title! }
  const desc = firstMatch(raw, DESC_KEYS)
  const source = firstMatch(raw, SOURCE_KEYS)
  if (desc) hit.description = desc
  if (source) hit.source = source
  return hit
}

// ---------------------------------------------------------------------------
// Domain filtering — shared across ALL providers
// ---------------------------------------------------------------------------

/** Safely extract hostname from a URL string. Returns undefined on parse failure. */
export function safeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return new URL(url).hostname } catch { return undefined }
}

/**
 * Check if a hostname exactly matches a domain or is a subdomain of it.
 * Example: hostMatchesDomain('sub.example.com', 'example.com') → true
 *          hostMatchesDomain('badexample.com', 'example.com') → false
 */
export function hostMatchesDomain(host: string, domain: string): boolean {
  // `host` arrives already lowercased (WHATWG `new URL().hostname` via
  // safeHostname), but `domain` comes straight from the caller's
  // allowed_domains / blocked_domains and is never normalized. Lowercase both
  // so a capitalized entry like `Reddit.com` still matches `reddit.com` — hosts
  // are case-insensitive, and without this `blocked_domains: ['Reddit.com']`
  // silently fails to block and `allowed_domains: ['GitHub.com']` drops every
  // legitimate hit.
  const normalizedHost = host.toLowerCase()
  const normalizedDomain = domain.toLowerCase()
  if (normalizedHost === normalizedDomain) return true
  // Subdomain: must end with `.domain` (not just `domain`)
  return normalizedHost.endsWith('.' + normalizedDomain)
}

export function applyDomainFilters(
  hits: SearchHit[],
  input: SearchInput,
): SearchHit[] {
  let out = hits
  if (input.blocked_domains?.length) {
    out = out.filter(h => {
      const host = safeHostname(h.url)
      if (!host) return true // can't confirm blocked → keep
      return !input.blocked_domains!.some(d => hostMatchesDomain(host, d))
    })
  }
  if (input.allowed_domains?.length) {
    out = out.filter(h => {
      const host = safeHostname(h.url)
      if (!host) return false // can't confirm allowed → drop
      return input.allowed_domains!.some(d => hostMatchesDomain(host, d))
    })
  }
  return out
}

