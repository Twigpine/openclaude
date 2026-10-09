import { randomBytes } from 'crypto'
import {
  getAdditionalModelOptionsCacheScope,
  isCodexAlias,
  isCodexBaseUrl,
  isCodexEligibleGpt5Model,
  parseOpenAICompatibleApiFormat,
} from '../services/api/providerConfig.js'
import {
  getGlobalConfig,
  saveGlobalConfig,
  type ProviderProfile,
} from './config.js'
import type { ModelOption } from './model/modelOptions.js'
import { getPrimaryModel, parseModelList } from './providerModels.js'
import {
  buildCompatibilityProcessEnv,
  createProfileFile,
  saveProfileFile,
  buildBedrockProfileEnv,
  buildConcentrateProfileEnv,
  buildGeminiProfileEnv,
  buildGithubProfileEnv,
  buildMiniMaxProfileEnv,
  buildMistralProfileEnv,
  buildNvidiaNimProfileEnv,
  buildOpenAIProfileEnv,
  buildVeniceProfileEnv,
  buildXaiOAuthProfileEnv,
  buildXiaomiMimoProfileEnv,
  buildAtlasCloudProfileEnv,
  buildApismartProfileEnv,
  buildVertexProfileEnv,
  clearManagedProfileEnv,
  deleteProfileFile,
  type ProfileFileLocation,
  type ProfileEnv,
  type ProviderProfile as ProviderProfileStartup,
} from './providerProfile.js'
import { isCanonicalAimlapiInferenceBaseUrl } from '../integrations/aimlapi/config.js'
import { refreshStartupDiscoveryForRoute } from '../integrations/discoveryService.js'
import {
  getCatalogEntriesForRoute,
  getProviderPresetUiMetadata,
  normalizeXiaomiMimoBaseUrl,
  routeSupportsApiFormatSelection,
  routeSupportsAuthHeaders,
  routeSupportsCustomHeaders,
  resolveProfileRoute,
  resolveRouteIdFromBaseUrl,
  type ResolvedProfileRoute,
  type ProviderPreset,
} from '../integrations/index.js'
import {
  getRouteDefaultBaseUrl,
  isCloudflareBaseUrl,
  isClinePassBaseUrl,
  isCanonicalApiRouteInferenceBaseUrl,
  isCanonicalApismartInferenceBaseUrl,
  isCanonicalConcentrateInferenceBaseUrl,
  isCanonicalLlmtrInferenceBaseUrl,
  isCanonicalCommandcodeInferenceBaseUrl,
  isFireworksBaseUrl,
  isLongcatBaseUrl,
  isNearaiBaseUrl,
  isXaiBaseUrl,
  isXiaomiMimoBaseUrl,
  resolveEnvOnlyProviderRouteId,
  resolveRouteCredentialValue,
} from '../integrations/routeMetadata.js'
import { getCommandcodeChatCompletionsModelError } from '../integrations/gateways/commandcode.js'
import { logForDebugging } from './debug.js'
import {
  sanitizeProfileCustomHeaders,
  serializeProfileCustomHeaders,
} from './providerCustomHeaders.js'
import { sanitizeApiKey } from './providerSecrets.js'
import { getSettings_DEPRECATED } from './settings/settings.js'

export type { ProviderPreset } from '../integrations/index.js'

export type ProviderProfileInput = {
  provider?: ProviderProfile['provider']
  name: string
  baseUrl: string
  model: string
  apiKey?: string
  apiFormat?: ProviderProfile['apiFormat']
  azureStyle?: ProviderProfile['azureStyle']
  authHeader?: ProviderProfile['authHeader']
  authScheme?: ProviderProfile['authScheme']
  authHeaderValue?: ProviderProfile['authHeaderValue']
  customHeaders?: ProviderProfile['customHeaders']
  maxContextLength?: ProviderProfile['maxContextLength']
}

export type ProviderProfileWriteOptions = {
  /** Marks credentials adopted from process env rather than entered by a user. */
  credentialSource?: 'environment'
}

export type ProviderPresetDefaults = Omit<ProviderProfileInput, 'provider'> & {
  provider: ProviderProfile['provider']
  requiresApiKey: boolean
}

const PROFILE_ENV_APPLIED_FLAG = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED'
const PROFILE_ENV_APPLIED_ID = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID'

type ProfileCompatibilityMode =
  | 'anthropic'
  | 'gemini'
  | 'mistral'
  | 'github'
  | 'github-enterprise'
  | 'bedrock'
  | 'vertex'
  | 'openai'

function isGithubCompatibilityMode(
  compatibilityMode: ProfileCompatibilityMode,
): boolean {
  return (
    compatibilityMode === 'github' ||
    compatibilityMode === 'github-enterprise'
  )
}

function resolveProfileCompatibility(provider: string): {
  route: ResolvedProfileRoute
  compatibilityMode: ProfileCompatibilityMode
} {
  const route = resolveProfileRoute(provider)

  if (provider === 'github-enterprise' || route.gatewayId === 'github-enterprise') {
    return { route, compatibilityMode: 'github-enterprise' }
  }
  if (provider === 'github' || route.gatewayId === 'github') {
    return { route, compatibilityMode: 'github' }
  }
  if (route.gatewayId === 'bedrock') {
    return { route, compatibilityMode: 'bedrock' }
  }
  if (route.gatewayId === 'vertex') {
    return { route, compatibilityMode: 'vertex' }
  }
  if (route.vendorId === 'anthropic') {
    return { route, compatibilityMode: 'anthropic' }
  }
  if (route.vendorId === 'minimax') {
    return { route, compatibilityMode: 'anthropic' }
  }
  if (route.vendorId === 'gemini') {
    return { route, compatibilityMode: 'gemini' }
  }
  if (route.vendorId === 'mistral' || route.gatewayId === 'mistral') {
    return { route, compatibilityMode: 'mistral' }
  }

  return { route, compatibilityMode: 'openai' }
}

function isClinePassProfile(profile: ProviderProfile): boolean {
  const { route } = resolveProfileCompatibility(profile.provider)
  return route.routeId === 'clinepass' || isClinePassBaseUrl(profile.baseUrl)
}

function isApismartProfile(profile: ProviderProfile): boolean {
  const baseUrl = profile.baseUrl?.trim()
  // Missing base URL resolves to the ApiSmart default, which is canonical.
  // Only the documented `/v1` inference URL may carry the dedicated key —
  // host-only or path-suffixed ApiSmart URLs are treated as retargeted.
  return !baseUrl || isCanonicalApismartInferenceBaseUrl(baseUrl)
}

function isConcentrateProfile(profile: ProviderProfile): boolean {
  const { route } = resolveProfileCompatibility(profile.provider)
  if (route.routeId !== 'concentrate') {
    return false
  }
  const baseUrl = profile.baseUrl?.trim()
  // Missing base URL resolves to the Concentrate default, which is canonical.
  // Only the documented `/v1` inference URL may carry the dedicated key —
  // host-only or path-suffixed Concentrate URLs are treated as retargeted.
  return !baseUrl || isCanonicalConcentrateInferenceBaseUrl(baseUrl)
}

function isApiRouteProfile(profile: ProviderProfile): boolean {
  const { route } = resolveProfileCompatibility(profile.provider)
  if (route.routeId !== 'api-route') {
    return false
  }
  const baseUrl = profile.baseUrl?.trim()
  return !baseUrl || isCanonicalApiRouteInferenceBaseUrl(baseUrl)
}

function isLlmtrProfile(profile: ProviderProfile): boolean {
  const { route } = resolveProfileCompatibility(profile.provider)
  if (route.routeId !== 'llmtr') {
    return false
  }
  const baseUrl = profile.baseUrl?.trim()
  return !baseUrl || isCanonicalLlmtrInferenceBaseUrl(baseUrl)
}

function isCommandcodeProfile(profile: ProviderProfile): boolean {
  const { route, compatibilityMode } = resolveProfileCompatibility(
    profile.provider,
  )
  if (compatibilityMode !== 'openai') return false
  const baseUrl = profile.baseUrl?.trim()
  if (route.routeId === 'commandcode') {
    return !baseUrl || isCanonicalCommandcodeInferenceBaseUrl(baseUrl)
  }
  // Legacy generic OpenAI profiles are runtime-classified by their endpoint.
  // Treat only the exact canonical inference URL as Command Code ownership;
  // generic or retargeted URLs must never receive the dedicated credential.
  return Boolean(baseUrl && isCanonicalCommandcodeInferenceBaseUrl(baseUrl))
}

function deriveGithubEnterpriseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined
  try {
    const parsed = new URL(baseUrl)
    if (parsed.origin === 'https://api.githubcopilot.com') {
      return undefined
    }
    return parsed.origin
  } catch {
    return undefined
  }
}

function buildGithubCompatibleProfileEnv(options: {
  model: string
  baseUrl?: string
  gatewayId?: string
  apiKey?: string
}): ProfileEnv {
  const env = buildGithubProfileEnv({
    model: options.model,
    baseUrl: options.baseUrl,
  })

  if (options.gatewayId === 'github-enterprise') {
    const enterpriseUrl = deriveGithubEnterpriseUrl(options.baseUrl)
    if (enterpriseUrl) {
      env.GITHUB_ENTERPRISE_URL = enterpriseUrl
    }
    if (options.apiKey?.trim()) {
      env.GITHUB_COPILOT_KEY = options.apiKey.trim()
    }
  }

  return env
}

function trimValue(value: string | undefined): string {
  return value?.trim() ?? ''
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = trimValue(value)
  return trimmed.length > 0 ? trimmed : undefined
}

function sanitizeAuthHeader(value: string | undefined): string | undefined {
  const trimmed = trimOrUndefined(value)
  if (!trimmed) {
    return undefined
  }
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(trimmed)
    ? trimmed
    : undefined
}

function sanitizeAuthScheme(value: string | undefined): ProviderProfile['authScheme'] | undefined {
  return value === 'raw' || value === 'bearer' ? value : undefined
}

function normalizeBaseUrl(value: string): string {
  return trimValue(value).replace(/\/+$/, '')
}

