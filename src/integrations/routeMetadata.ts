import type {
  GatewayDescriptor,
  TransportKind,
  ValidationRoutingMetadata,
  VendorDescriptor,
} from './descriptors.js'
import {
  ensureIntegrationsLoaded,
  filterAvailableCatalogEntries,
  getAllAnthropicProxies,
  getAllGateways,
  getAllVendors,
  getGateway,
  getAnthropicProxy,
  getVendor,
  resolveProfileRoute,
} from './index.js'
import { hasUsableOpenAICredential } from '../services/api/credentialPool.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { isFirstPartyAnthropicBaseUrlForEnv } from '../utils/anthropicBaseUrl.js'

export type RouteDescriptor = GatewayDescriptor | VendorDescriptor | import('./descriptors.js').AnthropicProxyDescriptor

const TRANSPORT_KIND_PROVIDER_TYPE_LABELS: Partial<
  Record<TransportKind, string>
> = {
  'anthropic-native': 'Anthropic native API',
  'gemini-native': 'Gemini API',
  bedrock: 'AWS Bedrock Claude API',
  vertex: 'Google Vertex Claude API',
  'anthropic-proxy': 'Anthropic-compatible API',
  local: 'OpenAI-compatible API',
  'openai-compatible': 'OpenAI-compatible API',
}

const XIAOMI_MIMO_PRIMARY_HOST = 'api.xiaomimimo.com'
const XIAOMI_MIMO_STALE_DOCS_HOST = 'api.mimo-v2.com'
const XIAOMI_MIMO_TOKEN_PLAN_HOSTS = [
  'token-plan-sgp.xiaomimimo.com',
  'token-plan-cn.xiaomimimo.com',
]
export const XIAOMI_MIMO_PRIMARY_BASE_URL = `https://${XIAOMI_MIMO_PRIMARY_HOST}/v1`

function getValidationRoutingHosts(
  descriptor: RouteDescriptor,
): string[] {
  const routing = descriptor.validation?.routing as
    | ValidationRoutingMetadata
    | undefined
  return routing?.matchBaseUrlHosts ?? []
}

export function matchHostnameAgainstRouteHosts(
  hostname: string,
  routeHosts: string[],
): boolean {
  return routeHosts.some(host => {
    const lowerHost = host.toLowerCase()
    if (lowerHost.startsWith('*.')) {
      const suffix = lowerHost.slice(1)
      return hostname.endsWith(suffix)
    }
    return hostname === lowerHost
  })
}

export function normalizeComparableBaseUrl(
  baseUrl?: string,
): string | null {
  if (!baseUrl?.trim()) {
    return null
  }

  try {
    const parsed = new URL(baseUrl)
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/+$/, '').toLowerCase()
  } catch {
    return baseUrl.trim().replace(/\/+$/, '').toLowerCase() || null
  }
}

const ZAI_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'

export function isCanonicalZaiCodingPlanBaseUrl(
  value: string | undefined,
): boolean {
  return (
    normalizeComparableBaseUrl(value) ===
    normalizeComparableBaseUrl(ZAI_CODING_PLAN_BASE_URL)
  )
}

function normalizeHost(
  baseUrl?: string,
): string | null {
  if (!baseUrl?.trim()) {
    return null
  }

  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
}

function getAllRoutes(): RouteDescriptor[] {
  ensureIntegrationsLoaded()
  return [...getAllGateways(), ...getAllVendors(), ...getAllAnthropicProxies()]
}

function resolveKnownLocalRouteIdFromBaseUrl(baseUrl?: string): string | null {
  if (!baseUrl) {
    return null
  }

  try {
    const parsed = new URL(baseUrl)
    const host = parsed.host.toLowerCase()
    const hostname = parsed.hostname.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    const haystack = `${hostname} ${path}`

    if (host.endsWith(':11434') || haystack.includes('ollama')) {
      return 'ollama'
    }
    if (
      host.endsWith(':1234') ||
      haystack.includes('lmstudio') ||
      haystack.includes('lm-studio')
    ) {
      return 'lmstudio'
    }
  } catch {
    return null
  }

  return null
}

export function getRouteDescriptor(
  routeId: string,
): RouteDescriptor | null {
  ensureIntegrationsLoaded()
  return getGateway(routeId) ?? getVendor(routeId) ?? getAnthropicProxy(routeId) ?? null
}

export function getRouteLabel(
  routeId: string,
): string | null {
  return getRouteDescriptor(routeId)?.label ?? null
}

export function getRouteDefaultBaseUrl(
  routeId: string,
): string | undefined {
  return getRouteDescriptor(routeId)?.defaultBaseUrl
}

export function getRouteDefaultModel(
  routeId: string,
): string | undefined {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return undefined
  }

  if ('defaultModel' in descriptor && descriptor.defaultModel) {
    return descriptor.defaultModel
  }

  // Same availability filter as the picker/route resolution — the fallback
  // default must never be a hidden or expired entry.
  const catalogModels = filterAvailableCatalogEntries(
    descriptor.catalog?.models ?? [],
  )
  const defaultEntry =
    catalogModels.find(model => model.default) ?? catalogModels[0]

  return defaultEntry?.apiName
}

