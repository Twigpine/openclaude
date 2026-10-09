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
 * Map Requesty's public GET /v1/models payload into a catalog entry.
 * Requesty reports `context_window`, `max_output_tokens` and boolean
 * `supports_*` flags instead of OpenRouter's `context_length` and
 * `supported_parameters`.
 */
export function mapRequestyModel(raw: unknown): ModelCatalogEntry | null {
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

  const api = getTrimmedString(raw, 'api')
  if (api && api !== 'chat') {
    return null
  }

  const toolCall = raw.supports_tool_calling === true
  const reasoning = raw.supports_reasoning === true
  const contextWindow = firstPositiveNumber(raw.context_window)
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
  id: 'requesty',
  label: 'Requesty',
  category: 'aggregating',
  defaultBaseUrl: 'https://router.requesty.ai/v1',
  defaultModel: 'openai/gpt-5-mini',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['REQUESTY_API_KEY'],
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
    id: 'requesty',
    description: 'Requesty OpenAI-compatible gateway',
    apiKeyEnvVars: ['REQUESTY_API_KEY'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: [
        'router.requesty.ai',
        'router.eu.requesty.ai',
        'router.us.requesty.ai',
        'router.ap.requesty.ai',
      ],
    },
    credentialEnvVars: ['REQUESTY_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Set REQUESTY_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY for the Requesty gateway.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      // The public model list works without a key; inference still needs one.
      requiresAuth: false,
      mapModel: mapRequestyModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      { id: 'requesty-gpt-5-mini', apiName: 'openai/gpt-5-mini', label: 'GPT-5 Mini (via Requesty)', modelDescriptorId: 'gpt-5-mini' },
      { id: 'requesty-claude-sonnet-4-6', apiName: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (via Requesty)', modelDescriptorId: 'claude-sonnet-4-6' },
      { id: 'requesty-grok-4.6', apiName: 'xai/grok-4.6', label: 'Grok 4.6 (via Requesty)', modelDescriptorId: 'grok-4.6' },
    ],
  },
  usage: { supported: false },
})
