import { describe, expect, test } from 'bun:test'

import { getCatalogEntriesForRoute } from '../index.js'
import {
  getRouteDefaultBaseUrl,
  getRouteDefaultModel,
  resolveRouteIdFromBaseUrl,
} from '../routeMetadata.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

describe('xiaomi-mimo-token gateway', () => {
  describe.each([
    {
      routeId: 'xiaomi-mimo-token',
      expected: {
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
        defaultModel: 'mimo-v2.5-pro',
        setup: { credentialEnvVars: ['MIMO_API_KEY'] },
        preset: { apiKeyEnvVars: ['MIMO_API_KEY'] },
        validation: {
          kind: 'credential-env',
          credentialEnvVars: ['MIMO_API_KEY', 'OPENAI_API_KEY'],
        },
        catalogSource: 'static',
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
      expect(getRouteDefaultBaseUrl(routeId)).toBe(expected.baseUrl)
      expect(getRouteDefaultModel(routeId)).toBe(expected.defaultModel)
    })
  })

  test('catalog models use OpenAI-compatible reasoning effort', () => {
    const entries = getCatalogEntriesForRoute('xiaomi-mimo-token')
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.reasoning).toEqual({
        mode: 'levels',
        levels: ['low', 'medium', 'high'],
        defaultLevel: 'medium',
        wireFormat: 'reasoning_effort',
      })
    }
  })

  test('resolves token-plan SGP base URL', () => {
    expect(
      resolveRouteIdFromBaseUrl('https://token-plan-sgp.xiaomimimo.com/v1'),
    ).toBe('xiaomi-mimo-token')
  })

  test('resolves token-plan CN base URL', () => {
    expect(
      resolveRouteIdFromBaseUrl('https://token-plan-cn.xiaomimimo.com/v1'),
    ).toBe('xiaomi-mimo-token')
  })

  test('resolves token-plan chat completions path', () => {
    expect(
      resolveRouteIdFromBaseUrl(
        'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
      ),
    ).toBe('xiaomi-mimo-token')
  })
})
