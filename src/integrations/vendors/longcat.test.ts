import { describe, expect, test } from 'bun:test'

import {
  ensureIntegrationsLoaded,
  getCatalogEntriesForRoute,
  getModel,
  getProviderPresetUiMetadata,
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  getVendor,
  resolveRouteIdFromBaseUrl,
  validateIntegrationRegistry,
} from '../index.js'
import { resolveModelReasoningControl } from '../../utils/effort.js'

describe('longcat vendor', () => {
  test('registers route defaults, catalog, and preset metadata', () => {
    ensureIntegrationsLoaded()

    for (const baseUrl of [
      'https://api.longcat.chat/openai',
      'https://api.longcat.chat/openai/v1',
    ]) {
      expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe('longcat')
    }
    expect(getRouteDefaultBaseUrl('longcat')).toBe(
      'https://api.longcat.chat/openai/v1',
    )
    expect(getRouteDefaultModel('longcat')).toBe('LongCat-2.0')

    const vendor = getVendor('longcat')
    expect(vendor).toMatchObject({
      defaultBaseUrl: 'https://api.longcat.chat/openai/v1',
      defaultModel: 'LongCat-2.0',
    })
    expect(vendor?.setup.credentialEnvVars).toEqual(['LONGCAT_API_KEY'])
    expect(vendor?.transportConfig.openaiShim?.thinkingRequestFormat).toBe(
      'zai-compatible',
    )
    expect(vendor?.transportConfig.openaiShim?.removeBodyFields).toContain(
      'reasoning_effort',
    )
    expect(vendor?.transportConfig.openaiShim?.removeBodyFields).toContain(
      'stream_options',
    )

    const entry = getCatalogEntriesForRoute('longcat').find(
      entry => entry.id === 'LongCat-2.0',
    )
    expect(entry).toMatchObject({
      apiName: 'LongCat-2.0',
      modelDescriptorId: 'LongCat-2.0',
    })

    const model = getModel('LongCat-2.0')
    expect(model).toMatchObject({
      id: 'LongCat-2.0',
      vendorId: 'longcat',
      contextWindow: 1_048_576,
      maxOutputTokens: 131_072,
      capabilities: {
        supportsStreaming: true,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
        supportsReasoning: true,
        supportsPreciseTokenCount: false,
      },
    })

    const preset = getProviderPresetUiMetadata('longcat')
    expect(preset.routeId).toBe('longcat')
    expect(preset.credentialEnvVars).toContain('LONGCAT_API_KEY')
    expect(preset.baseUrl).toBe('https://api.longcat.chat/openai/v1')
    expect(preset.model).toBe('LongCat-2.0')

    const validation = validateIntegrationRegistry()
    expect(validation.valid).toBe(true)
  })

  test('exposes LongCat reasoning without unsupported effort levels', () => {
    ensureIntegrationsLoaded()

    expect(
      resolveModelReasoningControl('LongCat-2.0', { routeId: 'longcat' }),
    ).toMatchObject({
      supportsReasoning: true,
      controllable: false,
      source: 'capability',
      levels: [],
    })
  })
})