/**
 * True for native vendor routes (e.g. MiniMax, xAI) that ship a complete,
 * curated static catalog. For these the catalog is authoritative, so the
 * `/model` picker should surface every catalogued model — not collapse to the
 * single model pinned in the active provider profile. Gateways, whose catalog
 * is a user-curated subset, keep the profile model list as a whitelist.
 */
export function isNativeVendorCatalogRoute(routeId: string): boolean {
  const vendor = getVendor(routeId)
  return (
    vendor?.classification === 'native' &&
    vendor.catalog?.source === 'static' &&
    (vendor.catalog?.models?.length ?? 0) > 0
  )
}

function uniqueEnvVars(envVars: Iterable<string>): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const envVar of envVars) {
    const trimmed = envVar.trim()
    if (!trimmed || seen.has(trimmed)) {
      continue
    }

    seen.add(trimmed)
    normalized.push(trimmed)
  }

  return normalized
}

function readFirstNonEmptyEnvValue(
  processEnv: NodeJS.ProcessEnv,
  envVars: readonly string[],
): string | undefined {
  for (const envVar of envVars) {
    const value = processEnv[envVar]
    if (hasUsableEnvCredentialValue(envVar, value)) {
      return value!.trim()
    }
  }

  return undefined
}

function hasUsableEnvCredentialValue(
  envVar: string,
  value: string | undefined,
): boolean {
  if (typeof value !== 'string') {
    return false
  }

  if (
    envVar === 'OPENAI_API_KEYS' ||
    envVar === 'OPENAI_API_KEY' ||
    envVar === 'AIMLAPI_API_KEY' ||
    envVar === 'APISMART_API_KEY' ||
    envVar === 'CONCENTRATE_API_KEY' ||
    envVar === 'LLMTR_API_KEY' ||
    envVar === 'CMD_API_KEY' ||
    envVar === 'COMMANDCODE_API_KEY' ||
    envVar === 'COMMAND_CODE_API_KEY' ||
    envVar === 'API_ROUTE_API_KEY'
  ) {
    return hasUsableOpenAICredential(value)
  }
  return value.trim() !== ''
}

function hasAnyUsableOpenAICredential(processEnv: NodeJS.ProcessEnv): boolean {
  return (
    hasUsableEnvCredentialValue('OPENAI_API_KEYS', processEnv.OPENAI_API_KEYS) ||
    hasUsableEnvCredentialValue('OPENAI_API_KEY', processEnv.OPENAI_API_KEY)
  )
}

function hasNonEmptyEnvValue(value: string | undefined): boolean {
  const trimmed = value?.trim().toLowerCase()
  return Boolean(trimmed && trimmed !== 'undefined' && trimmed !== 'null')
}

export function isMiniMaxBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase()
    return hostname === 'api.minimax.io' || hostname === 'api.minimax.chat'
  } catch {
    return false
  }
}

export function isXaiBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    return new URL(trimmed).hostname.toLowerCase() === 'api.x.ai'
  } catch {
    return false
  }
}

export function isCanonicalXaiInferenceBaseUrl(value: string | undefined): boolean {
  if (!value?.trim()) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'api.x.ai'
  } catch {
    return false
  }
}

export function isXiaomiMimoBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase()
    return (
      hostname === XIAOMI_MIMO_PRIMARY_HOST ||
      hostname === XIAOMI_MIMO_STALE_DOCS_HOST ||
      XIAOMI_MIMO_TOKEN_PLAN_HOSTS.includes(hostname)
    )
  } catch {
    return false
  }
}

export function normalizeXiaomiMimoBaseUrl(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) {
    return undefined
  }

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase()
    if (hostname === XIAOMI_MIMO_STALE_DOCS_HOST) {
      return XIAOMI_MIMO_PRIMARY_BASE_URL
    }
  } catch {
    return trimmed
  }

  return trimmed
}

export function getXiaomiMimoBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isXiaomiMimoBaseUrl(openAIBaseUrl)) {
    return normalizeXiaomiMimoBaseUrl(openAIBaseUrl)
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isXiaomiMimoBaseUrl(openAIApiBase)) {
    return normalizeXiaomiMimoBaseUrl(openAIApiBase)
  }

  return undefined
}

export function isVeniceBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    return new URL(trimmed).hostname.toLowerCase() === 'api.venice.ai'
  } catch {
    return false
  }
}

export function isNearaiBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const hostname = new URL(trimmed).hostname.toLowerCase()
    return hostname === 'cloud-api.near.ai' || hostname === 'completions.near.ai' || hostname.endsWith('.completions.near.ai')
  } catch {
    return false
  }
}

/**
 * Checks whether the given URL value targets the Fireworks AI inference API
 * by matching the hostname against `api.fireworks.ai`.
 */
export function isFireworksBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    return new URL(trimmed).hostname.toLowerCase() === 'api.fireworks.ai'
  } catch {
    return false
  }
}

export function isLongcatBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const url = new URL(trimmed)
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'api.longcat.chat' &&
      !url.port &&
      !url.search &&
      !url.hash &&
      /^\/openai(?:\/v1)?(?:\/chat\/completions)?\/?$/.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function isClinePassBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    return new URL(trimmed).hostname.toLowerCase() === 'api.cline.bot'
  } catch {
    return false
  }
}

export function isConcentrateBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const url = new URL(trimmed)
    return (
      url.protocol === 'https:' &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.hostname.toLowerCase() === 'api.concentrate.ai'
    )
  } catch {
    return false
  }
}

