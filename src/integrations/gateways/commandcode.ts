import { defineCatalog, defineGateway } from '../define.js'
import { isModelAlias } from '../../utils/model/aliases.js'
import { parseModelList } from '../../utils/providerModels.js'

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

const ANTHROPIC_MESSAGES_ONLY_MODEL_PATTERN = /^(claude-|anthropic\/)/i

function getProtocolModelIdentity(model: string): string {
  const withoutTrailingContextTag = model.trim().replace(/\[1m\]$/i, '').trim()
  const baseModel =
    withoutTrailingContextTag.split('?', 1)[0] ?? withoutTrailingContextTag
  return baseModel
    .trim()
    .replace(/\[1m\]$/i, '')
    .trim()
    .toLowerCase()
}

function requiresAnthropicMessages(model: string): boolean {
  const normalizedModel = getProtocolModelIdentity(model)
  return (
    ANTHROPIC_MESSAGES_ONLY_MODEL_PATTERN.test(normalizedModel) ||
    isModelAlias(normalizedModel)
  )
}

export function getCommandcodeChatCompletionsModelError(
  model: string | null | undefined,
): string | null {
  const normalizedModel = model?.trim()
  if (!normalizedModel) {
    return null
  }

  const modelIds = parseModelList(normalizedModel)
  const ids = modelIds.length > 0 ? modelIds : [normalizedModel]
  if (!ids.some(id => requiresAnthropicMessages(id))) {
    return null
  }

  return 'OpenAI Chat Completions does not support the selected Command Code model; it requires the Anthropic Messages protocol. Choose an OpenAI-compatible model.'
}

export function mapCommandcodeModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = getTrimmedString(raw, 'id')
  if (!id || getCommandcodeChatCompletionsModelError(id)) {
    return null
  }

  const name = getTrimmedString(raw, 'name')
  const contextWindow = getPositiveInteger(raw.context_length)

  return {
    id,
    apiName: id,
    label: name || id,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  }
}

const catalog = defineCatalog({
  source: 'hybrid',
  discovery: {
    kind: 'openai-compatible',
    requiresAuth: false,
    mapModel: mapCommandcodeModel,
  },
  discoveryCacheTtl: '1d',
  discoveryRefreshMode: 'background-if-stale',
  allowManualRefresh: true,
  models: [
    {
      id: 'commandcode-deepseek-v4-flash',
      apiName: 'deepseek/deepseek-v4-flash',
      aliases: ['deepseek-v4-flash'],
      label: 'DeepSeek V4 Flash',
      modelDescriptorId: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
    },
    {
      id: 'commandcode-deepseek-v4-pro',
      apiName: 'deepseek/deepseek-v4-pro',
      aliases: ['deepseek-v4-pro'],
      label: 'DeepSeek V4 Pro',
      modelDescriptorId: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
    },
    {
      id: 'commandcode-gpt-5.6-sol',
      apiName: 'gpt-5.6-sol',
      aliases: ['gpt-5.6-sol'],
      label: 'GPT-5.6 Sol',
      modelDescriptorId: 'gpt-5.6-sol',
      contextWindow: 1_050_000,
    },
    {
      id: 'commandcode-kimi-k2.5',
      apiName: 'moonshotai/Kimi-K2.5',
      aliases: ['kimi-k2.5', 'moonshotai/kimi-k2.5'],
      label: 'Kimi K2.5',
      modelDescriptorId: 'kimi-k2.5',
      contextWindow: 256_000,
    },
    {
      id: 'commandcode-minimax-m3',
      apiName: 'MiniMaxAI/MiniMax-M3',
      aliases: ['minimax-m3'],
      label: 'MiniMax M3',
      modelDescriptorId: 'minimax-m3',
      contextWindow: 1_000_000,
    },
    {
      id: 'commandcode-glm-5.3-flash',
      apiName: 'z-ai/glm-5.3-flash',
      aliases: ['glm-5.3-flash'],
      label: 'GLM-5.3 Flash',
      modelDescriptorId: 'glm-5.3-flash',
      contextWindow: 1_048_576,
    },
  ],
})

export default defineGateway({
  id: 'commandcode',
  label: 'Command Code',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.commandcode.ai/provider/v1',
  defaultModel: 'deepseek/deepseek-v4-flash',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: [
      'CMD_API_KEY',
      'COMMANDCODE_API_KEY',
      'COMMAND_CODE_API_KEY',
    ],
    dedicatedCredentialsOnly: true,
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      requiredApiFormat: 'chat_completions',
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'commandcode',
    description: 'Command Code hybrid OpenAI-compatible gateway',
    vendorId: 'openai',
    apiKeyEnvVars: [
      'CMD_API_KEY',
      'COMMANDCODE_API_KEY',
      'COMMAND_CODE_API_KEY',
    ],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
    },
    credentialEnvVars: [
      'CMD_API_KEY',
      'COMMANDCODE_API_KEY',
      'COMMAND_CODE_API_KEY',
    ],
    missingCredentialMessage:
      'Command Code auth is required. Set CMD_API_KEY, COMMANDCODE_API_KEY, or COMMAND_CODE_API_KEY.',
  },
  catalog,
  usage: { supported: false },
})
