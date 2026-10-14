/**
 * Build and run availability probes for a route's models.
 *
 * The probe request must match the route's inference transport, otherwise a
 * model gets blamed for a shape mismatch. `anthropic-proxy` routes probe
 * `/v1/messages`; `openai-compatible` routes probe `/chat/completions`.
 */

import {
  probeAvailabilityBatch,
  type ModelAvailability,
  type ProbePlanBuilder,
} from './modelAvailability.js'
import {
  clearCachedAvailability,
  getCachedAvailability,
  setCachedAvailability,
} from './modelAvailabilityCache.js'
import { getTransportKindForRoute } from '../../integrations/routeMetadata.js'

export type ProbeRouteAvailabilityOptions = {
  routeId: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  models: string[]
  concurrency?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?: (completed: number, total: number) => void
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

function buildProbePlan(
  transportKind: string,
  options: {
    baseUrl?: string
    apiKey?: string
    headers?: Record<string, string>
  },
): ProbePlanBuilder {
  const base = trimTrailingSlashes(
    options.baseUrl ?? 'https://api.anthropic.com',
  )
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  const apiKey = options.apiKey?.trim()

  if (transportKind === 'anthropic-proxy') {
    headers['anthropic-version'] ??= '2023-06-01'
    if (apiKey) {
      headers['x-api-key'] ??= apiKey
      headers.Authorization ??= `Bearer ${apiKey}`
    }
    const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`
    return model => ({
      url,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      },
    })
  }

  // Default: OpenAI-compatible chat completions.
  if (apiKey) {
    headers.Authorization ??= `Bearer ${apiKey}`
  }
  return model => ({
    url: `${base}/chat/completions`,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: {
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    },
  })
}

/** Probe every model and persist the verdicts under the caller's scope key. */
export async function probeRouteAvailability(
  options: ProbeRouteAvailabilityOptions & { scopeKey?: string },
): Promise<Record<string, ModelAvailability>> {
  const transportKind = getTransportKindForRoute(options.routeId) ?? 'openai-compatible'
  const buildPlan = buildProbePlan(transportKind, {
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    headers: options.headers,
  })

  const results = await probeAvailabilityBatch({
    models: options.models,
    buildPlan,
    concurrency: options.concurrency,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    onProgress: options.onProgress,
  })

  setCachedAvailability(
    options.scopeKey ?? availabilityScopeKey(options),
    results,
  )
  return results
}

/**
 * Default scope key for a route's probe results.
 *
 * Callers that already own a cache identity (the model catalog's
 * `getDiscoveryCacheKey`) should pass it as `scopeKey` instead, so a probe is
 * read back from the same partition the picker renders from.
 */
export function availabilityScopeKey(
  options: Pick<ProbeRouteAvailabilityOptions, 'routeId' | 'baseUrl' | 'apiKey'>,
): string {
  const parts = [
    options.routeId,
    trimTrailingSlashes(options.baseUrl ?? ''),
    options.apiKey?.trim() ? 'credential' : 'anonymous',
  ]
  return parts.join('|')
}

export function readCachedRouteAvailability(
  scopeKey: string,
): Record<string, ModelAvailability> {
  return getCachedAvailability(scopeKey)
}

export function clearRouteAvailability(scopeKey?: string): void {
  clearCachedAvailability(scopeKey)
}

/** One-line summary of a probe run, for the picker's status line. */
export function summarizeAvailability(
  results: Record<string, ModelAvailability>,
): string {
  const counts = new Map<string, number>()
  for (const availability of Object.values(results)) {
    counts.set(
      availability.state,
      (counts.get(availability.state) ?? 0) + 1,
    )
  }

  const available = counts.get('available') ?? 0
  const unusable = (counts.get('unavailable') ?? 0) +
    (counts.get('deprecated') ?? 0) +
    (counts.get('auth-failed') ?? 0)
  const retryable = (counts.get('rate-limited') ?? 0) +
    (counts.get('unreachable') ?? 0)

  const parts = [`${available} available`]
  if (unusable > 0) {
    parts.push(`${unusable} unusable`)
  }
  if (retryable > 0) {
    parts.push(`${retryable} not confirmed`)
  }
  return `${parts.join(' · ')}`
}