export function resolveProfileCapabilityRouteId(
  provider: string,
  baseUrl?: string,
): string {
  const providerRouteId = resolveProfileRoute(provider).routeId
  if (providerRouteId === 'custom-anthropic') {
    return providerRouteId
  }

  const routeIdFromBaseUrl = resolveRouteIdFromBaseUrl(baseUrl)
  if (routeIdFromBaseUrl) {
    return routeIdFromBaseUrl
  }

  if (providerRouteId === 'zai' && baseUrl) {
    return 'custom'
  }

  // Dedicated-route profiles retargeted away from their documented endpoints
  // run generically at runtime. Mirror that boundary here so capability-driven
  // surfaces are not stripped based on stale route ids.
  if (
    (providerRouteId === 'cloudflare' ||
      providerRouteId === 'longcat' ||
      providerRouteId === 'concentrate' ||
      providerRouteId === 'api-route' ||
      providerRouteId === 'llmtr' ||
      providerRouteId === 'commandcode') &&
    baseUrl &&
    !(providerRouteId === 'cloudflare'
      ? isCloudflareBaseUrl(baseUrl)
      : providerRouteId === 'longcat'
        ? isLongcatBaseUrl(baseUrl)
        : providerRouteId === 'concentrate'
          ? isCanonicalConcentrateInferenceBaseUrl(baseUrl)
          : providerRouteId === 'api-route'
            ? isCanonicalApiRouteInferenceBaseUrl(baseUrl)
          : providerRouteId === 'commandcode'
            ? isCanonicalCommandcodeInferenceBaseUrl(baseUrl)
            : isCanonicalLlmtrInferenceBaseUrl(baseUrl))
  ) {
    return 'custom'
  }

  return providerRouteId
}

function normalizeProfileModelLookupKey(model: string | undefined): string {
  // Strip a trailing [1m] tag along with any ?query suffix: the tag is a
  // client-side context opt-in, not part of the model's identity, so a saved
  // `codexplan[1m]` must still match a profile/catalog entry of `codexplan`.
  return (
    model?.trim().split('?', 1)[0]?.trim().toLowerCase().replace(/\[1m]$/, '') ??
    ''
  )
}

function profileSupportsModel(profile: ProviderProfile, model: string): boolean {
  const normalizedModel = normalizeProfileModelLookupKey(model)
  if (!normalizedModel) {
    return false
  }

  if (
    parseModelList(profile.model).some(
      configured => normalizeProfileModelLookupKey(configured) === normalizedModel,
    )
  ) {
    return true
  }

  // Codex-backend profiles (ChatGPT OAuth) are created with a single
  // `codexplan` entry, but the backend accepts every Codex alias model and
  // the wider gpt-5.x family (free-text /model picks like `gpt-5.1-codex`
  // pass live validation before being persisted). Without this, a saved
  // pick like `gpt-5.6-terra` is rejected here at the next startup, so the
  // profile's default silently wins and the choice appears to not stick.
  // Deliberately NOT a blanket allow: a stale non-GPT model saved under a
  // different provider (e.g. `kimi-k2.6`) — or an API-only gpt-5-mini/-nano
  // tier the Codex backend does not serve — must still fall back to the
  // profile default rather than 400 against the Codex backend. The gate is
  // authoritative for Codex profiles: falling through to the catalog check
  // would consult the `openai` route catalog (the profile's provider is
  // 'openai'), which describes api.openai.com's model set, not the ChatGPT
  // Codex backend's.
  if (isCodexBaseUrl(profile.baseUrl)) {
    return (
      isCodexAlias(normalizedModel) || isCodexEligibleGpt5Model(normalizedModel)
    )
  }

  const routeId = resolveProfileCapabilityRouteId(profile.provider, profile.baseUrl)
  return getCatalogEntriesForRoute(routeId).some(
    entry =>
      normalizeProfileModelLookupKey(entry.apiName) === normalizedModel ||
      normalizeProfileModelLookupKey(entry.id) === normalizedModel ||
      (entry.aliases ?? []).some(
        alias => normalizeProfileModelLookupKey(alias) === normalizedModel,
      ),
  )
}

let savedModelOverrideForTesting: string | undefined

export function _setSavedModelOverrideForTesting(model: string | undefined): void {
  savedModelOverrideForTesting = model
}

function getSavedModelOverrideForProfile(
  profile: ProviderProfile,
): string | undefined {
  const savedModel = trimOrUndefined(
    savedModelOverrideForTesting ?? getSettings_DEPRECATED()?.model,
  )
  if (!savedModel || !profileSupportsModel(profile, savedModel)) {
    return undefined
  }

  return savedModel
}

function sanitizeProfile(profile: ProviderProfile): ProviderProfile | null {
  const id = trimValue(profile.id)
  const name = trimValue(profile.name)
  const provider = trimValue(profile.provider)
  const baseUrl = normalizeBaseUrl(profile.baseUrl)
  const model = trimValue(profile.model)
  const apiFormat = parseOpenAICompatibleApiFormat(profile.apiFormat)
  const azureStyle = profile.azureStyle === true
  const authHeader = sanitizeAuthHeader(profile.authHeader)
  const authScheme = sanitizeAuthScheme(profile.authScheme)
  const authHeaderValue = trimOrUndefined(profile.authHeaderValue)
  const capabilityRouteId = resolveProfileCapabilityRouteId(provider, baseUrl)
  const supportsApiFormat = routeSupportsApiFormatSelection(capabilityRouteId)
  const supportsAuthHeaders = routeSupportsAuthHeaders(capabilityRouteId)
  const customHeaders = routeSupportsCustomHeaders(capabilityRouteId)
    ? sanitizeProfileCustomHeaders(profile.customHeaders)
    : undefined

  if (!id || !name || !baseUrl || !model || !provider) {
    return null
  }

  const maxContextLength =
    typeof profile.maxContextLength === 'number' &&
    Number.isFinite(profile.maxContextLength) &&
    profile.maxContextLength > 0 &&
    Number.isInteger(profile.maxContextLength)
      ? profile.maxContextLength
      : undefined

  const sanitized: ProviderProfile = {
    id,
    name,
    provider,
    baseUrl,
    model,
    // Drop template/dotenv sentinels so placeholders never persist as keys.
    apiKey: sanitizeApiKey(trimOrUndefined(profile.apiKey)),
  }
  if (supportsApiFormat && apiFormat) {
    sanitized.apiFormat = apiFormat
  }
  if (azureStyle) {
    sanitized.azureStyle = true
  }
  if (supportsAuthHeaders && authHeader) {
    sanitized.authHeader = authHeader
    sanitized.authScheme = authScheme ?? (
      authHeader.toLowerCase() === 'authorization' ? 'bearer' : 'raw'
    )
    sanitized.authHeaderValue = authHeaderValue
  }
  if (customHeaders) {
    sanitized.customHeaders = customHeaders
  }
  if (maxContextLength !== undefined) {
    sanitized.maxContextLength = maxContextLength
  }
  return sanitized
}

function sanitizeProfiles(profiles: ProviderProfile[] | undefined): ProviderProfile[] {
  const seen = new Set<string>()
  const sanitized: ProviderProfile[] = []

  for (const profile of profiles ?? []) {
    const normalized = sanitizeProfile(profile)
    if (!normalized || seen.has(normalized.id)) {
      continue
    }
    seen.add(normalized.id)
    sanitized.push(normalized)
  }

  return sanitized
}

function nextProfileId(): string {
  return `provider_${randomBytes(6).toString('hex')}`
}

function applyCommandcodeProfileWriteContract(
  profile: ProviderProfile,
  options?: ProviderProfileWriteOptions,
): ProviderProfile | null {
  if (!isCommandcodeProfile(profile)) {
    return profile
  }

  // Command Code is Chat Completions only. Reject the write so Console OAuth
  // env adoption, /provider, and any future caller share one gate instead of
  // persisting Claude/alias models that later startup and /model paths inherit.
  if (getCommandcodeChatCompletionsModelError(profile.model)) {
    return null
  }

  // Dedicated env keys are the Command Code credential. Generic OPENAI_API_KEY
  // is never route auth, so environment-sourced writes must persist the
  // dedicated secret or fail without mutating a profile. Explicit setup keeps
  // accepting the credential the user entered.
  const dedicatedKey = sanitizeApiKey(
    resolveRouteCredentialValue({
      routeId: 'commandcode',
      baseUrl: profile.baseUrl,
    }),
  )
  if (options?.credentialSource === 'environment') {
    return dedicatedKey ? { ...profile, apiKey: dedicatedKey } : null
  }
  if (dedicatedKey && !profile.apiKey) {
    return { ...profile, apiKey: dedicatedKey }
  }
  return profile
}

function toProfile(
  input: ProviderProfileInput,
  id: string = nextProfileId(),
  options?: ProviderProfileWriteOptions,
): ProviderProfile | null {
  const profile = sanitizeProfile({
    id,
    provider: input.provider ?? 'openai',
    name: input.name,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    apiFormat: input.apiFormat,
    azureStyle: input.azureStyle,
    authHeader: input.authHeader,
    authScheme: input.authScheme,
    authHeaderValue: input.authHeaderValue,
    customHeaders: input.customHeaders,
    maxContextLength: input.maxContextLength,
  })
  return profile ? applyCommandcodeProfileWriteContract(profile, options) : null
}

function getSupportedProfileCustomHeadersEnv(
  profile: ProviderProfile,
): string | undefined {
  const routeId = resolveProfileCapabilityRouteId(
    profile.provider,
    profile.baseUrl,
  )
  if (!routeSupportsCustomHeaders(routeId)) {
    return undefined
  }
  return serializeProfileCustomHeaders(
    sanitizeProfileCustomHeaders(profile.customHeaders),
  )
}

function applySupportedProfileCustomHeaders(
  profile: ProviderProfile,
  env: ProfileEnv,
): ProfileEnv {
  const customHeaders = getSupportedProfileCustomHeadersEnv(profile)
  return customHeaders ? { ...env, ANTHROPIC_CUSTOM_HEADERS: customHeaders } : env
}

function buildAnthropicCredentialEnv(
  provider: ProviderProfile['provider'],
  apiKey: string | undefined,
): ProfileEnv {
  if (!apiKey) return {}
  return provider === 'custom-anthropic'
    ? { ANTHROPIC_AUTH_TOKEN: apiKey }
    : { ANTHROPIC_API_KEY: apiKey }
}

function getModelCacheByProfile(
  profileId: string,
  config = getGlobalConfig(),
): ModelOption[] {
  return config.openaiAdditionalModelOptionsCacheByProfile?.[profileId] ?? []
}

function mergeModelOptionsByValue(
  primaryOptions: ModelOption[],
  additionalOptions: ModelOption[],
): ModelOption[] {
  const merged: ModelOption[] = []
  const seen = new Set<string>()

  for (const option of [...primaryOptions, ...additionalOptions]) {
    if (typeof option.value !== 'string') {
      continue
    }
    const value = option.value.trim()
    if (!value || seen.has(value)) {
      continue
    }
    seen.add(value)
    merged.push({
      ...option,
      value,
    })
  }

  return merged
}

