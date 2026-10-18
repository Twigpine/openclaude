/**
 * Ollama Web Search API adapter.
 *
 * Signed-in local Ollama servers proxy search through the experimental local
 * endpoint. An API key enables the hosted endpoint as a fallback.
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'
import { sanitizeApiKey } from '../../../utils/providerSecrets.js'

const OLLAMA_HOSTED_WEB_SEARCH_URL = 'https://ollama.com/api/web_search'

type OllamaSearchTarget = {
  label: string
  url: string
  authorization?: string
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function getUsableOllamaBaseUrlEnvValue(
  value: string | undefined,
): string | undefined {
  const trimmed = nonEmpty(value)
  if (!trimmed) return undefined
  const normalized = trimmed.toLowerCase()
  return normalized === 'undefined' || normalized === 'null'
    ? undefined
    : trimmed
}

export function getUsableOllamaApiKey(
  value: string | undefined,
): string | undefined {
  return sanitizeApiKey(value)?.trim()
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized &&
    normalized !== '0' &&
    normalized !== 'false' &&
    normalized !== 'no',
  )
}

export function isOllamaWebSearchBaseUrl(value: string | undefined): boolean {
  const trimmed = getUsableOllamaBaseUrlEnvValue(value)
  if (!trimmed) return false

  try {
    const parsed = new URL(trimmed)
    const host = parsed.host.toLowerCase()
    const hostnameLabels = parsed.hostname.toLowerCase().split('.')
    const pathSegments = parsed.pathname
      .toLowerCase()
      .split('/')
      .filter(Boolean)
    return (
      host.endsWith(':11434') ||
      hostnameLabels.includes('ollama') ||
      pathSegments.includes('ollama')
    )
  } catch {
    return false
  }
}

function normalizeOllamaApiBaseUrl(value: string): string {
  const parsed = new URL(value)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('configured endpoint is not a valid HTTP(S) URL')
  }
  const pathname = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = pathname.endsWith('/v1')
    ? pathname.slice(0, -3) || '/'
    : pathname || '/'
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

function getConfiguredLocalBaseUrl(): string | undefined {
  const explicitOllamaBaseUrl = getUsableOllamaBaseUrlEnvValue(
    process.env.OLLAMA_BASE_URL,
  )
  if (explicitOllamaBaseUrl) return explicitOllamaBaseUrl

  if (!isTruthyEnv(process.env.CLAUDE_CODE_USE_OPENAI)) return undefined

  const openAIBaseUrl =
    getUsableOllamaBaseUrlEnvValue(process.env.OPENAI_BASE_URL) ??
    getUsableOllamaBaseUrlEnvValue(process.env.OPENAI_API_BASE)
  const markedOllamaRoute =
    nonEmpty(process.env.CLAUDE_CODE_PROVIDER_ROUTE_ID)?.toLowerCase() === 'ollama'
  if (!markedOllamaRoute && !isOllamaWebSearchBaseUrl(openAIBaseUrl)) {
    return undefined
  }

  return openAIBaseUrl
}

function getSearchTargets(): {
  targets: OllamaSearchTarget[]
  errors: string[]
} {
  const targets: OllamaSearchTarget[] = []
  const errors: string[] = []
  const localBaseUrl = getConfiguredLocalBaseUrl()
  const apiKey = getUsableOllamaApiKey(process.env.OLLAMA_API_KEY)

  if (localBaseUrl) {
    try {
      targets.push({
        label: 'local',
        url: `${normalizeOllamaApiBaseUrl(localBaseUrl)}/api/experimental/web_search`,
      })
    } catch {
      errors.push('local: configured endpoint is not a valid HTTP(S) URL')
    }
  }

  if (apiKey) {
    targets.push({
      label: 'hosted',
      url: OLLAMA_HOSTED_WEB_SEARCH_URL,
      authorization: `Bearer ${apiKey}`,
    })
  }

  return { targets, errors }
}

export const ollamaProvider: SearchProvider = {
  name: 'ollama',

  isConfigured() {
    return getSearchTargets().targets.length > 0
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const { targets, errors } = getSearchTargets()

    if (targets.length === 0) {
      if (errors.length > 0) {
        throw new Error(`Ollama web search failed (${errors.join('; ')})`)
      }
      throw new Error(
        'Ollama search requires an active Ollama provider, OLLAMA_BASE_URL, or OLLAMA_API_KEY.',
      )
    }

    for (const [targetIndex, target] of targets.entries()) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (target.authorization) {
          headers.Authorization = target.authorization
        }

        const data = await fetchJsonWithWebSearchTimeout(
          target.url,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              query: input.query,
              max_results: 10,
            }),
          },
          signal,
          { providerName: `Ollama ${target.label}` },
        )

        const rawResults =
          data && typeof data === 'object' && 'results' in data
            ? data.results
            : undefined
        if (!Array.isArray(rawResults)) {
          throw new Error('response did not contain a results array')
        }

        const hits = rawResults
          .filter((result: unknown): result is Record<string, unknown> =>
            Boolean(result) && typeof result === 'object',
          )
          .map(result => {
            const title = typeof result.title === 'string' ? result.title : ''
            const url = typeof result.url === 'string' ? result.url : ''
            const content =
              typeof result.content === 'string' ? result.content : undefined
            return {
              title: title || url,
              url,
              description: content,
              source: safeHostname(url),
            }
          })
          .filter(hit => Boolean(hit.title && hit.url))

        if (hits.length === 0 && targetIndex < targets.length - 1) {
          throw new Error('response contained no usable results')
        }

        return {
          hits: applyDomainFilters(hits, input),
          providerName: 'ollama',
          durationSeconds: (performance.now() - start) / 1000,
        }
      } catch (error) {
        if (isAbortError(error, signal)) throw error
        const message = error instanceof Error ? error.message : String(error)
        errors.push(`${target.label}: ${message}`)
      }
    }

    throw new Error(`Ollama web search failed (${errors.join('; ')})`)
  },
}
