import {
  getCachedModels,
  isCacheStale,
  parseDurationString,
  recordDiscoveryError,
  setCachedModels,
  type DiscoveryCacheError,
} from './discoveryCache.js'
import type {
  ModelCatalogConfig,
  ModelCatalogEntry,
  ReadinessProbeKind,
} from './descriptors.js'
import { resolveRouteIdFromBaseUrl } from './index.js'
import { filterAvailableCatalogEntries } from './registry.js'
import {
  getRouteDescriptor,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalXaiInferenceBaseUrl,
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
} from './routeMetadata.js'
import type {
  AtomicChatReadiness,
  OllamaGenerationReadiness,
} from '../utils/providerDiscovery.js'
import {
  fetchOpenAICompatibleModelsRaw,
  listOpenAICompatibleModels,
  probeOllamaModelCatalog,
  probeAtomicChatReadiness,
  probeOllamaGenerationReadiness,
} from '../utils/providerDiscovery.js'
import { firstUsableCredential, hasInvalidCredentialPlaceholder } from '../services/api/credentialPool.js'
import { parseCustomHeadersEnv } from '../utils/providerCustomHeaders.js'
import { resolveAimlapiAttributionHeaders } from './aimlapi/config.js'
import { isEssentialTrafficOnly } from '../utils/privacyLevel.js'
import {
  getXaiDiscoveryCacheIdentity,
  readXaiCredentialsAsync,
  resolveXaiAccessToken,
} from '../utils/xaiCredentials.js'

export type RouteDiscoveryResult = {
  routeId: string
  models: ModelCatalogEntry[]
  discoveredModelCount?: number
  stale: boolean
  error: DiscoveryCacheError | null
  source: 'network' | 'cache' | 'stale-cache' | 'static' | 'error'
}

export type OpenAICompatibleReadiness =
  | { state: 'unreachable' }
  | { state: 'no_models' }
  | { state: 'ready'; models: string[] }

export type RouteReadinessResult =
  | OllamaGenerationReadiness
  | AtomicChatReadiness
  | OpenAICompatibleReadiness

function shouldSkipNonessentialDiscoveryTraffic(): boolean {
  return (
    isEssentialTrafficOnly() ||
    Boolean(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)
  )
}

function getRouteCatalog(routeId: string): ModelCatalogConfig | null {
  return getRouteDescriptor(routeId)?.catalog ?? null
}

export function resolveDiscoveryRouteIdFromBaseUrl(
  baseUrl?: string,
): string | null {
  return resolveRouteIdFromBaseUrl(baseUrl, { requireDiscovery: true })
}

function getCatalogEntries(
  routeId: string,
): ModelCatalogEntry[] {
  return getRouteCatalog(routeId)?.models ?? []
}

export function getDiscoveryCacheTtlMs(
  routeId: string,
): number {
  const ttl = getRouteCatalog(routeId)?.discoveryCacheTtl ?? 0
  return typeof ttl === 'string' || typeof ttl === 'number'
    ? parseDurationString(ttl)
    : 0
}

function normalizeDiscoveryCacheBaseUrl(
  baseUrl: string | undefined,
): string {
  if (!baseUrl?.trim()) {
    return ''
  }

  try {
    const parsed = new URL(baseUrl)
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/+$/, '').toLowerCase()
  } catch {
    return baseUrl.trim().replace(/\/+$/, '').toLowerCase()
  }
}

function normalizeDiscoveryCacheHeaders(
  headers: Record<string, string> | undefined,
): Array<[string, string]> {
  return Object.entries(headers ?? {})
    .map(([name, value]): [string, string] => [
      name.trim().toLowerCase(),
      value.trim(),
    ])
    .filter(([name, value]) => name && value)
    .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
}

const FNV1A_128_OFFSET_BASIS = 0x6c62272e07bb014262b821756295c58dn
const FNV1A_128_PRIME = 0x0000000001000000000000000000013bn

function fingerprintDiscoveryCachePartition(value: unknown): string {
  // Discovery results can be account-specific. This only needs a stable,
  // opaque local cache namespace; it is not password storage, authentication,
  // integrity protection, or a security boundary. Keep raw credentials out of
  // the cache key without retaining them in a process-wide memoization cache.
  let fingerprint = FNV1A_128_OFFSET_BASIS
  const serialized = JSON.stringify(value) ?? ''

  for (const byte of new TextEncoder().encode(serialized)) {
    fingerprint ^= BigInt(byte)
    fingerprint = BigInt.asUintN(128, fingerprint * FNV1A_128_PRIME)
  }

  return fingerprint.toString(16).padStart(32, '0')
}