export function getProviderPresetDefaults(
  preset: ProviderPreset,
): ProviderPresetDefaults {
  const metadata = getProviderPresetUiMetadata(preset)
  // Keep preset-pinned endpoints/models even when generic OpenAI env values
  // are present, but still read provider-specific credential env vars above.
  const routeDefaults =
    preset === 'custom' || preset === 'custom-anthropic'
      ? metadata
      : getProviderPresetUiMetadata(preset, {})
  return {
    provider: metadata.provider,
    name: metadata.name,
    baseUrl: routeDefaults.baseUrl,
    model: routeDefaults.model,
    // The /provider custom Anthropic flow always saves a Bearer token. Keep
    // direct ANTHROPIC_API_KEY/x-api-key setups out of that field so opening
    // the preset cannot silently change their authentication scheme.
    apiKey:
      preset === 'custom-anthropic'
        ? process.env.ANTHROPIC_AUTH_TOKEN?.trim() || undefined
        : metadata.apiKey,
    requiresApiKey: metadata.requiresApiKey,
  }
}

export function getProviderProfiles(
  config = getGlobalConfig(),
): ProviderProfile[] {
  return sanitizeProfiles(config.providerProfiles)
}

export function hasProviderProfiles(config = getGlobalConfig()): boolean {
  return getProviderProfiles(config).length > 0
}

function hasProviderSelectionFlags(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    processEnv.CLAUDE_CODE_USE_OPENAI !== undefined ||
    processEnv.CLAUDE_CODE_USE_GEMINI !== undefined ||
    processEnv.CLAUDE_CODE_USE_MISTRAL !== undefined ||
    processEnv.CLAUDE_CODE_USE_GITHUB !== undefined ||
    processEnv.CLAUDE_CODE_USE_BEDROCK !== undefined ||
    processEnv.CLAUDE_CODE_USE_VERTEX !== undefined ||
    processEnv.CLAUDE_CODE_USE_FOUNDRY !== undefined
  )
}

/**
 * A "complete" explicit provider selection = a USE flag AND at least one
 * concrete config value that tells us WHERE to route (a base URL) or WHAT
 * to run (a model id). A bare `CLAUDE_CODE_USE_OPENAI=1` with nothing else
 * is almost always a stale shell export from a previous session, not real
 * intent — and if we respect it, we skip the user's saved active profile
 * and fall back to hardcoded defaults (gpt-4o / api.openai.com), which is
 * the exact bug users report as "my saved provider isn't picked up".
 *
 * Used to gate whether saved-profile env should override shell state at
 * startup. The weaker `hasProviderSelectionFlags` is still used for the
 * anthropic-profile conflict check (any flag is a conflict for
 * first-party anthropic) and for alignment fingerprinting.
 */
function hasCompleteProviderSelection(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveEnvOnlyProviderRouteId(processEnv) !== null) return true
  if (
    trimOrUndefined(processEnv.ANTHROPIC_BASE_URL) !== undefined &&
    trimOrUndefined(processEnv.ANTHROPIC_MODEL) !== undefined &&
    (trimOrUndefined(processEnv.ANTHROPIC_AUTH_TOKEN) !== undefined ||
      trimOrUndefined(processEnv.ANTHROPIC_API_KEY) !== undefined)
  ) {
    return true
  }
  if (!hasProviderSelectionFlags(processEnv)) return false
  if (processEnv.CLAUDE_CODE_USE_OPENAI !== undefined) {
    return (
      trimOrUndefined(processEnv.OPENAI_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_API_BASE) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_MODEL) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_GEMINI !== undefined) {
    return (
      trimOrUndefined(processEnv.GEMINI_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.GEMINI_MODEL) !== undefined ||
      trimOrUndefined(processEnv.GEMINI_API_KEY) !== undefined ||
      trimOrUndefined(processEnv.GOOGLE_API_KEY) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_MISTRAL !== undefined) {
    return (
      trimOrUndefined(processEnv.MISTRAL_BASE_URL) !== undefined ||
      trimOrUndefined(processEnv.MISTRAL_MODEL) !== undefined ||
      trimOrUndefined(processEnv.MISTRAL_API_KEY) !== undefined
    )
  }
  if (processEnv.CLAUDE_CODE_USE_GITHUB !== undefined) {
    return (
      trimOrUndefined(processEnv.GITHUB_ENTERPRISE_URL) !== undefined ||
      trimOrUndefined(processEnv.GITHUB_COPILOT_KEY) !== undefined ||
      trimOrUndefined(processEnv.GITHUB_TOKEN) !== undefined ||
      trimOrUndefined(processEnv.GH_TOKEN) !== undefined ||
      trimOrUndefined(processEnv.OPENAI_MODEL) !== undefined
    )
  }
  // Bedrock / Vertex / Foundry signal cloud-provider routing in env; treat
  // the flag alone as complete (these paths rely on ambient AWS/GCP creds).
  return true
}

function hasConflictingProviderFlagsForProfile(
  processEnv: NodeJS.ProcessEnv,
  profile: ProviderProfile,
): boolean {
  const { compatibilityMode } = resolveProfileCompatibility(profile.provider)

  if (compatibilityMode === 'anthropic') {
    return hasProviderSelectionFlags(processEnv)
  }

  return (
    (compatibilityMode !== 'openai' && processEnv.CLAUDE_CODE_USE_OPENAI !== undefined) ||
    (compatibilityMode !== 'gemini' && processEnv.CLAUDE_CODE_USE_GEMINI !== undefined) ||
    (compatibilityMode !== 'mistral' && processEnv.CLAUDE_CODE_USE_MISTRAL !== undefined) ||
    (!isGithubCompatibilityMode(compatibilityMode) &&
      processEnv.CLAUDE_CODE_USE_GITHUB !== undefined) ||
    (compatibilityMode !== 'bedrock' && processEnv.CLAUDE_CODE_USE_BEDROCK !== undefined) ||
    (compatibilityMode !== 'vertex' && processEnv.CLAUDE_CODE_USE_VERTEX !== undefined) ||
    processEnv.CLAUDE_CODE_USE_FOUNDRY !== undefined
  )
}

function sameOptionalEnvValue(
  left: string | undefined,
  right: string | undefined,
): boolean {
  return trimOrUndefined(left) === trimOrUndefined(right)
}

function serializeProfileContextWindows(
  modelField: string,
  maxContextLength: number,
  activeModel?: string,
): string {
  const models = parseModelList(modelField)
  const configuredModels =
    models.length > 0 ? models : [getPrimaryModel(modelField)]
  // A saved /model choice can be valid for the provider catalog without
  // being listed in profile.model. Include the model that will actually run
  // so it does not fall back to a different context limit.
  const selectedModel = trimOrUndefined(activeModel)
  const contextModels = selectedModel
    ? [...new Set([...configuredModels, selectedModel])]
    : configuredModels

  return JSON.stringify(
    Object.fromEntries(
      // Match resolveModelRuntimeLimits' query-stripped lookup key without
      // changing case, [1m] tags, or the raw model selection and its options.
      contextModels.map(model => [
        model.split('?', 1)[0]?.trim() || model,
        maxContextLength,
      ]),
    ),
  )
}

