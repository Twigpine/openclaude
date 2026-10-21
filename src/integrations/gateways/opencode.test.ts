import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ensureIntegrationsLoaded } from '../index.js'
import {
  _clearRegistryForTesting,
  getGateway,
  getModelsForGateway,
  getCatalogEntriesForRoute,
  getAllModels,
  validateIntegrationRegistry,
} from '../registry.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

beforeEach(async () => {
  await acquireSharedMutationLock('integrations/gateways/opencode.test.ts')
  _clearRegistryForTesting()
  ensureIntegrationsLoaded()
})

afterEach(() => {
  try {
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  } finally {
    releaseSharedMutationLock()
  }
})

// ---------------------------------------------------------------------------
// Zen Gateway Descriptor Tests
// ---------------------------------------------------------------------------

describe('OpenCode Zen gateway descriptor', () => {
  test('is registered with correct id', () => {
    const gateway = getGateway('opencode')
    expect(gateway).not.toBeNull()
    expect(gateway!.id).toBe('opencode')
  })

  test('has correct label', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.label).toBe('OpenCode Zen')
  })

  test('has aggregating category', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.category).toBe('aggregating')
  })

  test('has correct default base URL', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.defaultBaseUrl).toBe('https://opencode.ai/zen/v1')
  })

  test('has correct default model', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.defaultModel).toBe('gpt-5.4')
  })

  test('requires auth', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.setup.requiresAuth).toBe(true)
  })

  test('uses api-key auth mode', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.setup.authMode).toBe('api-key')
  })

  test('has OPENCODE_API_KEY in credential env vars', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.setup.credentialEnvVars).toContain('OPENCODE_API_KEY')
  })

  test('has openai-compatible transport kind', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.transportConfig.kind).toBe('openai-compatible')
  })

  test('has preset metadata', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.preset).toBeDefined()
    expect(gateway!.preset!.id).toBe('opencode')
    expect(gateway!.preset!.vendorId).toBe('openai')
    expect(gateway!.preset!.apiKeyEnvVars).toContain('OPENCODE_API_KEY')
  })

  test('has validation metadata', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.validation).toBeDefined()
    expect(gateway!.validation!.kind).toBe('credential-env')
  })

  test('has catalog with static source', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.catalog).toBeDefined()
    expect(gateway!.catalog!.source).toBe('static')
  })

  test('has static models in catalog', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.catalog!.models).toBeDefined()
    expect(gateway!.catalog!.models!.length).toBeGreaterThan(0)
  })

  test('has usage metadata', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.usage).toBeDefined()
    expect(gateway!.usage!.supported).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Go Gateway Descriptor Tests
// ---------------------------------------------------------------------------

