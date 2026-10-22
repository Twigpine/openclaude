import { describe, expect, test } from 'bun:test'

import {
  getCatalogEntriesForRoute,
  getModel,
  getRouteDefaultBaseUrl,
  resolveRouteIdFromBaseUrl,
} from './index.js'
import { resolveModelRuntimeLimits } from './runtimeMetadata.js'

describe('Tencent HY3 descriptor', () => {
  test('links gateway wire models to descriptors and resolves limits by base URL', () => {
    const routeId = 'gitlawb-opengateway'
    const baseUrl = 'https://opengateway.gitlawb.com/v1'
    expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
    expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)

    for (const { id, catalogId, limits, classification, capabilities } of [
      {
        id: 'tencent/hy3',
        catalogId: 'opengateway-tencent-hy3',
        limits: { contextWindow: 262_144, maxOutputTokens: 131_072 },
        classification: ['chat', 'reasoning', 'coding'],
        capabilities: {
          supportsVision: false,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
          supportsReasoning: true,
        },
      },
    ]) {
      const model = getModel(id)
      expect(model).toMatchObject({
        id,
        defaultModel: id,
        ...limits,
        classification,
        capabilities,
      })
      const entry = getCatalogEntriesForRoute(routeId).find(e => e.id === catalogId)
      expect(entry).toMatchObject({ apiName: id, modelDescriptorId: model?.id })
      expect(
        resolveModelRuntimeLimits({ model: id, baseUrl, processEnv: {} }),
      ).toEqual(limits)
    }
  })
})