function isProcessEnvAlignedWithProfile(
  processEnv: NodeJS.ProcessEnv,
  profile: ProviderProfile,
  options?: {
    includeApiKey?: boolean
    primaryModel?: string
  },
): boolean {
  const includeApiKey = options?.includeApiKey ?? true
  const primaryModel = options?.primaryModel ?? getPrimaryModel(profile.model)
  const { compatibilityMode } = resolveProfileCompatibility(profile.provider)

  if (processEnv[PROFILE_ENV_APPLIED_FLAG] !== '1') {
    return false
  }

  if (trimOrUndefined(processEnv[PROFILE_ENV_APPLIED_ID]) !== profile.id) {
    return false
  }

  if (compatibilityMode === 'anthropic') {
    return (
      !hasProviderSelectionFlags(processEnv) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_BASE_URL, profile.baseUrl) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_MODEL, primaryModel) &&
      (!includeApiKey ||
        (profile.provider === 'custom-anthropic'
          ? sameOptionalEnvValue(processEnv.ANTHROPIC_AUTH_TOKEN, profile.apiKey)
          : sameOptionalEnvValue(processEnv.ANTHROPIC_API_KEY, profile.apiKey)))
    )
  }

  if (compatibilityMode === 'mistral') {
    return (
      processEnv.CLAUDE_CODE_USE_MISTRAL !== undefined &&
      processEnv.CLAUDE_CODE_USE_GEMINI === undefined &&
      processEnv.CLAUDE_CODE_USE_OPENAI === undefined &&
      processEnv.CLAUDE_CODE_USE_GITHUB === undefined &&
      processEnv.CLAUDE_CODE_USE_BEDROCK === undefined &&
      processEnv.CLAUDE_CODE_USE_VERTEX === undefined &&
      processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
      sameOptionalEnvValue(processEnv.MISTRAL_BASE_URL, profile.baseUrl) &&
      sameOptionalEnvValue(processEnv.MISTRAL_MODEL, primaryModel) &&
      (!includeApiKey ||
        sameOptionalEnvValue(processEnv.MISTRAL_API_KEY, profile.apiKey))
    )
  }

  if (compatibilityMode === 'gemini') {
    return (
      processEnv.CLAUDE_CODE_USE_GEMINI !== undefined &&
      processEnv.CLAUDE_CODE_USE_MISTRAL === undefined &&
      processEnv.CLAUDE_CODE_USE_OPENAI === undefined &&
      processEnv.CLAUDE_CODE_USE_GITHUB === undefined &&
      processEnv.CLAUDE_CODE_USE_BEDROCK === undefined &&
      processEnv.CLAUDE_CODE_USE_VERTEX === undefined &&
      processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
      sameOptionalEnvValue(processEnv.GEMINI_BASE_URL, profile.baseUrl) &&
      sameOptionalEnvValue(processEnv.GEMINI_MODEL, primaryModel) &&
      (!includeApiKey ||
        sameOptionalEnvValue(processEnv.GEMINI_API_KEY, profile.apiKey))
    )
  }

  if (isGithubCompatibilityMode(compatibilityMode)) {
    const expectedGheUrl =
      profile.provider === 'github-enterprise'
        ? deriveGithubEnterpriseUrl(profile.baseUrl)
        : undefined
    return (
      processEnv.CLAUDE_CODE_USE_GITHUB !== undefined &&
      processEnv.CLAUDE_CODE_USE_OPENAI === undefined &&
      processEnv.CLAUDE_CODE_USE_GEMINI === undefined &&
      processEnv.CLAUDE_CODE_USE_MISTRAL === undefined &&
      processEnv.CLAUDE_CODE_USE_BEDROCK === undefined &&
      processEnv.CLAUDE_CODE_USE_VERTEX === undefined &&
      processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
      sameOptionalEnvValue(processEnv.OPENAI_BASE_URL, profile.baseUrl) &&
      sameOptionalEnvValue(processEnv.OPENAI_MODEL, primaryModel) &&
      sameOptionalEnvValue(processEnv.GITHUB_ENTERPRISE_URL, expectedGheUrl) &&
      (profile.provider !== 'github-enterprise' ||
        !includeApiKey ||
        sameOptionalEnvValue(processEnv.GITHUB_COPILOT_KEY, profile.apiKey))
    )
  }

  if (compatibilityMode === 'bedrock') {
    return (
      processEnv.CLAUDE_CODE_USE_BEDROCK !== undefined &&
      processEnv.CLAUDE_CODE_USE_OPENAI === undefined &&
      processEnv.CLAUDE_CODE_USE_GEMINI === undefined &&
      processEnv.CLAUDE_CODE_USE_MISTRAL === undefined &&
      processEnv.CLAUDE_CODE_USE_GITHUB === undefined &&
      processEnv.CLAUDE_CODE_USE_VERTEX === undefined &&
      processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_MODEL, primaryModel) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_BEDROCK_BASE_URL, profile.baseUrl)
    )
  }

  if (compatibilityMode === 'vertex') {
    return (
      processEnv.CLAUDE_CODE_USE_VERTEX !== undefined &&
      processEnv.CLAUDE_CODE_USE_OPENAI === undefined &&
      processEnv.CLAUDE_CODE_USE_GEMINI === undefined &&
      processEnv.CLAUDE_CODE_USE_MISTRAL === undefined &&
      processEnv.CLAUDE_CODE_USE_GITHUB === undefined &&
      processEnv.CLAUDE_CODE_USE_BEDROCK === undefined &&
      processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_MODEL, primaryModel) &&
      sameOptionalEnvValue(processEnv.ANTHROPIC_VERTEX_BASE_URL, profile.baseUrl)
    )
  }

  const expectedContextWindows = profile.maxContextLength
    ? serializeProfileContextWindows(
        profile.model,
        profile.maxContextLength,
        primaryModel,
      )
    : undefined
  const isAimlapiRoute =
    profile.provider === 'aimlapi' ||
    resolveRouteIdFromBaseUrl(profile.baseUrl) === 'aimlapi'

  return (
    processEnv.CLAUDE_CODE_USE_OPENAI !== undefined &&
    processEnv.CLAUDE_CODE_USE_GEMINI === undefined &&
    processEnv.CLAUDE_CODE_USE_MISTRAL === undefined &&
    processEnv.CLAUDE_CODE_USE_GITHUB === undefined &&
    processEnv.CLAUDE_CODE_USE_BEDROCK === undefined &&
    processEnv.CLAUDE_CODE_USE_VERTEX === undefined &&
    processEnv.CLAUDE_CODE_USE_FOUNDRY === undefined &&
    sameOptionalEnvValue(processEnv.OPENAI_BASE_URL, profile.baseUrl) &&
    sameOptionalEnvValue(processEnv.OPENAI_MODEL, primaryModel) &&
    sameOptionalEnvValue(processEnv.OPENAI_API_FORMAT, profile.apiFormat) &&
    sameOptionalEnvValue(
      processEnv.OPENAI_AZURE_STYLE,
      profile.azureStyle ? '1' : undefined,
    ) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_HEADER, profile.authHeader) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_SCHEME, profile.authScheme) &&
    sameOptionalEnvValue(processEnv.OPENAI_AUTH_HEADER_VALUE, profile.authHeaderValue) &&
    sameOptionalEnvValue(
      processEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS,
      expectedContextWindows,
    ) &&
    (!includeApiKey ||
      sameOptionalEnvValue(processEnv.OPENAI_API_KEY, profile.apiKey)) &&
    (profile.baseUrl?.toLowerCase().includes('bankr')
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.BNKR_API_KEY, profile.apiKey)
      : true) &&
    (isXaiBaseUrl(profile.baseUrl)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.XAI_API_KEY, profile.apiKey)
      : true) &&
    (isAimlapiRoute
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.AIMLAPI_API_KEY, profile.apiKey)
      : true) &&
    (profile.baseUrl?.toLowerCase().includes('api.venice.ai')
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.VENICE_API_KEY, profile.apiKey)
      : true) &&
    (profile.baseUrl?.toLowerCase().includes('api.xiaomimimo.com') ||
      profile.baseUrl?.toLowerCase().includes('api.mimo-v2.com')
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.MIMO_API_KEY, profile.apiKey)
      : true) &&
    (profile.baseUrl?.toLowerCase().includes('atlascloud')
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.ATLAS_CLOUD_API_KEY, profile.apiKey)
      : true) &&
    (isApismartProfile(profile)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.APISMART_API_KEY, profile.apiKey)
      : true) &&
    (isApiRouteProfile(profile)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.API_ROUTE_API_KEY, profile.apiKey)
      : true) &&
    (isCommandcodeProfile(profile)
      ? !includeApiKey ||
        sameOptionalEnvValue(
          processEnv.CMD_API_KEY ??
            processEnv.COMMANDCODE_API_KEY ??
            processEnv.COMMAND_CODE_API_KEY,
          profile.apiKey,
        )
      : true) &&
    (isClinePassProfile(profile)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.CLINE_API_KEY, profile.apiKey)
      : true) &&
    (isNearaiBaseUrl(profile.baseUrl)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.NEARAI_API_KEY, profile.apiKey)
      : true) &&
    (isFireworksBaseUrl(profile.baseUrl)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.FIREWORKS_API_KEY, profile.apiKey)
      : true) &&
    (isLongcatBaseUrl(profile.baseUrl)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.LONGCAT_API_KEY, profile.apiKey)
      : true) &&
    (isCloudflareBaseUrl(profile.baseUrl)
      ? !includeApiKey ||
        sameOptionalEnvValue(processEnv.CLOUDFLARE_API_TOKEN, profile.apiKey)
      : true)
  )
}

/**
 * Sentinel `activeProviderProfileId` meaning "use built-in Anthropic", kept
 * distinct from `undefined`. Without it, clearing the active id falls through
 * to `profiles[0]` (see below), so a user with any saved third-party profile
 * could never return to Anthropic from `/provider` without hand-editing
 * `~/.openclaude.json` and restarting (#1426). Storing the sentinel preserves
 * the saved profiles for re-selection while expressing "no third-party active".
 */
export const ANTHROPIC_DEFAULT_PROFILE_ID = '__anthropic_default__'

export function getActiveProviderProfile(
  config = getGlobalConfig(),
): ProviderProfile | undefined {
  const profiles = getProviderProfiles(config)
  if (profiles.length === 0) {
    return undefined
  }

  const activeId = trimOrUndefined(config.activeProviderProfileId)
  // Explicit Anthropic selection: do not fall back to the first saved profile.
  if (activeId === ANTHROPIC_DEFAULT_PROFILE_ID) {
    return undefined
  }
  return profiles.find(profile => profile.id === activeId) ?? profiles[0]
}

/**
 * Switch back to built-in Anthropic while keeping saved provider profiles.
 * Clears the managed env this session (so the switch takes effect without a
 * restart), records the Anthropic sentinel as the active id (so startup no
 * longer replays a third-party profile), and removes the startup profile
 * mirror file. Returns false when there was nothing to clear.
 */
export function clearActiveProviderProfile(
  options?: ProfileFileLocation,
): boolean {
  const hadActiveProfile = getActiveProviderProfile() !== undefined

  saveGlobalConfig(config => ({
    ...config,
    activeProviderProfileId: ANTHROPIC_DEFAULT_PROFILE_ID,
    openaiAdditionalModelOptionsCache: [],
  }))

  clearProviderProfileEnvFromProcessEnv()
  deleteProfileFile(options)

  return hadActiveProfile
}

export function clearProviderProfileEnvFromProcessEnv(
  processEnv: NodeJS.ProcessEnv = process.env,
): void {
  clearManagedProfileEnv(processEnv)
  delete processEnv[PROFILE_ENV_APPLIED_FLAG]
  delete processEnv[PROFILE_ENV_APPLIED_ID]
}

