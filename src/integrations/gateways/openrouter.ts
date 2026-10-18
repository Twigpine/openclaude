import { defineGateway } from '../define.js'
import type { ModelCatalogEntry } from '../descriptors.js'
import {
  firstPositiveNumber,
  getTrimmedString,
  isFreeModel,
  isKnownNonCodingModelId,
  isRecord,
} from '../modelMapping.js'

/**
 * Checks if the raw model payload declares support for tool/function calling
 * via the `supported_parameters` array.
 */
function supportsTools(raw: Record<string, unknown>): boolean {
  const params = raw.supported_parameters
  return Array.isArray(params) && params.some(value => value === 'tools')
}

/**
 * Checks if the raw model payload declares reasoning support.
 * Recognizes `reasoning`, `reasoning_effort`, `include_reasoning` in
 * `supported_parameters`, or a `reasoning` object with mandatory/default/enabled
 * flags or a non-empty `supported_efforts` array.
 */
function supportsReasoning(raw: Record<string, unknown>): boolean {
  const params = raw.supported_parameters
  if (
    Array.isArray(params) &&
    params.some(
      value =>
        value === 'reasoning' ||
        value === 'reasoning_effort' ||
        value === 'include_reasoning',
    )
  ) {
    return true
  }
  const reasoning = raw.reasoning
  if (reasoning === true) {
    return true
  }
  if (isRecord(reasoning)) {
    return (
      reasoning.mandatory === true ||
      reasoning.default_enabled === true ||
      (Array.isArray(reasoning.supported_efforts) &&
        reasoning.supported_efforts.length > 0)
    )
  }
  return false
}

/**
 * Map OpenRouter's public GET /api/v1/models payload into a catalog entry.
 * Keeps coding-capable chat models and drops embeddings/image/audio routes.
 */
export function mapOpenRouterModel(raw: unknown): ModelCatalogEntry | null {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || isKnownNonCodingModelId(id)) {
    return null
  }

  const architecture = isRecord(raw.architecture) ? raw.architecture : null
  const outputModalities = Array.isArray(architecture?.output_modalities)
    ? architecture.output_modalities.filter(
        (value): value is string => typeof value === 'string',
      )
    : []
  if (outputModalities.length > 0 && !outputModalities.includes('text')) {
    return null
  }

  const toolCall = supportsTools(raw)
  const reasoning = supportsReasoning(raw)
  const name = getTrimmedString(raw, 'name')
  const free = isFreeModel(id, raw)
  let label = name || id
  if (free && !label.toLowerCase().includes('free')) {
    label = `${label} (free)`
  }

  const contextWindow = firstPositiveNumber(
    raw.context_length,
    raw.max_context_length,
    raw.context_window,
    raw.contextWindow,
  )

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow ? { contextWindow } : {}),
    ...(free ? { notes: 'Free' } : {}),
    ...(toolCall || reasoning
      ? {
          capabilities: {
            ...(toolCall ? { supportsFunctionCalling: true } : {}),
            ...(reasoning ? { supportsReasoning: true } : {}),
          },
        }
      : {}),
  }
}

export default defineGateway({
  id: 'openrouter',
  label: 'OpenRouter',
  category: 'aggregating',
  defaultBaseUrl: 'https://openrouter.ai/api/v1',
  defaultModel: 'openai/gpt-5-mini',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPENROUTER_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
    },
  },
  preset: {
    id: 'openrouter',
    description: 'OpenRouter OpenAI-compatible endpoint',
    apiKeyEnvVars: ['OPENROUTER_API_KEY'],
    vendorId: 'openai',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // Public model list works without a key (same posture as cairn-code).
      requiresAuth: false,
      mapModel: mapOpenRouterModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      { id: 'openrouter-gpt-5-mini', apiName: 'openai/gpt-5-mini', label: 'GPT-5 Mini (via OpenRouter)', modelDescriptorId: 'gpt-5-mini' },
      { id: 'openrouter-grok-4.6', apiName: 'x-ai/grok-4.6', label: 'Grok 4.6 (via OpenRouter)', modelDescriptorId: 'grok-4.6' },
      { id: 'openrouter-grok-4.5', apiName: 'x-ai/grok-4.5', label: 'Grok 4.5 (via OpenRouter)', modelDescriptorId: 'grok-4.5' },
    ],
  },
  usage: { supported: false },
})
