import { defineGateway } from '../define.js'

const NON_CHAT_MODEL_PATTERN =
  /(seedream|seedance|happyhorse|image|video|vision-preview)/i

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

function mapApismartModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || NON_CHAT_MODEL_PATTERN.test(id)) {
    return null
  }

  const ownedBy =
    getTrimmedString(raw, 'owned_by') || getTrimmedString(raw, 'ownedBy')
  const label = ownedBy ? `${id} (${ownedBy})` : id

  return {
    id,
    apiName: id,
    label,
  }
}

// Curated from https://www.apismart.ai/models (PAGE_MODEL_LIST LLM entries).
// Exact Model IDs are case-sensitive per ApiSmart docs.
const curatedModels = [
  {
    id: 'DEEPSEEK_V4_FLASH',
    apiName: 'DEEPSEEK_V4_FLASH',
    aliases: ['deepseek-v4-flash'],
    modelDescriptorId: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
  },
  {
    id: 'DEEPSEEK_V4_PRO',
    apiName: 'DEEPSEEK_V4_PRO',
    aliases: ['deepseek-v4-pro'],
    modelDescriptorId: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'DEEPSEEK_V3_2',
    apiName: 'DEEPSEEK_V3_2',
    aliases: ['deepseek-v3.2'],
    modelDescriptorId: 'deepseek-ai/deepseek-v3.2',
    label: 'DeepSeek V3.2',
    contextWindow: 131_072,
    maxOutputTokens: 8_192,
  },
  {
    id: 'KIMI_K2_6',
    apiName: 'KIMI_K2_6',
    aliases: ['kimi-k2.6'],
    modelDescriptorId: 'kimi-k2.6',
    label: 'Kimi K2.6',
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
  },
  {
    id: 'KIMI_K2_5',
    apiName: 'KIMI_K2_5',
    aliases: ['kimi-k2.5'],
    modelDescriptorId: 'kimi-k2.5',
    label: 'Kimi K2.5',
    contextWindow: 262_144,
    maxOutputTokens: 16_384,
  },
  {
    id: 'KIMI_K3',
    apiName: 'KIMI_K3',
    aliases: ['kimi-k3', 'k3'],
    modelDescriptorId: 'k3',
    label: 'Kimi K3',
    contextWindow: 1_075_200,
    maxOutputTokens: 8_192,
  },
  {
    id: 'GLM_5.2',
    apiName: 'GLM_5.2',
    aliases: ['glm-5.2'],
    modelDescriptorId: 'glm-5.2',
    label: 'GLM 5.2',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'GLM_5_1',
    apiName: 'GLM_5_1',
    aliases: ['glm-5.1'],
    modelDescriptorId: 'glm-5.1',
    label: 'GLM 5.1',
    contextWindow: 204_800,
    maxOutputTokens: 16_384,
  },
  {
    id: 'GLM_5',
    apiName: 'GLM_5',
    aliases: ['glm-5'],
    modelDescriptorId: 'glm-5',
    label: 'GLM 5',
    contextWindow: 209_920,
    maxOutputTokens: 16_384,
  },
  {
    id: 'QWEN_3_7_MAX',
    apiName: 'QWEN_3_7_MAX',
    aliases: ['qwen3.7-max'],
    modelDescriptorId: 'qwen3.7-max',
    label: 'Qwen 3.7 Max',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'QWEN_3_6_PLUS',
    apiName: 'QWEN_3_6_PLUS',
    aliases: ['qwen3.6-plus'],
    modelDescriptorId: 'qwen3.6-plus',
    label: 'Qwen 3.6 Plus',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'MINIMAX_M3',
    apiName: 'MINIMAX_M3',
    aliases: ['minimax-m3'],
    modelDescriptorId: 'minimax-m3',
    label: 'MiniMax M3',
    contextWindow: 1_048_576,
    maxOutputTokens: 16_384,
  },
  {
    id: 'MINIMAX_M2_5',
    apiName: 'MINIMAX_M2_5',
    aliases: ['minimax-m2.5'],
    modelDescriptorId: 'minimax-m2.5',
    label: 'MiniMax M2.5',
    contextWindow: 200_704,
    maxOutputTokens: 16_384,
  },
  {
    id: 'MINIMAX_M2_5_HIGHSPEED',
    apiName: 'MINIMAX_M2_5_HIGHSPEED',
    aliases: ['minimax-m2.5-highspeed'],
    modelDescriptorId: 'minimax-m2.5-highspeed',
    label: 'MiniMax M2.5 HighSpeed',
    contextWindow: 204_800,
    maxOutputTokens: 16_384,
  },
]

export default defineGateway({
  id: 'apismart',
  label: 'ApiSmart',
  category: 'aggregating',
  defaultBaseUrl: 'https://gw.apismart.ai/v1',
  defaultModel: 'DEEPSEEK_V4_FLASH',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['APISMART_API_KEY'],
    dedicatedCredentialsOnly: true,
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      // ApiSmart chat-completions examples use max_tokens.
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'apismart',
    description: 'ApiSmart unified OpenAI-compatible gateway',
    vendorId: 'openai',
    apiKeyEnvVars: ['APISMART_API_KEY'],
    modelEnvVars: ['APISMART_MODEL', 'OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['gw.apismart.ai'],
    },
    credentialEnvVars: ['APISMART_API_KEY'],
    missingCredentialMessage:
      'ApiSmart auth is required. Set APISMART_API_KEY.',
  },
  catalog: {
    // /v1/models exists and requires a Bearer key; curated LLM ids stay visible
    // before discovery and when refresh fails.
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      requiresAuth: true,
      mapModel: mapApismartModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [...curatedModels],
  },
  usage: { supported: false },
})