const CONCENTRATE_CANONICAL_INFERENCE_BASE_URL = 'https://api.concentrate.ai/v1'

export function isCanonicalConcentrateInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const canonical = new URL(CONCENTRATE_CANONICAL_INFERENCE_BASE_URL)
    const candidate = new URL(trimmed)
    const normalizePath = (pathname: string): string =>
      pathname.replace(/\/+$/, '') || '/'
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.hostname.toLowerCase() === canonical.hostname.toLowerCase() &&
      normalizePath(candidate.pathname) === normalizePath(canonical.pathname)
    )
  } catch {
    return false
  }
}

const LLMTR_CANONICAL_INFERENCE_BASE_URL = 'https://llmtr.com/v1'

export function isCanonicalLlmtrInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const canonical = new URL(LLMTR_CANONICAL_INFERENCE_BASE_URL)
    const candidate = new URL(trimmed)
    const normalizePath = (pathname: string): string =>
      pathname.replace(/\/+$/, '') || '/'
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.hostname.toLowerCase() === canonical.hostname.toLowerCase() &&
      normalizePath(candidate.pathname) === normalizePath(canonical.pathname)
    )
  } catch {
    return false
  }
}

const REQUESTY_INFERENCE_HOSTS = new Set([
  'router.requesty.ai',
  'router.eu.requesty.ai',
  'router.us.requesty.ai',
  'router.ap.requesty.ai',
])

/**
 * Requesty serves the same OpenAI-compatible /v1 API from a global host and
 * regional hosts (EU, US, AP) that accept the same key. Only those exact https
 * origins with the /v1 path may receive REQUESTY_API_KEY.
 */
export function isCanonicalRequestyInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const candidate = new URL(trimmed)
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.username &&
      !candidate.password &&
      !candidate.search &&
      !candidate.hash &&
      REQUESTY_INFERENCE_HOSTS.has(candidate.hostname.toLowerCase()) &&
      candidate.pathname.replace(/\/+$/, '') === '/v1'
    )
  } catch {
    return false
  }
}

const COMMANDCODE_CANONICAL_INFERENCE_BASE_URL =
  'https://api.commandcode.ai/provider/v1'

export function isCanonicalCommandcodeInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const canonical = new URL(COMMANDCODE_CANONICAL_INFERENCE_BASE_URL)
    const candidate = new URL(trimmed)
    const normalizePath = (pathname: string): string =>
      pathname.replace(/\/+$/, '') || '/'
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.hostname.toLowerCase() === canonical.hostname.toLowerCase() &&
      normalizePath(candidate.pathname) === normalizePath(canonical.pathname)
    )
  } catch {
    return false
  }
}

const API_ROUTE_CANONICAL_INFERENCE_BASE_URL =
  'https://global.api-route.com/v1'

export function isCanonicalApiRouteInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const canonical = new URL(API_ROUTE_CANONICAL_INFERENCE_BASE_URL)
    const candidate = new URL(trimmed)
    const normalizePath = (pathname: string): string =>
      pathname.replace(/\/+$/, '') || '/'
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.hostname.toLowerCase() === canonical.hostname.toLowerCase() &&
      normalizePath(candidate.pathname) === normalizePath(canonical.pathname)
    )
  } catch {
    return false
  }
}

export function isApiRouteBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const parsed = new URL(trimmed)
    return (
      parsed.protocol === 'https:' &&
      !parsed.port &&
      (parsed.hostname.toLowerCase() === 'global.api-route.com' ||
        parsed.hostname.toLowerCase() === 'api-route.com')
    )
  } catch {
    return false
  }
}

export function getConcentrateBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isConcentrateBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isConcentrateBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

/**
 * Host-scoped ApiSmart route match. Used for env-only conflict detection and
 * base-URL route identity (including `/v1/chat/completions` path suffixes that
 * still target the ApiSmart host). Credential forwarding and ambient-key
 * withholding use {@link isCanonicalApismartInferenceBaseUrl} instead — same
 * split AIMLAPI uses between host match and canonical inference URL.
 */
export function isApismartBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const parsed = new URL(trimmed)
    return (
      parsed.protocol === 'https:' &&
      !parsed.port &&
      parsed.hostname.toLowerCase() === 'gw.apismart.ai'
    )
  } catch {
    return false
  }
}

/**
 * Exact documented ApiSmart inference endpoint (`https://gw.apismart.ai/v1`).
 * Path suffixes (`/v1/models`), alternate versions (`/v2`), and host-only URLs
 * are not canonical — forwarding dedicated credentials there would send the
 * key to the wrong request/discovery path.
 */
const APISMART_CANONICAL_INFERENCE_BASE_URL = 'https://gw.apismart.ai/v1'

export function isCanonicalApismartInferenceBaseUrl(
  value: string | undefined,
): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  try {
    const canonical = new URL(APISMART_CANONICAL_INFERENCE_BASE_URL)
    const candidate = new URL(trimmed)
    const normalizePath = (pathname: string): string =>
      pathname.replace(/\/+$/, '') || '/'
    return (
      candidate.protocol === 'https:' &&
      !candidate.port &&
      !candidate.search &&
      !candidate.hash &&
      candidate.hostname.toLowerCase() === canonical.hostname.toLowerCase() &&
      normalizePath(candidate.pathname) === normalizePath(canonical.pathname)
    )
  } catch {
    return false
  }
}

