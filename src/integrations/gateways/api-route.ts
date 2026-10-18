import { defineCatalog, defineGateway } from '../define.js'

const NON_CHAT_MODEL_PATTERN =
  /(embedding|embed|dall-e|whisper|tts|rerank|moderation|omni-moderation|audio|^gpt-image-|^sora-|^veo-)/i


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

export function mapApiRouteModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || NON_CHAT_MODEL_PATTERN.test(id)) {
    return null
  }

  const name = getTrimmedString(raw, 'name')
  const ownedBy =
    getTrimmedString(raw, 'owned_by') || getTrimmedString(raw, 'ownedBy')
  const label = name || (ownedBy ? `${id} (${ownedBy})` : id)
  const contextWindow =
    getPositiveInteger(raw.context_length) ??
    getPositiveInteger(raw.context_window)

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  }
}

const curatedModels = [
  {
    id: 'claude-sonnet-4-6',
    apiName: 'claude-sonnet-4-6',
    aliases: ['sonnet-4.6', 'claude-sonnet'],
    modelDescriptorId: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
  },
]

const catalog = defineCatalog({
  source: 'hybrid',
  discovery: {
    kind: 'openai-compatible',
    requiresAuth: true,
    mapModel: mapApiRouteModel,
  },
  discoveryCacheTtl: '1d',
  discoveryRefreshMode: 'background-if-stale',
  allowManualRefresh: true,
  models: [...curatedModels],
})

export default defineGateway({
  id: 'api-route',
  label: 'API Route',
  category: 'aggregating',
  defaultBaseUrl: 'https://global.api-route.com/v1',
  defaultModel: 'claude-sonnet-4-6',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['API_ROUTE_API_KEY'],
    dedicatedCredentialsOnly: false,
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
    id: 'api-route',
    description: 'API Route OpenAI-compatible multi-model gateway',
    vendorId: 'openai',
    apiKeyEnvVars: ['API_ROUTE_API_KEY'],
    modelEnvVars: ['API_ROUTE_MODEL', 'OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['global.api-route.com'],
    },
    credentialEnvVars: ['API_ROUTE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'API Route auth is required. Set API_ROUTE_API_KEY.',
  },
  catalog,
  usage: { supported: false },
})
