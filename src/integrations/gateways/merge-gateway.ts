import { defineGateway } from '../define.js'

/** Convert Merge's native catalog object into an OpenClaude route entry. */
function mapMergeGatewayModel(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }

  const model = raw as Record<string, unknown>
  const apiName =
    typeof model.id === 'string'
      ? model.id.trim()
      : typeof model.model === 'string'
        ? model.model.trim()
        : ''
  if (!apiName) {
    return null
  }

  const label =
    typeof model.display_name === 'string' && model.display_name.trim()
      ? model.display_name.trim()
      : apiName

  return {
    id: `merge-gateway-${apiName}`,
    apiName,
    label: `${label} (via Merge Gateway)`,
  }
}

export default defineGateway({
  id: 'merge-gateway',
  label: 'Merge Gateway',
  category: 'aggregating',
  defaultBaseUrl: 'https://api-gateway.merge.dev/v1/openai',
  defaultModel: 'openai/gpt-5.5',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['MERGE_GATEWAY_API_KEY'],
    dedicatedCredentialsOnly: true,
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: true,
      supportsAuthHeaders: false,
      ui: {
        showAuthHeader: false,
        showAuthHeaderValue: false,
        showCustomHeaders: false,
      },
    },
  },
  preset: {
    id: 'merge-gateway',
    description: 'Merge Gateway multi-provider model router',
    apiKeyEnvVars: ['MERGE_GATEWAY_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
    vendorId: 'openai',
  },
  validation: {
    kind: 'credential-env',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api-gateway.merge.dev'],
    },
    credentialEnvVars: ['MERGE_GATEWAY_API_KEY'],
    missingCredentialMessage:
      'Merge Gateway auth is required. Set MERGE_GATEWAY_API_KEY.',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      requiresAuth: true,
      path: '/v1/models',
      mapModel: mapMergeGatewayModel,
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      {
        id: 'merge-gateway-default-routing',
        apiName: 'default_routing',
        label: 'Default routing policy',
        notes: 'Uses the routing policy configured for the Merge Gateway API key.',
      },
      {
        id: 'merge-gateway-gpt-5.5',
        apiName: 'openai/gpt-5.5',
        label: 'GPT-5.5 (via Merge Gateway)',
        modelDescriptorId: 'gpt-5.5',
      },
    ],
  },
  usage: { supported: false },
})
