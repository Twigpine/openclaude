// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { resolveModelRuntimeLimits } from '../integrations/runtimeMetadata.js'
import {
  getTransportKindForRoute,
  resolveActiveRouteIdFromEnv,
} from '../integrations/routeMetadata.js'
import { getCanonicalName } from './model/model.js'
import { getModelCapability } from './model/modelCapabilities.js'
import { resolveAntModel } from './model/antModels.js'
import { getActiveProviderProfile } from './providerProfiles.js'

// Model context window size (200k tokens for all models right now)
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000

// Fallback context window for unknown 3P models. Must be large enough that
// the effective context (this minus output token reservation) stays positive,
// otherwise auto-compact fires on every message (issue #635).
// Override via CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW env var to avoid
// hardcoding when deploying models not yet in integration model metadata.
export const OPENAI_FALLBACK_CONTEXT_WINDOW = (() => {
  const v = parseInt(process.env.CLAUDE_CODE_OPENAI_FALLBACK_CONTEXT_WINDOW ?? '', 10)
  return !isNaN(v) && v > 0 ? v : 128_000
})()

// Maximum output tokens for compact operations
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000

// Default max output tokens
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000

// Capped default for slot-reservation optimization. BQ p99 output = 4,911
// tokens, so 32k/64k defaults over-reserve 8-16× slot capacity. With the cap
// enabled, <1% of requests hit the limit; those get one clean retry at 64k
// (see query.ts max_output_tokens_escalate). Cap is applied in
// claude.ts:getMaxOutputTokensForModel to avoid the growthbook→betas→context
// import cycle.
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

const warnedUnknownIntegrationRuntimeLimitKeys = new Set<string>()
const PROFILE_ENV_APPLIED_FLAG = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED'
const PROFILE_ENV_APPLIED_ID = 'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID'

// Session-scoped context window overrides (abordagem C: module-level state)
// Key: normalized model name (lowercase, prefix stripped)
// Value: context window in tokens
const sessionContextWindowOverrides = new Map<string, number>()

// Minimum context window to avoid auto-compact floor paradox
// (reservedTokensForSummary + autocompactBuffer = 20k + 13k = 33k)
const MIN_CONTEXT_WINDOW_OVERRIDE = 33_000

/**
 * Normalize a model name for override lookup to get a single canonical key
 * for the model family (lowercase, prefix stripped).
 */
function normalizeModelName(model: string): string {
  const lowered = model.toLowerCase()
  const stripped = stripProviderPrefix(lowered)
  return stripped !== undefined ? stripped : lowered
}

/**
 * Strip a leading provider prefix (e.g. openai/, anthropic/) for fallback lookup.
 */
function stripProviderPrefix(model: string): string | undefined {
  const stripped = model.replace(/^[a-z][\w-]*\//, '')
  return stripped !== model ? stripped : undefined
}

/**
 * Set a session-scoped context window override for a specific model.
 * Used by the /set_context_window slash command.
 * The override is in-memory only and dies with the session.
 *
 * Returns the normalized model key used for storage.
 */
export function setSessionContextWindowOverride(
  model: string,
  tokens: number,
): { ok: true; normalizedModel: string } | { ok: false; error: string } {
  if (!Number.isFinite(tokens) || !Number.isInteger(tokens) || tokens <= 0) {
    return { ok: false, error: 'Context window must be a positive integer' }
  }
  if (tokens < MIN_CONTEXT_WINDOW_OVERRIDE) {
    return {
      ok: false,
      error: `Context window must be at least ${MIN_CONTEXT_WINDOW_OVERRIDE} tokens (current: ${tokens})`,
    }
  }
  const normalized = normalizeModelName(model)
  sessionContextWindowOverrides.set(normalized, tokens)
  return { ok: true, normalizedModel: normalized }
}

/**
 * Clear session-scoped context window overrides.
 * If model is provided, clears the canonical key for the model family.
 * If model is omitted, clears all overrides.
 */
export function clearSessionContextWindowOverride(model?: string): void {
  if (model) {
    const normalized = normalizeModelName(model)
    sessionContextWindowOverrides.delete(normalized)
  } else {
    sessionContextWindowOverrides.clear()
  }
}

/**
 * Get the current session-scoped context window override for a model, if any.
 * Resolves to the canonical key for the model family.
 */
export function getSessionContextWindowOverride(
  model: string,
): number | undefined {
  const normalized = normalizeModelName(model)
  return sessionContextWindowOverrides.get(normalized)
}

/**
 * Get all current session-scoped context window overrides.
 * Returns a copy of the internal map.
 */
export function getSessionContextWindowOverrides(): Map<string, number> {
  return new Map(sessionContextWindowOverrides)
}

/**
 * Check if 1M context is disabled via environment variable.
 * Used by C4E admins to disable 1M context for HIPAA compliance.
 */
export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)
}

