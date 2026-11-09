import { describe, expect, test } from 'bun:test'

import { mapOpenGatewayModel } from './gateways/gitlawb-opengateway.js'
import {
  getModel,
  getModelsForBrand,
  getRouteDefaultBaseUrl,
  resolveRouteIdFromBaseUrl,
} from './index.js'
import { resolveModelRuntimeLimits } from './runtimeMetadata.js'

describe('Macaron V1 Tall descriptor', () => {
  test('links gateway wire models to descriptors and resolves limits by base URL', () => {
    const routeId = 'gitlawb-opengateway'
    const baseUrl = 'https://api.twigpine.com/v1'
    expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe(routeId)
    expect(getRouteDefaultBaseUrl(routeId)).toBe(baseUrl)

    for (const { id, limits, classification, capabilities } of [
      {
        id: 'mindai/macaron-v1-tall',
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
      // The gateway no longer curates this route: its live /v1/models row
      // maps straight onto the descriptor id, and runtime limits resolve
      // from the descriptor without a catalog entry.
      expect(mapOpenGatewayModel({ id })?.apiName).toBe(model?.id)
      expect(
        resolveModelRuntimeLimits({ model: id, baseUrl, processEnv: {} }),
      ).toEqual(limits)
    }
  })
})
