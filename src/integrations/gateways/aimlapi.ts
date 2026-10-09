import { defineGateway } from '../define.js'
import { publicBuildVersion } from '../../utils/version.js'
import { withResolvedPartnerHeader } from '../aimlapi/config.js'

const AIMLAPI_CHAT_MODEL_TYPES = new Set([
  'openai/chat-completions',
  'chat-completion',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getTrimmedString(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' ? value.trim() : undefined
}

function mapAimlapiModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  const type = getTrimmedString(raw, 'type')
  if (!id || !type || !AIMLAPI_CHAT_MODEL_TYPES.has(type)) {
    return null
  }

  const info = isRecord(raw.info) ? raw.info : null
  const developer =
    getTrimmedString(info, 'developer') || getTrimmedString(raw, 'developer')
  const displayName = getTrimmedString(info, 'name')
  const label = displayName
    ? developer && !displayName.includes(`(${developer})`)
      ? `${displayName} (${developer})`
      : displayName
    : id
  const contextLength =
    typeof info?.contextLength === 'number'
      ? info.contextLength
      : typeof raw.contextLength === 'number'
        ? raw.contextLength
        : undefined

  return {
    id,
    apiName: id,
    label,
    ...(typeof contextLength === 'number' && contextLength > 0
      ? { contextWindow: contextLength }
      : {}),
  }
}

export default defineGateway({
  id: 'aimlapi',
  label: 'aimlapi.com',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.aimlapi.com/v1',
  defaultModel: 'gpt-4o',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['AIMLAPI_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      headers: withResolvedPartnerHeader({
        'X-AIMLAPI-Partner-ID': 'part_62yQoGYDq4Yqnrj2R1iGrDNJ',
        'X-AIMLAPI-Integration-Repo': 'Twigpine/openclaude',
        'X-AIMLAPI-Integration-Version': publicBuildVersion,
        // Attribution headers AI/ML API records for api.aimlapi.com requests
        // (issue #835). `HTTP-Referer`/`X-Title` identify the referring app.
        'HTTP-Referer': 'OpenClaude',
        'X-Title': 'OpenClaude',
      }),
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'aimlapi',
    description: '1,000+ models OpenAI compatible endpoint',
    badge: { text: 'Recommended', color: 'success' },
    apiKeyEnvVars: ['AIMLAPI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.aimlapi.com'],
    },
    credentialEnvVars: ['AIMLAPI_API_KEY', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'AI/ML API auth is required. Set AIMLAPI_API_KEY or OPENAI_API_KEY.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      requiresAuth: false,
      mapModel: mapAimlapiModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'startup',
    allowManualRefresh: true,
    models: [
      {
        id: 'aimlapi-gpt-4o',
        apiName: 'gpt-4o',
        label: 'GPT-4o',
        modelDescriptorId: 'gpt-4o',
      },
    ],
  },
  usage: { supported: false },
})
