// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
/**
 * Ensure that any model codenames introduced here are also added to
 * scripts/excluded-strings.txt to avoid leaking them. Wrap any codename string
 * literals with process.env.USER_TYPE === 'ant' for Bun to remove the codenames
 * during dead code elimination
 */
import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getSubscriptionType,
  isClaudeAISubscriber,
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../auth.js'
import {
  has1mContext,
  is1mContextDisabled,
  modelSupports1M,
} from '../context.js'
import { isEnvTruthy } from '../envUtils.js'
import { getModelStrings, resolveOverriddenModel } from './modelStrings.js'
import { getModelPricingString } from '../modelCost.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
  isFirstPartyAnthropicProvider,
  isCustomAnthropicProvider,
} from './providers.js'
import { LIGHTNING_BOLT } from '../../constants/figures.js'
import { isModelAllowed } from './modelAllowlist.js'
import { type ModelAlias, isModelAlias } from './aliases.js'
import { capitalize } from '../stringUtils.js'
import { DEFAULT_GEMINI_MODEL } from '../providerProfile.js'
import { getAntModelOverrideConfig, resolveAntModel } from './antModels.js'
import { getRouteDefaultModel, resolveActiveRouteIdFromEnv } from '../../integrations/routeMetadata.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

function getMiniMaxModelEnv(): string | undefined {
  return isEnvTruthy(process.env.CLAUDE_CODE_USE_OPENAI)
    ? process.env.OPENAI_MODEL
    : process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL
}

function normalizeModelSetting(value: unknown): ModelName | ModelAlias | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function getUsableProviderConfigModel(value: string | undefined): string | undefined {
  const normalized = normalizeModelSetting(value)
  if (!normalized) return undefined
  const lowercase = normalized.toLowerCase()
  return lowercase === 'undefined' || lowercase === 'null' ? undefined : normalized
}

function getAllowedConcentrateConfigModel(): string | undefined {
  for (const value of [
    process.env.CONCENTRATE_MODEL,
    process.env.OPENAI_MODEL,
  ]) {
    const model = getUsableProviderConfigModel(value)
    if (model && isModelAllowed(model)) return model
  }
  return undefined
}

function getAllowedApiRouteConfigModel(): string | undefined {
  for (const value of [
    process.env.API_ROUTE_MODEL,
    process.env.OPENAI_MODEL,
  ]) {
    const model = getUsableProviderConfigModel(value)
    if (model && isModelAllowed(model)) return model
  }
  return undefined
}

export function getSmallFastModel(): ModelName {
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) return process.env.ANTHROPIC_SMALL_FAST_MODEL
  if (isCustomAnthropicProvider()) {
    return process.env.ANTHROPIC_MODEL || getDefaultHaikuModel()
  }
  // For Gemini provider, use a fast model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'ministral-3b-latest'
  }
  // For OpenAI provider, use OPENAI_MODEL or a sensible default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  // Codex provider — OPENAI_MODEL is always set for Codex profiles; only fall
  // back to a codex-spark alias when an override env strips it.
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'codexspark'
  }
  // For GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.OPENAI_MODEL || 'github:copilot'
  }
  // NVIDIA NIM — OPENAI_MODEL carries the user's active NIM model; use a
  // small Meta Llama variant as the conservative fallback.
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.OPENAI_MODEL || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — OPENAI_MODEL carries the active MiniMax model; fall back to
  // the fastest tier (M2.5-highspeed) when missing.
  if (getAPIProvider() === 'minimax') {
    return getMiniMaxModelEnv() || 'MiniMax-M2.5-highspeed'
  }
  // Xiaomi MiMo — OPENAI_MODEL carries the active MiMo model; fall back to
  // the fast tier when missing.
  if (getAPIProvider() === 'xiaomi-mimo') {
    return process.env.OPENAI_MODEL || 'mimo-v2-flash'
  }
  // xAI — OPENAI_MODEL carries the active Grok model; fall back to Grok 4.6.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || getRouteDefaultModel('xai') || 'grok-4.6'
  }
  return getDefaultHaikuModel()
}

export function isNonCustomOpusModel(model: ModelName): boolean {
  return (
    model === getModelStrings().opus40 ||
    model === getModelStrings().opus41 ||
    model === getModelStrings().opus45 ||
    model === getModelStrings().opus46 ||
    model === getModelStrings().opus47 ||
    model === getModelStrings().opus48
  )
}

