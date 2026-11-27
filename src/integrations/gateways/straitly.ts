import { defineGateway } from '../define.js'
import type { ModelCatalogEntry } from '../descriptors.js'
import {
  firstPositiveNumber,
  getTrimmedString,
  isKnownNonCodingModelId,
  isRecord,
} from '../modelMapping.js'

// Model ids are rendered in the model picker. Drop anything carrying control
// characters (including ESC for ANSI sequences) instead of trying to clean it.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/

function supportsTools(raw: Record<string, unknown>): boolean {
  const params = raw.supported_parameters
  return Array.isArray(params) && params.some(value => value === 'tools')
}

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
  const catalog = isRecord(raw.catalog) ? raw.catalog : null
  return catalog?.reasoning === true
}

/**
 * Map Straitly's public GET /v1/models payload into a catalog entry.
 * Keeps text-output coding-capable chat models and drops control characters
 * and known non-coding routes.
 */
export function mapStraitlyModel(raw: unknown): ModelCatalogEntry | null {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (
    !id ||
    CONTROL_CHARACTER_PATTERN.test(id) ||
    isKnownNonCodingModelId(id)
  ) {
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

  const topProvider = isRecord(raw.top_provider) ? raw.top_provider : null
  const catalog = isRecord(raw.catalog) ? raw.catalog : null
  const rawName = getTrimmedString(raw, 'name')
  const label =
    rawName && !CONTROL_CHARACTER_PATTERN.test(rawName) ? rawName : id

  const contextWindow = firstPositiveNumber(
    raw.context_length,
    topProvider?.context_length,
    raw.context_window,
  )
  const maxOutputTokens = firstPositiveNumber(
    topProvider?.max_completion_tokens,
    catalog?.max_output_tokens,
    raw.max_output_tokens,
  )

  const toolCall = supportsTools(raw)
  const reasoning = supportsReasoning(raw)

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
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
  id: 'straitly',
  label: 'Straitly',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.straitly.ai/v1',
  defaultModel: 'deepseek/deepseek-v4-1-flash-1017',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['STRAITLY_API_KEY'],
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
    id: 'straitly',
    description: 'Straitly OpenAI-compatible gateway',
    apiKeyEnvVars: ['STRAITLY_API_KEY'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.straitly.ai'],
    },
    credentialEnvVars: ['STRAITLY_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Set STRAITLY_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY for the Straitly gateway.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // The public model list works without a key; inference still needs one.
      requiresAuth: false,
      mapModel: mapStraitlyModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      {
        id: 'straitly-deepseek-v4-1-flash-1017',
        apiName: 'deepseek/deepseek-v4-1-flash-1017',
        label: 'DeepSeek V4.1 Flash 1017 (via Straitly)',
        contextWindow: 1_048_576,
      },
      {
        id: 'straitly-claude-sonnet-5-5',
        apiName: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5 (via Straitly)',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
      },
      {
        id: 'straitly-gpt-6.1-sol',
        apiName: 'gpt-6.1-sol',
        label: 'GPT-6.1 Sol (via Straitly)',
        contextWindow: 1_050_000,
        maxOutputTokens: 128_000,
      },
    ],
  },
  usage: { supported: false },
})