export function applyProviderProfileToProcessEnv(
  profile: ProviderProfile,
  options?: { primaryModel?: string },
): void {
  const { route, compatibilityMode } = resolveProfileCompatibility(profile.provider)
  const primaryModel = options?.primaryModel ?? getPrimaryModel(profile.model)
  let profileEnv: ProfileEnv

  if (route.routeId === 'unknown-fallback') {
    // Safe fallback for unrecognised providers — OpenAI-compatible so the
    // user can still interact, but warn that the provider string was not
    // resolved to a known descriptor.
    console.warn(
      `[applyProviderProfileToProcessEnv] Unknown provider "${profile.provider}" — falling back to OpenAI-compatible env shaping.`,
    )
  }

  if (compatibilityMode === 'anthropic') {
    if (route.vendorId === 'minimax') {
      profileEnv =
        buildMiniMaxProfileEnv({
          model: primaryModel,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          processEnv: process.env,
        }) ?? {}
    } else {
      profileEnv = {
        ANTHROPIC_BASE_URL: profile.baseUrl,
        ANTHROPIC_MODEL: primaryModel,
        ...buildAnthropicCredentialEnv(profile.provider, profile.apiKey),
      }
    }
  } else if (compatibilityMode === 'mistral') {
    profileEnv = {
      MISTRAL_BASE_URL: profile.baseUrl,
      MISTRAL_MODEL: primaryModel,
      ...(profile.apiKey ? { MISTRAL_API_KEY: profile.apiKey } : {}),
    }
  } else if (compatibilityMode === 'gemini') {
    profileEnv = {
      GEMINI_BASE_URL: profile.baseUrl,
      GEMINI_MODEL: primaryModel,
      ...(profile.apiKey ? { GEMINI_API_KEY: profile.apiKey } : {}),
    }
  } else if (isGithubCompatibilityMode(compatibilityMode)) {
    profileEnv = buildGithubCompatibleProfileEnv({
      model: primaryModel,
      baseUrl: profile.baseUrl,
      gatewayId:
        profile.provider === 'github-enterprise'
          ? 'github-enterprise'
          : route.gatewayId,
      apiKey: profile.apiKey,
    })
  } else if (compatibilityMode === 'bedrock') {
    profileEnv = buildBedrockProfileEnv({
      model: primaryModel,
      baseUrl: profile.baseUrl,
    })
  } else if (compatibilityMode === 'vertex') {
    profileEnv = buildVertexProfileEnv({
      model: primaryModel,
      baseUrl: profile.baseUrl,
    })
  } else {
    const capabilityRouteId = resolveProfileCapabilityRouteId(
      profile.provider,
      profile.baseUrl,
    )
    const supportsApiFormat = routeSupportsApiFormatSelection(capabilityRouteId)
    const supportsAuthHeaders = routeSupportsAuthHeaders(capabilityRouteId)
    const normalizedProfileBaseUrl =
      route.routeId === 'xiaomi-mimo' || route.routeId === 'xiaomi-mimo-token'
        ? normalizeXiaomiMimoBaseUrl(profile.baseUrl) ?? profile.baseUrl
        : route.routeId === 'apismart' && !profile.baseUrl?.trim()
          ? getRouteDefaultBaseUrl('apismart') ?? profile.baseUrl
          : route.routeId === 'concentrate' && !profile.baseUrl?.trim()
            ? getRouteDefaultBaseUrl('concentrate') ?? profile.baseUrl
            : route.routeId === 'api-route' && !profile.baseUrl?.trim()
              ? getRouteDefaultBaseUrl('api-route') ?? profile.baseUrl
              : route.routeId === 'commandcode' && !profile.baseUrl?.trim()
                ? getRouteDefaultBaseUrl('commandcode') ?? profile.baseUrl
                : profile.baseUrl
    const openAIProfileEnv: ProfileEnv = {
      OPENAI_BASE_URL: normalizedProfileBaseUrl,
      OPENAI_MODEL: primaryModel,
    }
    const isAimlapiProfile =
      profile.provider === 'aimlapi' ||
      route.routeId === 'aimlapi' ||
      resolveRouteIdFromBaseUrl(profile.baseUrl) === 'aimlapi'
    if (supportsApiFormat && profile.apiFormat) {
      openAIProfileEnv.OPENAI_API_FORMAT = profile.apiFormat
    }
    if (profile.azureStyle) {
      openAIProfileEnv.OPENAI_AZURE_STYLE = '1'
    }
    if (supportsAuthHeaders && profile.authHeader) {
      openAIProfileEnv.OPENAI_AUTH_HEADER = profile.authHeader
      openAIProfileEnv.OPENAI_AUTH_SCHEME =
        profile.authScheme ??
        (profile.authHeader.toLowerCase() === 'authorization'
          ? 'bearer'
          : 'raw')
      if (profile.authHeaderValue) {
        openAIProfileEnv.OPENAI_AUTH_HEADER_VALUE = profile.authHeaderValue
      }
    }

    const withholdRetargetedApismartCredential =
      route.routeId === 'apismart' && !isApismartProfile(profile)
    const withholdRetargetedConcentrateCredential =
      route.routeId === 'concentrate' && !isConcentrateProfile(profile)
    const withholdRetargetedApiRouteCredential =
      route.routeId === 'api-route' && !isApiRouteProfile(profile)
    const withholdRetargetedLlmtrCredential =
      route.routeId === 'llmtr' && !isLlmtrProfile(profile)
    const withholdRetargetedCommandcodeCredential =
      route.routeId === 'commandcode' && !isCommandcodeProfile(profile)
    if (
      profile.apiKey &&
      !withholdRetargetedApismartCredential &&
      !withholdRetargetedConcentrateCredential &&
      !withholdRetargetedApiRouteCredential &&
      !withholdRetargetedLlmtrCredential &&
      !withholdRetargetedCommandcodeCredential
    ) {
      openAIProfileEnv.OPENAI_API_KEY = profile.apiKey
      if (route.vendorId === 'minimax' || normalizedProfileBaseUrl.toLowerCase().includes('minimax')) {
        openAIProfileEnv.MINIMAX_API_KEY = profile.apiKey
      }
      if (
        route.gatewayId === 'nvidia-nim' ||
        normalizedProfileBaseUrl.toLowerCase().includes('nvidia') ||
        normalizedProfileBaseUrl.toLowerCase().includes('integrate.api.nvidia')
      ) {
        openAIProfileEnv.NVIDIA_API_KEY = profile.apiKey
      }
      if (route.routeId === 'bankr' || normalizedProfileBaseUrl.toLowerCase().includes('bankr')) {
        openAIProfileEnv.BNKR_API_KEY = profile.apiKey
      }
      if (route.routeId === 'xai' || isXaiBaseUrl(profile.baseUrl)) {
        openAIProfileEnv.XAI_API_KEY = profile.apiKey
      }
      if (isAimlapiProfile) {
        openAIProfileEnv.AIMLAPI_API_KEY = profile.apiKey
      }
      if (route.routeId === 'venice' || normalizedProfileBaseUrl.toLowerCase().includes('api.venice.ai')) {
        openAIProfileEnv.VENICE_API_KEY = profile.apiKey
      }
      if (
        route.routeId === 'xiaomi-mimo' ||
        route.routeId === 'xiaomi-mimo-token' ||
        isXiaomiMimoBaseUrl(profile.baseUrl)
      ) {
        openAIProfileEnv.MIMO_API_KEY = profile.apiKey
      }
      if (route.routeId === 'atlas-cloud' || normalizedProfileBaseUrl.toLowerCase().includes('atlascloud')) {
        openAIProfileEnv.ATLAS_CLOUD_API_KEY = profile.apiKey
      }
      if (isApismartProfile(profile)) {
        openAIProfileEnv.APISMART_API_KEY = profile.apiKey
      }
      if (isConcentrateProfile(profile)) {
        openAIProfileEnv.CONCENTRATE_API_KEY = profile.apiKey
      }
      if (isApiRouteProfile(profile)) {
        openAIProfileEnv.API_ROUTE_API_KEY = profile.apiKey
      }
      if (isCommandcodeProfile(profile)) {
        openAIProfileEnv.CMD_API_KEY = profile.apiKey
      }
      if (isClinePassProfile(profile)) {
        openAIProfileEnv.CLINE_API_KEY = profile.apiKey
      }
      if (route.routeId === 'nearai' || isNearaiBaseUrl(profile.baseUrl)) {
        openAIProfileEnv.NEARAI_API_KEY = profile.apiKey
      }
      if (route.routeId === 'fireworks' || isFireworksBaseUrl(profile.baseUrl)) {
        openAIProfileEnv.FIREWORKS_API_KEY = profile.apiKey
      }
      if (isLongcatBaseUrl(profile.baseUrl)) {
        openAIProfileEnv.LONGCAT_API_KEY = profile.apiKey
      }
      // Gate on the Workers AI path predicate (isCloudflareBaseUrl: exact
      // api.cloudflare.com host AND the `/client/v4/accounts/<id>/ai/v1` path),
      // not the saved route id and not the host alone. A cloudflare profile
      // retargeted to the shared gateway.ai.cloudflare.com AI Gateway host, or
      // to a non-Workers api.cloudflare.com REST path, keeps
      // routeId === 'cloudflare' yet is not a Workers AI endpoint — mirroring
      // CLOUDFLARE_API_TOKEN on the route id (or on host alone) would leak the
      // token to it. The sibling sites (isProcessEnvAlignedWithProfile,
      // buildOpenAICompatibleStartupEnv) key on the same isCloudflareBaseUrl
      // path predicate.
      if (isCloudflareBaseUrl(profile.baseUrl)) {
        openAIProfileEnv.CLOUDFLARE_API_TOKEN = profile.apiKey
      }
    }
    if (isAimlapiProfile) {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
      // The ambient AIMLAPI_API_KEY is the canonical aimlapi.com credential.
      // Only forward it when the profile targets the canonical inference host;
      // a keyless `aimlapi` profile can point at a user-controlled proxy, and
      // injecting the credential there would leak it. This mirrors the
      // guided-flow validation, which also gates on the canonical URL. A missing
      // base URL resolves to the aimlapi default (which is canonical), so treat
      // it as canonical rather than passing undefined into the string helper.
      if (!profile.baseUrl || isCanonicalAimlapiInferenceBaseUrl(profile.baseUrl)) {
        const ambientAimlapiKey =
          trimOrUndefined(process.env.AIMLAPI_API_KEY) ??
          trimOrUndefined(process.env.OPENAI_API_KEY)
        openAIProfileEnv.OPENAI_API_KEY =
          openAIProfileEnv.OPENAI_API_KEY ?? ambientAimlapiKey
        openAIProfileEnv.AIMLAPI_API_KEY =
          openAIProfileEnv.AIMLAPI_API_KEY ?? ambientAimlapiKey
      }
    }
    // Preserve the selected Ollama route even when the profile points at a
    // reverse proxy whose URL has no Ollama-specific hostname or port. Web
    // search discovery uses this marker to distinguish that endpoint from a
    // generic OpenAI-compatible profile.
    if (route.routeId === 'ollama') {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
    }
    // Keep ApiSmart route identity even when the profile is retargeted to a
    // proxy. Dedicated credentials stay withheld above; the route id is what
    // lets buildLaunchEnv refuse ambient APISMART_API_KEY / mirrored
    // OPENAI_API_KEY on relaunch (AIMLAPI parity).
    if (route.routeId === 'apismart') {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'apismart'
      // Keyless canonical ApiSmart profiles resolve ambient dedicated
      // credentials the same way AIMLAPI does. Proxy / non-canonical hosts
      // must not receive the ambient key.
      if (isApismartProfile(profile)) {
        const ambientApismartKey = sanitizeApiKey(process.env.APISMART_API_KEY)
        if (ambientApismartKey) {
          openAIProfileEnv.OPENAI_API_KEY =
            openAIProfileEnv.OPENAI_API_KEY ?? ambientApismartKey
          openAIProfileEnv.APISMART_API_KEY =
            openAIProfileEnv.APISMART_API_KEY ?? ambientApismartKey
        }
      }
    }
    // Stamp dedicated Concentrate profile identity and mirror its credential so
    // the saved profile relaunches authenticated.
    if (route.routeId === 'concentrate') {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'concentrate'
      // Keyless canonical Concentrate profiles may resolve the ambient dedicated
      // credential the same way ApiSmart does.
      if (isConcentrateProfile(profile) && !profile.apiKey) {
        const ambientConcentrateKey = sanitizeApiKey(
          process.env.CONCENTRATE_API_KEY,
        )
        if (ambientConcentrateKey) {
          openAIProfileEnv.OPENAI_API_KEY =
            openAIProfileEnv.OPENAI_API_KEY ?? ambientConcentrateKey
          openAIProfileEnv.CONCENTRATE_API_KEY = ambientConcentrateKey
        }
      }
    }
    if (route.routeId === 'api-route') {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'api-route'
      if (isApiRouteProfile(profile) && !profile.apiKey) {
        const ambientApiRouteKey = sanitizeApiKey(process.env.API_ROUTE_API_KEY)
        if (ambientApiRouteKey) {
          openAIProfileEnv.OPENAI_API_KEY =
            openAIProfileEnv.OPENAI_API_KEY ?? ambientApiRouteKey
          openAIProfileEnv.API_ROUTE_API_KEY = ambientApiRouteKey
        }
      }
    }
    // A keyless canonical LLMTR profile may use the dedicated credential from
    // the ambient environment. Profile application clears all managed provider
    // variables before installing this object, so adopt it here while the
    // canonical endpoint boundary is still known. Never carry it to a
    // retargeted profile.
    if (route.routeId === 'llmtr') {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'llmtr'
      if (isLlmtrProfile(profile) && !profile.apiKey) {
        const ambientLlmtrKey = sanitizeApiKey(process.env.LLMTR_API_KEY)
        if (ambientLlmtrKey) {
          openAIProfileEnv.OPENAI_API_KEY =
            openAIProfileEnv.OPENAI_API_KEY ?? ambientLlmtrKey
          openAIProfileEnv.LLMTR_API_KEY = ambientLlmtrKey
        }
      }
    }
    if (isCommandcodeProfile(profile)) {
      openAIProfileEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'commandcode'
      if (!profile.apiKey) {
        const ambientCommandcodeKey =
          sanitizeApiKey(process.env.CMD_API_KEY) ||
          sanitizeApiKey(process.env.COMMANDCODE_API_KEY) ||
          sanitizeApiKey(process.env.COMMAND_CODE_API_KEY)
        if (ambientCommandcodeKey) {
          openAIProfileEnv.OPENAI_API_KEY =
            openAIProfileEnv.OPENAI_API_KEY ?? ambientCommandcodeKey
          openAIProfileEnv.CMD_API_KEY = ambientCommandcodeKey
        }
      }
    }
    if (route.gatewayId === 'nvidia-nim') {
      openAIProfileEnv.NVIDIA_NIM = '1'
    }
    if (profile.maxContextLength) {
      openAIProfileEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS =
        serializeProfileContextWindows(
          profile.model,
          profile.maxContextLength,
          primaryModel,
        )
    }

    profileEnv = openAIProfileEnv
  }

  profileEnv = applySupportedProfileCustomHeaders(profile, profileEnv)

  const nextEnv = buildCompatibilityProcessEnv({
    processEnv: process.env,
    compatibilityMode,
    profileEnv,
  })

  clearProviderProfileEnvFromProcessEnv()
  Object.assign(process.env, nextEnv)
  process.env[PROFILE_ENV_APPLIED_FLAG] = '1'
  process.env[PROFILE_ENV_APPLIED_ID] = profile.id
}