/**
 * Checks whether the given URL value targets the Cloudflare Workers AI
 * OpenAI-compatible API, i.e. `api.cloudflare.com` **and** the Workers AI path
 * `/client/v4/accounts/<account_id>/ai/v1`.
 *
 * The host alone is not sufficient: `api.cloudflare.com` also serves the general
 * Cloudflare REST API (e.g. `/client/v4/user/tokens/verify`), which is not a
 * Workers AI endpoint. Route detection and CLOUDFLARE_API_TOKEN mirroring both
 * key on this predicate, so matching the whole host would route unrelated
 * Cloudflare API calls through the `cloudflare` provider and leak the token into
 * `OPENAI_API_KEY` for them.
 *
 * The account id must be a real value — the descriptor's literal `<ACCOUNT_ID>`
 * placeholder (or any `<…>` placeholder) does not count, since a URL still
 * carrying it cannot serve a request. The shared AI Gateway host
 * (`gateway.ai.cloudflare.com`) is also excluded — it proxies arbitrary upstream
 * providers, so a profile pointed there is not necessarily Cloudflare-credentialed.
 */
export function isCloudflareBaseUrl(value: string | undefined): boolean {
  const trimmed = value?.trim()
  if (!trimmed) {
    return false
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return false
  }
  // Workers AI is only served over HTTPS. Requiring `https:` here keeps the
  // Cloudflare route — and the CLOUDFLARE_API_TOKEN it mirrors into
  // OPENAI_API_KEY — off a plaintext `http://api.cloudflare.com/...` endpoint.
  if (url.protocol !== 'https:') {
    return false
  }
  if (url.hostname.toLowerCase() !== 'api.cloudflare.com') {
    return false
  }
  const match = url.pathname.match(
    /^\/client\/v4\/accounts\/([^/]+)\/ai\/v1(?:\/|$)/,
  )
  if (!match) {
    return false
  }
  let accountId: string
  try {
    accountId = decodeURIComponent(match[1] ?? '')
  } catch {
    accountId = match[1] ?? ''
  }
  return accountId.length > 0 && !/[<>]/.test(accountId)
}

export function getClinePassBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isClinePassBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isClinePassBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

export function getNearaiBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isNearaiBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isNearaiBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

/**
 * Returns the user-configured Fireworks AI base URL from `OPENAI_BASE_URL`
 * or `OPENAI_API_BASE` when the hostname resolves to api.fireworks.ai.
 */
export function getFireworksBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isFireworksBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isFireworksBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

export function getLongcatBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isLongcatBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isLongcatBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

export function getMiniMaxBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const anthropicBaseUrl = processEnv.ANTHROPIC_BASE_URL?.trim()
  if (isMiniMaxBaseUrl(anthropicBaseUrl)) {
    return anthropicBaseUrl
  }

  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isMiniMaxBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isMiniMaxBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

function isMiniMaxModelName(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return Boolean(
    normalized &&
      (normalized.startsWith('minimax-') || normalized.startsWith('minimax/')),
  )
}

function hasMiniMaxRouteIntent(processEnv: NodeJS.ProcessEnv): boolean {
  return (
    getMiniMaxBaseUrlOverride(processEnv) !== undefined ||
    isMiniMaxModelName(processEnv.OPENAI_MODEL) ||
    isMiniMaxModelName(processEnv.ANTHROPIC_MODEL)
  )
}

export function getXaiBaseUrlOverride(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const openAIBaseUrl = processEnv.OPENAI_BASE_URL?.trim()
  if (isXaiBaseUrl(openAIBaseUrl)) {
    return openAIBaseUrl
  }

  const openAIApiBase = processEnv.OPENAI_API_BASE?.trim()
  if (isXaiBaseUrl(openAIApiBase)) {
    return openAIApiBase
  }

  return undefined
}

function hasConflictingOpenAIBaseUrlForRoute(
  processEnv: NodeJS.ProcessEnv,
  isRouteBaseUrl: (value: string | undefined) => boolean,
): boolean {
  if (hasNonEmptyEnvValue(processEnv.OPENAI_BASE_URL)) {
    return !isRouteBaseUrl(processEnv.OPENAI_BASE_URL)
  }

  return (
    hasNonEmptyEnvValue(processEnv.OPENAI_API_BASE) &&
    !isRouteBaseUrl(processEnv.OPENAI_API_BASE)
  )
}

function hasExplicitOpenAIBaseUrlForRoute(
  processEnv: NodeJS.ProcessEnv,
  isRouteBaseUrl: (value: string | undefined) => boolean,
): boolean {
  if (hasNonEmptyEnvValue(processEnv.OPENAI_BASE_URL)) {
    return isRouteBaseUrl(processEnv.OPENAI_BASE_URL)
  }

  return (
    hasNonEmptyEnvValue(processEnv.OPENAI_API_BASE) &&
    isRouteBaseUrl(processEnv.OPENAI_API_BASE)
  )
}

function hasCompetingApismartCredential(
  processEnv: NodeJS.ProcessEnv,
  isRouteBaseUrl: (value: string | undefined) => boolean,
): boolean {
  return (
    hasUsableOpenAICredential(processEnv.APISMART_API_KEY) &&
    !hasExplicitOpenAIBaseUrlForRoute(processEnv, isRouteBaseUrl)
  )
}

