import { defineCatalog, defineGateway } from '../define.js'

const NON_CHAT_MODEL_PATTERN =
  /(embed|clip-vit|rerank|whisper|moderation|guard|video|(^|[-_/.])(tts|image)($|[-_/.]))/i

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

export function mapGmiCloudModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || NON_CHAT_MODEL_PATTERN.test(id)) {
    return null
  }

  const label =
    getTrimmedString(raw, 'display_name') || getTrimmedString(raw, 'name') || id
  const contextWindow =
    getPositiveInteger(raw.context_length) ??
    getPositiveInteger(raw.context_window)
  const maxOutputTokens =
    getPositiveInteger(raw.max_output_tokens) ??
    getPositiveInteger(raw.max_completion_tokens)

  return {
    id,
    apiName: id,
    label,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

// Qwen 3.8 first (the models GMI Cloud partners with), then the DeepSeek V4
// coding picks from https://docs.gmicloud.ai/coding-tools/opencode. All four
// are served by GMI's /v1/models; the rest of the catalog comes from discovery.
const curatedModels = [
  {
    id: 'Qwen/Qwen3.8-Max',
    apiName: 'Qwen/Qwen3.8-Max',
    aliases: ['qwen3.8-max'],
    modelDescriptorId: 'qwen3.8-max',
    label: 'Qwen 3.8 Max',
  },
  {
    id: 'Qwen/Qwen3.8-Flash',
    apiName: 'Qwen/Qwen3.8-Flash',
    aliases: ['qwen3.8-flash'],
    modelDescriptorId: 'qwen3.8-flash',
    label: 'Qwen 3.8 Flash',
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Pro',
    apiName: 'deepseek-ai/DeepSeek-V4-Pro',
    aliases: ['deepseek-v4-pro'],
    modelDescriptorId: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
  },
  {
    id: 'deepseek-ai/DeepSeek-V4-Flash',
    apiName: 'deepseek-ai/DeepSeek-V4-Flash',
    aliases: ['deepseek-v4-flash'],
    modelDescriptorId: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
  },
]

const catalog = defineCatalog({
  // /v1/models requires a Bearer key; the curated ids stay visible before
  // discovery and when a refresh fails.
  source: 'hybrid',
  discovery: {
    kind: 'openai-compatible',
    requiresAuth: true,
    mapModel: mapGmiCloudModel,
  },
  discoveryCacheTtl: '1d',
  discoveryRefreshMode: 'background-if-stale',
  allowManualRefresh: true,
  models: [...curatedModels],
})

export default defineGateway({
  id: 'gmi-cloud',
  label: 'GMI Cloud',
  vendorId: 'openai',
  category: 'hosted',
  defaultBaseUrl: 'https://api.gmi-serving.com/v1',
  defaultModel: 'Qwen/Qwen3.8-Max',
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['GMI_API_KEY'],
    dedicatedCredentialsOnly: true,
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      // Bearer-only chat completions; GMI's reference documents max_tokens.
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'gmi-cloud',
    vendorId: 'openai',
    description: 'GMI Cloud inference (OpenAI-compatible)',
    apiKeyEnvVars: ['GMI_API_KEY'],
    modelEnvVars: ['GMI_MODEL', 'OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    // No host-level match: the same host also serves GMI's
    // Anthropic-compatible API, which must stay a custom Anthropic endpoint.
    routing: {
      matchDefaultBaseUrl: true,
    },
    credentialEnvVars: ['GMI_API_KEY'],
    missingCredentialMessage:
      'GMI Cloud auth is required. Set GMI_API_KEY.',
  },
  catalog,
  usage: { supported: false },
})
