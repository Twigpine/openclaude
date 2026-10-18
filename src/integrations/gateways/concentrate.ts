import { defineGateway } from '../define.js'

const NON_CHAT_MODEL_PATTERN =
  /redact|safeguard|embed|embedding|whisper|tts|dall-e|rerank|moderation|image-generation|video-generation|audio-generation/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getTrimmedString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : undefined
}

function getPositiveInteger(value: unknown): number | undefined {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  ) {
    return value
  }
  return undefined
}

function mapConcentrateModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || NON_CHAT_MODEL_PATTERN.test(id)) {
    return null
  }

  const displayName = getTrimmedString(raw, 'display_name')
  const label = displayName || id
  const contextWindow = getPositiveInteger(raw.max_input_tokens)
  const maxOutputTokens = getPositiveInteger(raw.max_tokens)

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

export default defineGateway({
  id: 'concentrate',
  label: 'Concentrate',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.concentrate.ai/v1',
  defaultModel: 'deepseek-v4-flash',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['CONCENTRATE_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'concentrate',
    description: 'Concentrate AI — 150+ models via OpenAI-compatible API',
    vendorId: 'openai',
    apiKeyEnvVars: ['CONCENTRATE_API_KEY'],
    baseUrlEnvVars: ['CONCENTRATE_BASE_URL'],
    modelEnvVars: ['CONCENTRATE_MODEL', 'OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.concentrate.ai'],
    },
    credentialEnvVars: [
      'CONCENTRATE_API_KEY',
      'OPENAI_API_KEYS',
      'OPENAI_API_KEY',
    ],
    missingCredentialMessage:
      'Concentrate auth is required. Set CONCENTRATE_API_KEY or OPENAI_API_KEY.',
  },
  catalog: {
    source: 'dynamic',
    discovery: {
      kind: 'openai-compatible',
      requiresAuth: false,
      mapModel: mapConcentrateModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'startup',
    allowManualRefresh: true,
  },
  usage: { supported: false },
})