function isAimlapiBaseUrl(baseUrl?: string): boolean {
  return normalizeHost(baseUrl) === 'api.aimlapi.com'
}

function hasNoExplicitNonOpenAICompatibleProvider(
  processEnv: NodeJS.ProcessEnv,
): boolean {
  return (
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_FOUNDRY)
  )
}

function hasNoExplicitNonOpenAIProvider(
  processEnv: NodeJS.ProcessEnv,
): boolean {
  return (
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX) &&
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_FOUNDRY)
  )
}

export function hasAimlapiEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasUsableOpenAICredential(processEnv.AIMLAPI_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isAimlapiBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isAimlapiBaseUrl) &&
    hasNoExplicitNonOpenAIProvider(processEnv)
  )
}

export function hasXaiEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isXaiBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isXaiBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

export function hasMiniMaxEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const hasExplicitMiniMaxIntent = hasMiniMaxRouteIntent(processEnv)
  const hasMiniMaxCredential =
    hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) ||
    (isMiniMaxBaseUrl(processEnv.ANTHROPIC_BASE_URL) &&
      hasNonEmptyEnvValue(processEnv.ANTHROPIC_API_KEY))

  return (
    hasMiniMaxCredential &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isMiniMaxBaseUrl) &&
    (hasExplicitMiniMaxIntent ||
      (!hasAnyUsableOpenAICredential(processEnv) &&
        !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
        !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
        !hasCompetingApismartCredential(processEnv, isMiniMaxBaseUrl) &&
        hasNoExplicitNonOpenAICompatibleProvider(processEnv)))
  )
}

export function hasVeniceEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.VENICE_API_KEY) &&
    !hasAnyUsableOpenAICredential(processEnv) &&
    !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isVeniceBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isVeniceBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

export function hasXiaomiMimoEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.MIMO_API_KEY) &&
    !hasAnyUsableOpenAICredential(processEnv) &&
    !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.VENICE_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isXiaomiMimoBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isXiaomiMimoBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

export function hasNearaiEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.NEARAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.VENICE_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MIMO_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.FIREWORKS_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.LONGCAT_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isNearaiBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isNearaiBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

/**
 * Detects whether the process environment is configured to route traffic
 * exclusively through Fireworks AI based on the presence of FIREWORKS_API_KEY
 * and the absence of conflicting env vars for other providers.
 */
export function hasFireworksEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.FIREWORKS_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.VENICE_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MIMO_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.NEARAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.LONGCAT_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isFireworksBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isFireworksBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

export function hasLongcatEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.LONGCAT_API_KEY) &&
    !hasAnyUsableOpenAICredential(processEnv) &&
    !hasNonEmptyEnvValue(processEnv.XAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MINIMAX_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.VENICE_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.MIMO_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.NEARAI_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.FIREWORKS_API_KEY) &&
    !hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isLongcatBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isLongcatBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

/**
 * Detects whether the process environment is configured to route traffic
 * exclusively through ClinePass based on the presence of CLINE_API_KEY
 * and the absence of conflicting env vars for other providers.
 */
export function hasClinePassEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasNonEmptyEnvValue(processEnv.CLINE_API_KEY) &&
    !hasCompetingApismartCredential(processEnv, isClinePassBaseUrl) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isClinePassBaseUrl) &&
    hasNoExplicitNonOpenAICompatibleProvider(processEnv)
  )
}

export function hasApismartEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  // Match AIMLAPI: ApiSmart is an OpenAI-compatible dedicated-key route, so a
  // lingering CLAUDE_CODE_USE_OPENAI=1 from a prior OpenAI session must not
  // suppress env-only ApiSmart identity. Only true non-OpenAI providers
  // (Gemini/GitHub/Bedrock/...) block this intent.
  return (
    hasUsableOpenAICredential(processEnv.APISMART_API_KEY) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isApismartBaseUrl) &&
    hasNoExplicitNonOpenAIProvider(processEnv)
  )
}

export function hasConcentrateEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  // The dedicated credential explicitly selects Concentrate. Base/model
  // overrides alone are configuration details, not route identity: treating
  // them as identity would let a stale optional setting override a valid
  // generic OpenAI configuration.
  return (
    hasUsableOpenAICredential(processEnv.CONCENTRATE_API_KEY) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isConcentrateBaseUrl) &&
    !(processEnv.CLAUDE_CODE_USE_OPENAI !== undefined &&
      !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) &&
    hasNoExplicitNonOpenAIProvider(processEnv)
  )
}

export function hasApiRouteEnvOnlyProviderIntent(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    hasUsableOpenAICredential(processEnv.API_ROUTE_API_KEY) &&
    !hasConflictingOpenAIBaseUrlForRoute(processEnv, isApiRouteBaseUrl) &&
    !(processEnv.CLAUDE_CODE_USE_OPENAI !== undefined &&
      !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) &&
    hasNoExplicitNonOpenAIProvider(processEnv)
  )
}