export function has1mContext(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  return /\[1m\]/i.test(model)
}

// @[MODEL LAUNCH]: Update this pattern if the new model supports 1M context
export function modelSupports1M(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('claude-sonnet-4') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-8')
  )
}

function getAppliedActiveProfileProvider(
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (processEnv[PROFILE_ENV_APPLIED_FLAG] !== '1') {
    return undefined
  }

  const activeProfile = getActiveProviderProfile()
  if (!activeProfile) {
    return undefined
  }

  const appliedId = processEnv[PROFILE_ENV_APPLIED_ID]?.trim()
  if (appliedId && appliedId !== activeProfile.id) {
    return undefined
  }

  return activeProfile.provider
}

export function shouldUseIntegrationRuntimeLimits(
  processEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const routeId = resolveActiveRouteIdFromEnv(processEnv, {
    activeProfileProvider: getAppliedActiveProfileProvider(processEnv),
  })
  const transportKind = routeId ? getTransportKindForRoute(routeId) : null

  return (
    transportKind === 'openai-compatible' ||
    transportKind === 'anthropic-proxy' ||
    transportKind === 'local' ||
    transportKind === 'gemini-native'
  )
}

/**
 * Emit one debug-only metadata fallback warning per active route/model pair.
 *
 * Unknown runtime metadata is recoverable because the fallback context window
 * keeps compaction budgets positive. Keep this out of console.error because
 * the Ink runtime treats console errors as application errors.
 */
function warnUnknownIntegrationRuntimeLimits(model: string): void {
  const routeId =
    resolveActiveRouteIdFromEnv(process.env, {
      activeProfileProvider: getAppliedActiveProfileProvider(process.env),
    }) ?? 'unknown-route'
  const warningKey = `${routeId}:${model}`
  if (warnedUnknownIntegrationRuntimeLimitKeys.has(warningKey)) return

  warnedUnknownIntegrationRuntimeLimitKeys.add(warningKey)
  logForDebugging(
    `[context] Warning: model "${model}" not in integration model metadata for route "${routeId}" — ` +
      `using fallback ${OPENAI_FALLBACK_CONTEXT_WINDOW} token context window. ` +
      'Add it to src/integrations/models for accurate compaction.',
    { level: 'warn' },
  )
}

export function getContextWindowForModel(
  model: string,
  betas?: string[],
  runtimeLimits?: { contextWindow?: number },
): number {
  // Allow override via environment variable (internal-only)
  // This takes precedence over all other context window resolution, including 1M detection,
  // so users can cap the effective context window for local decisions (auto-compact, etc.)
  // while still using a 1M-capable endpoint.
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  ) {
    const override = parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, 10)
    if (!isNaN(override) && override > 0) {
      return override
    }
  }

  // Session-scoped override — set via /set_context_window command.
  // Takes precedence over all resolution except the internal env var above.
  const sessionOverride = getSessionContextWindowOverride(model)
  if (sessionOverride !== undefined) {
    return sessionOverride
  }

  // [1m] suffix — explicit client-side opt-in, respected over all detection
  if (has1mContext(model)) {
    return 1_000_000
  }

  // OpenAI-compatible provider — use known context windows for the model.
  // Unknown models get a conservative 128k default. This was previously 8k,
  // but that caused auto-compact to fire on every turn because the effective
  // context (8k minus output reservation) became negative (issue #635).
  if (runtimeLimits?.contextWindow !== undefined || shouldUseIntegrationRuntimeLimits()) {
    const resolvedRuntimeLimits = runtimeLimits ?? resolveModelRuntimeLimits({
      model,
      activeProfileProvider: getAppliedActiveProfileProvider(),
    })
    if (resolvedRuntimeLimits.contextWindow !== undefined) {
      return resolvedRuntimeLimits.contextWindow
    }
    warnUnknownIntegrationRuntimeLimits(model)
    return OPENAI_FALLBACK_CONTEXT_WINDOW
  }

  const cap = getModelCapability(model)
  if (cap?.max_input_tokens && cap.max_input_tokens >= 100_000) {
    if (
      cap.max_input_tokens > MODEL_CONTEXT_WINDOW_DEFAULT &&
      is1mContextDisabled()
    ) {
      return MODEL_CONTEXT_WINDOW_DEFAULT
    }
    return cap.max_input_tokens
  }

  if (betas?.includes(CONTEXT_1M_BETA_HEADER) && modelSupports1M(model)) {
    return 1_000_000
  }
  if (getSonnet1mExpTreatmentEnabled(model)) {
    return 1_000_000
  }
  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model)
    if (antModel?.contextWindow) {
      return antModel.contextWindow
    }
  }
  return MODEL_CONTEXT_WINDOW_DEFAULT
}

