import { describe, expect, test } from 'bun:test'

import {
  getCatalogEntriesForRoute,
  getModel,
  getModelsForBrand,
  getRouteDefaultBaseUrl,
  resolveRouteIdFromBaseUrl,
} from './index.js'
import { resolveModelRuntimeLimits } from './runtimeMetadata.js'

// All three sides of the Ling Tiny availability window (availableUntil on
// the gitlawb-opengateway catalog entry, mirroring the gateway's
// LING_TINY_FREE_END_ISO = 2026-08-13T10:00:00Z). The cutoff itself is
// exclusive: at exactly the cutoff instant the entry is already gone.
const DURING_WINDOW = new Date('2026-08-12T00:00:00Z')
const AT_CUTOFF = new Date('2026-08-13T10:00:00Z')
const AFTER_WINDOW = new Date('2026-08-13T10:00:01Z')

describe('Ling 3.0 Tiny :free descriptor', () => {
  test('links gateway wire models to descriptors and resolves limits by base URL', () => {
    const routeId = 'gitlawb-opengateway'
    const baseUrl = 'https://opengateway.gitlawb.com/v1'
    expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
    expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)

    for (const { id, catalogId, limits, classification, capabilities } of [
      {
        id: 'inclusionai/ling-3.0-tiny:free',
        catalogId: 'opengateway-ling-3.0-tiny-free',
        limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
        classification: ['chat', 'reasoning', 'coding'],
        capabilities: {
          supportsVision: false,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
          supportsReasoning: true,
          supportsPreciseTokenCount: false,
        },
      },
    ]) {
      const model = getModel(id)
      expect(model).toMatchObject({
        id,
        brandId: 'ling',
        defaultModel: id,
        ...limits,
        classification,
        capabilities,
      })
      expect(getModelsForBrand('ling').map(m => m.id)).toContain(id)
      const entry = getCatalogEntriesForRoute(routeId, DURING_WINDOW).find(
        e => e.id === catalogId,
      )
      expect(entry).toMatchObject({ apiName: id, modelDescriptorId: model?.id })
      expect(
        resolveModelRuntimeLimits({ model: id, baseUrl, processEnv: {} }),
      ).toEqual(limits)
    }
  })

  test('availableUntil drops the entry from catalog resolution after the window', () => {
    const during = getCatalogEntriesForRoute('gitlawb-opengateway', DURING_WINDOW)
    expect(during.some(e => e.id === 'opengateway-ling-3.0-tiny-free')).toBe(true)

    // Boundary: at exactly the cutoff instant — and any time after — the
    // picker must not offer the id the gateway now rejects; the entry
    // disappears without a client release.
    const atCutoff = getCatalogEntriesForRoute('gitlawb-opengateway', AT_CUTOFF)
    expect(atCutoff.some(e => e.id === 'opengateway-ling-3.0-tiny-free')).toBe(false)
    const after = getCatalogEntriesForRoute('gitlawb-opengateway', AFTER_WINDOW)
    expect(after.some(e => e.id === 'opengateway-ling-3.0-tiny-free')).toBe(false)

    // Entries without availableUntil are untouched by the filter.
    expect(after.some(e => e.id === 'opengateway-ling-3.0-flash-free')).toBe(true)
    expect(after.length).toBe(during.length - 1)
  })
})