export function applyActiveProviderProfileFromConfig(
  config = getGlobalConfig(),
  options?: {
    processEnv?: NodeJS.ProcessEnv
    force?: boolean
  },
): ProviderProfile | undefined {
  const processEnv = options?.processEnv ?? process.env

  // Built-in Anthropic is an explicit active state recorded as the sentinel,
  // not "no active profile". getActiveProviderProfile() resolves the sentinel
  // to undefined, so without this guard we would return below without marking
  // provider env as handled; buildStartupEnvFromProfile() then treats the
  // profile mirror that clearActiveProviderProfile() deleted as a fresh install
  // and synthesizes the default Twigpine OpenGateway env, bouncing the user off
  // built-in Anthropic on the next launch (#1429). Clear any managed provider
  // env and set the applied flag so the legacy/fresh-install fallback is
  // suppressed. An explicit startup provider selection still wins for the
  // current session, matching the saved-profile branch below.
  if (
    trimOrUndefined(config.activeProviderProfileId) === ANTHROPIC_DEFAULT_PROFILE_ID
  ) {
    if (!options?.force && hasCompleteProviderSelection(processEnv)) {
      return undefined
    }
    clearProviderProfileEnvFromProcessEnv(processEnv)
    processEnv[PROFILE_ENV_APPLIED_FLAG] = '1'
    return undefined
  }

  const activeProfile = getActiveProviderProfile(config)
  if (!activeProfile) {
    return undefined
  }

  const isCurrentEnvProfileManaged =
    processEnv[PROFILE_ENV_APPLIED_FLAG] === '1' &&
    trimOrUndefined(processEnv[PROFILE_ENV_APPLIED_ID]) === activeProfile.id

  if (!options?.force && (hasCompleteProviderSelection(processEnv) || processEnv[PROFILE_ENV_APPLIED_FLAG] === '1')) {
    // Respect explicit startup provider intent. Auto-heal only when this
    // exact active profile previously applied the current env.
    // NOTE: we gate on hasCompleteProviderSelection (flag + concrete config)
    // rather than hasProviderSelectionFlags alone. A bare CLAUDE_CODE_USE_*=1
    // with no BASE_URL/MODEL is almost always a stale shell export, not
    // intent — respecting it would skip the saved profile and fall through
    // to hardcoded provider defaults, which surfaces as "my saved provider
    // isn't being picked up at startup".
    if (!isCurrentEnvProfileManaged) {
      return undefined
    }

    if (hasConflictingProviderFlagsForProfile(processEnv, activeProfile)) {
      return undefined
    }

    const savedPrimaryModel = getSavedModelOverrideForProfile(activeProfile)
    if (
      isProcessEnvAlignedWithProfile(processEnv, activeProfile, {
        primaryModel: savedPrimaryModel,
      })
    ) {
      return activeProfile
    }
  }

  const savedPrimaryModel = getSavedModelOverrideForProfile(activeProfile)
  applyProviderProfileToProcessEnv(activeProfile, {
    primaryModel: savedPrimaryModel,
  })
  return activeProfile
}

export function addProviderProfile(
  input: ProviderProfileInput,
  options?: { makeActive?: boolean } & ProviderProfileWriteOptions,
): ProviderProfile | null {
  const profile = toProfile(input, undefined, options)
  if (!profile) {
    return null
  }

  const makeActive = options?.makeActive ?? true

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const nextProfiles = [...currentProfiles, profile]
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    // Resolve the *effective* active id the same way getActiveProviderProfile
    // does, so adding a profile with makeActive:false preserves whatever is
    // actually active now rather than silently switching the user (#1426):
    //   - Anthropic sentinel               -> built-in Anthropic (keep sentinel)
    //   - explicit id for a saved profile  -> that profile
    //   - stale or unset id with profiles  -> implicit first profile
    //   - no saved profiles                -> nothing active yet
    // The stale-id case matters: getActiveProviderProfile() falls back to
    // profiles[0] for an id whose profile was deleted, so makeActive:false must
    // keep profiles[0] and not promote the newly added profile.
    let effectiveActiveId: string | undefined
    if (currentActive === ANTHROPIC_DEFAULT_PROFILE_ID) {
      effectiveActiveId = ANTHROPIC_DEFAULT_PROFILE_ID
    } else if (currentActive && currentProfiles.some(p => p.id === currentActive)) {
      effectiveActiveId = currentActive
    } else if (currentProfiles.length > 0) {
      effectiveActiveId = currentProfiles[0].id
    } else {
      effectiveActiveId = undefined
    }
    const nextActiveId =
      makeActive || effectiveActiveId === undefined ? profile.id : effectiveActiveId

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
    }
  })

  const activeProfile = getActiveProviderProfile()
  if (activeProfile?.id === profile.id) {
    setActiveProviderProfile(profile.id)
    clearActiveOpenAIModelOptionsCache()
  }

  return profile
}

export function updateProviderProfile(
  profileId: string,
  input: ProviderProfileInput,
  options?: ProviderProfileWriteOptions,
): ProviderProfile | null {
  const updatedProfile = toProfile(input, profileId, options)
  if (!updatedProfile) {
    return null
  }

  let wasUpdated = false
  let shouldApply = false

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const profileIndex = currentProfiles.findIndex(
      profile => profile.id === profileId,
    )

    if (profileIndex < 0) {
      return current
    }

    wasUpdated = true

    const nextProfiles = [...currentProfiles]
    nextProfiles[profileIndex] = updatedProfile

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    // Updating any profile must not reactivate profiles[0] when the user is on
    // built-in Anthropic — the sentinel is a valid active state to preserve.
    const nextActiveId =
      currentActive &&
      (currentActive === ANTHROPIC_DEFAULT_PROFILE_ID ||
        nextProfiles.some(profile => profile.id === currentActive))
        ? currentActive
        : nextProfiles[0]?.id

    shouldApply = nextActiveId === profileId

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: shouldApply
        ? []
        : current.openaiAdditionalModelOptionsCache,
    }
  })

  if (!wasUpdated) {
    return null
  }

  if (shouldApply) {
    setActiveProviderProfile(profileId)
  }

  return updatedProfile
}

export function persistActiveProviderProfileModel(
  model: string,
): ProviderProfile | null {
  const nextModel = trimOrUndefined(model)
  if (!nextModel) {
    return null
  }

  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) {
    return null
  }

  // Runtime model selection is a session-level choice handled by
  // mainLoopModelOverride (see src/hooks/useMainLoopModel.ts), not a
  // profile edit. Whether the chosen model is already part of the
  // profile's list or not, do NOT mutate profile.model here:
  //   - if it IS in the list, the list is already correct (no-op)
  //   - if it ISN'T, the user picked an out-of-list model for the
  //     session and the profile's list should only change via an
  //     explicit provider edit, not by side-effect of /model.
  // An earlier implementation prepended out-of-list models to the
  // profile, which (a) contradicted this contract, (b) caused
  // unbounded list growth on rotation, and (c) used a separator
  // inferred from a single-character substring of the model field
  // that broke on mixed-separator inputs.
  return activeProfile
}

export function getConfiguredProfileModelOptions(
  profile: ProviderProfile,
): ModelOption[] {
  return parseModelList(profile.model).map(model => ({
    value: model,
    label: model,
    description: `Provider: ${profile.name}`,
  }))
}

/**
 * Generate model options from a provider profile's model field.
 * Each parsed model becomes a separate option in the picker, then any
 * discovered OpenAI-compatible models cached for the same profile are
 * appended without duplicates.
 */
export function getProfileModelOptions(
  profile: ProviderProfile,
  config = getGlobalConfig(),
): ModelOption[] {
  const configuredOptions = getConfiguredProfileModelOptions(profile)
  return mergeModelOptionsByValue(
    configuredOptions,
    getModelCacheByProfile(profile.id, config),
  )
}