export function resolveEnvOnlyProviderRouteId(
  processEnv: NodeJS.ProcessEnv = process.env,
):
  | 'xai'
  | 'minimax'
  | 'aimlapi'
  | 'venice'
  | 'xiaomi-mimo'
  | 'nearai'
  | 'fireworks'
  | 'longcat'
  | 'clinepass'
  | 'apismart'
  | 'concentrate'
  | 'api-route'
  | null {
  if (
    hasMiniMaxRouteIntent(processEnv) &&
    hasMiniMaxEnvOnlyProviderIntent(processEnv)
  ) {
    return 'minimax'
  }

  if (hasAimlapiEnvOnlyProviderIntent(processEnv)) {
    return 'aimlapi'
  }

  if (hasXaiEnvOnlyProviderIntent(processEnv)) {
    return 'xai'
  }

  if (hasMiniMaxEnvOnlyProviderIntent(processEnv)) {
    return 'minimax'
  }

  if (hasVeniceEnvOnlyProviderIntent(processEnv)) {
    return 'venice'
  }

  if (hasXiaomiMimoEnvOnlyProviderIntent(processEnv)) {
    return 'xiaomi-mimo'
  }

  if (hasNearaiEnvOnlyProviderIntent(processEnv)) {
    return 'nearai'
  }

  if (hasFireworksEnvOnlyProviderIntent(processEnv)) {
    return 'fireworks'
  }

  if (hasLongcatEnvOnlyProviderIntent(processEnv)) {
    return 'longcat'
  }

  if (hasClinePassEnvOnlyProviderIntent(processEnv)) {
    return 'clinepass'
  }

  if (hasApismartEnvOnlyProviderIntent(processEnv)) {
    return 'apismart'
  }

  if (hasConcentrateEnvOnlyProviderIntent(processEnv)) {
    return 'concentrate'
  }

  if (hasApiRouteEnvOnlyProviderIntent(processEnv)) {
    return 'api-route'
  }

  return null
}

export function getRouteCredentialEnvVars(
  routeId: string,
): string[] {
  if (routeId === 'custom') {
    return ['OPENAI_API_KEYS', 'OPENAI_API_KEY']
  }

  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return []
  }

  const envVars = [...(descriptor.setup.credentialEnvVars ?? [])]
  if (
    (descriptor.transportConfig.kind === 'openai-compatible' ||
      descriptor.transportConfig.kind === 'local') &&
    !descriptor.setup.dedicatedCredentialsOnly &&
    !envVars.includes('OPENAI_API_KEYS')
  ) {
    const openAIFallbackIndex = envVars.indexOf('OPENAI_API_KEY')
    if (openAIFallbackIndex === -1) {
      envVars.push('OPENAI_API_KEYS', 'OPENAI_API_KEY')
    } else {
      envVars.splice(openAIFallbackIndex, 0, 'OPENAI_API_KEYS')
    }
  }

  return uniqueEnvVars(envVars)
}

export function getRouteCredentialValue(
  routeId: string,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return readFirstNonEmptyEnvValue(
    processEnv,
    getRouteCredentialEnvVars(routeId),
  )
}

export function resolveRouteCredentialValue(
  options?: {
    routeId?: string | null
    baseUrl?: string
    processEnv?: NodeJS.ProcessEnv
    activeProfileProvider?: string
  },
): string | undefined {
  const processEnv = options?.processEnv ?? process.env
  const routeId =
    options?.routeId ??
    resolveActiveRouteIdFromEnv(processEnv, {
      activeProfileProvider: options?.activeProfileProvider,
    }) ??
    resolveRouteIdFromBaseUrl(options?.baseUrl) ??
    (options?.baseUrl ? 'custom' : null)

  if (!routeId || routeId === 'anthropic') {
    return undefined
  }

  // ApiSmart's host is intentionally sufficient for route identity, but its
  // dedicated credential is valid only for the documented inference base.
  // Keep those concerns separate so discovery, versioned, or custom paths on
  // the same host cannot receive the bearer token.
  if (
    routeId === 'apismart' &&
    options?.baseUrl !== undefined &&
    !isCanonicalApismartInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }
  // Concentrate is the same: route identity is host-scoped, but the dedicated
  // credential is only valid for the documented /v1 inference endpoint.
  if (
    routeId === 'concentrate' &&
    options?.baseUrl !== undefined &&
    !isCanonicalConcentrateInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }
  if (
    routeId === 'llmtr' &&
    options?.baseUrl !== undefined &&
    !isCanonicalLlmtrInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }
  if (
    routeId === 'commandcode' &&
    options?.baseUrl !== undefined &&
    !isCanonicalCommandcodeInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }
  if (
    routeId === 'api-route' &&
    options?.baseUrl !== undefined &&
    !isCanonicalApiRouteInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }
  if (
    routeId === 'requesty' &&
    options?.baseUrl !== undefined &&
    !isCanonicalRequestyInferenceBaseUrl(options.baseUrl)
  ) {
    return undefined
  }

  return getRouteCredentialValue(routeId, processEnv)
}

export function routeSupportsCustomHeaders(
  routeId: string,
): boolean {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return false
  }

  return (
    descriptor.transportConfig.openaiShim?.supportsAuthHeaders === true ||
    descriptor.transportConfig.anthropicProxy?.supportsCustomHeaders === true
  )
}

export function routeShowsAuthHeaderValue(routeId: string): boolean {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return false
  }

  return (
    descriptor.transportConfig.openaiShim?.supportsAuthHeaders === true &&
    descriptor.transportConfig.openaiShim?.ui?.showAuthHeaderValue !== false
  )
}

