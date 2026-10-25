// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider, isFirstPartyAnthropicProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'
import { getModelStrings } from './modelStrings.js'
import { getCachedOllamaModelOptions, isOllamaProvider } from './ollamaModels.js'
import {
  getCachedNvidiaNimModelOptions,
  getDiscoveredNvidiaNimModelIds,
  isNvidiaNimProvider,
} from './nvidiaNimModels.js'
import { getCachedMiniMaxModelOptions, isKnownMiniMaxModel, isMiniMaxProvider } from './minimaxModels.js'

// Cache valid models to avoid repeated API calls
const validModelCache = new Map<string, boolean>()

/**
 * Validates a model by attempting an actual API call.
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // Empty model is invalid
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // For Ollama provider, validate against cached model list instead of API call
  // (skip enterprise allowlist since Ollama models are user-managed)
  if (getAPIProvider() === 'openai' && isOllamaProvider()) {
    const ollamaModels = getCachedOllamaModelOptions()
    const found = ollamaModels.some(m => m.value === normalizedModel)
    if (found) {
      validModelCache.set(normalizedModel, true)
      return { valid: true }
    }
    if (ollamaModels.length > 0) {
      const MAX_SHOWN = 5
      const names = ollamaModels.map(m => m.value)
      const shown = names.slice(0, MAX_SHOWN).join(', ')
      const suffix = names.length > MAX_SHOWN ? ` and ${names.length - MAX_SHOWN} more` : ''
      return { valid: false, error: `Model '${normalizedModel}' not found on Ollama server. Available: ${shown}${suffix}` }
    }
    // If cache is empty, fall through to API validation
  }

  // For NVIDIA NIM provider, validate against cached model list (static
  // catalog first, then the persisted discovery cache so that ids surfaced
  // only via dynamic discovery are still accepted on the inline `/model <id>`
  // path).
  if (isNvidiaNimProvider()) {
    const nvidiaModels = getCachedNvidiaNimModelOptions()
    if (nvidiaModels.some(m => m.value === normalizedModel)) {
      validModelCache.set(normalizedModel, true)
      return { valid: true }
    }
    const discoveredIds = await getDiscoveredNvidiaNimModelIds()
    if (discoveredIds.includes(normalizedModel)) {
      validModelCache.set(normalizedModel, true)
      return { valid: true }
    }
    if (nvidiaModels.length > 0 || discoveredIds.length > 0) {
      const names = [
        ...nvidiaModels.map(m => m.value),
        ...discoveredIds.filter(
          id => !nvidiaModels.some(m => m.value === id),
        ),
      ]
      const MAX_SHOWN = 5
      const shown = names.slice(0, MAX_SHOWN).join(', ')
      const suffix =
        names.length > MAX_SHOWN ? ` and ${names.length - MAX_SHOWN} more` : ''
      return {
        valid: false,
        error: `Model '${normalizedModel}' not found in NVIDIA NIM catalog. Available: ${shown}${suffix}`,
      }
    }
  }

  // Known explicit IDs are independent of the filtered picker suggestions.
  if (isMiniMaxProvider()) {
    const minimaxModels = getCachedMiniMaxModelOptions()
    const found = isKnownMiniMaxModel(normalizedModel)
    if (found) {
      validModelCache.set(normalizedModel, true)
      return { valid: true }
    }
    if (minimaxModels.length > 0) {
      const MAX_SHOWN = 5
      const names = minimaxModels.map(m => m.value)
      const shown = names.slice(0, MAX_SHOWN).join(', ')
      const suffix = names.length > MAX_SHOWN ? ` and ${names.length - MAX_SHOWN} more` : ''
      return { valid: false, error: `Model '${normalizedModel}' not found in MiniMax catalog. Available: ${shown}${suffix}` }
    }
  }

  // Check against availableModels allowlist before any API call
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // Check if it's a known alias (these are always valid)
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // Check if it matches ANTHROPIC_CUSTOM_MODEL_OPTION (pre-validated by the user)
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // Check cache first
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }


  // Try to make an actual API call with minimal parameters
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // If we got here, the model is valid
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    return handleValidationError(error, normalizedModel)
  }
}

function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // NotFoundError (404) means the model doesn't exist
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
    }
  }

  // For other API errors, provide context-specific messages
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // Check error body for model-specific errors
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // Generic API error
    return { valid: false, error: `API error: ${error.message}` }
  }

  // For unknown errors, be safe and reject
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * Suggest a fallback model for 3P users when the selected model is unavailable.
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  if (isFirstPartyAnthropicProvider()) {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  if (lowerModel.includes('opus-4-8') || lowerModel.includes('opus_4_8')) {
    return getModelStrings().opus47
  }
  if (lowerModel.includes('opus-4-7') || lowerModel.includes('opus_4_7')) {
    return getModelStrings().opus46
  }
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}