function buildOpenAICompatibleStartupEnv(
  activeProfile: ProviderProfile,
): ProfileEnv | null {
  if (isCodexBaseUrl(activeProfile.baseUrl)) {
    return null
  }
  const activeProfileRouteId = resolveProfileRoute(activeProfile.provider).routeId
  const normalizedBaseUrl =
    activeProfileRouteId === 'api-route' && !activeProfile.baseUrl?.trim()
      ? getRouteDefaultBaseUrl('api-route') ?? activeProfile.baseUrl
      : activeProfile.baseUrl
  const withholdRetargetedApismartCredential =
    activeProfileRouteId === 'apismart' &&
    !isApismartProfile(activeProfile)
  const withholdRetargetedConcentrateCredential =
    activeProfileRouteId === 'concentrate' &&
    !isConcentrateProfile(activeProfile)
  const withholdRetargetedApiRouteCredential =
    activeProfileRouteId === 'api-route' && !isApiRouteProfile(activeProfile)
  const withholdRetargetedLlmtrCredential =
    activeProfileRouteId === 'llmtr' && !isLlmtrProfile(activeProfile)
  const withholdRetargetedCommandcodeCredential =
    activeProfileRouteId === 'commandcode' &&
    !isCommandcodeProfile(activeProfile)
  const isAimlapiProfile =
    activeProfile.provider === 'aimlapi' ||
    resolveRouteIdFromBaseUrl(activeProfile.baseUrl) === 'aimlapi'
  const isConcentrateProfileFlag = isConcentrateProfile(activeProfile)
  const isApiRouteProfileFlag = isApiRouteProfile(activeProfile)
  const isLlmtrProfileFlag = isLlmtrProfile(activeProfile)
  const isCommandcodeProfileFlag = isCommandcodeProfile(activeProfile)

  if (
    activeProfile.apiKey &&
    !withholdRetargetedApismartCredential &&
    !withholdRetargetedConcentrateCredential &&
    !withholdRetargetedApiRouteCredential &&
    !withholdRetargetedLlmtrCredential &&
    !withholdRetargetedCommandcodeCredential
  ) {
    const strictEnv = buildOpenAIProfileEnv({
      goal: 'balanced',
      model: activeProfile.model,
      baseUrl: normalizedBaseUrl,
      apiKey: activeProfile.apiKey,
      apiFormat: activeProfile.apiFormat,
      azureStyle: activeProfile.azureStyle ? '1' : undefined,
      authHeader: activeProfile.authHeader,
      authScheme: activeProfile.authScheme,
      authHeaderValue: activeProfile.authHeaderValue,
      maxContextLength: activeProfile.maxContextLength,
      processEnv: {},
    })
    if (strictEnv) {
      if (activeProfile.maxContextLength) {
        strictEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS =
          serializeProfileContextWindows(
            activeProfile.model,
            activeProfile.maxContextLength,
          )
      }
      if (isAimlapiProfile) {
        strictEnv.AIMLAPI_API_KEY = activeProfile.apiKey
        strictEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
      }
      if (activeProfileRouteId === 'ollama') {
        strictEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
      }
      // Atlas Cloud is dedicatedCredentialsOnly: its route ignores
      // OPENAI_API_KEY, so a generic OpenAI profile pointed at Atlas must
      // persist the dedicated key too or it relaunches unauthenticated.
      if (activeProfile.baseUrl?.toLowerCase().includes('atlascloud')) {
        strictEnv.ATLAS_CLOUD_API_KEY = activeProfile.apiKey
      }
      if (isApismartProfile(activeProfile)) {
        strictEnv.APISMART_API_KEY = activeProfile.apiKey
      }
      if (isConcentrateProfileFlag) {
        strictEnv.CONCENTRATE_API_KEY = activeProfile.apiKey
      }
      if (isApiRouteProfileFlag) {
        strictEnv.API_ROUTE_API_KEY = activeProfile.apiKey
        strictEnv.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'api-route'
      }
      if (isLlmtrProfileFlag) {
        strictEnv.LLMTR_API_KEY = activeProfile.apiKey
      }
      if (isCommandcodeProfileFlag) {
        strictEnv.CMD_API_KEY = activeProfile.apiKey
      }
      if (isClinePassProfile(activeProfile)) {
        strictEnv.CLINE_API_KEY = activeProfile.apiKey
      }
      if (isNearaiBaseUrl(activeProfile.baseUrl)) {
        strictEnv.NEARAI_API_KEY = activeProfile.apiKey
      }
      if (isFireworksBaseUrl(activeProfile.baseUrl)) {
        strictEnv.FIREWORKS_API_KEY = activeProfile.apiKey
      }
      if (isLongcatBaseUrl(activeProfile.baseUrl)) {
        strictEnv.LONGCAT_API_KEY = activeProfile.apiKey
      }
      // Cloudflare's transport reads the dedicated CLOUDFLARE_API_TOKEN; mirror
      // it like nearai/fireworks, but only when the base URL is a real Workers
      // AI endpoint per the isCloudflareBaseUrl path predicate (exact
      // api.cloudflare.com host AND the `/client/v4/accounts/<id>/ai/v1` path),
      // so a keyed Cloudflare profile's persisted startup env stays consistent
      // and re-detects correctly after relaunch without persisting the token
      // for a non-Workers api.cloudflare.com path or the shared AI Gateway host.
      if (isCloudflareBaseUrl(activeProfile.baseUrl)) {
        strictEnv.CLOUDFLARE_API_TOKEN = activeProfile.apiKey
      }
      return applySupportedProfileCustomHeaders(activeProfile, strictEnv)
    }
  }

  const env: ProfileEnv = {
    OPENAI_BASE_URL: normalizedBaseUrl,
    OPENAI_MODEL: getPrimaryModel(activeProfile.model),
    ...(activeProfile.apiFormat ? { OPENAI_API_FORMAT: activeProfile.apiFormat } : {}),
    ...(activeProfile.azureStyle ? { OPENAI_AZURE_STYLE: '1' } : {}),
    ...(activeProfile.authHeader ? { OPENAI_AUTH_HEADER: activeProfile.authHeader } : {}),
    ...(activeProfile.authScheme ? { OPENAI_AUTH_SCHEME: activeProfile.authScheme } : {}),
    ...(activeProfile.authHeaderValue ? { OPENAI_AUTH_HEADER_VALUE: activeProfile.authHeaderValue } : {}),
    ...(activeProfile.maxContextLength
      ? {
          CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS: serializeProfileContextWindows(
            activeProfile.model,
            activeProfile.maxContextLength,
          ),
        }
      : {}),
  }

  if (isAimlapiProfile) {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'aimlapi'
  }
  if (activeProfileRouteId === 'ollama') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'ollama'
  }
  // Preserve ApiSmart identity on retargeted/proxy startup envs so relaunch
  // withholding can refuse ambient dedicated credentials. Canonical profiles
  // already stamp this via buildApismartProfileEnv.
  if (activeProfileRouteId === 'apismart') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'apismart'
  }
  // Preserve Concentrate identity for retargeted profiles too, so a later
  // launch can apply the same dedicated-credential boundary.
  if (activeProfileRouteId === 'concentrate') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'concentrate'
  }
  if (activeProfileRouteId === 'api-route') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'api-route'
  }
  if (activeProfileRouteId === 'llmtr') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'llmtr'
  }
  if (activeProfileRouteId === 'commandcode') {
    env.CLAUDE_CODE_PROVIDER_ROUTE_ID = 'commandcode'
  }
  if (
    activeProfile.apiKey &&
    !withholdRetargetedApismartCredential &&
    !withholdRetargetedConcentrateCredential &&
    !withholdRetargetedApiRouteCredential &&
    !withholdRetargetedLlmtrCredential &&
    !withholdRetargetedCommandcodeCredential
  ) {
    env.OPENAI_API_KEY = activeProfile.apiKey
    if (activeProfile.baseUrl?.toLowerCase().includes('bankr')) {
      env.BNKR_API_KEY = activeProfile.apiKey
    }
    if (isXaiBaseUrl(activeProfile.baseUrl)) {
      env.XAI_API_KEY = activeProfile.apiKey
    }
    if (isAimlapiProfile) {
      env.AIMLAPI_API_KEY = activeProfile.apiKey
    }
    if (activeProfile.baseUrl?.toLowerCase().includes('api.venice.ai')) {
      env.VENICE_API_KEY = activeProfile.apiKey
    }
    if (
      activeProfile.baseUrl?.toLowerCase().includes('api.xiaomimimo.com') ||
      activeProfile.baseUrl?.toLowerCase().includes('api.mimo-v2.com')
    ) {
      env.MIMO_API_KEY = activeProfile.apiKey
    }
    if (activeProfile.baseUrl?.toLowerCase().includes('atlascloud')) {
      env.ATLAS_CLOUD_API_KEY = activeProfile.apiKey
    }
    if (isApismartProfile(activeProfile)) {
      env.APISMART_API_KEY = activeProfile.apiKey
    }
    if (isConcentrateProfileFlag) {
      env.CONCENTRATE_API_KEY = activeProfile.apiKey
    }
    if (isApiRouteProfileFlag) {
      env.API_ROUTE_API_KEY = activeProfile.apiKey
    }
    if (isLlmtrProfileFlag) {
      env.LLMTR_API_KEY = activeProfile.apiKey
    }
    if (isCommandcodeProfileFlag) {
      env.CMD_API_KEY = activeProfile.apiKey
    }
    if (isClinePassProfile(activeProfile)) {
      env.CLINE_API_KEY = activeProfile.apiKey
    }
    if (isNearaiBaseUrl(activeProfile.baseUrl)) {
      env.NEARAI_API_KEY = activeProfile.apiKey
    }
    if (isFireworksBaseUrl(activeProfile.baseUrl)) {
      env.FIREWORKS_API_KEY = activeProfile.apiKey
    }
    if (isLongcatBaseUrl(activeProfile.baseUrl)) {
      env.LONGCAT_API_KEY = activeProfile.apiKey
    }
    // Cloudflare Workers AI authenticates over the generic OpenAI-compatible
    // header, so mirror the saved key into CLOUDFLARE_API_TOKEN only when the
    // endpoint is the real Workers AI route: api.cloudflare.com with the
    // /client/v4/accounts/<id>/ai/v1 path over HTTPS (isCloudflareBaseUrl).
    // Non-Workers api.cloudflare.com paths and the shared AI Gateway host
    // (gateway.ai.cloudflare.com) are excluded — they proxy arbitrary
    // providers (#1100 review).
    if (isCloudflareBaseUrl(activeProfile.baseUrl)) {
      env.CLOUDFLARE_API_TOKEN = activeProfile.apiKey
    }
  } else if (isApiRouteProfileFlag) {
    const ambientApiRouteKey = sanitizeApiKey(process.env.API_ROUTE_API_KEY)
    if (ambientApiRouteKey) {
      env.OPENAI_API_KEY = ambientApiRouteKey
      env.API_ROUTE_API_KEY = ambientApiRouteKey
    }
  } else {
    delete env.OPENAI_API_KEY
  }
  return applySupportedProfileCustomHeaders(activeProfile, env)
}

