import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'hicap',
  label: 'Hicap',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.hicap.ai/v1',
  defaultModel: 'claude-opus-4.8',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['HICAP_API_KEY'],
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: true,
      supportsAuthHeaders: true,
      ui: {
        showAuthHeader: false,
        showAuthHeaderValue: false,
        showCustomHeaders: true,
      },
      defaultAuthHeader: {
        name: 'api-key',
        scheme: 'raw',
      },
      responsesApiModelPrefixes: ['gpt-5.4', 'gpt-5.5'],
    },
  },
  preset: {
    id: 'hicap',
    description: 'Hicap OpenAI-compatible gateway',
    apiKeyEnvVars: ['HICAP_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.hicap.ai'],
    },
    credentialEnvVars: ['HICAP_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'Set HICAP_API_KEY or OPENAI_API_KEYS / OPENAI_API_KEY for the Hicap provider.',
  },
  catalog: {
    source: 'hybrid',
    discovery: { kind: 'openai-compatible', requiresAuth: false },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    // Hicap /v1/models currently returns ids only; keep verified route metadata here.
    models: [
      { id: 'hicap-claude-opus-4.8', apiName: 'claude-opus-4.8', label: 'Claude Opus 4.8', modelDescriptorId: 'claude-opus-4-8', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-claude-opus-4.7', apiName: 'claude-opus-4.7', aliases: ['claude-opus-4-7'], label: 'Claude Opus 4.7', modelDescriptorId: 'claude-opus-4-7', contextWindow: 1_000_000, maxOutputTokens: 128_000, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-deepseek-v4-pro', apiName: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', modelDescriptorId: 'deepseek-v4-pro', contextWindow: 1_048_576, maxOutputTokens: 65_536, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-glm-5.2', apiName: 'glm-5.2', aliases: ['zai-org/glm-5.2'], label: 'GLM 5.2', modelDescriptorId: 'glm-5.2', contextWindow: 1_000_000, maxOutputTokens: 131_072, capabilities: { supportsFunctionCalling: true, supportsJsonMode: true, supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'zai_compatible' }, transportOverrides: { openaiShim: { preserveReasoningContent: true, requireReasoningContentOnAssistantMessages: true, reasoningContentFallback: '', thinkingRequestFormat: 'zai-compatible', maxTokensField: 'max_tokens', removeBodyFields: ['store'], enableToolStreaming: true } } },
      { id: 'hicap-gpt-5.4', apiName: 'gpt-5.4', label: 'GPT-5.4', modelDescriptorId: 'gpt-5.4', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' }, transportOverrides: { openaiShim: { requiredApiFormat: 'responses', maxTokensField: 'max_completion_tokens' } } },
      { id: 'hicap-gpt-5.5', apiName: 'gpt-5.5', label: 'GPT-5.5', modelDescriptorId: 'gpt-5.5', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' }, transportOverrides: { openaiShim: { requiredApiFormat: 'responses', maxTokensField: 'max_completion_tokens' } } },
      { id: 'hicap-grok-4.6', apiName: 'grok-4.6', aliases: ['grok-4.6-latest'], label: 'Grok 4.6', modelDescriptorId: 'grok-4.6', contextWindow: 500_000, maxOutputTokens: 32_768, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-grok-4.5', apiName: 'grok-4.5', aliases: ['grok-4.5-latest', 'grok-build-latest'], label: 'Grok 4.5', modelDescriptorId: 'grok-4.5', contextWindow: 500_000, maxOutputTokens: 32_768, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-grok-4.3', apiName: 'grok-4.3', label: 'Grok 4.3', modelDescriptorId: 'grok-4.3', contextWindow: 1_000_000, maxOutputTokens: 32_768, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-kimi-k2.7-code', apiName: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', modelDescriptorId: 'kimi-k2.7-code', contextWindow: 262_144, maxOutputTokens: 262_144, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'hicap-minimax-m3', apiName: 'minimax-m3', label: 'MiniMax M3', modelDescriptorId: 'minimax-m3', contextWindow: 1_048_576, maxOutputTokens: 131_072, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
    ],
  },
  usage: { supported: false },
})