/**
 * Helper to get the model from /model (including via /config), the --model flag, environment variable,
 * or the saved settings. The returned value can be a model alias if that's what the user specified.
 * Undefined if the user didn't configure anything, in which case we fall back to
 * the default (null).
 *
 * Priority order within this function:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  let specifiedModel: ModelSetting | undefined

  const modelOverride = getMainLoopModelOverride()
  if (modelOverride !== undefined) {
    specifiedModel = modelOverride
  } else {
    const settings = getSettings_DEPRECATED() || {}
    const setting = normalizeModelSetting(settings.model)
    // Read the model env var that matches the active provider to prevent
    // cross-provider leaks (e.g. ANTHROPIC_MODEL sent to the OpenAI API).
    //
    // All OpenAI-shim providers (openai, codex, github, nvidia-nim, minimax)
    // set CLAUDE_CODE_USE_OPENAI=1 + OPENAI_MODEL via
    // applyProviderProfileToProcessEnv. Earlier this check only included
    // openai/github — codex/nvidia-nim/minimax fell through to the stale
    // settings.model, so switching from (say) Moonshot to Codex kept firing
    // `kimi-k2.6` at the Codex endpoint and getting 400s.
    const provider = getAPIProvider()
    const activeRouteId = resolveActiveRouteIdFromEnv(process.env)
    const isOpenAIShimProvider =
      provider === 'openai' ||
      provider === 'codex' ||
      provider === 'github' ||
      provider === 'nvidia-nim' ||
      provider === 'minimax' ||
      provider === 'xiaomi-mimo' ||
      provider === 'xai'
    specifiedModel = activeRouteId === 'concentrate'
      // Concentrate is an env-only OpenAI-compatible route. Model selection
      // happens before the client applies its OpenAI-compatible defaults, so
      // consume its dedicated setting here rather than falling through to a
      // saved model from an unrelated provider.
      ? getAllowedConcentrateConfigModel()
      : activeRouteId === 'api-route'
        ? getAllowedApiRouteConfigModel()
        : (provider === 'gemini' ? process.env.GEMINI_MODEL : undefined) ||
        (provider === 'mistral' ? process.env.MISTRAL_MODEL : undefined) ||
        (provider === 'minimax' ? getMiniMaxModelEnv() : undefined) ||
        (isOpenAIShimProvider ? process.env.OPENAI_MODEL : undefined) ||
        (provider === 'firstParty' ? process.env.ANTHROPIC_MODEL : undefined) ||
        setting ||
        undefined
  }

  // Ignore the user-specified model if it's not in the availableModels allowlist.
  if (specifiedModel && !isModelAllowed(specifiedModel)) {
    return undefined
  }

  return specifiedModel
}

/**
 * Get the main loop model to use for the current session.
 *
 * Model Selection Priority Order:
 * 1. Model override during session (from /model command) - highest priority
 * 2. Model override at startup (from --model flag)
 * 3. ANTHROPIC_MODEL environment variable
 * 4. Settings (from user's saved settings)
 * 5. Built-in default
 *
 * @returns The resolved model name to use
 */
export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  if (model !== undefined && model !== null) {
    return parseUserSpecifiedModel(model)
  }
  return getDefaultMainLoopModel()
}

export function getBestModel(): ModelName {
  return getDefaultOpusModel()
}

// @[MODEL LAUNCH]: Update the default Opus model (3P providers may lag so keep defaults unchanged).
export function getDefaultOpusModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.5-pro'
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'devstral-latest'
  }
  // OpenAI provider: use user-specified model or default
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Codex provider: use user-specified model or default
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.6-sol'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.OPENAI_MODEL || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.OPENAI_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — flagship tier for "opus"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getMiniMaxModelEnv() || 'MiniMax-M2.7'
  }
  // Xiaomi MiMo — flagship tier for "opus"-equivalent.
  if (getAPIProvider() === 'xiaomi-mimo') {
    return process.env.OPENAI_MODEL || 'mimo-v2.5-pro'
  }
  // xAI — flagship Grok model for "opus"-equivalent.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || getRouteDefaultModel('xai') || 'grok-4.6'
  }
  // 3P providers (Bedrock, Vertex, Foundry) — kept as a separate branch
  // since 3P availability lags firstParty and these will diverge again at
  // the next model launch. Keep 3P on Opus 4.7 until they roll out 4.8.
  if (!isFirstPartyAnthropicProvider()) {
    return getModelStrings().opus47
  }
  return getModelStrings().opus48
}

// @[MODEL LAUNCH]: Update the default Sonnet model (3P providers may lag so keep defaults unchanged).
export function getDefaultSonnetModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'mistral-medium-latest'
  }
  // OpenAI provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Codex provider
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.6-sol'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.OPENAI_MODEL || 'github:copilot'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.OPENAI_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct'
  }
  // MiniMax — mid tier for "sonnet"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getMiniMaxModelEnv() || 'MiniMax-M2.5'
  }
  // Xiaomi MiMo — flagship model for "sonnet"-equivalent.
  if (getAPIProvider() === 'xiaomi-mimo') {
    return process.env.OPENAI_MODEL || 'mimo-v2.5-pro'
  }
  // xAI — flagship Grok model for "sonnet"-equivalent.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || getRouteDefaultModel('xai') || 'grok-4.6'
  }
  // Default to Sonnet 4.5 for 3P since they may not have 4.6 yet
  if (!isFirstPartyAnthropicProvider()) {
    return getModelStrings().sonnet45
  }
  return getModelStrings().sonnet46
}

