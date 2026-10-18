import { expect, test } from 'bun:test'

import { routeForPreset } from '../compatibility.js'
import { getProviderPresetUiMetadata } from '../providerUiMetadata.js'
import {
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
} from '../routeMetadata.js'
import gateway, { mapApiRouteModel } from './api-route.js'

test('API Route uses a dedicated hybrid OpenAI-compatible gateway contract', () => {
  expect(gateway.defaultBaseUrl).toBe('https://global.api-route.com/v1')
  expect(gateway.defaultModel).toBe('claude-sonnet-4-6')
  expect(gateway.setup.credentialEnvVars).toEqual(['API_ROUTE_API_KEY'])
  expect(gateway.setup.dedicatedCredentialsOnly).toBe(false)
  expect(gateway.preset?.apiKeyEnvVars).toEqual(['API_ROUTE_API_KEY'])
  expect(gateway.validation).toMatchObject({
    kind: 'credential-env',
    routing: { matchDefaultBaseUrl: true },
    credentialEnvVars: ['API_ROUTE_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_API_KEY'],
  })
  expect(gateway.transportConfig).toEqual({
    kind: 'openai-compatible',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  })
  expect(gateway.catalog?.source).toBe('hybrid')
  expect(gateway.catalog?.discovery?.requiresAuth).toBe(true)
  expect(gateway.catalog?.models?.map(model => model.apiName)).toEqual([
    'claude-sonnet-4-6',
  ])
})

test('API Route preset uses the existing generic profile path', () => {
  expect(routeForPreset('api-route')).toEqual({
    vendorId: 'openai',
    gatewayId: 'api-route',
    routeId: 'api-route',
  })
  expect(
    getProviderPresetUiMetadata('api-route', {
      API_ROUTE_API_KEY: 'test-api-route-key',
    }),
  ).toMatchObject({
    apiKey: 'test-api-route-key',
    baseUrl: 'https://global.api-route.com/v1',
    model: 'claude-sonnet-4-6',
    provider: 'api-route',
    routeId: 'api-route',
  })
  expect(
    getProviderPresetUiMetadata('api-route', {
      API_ROUTE_API_KEY: 'test-api-route-key',
      API_ROUTE_MODEL: 'custom-api-route-model',
      OPENAI_MODEL: 'custom-openai-model',
    }),
  ).toMatchObject({
    model: 'custom-api-route-model',
  })
  expect(
    getProviderPresetUiMetadata('api-route', {
      API_ROUTE_API_KEY: 'test-api-route-key',
      OPENAI_MODEL: 'custom-openai-model',
    }),
  ).toMatchObject({
    model: 'custom-openai-model',
  })
})

test('API Route profile credentials use the generic fallback only on the canonical inference URL', () => {
  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'https://global.api-route.com/v1',
      processEnv: { OPENAI_API_KEY: 'saved-profile-key' },
    }),
  ).toBe('saved-profile-key')

  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'https://proxy.example.com/v1',
      processEnv: { OPENAI_API_KEY: 'saved-profile-key' },
    }),
  ).toBeUndefined()

  const env = { API_ROUTE_API_KEY: 'secret-key' }

  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'https://global.api-route.com/v1',
      processEnv: env,
    }),
  ).toBe('secret-key')

  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'http://global.api-route.com/v1',
      processEnv: env,
    }),
  ).toBeUndefined()

  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'https://global.api-route.com/v1?tenant=proxy',
      processEnv: env,
    }),
  ).toBeUndefined()

  expect(
    resolveRouteCredentialValue({
      routeId: 'api-route',
      baseUrl: 'https://proxy.example.com/v1',
      processEnv: env,
    }),
  ).toBeUndefined()
})

test('API Route discovery maps chat models and drops non-chat IDs', () => {
  expect(
    mapApiRouteModel({
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      context_length: 200000,
    }),
  ).toEqual({
    id: 'claude-sonnet-4-6',
    apiName: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    contextWindow: 200000,
  })

  expect(
    mapApiRouteModel({
      id: 'gpt-4o-mini',
      owned_by: 'openai',
    }),
  ).toEqual({
    id: 'gpt-4o-mini',
    apiName: 'gpt-4o-mini',
    label: 'gpt-4o-mini (openai)',
  })

  expect(mapApiRouteModel({ id: 'text-embedding-3-small' })).toBeNull()
  expect(mapApiRouteModel({ id: 'whisper-1' })).toBeNull()
  expect(mapApiRouteModel({ id: 'dall-e-3' })).toBeNull()
  expect(mapApiRouteModel({ id: 'gpt-image-1' })).toBeNull()
  expect(mapApiRouteModel({ id: 'sora-turbo' })).toBeNull()
  expect(mapApiRouteModel({ id: 'veo-2' })).toBeNull()
  expect(mapApiRouteModel(null)).toBeNull()
  expect(mapApiRouteModel({})).toBeNull()
})

test('API Route route resolution detects endpoints and environment intent', () => {
  expect(resolveRouteIdFromBaseUrl('https://global.api-route.com/v1')).toBe(
    'api-route',
  )
  expect(
    resolveRouteIdFromBaseUrl('https://global.api-route.com/v1/chat/completions'),
  ).toBe('api-route')

  expect(
    resolveActiveRouteIdFromEnv({
      API_ROUTE_API_KEY: 'test-key',
    }),
  ).toBe('api-route')
})
