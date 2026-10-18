import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import type { RouteDiscoveryResult } from '../../integrations/discoveryService.js'
import {
  discoverModelsForRoute,
  getRouteDiscoveryHeaders,
  resolveDiscoveryRouteIdFromBaseUrl,
} from '../../integrations/discoveryService.js'
import {
  getCatalogEntriesForRoute,
  getGateway,
  getVendor,
} from '../../integrations/index.js'
import {
  getRouteDescriptor,
  resolveRouteCredentialValue,
} from '../../integrations/routeMetadata.js'
import { firstUsableCredential, hasInvalidCredentialPlaceholder } from './credentialPool.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import type { ModelOption } from '../../utils/model/modelOptions.js'
import {
  getLocalOpenAICompatibleProviderLabel,
  listOpenAICompatibleModels,
} from '../../utils/providerDiscovery.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'
import { parseCustomHeadersEnv } from '../../utils/providerCustomHeaders.js'
import {
  getAdditionalModelOptionsCacheScope,
  resolveProviderRequest,
} from './providerConfig.js'

const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    client_data: z.record(z.unknown()).nullish(),
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

type BootstrapCachePayload = {
  clientData: Record<string, unknown> | null
  additionalModelOptions: ModelOption[]
  additionalModelOptionsScope: string
}

function normalizeDiscoveredModelLookupKey(model: string): string {
  return model.trim().split('?', 1)[0]?.trim().toLowerCase() ?? ''
}

export function getDiscoveredModelApiNames(
  discovered: RouteDiscoveryResult | null,
): string[] | null {
  if (
    !discovered ||
    (discovered.source !== 'static' &&
      (discovered.discoveredModelCount ?? 0) === 0)
  ) {
    return null
  }

  const discoveredModels = discovered.models
    .map(model => model.apiName)
    .filter(model => model.trim())
  return discoveredModels?.length ? discoveredModels : null
}

function buildLocalOpenAIModelOptions(options: {
  models: string[]
  routeId: string | null
  routeLabel: string
}): ModelOption[] {
  const seen = new Set<string>()
  const catalogEntries = options.routeId
    ? getCatalogEntriesForRoute(options.routeId)
    : []

  return options.models.flatMap(model => {
    const normalizedModel = normalizeDiscoveredModelLookupKey(model)
    const catalogEntry = catalogEntries.find(
      entry =>
        normalizeDiscoveredModelLookupKey(entry.apiName) === normalizedModel ||
        normalizeDiscoveredModelLookupKey(entry.id) === normalizedModel ||
        (entry.aliases ?? []).some(
          alias => normalizeDiscoveredModelLookupKey(alias) === normalizedModel,
        ),
    )
    const value = catalogEntry?.apiName ?? model
    const key = normalizeDiscoveredModelLookupKey(value)
    if (!key || seen.has(key)) {
      return []
    }

    seen.add(key)
    return [{
      value,
      label: catalogEntry?.label ?? model,
      description: `Detected from ${options.routeLabel}`,
    }]
  })
}