export function getDiscoveryCacheKey(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    baseUrl?: string
    apiKey?: string
    cacheKey?: string
    headers?: Record<string, string>
  },
): string {
  const discoveryApiKey = getRouteDiscoveryApiKey(routeId, options)
  const cacheIdentity = options?.cacheKey ?? discoveryApiKey
  const partition = {
    baseUrl: normalizeDiscoveryCacheBaseUrl(getRouteBaseUrl(routeId, options)),
    apiKeyHash: cacheIdentity
      ? fingerprintDiscoveryCachePartition(cacheIdentity)
      : '',
    headers: normalizeDiscoveryCacheHeaders(
      getRouteDiscoveryHeaders(routeId, options),
    ),
  }

  return `${routeId}:${fingerprintDiscoveryCachePartition(partition)}`
}

function getRouteBaseUrl(
  routeId: string,
  options?: { baseUrl?: string },
): string | undefined {
  return options?.baseUrl ?? getRouteDescriptor(routeId)?.defaultBaseUrl
}

// Keep custom endpoint authentication identical for requests and cache readers.
function getCustomDiscoveryAuth(
  routeId: string,
  options?: { apiKey?: string; baseUrl?: string; processEnv?: NodeJS.ProcessEnv },
): Record<string, string> | undefined {
  if (routeId !== 'custom') return undefined
  const env = options?.processEnv ?? process.env
  const name = env.OPENAI_AUTH_HEADER?.trim()
  if (!name || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) return undefined
  const explicitValue = env.OPENAI_AUTH_HEADER_VALUE?.trim()
  if (explicitValue && /[\r\n]/.test(explicitValue)) {
    throw new Error('OPENAI_AUTH_HEADER_VALUE must not contain CR/LF characters')
  }
  const value =
    explicitValue ||
    firstUsableCredential(options?.apiKey) ||
    firstUsableCredential(
      resolveRouteCredentialValue({
        routeId,
        baseUrl: options?.baseUrl,
        processEnv: env,
      }),
    )
  const scheme = env.OPENAI_AUTH_SCHEME
  const bearer =
    scheme === 'bearer' ||
    (scheme !== 'raw' && name.toLowerCase() === 'authorization')
  return value ? { [name]: bearer ? `Bearer ${value}` : value } : {}
}

function getRouteDiscoveryApiKey(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    baseUrl?: string
    apiKey?: string
  },
): string | undefined {
  if (getCustomDiscoveryAuth(routeId, options)) return undefined

  const baseUrl = getRouteBaseUrl(routeId, options)
  // ApiSmart's dedicated token must never be used for an overridden discovery
  // URL. Apply the same exact inference-endpoint boundary used by requests and
  // profiles before considering either a caller-provided or ambient key.
  if (
    routeId === 'apismart' &&
    !isCanonicalApismartInferenceBaseUrl(baseUrl)
  ) {
    return undefined
  }

  if (hasInvalidCredentialPlaceholder(options?.apiKey)) {
    return undefined
  }

  const optionCredential = firstUsableCredential(options?.apiKey)
  if (optionCredential) {
    return optionCredential
  }

  return firstUsableCredential(
    resolveRouteCredentialValue({
      routeId,
      baseUrl,
      processEnv:
        routeId === 'custom' ? options?.processEnv ?? process.env : process.env,
    }),
  )
}

export async function resolveDiscoveryRequestOptions<
  T extends {
    processEnv?: NodeJS.ProcessEnv
    apiKey?: string
    cacheKey?: string
    baseUrl?: string
    headers?: Record<string, string>
  },
>(
  routeId: string,
  options?: T,
  resolverOptions?: { refreshXaiOAuth?: boolean },
): Promise<T> {
  const next = { ...(options ?? {}) } as T
  if (routeId === 'custom') {
    // Profile activation can change the global env while cache I/O is pending.
    next.processEnv = { ...(next.processEnv ?? process.env) }
    return next
  }
  if (getRouteDiscoveryApiKey(routeId, next) || routeId !== 'xai') {
    return next
  }

  if (!isCanonicalXaiInferenceBaseUrl(getRouteBaseUrl(routeId, next))) {
    return next
  }

  let credentials = await readXaiCredentialsAsync()
  const cacheOnly =
    shouldSkipNonessentialDiscoveryTraffic() ||
    resolverOptions?.refreshXaiOAuth === false
  const token = firstUsableCredential(
    cacheOnly ? credentials?.accessToken : await resolveXaiAccessToken(),
  )
  if (!cacheOnly) {
    // A refresh can rotate the refresh token. Re-read the persisted blob so
    // discovery writes under the same stable identity subsequent readers use.
    credentials = (await readXaiCredentialsAsync()) ?? credentials
  }
  if (token) {
    next.apiKey = token
    // The access token can rotate while the OAuth account does not. Keep the
    // cache partition tied to a stable account identity, not a bearer token.
    next.cacheKey = getXaiDiscoveryCacheIdentity(credentials) ?? token
  }
  return next
}

