import { defineVendor } from '../define.js'

export const MINIMAX_GLOBAL_ANTHROPIC_BASE_URL = 'https://api.minimax.io/anthropic'
export const MINIMAX_CHINA_ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic'

export default defineVendor({
  id: 'minimax',
  label: 'MiniMax',
  classification: 'native',
  defaultBaseUrl: MINIMAX_GLOBAL_ANTHROPIC_BASE_URL,
  defaultModel: 'MiniMax-M3',
  requiredEnvVars: ['MINIMAX_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['MINIMAX_API_KEY'],
  },
  transportConfig: {
    kind: 'anthropic-proxy',
  },
  preset: {
    id: 'minimax',
    description: 'MiniMax API endpoint',
    apiKeyEnvVars: ['MINIMAX_API_KEY'],
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.minimax.io', 'api.minimaxi.com', 'api.minimax.chat'],
    },
    // Explicit OpenAI-compatible endpoints also accept the shim's credentials.
    credentialEnvVars: ['MINIMAX_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
    missingCredentialMessage:
      'MiniMax auth is required. Set MINIMAX_API_KEY or OPENAI_API_KEY / OPENAI_API_KEYS.',
  },
  catalog: {
    source: 'static',
    models: [
      { id: 'minimax-m2', apiName: 'MiniMax-M2', label: 'MiniMax M2', modelDescriptorId: 'minimax-m2', contextWindow: 204_800 },
      { id: 'minimax-m2.1', apiName: 'MiniMax-M2.1', label: 'MiniMax M2.1', modelDescriptorId: 'minimax-m2.1', contextWindow: 204_800 },
      { id: 'minimax-m2.1-highspeed', apiName: 'MiniMax-M2.1-highspeed', label: 'MiniMax M2.1 Highspeed', modelDescriptorId: 'minimax-m2.1-highspeed', contextWindow: 204_800 },
      { id: 'minimax-m2.5', apiName: 'MiniMax-M2.5', label: 'MiniMax M2.5', modelDescriptorId: 'minimax-m2.5', contextWindow: 204_800 },
      { id: 'minimax-m2.5-highspeed', apiName: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed', modelDescriptorId: 'minimax-m2.5-highspeed', contextWindow: 204_800 },
      { id: 'minimax-m2.7', apiName: 'MiniMax-M2.7', label: 'MiniMax M2.7', modelDescriptorId: 'minimax-m2.7', contextWindow: 204_800 },
      { id: 'minimax-m2.7-highspeed', apiName: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', modelDescriptorId: 'minimax-m2.7-highspeed', contextWindow: 204_800 },
      { id: 'minimax-m3', apiName: 'MiniMax-M3', label: 'MiniMax M3', modelDescriptorId: 'minimax-m3', contextWindow: 1_048_576 },
      { id: 'minimax-text-01', apiName: 'MiniMax-Text-01', label: 'MiniMax Text 01', modelDescriptorId: 'minimax-text-01' },
      { id: 'minimax-text-01-preview', apiName: 'MiniMax-Text-01-Preview', label: 'MiniMax Text 01 Preview', modelDescriptorId: 'minimax-text-01-preview' },
      { id: 'minimax-vision-01', apiName: 'MiniMax-Vision-01', label: 'MiniMax Vision 01', modelDescriptorId: 'minimax-vision-01' },
      { id: 'minimax-vision-01-fast', apiName: 'MiniMax-Vision-01-Fast', label: 'MiniMax Vision 01 Fast', modelDescriptorId: 'minimax-vision-01-fast' },
    ],
  },
  usage: { supported: true },
})