// @[MODEL LAUNCH]: Update the default Haiku model (3P providers may lag so keep defaults unchanged).
export function getDefaultHaikuModel(): ModelName {
  if (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    return process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL
  }
  // Mistral provider
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'ministral-3b-latest'
  }
  // OpenAI provider
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o-mini'
  }
  // Codex provider
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.6-sol'
  }
  // GitHub Copilot provider
  if (getAPIProvider() === 'github') {
    return process.env.OPENAI_MODEL || 'github:copilot'
  }
  // Gemini provider
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite'
  }
  // NVIDIA NIM
  if (getAPIProvider() === 'nvidia-nim') {
    return process.env.OPENAI_MODEL || 'meta/llama-3.1-8b-instruct'
  }
  // MiniMax — fastest tier for "haiku"-equivalent.
  if (getAPIProvider() === 'minimax') {
    return getMiniMaxModelEnv() || 'MiniMax-M2.5-highspeed'
  }
  // Xiaomi MiMo — fast tier for "haiku"-equivalent.
  if (getAPIProvider() === 'xiaomi-mimo') {
    return process.env.OPENAI_MODEL || 'mimo-v2-flash'
  }
  // xAI — use the current Grok default for "haiku"-equivalent until xAI exposes a smaller live alias.
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || getRouteDefaultModel('xai') || 'grok-4.6'
  }

  // Haiku 4.5 is available on all platforms (first-party, Foundry, Bedrock, Vertex)
  return getModelStrings().haiku45
}

/**
 * Get the model to use for runtime, depending on the runtime context.
 * @param params Subset of the runtime context to determine the model to use.
 * @returns The model to use
 */
export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  const { permissionMode, mainLoopModel, exceeds200kTokens = false } = params

  // opusplan uses Opus in plan mode without [1m] suffix.
  if (
    getUserSpecifiedModelSetting() === 'opusplan' &&
    permissionMode === 'plan' &&
    !exceeds200kTokens
  ) {
    return getDefaultOpusModel()
  }

  // sonnetplan by default
  if (getUserSpecifiedModelSetting() === 'haiku' && permissionMode === 'plan') {
    return getDefaultSonnetModel()
  }

  return mainLoopModel
}

/**
 * Get the default main loop model setting.
 *
 * This handles the built-in default:
 * - Opus for Max and Team Premium users
 * - Sonnet 4.6 for all other users (including Team Standard, Pro, Enterprise)
 *
 * @returns The default model setting to use
 */
export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  if (resolveActiveRouteIdFromEnv(process.env) === 'concentrate') {
    return (
      getAllowedConcentrateConfigModel() ||
      getRouteDefaultModel('concentrate') ||
      'deepseek-v4-flash'
    )
  }
  if (resolveActiveRouteIdFromEnv(process.env) === 'api-route') {
    return (
      getAllowedApiRouteConfigModel() ||
      getRouteDefaultModel('api-route') ||
      'claude-sonnet-4-6'
    )
  }
  // Custom Anthropic-compatible endpoints intentionally retain the legacy
  // firstParty provider category, so prefer their explicitly configured model
  // before the subscription and PAYG defaults below.
  if (isCustomAnthropicProvider()) {
    return process.env.ANTHROPIC_MODEL || getDefaultSonnetModel()
  }
  // GitHub Copilot provider: check settings.model first, then env, then default
  if (getAPIProvider() === 'github') {
    const settings = getSettings_DEPRECATED() || {}
    return (
      normalizeModelSetting(settings.model) ||
      normalizeModelSetting(process.env.OPENAI_MODEL) ||
      'github:copilot'
    )
  }
  // Gemini provider: always use the configured Gemini model
  if (getAPIProvider() === 'gemini') {
    return process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL
  }
  if (getAPIProvider() === 'mistral') {
    return process.env.MISTRAL_MODEL || 'devstral-latest'
  }
  // OpenAI provider: always use the configured OpenAI model
  if (getAPIProvider() === 'openai') {
    return process.env.OPENAI_MODEL || 'gpt-4o'
  }
  // Codex provider: always use the configured Codex model
  if (getAPIProvider() === 'codex') {
    return process.env.OPENAI_MODEL || 'gpt-5.6-sol'
  }
  // NVIDIA NIM uses OpenAI-compatible model ids. Keep this fallback aligned
  // with the route descriptor so headless sessions never send a Claude model.
  if (getAPIProvider() === 'nvidia-nim') {
    return (
      process.env.OPENAI_MODEL ||
      getRouteDefaultModel('nvidia-nim') ||
      'nvidia/llama-3.1-nemotron-70b-instruct'
    )
  }
  // xAI provider: always use the configured Grok model (default grok-4.6)
  if (getAPIProvider() === 'xai') {
    return process.env.OPENAI_MODEL || getRouteDefaultModel('xai') || 'grok-4.6'
  }
  // MiniMax provider: always use the configured MiniMax model.
  // Keep the env-only fallback aligned with the MiniMax descriptor default
  // (MiniMax-M3) so a session with only MINIMAX_API_KEY / a MiniMax base URL
  // defaults to the same model as --provider minimax and saved profiles.
  if (getAPIProvider() === 'minimax') {
    return getMiniMaxModelEnv() || 'MiniMax-M3'
  }
  // Xiaomi MiMo provider: always use the configured MiMo model
  if (getAPIProvider() === 'xiaomi-mimo') {
    return process.env.OPENAI_MODEL || 'mimo-v2.5-pro'
  }

  // Ants default to defaultModel from flag config, or Opus 1M if not configured
  if (process.env.USER_TYPE === 'ant') {
    return (
      getAntModelOverrideConfig()?.defaultModel ??
      getDefaultOpusModel() + '[1m]'
    )
  }

  // Max users get Opus as default
  if (isMaxSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // Team Premium gets Opus (same as Max)
  if (isTeamPremiumSubscriber()) {
    return getDefaultOpusModel() + (isOpus1mMergeEnabled() ? '[1m]' : '')
  }

  // PAYG (1P and 3P), Enterprise, Team Standard, and Pro get Sonnet as default
  // Note that PAYG (3P) may default to an older Sonnet model
  return getDefaultSonnetModel()
}

