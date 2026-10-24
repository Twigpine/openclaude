import { defineGateway } from '../define.js'

export default defineGateway({
  id: 'llama-windows',
  label: 'Llama for Windows',
  category: 'local',
  defaultBaseUrl: 'http://127.0.0.1:9931/v1',
  defaultModel: 'local-model',
  supportsModelRouting: true,
  setup: {
    requiresAuth: false,
    authMode: 'none',
  },
  startup: {
    autoDetectable: true,
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'local',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  },
  preset: {
    id: 'llama-windows',
    description: 'Local Llama for Windows endpoint',
    baseUrlEnvVars: ['LLAMA_WINDOWS_BASE_URL'],
    modelEnvVars: ['OPENAI_MODEL'],
    vendorId: 'openai',
  },
  catalog: {
    source: 'dynamic',
    discovery: { kind: 'openai-compatible' },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
  },
  usage: { supported: false },
})
