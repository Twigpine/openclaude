import { defineGateway } from '../define.js'
import catalog from './llmtr.models.js'

export default defineGateway({
  id: 'llmtr',
  label: 'LLMTR',
  category: 'aggregating',
  defaultBaseUrl: 'https://llmtr.com/v1',
  defaultModel: 'deepseek/deepseek-v4-flash',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['LLMTR_API_KEY', 'OPENAI_API_KEY'],
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
    id: 'llmtr',
    description: 'LLMTR OpenAI-compatible multi-model gateway',
    vendorId: 'openai',
    apiKeyEnvVars: ['LLMTR_API_KEY', 'OPENAI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
    },
    credentialEnvVars: [
      'LLMTR_API_KEY',
      'OPENAI_API_KEYS',
      'OPENAI_API_KEY',
    ],
    missingCredentialMessage:
      'LLMTR auth is required. Set LLMTR_API_KEY or OPENAI_API_KEY.',
  },
  catalog,
  usage: { supported: false },
})
