import { defineVendor } from '../define.js'

export default defineVendor({
  id: 'openai',
  label: 'OpenAI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-5.4',
  requiredEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: true,
      supportsAuthHeaders: true,
    },
  },
  preset: {
    id: 'openai',
    description: 'OpenAI API with API key',
    apiKeyEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      fallbackWhenUseOpenAI: true,
    },
    credentialEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    allowLocalBaseUrlWithoutCredential: true,
    missingCredentialMessage:
      'OPENAI_API_KEYS or OPENAI_API_KEY is required when CLAUDE_CODE_USE_OPENAI=1 and OPENAI_BASE_URL is not local.',
    invalidCredentialValues: [
      {
        envVar: 'OPENAI_API_KEYS',
        value: 'SUA_CHAVE',
        message:
          'Invalid OPENAI_API_KEYS: placeholder value SUA_CHAVE detected. Set real key(s) or unset for local providers.',
      },
      {
        envVar: 'OPENAI_API_KEY',
        value: 'SUA_CHAVE',
        message:
          'Invalid OPENAI_API_KEY: placeholder value SUA_CHAVE detected. Set a real key or unset for local providers.',
      },
    ],
  },
  isFirstParty: true,
  catalog: {
    source: 'static',
    models: [
      // gpt-5.6 (sol/terra/luna): reject function tools + reasoning_effort on
      // /v1/chat/completions, so modelRequiresResponsesApi routes them to
      // /v1/responses. The reasoning metadata here makes buildResponsesBody
      // emit nested reasoning.effort; requiredApiFormat is intentionally NOT
      // set so an explicit OPENAI_API_FORMAT=chat_completions stays an escape
      // hatch.
      { id: 'gpt-5.6-sol', apiName: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', modelDescriptorId: 'gpt-5.6-sol', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'gpt-5.6-terra', apiName: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', modelDescriptorId: 'gpt-5.6-terra', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'gpt-5.6-luna', apiName: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', modelDescriptorId: 'gpt-5.6-luna', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'gpt-5.5', apiName: 'gpt-5.5', label: 'GPT-5.5', modelDescriptorId: 'gpt-5.5', contextWindow: 272_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'gpt-5.4', apiName: 'gpt-5.4', label: 'GPT-5.4', modelDescriptorId: 'gpt-5.4', contextWindow: 1_050_000, maxOutputTokens: 128_000, capabilities: { supportsReasoning: true }, reasoning: { mode: 'levels', levels: ['low', 'medium', 'high', 'xhigh'], defaultLevel: 'high', wireFormat: 'reasoning_effort' } },
      { id: 'gpt-5-mini', apiName: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'gpt-4o', apiName: 'gpt-4o', label: 'GPT-4o' },
      { id: 'gpt-4o-mini', apiName: 'gpt-4o-mini', label: 'GPT-4o Mini' },
    ],
  },
  usage: { supported: false },
})