describe('OpenCode Go gateway descriptor', () => {
  test('is registered with correct id', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway).not.toBeNull()
    expect(gateway!.id).toBe('opencode-go')
  })

  test('has correct label', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.label).toBe('OpenCode Go')
  })

  test('has aggregating category', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.category).toBe('aggregating')
  })

  test('has correct default base URL', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.defaultBaseUrl).toBe('https://opencode.ai/zen/go/v1')
  })

  test('has correct default model', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.defaultModel).toBe('glm-5.1')
  })

  test('requires auth', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.setup.requiresAuth).toBe(true)
  })

  test('uses api-key auth mode', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.setup.authMode).toBe('api-key')
  })

  test('has OPENCODE_API_KEY in credential env vars', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.setup.credentialEnvVars).toContain('OPENCODE_API_KEY')
  })

  test('has openai-compatible transport kind', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.transportConfig.kind).toBe('openai-compatible')
  })

  test('has preset metadata with vendorId openai', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.preset).toBeDefined()
    expect(gateway!.preset!.id).toBe('opencode-go')
    expect(gateway!.preset!.vendorId).toBe('openai')
    expect(gateway!.preset!.apiKeyEnvVars).toContain('OPENCODE_API_KEY')
  })

  test('has catalog with static source', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.catalog).toBeDefined()
    expect(gateway!.catalog!.source).toBe('static')
  })

  test('has static models in catalog', () => {
    const gateway = getGateway('opencode-go')
    expect(gateway!.catalog!.models).toBeDefined()
    expect(gateway!.catalog!.models!.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Model Catalog Tests
// ---------------------------------------------------------------------------

describe('OpenCode model catalog', () => {
  test('zen gateway has models registered', () => {
    const models = getModelsForGateway('opencode')
    expect(models.length).toBeGreaterThan(0)
  })

  test('go gateway has models registered', () => {
    const models = getModelsForGateway('opencode-go')
    expect(models.length).toBeGreaterThan(0)
  })

  test('models have vendorId openai', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    for (const model of models) {
      expect(model.vendorId).toBe('openai')
    }
  })

  test('all models have required fields', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    for (const model of models) {
      expect(model.id).toBeDefined()
      expect(model.label).toBeDefined()
      expect(model.vendorId).toBeDefined()
      expect(model.classification).toBeDefined()
      expect(model.defaultModel).toBeDefined()
      expect(model.capabilities).toBeDefined()
    }
  })

  test('all models have valid classification', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const validClassifications = ['chat', 'reasoning', 'vision', 'coding']
    for (const model of models) {
      expect(model.classification.length).toBeGreaterThan(0)
      for (const c of model.classification) {
        expect(validClassifications).toContain(c)
      }
    }
  })

  test('zen gpt models have correct classification', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-gpt-'))
    for (const model of models) {
      expect(model.classification).toContain('chat')
    }
  })

  test('zen claude models have correct classification', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-claude-'))
    for (const model of models) {
      expect(model.classification).toContain('chat')
    }
  })

  test('codex models have coding classification', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const codexModels = models.filter(m => m.defaultModel.includes('codex'))
    for (const model of codexModels) {
      expect(model.classification).toContain('coding')
    }
  })

  test('reasoning models have reasoning classification', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const reasoningModels = models.filter(m =>
      m.defaultModel.includes('opus') ||
      m.defaultModel === 'gpt-5.5-pro' ||
      m.defaultModel === 'gpt-5.4-pro' ||
      m.defaultModel === 'deepseek-v4-pro' ||
      m.defaultModel === 'gemini-3.1-pro'
    )
    for (const model of reasoningModels) {
      expect(model.classification).toContain('reasoning')
    }
  })

  test('no duplicate model ids', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const ids = models.map(m => m.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  test('no duplicate model ids across zen and go', () => {
    const zenModels = getCatalogEntriesForRoute('opencode')
    const goModels = getCatalogEntriesForRoute('opencode-go')
    const zenIds = new Set(zenModels.map(m => m.id))
    const goIds = new Set(goModels.map(m => m.id))
    for (const id of goIds) {
      expect(zenIds.has(id)).toBe(false)
    }
  })

  test('zen model count matches expected', () => {
    const models = getCatalogEntriesForRoute('opencode')
    expect(models.length).toBe(50)
  })

  test('go model count matches expected', () => {
    const models = getCatalogEntriesForRoute('opencode-go')
    expect(models.length).toBe(13)
  })

  test('go model set matches opencode.ai/go catalog exactly', () => {
    const models = getCatalogEntriesForRoute('opencode-go')
    const expectedIds = new Set([
      'opencode-go-glm-5.2',
      'opencode-go-qwen3.7-max',
      'opencode-go-kimi-k2.7-code',
      'opencode-go-mimo-v2.5-pro',
      'opencode-go-deepseek-v4-pro',
      'opencode-go-qwen3.7-plus',
      'opencode-go-minimax-m3',
      'opencode-go-mimo-v2.5',
      'opencode-go-deepseek-v4-flash',
      'opencode-go-glm-5.1',
      'opencode-go-kimi-k2.6',
      'opencode-go-qwen3.6-plus',
      'opencode-go-minimax-m2.7',
    ])
    const actualIds = new Set(models.map(m => m.id))
    // All expected IDs present
    for (const id of expectedIds) {
      expect(actualIds.has(id)).toBe(true)
    }
    // No removed or unexpected IDs remain
    for (const id of actualIds) {
      expect(expectedIds.has(id)).toBe(true)
    }
    // Explicitly verify removed models are not included
    const removedIds = [
      'opencode-go-minimax-m2.5',
      'opencode-go-kimi-k2.5',
      'opencode-go-glm-5',
      'opencode-go-qwen3.5-plus',
      'opencode-go-mimo-v2-pro',
      'opencode-go-mimo-v2-omni',
      'opencode-go-hy3-preview',
    ];
    for (const id of removedIds) {
      expect(actualIds.has(id)).toBe(false);
    }
  })

  test('all zen gpt models have modelDescriptorId', () => {
    const models = getCatalogEntriesForRoute('opencode')
    const gptModels = models.filter(m => m.apiName.startsWith('gpt-'))
    for (const model of gptModels) {
      expect(model.modelDescriptorId).toBeDefined()
      expect(model.modelDescriptorId).toMatch(/^opencode-gpt-/)
    }
  })

  test('all zen claude models have modelDescriptorId', () => {
    const models = getCatalogEntriesForRoute('opencode')
    const claudeModels = models.filter(m => m.apiName.startsWith('claude-'))
    for (const model of claudeModels) {
      expect(model.modelDescriptorId).toBeDefined()
      expect(model.modelDescriptorId).toMatch(/^opencode-claude-/)
    }
  })

  test('all go models have modelDescriptorId', () => {
    const models = getCatalogEntriesForRoute('opencode-go')
    for (const model of models) {
      expect(model.modelDescriptorId).toBeDefined()
      expect(model.modelDescriptorId).toMatch(/^opencode-go-/)
    }
  })

  test('go Anthropic-format models use the messages endpoint with x-api-key auth', () => {
    const models = getCatalogEntriesForRoute('opencode-go')
    const messagesModelIds = [
      'opencode-go-minimax-m3',
      'opencode-go-minimax-m2.7',
      'opencode-go-qwen3.7-max',
      'opencode-go-qwen3.7-plus',
      'opencode-go-qwen3.6-plus',
    ]
    for (const id of messagesModelIds) {
      const model = models.find(m => m.id === id)
      expect(model).toBeDefined()
      expect(model!.transportOverrides?.openaiShim).toMatchObject({
        endpointPath: '/messages',
        defaultAuthHeader: {
          name: 'x-api-key',
          scheme: 'raw',
        },
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Cross-Reference Tests
// ---------------------------------------------------------------------------

describe('OpenCode cross-reference consistency', () => {
  test('gateway catalog modelDescriptorIds match actual model descriptors', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const modelIds = new Set(models.map(m => m.id))
    const entry = getGateway('opencode')
    for (const catalogEntry of entry!.catalog!.models!) {
      if (catalogEntry.modelDescriptorId) {
        expect(modelIds.has(catalogEntry.modelDescriptorId)).toBe(true)
      }
    }
  })

  test('go gateway catalog modelDescriptorIds match actual model descriptors', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    const modelIds = new Set(models.map(m => m.id))
    const gateway = getGateway('opencode-go')
    for (const catalogEntry of gateway!.catalog!.models!) {
      if (catalogEntry.modelDescriptorId) {
        expect(modelIds.has(catalogEntry.modelDescriptorId)).toBe(true)
      }
    }
  })

  test('zen and go gateways share the same OPENCODE_API_KEY', () => {
    const zen = getGateway('opencode')
    const go = getGateway('opencode-go')
    expect(zen!.setup.credentialEnvVars).toEqual(go!.setup.credentialEnvVars)
  })
})

// ---------------------------------------------------------------------------
// Validation Registry Tests
// ---------------------------------------------------------------------------

describe('OpenCode integration validation', () => {
  test('registry validation passes with opencode descriptors', () => {
    const result = validateIntegrationRegistry()
    const opencodeErrors = result.errors.filter(e => e.includes('opencode'))
    expect(opencodeErrors).toHaveLength(0)
  })

  test('no preset id conflicts', () => {
    const result = validateIntegrationRegistry()
    const presetErrors = result.errors.filter(e => e.includes('preset'))
    expect(presetErrors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

describe('OpenCode edge cases', () => {
  test('zen catalog entries have unique ids', () => {
    const gateway = getGateway('opencode')
    const ids = gateway!.catalog!.models!.map(m => m.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  test('go catalog entries have unique ids', () => {
    const gateway = getGateway('opencode-go')
    const ids = gateway!.catalog!.models!.map(m => m.id)
    const uniqueIds = new Set(ids)
    expect(ids.length).toBe(uniqueIds.size)
  })

  test('zen catalog entries have unique apiNames', () => {
    const gateway = getGateway('opencode')
    const apiNames = gateway!.catalog!.models!.map(m => m.apiName)
    const uniqueApiNames = new Set(apiNames)
    expect(apiNames.length).toBe(uniqueApiNames.size)
  })

  test('go catalog entries have unique apiNames', () => {
    const gateway = getGateway('opencode-go')
    const apiNames = gateway!.catalog!.models!.map(m => m.apiName)
    const uniqueApiNames = new Set(apiNames)
    expect(apiNames.length).toBe(uniqueApiNames.size)
  })

  test('zen catalog entries have non-empty labels', () => {
    const gateway = getGateway('opencode')
    for (const entry of gateway!.catalog!.models!) {
      // label is optional in the catalog type; an undefined label fails too.
      expect((entry.label ?? '').length).toBeGreaterThan(0)
    }
  })

  test('go catalog entries have non-empty labels', () => {
    const gateway = getGateway('opencode-go')
    for (const entry of gateway!.catalog!.models!) {
      expect((entry.label ?? '').length).toBeGreaterThan(0)
    }
  })

  test('model descriptors have non-empty contextWindow', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    for (const model of models) {
      if (model.contextWindow !== undefined) {
        expect(model.contextWindow).toBeGreaterThan(0)
      }
    }
  })

  test('model descriptors have non-empty maxOutputTokens', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    for (const model of models) {
      if (model.maxOutputTokens !== undefined) {
        expect(model.maxOutputTokens).toBeGreaterThan(0)
      }
    }
  })

  test('model descriptors have valid defaultModel format', () => {
    const models = getAllModels().filter(m => m.id.startsWith('opencode-'))
    for (const model of models) {
      expect(model.defaultModel).toMatch(/^[a-z0-9\-\.]+$/)
    }
  })

  test('model descriptors preserve OpenCode provider limit metadata', () => {
    const models = new Map(
      getAllModels()
        .filter(m => m.id.startsWith('opencode-'))
        .map(model => [model.id, model]),
    )

    expect(models.get('opencode-qwen3.6-plus')?.contextWindow).toBe(262_144)
    expect(models.get('opencode-deepseek-v4-pro')?.maxOutputTokens).toBe(384_000)
    expect(models.get('opencode-go-minimax-m2.7')?.maxOutputTokens).toBe(131_072)
    expect(models.get('opencode-go-mimo-v2.5')?.contextWindow).toBe(1_000_000)
  })

  test('zen gateway validation message mentions OPENCODE_API_KEY', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.validation!.missingCredentialMessage).toContain('OPENCODE_API_KEY')
  })

  test('zen gateway validation message mentions opencode.ai', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.validation!.missingCredentialMessage).toContain('opencode.ai')
  })
})