export function getRouteDiscoveryHeaders(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    apiKey?: string
    baseUrl?: string
    headers?: Record<string, string>
  },
): Record<string, string> | undefined {
  const transportConfig = getRouteDescriptor(routeId)?.transportConfig
  // Descriptor headers are attribution, not transport plumbing: an `aimlapi`
  // profile keeps its route id while pointing at a user-controlled proxy, so the
  // `/models` request must be filtered on the same canonical predicate the
  // inference shim uses (`resolveAimlapiAttributionHeaders`). Without this the
  // discovery path would hand the partner identity to an arbitrary host.
  const descriptorHeaders = {
    ...(transportConfig?.headers ?? {}),
    ...(transportConfig?.openaiShim?.headers ?? {}),
  }
  // Command Code uses a fixed dedicated-auth contract. Inference suppresses
  // caller headers for this route; discovery must enforce the same boundary so
  // stale proxy/tenant secrets are not sent to its public model catalog.
  const callerHeaders = routeId === 'commandcode' ? {} : options?.headers ?? {}
  // Caller headers first, then managed AIMLAPI attribution, so ANTHROPIC_CUSTOM_HEADERS
  // cannot replace partner/source/integration identity. resolveAimlapiAttributionHeaders
  // also strips those names on a non-canonical proxy, including caller-supplied copies.
  const headers =
    routeId === 'aimlapi'
      ? resolveAimlapiAttributionHeaders(
          {
            ...callerHeaders,
            ...descriptorHeaders,
          },
          getRouteBaseUrl(routeId, options),
        )
      : {
          ...descriptorHeaders,
          ...callerHeaders,
        }

  const customAuth = getCustomDiscoveryAuth(routeId, options)
  const requestHeaders = { ...headers }
  for (const [name, value] of Object.entries(customAuth ?? {})) {
    for (const existingName of Object.keys(requestHeaders)) {
      if (existingName.toLowerCase() === name.toLowerCase()) {
        delete requestHeaders[existingName]
      }
    }
    requestHeaders[name] = value
  }
  return Object.keys(requestHeaders).length > 0 ? requestHeaders : undefined
}

function toDiscoveredModelEntry(modelId: string): ModelCatalogEntry {
  return {
    id: modelId,
    apiName: modelId,
    label: modelId,
  }
}

function toOllamaModelEntry(model: { name: string }): ModelCatalogEntry {
  return {
    id: model.name,
    apiName: model.name,
    label: model.name,
  }
}

function mergeCatalogEntries(
  staticEntries: ModelCatalogEntry[],
  discoveredEntries: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const merged = [...staticEntries]
  const existingApiNames = new Set(
    staticEntries.map(entry => entry.apiName.toLowerCase()),
  )

  for (const entry of discoveredEntries) {
    if (existingApiNames.has(entry.apiName.toLowerCase())) {
      continue
    }
    existingApiNames.add(entry.apiName.toLowerCase())
    merged.push(entry)
  }

  return merged
}

function dedupeDiscoveredEntries(
  entries: ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const deduped: ModelCatalogEntry[] = []
  const seenApiNames = new Set<string>()

  for (const entry of entries) {
    const apiName = entry.apiName.trim()
    const apiNameKey = apiName.toLowerCase()
    if (!apiName || seenApiNames.has(apiNameKey)) {
      continue
    }

    seenApiNames.add(apiNameKey)
    deduped.push({ ...entry, apiName })
  }

  return deduped
}

