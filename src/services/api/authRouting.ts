import {
  type APIProvider,
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import {
  getAnthropicApiKeyWithSource,
  getAuthTokenSource,
  getSubscriptionType,
  isClaudeAISubscriber,
  isManagedOAuthContext,
} from 'src/utils/auth.js'
import {
  getTransportKindForRoute,
  resolveActiveRouteIdFromEnv,
} from '../../integrations/routeMetadata.js'
import {
  type AnthropicAttributionAuth,
  type AnthropicAttributionPolicy,
  type AnthropicAttributionRoute,
  getAnthropicAttributionDiagnostic,
  resolveAnthropicAttributionAuth,
  resolveAnthropicAttributionPolicy,
} from '../../utils/anthropicAttribution.js'
import { logForDebugging } from '../../utils/debug.js'
import { isBareMode } from '../../utils/envUtils.js'

export type ProviderOverride = { model: string; baseURL: string; apiKey: string }

function resolveAnthropicAttributionAuthTokenSource(
  authTokenSource: ReturnType<typeof getAuthTokenSource>['source'],
  managedOAuthContext: boolean,
): 'oauth' | 'api_key' | 'none' {
  if (
    managedOAuthContext &&
    (authTokenSource === 'ANTHROPIC_AUTH_TOKEN' ||
      authTokenSource === 'apiKeyHelper')
  ) {
    return 'none'
  }
  if (
    authTokenSource === 'ANTHROPIC_AUTH_TOKEN' ||
    authTokenSource === 'apiKeyHelper'
  ) {
    return 'api_key'
  }
  if (
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN' ||
    authTokenSource === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR' ||
    authTokenSource === 'CCR_OAUTH_TOKEN_FILE' ||
    authTokenSource === 'claude.ai'
  ) {
    return 'oauth'
  }
  return 'none'
}

function isManagedOAuthEffective(
  authTokenSource: ReturnType<typeof getAuthTokenSource>['source'],
  managedOAuthContext: boolean,
  bareMode: boolean,
): boolean {
  return (
    managedOAuthContext &&
    !bareMode &&
    resolveAnthropicAttributionAuthTokenSource(authTokenSource, false) ===
      'oauth'
  )
}

export function resolveAnthropicAttributionAuthFromSources({
  apiKeySource,
  authTokenSource,
  bareMode,
  isSubscriber,
  managedOAuthContext,
}: {
  apiKeySource: ReturnType<typeof getAnthropicApiKeyWithSource>['source']
  authTokenSource: ReturnType<typeof getAuthTokenSource>['source']
  bareMode: boolean
  isSubscriber: boolean
  managedOAuthContext: boolean
}): AnthropicAttributionAuth {
  // Match getAnthropicClient: managed remote and Desktop sessions ignore
  // inherited API-key settings only when OAuth is actually effective. Bare
  // mode remains API-key-only even if a managed-context marker is present.
  const managedOAuthIsEffective = isManagedOAuthEffective(
    authTokenSource,
    managedOAuthContext,
    bareMode,
  )
  const apiKey = managedOAuthIsEffective
    ? 'none'
    : apiKeySource === 'ANTHROPIC_API_KEY' || apiKeySource === 'apiKeyHelper'
      ? 'external'
      : apiKeySource === '/login managed key'
        ? 'managed'
        : 'none'
  const authToken = resolveAnthropicAttributionAuthTokenSource(
    authTokenSource,
    managedOAuthIsEffective,
  )

  return resolveAnthropicAttributionAuth({
    apiKey,
    authToken,
    isSubscriber,
  })
}

function resolveCurrentAnthropicAttributionAuth(): AnthropicAttributionAuth {
  let apiKeySource: ReturnType<
    typeof getAnthropicApiKeyWithSource
  >['source'] = 'none'
  try {
    ;({ source: apiKeySource } = getAnthropicApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    }))
  } catch {
    // Missing credentials are an ambiguous state, not an error for policy.
  }

  let authTokenSource: ReturnType<typeof getAuthTokenSource>['source'] = 'none'
  try {
    ;({ source: authTokenSource } = getAuthTokenSource())
  } catch {
    return 'unknown'
  }

  const bareMode = isBareMode()
  const managedOAuthContext = isManagedOAuthContext()
  const managedOAuthIsEffective = isManagedOAuthEffective(
    authTokenSource,
    managedOAuthContext,
    bareMode,
  )
  const hasOAuthToken =
    resolveAnthropicAttributionAuthTokenSource(
      authTokenSource,
      managedOAuthIsEffective,
    ) === 'oauth'
  let isSubscriber = false
  if (hasOAuthToken) {
    try {
      // Managed launchers establish the subscription OAuth path independently
      // of machine-local token discovery, but an explicit trusted free-plan
      // override still makes the client send API-key auth.
      isSubscriber = managedOAuthIsEffective
        ? getSubscriptionType() !== 'free'
        : isClaudeAISubscriber()
    } catch {
      return 'unknown'
    }
  }

  return resolveAnthropicAttributionAuthFromSources({
    apiKeySource,
    authTokenSource,
    bareMode,
    isSubscriber,
    managedOAuthContext,
  })
}

function resolveAnthropicAttributionRoute(
  providerOverride?: ProviderOverride,
): AnthropicAttributionRoute {
  if (providerOverride) return 'non_official'

  try {
    const routeId = resolveActiveRouteIdFromEnv(process.env)
    if (
      routeId === 'anthropic' &&
      getAPIProvider() === 'firstParty' &&
      isFirstPartyAnthropicBaseUrl()
    ) {
      return 'official_anthropic'
    }
    if (routeId && getTransportKindForRoute(routeId) !== null) {
      return 'non_official'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

export function resolveCurrentAnthropicAttributionPolicy({
  attributionEnabled,
  providerOverride,
}: {
  attributionEnabled: boolean
  providerOverride?: ProviderOverride
}): AnthropicAttributionPolicy {
  const route = resolveAnthropicAttributionRoute(providerOverride)
  const policy = resolveAnthropicAttributionPolicy({
    route,
    auth:
      route === 'official_anthropic'
        ? resolveCurrentAnthropicAttributionAuth()
        : 'unknown',
    attributionEnabled,
  })
  const diagnostic = getAnthropicAttributionDiagnostic(policy)
  if (diagnostic) logForDebugging(diagnostic)
  return policy
}

export function shouldUseFirstPartyAnthropicAuthForProvider({
  providerOverride,
  apiProvider,
  isFirstPartyBaseUrl,
}: {
  providerOverride?: ProviderOverride
  apiProvider: APIProvider
  isFirstPartyBaseUrl: boolean
}): boolean {
  return !providerOverride && apiProvider === 'firstParty' && isFirstPartyBaseUrl
}

export function shouldUseFirstPartyAnthropicAuth(
  providerOverride?: ProviderOverride,
): boolean {
  return shouldUseFirstPartyAnthropicAuthForProvider({
    providerOverride,
    apiProvider: getAPIProvider(),
    isFirstPartyBaseUrl: isFirstPartyAnthropicBaseUrl(),
  })
}

export function shouldUseCustomAnthropicBearerAuth({
  providerOverride,
  apiProvider,
  isFirstPartyBaseUrl,
  authToken,
}: {
  providerOverride?: ProviderOverride
  apiProvider: APIProvider
  isFirstPartyBaseUrl: boolean
  authToken?: string
}): boolean {
  return Boolean(
    !providerOverride &&
      authToken?.trim() &&
      apiProvider === 'firstParty' &&
      !isFirstPartyBaseUrl,
  )
}
