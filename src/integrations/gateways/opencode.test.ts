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
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

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

describe('OpenCode gateway catalogs', () => {
  describe.each([
    {
      routeId: 'opencode',
      expected: {
        baseUrl: 'https://opencode.ai/zen/v1',
        defaultModel: 'gpt-5.4',
        category: 'aggregating',
        setup: {
          requiresAuth: true,
          authMode: 'api-key',
          credentialEnvVars: ['OPENCODE_API_KEY'],
        },
        preset: {
          id: 'opencode',
          vendorId: 'openai',
          apiKeyEnvVars: ['OPENCODE_API_KEY'],
        },
        validation: { kind: 'credential-env' },
        usage: { supported: false },
        catalogSource: 'static',
      } satisfies GatewayCatalogExpectations,
    },
    {
      routeId: 'opencode-go',
      expected: {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        defaultModel: 'glm-5.1',
        category: 'aggregating',
        setup: {
          requiresAuth: true,
          authMode: 'api-key',
          credentialEnvVars: ['OPENCODE_API_KEY'],
        },
        preset: {
          id: 'opencode-go',
          vendorId: 'openai',
          apiKeyEnvVars: ['OPENCODE_API_KEY'],
        },
        catalogSource: 'static',
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
    })
  })
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

  test('has static models in catalog', () => {
    const gateway = getGateway('opencode')
    expect(gateway!.catalog!.models).toBeDefined()
    expect(gateway!.catalog!.models!.length).toBeGreaterThan(0)
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

  test('go catalog excludes removed model ids', () => {
    const models = getCatalogEntriesForRoute('opencode-go')
    const ids = models.map(m => m.id)
    const removedModelIds = [
      'opencode-go-minimax-m2.5',
      'opencode-go-kimi-k2.5',
      'opencode-go-glm-5',
      'opencode-go-qwen3.5-plus',
      'opencode-go-mimo-v2-pro',
      'opencode-go-mimo-v2-omni',
      'opencode-go-hy3-preview',
    ]
    for (const id of removedModelIds) {
      expect(ids).not.toContain(id)
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