async function runDiscovery(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    baseUrl?: string
    apiKey?: string
    headers?: Record<string, string>
  },
): Promise<ModelCatalogEntry[] | null> {
  const catalog = getRouteCatalog(routeId)
  const discovery = catalog?.discovery
  if (!catalog || !discovery) {
    return null
  }

  switch (discovery.kind) {
    case 'ollama': {
      const result = await probeOllamaModelCatalog({
        baseUrl: getRouteBaseUrl(routeId, options),
      })
      if (!result.reachable) {
        return null
      }
      return result.models.map(model => toOllamaModelEntry(model))
    }

    case 'openai-compatible': {
      if (discovery.mapModel) {
        const rawModels = await fetchOpenAICompatibleModelsRaw({
          baseUrl: getRouteBaseUrl(routeId, options),
          apiKey: getRouteDiscoveryApiKey(routeId, options),
          headers: getRouteDiscoveryHeaders(routeId, options),
        })
        if (rawModels === null) {
          return null
        }
        const entries: ModelCatalogEntry[] = []
        for (const raw of rawModels) {
          const entry = discovery.mapModel(raw)
          if (entry !== null) {
            entries.push(entry)
          }
        }
        return dedupeDiscoveredEntries(entries)
      }

      const models = await listOpenAICompatibleModels({
        baseUrl: getRouteBaseUrl(routeId, options),
        apiKey: getRouteDiscoveryApiKey(routeId, options),
        headers: getRouteDiscoveryHeaders(routeId, options),
      })
      return models?.map(model => toDiscoveredModelEntry(model)) ?? null
    }

    case 'custom':
      return null
  }
}

export async function discoverModelsForRoute(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    baseUrl?: string
    apiKey?: string
    headers?: Record<string, string>
    forceRefresh?: boolean
  },
): Promise<RouteDiscoveryResult | null> {
  const catalog = getRouteCatalog(routeId)
  if (!catalog) {
    return null
  }

  const staticEntries = getCatalogEntries(routeId)
  if (!catalog.discovery) {
    return {
      routeId,
      models: filterAvailableCatalogEntries(staticEntries),
      stale: false,
      error: null,
      source: 'static',
    }
  }

  const ttlMs = getDiscoveryCacheTtlMs(routeId)
  // Cache-only reads must not refresh an OAuth token: discovery can be
  // disabled by privacy policy, and a refresh can rotate the bearer before a
  // fresh cached result is checked.
  const cachedOptions = await resolveDiscoveryRequestOptions(routeId, options, {
    refreshXaiOAuth: false,
  })
  const cacheKey = getDiscoveryCacheKey(routeId, cachedOptions)
  if (!cachedOptions.forceRefresh && ttlMs > 0) {
    const cached = await getCachedModels(cacheKey, ttlMs)
    if (cached) {
      return {
        routeId,
        models: filterAvailableCatalogEntries(
          mergeCatalogEntries(staticEntries, cached.models),
        ),
        discoveredModelCount: cached.models.length,
        stale: false,
        error: cached.error,
        source: 'cache',
      }
    }
  }

  if (shouldSkipNonessentialDiscoveryTraffic()) {
    const staleEntry = await getCachedModels(cacheKey, ttlMs, {
      includeStale: true,
    })

    if (staleEntry) {
      const stale = await isCacheStale(cacheKey, ttlMs)
      return {
        routeId,
        models: filterAvailableCatalogEntries(
          mergeCatalogEntries(staticEntries, staleEntry.models),
        ),
        discoveredModelCount: staleEntry.models.length,
        stale,
        error: staleEntry.error,
        source: stale ? 'stale-cache' : 'cache',
      }
    }

    return {
      routeId,
      models: filterAvailableCatalogEntries(staticEntries),
      stale: false,
      error: null,
      source: 'static',
    }
  }

  try {
    const discoveryOptions = await resolveDiscoveryRequestOptions(
      routeId,
      routeId === 'custom' ? cachedOptions : options,
    )
    const discoveryCacheKey = getDiscoveryCacheKey(routeId, discoveryOptions)
    const discovered = await runDiscovery(routeId, discoveryOptions)
    if (discovered === null) {
      throw new Error(`Discovery failed for route ${routeId}`)
    }

    await setCachedModels(discoveryCacheKey, { models: discovered })
    return {
      routeId,
      models: filterAvailableCatalogEntries(
        mergeCatalogEntries(staticEntries, discovered),
      ),
      discoveredModelCount: discovered.length,
      stale: false,
      error: null,
      source: 'network',
    }
  } catch (error) {
    await recordDiscoveryError(cacheKey, error)

    const staleEntry = await getCachedModels(cacheKey, ttlMs, {
      includeStale: true,
    })

    if (staleEntry) {
      return {
        routeId,
        models: filterAvailableCatalogEntries(
          mergeCatalogEntries(staticEntries, staleEntry.models),
        ),
        discoveredModelCount: staleEntry.models.length,
        stale: true,
        error: staleEntry.error,
        source: 'stale-cache',
      }
    }

    return {
      routeId,
      models: filterAvailableCatalogEntries(staticEntries),
      stale: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        recordedAt: Date.now(),
      },
      source: 'error',
    }
  }
}

