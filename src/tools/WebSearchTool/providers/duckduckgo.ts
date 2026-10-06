import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, type ProviderOutput } from './types.js'
import {
  isWebSearchTimeoutError,
  toAbortError,
  withWebSearchTimeout,
} from './timeout.js'

// DuckDuckGo's HTML scraper aggressively blocks datacenter / repeat IPs with
// an "anomaly in the request" response. When that happens we surface an
// actionable error instead of the opaque scraper message so users know how
// to configure a working backend.
const DDG_ANOMALY_HINT =
  'DuckDuckGo scraping is rate-limited from this network. ' +
  'Run /search to configure a backend, or set EXA_API_KEY (recommended) or one of: ' +
  'OLLAMA_BASE_URL, OLLAMA_API_KEY, FIRECRAWL_API_KEY, TAVILY_API_KEY, YOU_API_KEY, ' +
  'JINA_API_KEY, BING_API_KEY, MOJEEK_API_KEY, LINKUP_API_KEY — ' +
  'or use an Anthropic / Vertex / Foundry provider for native web search.'

const MAX_RETRIES = 3
const INITIAL_BACKOFF_MS = 1000

function isAnomalyError(message: string): boolean {
  return /anomaly in the request|likely making requests too quickly/i.test(
    message,
  )
}

function isRetryableDDGError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (isWebSearchTimeoutError(err)) return false
  const msg = err.message.toLowerCase()
  return (
    msg.includes('anomaly') ||
    msg.includes('too quickly') ||
    msg.includes('rate limit') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnaborted')
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(toAbortError(signal.reason))
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      cleanup()
      reject(toAbortError(signal?.reason))
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',

  isConfigured() {
    // DDG is the default fallback — always available (duck-duck-scrape is a runtime dep)
    return true
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    let search: typeof import('duck-duck-scrape').search
    let SafeSearchType: typeof import('duck-duck-scrape').SafeSearchType
    try {
      ;({ search, SafeSearchType } = await import('duck-duck-scrape'))
    } catch {
      throw new Error('duck-duck-scrape package not installed. Run: npm install duck-duck-scrape')
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    let lastErr: unknown
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      try {
        const response = await withWebSearchTimeout(
          combinedSignal =>
            search(
              input.query,
              { safeSearch: SafeSearchType.STRICT },
              { signal: combinedSignal } as Parameters<typeof search>[2],
            ),
          signal,
          { providerName: 'DuckDuckGo' },
        )

        const hits = applyDomainFilters(
          response.results.map(r => ({
            title: r.title || r.url,
            url: r.url,
            description: r.description ?? undefined,
          })),
          input,
        )

        return {
          hits,
          providerName: 'duckduckgo',
          durationSeconds: (performance.now() - start) / 1000,
        }
      } catch (err) {
        lastErr = err
        const msg = err instanceof Error ? err.message : String(err)
        if (isAnomalyError(msg)) {
          throw new Error(DDG_ANOMALY_HINT)
        }
        if (!isRetryableDDGError(err) || attempt === MAX_RETRIES - 1) {
          throw err
        }
        // Exponential backoff with jitter: 1s, 2s, 4s +/- 20%
        const baseDelay = INITIAL_BACKOFF_MS * Math.pow(2, attempt)
        const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1)
        await sleep(baseDelay + jitter, signal)
      }
    }

    throw lastErr
  },
}
