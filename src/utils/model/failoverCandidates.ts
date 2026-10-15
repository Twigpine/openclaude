/**
 * Ranked alternative-model candidates for auto failover.
 *
 * Ranking reuses the picker's option order: `getModelOptions()` already
 * encodes provider preference (Recommended entries first), the allowlist, and
 * route-catalog dedup. This module only filters that list down to models the
 * current credential can actually use, using the availability probe cache —
 * never a new probe, which would cost a real inference call.
 *
 * A cold cache degrades gracefully to catalog order.
 */

import { parseSwitchProfileValue, type ModelOption } from './modelOptions.js'
import type { ModelAvailability } from './modelAvailability.js'
import { isModelAllowed } from './modelAllowlist.js'
import {
  getCachedAvailability,
  hasCachedAvailability,
} from './modelAvailabilityCache.js'
import { resolveActiveRouteIdFromEnv } from '../../integrations/routeMetadata.js'
import { getActiveProviderProfile } from '../providerProfiles.js'
import { getDiscoveryCacheKey } from '../../integrations/discoveryService.js'
import { scoreFailoverCandidates } from './failoverScoring.js'

export type RankFailoverCandidatesOptions = {
  /** Picker options, already in provider-preference order. */
  options: ModelOption[]
  failingModel: string
  alreadyTried?: string[]
  /** Availability verdicts keyed by model id; only `available` survives. */
  availability?: Record<string, ModelAvailability>
}

/**
 * The picker value channel can carry cross-profile switch markers
 * (`__switch_profile__:<id>:<model>`); failover must apply the decoded model,
 * and a cross-profile switch is out of scope for v1 — switching profiles
 * mid-turn changes the transport, not just the model.
 */
function optionModelValue(option: ModelOption): string | undefined {
  if (typeof option.value !== 'string' || !option.value) {
    return undefined
  }
  if (option.switchToProfileId !== undefined) {
    return undefined
  }
  const parsed = parseSwitchProfileValue(option.value)
  return parsed ? parsed.model : option.value
}

export function rankFailoverCandidates(
  params: RankFailoverCandidatesOptions,
): string[] {
  const alreadyTried = params.alreadyTried ?? []
  const tried = new Set([params.failingModel, ...alreadyTried])
  const availability = params.availability ?? {}
  const hasVerdicts = Object.keys(availability).length > 0
  const seen = new Set<string>()
  const verified: string[] = []
  const unprobed: string[] = []

  for (const option of params.options) {
    const model = optionModelValue(option)
    if (model === undefined || seen.has(model)) {
      continue
    }
    seen.add(model)
    if (tried.has(model)) {
      continue
    }
    if (!isModelAllowed(model)) {
      continue
    }
    if (hasVerdicts) {
      const verdict = availability[model] ?? availability[option.label]
      if (verdict) {
        // Only a confirmed-good verdict qualifies; a verified-bad model must
        // never receive the retried turn.
        if (verdict.state === 'available') {
          verified.push(model)
        }
        continue
      }
      // Cache present but this model unprobed: keep it, ranked after verified
      // models, so a partial cache does not strand failover.
      unprobed.push(model)
      continue
    }
    // Cold cache: catalog order is the only signal.
    verified.push(model)
  }

  const ranked = [...verified, ...unprobed]
  // Score and re-rank using performance metrics when available
  const scored = scoreFailoverCandidates({
    candidates: ranked,
    availability: hasVerdicts ? availability : undefined,
  })
  return scored.map(c => c.model)
}

/**
 * Availability cache scope for the active route, matching the picker's key so
 * failover reads the same verdicts the user last refreshed. Undefined when no
 * OpenAI-compatible route is active (first-party Anthropic has no probe cache).
 */
export function resolveFailoverAvailabilityScopeKey(): string | undefined {
  try {
    const activeProfile = getActiveProviderProfile()
    const routeId = resolveActiveRouteIdFromEnv(process.env, {
      activeProfileProvider: activeProfile?.provider,
      activeProfileBaseUrl: activeProfile?.baseUrl,
    })
    if (!routeId) {
      return undefined
    }
    return getDiscoveryCacheKey(routeId)
  } catch {
    return undefined
  }
}
