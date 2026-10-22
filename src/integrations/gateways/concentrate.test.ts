import { describe, expect, test } from 'bun:test'

import concentrate from './concentrate.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

const mapModel = concentrate.catalog?.discovery?.mapModel

describe('concentrate gateway', () => {
  describe.each([
    {
      routeId: 'concentrate',
      expected: {
        baseUrl: 'https://api.concentrate.ai/v1',
        defaultModel: 'deepseek-v4-flash',
        category: 'aggregating',
        supportsModelRouting: true,
        setup: {
          requiresAuth: true,
          authMode: 'api-key',
          credentialEnvVars: ['CONCENTRATE_API_KEY'],
          dedicatedCredentialsOnly: undefined,
        },
        validation: {
          kind: 'credential-env',
          credentialEnvVars: [
            'CONCENTRATE_API_KEY',
            'OPENAI_API_KEYS',
            'OPENAI_API_KEY',
          ],
        },
        catalogSource: 'dynamic',
        discovery: { requiresAuth: false },
        allowEmptyCatalog: true,
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
    })
  })

  test('mapModel keeps chat models and drops non-chat ids', () => {
    if (!mapModel) throw new Error('mapModel missing')

    expect(
      mapModel({
        id: 'deepseek-v4-flash',
        display_name: 'DeepSeek V4 Flash',
        owned_by: 'deepseek',
        max_input_tokens: 1_048_576,
        max_tokens: 393_216,
      }),
    ).toEqual({
      id: 'deepseek-v4-flash',
      apiName: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      contextWindow: 1_048_576,
      maxOutputTokens: 393_216,
    })

    expect(
      mapModel({
        id: 'claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
        owned_by: 'anthropic',
        max_input_tokens: 200_000,
        max_tokens: 64_000,
      }),
    ).toEqual({
      id: 'claude-sonnet-5',
      apiName: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
    })

    expect(mapModel({ id: 'redact-v1' })).toBeNull()
    expect(mapModel({ id: 'gpt-oss-safeguard-120b' })).toBeNull()
    expect(mapModel({ id: 'text-embedding-3-small' })).toBeNull()
    expect(mapModel({ id: 'whisper-1' })).toBeNull()
    expect(mapModel({})).toBeNull()
    expect(mapModel(null)).toBeNull()
  })
})