export function routeShowsAuthHeader(routeId: string): boolean {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return false
  }

  return (
    descriptor.transportConfig.openaiShim?.supportsAuthHeaders === true &&
    descriptor.transportConfig.openaiShim?.ui?.showAuthHeader !== false
  )
}

export function routeShowsCustomHeaders(routeId: string): boolean {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor) {
    return false
  }

  return (
    routeSupportsCustomHeaders(routeId) &&
    descriptor.transportConfig.openaiShim?.ui?.showCustomHeaders !== false
  )
}

function routeSupportsOpenAIShimOption(
  routeId: string,
  option: 'supportsApiFormatSelection' | 'supportsAuthHeaders',
): boolean {
  const descriptor = getRouteDescriptor(routeId)
  if (!descriptor || descriptor.transportConfig.kind !== 'openai-compatible') {
    return false
  }

  return descriptor.transportConfig.openaiShim?.[option] === true
}

export function routeSupportsApiFormatSelection(routeId: string): boolean {
  return routeSupportsOpenAIShimOption(routeId, 'supportsApiFormatSelection')
}

export function routeSupportsAuthHeaders(routeId: string): boolean {
  return routeSupportsOpenAIShimOption(routeId, 'supportsAuthHeaders')
}

export function getRouteProviderTypeLabel(
  routeId: string,
): string {
  const kind = getRouteDescriptor(routeId)?.transportConfig.kind
  return (
    (kind ? TRANSPORT_KIND_PROVIDER_TYPE_LABELS[kind] : undefined) ??
    'OpenAI-compatible API'
  )
}

export function resolveRouteIdFromBaseUrl(
  baseUrl?: string,
  options?: {
    requireDiscovery?: boolean
  },
): string | null {
  const normalizedBaseUrl = normalizeComparableBaseUrl(baseUrl)
  const normalizedHost = normalizeHost(baseUrl)
  if (!normalizedBaseUrl && !normalizedHost) {
    return null
  }

  const routes = getAllRoutes().filter(route =>
    options?.requireDiscovery ? Boolean(route.catalog?.discovery) : true,
  )

  for (const route of routes) {
    const normalizedDefaultBaseUrl = normalizeComparableBaseUrl(
      route.defaultBaseUrl,
    )
    if (
      normalizedBaseUrl &&
      normalizedDefaultBaseUrl === normalizedBaseUrl
    ) {
      // LLMTR's dedicated credential and fixed transport contract are valid
      // only for the exact inference URL. The generic comparable-URL helper
      // intentionally ignores query/hash components for other providers, but a
      // query-bearing LLMTR URL is a retargeted/custom endpoint.
      if (
        route.id === 'llmtr' &&
        !isCanonicalLlmtrInferenceBaseUrl(baseUrl)
      ) {
        continue
      }
      if (
        route.id === 'commandcode' &&
        !isCanonicalCommandcodeInferenceBaseUrl(baseUrl)
      ) {
        continue
      }
      if (
        route.id === 'api-route' &&
        !isCanonicalApiRouteInferenceBaseUrl(baseUrl)
      ) {
        continue
      }
      return route.id
    }
  }

  if (normalizedHost) {
    for (const route of routes) {
      if (matchHostnameAgainstRouteHosts(normalizedHost, getValidationRoutingHosts(route))) {
        // api.cloudflare.com also serves the general Cloudflare REST API, so a
        // bare hostname match isn't enough for the Workers AI route — require
        // the Workers AI path (/client/v4/accounts/<id>/ai/v1). Otherwise an
        // unrelated Cloudflare API URL would inherit Workers-AI routing.
        if (
          (route.id === 'cloudflare' && !isCloudflareBaseUrl(baseUrl)) ||
          (route.id === 'longcat' && !isLongcatBaseUrl(baseUrl)) ||
          (route.id === 'apismart' && !isApismartBaseUrl(baseUrl)) ||
          (route.id === 'concentrate' &&
            !isCanonicalConcentrateInferenceBaseUrl(baseUrl)) ||
          (route.id === 'llmtr' &&
            !isCanonicalLlmtrInferenceBaseUrl(baseUrl)) ||
          (route.id === 'commandcode' &&
            !isCanonicalCommandcodeInferenceBaseUrl(baseUrl)) ||
          (route.id === 'api-route' &&
            !isApiRouteBaseUrl(baseUrl))
        ) {
          continue
        }
        return route.id
      }
    }
  }

  const localRouteId = resolveKnownLocalRouteIdFromBaseUrl(baseUrl)
  if (localRouteId) {
    return localRouteId
  }

  return null
}

/**
 * Extra boundary for resolving a route from the *active profile provider* (not
 * from a matched base URL). Most routes are host-scoped by resolveProfileRoute,
 * but the Cloudflare Workers AI route is path-scoped (see isCloudflareBaseUrl):
 * a saved `cloudflare` profile retargeted to a non-Workers URL — the shared AI
 * Gateway host, or a general api.cloudflare.com REST path — must NOT resolve as
 * `cloudflare`, or its Workers-AI shim config and CLOUDFLARE_API_TOKEN mirroring
 * would be applied to a generic endpoint. Returns true (route allowed) for every
 * other route.
 */
