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

/**
 * Map UberLLM's public GET /v1/models payload into a catalog entry.
 * UberLLM reports `type`, `available`, `context_length`, `max_output_tokens`
 * and boolean `supports_*` flags for each model.
 */
export function mapUberllmModel(raw: unknown): ModelCatalogEntry | null {
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

  const type = getTrimmedString(raw, 'type')
  if ((type && type !== 'chat') || raw.available === false) {
    return null
  }

  const toolCall = raw.supports_tools === true
  const reasoning = raw.supports_reasoning === true
  const contextWindow = firstPositiveNumber(raw.context_length)
  const maxOutputTokens = firstPositiveNumber(raw.max_output_tokens)

  return {
    id,
    apiName: id,
    label: id,
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
  id: 'uberllm',
  label: 'UberLLM',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.uberllm.dev/v1',
  defaultModel: 'deepseek/deepseek-v4-flash',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['UBERLLM_API_KEY'],
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
    id: 'uberllm',
    description: 'UberLLM OpenAI-compatible gateway',
    apiKeyEnvVars: ['UBERLLM_API_KEY'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.uberllm.dev'],
    },
    credentialEnvVars: ['UBERLLM_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Set UBERLLM_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY for the UberLLM gateway.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // The public model list works without a key; inference still needs one.
      requiresAuth: false,
      mapModel: mapUberllmModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      { id: 'uberllm-deepseek-v4-flash', apiName: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash (via UberLLM)', modelDescriptorId: 'deepseek-v4-flash' },
      { id: 'uberllm-claude-sonnet-4-6', apiName: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (via UberLLM)', modelDescriptorId: 'claude-sonnet-4-6' },
      { id: 'uberllm-gpt-5.5', apiName: 'openai/gpt-5.5', label: 'GPT-5.5 (via UberLLM)', modelDescriptorId: 'gpt-5.5' },
    ],
  },
  usage: { supported: false },
})