export async function refreshStartupDiscoveryForRoute(
  routeId: string,
  options?: {
    processEnv?: NodeJS.ProcessEnv
    baseUrl?: string
    apiKey?: string
    headers?: Record<string, string>
  },
): Promise<RouteDiscoveryResult | null> {
  const catalog = getRouteCatalog(routeId)
  if (!catalog?.discovery || catalog.discoveryRefreshMode !== 'startup') {
    return null
  }

  const ttlMs = getDiscoveryCacheTtlMs(routeId)
  const cachedOptions = await resolveDiscoveryRequestOptions(routeId, options, {
    refreshXaiOAuth: false,
  })
  const cacheKey = getDiscoveryCacheKey(routeId, cachedOptions)
  if (ttlMs > 0) {
    const cached = await getCachedModels(cacheKey, ttlMs)
    if (cached) {
      return {
        routeId,
        models: filterAvailableCatalogEntries(
          mergeCatalogEntries(getCatalogEntries(routeId), cached.models),
        ),
        stale: false,
        error: cached.error,
        source: 'cache',
      }
    }
  }

  return discoverModelsForRoute(routeId, {
    ...(routeId === 'custom' ? cachedOptions : options),
    forceRefresh: true,
  })
}

export async function refreshStartupDiscoveryForActiveRoute(
  options?: {
    processEnv?: NodeJS.ProcessEnv
    activeProfileProvider?: string
    baseUrl?: string
    apiKey?: string
    headers?: Record<string, string>
  },
): Promise<RouteDiscoveryResult | null> {
  const processEnv = options?.processEnv ?? process.env
  const baseUrl =
    options?.baseUrl ??
    processEnv.OPENAI_BASE_URL ??
    processEnv.OPENAI_API_BASE
  const routeId =
    resolveActiveRouteIdFromEnv(processEnv, {
      activeProfileProvider: options?.activeProfileProvider,
    }) ??
    resolveRouteIdFromBaseUrl(baseUrl)

  if (!routeId || routeId === 'anthropic') {
    return null
  }

  return refreshStartupDiscoveryForRoute(routeId, {
    processEnv,
    baseUrl,
    headers:
      options?.headers ??
      parseCustomHeadersEnv(processEnv.ANTHROPIC_CUSTOM_HEADERS),
    apiKey: hasInvalidCredentialPlaceholder(options?.apiKey)
      ? undefined
      : firstUsableCredential(options?.apiKey) ??
        firstUsableCredential(
          resolveRouteCredentialValue({
            routeId,
            baseUrl,
            processEnv,
            activeProfileProvider: options?.activeProfileProvider,
          }),
        ),
  })
}

function getReadinessProbeKind(routeId: string): ReadinessProbeKind | null {
  return getRouteDescriptor(routeId)?.startup?.probeReadiness ?? null
}

export function probeRouteReadiness(
  routeId: 'ollama',
  options?: {
    baseUrl?: string
    model?: string
    timeoutMs?: number
    apiKey?: string
  },
): Promise<OllamaGenerationReadiness | null>
export function probeRouteReadiness(
  routeId: 'atomic-chat',
  options?: {
    baseUrl?: string
    model?: string
    timeoutMs?: number
    apiKey?: string
  },
): Promise<AtomicChatReadiness | null>
export function probeRouteReadiness(
  routeId: string,
  options?: {
    baseUrl?: string
    model?: string
    timeoutMs?: number
    apiKey?: string
  },
): Promise<RouteReadinessResult | null>
export async function probeRouteReadiness(
  routeId: string,
  options?: {
    baseUrl?: string
    model?: string
    timeoutMs?: number
    apiKey?: string
  },
): Promise<RouteReadinessResult | null> {
  const readinessKind = getReadinessProbeKind(routeId)
  if (!readinessKind) {
    return null
  }

  switch (readinessKind) {
    case 'ollama-generation':
      return probeOllamaGenerationReadiness({
        baseUrl: getRouteBaseUrl(routeId, options),
        model: options?.model,
        timeoutMs: options?.timeoutMs,
      })

    case 'openai-compatible-models': {
      if (routeId === 'atomic-chat') {
        return probeAtomicChatReadiness({
          baseUrl: getRouteBaseUrl(routeId, options),
        })
      }

      const discovered = await runDiscovery(routeId, options)
      if (discovered === null) {
        return { state: 'unreachable' }
      }

      if (discovered.length === 0) {
        return { state: 'no_models' }
      }

      return {
        state: 'ready',
        models: discovered.map(entry => entry.apiName),
      }
    }
  }
}
