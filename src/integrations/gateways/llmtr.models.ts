import { defineCatalog } from '../define.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasStringValue(value: unknown, expected: string): boolean {
  return (
    Array.isArray(value) &&
    value.some(item => typeof item === 'string' && item === expected)
  )
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : undefined
}

export function mapLlmtrModel(raw: unknown) {
  if (!isRecord(raw)) {
    return null
  }

  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (
    !id ||
    !hasStringValue(raw.supported_parameters, 'tools') ||
    !hasStringValue(raw.supported_operations, 'CHAT_COMPLETIONS') ||
    !hasStringValue(raw.supported_endpoints, '/v1/chat/completions')
  ) {
    return null
  }

  const architecture = isRecord(raw.architecture) ? raw.architecture : null
  const topProvider = isRecord(raw.top_provider) ? raw.top_provider : null
  const contextWindow =
    positiveInteger(raw.context_length) ??
    positiveInteger(topProvider?.context_length)
  const maxOutputTokens = positiveInteger(
    topProvider?.max_completion_tokens,
  )

  return {
    id,
    apiName: id,
    label:
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    capabilities: {
      supportsFunctionCalling: true,
      supportsVision: hasStringValue(architecture?.input_modalities, 'image'),
      supportsReasoning:
        isRecord(raw.reasoning) ||
        hasStringValue(raw.supported_parameters, 'reasoning') ||
        hasStringValue(raw.supported_parameters, 'reasoning_effort'),
    },
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
  }
}

export default defineCatalog({
  source: 'hybrid',
  discovery: {
    kind: 'openai-compatible',
    requiresAuth: false,
    mapModel: mapLlmtrModel,
  },
  discoveryCacheTtl: '1d',
  discoveryRefreshMode: 'background-if-stale',
  allowManualRefresh: true,
  models: [
    {
      id: 'llmtr-deepseek-v4-flash',
      apiName: 'deepseek/deepseek-v4-flash',
      aliases: ['deepseek-v4-flash'],
      label: 'DeepSeek V4 Flash',
      modelDescriptorId: 'deepseek-v4-flash',
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
    },
    {
      id: 'llmtr-claude-sonnet-4.6',
      apiName: 'anthropic/claude-sonnet-4.6',
      aliases: ['claude-sonnet-4-6'],
      label: 'Claude Sonnet 4.6',
      modelDescriptorId: 'claude-sonnet-4-6',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
    },
    {
      id: 'llmtr-gpt-5.4',
      apiName: 'openai/gpt-5.4',
      aliases: ['gpt-5.4'],
      label: 'GPT-5.4',
      modelDescriptorId: 'gpt-5.4',
      contextWindow: 272_000,
      maxOutputTokens: 128_000,
    },
    {
      id: 'llmtr-gemini-3.1-pro-preview',
      apiName: 'google/gemini-3.1-pro-preview',
      label: 'Gemini 3.1 Pro Preview',
      modelDescriptorId: 'google/gemini-3.1-pro-preview',
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
    },
    {
      id: 'llmtr-deepseek-v4-pro',
      apiName: 'deepseek/deepseek-v4-pro',
      aliases: ['deepseek-v4-pro'],
      label: 'DeepSeek V4 Pro',
      modelDescriptorId: 'deepseek-v4-pro',
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216,
    },
    {
      id: 'llmtr-glm-5.2',
      apiName: 'zai/glm-5.2',
      aliases: ['glm-5.2'],
      label: 'GLM-5.2',
      modelDescriptorId: 'glm-5.2',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
    },
  ],
})