/**
 * Synchronous operation to get the default main loop model to use
 * (bypassing any user-specified values).
 */
export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

// @[MODEL LAUNCH]: Add a canonical name mapping for the new model below.
/**
 * Pure string-match that strips date/provider suffixes from a first-party model
 * name. Input must already be a 1P-format ID (e.g. 'claude-3-7-sonnet-20250219',
 * 'us.anthropic.claude-opus-4-6-v1:0'). Does not touch settings, so safe at
 * module top-level (see MODEL_COSTS in modelCost.ts).
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  name = name.toLowerCase()
  // Special cases for Claude 4+ models to differentiate versions
  // Order matters: check more specific versions first (4-8 before 4-7 before 4-6 before 4-5 before 4)
  if (name.includes('claude-opus-4-8')) {
    return 'claude-opus-4-8'
  }
  if (name.includes('claude-opus-4-7')) {
    return 'claude-opus-4-7'
  }
  if (name.includes('claude-opus-4-6')) {
    return 'claude-opus-4-6'
  }
  if (name.includes('claude-opus-4-5')) {
    return 'claude-opus-4-5'
  }
  if (name.includes('claude-opus-4-1')) {
    return 'claude-opus-4-1'
  }
  if (name.includes('claude-opus-4')) {
    return 'claude-opus-4'
  }
  if (name.includes('claude-sonnet-4-6')) {
    return 'claude-sonnet-4-6'
  }
  if (name.includes('claude-sonnet-4-5')) {
    return 'claude-sonnet-4-5'
  }
  if (name.includes('claude-sonnet-4')) {
    return 'claude-sonnet-4'
  }
  if (name.includes('claude-haiku-4-5')) {
    return 'claude-haiku-4-5'
  }
  // Claude 3.x models use a different naming scheme (claude-3-{family})
  if (name.includes('claude-3-7-sonnet')) {
    return 'claude-3-7-sonnet'
  }
  if (name.includes('claude-3-5-sonnet')) {
    return 'claude-3-5-sonnet'
  }
  if (name.includes('claude-3-5-haiku')) {
    return 'claude-3-5-haiku'
  }
  if (name.includes('claude-3-opus')) {
    return 'claude-3-opus'
  }
  if (name.includes('claude-3-sonnet')) {
    return 'claude-3-sonnet'
  }
  if (name.includes('claude-3-haiku')) {
    return 'claude-3-haiku'
  }
  const match = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (match && match[1]) {
    return match[1]
  }
  // Fall back to the original name if no pattern matches
  return name
}

/**
 * Maps a full model string to a shorter canonical version that's unified across 1P and 3P providers.
 * For example, 'claude-3-5-haiku-20241022' and 'us.anthropic.claude-3-5-haiku-20241022-v1:0'
 * would both be mapped to 'claude-3-5-haiku'.
 * @param fullModelName The full model name (e.g., 'claude-3-5-haiku-20241022')
 * @returns The short name (e.g., 'claude-3-5-haiku') if found, or the original name if no mapping exists
 */
export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  // Resolve overridden model IDs (e.g. Bedrock ARNs) back to canonical names.
  // resolved is always a 1P-format ID, so firstPartyNameToCanonical can handle it.
  return firstPartyNameToCanonical(resolveOverriddenModel(fullModelName))
}

