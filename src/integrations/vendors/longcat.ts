import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'longcat',
  label: 'LongCat',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.longcat.chat/openai/v1',
  defaultModel: 'LongCat-2.0',
  requiredEnvVars: ['LONGCAT_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['LONGCAT_API_KEY'],
    dedicatedCredentialsOnly: true,
    setupPrompt: 'Paste your LongCat API key from https://longcat.chat/platform/api_keys',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      thinkingRequestFormat: 'zai-compatible',
      maxTokensField: 'max_tokens',
      // The documented Chat Completions request accepts text input only.
      supportsImageInputs: false,
      // LongCat documents thinking:{type} but not reasoning_effort.
      removeBodyFields: ['store', 'reasoning_effort', 'stream_options', 'tools'],
      requiredApiFormat: 'chat_completions',
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'longcat',
    description: 'LongCat OpenAI-compatible API (Meituan)',
    label: 'LongCat',
    name: 'LongCat',
    apiKeyEnvVars: ['LONGCAT_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.longcat.chat'],
    },
    credentialEnvVars: ['LONGCAT_API_KEY'],
    missingCredentialMessage: 'LONGCAT_API_KEY is required.',
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'LongCat-2.0',
        apiName: 'LongCat-2.0',
        label: 'LongCat-2.0',
        modelDescriptorId: 'LongCat-2.0',
        capabilities: {
          supportsStreaming: true,
          supportsFunctionCalling: false,
          supportsReasoning: true,
        },
        contextWindow: 1_048_576,
        maxOutputTokens: 131_072,
      },
    ],
  },
  usage: { supported: false },
})