function profileRouteHonorsBaseUrlBoundary(
  routeId: string,
  baseUrl: string | undefined,
): boolean {
  if (routeId === 'cloudflare') {
    return isCloudflareBaseUrl(baseUrl)
  }
  if (routeId === 'longcat') {
    return isLongcatBaseUrl(baseUrl)
  }
  if (routeId === 'apismart') {
    return isApismartBaseUrl(baseUrl)
  }
  if (routeId === 'llmtr') {
    return isCanonicalLlmtrInferenceBaseUrl(baseUrl)
  }
  if (routeId === 'commandcode') {
    return isCanonicalCommandcodeInferenceBaseUrl(baseUrl)
  }
  if (routeId === 'api-route') {
    return isCanonicalApiRouteInferenceBaseUrl(baseUrl)
  }
  if (routeId === 'zai') {
    return !baseUrl || isCanonicalZaiCodingPlanBaseUrl(baseUrl)
  }
  return true
}

export function resolveActiveRouteIdFromEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
  options?: {
    activeProfileProvider?: string
    activeProfileBaseUrl?: string
  },
): string | null {
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI)) {
    return 'gemini'
  }
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL)) {
    return 'mistral'
  }
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    return 'github'
  }
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_BEDROCK)) {
    return 'bedrock'
  }
  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_VERTEX)) {
    return 'vertex'
  }

  // A Bearer token explicitly selects the custom Anthropic proxy contract,
  // even if the host also belongs to a known OpenAI-compatible route. Keep
  // native x-api-key configurations on those known routes for compatibility.
  const anthropicBaseUrl = hasNonEmptyEnvValue(processEnv.ANTHROPIC_BASE_URL)
    ? processEnv.ANTHROPIC_BASE_URL
    : undefined
  const knownAnthropicRoute = resolveRouteIdFromBaseUrl(anthropicBaseUrl)
  if (
    !isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI) &&
    anthropicBaseUrl &&
    hasNonEmptyEnvValue(processEnv.ANTHROPIC_MODEL) &&
    (hasNonEmptyEnvValue(processEnv.ANTHROPIC_AUTH_TOKEN) ||
      hasNonEmptyEnvValue(processEnv.ANTHROPIC_API_KEY)) &&
    !isFirstPartyAnthropicBaseUrlForEnv(processEnv) &&
    (hasNonEmptyEnvValue(processEnv.ANTHROPIC_AUTH_TOKEN) ||
      knownAnthropicRoute === 'custom-anthropic' ||
      !knownAnthropicRoute)
  ) {
    return 'custom-anthropic'
  }

  const envOnlyRouteId = resolveEnvOnlyProviderRouteId(processEnv)
  if (envOnlyRouteId) return envOnlyRouteId

  if (isEnvTruthy(processEnv.CLAUDE_CODE_USE_OPENAI)) {
    const baseUrl = hasNonEmptyEnvValue(processEnv.OPENAI_BASE_URL)
      ? processEnv.OPENAI_BASE_URL
      : hasNonEmptyEnvValue(processEnv.OPENAI_API_BASE)
        ? processEnv.OPENAI_API_BASE
        : undefined
    const hasExplicitBaseUrl = baseUrl !== undefined
    const matchedRoute = resolveRouteIdFromBaseUrl(baseUrl)

    if (matchedRoute) {
      return matchedRoute
    }

    if (!hasExplicitBaseUrl && options?.activeProfileProvider) {
      const route = resolveProfileRoute(options.activeProfileProvider)
      if (
        route.routeId !== 'unknown-fallback' &&
        route.routeId !== 'openai' &&
        route.routeId !== 'custom' &&
        profileRouteHonorsBaseUrlBoundary(
          route.routeId,
          options.activeProfileBaseUrl ?? baseUrl,
        )
      ) {
        return route.routeId
      }
      // A custom/unknown profile may still target a known gateway via its
      // saved base URL; prefer that route over the generic openai/custom path.
      const profileBaseUrlRoute = resolveRouteIdFromBaseUrl(
        options.activeProfileBaseUrl,
      )
      if (profileBaseUrlRoute) {
        return profileBaseUrlRoute
      }
    }

    const normalizedBaseUrl = normalizeComparableBaseUrl(baseUrl)
    const openAIDefaultBaseUrl = normalizeComparableBaseUrl(
      getRouteDefaultBaseUrl('openai'),
    )

    if (!normalizedBaseUrl || normalizedBaseUrl === openAIDefaultBaseUrl) {
      return 'openai'
    }

    return 'custom'
  }

  if (!anthropicBaseUrl && options?.activeProfileProvider) {
    const route = resolveProfileRoute(options.activeProfileProvider)
    if (
      route.routeId !== 'unknown-fallback' &&
      route.routeId !== 'openai' &&
      route.routeId !== 'custom' &&
      profileRouteHonorsBaseUrlBoundary(
        route.routeId,
        options.activeProfileBaseUrl,
      )
    ) {
      return route.routeId
    }
    // A custom/unknown profile may still target a known gateway via its
    // saved base URL; prefer that route over the generic anthropic fallback.
    const profileBaseUrlRoute = resolveRouteIdFromBaseUrl(
      options.activeProfileBaseUrl,
    )
    if (profileBaseUrlRoute) {
      return profileBaseUrlRoute
    }
  }

  return 'anthropic'
}

export function getTransportKindForRoute(
  routeId: string,
): TransportKind | null {
  return getRouteDescriptor(routeId)?.transportConfig.kind ?? null
}
