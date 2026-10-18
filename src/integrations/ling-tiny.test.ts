import { describe, expect, test } from 'bun:test'

import {
  getCatalogEntriesForRoute,
  getModel,
  getModelsForBrand,
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
  test('exposes the Tiny capabilities and limits to gateway catalogs', () => {
    const model = getModel('inclusionai/ling-3.0-tiny:free')

    expect(model).toBeDefined()
    expect(model).toMatchObject({
      id: 'inclusionai/ling-3.0-tiny:free',
      brandId: 'ling',
      classification: ['chat', 'reasoning', 'coding'],
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      capabilities: {
        supportsVision: false,
        supportsStreaming: true,
        supportsFunctionCalling: true,
        supportsJsonMode: false,
        supportsReasoning: true,
        supportsPreciseTokenCount: false,
      },
    })
    expect(getModelsForBrand('ling').map(m => m.id)).toContain(
      'inclusionai/ling-3.0-tiny:free',
    )

    // The gateway entry must map BOTH the wire id (apiName) and the picker
    // descriptor to the :free id — a mismatch would send a different model
    // upstream than the picker advertises.
    const catalogEntry = getCatalogEntriesForRoute(
      'gitlawb-opengateway',
      DURING_WINDOW,
    ).find(entry => entry.apiName === 'inclusionai/ling-3.0-tiny:free')
    expect(catalogEntry?.id).toBe('opengateway-ling-3.0-tiny-free')
    expect(catalogEntry?.modelDescriptorId).toBe(model?.id)

    expect(
      resolveModelRuntimeLimits({
        model: 'inclusionai/ling-3.0-tiny:free',
        baseUrl: 'https://opengateway.gitlawb.com/v1',
        processEnv: {},
      }),
    ).toEqual({ contextWindow: 262_144, maxOutputTokens: 32_768 })
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
