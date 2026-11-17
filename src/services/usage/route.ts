import {
  resolveActiveRouteIdFromEnv,
  resolveRouteIdFromBaseUrl,
} from '../../integrations/routeMetadata.js'
import { getActiveProviderProfile } from '../../utils/providerProfiles.js'
import {
  getAPIProvider,
  isGithubNativeAnthropicMode,
} from '../../utils/model/providers.js'
import { resolveActiveProviderBaseUrl } from '../../utils/statusNoticeLocalModel.js'
import {
  type CacheAwareProvider,
  resolveCacheProvider,
} from '../api/cacheMetrics.js'
import { isLocalProviderUrl } from '../api/providerConfig.js'

export type UsageProviderOverride = { baseURL: string }

export type UsageRouteContext = {
  route: string
  local: boolean
  cacheProvider: CacheAwareProvider
}

// Runtime provider categories that have no route descriptor of their own.
// `firstParty` is not listed: a custom Anthropic proxy is still firstParty
// but resolves to its own `custom-anthropic` route.
const RUNTIME_ROUTE_IDS: Record<string, string> = {
  foundry: 'foundry',
  codex: 'codex',
}

/**
 * Identify the provider that served a request without storing its URL.
 *
 * A per-agent `providerOverride` wins over the session's active provider
 * because those agents send their requests to a different endpoint.
 */
export function resolveUsageRouteContext(
  model: string,
  providerOverride?: UsageProviderOverride,
  processEnv: NodeJS.ProcessEnv = process.env,
): UsageRouteContext {
  if (providerOverride?.baseURL) {
    const baseUrl = providerOverride.baseURL
    return {
      route: resolveRouteIdFromBaseUrl(baseUrl) ?? 'custom',
      local: isLocalProviderUrl(baseUrl),
      cacheProvider: resolveCacheProvider('openai', { openAiBaseUrl: baseUrl }),
    }
  }

  const provider = getAPIProvider()
  const runtimeRoute = RUNTIME_ROUTE_IDS[provider]
  let route = runtimeRoute
  if (!route) {
    const profile = getActiveProviderProfile()
    route =
      resolveActiveRouteIdFromEnv(processEnv, {
        activeProfileProvider: profile?.provider,
        activeProfileBaseUrl: profile?.baseUrl,
      }) ?? (provider === 'firstParty' ? 'anthropic' : provider)
  }

  const baseUrl = resolveActiveProviderBaseUrl(processEnv)
  return {
    route,
    local: isLocalProviderUrl(baseUrl),
    cacheProvider: resolveCacheProvider(provider, {
      githubNativeAnthropic: isGithubNativeAnthropicMode(model),
      openAiBaseUrl: processEnv.OPENAI_BASE_URL ?? processEnv.OPENAI_API_BASE,
    }),
  }
}
