import memoize from 'lodash-es/memoize.js'
import { getAPIProvider, isFirstPartyAnthropicBaseUrl } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'xhigh_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

function buildCapabilityOverrideCacheKey(
  model: string,
  capability: ModelCapabilityOverride,
  apiProvider?: ReturnType<typeof getAPIProvider>,
): string {
  const resolvedApiProvider = apiProvider ?? getAPIProvider()
  const envParts = TIERS.flatMap(tier => [
    process.env[tier.modelEnvVar] ?? '',
    process.env[tier.capabilitiesEnvVar] ?? '',
  ])

  return [
    model.toLowerCase(),
    capability,
    resolvedApiProvider,
    process.env.ANTHROPIC_BASE_URL ?? '',
    process.env.USER_TYPE ?? '',
    ...envParts,
  ].join('\0')
}

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (
    model: string,
    capability: ModelCapabilityOverride,
    apiProvider?: ReturnType<typeof getAPIProvider>,
  ): boolean | undefined => {
    const resolvedApiProvider = apiProvider ?? getAPIProvider()
    if (
      resolvedApiProvider === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl()
    ) {
      return undefined
    }
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  buildCapabilityOverrideCacheKey,
)
