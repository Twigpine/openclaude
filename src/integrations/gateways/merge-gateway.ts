import { defineGateway } from '../define.js'
import { isKnownNonCodingModelId, isRecord } from '../modelMapping.js'

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

  // Native entries describe modalities per vendor. Keep multimodal chat if
  // any vendor supports text in and out; media/embedding endpoints cannot serve
  // this conversation route. Sparse compatible entries use the existing ID filter.
  const modalities = isRecord(model.vendors)
    ? Object.values(model.vendors).flatMap(vendor => {
        const capabilities = isRecord(vendor) ? vendor.capabilities : undefined
        return isRecord(capabilities) &&
          Array.isArray(capabilities.input) &&
          Array.isArray(capabilities.output)
          ? [{ input: capabilities.input, output: capabilities.output }]
          : []
      })
    : []
  if (
    modalities.length > 0
      ? !modalities.some(
          ({ input, output }) => input.includes('text') && output.includes('text'),
        )
      : isKnownNonCodingModelId(apiName) || /(?:^|\/)veo[-_.]/i.test(apiName)
  ) {
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
        notes: 'Uses the applicable Merge routing policy.',
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
