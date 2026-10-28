import { defineGateway } from '../define.js'
import { getTrimmedString, isRecord } from '../modelMapping.js'

function mapOrcarouterModel(raw: unknown) {
  if (!isRecord(raw)) return null
  const id = getTrimmedString(raw, 'id')
  if (!id) return null
  const context = raw.context_length
  return {
    id,
    apiName: id,
    label: id,
    ...(typeof context === 'number' && Number.isInteger(context) && context > 0
      ? { contextWindow: context }
      : {}),
  }
}

export default defineGateway({
  id: 'orcarouter',
  label: 'OrcaRouter',
  category: 'aggregating',
  defaultBaseUrl: 'https://api.orcarouter.ai/v1',
  defaultModel: 'openai/gpt-5.5',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['ORCAROUTER_API_KEY'],
    dedicatedCredentialsOnly: true,
  },
  startup: {
    probeReadiness: 'openai-compatible-models',
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: true,
      supportsAuthHeaders: true,
    },
  },
  preset: {
    id: 'orcarouter',
    description: 'OrcaRouter OpenAI-compatible endpoint',
    apiKeyEnvVars: ['ORCAROUTER_API_KEY'],
    vendorId: 'openai',
  },
  catalog: {
    source: 'hybrid',
    discovery: { kind: 'openai-compatible', mapModel: mapOrcarouterModel },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: [
      {
        id: 'orcarouter-auto',
        apiName: 'orcarouter/auto',
        label: 'Auto — Smart Routing (via OrcaRouter)',
        notes: 'Gateway routes to the best model for each request',
      },
      {
        id: 'orcarouter-gpt-5.5',
        apiName: 'openai/gpt-5.5',
        label: 'GPT-5.5 (via OrcaRouter)',
        modelDescriptorId: 'gpt-5.5',
      },
      {
        id: 'orcarouter-claude-sonnet-4-6',
        apiName: 'anthropic/claude-sonnet-4.6',
        label: 'Claude Sonnet 4.6 (via OrcaRouter)',
        modelDescriptorId: 'claude-sonnet-4-6',
        maxOutputTokens: 64_000,
      },
      {
        id: 'orcarouter-gemini-3.5-flash',
        apiName: 'google/gemini-3.5-flash',
        label: 'Gemini 3.5 Flash (via OrcaRouter)',
        modelDescriptorId: 'gemini-3.5-flash',
      },
    ],
  },
  usage: { supported: false },
})
