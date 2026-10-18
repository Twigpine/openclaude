import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'moonshot',
  label: 'Moonshot AI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.moonshot.ai/v1',
  defaultModel: 'kimi-k2.7-code',
  requiredEnvVars: ['MOONSHOT_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['MOONSHOT_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      preserveReasoningContent: true,
      requireReasoningContentOnAssistantMessages: true,
      reasoningContentFallback: '',
      maxTokensField: 'max_tokens',
      removeBodyFields: ['store'],
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
    },
  },
  preset: {
    id: 'moonshotai',
    description: 'Moonshot AI - API endpoint',
    label: 'Moonshot AI - API',
    name: 'Moonshot AI - API',
    apiKeyEnvVars: ['MOONSHOT_API_KEY'],
  },
  catalog: {
    source: 'static',
    models: [
      { id: 'k3', apiName: 'kimi-k3', label: 'Kimi K3', modelDescriptorId: 'k3', contextWindow: 1_048_576, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'high', 'max'], defaultLevel: 'max', wireFormat: 'reasoning_effort' } },
      { id: 'kimi-k2.7-code', apiName: 'kimi-k2.7-code', aliases: ['moonshotai/kimi-k2.7-code'], label: 'Kimi K2.7 Code', modelDescriptorId: 'kimi-k2.7-code', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' } },
      { id: 'kimi-k2.6', apiName: 'kimi-k2.6', aliases: ['moonshotai/kimi-k2.6'], label: 'Kimi K2.6', modelDescriptorId: 'kimi-k2.6', contextWindow: 262_144, maxOutputTokens: 262_144, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' } },
      { id: 'kimi-k2.5', apiName: 'kimi-k2.5', aliases: ['moonshotai/kimi-k2.5'], label: 'Kimi K2.5', modelDescriptorId: 'kimi-k2.5', contextWindow: 262_144, maxOutputTokens: 262_144, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' } },
    ],
  },
  usage: { supported: false },
})
