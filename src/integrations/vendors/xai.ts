import { defineVendor } from '../define.js'
import type { ModelCatalogEntry } from '../descriptors.js'

// Keep chat/coding Grok IDs from https://api.x.ai/v1/models. Imagine, voice,
// STT/TTS, and embedding entries are not usable on the OpenClaude chat path.
const XAI_NON_CHAT_PATTERN =
  /(imagine|voice|tts|stt|whisper|embed|speech-to-speech|speech-to-text|text-to-speech|multi-agent)/i

const XAI_CURATED_MODELS: ModelCatalogEntry[] = [
  {
    id: 'grok-4.6',
    apiName: 'grok-4.6',
    aliases: ['grok-4.6-latest'],
    label: 'Grok 4.6',
    modelDescriptorId: 'grok-4.6',
    contextWindow: 500_000,
    reasoning: {
      mode: 'levels',
      levels: ['low', 'medium', 'high', 'xhigh'],
      defaultLevel: 'high',
      wireFormat: 'reasoning_effort',
    },
  },
  {
    id: 'grok-4.5',
    apiName: 'grok-4.5',
    aliases: ['grok-4.5-latest', 'grok-build-latest'],
    label: 'Grok 4.5',
    modelDescriptorId: 'grok-4.5',
    contextWindow: 500_000,
    maxOutputTokens: 32_768,
    reasoning: {
      mode: 'levels',
      levels: ['low', 'medium', 'high'],
      defaultLevel: 'high',
      wireFormat: 'reasoning_effort',
    },
  },
  {
    id: 'grok-4.3',
    apiName: 'grok-4.3',
    aliases: ['grok-4.3-latest', 'grok-latest', 'grok-4', 'grok-3'],
    label: 'Grok 4.3',
    modelDescriptorId: 'grok-4.3',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    reasoning: { mode: 'levels', levels: ['low', 'medium', 'high'], wireFormat: 'reasoning_effort' },
  },
  {
    id: 'grok-build-0.1',
    apiName: 'grok-build-0.1',
    aliases: ['grok-code-fast-1', 'grok-code-fast', 'grok-code-fast-1-0825'],
    label: 'Grok Build 0.1',
    modelDescriptorId: 'xai/grok-build-0.1',
    contextWindow: 256_000,
    maxOutputTokens: 64_000,
    capabilities: { supportsReasoning: false },
    transportOverrides: { openaiShim: { endpointPath: '/responses', removeBodyFields: ['reasoning_effort'] } },
  },
  {
    id: 'grok-4.20-0309-reasoning',
    apiName: 'grok-4.20-0309-reasoning',
    aliases: [
      'grok-4.20-reasoning-latest',
      'grok-4.20',
      'grok-4.20-reasoning',
      'grok-4.20-0309',
      'grok-4.20-beta-0309-reasoning',
      'grok-4.20-beta',
      'grok-4.20-beta-0309',
      'grok-4.20-beta-latest',
      'grok-4.20-beta-latest-reasoning',
      'grok-4.20-beta-reasoning',
      'grok-4.20-experimental-beta-0304-reasoning',
      'grok-4.20-experimental-beta-0304',
      'grok-4.20-experimental-beta-reasoning-latest',
      'grok-4.20-experimental-beta-latest',
      'grok-4.20-reasoning-gv2',
    ],
    label: 'Grok 4.20 Reasoning',
    modelDescriptorId: 'grok-4.20-0309-reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    reasoning: { mode: 'always-on', wireFormat: 'none' },
    transportOverrides: { openaiShim: { endpointPath: '/responses', removeBodyFields: ['reasoning_effort'] } },
  },
  {
    id: 'grok-4.20-0309-non-reasoning',
    apiName: 'grok-4.20-0309-non-reasoning',
    aliases: [
      'grok-4.20-non-reasoning',
      'grok-4.20-non-reasoning-latest',
      'grok-4.20-beta-non-reasoning',
      'grok-4.20-beta-latest-non-reasoning',
      'grok-4.20-experimental-beta-0304-non-reasoning',
      'grok-4.20-experimental-beta-non-reasoning-latest',
      'grok-4.20-beta-0309-non-reasoning',
      'grok-4.20-non-reasoning-gv2',
    ],
    label: 'Grok 4.20 Non-Reasoning',
    modelDescriptorId: 'grok-4.20-0309-non-reasoning',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    capabilities: { supportsReasoning: false },
  },
]

const XAI_DISCOVERY_SUPPRESSED_IDS = new Set(
  ['latest', ...XAI_CURATED_MODELS.flatMap(model => model.aliases ?? [])].map(
    id => id.toLowerCase(),
  ),
)

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export default defineVendor({
  id: 'xai',
  label: 'xAI',
  classification: 'openai-compatible',
  defaultBaseUrl: 'https://api.x.ai/v1',
  defaultModel: 'grok-4.6',
  requiredEnvVars: ['XAI_API_KEY'],
  setup: {
    requiresAuth: true,
    authMode: 'api-key',
    credentialEnvVars: ['XAI_API_KEY'],
  },
  transportConfig: {
    kind: 'openai-compatible',
  },
  preset: {
    id: 'xai',
    description: 'xAI Grok OpenAI-compatible endpoint',
    apiKeyEnvVars: ['XAI_API_KEY'],
    modelEnvVars: ['OPENAI_MODEL'],
  },
  validation: {
    kind: 'xai-credential',
    routing: {
      matchDefaultBaseUrl: true,
      matchBaseUrlHosts: ['api.x.ai'],
    },
    credentialEnvVars: ['XAI_API_KEY'],
    // Saved OAuth profiles tag their env with this marker so validation
    // passes without re-reading secure storage.
    credentialSourceEnvMarkers: {
      XAI_CREDENTIAL_SOURCE: ['oauth'],
    },
    missingCredentialMessage:
      'XAI_API_KEY is required, or sign in with `openclaude auth xai login` (browser OAuth) or `openclaude auth xai device` (remote hosts).',
  },
  catalog: {
    source: 'hybrid',
    discovery: {
      kind: 'openai-compatible',
      mapModel(raw: unknown) {
        if (!raw || typeof raw !== 'object') {
          return null
        }
        const model = raw as {
          id?: string
          active?: boolean
          context_length?: number
        }
        const id = typeof model.id === 'string' ? model.id.trim() : ''
        if (!id || model.active === false) {
          return null
        }
        if (XAI_NON_CHAT_PATTERN.test(id)) {
          return null
        }
        if (!/^grok/i.test(id)) {
          return null
        }
        if (XAI_DISCOVERY_SUPPRESSED_IDS.has(id.toLowerCase())) {
          return null
        }
        return {
          id,
          apiName: id,
          label: id,
          ...(isPositiveFiniteNumber(model.context_length)
            ? { contextWindow: model.context_length }
            : {}),
        }
      },
    },
    discoveryCacheTtl: '1d',
    discoveryRefreshMode: 'background-if-stale',
    allowManualRefresh: true,
    models: XAI_CURATED_MODELS,
  },
  usage: { supported: false },
})
