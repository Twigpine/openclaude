import { describe, expect, test } from 'bun:test'
import opengateway, { mapOpenGatewayModel } from './gitlawb-opengateway.js'
import {
  getCatalogEntriesForRoute,
  getRouteDefaultBaseUrl,
  resolveRouteIdFromBaseUrl,
} from '../index.js'
import { resolveOpenAIShimRuntimeContext } from '../runtimeMetadata.js'
import { isVisionSupported } from '../../utils/visionUtils.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

describe('gitlawb-opengateway live model mapping', () => {
  describe.each([
    {
      routeId: 'gitlawb-opengateway',
      expected: {
        baseUrl: 'https://api.twigpine.com/v1',
        defaultModel: 'mimo-v2.6-pro',
        preset: {
          label: 'Twigpine OpenGateway',
          name: 'Twigpine OpenGateway',
          description:
            'Twigpine OpenGateway - (API key required, signup at https://twigpine.com/console/gateway/keys)',
          fallbackBaseUrl: 'https://api.twigpine.com/v1',
          fallbackModel: 'mimo-v2.6-pro',
          badge: { text: 'Recommended', color: 'success' },
        },
        validation: {
          routing: {
            matchBaseUrlHosts: [
              'api.twigpine.com',
              'opengateway.gitlawb.com',
              'opengateway.fly.dev',
            ],
          },
        },
        setup: {
          credentialEnvVars: [
            'OPENGATEWAY_API_KEY',
            'OPENAI_API_KEYS',
            'OPENAI_API_KEY',
          ],
        },
        catalogSource: 'hybrid',
        discovery: { requiresAuth: false, mapModel: mapOpenGatewayModel },
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
      expect(opengateway.startup?.probeReadiness).toBeUndefined()
    })
  })

  test('uses the Twigpine name, address and key URL', () => {
    expect(opengateway.label).toBe('Twigpine OpenGateway')
    expect(getRouteDefaultBaseUrl('gitlawb-opengateway')).toBe(
      'https://api.twigpine.com/v1',
    )
    const validation = opengateway.validation
    expect(validation?.kind).toBe('credential-env')
    if (validation?.kind !== 'credential-env') return
    expect(validation.missingCredentialMessage).toContain('Twigpine OpenGateway')
    expect(validation.missingCredentialMessage).toContain(
      'https://twigpine.com/console/gateway/keys',
    )
    expect(validation.missingCredentialMessage).not.toContain('gitlawb.com')
  })

  test('routes the new and legacy gateway hosts to the same provider', () => {
    for (const baseUrl of [
      'https://api.twigpine.com/v1',
      'https://opengateway.gitlawb.com/v1',
      'https://opengateway.fly.dev/v1',
    ]) {
      expect(resolveRouteIdFromBaseUrl(baseUrl)).toBe('gitlawb-opengateway')
    }
  })

  test('keeps only a minimal offline floor; the live list supplies the rest', () => {
    expect(
      getCatalogEntriesForRoute('gitlawb-opengateway').map(entry => entry.apiName),
    ).toEqual(['auto', 'mimo-v2.6-pro', 'mimo-v2.6-flash'])
    expect(opengateway.catalog?.source).toBe('hybrid')
    expect(opengateway.catalog?.discoveryRefreshMode).toBe('startup')
    expect(opengateway.catalog?.discoveryCacheTtl).toBe('1h')
  })

  test('maps gateway routes including auto and free models', () => {
    expect(
      mapOpenGatewayModel({
        id: 'auto',
        name: 'Auto (smart routing)',
        description: 'picks the cheapest capable model',
      }),
    ).toEqual({
      id: 'auto',
      apiName: 'auto',
      label: 'Auto (smart routing)',
    })

    expect(
      mapOpenGatewayModel({
        id: 'xiaomi/mimo-v2.5-pro',
        name: 'MiMo V2.5-Pro',
        context_window: 262144,
      }),
    ).toEqual({
      id: 'mimo-v2.5-pro',
      apiName: 'mimo-v2.5-pro',
      label: 'MiMo V2.5-Pro',
      contextWindow: 262144,
    })

    expect(
      mapOpenGatewayModel({
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        name: 'Nemotron 3 Ultra free',
        context_window: 128000,
      }),
    ).toEqual({
      id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      apiName: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      label: 'Nemotron 3 Ultra free',
      contextWindow: 128000,
      notes: 'Free',
    })
  })

  test('dedupes the live xiaomi/ MiMo ids onto the offline floor entries', () => {
    expect(
      mapOpenGatewayModel({
        id: 'xiaomi/mimo-v2.6-pro',
        name: 'MiMo V2.6-Pro',
        context_window: 262144,
        status: 'active',
      }),
    ).toEqual({
      id: 'mimo-v2.6-pro',
      apiName: 'mimo-v2.6-pro',
      label: 'MiMo V2.6-Pro',
      contextWindow: 262144,
    })
    expect(mapOpenGatewayModel({ id: 'xiaomi/mimo-v2.6-flash' })?.apiName).toBe(
      'mimo-v2.6-flash',
    )
  })

  test('skips retired models listed by ?status=all', () => {
    expect(
      mapOpenGatewayModel({
        id: 'xiaomi/mimo-v2.5-pro',
        name: 'MiMo V2.5-Pro',
        status: 'retired',
        successor: 'xiaomi/mimo-v2.6-pro',
      }),
    ).toBeNull()
    expect(mapOpenGatewayModel({ id: 'a/b', status: ' Retired ' })).toBeNull()
    expect(mapOpenGatewayModel({ id: 'a/b', status: 'active' })?.apiName).toBe(
      'a/b',
    )
  })

  test('live GLM ids get the Z.AI GLM request shape on the gateway route', () => {
    // No curated GLM entry: the runtime infers the Z.AI GLM shim from the id,
    // and the gateway's own wire contract (max_completion_tokens, no
    // store/stream_options) still wins over the shim's defaults.
    const result = resolveOpenAIShimRuntimeContext({
      baseUrl: 'https://api.twigpine.com/v1',
      model: 'z-ai/glm-5.2',
      processEnv: { CLAUDE_CODE_USE_OPENAI: '1' },
    })
    expect(result.routeId).toBe('gitlawb-opengateway')
    expect(result.catalogEntry).toBeNull()
    expect(result.openaiShimConfig).toMatchObject({
      preserveReasoningContent: true,
      requireReasoningContentOnAssistantMessages: true,
      reasoningContentFallback: '',
      thinkingRequestFormat: 'zai-compatible',
      maxTokensField: 'max_completion_tokens',
      removeBodyFields: ['store', 'stream_options'],
    })
    // The live id still resolves to the shared text-only GLM 5.2 descriptor.
    expect(
      isVisionSupported('z-ai/glm-5.2', { routeId: 'gitlawb-opengateway' }),
    ).toBe(false)
  })

  test('drops known non-coding ids', () => {
    expect(
      mapOpenGatewayModel({
        id: 'whisper-1',
        name: 'Whisper',
      }),
    ).toBeNull()
    expect(mapOpenGatewayModel({})).toBeNull()
    expect(mapOpenGatewayModel({ id: '   ' })).toBeNull()
    expect(mapOpenGatewayModel(null)).toBeNull()
  })

  test('falls back to display_name and title for labels', () => {
    expect(mapOpenGatewayModel({ id: 'a/b', display_name: 'B' })?.label).toBe(
      'B',
    )
    expect(mapOpenGatewayModel({ id: 'c/d', title: 'D' })?.label).toBe('D')
  })
})
