/**
 * Per-model performance recording and scoring.
 *
 * Tracks latency, success/failure, and error categories per model so that
 * failover ranking can prefer models with a proven track record.
 *
 * Scoring formula:
 *   score = successRate * 100 - avgLatencyMs / 100 - errorCount * 5
 *
 * Higher is better. A model with no data scores 0 (neutral).
 */

export type MetricOutcome = 'success' | 'failure'

export type ErrorCategory =
  | 'timeout'
  | 'rate-limit'
  | 'auth'
  | 'network'
  | 'unknown'
  | 'none'

export interface ModelMetricRecord {
  model: string
  outcome: MetricOutcome
  latencyMs: number
  errorCategory: ErrorCategory
  timestamp: number
}

export interface ModelScore {
  model: string
  totalCalls: number
  successCount: number
  failureCount: number
  successRate: number
  avgLatencyMs: number
  score: number
  lastUsedAt: number
}

import { clearPersistedMetrics, loadPersistedMetrics, persistMetrics } from './performanceMetricsCache.js'

const METRICS_MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes
const METRICS_MAX_ENTRIES = 500

/**
 * Rate-limit cooldown: a model that hits 429s is excluded from failover for
 * an exponentially-growing window (base 1 min, cap 30 min) over consecutive
 * rate-limit records. A success more recent than the last rate-limit resets
 * the cooldown.
 */
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000
const RATE_LIMIT_BASE_COOLDOWN_MS = 60 * 1000
const RATE_LIMIT_MAX_COOLDOWN_MS = 30 * 60 * 1000

let records: ModelMetricRecord[] = loadPersistedMetrics()

/**
 * Record a performance observation for a model.
 */
export function recordPerformanceMetric(entry: {
  model: string
  outcome: MetricOutcome
  latencyMs: number
  errorCategory?: ErrorCategory
  timestamp?: number
}): void {
  records.push({
    model: entry.model,
    outcome: entry.outcome,
    latencyMs: entry.latencyMs,
    errorCategory: entry.errorCategory ?? (entry.outcome === 'success' ? 'none' : 'unknown'),
    timestamp: entry.timestamp ?? Date.now(),
  })
  // Trim old entries to bound memory
  const cutoff = Date.now() - METRICS_MAX_AGE_MS
  records = records.filter(r => r.timestamp >= cutoff)
  if (records.length > METRICS_MAX_ENTRIES) {
    records = records.slice(-METRICS_MAX_ENTRIES)
  }
  // Best-effort persist to disk
  persistMetrics(records)
}

/**
 * Compute scores for all models with recorded metrics.
 * Returns an empty object if no metrics exist.
 */
export function computeModelScores(): Record<string, ModelScore> {
  const grouped = new Map<string, ModelMetricRecord[]>()
  for (const r of records) {
    const list = grouped.get(r.model) ?? []
    list.push(r)
    grouped.set(r.model, list)
  }

  const scores: Record<string, ModelScore> = {}
  for (const [model, list] of grouped) {
    const totalCalls = list.length
    const successCount = list.filter(r => r.outcome === 'success').length
    const failureCount = totalCalls - successCount
    const successRate = successCount / totalCalls
    const totalLatency = list.reduce((sum, r) => sum + r.latencyMs, 0)
    const avgLatencyMs = totalLatency / totalCalls
    const score = successRate * 100 - avgLatencyMs / 100 - failureCount * 5
    const lastUsedAt = Math.max(...list.map(r => r.timestamp))

    scores[model] = {
      model,
      totalCalls,
      successCount,
      failureCount,
      successRate,
      avgLatencyMs,
      score,
      lastUsedAt,
    }
  }
  return scores
}

/**
 * Get the score for a specific model. Returns 0 if no data.
 */
export function getModelScore(model: string): number {
  const scores = computeModelScores()
  return scores[model]?.score ?? 0
}

/**
 * Epoch ms until which `model` should be excluded from failover due to recent
 * rate-limits, or `undefined` when not currently rate-limited.
 *
 * A success more recent than the last rate-limit clears the cooldown, matching
 * the probe path's re-verification on the next success.
 */
export function getRateLimitCooldownUntil(
  model: string,
  now: number = Date.now(),
): number | undefined {
  const recent = records.filter(
    r => r.model === model && now - r.timestamp <= RATE_LIMIT_WINDOW_MS,
  )
  if (recent.length === 0) {
    return undefined
  }
  const latest = recent.reduce((max, r) =>
    r.timestamp > max.timestamp ? r : max,
  )
  if (latest.outcome === 'success') {
    return undefined
  }
  const rateLimits = recent.filter(r => r.errorCategory === 'rate-limit')
  if (rateLimits.length === 0) {
    return undefined
  }
  const latestRateLimitAt = rateLimits.reduce(
    (max, r) => Math.max(max, r.timestamp),
    0,
  )
  const cooldownMs = Math.min(
    RATE_LIMIT_BASE_COOLDOWN_MS * 2 ** (rateLimits.length - 1),
    RATE_LIMIT_MAX_COOLDOWN_MS,
  )
  return latestRateLimitAt + cooldownMs
}

/**
 * Clear all recorded metrics. Used by tests.
 */
export function clearPerformanceMetrics(): void {
  records = []
  clearPersistedMetrics()
}
