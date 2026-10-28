import {
  getModelStrings as getModelStringsState,
  setModelStrings as setModelStringsState,
} from 'src/bootstrap/state.js'
import { logError } from '../log.js'
import { sequential } from '../sequential.js'
import { getInitialSettings } from '../settings/settings.js'
import { findFirstMatch, getBedrockInferenceProfiles } from './bedrock.js'
import {
  CANONICAL_ID_TO_KEY,
  LEGACY_PROVIDER_MODEL_CONFIGS,
  type CanonicalModelId,
  type LegacyProviderModelConfig,
  type ModelKey,
} from './configs.js'
import { type LegacyAPIProvider, getAPIProvider } from './providers.js'

/**
 * Maps each model version to its provider-specific model ID string.
 * Derived from the legacy provider compatibility table — adding a model there
 * extends this type until descriptor-native callers fully replace it.
 */
export type ModelStrings = Record<ModelKey, string>

const MODEL_KEYS = Object.keys(LEGACY_PROVIDER_MODEL_CONFIGS) as ModelKey[]

function getBuiltinModelStrings(provider: LegacyAPIProvider): ModelStrings {
  // Codex piggybacks on the OpenAI provider transport for Anthropic tier aliases.
  // Reuse OpenAI mappings so model string lookups never return undefined.
  // Native Vertex resolves Gemini defaults in model.ts, outside this Claude
  // compatibility table. Keep canonical Claude IDs here so initializing its
  // display cache cannot poison a later switch back to built-in Anthropic.
  const providerKey = provider === 'gemini-vertex'
    ? 'firstParty'
    : provider === 'codex' || provider === 'github' ? 'openai' : provider
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    out[key] = (
      LEGACY_PROVIDER_MODEL_CONFIGS[key] as LegacyProviderModelConfig
    )[providerKey]
  }
  return out
}

async function getBedrockModelStrings(): Promise<ModelStrings> {
  const fallback = getBuiltinModelStrings('bedrock')
  let profiles: string[] | undefined
  try {
    profiles = await getBedrockInferenceProfiles()
  } catch (error) {
    logError(error as Error)
    return fallback
  }
  if (!profiles?.length) {
    return fallback
  }
  // Each config's firstParty ID is the canonical substring we search for in the
  // user's inference profile list (e.g. "claude-opus-4-6" matches
  // "eu.anthropic.claude-opus-4-6-v1"). Fall back to the hardcoded bedrock ID
  // when no matching profile is found.
  const out = {} as ModelStrings
  for (const key of MODEL_KEYS) {
    const needle = LEGACY_PROVIDER_MODEL_CONFIGS[key].firstParty
    out[key] = findFirstMatch(profiles, needle) || fallback[key]
  }
  return out
}

/**
 * Layer user-configured modelOverrides (from settings.json) on top of the
 * provider-derived model strings. Overrides are keyed by canonical first-party
 * model ID (e.g. "claude-opus-4-6") and map to arbitrary provider-specific
 * strings — typically Bedrock inference profile ARNs.
 */
function applyModelOverrides(ms: ModelStrings): ModelStrings {
  const overrides = getInitialSettings().modelOverrides
  if (!overrides) {
    return ms
  }
  const out = { ...ms }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    const key = CANONICAL_ID_TO_KEY[canonicalId as CanonicalModelId]
    if (key && override) {
      out[key] = override
    }
  }
  return out
}

/**
 * Resolve an overridden model ID (e.g. a Bedrock ARN) back to its canonical
 * first-party model ID. If the input doesn't match any current override value,
 * it is returned unchanged. Safe to call during module init (no-ops if settings
 * aren't loaded yet).
 */
export function resolveOverriddenModel(modelId: string): string {
  let overrides: Record<string, string> | undefined
  try {
    overrides = getInitialSettings().modelOverrides
  } catch {
    return modelId
  }
  if (!overrides) {
    return modelId
  }
  for (const [canonicalId, override] of Object.entries(overrides)) {
    if (override === modelId) {
      return canonicalId
    }
  }
  return modelId
}

const updateBedrockModelStrings = sequential(async () => {
  if (getModelStringsState() !== null) {
    // Already initialized. Doing the check here, combined with
    // `sequential`, allows the test suite to reset the state
    // between tests while still preventing multiple API calls
    // in production.
    return
  }
  try {
    const ms = await getBedrockModelStrings()
    setModelStringsState(ms)
  } catch (error) {
    logError(error as Error)
  }
})

function initModelStrings(): void {
  const ms = getModelStringsState()
  if (ms !== null) {
    // Already initialized
    return
  }
  // Initial with default values for non-Bedrock providers
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }
  // On Bedrock, update model strings in the background without blocking.
  // Don't set the state in this case so that we can use `sequential` on
  // `updateBedrockModelStrings` and check for existing state on multiple
  // calls.
  void updateBedrockModelStrings()
}

export function getModelStrings(): ModelStrings {
  const ms = getModelStringsState()
  if (ms === null) {
    initModelStrings()
    // Bedrock path falls through here while the profile fetch runs in the
    // background — still honor overrides on the interim defaults.
    return applyModelOverrides(getBuiltinModelStrings(getAPIProvider()))
  }
  return applyModelOverrides(ms)
}

/**
 * Ensure model strings are fully initialized.
 * For Bedrock users, this waits for the profile fetch to complete.
 * Call this before generating model options to ensure correct region strings.
 */
export async function ensureModelStringsInitialized(): Promise<void> {
  const ms = getModelStringsState()
  if (ms !== null) {
    return
  }

  // For non-Bedrock, initialize synchronously
  if (getAPIProvider() !== 'bedrock') {
    setModelStringsState(getBuiltinModelStrings(getAPIProvider()))
    return
  }

  // For Bedrock, wait for the profile fetch
  await updateBedrockModelStrings()
}
