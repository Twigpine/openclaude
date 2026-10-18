// src/integrations/index.test.ts
// Integration test: validates the full registry after loading all descriptors.

import { describe, expect, test } from 'bun:test'
import {
  getBrandsForVendor,
  getAllGateways,
  getAllVendors,
  getCatalogEntriesForRoute,
  getModel,
  getModelsForVendor,
  routeSupportsApiFormatSelection,
  routeSupportsAuthHeaders,
  routeSupportsCustomHeaders,
  validateIntegrationRegistry,
} from './index.js'

describe('loaded registry validation', () => {
  test('registry is valid after loading all descriptors', () => {
    const result = validateIntegrationRegistry()
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test('MiniMax has shared brand and model descriptors wired to its route catalog', () => {
    expect(getBrandsForVendor('minimax').map(brand => brand.id)).toContain(
      'minimax',
    )
    expect(getModelsForVendor('minimax').map(model => model.id)).toContain(
      'minimax-m2.7',
    )
    expect(
      getCatalogEntriesForRoute('minimax').every(entry =>
        Boolean(entry.modelDescriptorId),
      ),
    ).toBe(true)
    expect(routeSupportsApiFormatSelection('minimax')).toBe(false)
    expect(routeSupportsAuthHeaders('minimax')).toBe(false)
    expect(routeSupportsCustomHeaders('minimax')).toBe(false)
    expect(routeSupportsCustomHeaders('custom-anthropic')).toBe(true)
  })

  test('route catalogs do not duplicate defaultModel with catalog default flags', () => {
    const routes = [...getAllVendors(), ...getAllGateways()]
    expect(
      routes.flatMap(route =>
        (route.catalog?.models ?? [])
          .filter(model => model.default)
          .map(model => `${route.id}:${model.id}`),
      ),
    ).toEqual([])
  })

  test('dynamic route catalogs rely entirely on discovery', () => {
    const routes = [...getAllVendors(), ...getAllGateways()]
    const dynamicCatalogsWithCuratedModels = routes
      .filter(route => route.catalog?.source === 'dynamic')
      .filter(route => (route.catalog?.models ?? []).length > 0)
      .map(route => route.id)

    expect(dynamicCatalogsWithCuratedModels).toEqual([])
  })

  test('static gateway catalog entries use shared model descriptors when known', () => {
    const descriptorOptionalEntries = new Set([
      'azure-openai:azure-deployment',
      // Virtual model — the gateway's smart router resolves it server-side,
      // so there is no concrete model descriptor to reference.
      'gitlawb-opengateway:opengateway-auto',
      // Cloudflare Workers AI serves provider-specific quantized builds
      // (`@cf/...`) with no shared cross-provider model descriptor, the same
      // situation as azure-deployment above. See gateways/cloudflare.ts (#1100).
      'cloudflare:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      'cloudflare:@cf/meta/llama-3.1-8b-instruct',
      'cloudflare:@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
      'cloudflare:@cf/qwen/qwen2.5-coder-32b-instruct',
    ])
    const missingDescriptors = getAllGateways().flatMap(gateway =>
      (gateway.catalog?.models ?? [])
        .filter(entry => !descriptorOptionalEntries.has(`${gateway.id}:${entry.id}`))
        .filter(entry => !entry.modelDescriptorId)
        .map(entry => `${gateway.id}:${entry.id}`),
    )

    expect(missingDescriptors).toEqual([])
  })

  test('gateway defaultModel values are present unless provided outside curated catalog metadata', () => {
    const routesWithExternalDefaultModelSources = new Set([
      'atomic-chat',
      'concentrate',
      'custom',
      'lmstudio',
      'ollama',
    ])
    const missingDefaults = getAllGateways()
      .filter(gateway => gateway.defaultModel)
      .filter(gateway => !routesWithExternalDefaultModelSources.has(gateway.id))
      .filter(gateway => {
        const defaultModel = gateway.defaultModel?.trim()
        return !(gateway.catalog?.models ?? []).some(
          entry =>
            entry.id === defaultModel ||
            entry.apiName === defaultModel ||
            entry.modelDescriptorId === defaultModel,
        )
      })
      .map(gateway => `${gateway.id}:${gateway.defaultModel}`)

    expect(missingDefaults).toEqual([])
  })

  test('gateway modelDescriptorId references have model metadata', () => {
    const missingModels = getAllGateways().flatMap(gateway =>
      (gateway.catalog?.models ?? [])
        .filter(entry => entry.modelDescriptorId)
        .filter(entry => !getModel(entry.modelDescriptorId!))
        .map(entry => `${gateway.id}:${entry.id}:${entry.modelDescriptorId}`),
    )

    expect(missingModels).toEqual([])
  })
})