function buildStartupProfileFromActiveProfile(
  activeProfile: ProviderProfile,
): {
  profile: ProviderProfileStartup
  env: ProfileEnv
} | null {
  const { route, compatibilityMode } = resolveProfileCompatibility(activeProfile.provider)

  switch (compatibilityMode) {
    case 'anthropic':
      if (route.vendorId === 'minimax') {
        const env =
          buildMiniMaxProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'minimax', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }
      return {
        profile: 'anthropic',
        env: applySupportedProfileCustomHeaders(activeProfile, {
          ANTHROPIC_BASE_URL: activeProfile.baseUrl,
          ANTHROPIC_MODEL: getPrimaryModel(activeProfile.model),
          ...buildAnthropicCredentialEnv(
            activeProfile.provider,
            activeProfile.apiKey,
          ),
        }),
      }
    case 'gemini': {
      const env =
        buildGeminiProfileEnv({
          model: getPrimaryModel(activeProfile.model),
          baseUrl: activeProfile.baseUrl,
          apiKey: activeProfile.apiKey,
          authMode: 'api-key',
          processEnv: process.env,
        }) ?? null
      return env
        ? { profile: 'gemini', env: applySupportedProfileCustomHeaders(activeProfile, env) }
        : null
    }
    case 'mistral': {
      const env =
        buildMistralProfileEnv({
          model: getPrimaryModel(activeProfile.model),
          baseUrl: activeProfile.baseUrl,
          apiKey: activeProfile.apiKey,
          processEnv: process.env,
        }) ?? null
      return env
        ? { profile: 'mistral', env: applySupportedProfileCustomHeaders(activeProfile, env) }
        : null
    }
    case 'github':
    case 'github-enterprise': {
      return {
        profile:
          activeProfile.provider === 'github-enterprise'
            ? 'github-enterprise'
            : 'github',
        env: applySupportedProfileCustomHeaders(
          activeProfile,
          buildGithubCompatibleProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            gatewayId:
              activeProfile.provider === 'github-enterprise'
                ? 'github-enterprise'
                : 'github',
          }),
        ),
      }
    }
    case 'bedrock':
      return {
        profile: 'bedrock',
        env: applySupportedProfileCustomHeaders(activeProfile, buildBedrockProfileEnv({
          model: getPrimaryModel(activeProfile.model),
          baseUrl: activeProfile.baseUrl,
        })),
      }
    case 'vertex':
      return {
        profile: 'vertex',
        env: applySupportedProfileCustomHeaders(activeProfile, buildVertexProfileEnv({
          model: getPrimaryModel(activeProfile.model),
          baseUrl: activeProfile.baseUrl,
        })),
      }
    case 'openai': {
      if (route.gatewayId === 'nvidia-nim') {
        const env =
          buildNvidiaNimProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'nvidia-nim', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.vendorId === 'minimax') {
        const env =
          buildMiniMaxProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'minimax', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.vendorId === 'venice') {
        const env =
          buildVeniceProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'openai', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.vendorId === 'xiaomi-mimo') {
        const env =
          buildXiaomiMimoProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'openai', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.routeId === 'atlas-cloud') {
        const env =
          buildAtlasCloudProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'openai', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.routeId === 'apismart' && isApismartProfile(activeProfile)) {
        const env =
          buildApismartProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'openai', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.routeId === 'concentrate' && isConcentrateProfile(activeProfile)) {
        const env =
          buildConcentrateProfileEnv({
            model: getPrimaryModel(activeProfile.model),
            baseUrl: activeProfile.baseUrl,
            apiKey: activeProfile.apiKey,
            processEnv: process.env,
          }) ?? null
        return env
          ? { profile: 'openai', env: applySupportedProfileCustomHeaders(activeProfile, env) }
          : null
      }

      if (route.vendorId === 'nearai') {
        const env = buildOpenAICompatibleStartupEnv(activeProfile)
        return env ? { profile: 'openai', env } : null
      }

      // xAI OAuth profile (provider=xai with no API key). Tag the startup
      // file with profile='xai' + XAI_CREDENTIAL_SOURCE=oauth so:
      //   1. validation accepts it at startup (no spurious
      //      "XAI_API_KEY is required" before openaiShim resolves the
      //      stored OAuth token)
      //   2. `clearPersistedXaiOAuthProfile()` can identify and remove it
      //      on logout, instead of leaving a stale openai-shaped file
      //      pointing at api.x.ai with no credential.
      if (route.vendorId === 'xai' && !activeProfile.apiKey) {
        const env = applySupportedProfileCustomHeaders(activeProfile, {
          ...buildXaiOAuthProfileEnv({
            model: getPrimaryModel(activeProfile.model),
          }),
          OPENAI_BASE_URL: activeProfile.baseUrl,
        })
        return { profile: 'xai', env }
      }

      const env = buildOpenAICompatibleStartupEnv(activeProfile)
      return env ? { profile: 'openai', env } : null
    }
  }
}

function triggerStartupDiscoveryRefreshForProfile(
  profile: ProviderProfile,
): void {
  const route = resolveProfileRoute(profile.provider)
  if (route.routeId === 'unknown-fallback') {
    return
  }
  if (route.routeId === 'apismart' && !isApismartProfile(profile)) {
    return
  }
  if (route.routeId === 'api-route' && !isApiRouteProfile(profile)) {
    return
  }
  if (route.routeId === 'llmtr' && !isLlmtrProfile(profile)) {
    return
  }
  if (route.routeId === 'commandcode' && !isCommandcodeProfile(profile)) {
    return
  }

  void refreshStartupDiscoveryForRoute(route.routeId, {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    headers: sanitizeProfileCustomHeaders(profile.customHeaders),
  }).catch(error => {
    const detail = error instanceof Error ? error.message : String(error)
    logForDebugging(
      `[providerProfiles] Startup discovery refresh failed for ${route.routeId}: ${detail}`,
    )
  })
}

export function setActiveProviderProfile(
  profileId: string,
  options?: ProfileFileLocation,
): ProviderProfile | null {
  const current = getGlobalConfig()
  const profiles = getProviderProfiles(current)
  const activeProfile = profiles.find(profile => profile.id === profileId)

  if (!activeProfile) {
    return null
  }

  const profileModelOptions = getProfileModelOptions(activeProfile, current)

  saveGlobalConfig(config => ({
    ...config,
    activeProviderProfileId: profileId,
    openaiAdditionalModelOptionsCache: profileModelOptions,
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(config.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [profileId]: profileModelOptions,
    },
  }))

  applyProviderProfileToProcessEnv(activeProfile)
  triggerStartupDiscoveryRefreshForProfile(activeProfile)

  // Keep startup persisted provider profile in sync so initial startup
  // uses the selected provider/model.
  const startupProfile = buildStartupProfileFromActiveProfile(activeProfile)

  if (startupProfile) {
    const file = createProfileFile(startupProfile.profile, startupProfile.env)
    saveProfileFile(file, options)
  }

  return activeProfile
}

export function deleteProviderProfile(profileId: string): {
  removed: boolean
  activeProfileId?: string
} {
  let removed = false
  let deletedProfile: ProviderProfile | undefined
  let nextActiveProfile: ProviderProfile | undefined
  let activeProfileWasDeleted = false

  saveGlobalConfig(current => {
    const currentProfiles = getProviderProfiles(current)
    const existing = currentProfiles.find(profile => profile.id === profileId)

    if (!existing) {
      return current
    }

    removed = true
    deletedProfile = existing

    const nextProfiles = currentProfiles.filter(profile => profile.id !== profileId)
    const currentActive = trimOrUndefined(current.activeProviderProfileId)
    // The Anthropic sentinel survives deletion of any other profile — deleting
    // an inactive saved profile must not knock a built-in-Anthropic user back
    // onto profiles[0] (#1426).
    const activeWasDeleted =
      !currentActive ||
      currentActive === profileId ||
      (currentActive !== ANTHROPIC_DEFAULT_PROFILE_ID &&
        !nextProfiles.some(profile => profile.id === currentActive))
    activeProfileWasDeleted = activeWasDeleted

    const nextActiveId = activeWasDeleted ? nextProfiles[0]?.id : currentActive

    if (nextActiveId && nextActiveId !== ANTHROPIC_DEFAULT_PROFILE_ID) {
      nextActiveProfile =
        nextProfiles.find(profile => profile.id === nextActiveId) ?? nextProfiles[0]
    }

    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[profileId]

    return {
      ...current,
      providerProfiles: nextProfiles,
      activeProviderProfileId: nextActiveId,
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
      openaiAdditionalModelOptionsCache: nextActiveId
        ? (
            nextActiveProfile
              ? getProfileModelOptions(nextActiveProfile, {
                  ...current,
                  providerProfiles: nextProfiles,
                  activeProviderProfileId: nextActiveId,
                  openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
                })
              : []
          )
        : [],
    }
  })

  if (nextActiveProfile) {
    setActiveProviderProfile(nextActiveProfile.id)
  } else if (deletedProfile && activeProfileWasDeleted) {
    if (
      isProcessEnvAlignedWithProfile(process.env, deletedProfile, {
        includeApiKey: false,
      })
    ) {
      clearProviderProfileEnvFromProcessEnv()
    }
    deleteProfileFile()
  }

  return {
    removed,
    activeProfileId: nextActiveProfile?.id,
  }
}

export function getActiveOpenAIModelOptionsCache(
  config = getGlobalConfig(),
): ModelOption[] {
  const activeProfile = getActiveProviderProfile(config)

  if (!activeProfile) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  const cached = config.openaiAdditionalModelOptionsCacheByProfile?.[
    activeProfile.id
  ]
  if (cached) {
    return cached
  }

  const profileOptions = getProfileModelOptions(activeProfile, config)
  if (profileOptions.length > 0) {
    return profileOptions
  }

  // Backward compatibility for users who have only the legacy single cache.
  if (
    Object.keys(config.openaiAdditionalModelOptionsCacheByProfile ?? {}).length ===
    0
  ) {
    return config.openaiAdditionalModelOptionsCache ?? []
  }

  return []
}

export function setActiveOpenAIModelOptionsCache(options: ModelOption[]): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: options,
    }))
    return
  }

  const mergedOptions = mergeModelOptionsByValue(
    parseModelList(activeProfile.model).map(model => ({
      value: model,
      label: model,
      description: `Provider: ${activeProfile.name}`,
    })),
    options,
  )

  saveGlobalConfig(current => ({
    ...current,
    openaiAdditionalModelOptionsCache: mergedOptions,
    openaiAdditionalModelOptionsCacheByProfile: {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
      [activeProfile.id]: mergedOptions,
    },
  }))
}

export function getActiveOpenAIRouteModelOptionsCache(
  config = getGlobalConfig(),
): ModelOption[] {
  const activeScope = getAdditionalModelOptionsCacheScope()

  return activeScope?.startsWith('openai:') &&
    config.additionalModelOptionsCacheScope === activeScope
    ? (config.additionalModelOptionsCache ?? [])
    : []
}

export function setActiveOpenAIRouteModelOptionsCache(
  options: ModelOption[],
): void {
  const activeScope = getAdditionalModelOptionsCacheScope()
  if (!activeScope?.startsWith('openai:')) {
    return
  }

  saveGlobalConfig(current => ({
    ...current,
    additionalModelOptionsCache: options,
    additionalModelOptionsCacheScope: activeScope,
  }))
}

export function clearActiveOpenAIModelOptionsCache(): void {
  const activeProfile = getActiveProviderProfile()

  if (!activeProfile) {
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: [],
    }))
    return
  }

  saveGlobalConfig(current => {
    const cacheByProfile = {
      ...(current.openaiAdditionalModelOptionsCacheByProfile ?? {}),
    }
    delete cacheByProfile[activeProfile.id]

    return {
      ...current,
      openaiAdditionalModelOptionsCache: [],
      openaiAdditionalModelOptionsCacheByProfile: cacheByProfile,
    }
  })
}