// @[MODEL LAUNCH]: Update the default model description strings shown to users.
export function getClaudeAiUserDefaultModelDescription(
  fastMode = false,
): string {
  if (isMaxSubscriber() || isTeamPremiumSubscriber()) {
    if (isOpus1mMergeEnabled()) {
      return `Opus 4.8 with 1M context · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
    }
    return `Opus 4.8 · Most capable for complex work${fastMode ? getOpus46PricingSuffix(true) : ''}`
  }
  return 'Sonnet 4.6 · Best for everyday tasks'
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  if (setting === 'opusplan') {
    return 'Opus 4.8 in plan mode, else Sonnet 4.6'
  }
  return renderModelName(parseUserSpecifiedModel(setting))
}

export function getOpus46PricingSuffix(
  fastMode: boolean,
  model: string = getModelStrings().opus48,
): string {
  if (!isFirstPartyAnthropicProvider()) return ''
  const pricing = getModelPricingString(model, {
    speed: fastMode ? 'fast' : 'standard',
  })
  if (!pricing) return ''
  const fastModeIndicator = fastMode ? ` (${LIGHTNING_BOLT})` : ''
  return ` ·${fastModeIndicator} ${pricing}`
}

export function isOpus1mMergeEnabled(): boolean {
  if (
    is1mContextDisabled() ||
    isProSubscriber() ||
    !isFirstPartyAnthropicProvider()
  ) {
    return false
  }
  // Fail closed when a subscriber's subscription type is unknown. The VS Code
  // config-loading subprocess can have OAuth tokens with valid scopes but no
  // subscriptionType field (stale or partial refresh). Without this guard,
  // isProSubscriber() returns false for such users and the merge leaks
  // opus[1m] into the model dropdown — the API then rejects it with a
  // misleading "rate limit reached" error.
  if (isClaudeAISubscriber() && getSubscriptionType() === null) {
    return false
  }
  return true
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  if (setting === 'opusplan') {
    return 'Opus Plan'
  }
  // Handle Codex models - show actual model name + resolved model
  if (setting === 'codexplan') {
    return 'codexplan (gpt-5.6-sol)'
  }
  if (setting === 'codexspark') {
    return 'codexspark (gpt-5.3-codex-spark)'
  }
  if (isModelAlias(setting)) {
    return capitalize(setting)
  }
  return renderModelName(setting)
}

// @[MODEL LAUNCH]: Add display name cases for the new model (base + [1m] variant if applicable).
/**
 * Returns a human-readable display name for known public models, or null
 * if the model is not recognized as a public model.
 */
export function getPublicModelDisplayName(model: ModelName): string | null {
  // For OpenAI-compatible/non-Anthropic providers, show the actual model name
  // instead of interpreting provider-specific defaults as Claude aliases.
  if (
    getAPIProvider() === 'openai' ||
    getAPIProvider() === 'gemini' ||
    getAPIProvider() === 'codex' ||
    getAPIProvider() === 'github' ||
    getAPIProvider() === 'xai' ||
    getAPIProvider() === 'minimax' ||
    getAPIProvider() === 'xiaomi-mimo' ||
    getAPIProvider() === 'nvidia-nim' ||
    getAPIProvider() === 'mistral'
  ) {
    // Return display names for known GitHub Copilot models
    const copilotModelNames: Record<string, string> = {
      'gpt-5.6-sol': 'GPT-5.6 Sol',
      'gpt-5.6-terra': 'GPT-5.6 Terra',
      'gpt-5.6-luna': 'GPT-5.6 Luna',
      'gpt-5.5': 'GPT-5.5',
      'gpt-5.5-mini': 'GPT-5.5 mini',
      'gpt-5.4': 'GPT-5.4',
      'gpt-5.4-mini': 'GPT-5.4 mini',
      'gpt-5.3-codex': 'GPT-5.3 Codex',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gpt-5.2': 'GPT-5.2',
      'gpt-5.1-codex': 'GPT-5.1 Codex',
      'gpt-5.1-codex-max': 'GPT-5.1 Codex max',
      'gpt-5.1-codex-mini': 'GPT-5.1 Codex mini',
      'gpt-4o': 'GPT-4o',
      'gpt-4.1': 'GPT-4.1',
      'claude-opus-4.6': 'Claude Opus 4.6',
      'claude-opus-4.5': 'Claude Opus 4.5',
      'claude-sonnet-4.6': 'Claude Sonnet 4.6',
      'claude-sonnet-4.5': 'Claude Sonnet 4.5',
      'claude-haiku-4.5': 'Claude Haiku 4.5',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'gemini-3-flash-preview': 'Gemini 3 Flash',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'grok-code-fast-1': 'Grok Build 0.1',
      'grok-build-0.1': 'Grok Build 0.1',
      'grok-4.20': 'Grok 4.20 Reasoning',
      'grok-4.20-0309-reasoning': 'Grok 4.20 Reasoning',
      'grok-4.20-0309-non-reasoning': 'Grok 4.20 Non-Reasoning',
    }
    if (copilotModelNames[model]) {
      return copilotModelNames[model]
    }
    return null
  }
  switch (model) {
    case 'gpt-5.6-sol':
      return 'GPT-5.6 Sol'
    case 'gpt-5.6-terra':
      return 'GPT-5.6 Terra'
    case 'gpt-5.6-luna':
      return 'GPT-5.6 Luna'
    case 'gpt-5.5':
      return 'GPT-5.5'
    case 'gpt-5.4':
      return 'GPT-5.4'
    case 'gpt-5.3-codex-spark':
      return 'GPT-5.3 Codex Spark'
    case getModelStrings().opus48 + '[1m]':
      return 'Opus 4.8 (1M context)'
    case getModelStrings().opus48:
      return 'Opus 4.8'
    case getModelStrings().opus47 + '[1m]':
      return 'Opus 4.7 (1M context)'
    case getModelStrings().opus47:
      return 'Opus 4.7'
    case getModelStrings().opus46 + '[1m]':
      return 'Opus 4.6 (1M context)'
    case getModelStrings().opus46:
      return 'Opus 4.6'
    case getModelStrings().opus45:
      return 'Opus 4.5'
    case getModelStrings().opus41:
      return 'Opus 4.1'
    case getModelStrings().opus40:
      return 'Opus 4'
    case getModelStrings().sonnet46 + '[1m]':
      return 'Sonnet 4.6 (1M context)'
    case getModelStrings().sonnet46:
      return 'Sonnet 4.6'
    case getModelStrings().sonnet45 + '[1m]':
      return 'Sonnet 4.5 (1M context)'
    case getModelStrings().sonnet45:
      return 'Sonnet 4.5'
    case getModelStrings().sonnet40:
      return 'Sonnet 4'
    case getModelStrings().sonnet40 + '[1m]':
      return 'Sonnet 4 (1M context)'
    case getModelStrings().sonnet37:
      return 'Sonnet 3.7'
    case getModelStrings().sonnet35:
      return 'Sonnet 3.5'
    case getModelStrings().haiku45:
      return 'Haiku 4.5'
    case getModelStrings().haiku35:
      return 'Haiku 3.5'
    default:
      return null
  }
}

function maskModelCodename(baseName: string): string {
  // Mask only the first dash-separated segment (the codename), preserve the rest
  // e.g. capybara-v2-fast → cap*****-v2-fast
  const [codename = '', ...rest] = baseName.split('-')
  const masked =
    codename.slice(0, 3) + '*'.repeat(Math.max(0, codename.length - 3))
  return [masked, ...rest].join('-')
}

export function renderModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return publicName
  }
  // Handle GitHub Copilot special model aliases
  if (model === 'github:copilot') {
    return 'GPT-4o'
  }
  if (process.env.USER_TYPE === 'ant') {
    const resolved = parseUserSpecifiedModel(model)
    const antModel = resolveAntModel(model)
    if (antModel) {
      const baseName = antModel.model.replace(/\[1m\]$/i, '')
      const masked = maskModelCodename(baseName)
      const suffix = has1mContext(resolved) ? '[1m]' : ''
      return masked + suffix
    }
    if (resolved !== model) {
      return `${model} (${resolved})`
    }
    return resolved
  }
  return model
}

/**
 * Returns a safe author name for public display (e.g., in git commit trailers).
 * Returns "Claude {ModelName}" for publicly known models, or "Claude ({model})"
 * for unknown/internal models so the exact model name is preserved.
 *
 * @param model The full model name
 * @returns "Claude {ModelName}" for public models, or "Claude ({model})" for non-public models
 */
export function getPublicModelName(model: ModelName): string {
  const publicName = getPublicModelDisplayName(model)
  if (publicName) {
    return `Claude ${publicName}`
  }
  return `Claude (${model})`
}

/**
 * Returns a full model name for use in this session, possibly after resolving
 * a model alias.
 *
 * This function intentionally does not support version numbers to align with
 * the model switcher.
 *
 * Supports [1m] suffix on any model alias (e.g., haiku[1m], sonnet[1m]) to enable
 * 1M context window without requiring each variant to be in MODEL_ALIASES.
 *
 * @param modelInput The model alias or name provided by the user.
 */
export function parseUserSpecifiedModel(
  modelInput: ModelName | ModelAlias,
): ModelName {
  const modelInputTrimmed = normalizeModelSetting(modelInput)
  if (!modelInputTrimmed) {
    return getDefaultSonnetModel()
  }
  const normalizedModel = modelInputTrimmed.toLowerCase()

  // Separate "the [1m] tag is present in the input" from "1M context is active".
  // The tag must ALWAYS be stripped before alias/model matching, otherwise an
  // aliased request like `sonnet[1m]` fails to resolve to its base model. Whether
  // to re-append the tag depends on has1mContext, which returns false when 1M is
  // disabled (CLAUDE_CODE_DISABLE_1M_CONTEXT) — in that case the request resolves
  // to the base model with the tag dropped, not left as an unresolved alias.
  const hasTagSyntax = /\[1m]$/i.test(normalizedModel)
  const has1mTag = has1mContext(normalizedModel)
  const modelString = hasTagSyntax
    ? normalizedModel.replace(/\[1m]$/i, '').trim()
    : normalizedModel

  // Re-apply the [1m] tag policy to a resolved model. The resolved value may
  // itself carry a [1m] suffix — e.g. a custom default override like
  // ANTHROPIC_DEFAULT_SONNET_MODEL=Deploy[1m] baked into getDefaultSonnetModel().
  // Strip whatever tag is present, then re-attach [1m] only when a tag was
  // requested (on the user input OR the resolved default) AND 1M context is
  // enabled. This guarantees CLAUDE_CODE_DISABLE_1M_CONTEXT drops the tag no
  // matter where it came from, while still honoring an env default's opt-in.
  const applyOneMTag = (resolved: ModelName): ModelName => {
    const base = resolved.replace(/\[1m]$/i, '').trim()
    return has1mTag || has1mContext(resolved) ? base + '[1m]' : base
  }

  if (isModelAlias(modelString)) {
    switch (modelString) {
      case 'opusplan':
        return applyOneMTag(getDefaultSonnetModel()) // Sonnet is default, Opus in plan mode
      case 'sonnet':
        return applyOneMTag(getDefaultSonnetModel())
      case 'haiku':
        return applyOneMTag(getDefaultHaikuModel())
      case 'opus':
        return applyOneMTag(getDefaultOpusModel())
      case 'best':
        return applyOneMTag(getBestModel())
      default:
    }
  }

  // Handle Codex aliases - map to actual model names. Preserve the [1m] tag the
  // same way the Claude aliases above do: it is an explicit client-side opt-in
  // to the 1M context window (see has1mContext), so dropping it here would
  // silently shrink a `codexplan[1m]`/`codexspark[1m]` session back to the
  // model default.
  if (modelString === 'codexplan') {
    return 'gpt-5.6-sol' + (has1mTag ? '[1m]' : '')
  }
  if (modelString === 'codexspark') {
    return 'gpt-5.3-codex-spark' + (has1mTag ? '[1m]' : '')
  }
  // Bare gpt-5.6 resolves to the flagship tier (Sol), like the Codex CLI.
  // Resolving here — not just in the request-time alias map — keeps the
  // runtime model id on the tier that has real descriptor metadata, so
  // context-window sizing and display names don't fall back to defaults.
  // Match on the base name so a ?reasoning=/?thinking= query suffix does not
  // defeat the rewrite; the query is preserved on the resolved tier id and a
  // [1m] tag stays TRAILING (after the query, mirroring the input form) so
  // downstream query parsing sees `?reasoning=...` intact — request-time
  // parsing (parseModelDescriptor) strips the trailing tag itself.
  if (modelString === 'gpt-5.6' || modelString.startsWith('gpt-5.6?')) {
    const query = modelString.slice('gpt-5.6'.length)
    return 'gpt-5.6-sol' + query + (has1mTag ? '[1m]' : '')
  }

  // Opus 4/4.1 are no longer available on the first-party API (same as
  // Claude.ai) — silently remap to the current Opus default. The 'opus'
  // alias already resolves to 4.6, so the only users on these explicit
  // strings pinned them in settings/env/--model/SDK before 4.5 launched.
  // 3P providers may not yet have 4.6 capacity, so pass through unchanged.
  if (
    getAPIProvider() === 'firstParty' &&
    isFirstPartyAnthropicBaseUrl() &&
    isLegacyOpusFirstParty(modelString) &&
    isLegacyModelRemapEnabled()
  ) {
    return applyOneMTag(getDefaultOpusModel())
  }

  if (process.env.USER_TYPE === 'ant') {
    const has1mAntTag = has1mContext(normalizedModel)
    const baseAntModel = normalizedModel.replace(/\[1m]$/i, '').trim()

    const antModel = resolveAntModel(baseAntModel)
    if (antModel) {
      const suffix = has1mAntTag ? '[1m]' : ''
      return antModel.model + suffix
    }

    // Fall through to the alias string if we cannot load the config. The API calls
    // will fail with this string, but we should hear about it through feedback and
    // can tell the user to restart/wait for flag cache refresh to get the latest values.
  }

  // Preserve original case for custom model names (e.g., Azure Foundry deployment IDs).
  // Strip a present [1m] suffix (maintaining base-model case) and re-append it
  // only when 1M is active — when disabled, a custom `mydeploy[1m]` must resolve
  // to the base `mydeploy`, not an unservable `mydeploy[1m]` model id.
  if (hasTagSyntax) {
    return (
      modelInputTrimmed.replace(/\[1m\]$/i, '').trim() +
      (has1mTag ? '[1m]' : '')
    )
  }
  return modelInputTrimmed
}

// Runtime code needs the concrete model for capabilities and routing, but a
// custom gateway still distinguishes the legacy codexplan selection from an
// explicit GPT-5.6 Sol request when applying its default reasoning effort.
export function getProviderRequestModel(
  selectedModel: string,
  runtimeModel: string,
): string {
  const selected = selectedModel.trim()
  const selectedBase = selected
    .replace(/\[1m]$/i, '')
    .split('?', 1)[0]
    ?.toLowerCase()
  const runtimeBase = runtimeModel
    .trim()
    .replace(/\[1m]$/i, '')
    .split('?', 1)[0]
    ?.toLowerCase()
  return selectedBase === 'codexplan' &&
    runtimeBase === parseUserSpecifiedModel('codexplan')
    ? selected
    : runtimeModel
}

/**
 * Resolves a skill's `model:` frontmatter against the current model, carrying
 * the `[1m]` suffix over when the target family supports it.
 *
 * A skill author writing `model: opus` means "use opus-class reasoning" — not
 * "downgrade to 200K". If the user is on opus[1m] at 230K tokens and invokes a
 * skill with `model: opus`, passing the bare alias through drops the effective
 * context window from 1M to 200K, which trips autocompact at 23% apparent usage
 * and surfaces "Context limit reached" even though nothing overflowed.
 *
 * We only carry [1m] when the target actually supports it (sonnet/opus). A skill
 * with `model: haiku` on a 1M session still downgrades — haiku has no 1M variant,
 * so the autocompact that follows is correct. Skills that already specify [1m]
 * are left untouched.
 */
export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  // modelSupports1M matches on canonical IDs ('claude-opus-4-6', 'claude-sonnet-4');
  // a bare 'opus' alias falls through getCanonicalName unmatched. Resolve first.
  if (modelSupports1M(parseUserSpecifiedModel(skillModel))) {
    return skillModel + '[1m]'
  }
  return skillModel
}

const LEGACY_OPUS_FIRSTPARTY = [
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
]

function isLegacyOpusFirstParty(model: string): boolean {
  return LEGACY_OPUS_FIRSTPARTY.includes(model)
}

/**
 * Opt-out for the legacy Opus 4.0/4.1 → current Opus remap.
 */
export function isLegacyModelRemapEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP)
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    if (!isFirstPartyAnthropicProvider()) {
      return `Default (${getDefaultMainLoopModel()})`
    }
    if (process.env.USER_TYPE === 'ant') {
      return `Default for Ants (${renderDefaultModelSetting(getDefaultMainLoopModelSetting())})`
    } else if (isClaudeAISubscriber()) {
      return `Default (${getClaudeAiUserDefaultModelDescription()})`
    }
    return `Default (${getDefaultMainLoopModel()})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

// @[MODEL LAUNCH]: Add a marketing name mapping for the new model below.
export function getMarketingNameForModel(modelId: string): string | undefined {
  if (getAPIProvider() === 'foundry') {
    // deployment ID is user-defined in Foundry, so it may have no relation to the actual model
    return undefined
  }

  const has1m = modelId.toLowerCase().includes('[1m]')
  const canonical = getCanonicalName(modelId)

  if (canonical.includes('claude-opus-4-8')) {
    return has1m ? 'Opus 4.8 (with 1M context)' : 'Opus 4.8'
  }
  if (canonical.includes('claude-opus-4-7')) {
    return has1m ? 'Opus 4.7 (with 1M context)' : 'Opus 4.7'
  }
  if (canonical.includes('claude-opus-4-6')) {
    return has1m ? 'Opus 4.6 (with 1M context)' : 'Opus 4.6'
  }
  if (canonical.includes('claude-opus-4-5')) {
    return 'Opus 4.5'
  }
  if (canonical.includes('claude-opus-4-1')) {
    return 'Opus 4.1'
  }
  if (canonical.includes('claude-opus-4')) {
    return 'Opus 4'
  }
  if (canonical.includes('claude-sonnet-4-6')) {
    return has1m ? 'Sonnet 4.6 (with 1M context)' : 'Sonnet 4.6'
  }
  if (canonical.includes('claude-sonnet-4-5')) {
    return has1m ? 'Sonnet 4.5 (with 1M context)' : 'Sonnet 4.5'
  }
  if (canonical.includes('claude-sonnet-4')) {
    return has1m ? 'Sonnet 4 (with 1M context)' : 'Sonnet 4'
  }
  if (canonical.includes('claude-3-7-sonnet')) {
    return 'Claude 3.7 Sonnet'
  }
  if (canonical.includes('claude-3-5-sonnet')) {
    return 'Claude 3.5 Sonnet'
  }
  if (canonical.includes('claude-haiku-4-5')) {
    return 'Haiku 4.5'
  }
  if (canonical.includes('claude-3-5-haiku')) {
    return 'Claude 3.5 Haiku'
  }

  return undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