async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

  if (getAPIProvider() !== 'firstParty' || !isFirstPartyAnthropicBaseUrl()) {
    logForDebugging('[Bootstrap] Skipped: 3P provider')
    return null
  }

  // OAuth preferred (requires user:profile scope — service-key OAuth tokens
  // lack it and would 403). Fall back to API key auth for console users.
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`

  // withOAuth401Retry handles the refresh-and-retry. API key users fail
  // through on 401 (no refresh mechanism — no OAuth token to pass).
  try {
    return await withOAuth401Retry(async () => {
      // Re-read OAuth each call so the retry picks up the refreshed token.
      const token = getClaudeAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        authHeaders = { 'x-api-key': apiKey }
      } else {
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getClaudeCodeUserAgent(),
          ...authHeaders,
        },
        timeout: 5000,
      })
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return parsed.data
    })
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status ?? 'no-response'
      const code = error.code ?? 'unknown-code'
      const method = error.config?.method?.toUpperCase() ?? 'UNKNOWN'
      const requestUrl = error.config?.url ?? 'unknown-url'
      const message = error.message ?? 'unknown axios error'

      logForDebugging(
        `[Bootstrap] Fetch failed: status=${status} code=${code} method=${method} url=${requestUrl} message=${message}`,
      )
    } else {
      const message = error instanceof Error ? error.message : String(error)
      logForDebugging(`[Bootstrap] Fetch failed: ${message}`)
    }

    throw error
  }
}

function getSafeBaseUrlForDebug(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return 'invalid-base-url'
  }
}

type FetchLocalOpenAIModelOptionsDeps = {
  discoverModelsForRoute?: typeof discoverModelsForRoute
  getAdditionalModelOptionsCacheScope?: typeof getAdditionalModelOptionsCacheScope
  listOpenAICompatibleModels?: typeof listOpenAICompatibleModels
  resolveProviderRequest?: typeof resolveProviderRequest
}

export async function fetchLocalOpenAIModelOptions(
  deps: FetchLocalOpenAIModelOptionsDeps = {},
): Promise<BootstrapCachePayload | null> {
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped local model discovery: Nonessential traffic disabled')
    return null
  }

  const getScope = deps.getAdditionalModelOptionsCacheScope ?? getAdditionalModelOptionsCacheScope
  const resolveRequest = deps.resolveProviderRequest ?? resolveProviderRequest
  const scope = getScope()
  if (!scope?.startsWith('openai:')) {
    return null
  }

  const { baseUrl } = resolveRequest()
  const routeId = resolveDiscoveryRouteIdFromBaseUrl(baseUrl)
  const routeLabel =
    (routeId
      ? getGateway(routeId)?.label ?? getVendor(routeId)?.label
      : undefined) ?? getLocalOpenAICompatibleProviderLabel(baseUrl)
  const routeCredential = resolveRouteCredentialValue({
    routeId: routeId ?? 'custom',
    baseUrl,
    processEnv: process.env,
  })
  const apiKey = hasInvalidCredentialPlaceholder(routeCredential)
    ? undefined
    : firstUsableCredential(routeCredential)

  const customHeaders = parseCustomHeadersEnv(
    process.env.ANTHROPIC_CUSTOM_HEADERS,
  )
  const fallbackHeaders = routeId
    ? getRouteDiscoveryHeaders(routeId, { baseUrl, headers: customHeaders })
    : customHeaders

  const discoverModels = deps.discoverModelsForRoute ?? discoverModelsForRoute
  const listModels = deps.listOpenAICompatibleModels ?? listOpenAICompatibleModels
  const discovered = routeId
    ? await discoverModels(routeId, {
        baseUrl,
        apiKey,
        headers: customHeaders,
      })
    : null
  const models =
    getDiscoveredModelApiNames(discovered) ??
    (await listModels({
      baseUrl,
      apiKey,
      headers: fallbackHeaders,
    }))

  if (models === null) {
    logForDebugging(
      `[Bootstrap] OpenAI-compatible model discovery failed for ${getSafeBaseUrlForDebug(baseUrl)}`,
    )
    return null
  }

  return {
    clientData: getGlobalConfig().clientDataCache ?? null,
    additionalModelOptionsScope: scope,
    additionalModelOptions: buildLocalOpenAIModelOptions({
      models,
      routeId,
      routeLabel,
    }),
  }
}

/**
 * Fetch bootstrap data from the API and persist to disk cache.
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const scope = getAdditionalModelOptionsCacheScope()
    let payload: BootstrapCachePayload | null = null

    if (scope === 'firstParty') {
      const response = await fetchBootstrapAPI()
      if (!response) return

      payload = {
        clientData: response.client_data ?? null,
        additionalModelOptions: response.additional_model_options ?? [],
        additionalModelOptionsScope: scope,
      }
    } else if (scope?.startsWith('openai:')) {
      payload = await fetchLocalOpenAIModelOptions()
      if (!payload) return
    } else {
      logForDebugging('[Bootstrap] Skipped: no additional model source')
      return
    }

    const { clientData, additionalModelOptions, additionalModelOptionsScope } =
      payload

    // Only persist if data actually changed — avoids a config write on every startup.
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions) &&
      config.additionalModelOptionsCacheScope === additionalModelOptionsScope
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
      additionalModelOptionsCacheScope: additionalModelOptionsScope,
    }))
  } catch (error) {
    logError(error)
  }
}
