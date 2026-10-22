import { describe, expect, test } from 'bun:test'

import {
  getCatalogEntriesForRoute,
  getModel,
  getModelsForBrand,
  getRouteDefaultBaseUrl,
  resolveRouteIdFromBaseUrl,
} from './index.js'
import { resolveModelRuntimeLimits } from './runtimeMetadata.js'

describe('Macaron V1 Tall descriptor', () => {
  test('links gateway wire models to descriptors and resolves limits by base URL', () => {
    const routeId = 'gitlawb-opengateway'
    const baseUrl = 'https://opengateway.gitlawb.com/v1'
    expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
    expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)

    for (const { id, catalogId, limits, classification, capabilities } of [
      {
        id: 'mindai/macaron-v1-tall',
        catalogId: 'opengateway-macaron-v1-tall',
        limits: { contextWindow: 262_144, maxOutputTokens: 32_768 },
        classification: ['chat', 'reasoning', 'coding'],
        capabilities: {
          supportsVision: false,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
          supportsReasoning: true,
        },
      },
    ]) {
      const model = getModel(id)
      expect(model).toMatchObject({
        id,
        brandId: 'macaron',
        defaultModel: id,
        ...limits,
        classification,
        capabilities,
      })
      expect(getModelsForBrand('macaron').map(m => m.id)).toContain(id)
      const entry = getCatalogEntriesForRoute(routeId).find(e => e.id === catalogId)
      expect(entry).toMatchObject({ apiName: id, modelDescriptorId: model?.id })
      expect(
        resolveModelRuntimeLimits({ model: id, baseUrl, processEnv: {} }),
      ).toEqual(limits)
    }
  })
})
