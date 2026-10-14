import { defineAnthropicProxy } from '../define.js'

// A generic user-configured Anthropic Messages API endpoint. Unlike the
// first-party Anthropic preset, this route can use a provider-issued Bearer
// token or native x-api-key authentication.
export default defineAnthropicProxy({
  id: 'custom-anthropic',
  label: 'Custom (Anthropic-compatible)',
  classification: 'anthropic-proxy',
  defaultBaseUrl: 'https://anthropic-proxy.example',
  defaultModel: 'claude-sonnet-4-6',
  setup: {
    requiresAuth: true,
    authMode: 'token',
    credentialEnvVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    setupPrompt: 'Paste the credential for your Anthropic-compatible endpoint.',
  },
  envVarConfig: {
    authTokenEnvVar: 'ANTHROPIC_AUTH_TOKEN',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
    modelEnvVar: 'ANTHROPIC_MODEL',
  },
  capabilities: {
    supportsStreaming: true,
    supportsFunctionCalling: true,
    supportsVision: true,
  },
  transportConfig: {
    kind: 'anthropic-proxy',
    anthropicProxy: { supportsCustomHeaders: true },
  },
  usage: { supported: false },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'anthropic-compatible',
      parse: 'anthropic-models-list',
    },
    // The catalog is only as fresh as the proxy behind it, and every probe
    // below is a real inference call — so refresh stays an explicit action
    // rather than running on startup.
    allowManualRefresh: true,
  },
  preset: {
    id: 'custom-anthropic',
    description: 'Any Anthropic Messages API-compatible provider',
    label: 'Custom (Anthropic-compatible)',
    name: 'Custom (Anthropic-compatible)',
    vendorId: 'anthropic',
    apiKeyEnvVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    baseUrlEnvVars: ['ANTHROPIC_BASE_URL'],
    modelEnvVars: ['ANTHROPIC_MODEL'],
    fallbackBaseUrl: 'https://anthropic-proxy.example',
    fallbackModel: 'claude-sonnet-4-6',
  },
})
