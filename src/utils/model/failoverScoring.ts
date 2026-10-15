/**
 * Performance-aware failover scoring.
 *
 * Blends availability verdicts with historical performance metrics to
 * rank failover candidates. Models with strong track records are preferred
 * over unknown or poorly-performing ones.
 */

import {
  computeModelScores,
  getRateLimitCooldownUntil,
  type ModelScore,
} from './performanceMetrics.js'
import type { ModelAvailability } from './modelAvailability.js'

export interface ScoredCandidate {
  model: string
  score: number
  availability: ModelAvailability | undefined
  metric: ModelScore | undefined
}

/**
 * Score and rank candidates using availability + performance data.
 *
 * Scoring:
 * - Available model with metrics: base score from performance
 * - Available model without metrics: neutral (50)
 * - Unavailable model: excluded (filtered out by caller)
 *
 * Returns candidates sorted by score descending.
 */
export function scoreFailoverCandidates(params: {
  candidates: string[]
  availability?: Record<string, ModelAvailability>
}): ScoredCandidate[] {
  const metrics = computeModelScores()
  const hasVerdicts = params.availability && Object.keys(params.availability).length > 0

  const scored: ScoredCandidate[] = []
  const now = Date.now()

  for (const model of params.candidates) {
    const availability = hasVerdicts
      ? params.availability?.[model]
      : undefined

    // Skip models explicitly marked unavailable
    if (availability && availability.state !== 'available') {
      continue
    }

    // Skip models currently cooling down from a rate-limit storm.
    const cooldownUntil = getRateLimitCooldownUntil(model, now)
    if (cooldownUntil !== undefined && now < cooldownUntil) {
      continue
    }

    const metric = metrics[model]
    let score: number

    if (metric) {
      score = metric.score
    } else if (availability?.state === 'available') {
      score = 50 // Neutral baseline for confirmed-available models
    } else {
      score = 25 // Lower baseline for unprobed models
    }

    scored.push({ model, score, availability, metric })
  }

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score)
  return scored
}

/**
 * Get the best candidate from a scored list.
 */
export function pickBestCandidate(
  scored: ScoredCandidate[],
): string | undefined {
  return scored.length > 0 ? scored[0].model : undefined
}
