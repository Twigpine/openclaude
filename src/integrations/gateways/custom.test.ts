import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { _clearRegistryForTesting, ensureIntegrationsLoaded, getCatalogForGateway } from '../index.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

describe('custom gateway', () => {
  beforeEach(() => {
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  })

  afterEach(() => {
    _clearRegistryForTesting()
    ensureIntegrationsLoaded()
  })

  describe.each([
    {
      routeId: 'custom',
      expected: {
        baseUrl: undefined,
        defaultModel: 'llama3.1:8b',
        setup: { requiresAuth: false, credentialEnvVars: undefined },
        preset: {
          fallbackBaseUrl: 'http://localhost:11434/v1',
          apiKeyEnvVars: ['OPENAI_API_KEYS', 'OPENAI_API_KEY'],
        },
        openaiShim: {
          supportsApiFormatSelection: true,
          supportsAuthHeaders: true,
        },
        catalogSource: 'hybrid',
        allowEmptyCatalog: true,
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
    })
  })

  test('discovers /v1/models and maps context_length to contextWindow', async () => {
    const catalog = getCatalogForGateway('custom')
    expect(catalog?.source).toBe('hybrid')
    expect(catalog?.discovery?.kind).toBe('openai-compatible')

    const mapModel = catalog?.discovery?.mapModel
    expect(mapModel).toBeDefined()

    const mapped = mapModel?.({
      id: 'litellm-gpt-4o',
      object: 'model',
      created: 123,
      owned_by: 'organization',
      context_length: 200_000,
    })

    expect(mapped).toEqual({
      id: 'litellm-gpt-4o',
      apiName: 'litellm-gpt-4o',
      label: 'litellm-gpt-4o',
      contextWindow: 200_000,
    })
  })

  test('falls back to context_window when context_length is absent', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    const mapped = mapModel?.({
      id: 'litellm-claude-opus',
      context_window: 200_000,
    })

    expect(mapped).toEqual({
      id: 'litellm-claude-opus',
      apiName: 'litellm-claude-opus',
      label: 'litellm-claude-opus',
      contextWindow: 200_000,
    })
  })

  test('falls back to max_model_len when other fields are absent', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    const mapped = mapModel?.({
      id: 'litellm-qwen-3',
      max_model_len: 131_072,
    })

    expect(mapped).toEqual({
      id: 'litellm-qwen-3',
      apiName: 'litellm-qwen-3',
      label: 'litellm-qwen-3',
      contextWindow: 131_072,
    })
  })

  test('falls back to top-level max_input_tokens when other fields are absent', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    const mapped = mapModel?.({
      id: 'litellm-gpt-5',
      max_input_tokens: 1_000_000,
    })

    expect(mapped).toEqual({
      id: 'litellm-gpt-5',
      apiName: 'litellm-gpt-5',
      label: 'litellm-gpt-5',
      contextWindow: 1_000_000,
    })
  })

  test('falls back to LiteLLM model_info context fields', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    expect(
      mapModel?.({
        id: 'litellm-claude-opus',
        model_info: {
          context_length: 1_000_000,
        },
      }),
    ).toEqual({
      id: 'litellm-claude-opus',
      apiName: 'litellm-claude-opus',
      label: 'litellm-claude-opus',
      contextWindow: 1_000_000,
    })

    expect(
      mapModel?.({
        id: 'litellm-qwen',
        model_info: {
          max_input_tokens: 131_072,
        },
      }),
    ).toEqual({
      id: 'litellm-qwen',
      apiName: 'litellm-qwen',
      label: 'litellm-qwen',
      contextWindow: 131_072,
    })
  })

  test('omits contextWindow when provider does not expose any size', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    const mapped = mapModel?.({
      id: 'litellm-unknown',
    })

    expect(mapped).toEqual({
      id: 'litellm-unknown',
      apiName: 'litellm-unknown',
      label: 'litellm-unknown',
    })
  })

  test('skips models without an id', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    expect(mapModel?.({})).toBeNull()
    expect(mapModel?.({ id: '   ' })).toBeNull()
    expect(mapModel?.(null)).toBeNull()
    expect(mapModel?.('bad entry')).toBeNull()
  })

  test('ignores non-positive or non-integer context values', async () => {
    const catalog = getCatalogForGateway('custom')
    const mapModel = catalog?.discovery?.mapModel

    expect(
      mapModel?.({
        id: 'negative',
        context_length: -1,
      }),
    ).toEqual({ id: 'negative', apiName: 'negative', label: 'negative' })

    expect(
      mapModel?.({
        id: 'zero',
        context_window: 0,
      }),
    ).toEqual({ id: 'zero', apiName: 'zero', label: 'zero' })

    expect(
      mapModel?.({
        id: 'float',
        max_model_len: 128_000.5,
      }),
    ).toEqual({ id: 'float', apiName: 'float', label: 'float' })

    expect(
      mapModel?.({
        id: 'infinite',
        context_length: Infinity,
      }),
    ).toEqual({ id: 'infinite', apiName: 'infinite', label: 'infinite' })

    expect(
      mapModel?.({
        id: 'nan',
        context_length: NaN,
      }),
    ).toEqual({ id: 'nan', apiName: 'nan', label: 'nan' })
  })
})
