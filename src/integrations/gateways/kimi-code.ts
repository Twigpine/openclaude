import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'kimi-code',
  label: 'Moonshot AI - Kimi Code',
  category: 'hosted',
  defaultBaseUrl: 'https://api.kimi.com/coding/v1',
  // K3 requires a Moderato subscription. Keep the all-members K2.7 model as
  // the default; eligible users can explicitly select either K3 variant.
  defaultModel: 'kimi-for-coding',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['KIMI_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      preserveReasoningContent: true,
      requireReasoningContentOnAssistantMessages: true,
      reasoningContentFallback: '',
      maxTokensField: 'max_tokens',
      removeBodyFields: ['store'],
    },
  },
  preset: {
    id: 'kimi-code',
    description: 'Moonshot AI - Kimi Code Subscription endpoint',
    apiKeyEnvVars: ['KIMI_API_KEY'],
    vendorId: 'openai',
  },
  catalog: {
    source: 'static',
    models: [
      { id: 'k3', apiName: 'k3', label: 'Kimi K3 (1M)', modelDescriptorId: 'k3', contextWindow: 1_048_576, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'high', 'max'], defaultLevel: 'max', wireFormat: 'reasoning_effort', disableFormat: 'thinking_type_disabled' }, notes: 'Allegretto+' },
      { id: 'k3-256k', apiName: 'k3', label: 'Kimi K3 (256K)', modelDescriptorId: 'k3', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'high', 'max'], defaultLevel: 'max', wireFormat: 'reasoning_effort', disableFormat: 'thinking_type_disabled' }, notes: 'Moderato+' },
      { id: 'kimi-k2.7-code', apiName: 'kimi-k2.7-code', aliases: ['moonshotai/kimi-k2.7-code'], label: 'Kimi K2.7 Code', modelDescriptorId: 'kimi-k2.7-code', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' } },
      { id: 'kimi-for-coding', apiName: 'kimi-for-coding', label: 'Kimi for Coding', modelDescriptorId: 'kimi-for-coding', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' } },
      { id: 'kimi-for-coding-highspeed', apiName: 'kimi-for-coding-highspeed', label: 'Kimi K2.7 Code HighSpeed (Allegretto+)', modelDescriptorId: 'kimi-for-coding', contextWindow: 262_144, maxOutputTokens: 32_768, capabilities: { supportsVision: true, supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'medium', wireFormat: 'reasoning_effort' }, notes: 'Requires Allegretto or above; 6x speed and 3x quota usage.' },
    ],
  },
  usage: { supported: false },
})
