import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'zai',
  label: 'Z.AI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  defaultModel: 'glm-5.2',
  requiredEnvVars: ['OPENAI_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPENAI_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      preserveReasoningContent: true,
      requireReasoningContentOnAssistantMessages: true,
      reasoningContentFallback: '',
      thinkingRequestFormat: 'zai-compatible',
      maxTokensField: 'max_tokens',
      removeBodyFields: ['store'],
    },
  },
  preset: {
    id: 'zai',
    description: 'Z.AI GLM coding subscription endpoint',
    label: 'Z.AI - GLM Coding Plan',
    name: 'Z.AI - GLM Coding Plan',
    apiKeyEnvVars: ['OPENAI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
    },
    credentialEnvVars: ['OPENAI_API_KEY'],
    missingCredentialMessage:
      'OPENAI_API_KEY is required for Z.AI GLM Coding Plan.',
  },
  catalog: {
    source: 'static',
    models: [
      {
        id: 'glm-5.3-flash',
        apiName: 'glm-5.3-flash',
        label: 'GLM-5.3-Flash',
        modelDescriptorId: 'glm-5.3-flash',
        reasoning: {
          mode: 'levels',
          levels: ['low', 'high', 'xhigh'],
          wireFormat: 'zai_compatible',
        },
        transportOverrides: {
          openaiShim: {
            enableToolStreaming: true,
          },
        },
      },
      {
        id: 'glm-5.3',
        apiName: 'glm-5.3',
        label: 'GLM-5.3',
        modelDescriptorId: 'glm-5.3',
        reasoning: {
          mode: 'levels',
          levels: ['low', 'high', 'xhigh'],
          wireFormat: 'zai_compatible',
        },
        transportOverrides: {
          openaiShim: {
            enableToolStreaming: true,
          },
        },
      },
      {
        id: 'glm-5.2',
        apiName: 'glm-5.2',
        label: 'GLM-5.2',
        modelDescriptorId: 'glm-5.2',
        transportOverrides: {
          openaiShim: {
            enableToolStreaming: true,
          },
        },
      },
      {
        id: 'GLM-5.1',
        apiName: 'GLM-5.1',
        label: 'GLM-5.1',
        modelDescriptorId: 'GLM-5.1',
      },
      {
        id: 'GLM-5-Turbo',
        apiName: 'GLM-5-Turbo',
        label: 'GLM-5-Turbo',
        modelDescriptorId: 'GLM-5-Turbo',
      },
      {
        id: 'GLM-4.7',
        apiName: 'GLM-4.7',
        label: 'GLM-4.7',
        modelDescriptorId: 'GLM-4.7',
      },
      {
        id: 'GLM-4.5-Air',
        apiName: 'GLM-4.5-Air',
        label: 'GLM-4.5-Air',
        modelDescriptorId: 'GLM-4.5-Air',
      },
    ],
  },
  usage: { supported: false },
})