export function getSonnet1mExpTreatmentEnabled(model: string): boolean {
  if (is1mContextDisabled()) {
    return false
  }
  // Only applies to sonnet 4.6 without an explicit [1m] suffix
  if (has1mContext(model)) {
    return false
  }
  if (!getCanonicalName(model).includes('sonnet-4-6')) {
    return false
  }
  return getGlobalConfig().clientDataCache?.['coral_reef_sonnet'] === 'true'
}

/**
 * Calculate context window usage percentage from token usage data.
 * Returns used and remaining percentages, or null values if no usage data.
 */
export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) {
    return { used: null, remaining: null }
  }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens

  const rawUsedPercentage = (totalInputTokens / contextWindowSize) * 100
  const usedPercentage =
    rawUsedPercentage > 0 && rawUsedPercentage < 0.01
      ? 0.01
      : Math.round(rawUsedPercentage * 100) / 100
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))

  return {
    used: clampedUsed,
    remaining: Math.max(0, Math.round((100 - clampedUsed) * 100) / 100),
  }
}

/**
 * Returns the model's default and upper limit for max output tokens.
 */
export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  let defaultTokens: number
  let upperLimit: number

  if (process.env.USER_TYPE === 'ant') {
    const antModel = resolveAntModel(model.toLowerCase())
    if (antModel) {
      defaultTokens = antModel.defaultMaxTokens ?? MAX_OUTPUT_TOKENS_DEFAULT
      upperLimit = antModel.upperMaxTokensLimit ?? MAX_OUTPUT_TOKENS_UPPER_LIMIT
      return { default: defaultTokens, upperLimit }
    }
  }

  // OpenAI-compatible provider — use known output limits to avoid 400 errors
  if (shouldUseIntegrationRuntimeLimits()) {
    const runtimeLimits = resolveModelRuntimeLimits({
      model,
      activeProfileProvider: getAppliedActiveProfileProvider(),
    })
    if (runtimeLimits.maxOutputTokens !== undefined) {
      return {
        default: runtimeLimits.maxOutputTokens,
        upperLimit: runtimeLimits.maxOutputTokens,
      }
    }
    // 3P provider with no runtime maxOutputTokens (e.g. ad-hoc Ollama models
    // like `gemma4:e4b` not in the route catalog) — fall through to a
    // permissive upper limit so CLAUDE_CODE_MAX_OUTPUT_TOKENS isn't silently
    // capped to the Anthropic 64k fallback below (issue #1604). Bound by the
    // runtime context window when known; otherwise use the same fallback as
    // context budgeting so output reservation cannot exceed the window.
    return {
      default: MAX_OUTPUT_TOKENS_DEFAULT,
      upperLimit: runtimeLimits.contextWindow ?? OPENAI_FALLBACK_CONTEXT_WINDOW,
    }
  }

  const m = getCanonicalName(model)

  if (
    m.includes('opus-4-8') ||
    m.includes('opus-4-7') ||
    m.includes('opus-4-6')
  ) {
    defaultTokens = 64_000
    upperLimit = 128_000
  } else if (m.includes('sonnet-4-6')) {
    defaultTokens = 32_000
    upperLimit = 128_000
  } else if (
    m.includes('opus-4-5') ||
    m.includes('sonnet-4') ||
    m.includes('haiku-4')
  ) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else if (m.includes('opus-4-1') || m.includes('opus-4')) {
    defaultTokens = 32_000
    upperLimit = 32_000
  } else if (m.includes('claude-3-opus')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('claude-3-sonnet')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('claude-3-haiku')) {
    defaultTokens = 4_096
    upperLimit = 4_096
  } else if (m.includes('3-5-sonnet') || m.includes('3-5-haiku')) {
    defaultTokens = 8_192
    upperLimit = 8_192
  } else if (m.includes('3-7-sonnet')) {
    defaultTokens = 32_000
    upperLimit = 64_000
  } else {
    defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT
    upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT
  }

  const cap = getModelCapability(model)
  if (cap?.max_tokens && cap.max_tokens >= 4_096) {
    upperLimit = cap.max_tokens
    defaultTokens = Math.min(defaultTokens, upperLimit)
  }

  return { default: defaultTokens, upperLimit }
}

/**
 * Returns the max thinking budget tokens for a given model. The max
 * thinking tokens should be strictly less than the max output tokens.
 *
 * Deprecated since newer models use adaptive thinking rather than a
 * strict thinking token budget.
 */
export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}
