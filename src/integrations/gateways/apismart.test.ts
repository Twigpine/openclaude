import { describe, expect, test } from 'bun:test'

import apismart from './apismart.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

const mapModel = apismart.catalog?.discovery?.mapModel

describe('apismart gateway', () => {
  describe.each([
    {
      routeId: 'apismart',
      expected: {
        baseUrl: 'https://gw.apismart.ai/v1',
        defaultModel: 'DEEPSEEK_V4_FLASH',
        setup: {
          credentialEnvVars: ['APISMART_API_KEY'],
          dedicatedCredentialsOnly: true,
        },
        catalogSource: 'hybrid',
        discovery: { requiresAuth: true },
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
    })
  })

  test('mapModel keeps chat models and drops image/video ids', () => {
    if (!mapModel) throw new Error('mapModel missing')
    expect(mapModel({ id: 'DEEPSEEK_V4_FLASH', owned_by: 'DeepSeek' })).toEqual(
      {
        id: 'DEEPSEEK_V4_FLASH',
        apiName: 'DEEPSEEK_V4_FLASH',
        label: 'DEEPSEEK_V4_FLASH (DeepSeek)',
      },
    )
    expect(mapModel({ id: 'seedream-5.0' })).toBeNull()
    expect(mapModel({ id: 'seedance-2.0' })).toBeNull()
    expect(mapModel({ id: 'happyhorse-1.0' })).toBeNull()
    expect(mapModel({})).toBeNull()
    expect(mapModel(null)).toBeNull()
  })
})
