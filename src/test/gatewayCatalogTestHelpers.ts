import { expect } from 'bun:test'

import type {
  GatewayDescriptor,
  ModelCatalogConfig,
  ModelDiscoveryConfig,
  OpenAIShimTransportConfig,
  ValidationMetadata,
  ValidationRoutingMetadata,
} from '../integrations/descriptors.js'
import { parseDurationString } from '../integrations/discoveryCache.js'
import {
  ensureIntegrationsLoaded,
  getCatalogForGateway,
  getGateway,
  getModel,
} from '../integrations/index.js'

type CredentialValidation = Extract<ValidationMetadata, { kind: 'credential-env' }>

export type GatewayCatalogExpectations = {
  baseUrl?: GatewayDescriptor['defaultBaseUrl']
  defaultModel?: GatewayDescriptor['defaultModel']
  category?: GatewayDescriptor['category']
  supportsModelRouting?: GatewayDescriptor['supportsModelRouting']
  setup?: Partial<GatewayDescriptor['setup']>
  preset?: Partial<NonNullable<GatewayDescriptor['preset']>>
  validation?: Omit<Partial<CredentialValidation>, 'routing'> & {
    routing?: Partial<ValidationRoutingMetadata>
  }
  openaiShim?: Partial<OpenAIShimTransportConfig>
  discovery?: Partial<ModelDiscoveryConfig>
  catalogSource: ModelCatalogConfig['source']
  discoveryRefreshMode?: ModelCatalogConfig['discoveryRefreshMode']
  allowManualRefresh?: ModelCatalogConfig['allowManualRefresh']
  usage?: Partial<NonNullable<GatewayDescriptor['usage']>>
  allowEmptyCatalog?: boolean
}

// Iterating supplied keys preserves explicit undefined expectations.
function expectFields<T extends object>(
  actual: T | undefined,
  expected: Partial<T>,
): void {
  expect(actual).toBeDefined()
  if (!actual) throw new Error('Expected gateway metadata to exist')
  for (const key of Object.keys(expected) as (keyof T)[]) {
    expect<T[keyof T] | undefined>(actual[key]).toEqual(expected[key])
  }
}

export function expectGatewayCatalog(
  routeId: string,
  expected: GatewayCatalogExpectations,
): void {
  ensureIntegrationsLoaded()
  const gateway = getGateway(routeId)
  const catalog = getCatalogForGateway(routeId)
  expect(gateway).toBeDefined()
  expect(catalog).toBeDefined()
  if (!gateway || !catalog) throw new Error(`Missing gateway catalog: ${routeId}`)

  expect(gateway.id).toBe(routeId)
  expect(gateway.label.trim().length).toBeGreaterThan(0)
  if ('baseUrl' in expected) expect(gateway.defaultBaseUrl).toBe(expected.baseUrl)
  if ('defaultModel' in expected) {
    expect(gateway.defaultModel).toBe(expected.defaultModel)
  }
  if ('category' in expected) expect(gateway.category).toBe(expected.category)
  if ('supportsModelRouting' in expected) {
    expect(gateway.supportsModelRouting).toBe(expected.supportsModelRouting)
  }
  if (expected.setup) expectFields(gateway.setup, expected.setup)
  if (expected.preset) expectFields(gateway.preset, expected.preset)
  if (expected.validation) {
    const { routing, ...validation } = expected.validation
    expectFields(gateway.validation, validation)
    if (routing) expectFields(gateway.validation?.routing, routing)
  }
  if (expected.usage) expectFields(gateway.usage, expected.usage)
  expect(gateway.transportConfig.kind).toBe('openai-compatible')
  if (expected.openaiShim) {
    expectFields(gateway.transportConfig.openaiShim, expected.openaiShim)
  }

  expect(catalog.source).toBe(expected.catalogSource)
  if (catalog.source === 'dynamic' || catalog.source === 'hybrid') {
    expect(catalog.discovery?.kind).toBe('openai-compatible')
    expect(typeof catalog.discovery?.mapModel).toBe('function')
  }
  if (expected.discovery) {
    const { mapModel, ...discovery } = expected.discovery
    expectFields(catalog.discovery, discovery)
    if ('mapModel' in expected.discovery) {
      expect(catalog.discovery?.mapModel).toBe(mapModel)
    }
  }
  if (catalog.discoveryCacheTtl !== undefined) {
    const ttl = parseDurationString(catalog.discoveryCacheTtl)
    expect(Number.isFinite(ttl)).toBe(true)
    expect(ttl).toBeGreaterThan(0)
  }
  if ('discoveryRefreshMode' in expected) {
    expect(catalog.discoveryRefreshMode).toBe(expected.discoveryRefreshMode)
  }
  if ('allowManualRefresh' in expected) {
    expect(catalog.allowManualRefresh).toBe(expected.allowManualRefresh)
  }

  // Raw entries include hidden and expired models filtered out by route lookup.
  const entries = catalog.models ?? []
  if (!expected.allowEmptyCatalog) {
    expect(entries.length).toBeGreaterThan(0)
    if (gateway.defaultModel !== undefined) {
      expect(
        entries.some(entry => entry.apiName === gateway.defaultModel),
      ).toBe(true)
    }
  }
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length)
  expect(new Set(entries.map(entry => entry.apiName)).size).toBe(entries.length)
  for (const entry of entries) {
    expect(entry.id.trim().length).toBeGreaterThan(0)
    expect(entry.apiName.trim().length).toBeGreaterThan(0)
    if (entry.label !== undefined) {
      expect(entry.label.trim().length).toBeGreaterThan(0)
    }
    if (entry.modelDescriptorId !== undefined) {
      expect(getModel(entry.modelDescriptorId)).toBeDefined()
    }
  }
}
