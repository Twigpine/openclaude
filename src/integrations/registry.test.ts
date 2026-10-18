// src/integrations/registry.test.ts

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ensureIntegrationsLoaded } from './index.js'
import {
  _clearRegistryForTesting,
  getAllAnthropicProxies,
  getAllBrands,
  getAllGateways,
  getAllModels,
  getAllVendors,
  getBrand,
  getCatalogEntriesForRoute,
  getGateway,
  getModelsForBrand,
  getModelsForGateway,
  getVendor,
  registerAnthropicProxy,
  registerBrand,
  registerGateway,
  registerModel,
  registerVendor,
  setRegistryLazyLoader,
  validateIntegrationRegistry,
} from './registry.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

beforeEach(async () => {
  await acquireSharedMutationLock('integrations/registry.test.ts')
  _clearRegistryForTesting()
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
// Helpers to build minimal valid descriptors
// ---------------------------------------------------------------------------

function makeVendor(id: string, overrides?: Partial<import('./descriptors.js').VendorDescriptor>): import('./descriptors.js').VendorDescriptor {
  return {
    id,
    label: id,
    classification: 'openai-compatible',
    defaultBaseUrl: 'https://example.com',
    defaultModel: 'model-1',
    setup: { requiresAuth: true, authMode: 'api-key' },
    transportConfig: { kind: 'openai-compatible' },
    ...overrides,
  }
}

function makeGateway(id: string, overrides?: Partial<import('./descriptors.js').GatewayDescriptor>): import('./descriptors.js').GatewayDescriptor {
  return {
    id,
    label: id,
    setup: { requiresAuth: true, authMode: 'api-key' },
    transportConfig: { kind: 'openai-compatible' },
    ...overrides,
  }
}

function makeBrand(id: string, overrides?: Partial<import('./descriptors.js').BrandDescriptor>): import('./descriptors.js').BrandDescriptor {
  return {
    id,
    label: id,
    canonicalVendorId: 'openai',
    defaultCapabilities: {},
    ...overrides,
  }
}

function makeModel(id: string, overrides?: Partial<import('./descriptors.js').ModelDescriptor>): import('./descriptors.js').ModelDescriptor {
  return {
    id,
    label: id,
    vendorId: 'openai',
    classification: ['chat'],
    defaultModel: 'model-1',
    capabilities: {},
    ...overrides,
  }
}

function makeAnthropicProxy(id: string, overrides?: Partial<import('./descriptors.js').AnthropicProxyDescriptor>): import('./descriptors.js').AnthropicProxyDescriptor {
  return {
    id,
    label: id,
    classification: 'anthropic-proxy',
    defaultBaseUrl: 'https://proxy.example.com',
    defaultModel: 'claude-sonnet',
    setup: { requiresAuth: true, authMode: 'api-key' },
    envVarConfig: { authTokenEnvVar: 'PROXY_API_KEY', baseUrlEnvVar: 'PROXY_BASE_URL' },
    capabilities: {},
    transportConfig: { kind: 'anthropic-proxy' },
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Register / retrieve
// ---------------------------------------------------------------------------

describe('register and get', () => {
  test('vendor roundtrip', () => {
    const v = makeVendor('acme')
    registerVendor(v)
    expect(getVendor('acme')).toBe(v)
  })

  test('gateway roundtrip', () => {
    const g = makeGateway('acme-gw')
    registerGateway(g)
    expect(getGateway('acme-gw')).toBe(g)
  })

  test('brand roundtrip', () => {
    const b = makeBrand('acme-brand')
    registerBrand(b)
    expect(getBrand('acme-brand')).toBe(b)
  })

  test('model roundtrip', () => {
    const m = makeModel('acme-model')
    registerModel(m)
    expect(getAllModels().find(x => x.id === 'acme-model')).toBe(m)
  })

  test('anthropic proxy roundtrip', () => {
    const p = makeAnthropicProxy('acme-proxy')
    registerAnthropicProxy(p)
    expect(getAllAnthropicProxies().find(x => x.id === 'acme-proxy')).toBe(p)
  })

  test('duplicate vendor id throws', () => {
    registerVendor(makeVendor('dup'))
    expect(() => registerVendor(makeVendor('dup'))).toThrow('Duplicate vendor id: dup')
  })

  test('duplicate gateway id throws', () => {
    registerGateway(makeGateway('dup-gw'))
    expect(() => registerGateway(makeGateway('dup-gw'))).toThrow('Duplicate gateway id: dup-gw')
  })

  test('duplicate brand id throws', () => {
    registerBrand(makeBrand('dup-brand'))
    expect(() => registerBrand(makeBrand('dup-brand'))).toThrow('Duplicate brand id: dup-brand')
  })

  test('duplicate model id throws', () => {
    registerModel(makeModel('dup-model'))
    expect(() => registerModel(makeModel('dup-model'))).toThrow('Duplicate model id: dup-model')
  })

  test('duplicate anthropic proxy id throws', () => {
    registerAnthropicProxy(makeAnthropicProxy('dup-proxy'))
    expect(() => registerAnthropicProxy(makeAnthropicProxy('dup-proxy'))).toThrow(
      'Duplicate anthropic proxy id: dup-proxy',
    )
  })
})

// ---------------------------------------------------------------------------
// List helpers
// ---------------------------------------------------------------------------

describe('list helpers', () => {
  test('getAllVendors returns copy', () => {
    registerVendor(makeVendor('v1'))
    const first = getAllVendors()
    const second = getAllVendors()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })

  test('getAllGateways returns copy', () => {
    registerGateway(makeGateway('g1'))
    const first = getAllGateways()
    const second = getAllGateways()
    expect(first).toEqual(second)
    expect(first).not.toBe(second)
  })
})

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

describe('catalog helpers', () => {
  test('getCatalogEntriesForRoute returns gateway catalog models', () => {
    registerGateway(
      makeGateway('gw-1', {
        catalog: {
          source: 'static',
          models: [
            { id: 'm1', apiName: 'model-1', default: true },
            { id: 'm2', apiName: 'model-2' },
          ],
        },
      }),
    )
    const entries = getCatalogEntriesForRoute('gw-1')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).toBe('m1')
  })

  test('getModelsForGateway enriches with shared model descriptors', () => {
    registerGateway(
      makeGateway('gw-1', {
        catalog: {
          source: 'static',
          models: [
            { id: 'cm1', apiName: 'claude-model', modelDescriptorId: 'claude-sonnet' },
          ],
        },
      }),
    )
    registerModel(makeModel('claude-sonnet', { brandId: 'claude' }))

    const enriched = getModelsForGateway('gw-1')
    expect(enriched).toHaveLength(1)
    expect(enriched[0]!.id).toBe('claude-sonnet')
  })

  test('getModelsForBrand filters by brandId', () => {
    registerModel(makeModel('m-claude', { brandId: 'claude' }))
    registerModel(makeModel('m-gpt', { brandId: 'gpt' }))
    expect(getModelsForBrand('claude')).toHaveLength(1)
    expect(getModelsForBrand('claude')[0]!.id).toBe('m-claude')
  })

  test('hidden entries are dropped from catalog resolution', () => {
    registerGateway(
      makeGateway('gw-1', {
        catalog: {
          source: 'static',
          models: [
            { id: 'visible', apiName: 'model-visible' },
            { id: 'invisible', apiName: 'model-hidden', hidden: true },
          ],
        },
      }),
    )
    const entries = getCatalogEntriesForRoute('gw-1')
    expect(entries.map(e => e.id)).toEqual(['visible'])
  })

  test('availableUntil expires entries at the cutoff instant, exclusive', () => {
    registerGateway(
      makeGateway('gw-1', {
        catalog: {
          source: 'static',
          models: [
            { id: 'evergreen', apiName: 'model-evergreen' },
            {
              id: 'time-boxed',
              apiName: 'model-window',
              availableUntil: '2026-08-13T10:00:00Z',
            },
          ],
        },
      }),
    )
    const before = getCatalogEntriesForRoute('gw-1', new Date('2026-08-13T09:59:59Z'))
    expect(before.map(e => e.id)).toEqual(['evergreen', 'time-boxed'])

    const atCutoff = getCatalogEntriesForRoute('gw-1', new Date('2026-08-13T10:00:00Z'))
    expect(atCutoff.map(e => e.id)).toEqual(['evergreen'])

    const after = getCatalogEntriesForRoute('gw-1', new Date('2026-08-13T10:00:01Z'))
    expect(after.map(e => e.id)).toEqual(['evergreen'])
  })

  test('a malformed availableUntil fails open (entry stays visible)', () => {
    registerGateway(
      makeGateway('gw-1', {
        catalog: {
          source: 'static',
          models: [
            { id: 'typo', apiName: 'model-typo', availableUntil: 'not-a-date' },
          ],
        },
      }),
    )
    const entries = getCatalogEntriesForRoute('gw-1', new Date('2099-01-01T00:00:00Z'))
    expect(entries.map(e => e.id)).toEqual(['typo'])
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateIntegrationRegistry', () => {
  test('empty registry is valid', () => {
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('catches missing modelDescriptorId reference', () => {
    registerGateway(
      makeGateway('gw-bad', {
        catalog: {
          source: 'static',
          models: [{ id: 'e1', apiName: 'a1', modelDescriptorId: 'missing-model' }],
        },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('missing-model'))).toBe(true)
  })

  test('catches duplicate catalog entry ids within same route', () => {
    registerGateway(
      makeGateway('gw-dup', {
        catalog: {
          source: 'static',
          models: [
            { id: 'e1', apiName: 'a1' },
            { id: 'e1', apiName: 'a2' },
          ],
        },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('Duplicate catalog entry id'))).toBe(true)
  })

  test('catches catalog default flags when route defaultModel is set', () => {
    registerGateway(
      makeGateway('gw-duplicate-default', {
        defaultModel: 'model-1',
        catalog: {
          source: 'static',
          models: [{ id: 'e1', apiName: 'model-1', default: true }],
        },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(
      result.errors.some(error =>
        error.includes('must not set default because the route defines defaultModel'),
      ),
    ).toBe(true)
  })

  test('catches openaiShim overrides on non-openai-compatible route', () => {
    registerGateway(
      makeGateway('gw-native', {
        transportConfig: { kind: 'anthropic-native' },
        catalog: {
          source: 'static',
          models: [
            {
              id: 'e1',
              apiName: 'a1',
              transportOverrides: { openaiShim: { maxTokensField: 'max_tokens' } },
            },
          ],
        },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('openaiShim overrides but route transport is'))).toBe(true)
  })

  test('catches usage delegate to missing vendor', () => {
    registerGateway(
      makeGateway('gw-delegate', {
        usage: { supported: true, delegateToVendorId: 'missing-vendor' },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('delegates usage to missing vendor'))).toBe(true)
  })

  test('catches usage delegate to missing gateway', () => {
    registerVendor(
      makeVendor('v-delegate', {
        usage: { supported: true, delegateToGatewayId: 'missing-gateway' },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.includes('delegates usage to missing gateway'))).toBe(true)
  })

  test('warns on static catalog with no models and no discovery', () => {
    registerGateway(
      makeGateway('gw-empty', {
        catalog: { source: 'static', models: [] },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.warnings.some(w => w.includes('has no models and no discovery config'))).toBe(true)
  })

  test('allows static catalog with no models when discovery is configured', () => {
    registerGateway(
      makeGateway('gw-discovery', {
        catalog: {
          source: 'static',
          models: [],
          discovery: { kind: 'openai-compatible' },
        },
      }),
    )
    const result = validateIntegrationRegistry()
    expect(result.warnings.some(w => w.includes('has no models and no discovery config'))).toBe(false)
  })

  test('catches dynamic catalogs with curated models', () => {
    registerGateway(
      makeGateway('gw-dynamic-curated', {
        catalog: {
          source: 'dynamic',
          discovery: { kind: 'openai-compatible' },
          models: [{ id: 'curated-model', apiName: 'curated-model' }],
        },
      }),
    )

    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(
      result.errors.some(e =>
        e.includes('must use source "hybrid" when declaring curated models'),
      ),
    ).toBe(true)
  })

  test('catches duplicate preset ids across routes', () => {
    registerVendor(
      makeVendor('vendor-one', {
        preset: {
          id: 'shared-preset',
          description: 'Shared preset',
          apiKeyEnvVars: ['VENDOR_ONE_KEY'],
        },
      }),
    )
    registerVendor(
      makeVendor('vendor-two', {
        preset: {
          id: 'shared-preset',
          description: 'Shared preset',
          apiKeyEnvVars: ['VENDOR_TWO_KEY'],
        },
      }),
    )

    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(error => error.includes('Duplicate preset id "shared-preset"'))).toBe(true)
  })

  test('catches non-vendor preset routes without preset.vendorId', () => {
    registerVendor(makeVendor('openai'))
    registerGateway(
      makeGateway('gw-missing-vendor', {
        defaultBaseUrl: 'https://gateway.example.com/v1',
        defaultModel: 'gateway-model',
        preset: {
          id: 'gateway-preset',
          description: 'Gateway preset',
          apiKeyEnvVars: ['GATEWAY_KEY'],
        },
      }),
    )

    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(error => error.includes('must declare preset.vendorId'))).toBe(true)
  })

  test('catches preset routes without enough base-url metadata for UI defaults', () => {
    registerVendor(
      makeVendor('vendor-no-base', {
        defaultBaseUrl: '',
        preset: {
          id: 'vendor-no-base',
          description: 'Vendor without base URL',
          apiKeyEnvVars: ['VENDOR_KEY'],
        },
      }),
    )

    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(false)
    expect(result.errors.some(error => error.includes('defaultBaseUrl or preset.fallbackBaseUrl'))).toBe(true)
  })
})

describe('lazy loader', () => {
  test('stays armed and retries after a failed load', () => {
    _clearRegistryForTesting()
    let calls = 0
    setRegistryLazyLoader(() => {
      calls++
      if (calls === 1) {
        throw new Error('loader boom')
      }
      registerBrand(makeBrand('lazy-retry-brand'))
    })

    // First read runs the loader, which throws; the error must propagate AND the
    // loader must stay armed (not be cleared mid-failure) so a retry is possible.
    expect(() => getBrand('lazy-retry-brand')).toThrow('loader boom')

    // Second read retries the loader, which now succeeds and registers.
    expect(getBrand('lazy-retry-brand')?.id).toBe('lazy-retry-brand')
    expect(calls).toBe(2)

    // Once loaded, the loader is cleared and not invoked again.
    getBrand('lazy-retry-brand')
    expect(calls).toBe(2)
  })
})
