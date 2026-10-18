import {
  isSettingSourceEnabled,
  SETTING_SOURCES,
  type SettingSource,
} from './constants.js'
import { getSettingsForSource } from './settings.js'

export const DEFAULT_MODEL_WEB_SEARCH_RATE_USD_PER_REQUEST = 0.01

export type ResolvedModelPricing = Readonly<{
  inputTokens: number
  outputTokens: number
  promptCacheReadTokens: number
  promptCacheWriteTokens: number
  webSearchRequests: number
}>

const TRUSTED_MODEL_PRICING_SOURCES = new Set<SettingSource>([
  'userSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
])

/**
 * Resolve a price for the exact model id used by the API request.
 *
 * Source precedence follows SETTING_SOURCES (later wins), but deliberately
 * excludes shared project settings so repository content cannot change a
 * user's personal USD accounting. The settings loader owns caching and reload
 * invalidation; this function keeps no additional state.
 */
export function getModelPricingOverride(
  model: string,
): ResolvedModelPricing | undefined {
  let resolved: ResolvedModelPricing | undefined

  for (const source of SETTING_SOURCES) {
    if (
      !TRUSTED_MODEL_PRICING_SOURCES.has(source) ||
      !isSettingSourceEnabled(source)
    ) {
      continue
    }

    const pricing = getSettingsForSource(source)?.modelPricing
    if (!pricing || !Object.hasOwn(pricing, model)) {
      continue
    }

    const entry = pricing[model]
    resolved = Object.freeze({
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      promptCacheReadTokens: entry.promptCacheReadTokens,
      promptCacheWriteTokens: entry.promptCacheWriteTokens,
      webSearchRequests:
        entry.webSearchRequests ??
        DEFAULT_MODEL_WEB_SEARCH_RATE_USD_PER_REQUEST,
    })
  }

  return resolved
}
