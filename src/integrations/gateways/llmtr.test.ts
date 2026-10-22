import { describe, expect, test } from 'bun:test'

import { getCatalogForGateway } from '../index.js'
import { routeForPreset } from '../compatibility.js'
import { getProviderPresetUiMetadata } from '../providerUiMetadata.js'
import {
  resolveActiveRouteIdFromEnv,
  resolveRouteCredentialValue,
  resolveRouteIdFromBaseUrl,
} from '../routeMetadata.js'
import catalog, { mapLlmtrModel } from './llmtr.models.js'
import gateway from './llmtr.js'
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

describe('llmtr gateway', () => {
  describe.each([
    {
      routeId: 'llmtr',
      expected: {
        baseUrl: 'https://llmtr.com/v1',
        defaultModel: 'deepseek/deepseek-v4-flash',
        setup: { credentialEnvVars: ['LLMTR_API_KEY', 'OPENAI_API_KEY'] },
        preset: { apiKeyEnvVars: ['LLMTR_API_KEY', 'OPENAI_API_KEY'] },
        validation: {
          kind: 'credential-env',
          routing: { matchDefaultBaseUrl: true, matchBaseUrlHosts: undefined },
          credentialEnvVars: [
            'LLMTR_API_KEY',
            'OPENAI_API_KEYS',
            'OPENAI_API_KEY',
          ],
        },
        openaiShim: {
          requiredApiFormat: 'chat_completions',
          supportsAuthHeaders: false,
          maxTokensField: 'max_tokens',
        },
        catalogSource: 'hybrid',
        discovery: { requiresAuth: false },
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
      expect(gateway.setup.dedicatedCredentialsOnly).not.toBe(true)
      expect(getCatalogForGateway(routeId)).toBe(catalog)
    })
  })
})

test('LLMTR preset uses the existing generic profile path', () => {
  expect(routeForPreset('llmtr')).toEqual({
    vendorId: 'openai',
    gatewayId: 'llmtr',
    routeId: 'llmtr',
  })
  expect(
    getProviderPresetUiMetadata('llmtr', {
      LLMTR_API_KEY: 'llmtr-key',
      OPENAI_API_KEY: 'fallback-key',
    }),
  ).toMatchObject({
    apiKey: 'llmtr-key',
    baseUrl: 'https://llmtr.com/v1',
    model: 'deepseek/deepseek-v4-flash',
    provider: 'llmtr',
    routeId: 'llmtr',
  })

  expect(
    getProviderPresetUiMetadata('llmtr', {
      OPENAI_API_KEY: 'fallback-key',
    }).apiKey,
  ).toBe('fallback-key')

  expect(
    getProviderPresetUiMetadata('llmtr', {
      LLMTR_API_KEY: 'SUA_CHAVE',
    }).apiKey,
  ).toBe('')
  expect(
    getProviderPresetUiMetadata('llmtr', {
      LLMTR_API_KEY: 'SUA_CHAVE',
      OPENAI_API_KEY: 'fallback-key',
    }).apiKey,
  ).toBe('fallback-key')
})

test('LLMTR dedicated credentials require an already selected LLMTR route', () => {
  const processEnv = { LLMTR_API_KEY: 'llmtr-key' }

  expect(resolveRouteIdFromBaseUrl('https://llmtr.com/v1')).toBe('llmtr')
  expect(resolveRouteIdFromBaseUrl('https://llmtr.com/proxy/v1')).toBeNull()
  expect(
    resolveRouteIdFromBaseUrl('https://llmtr.com/v1?tenant=proxy'),
  ).toBeNull()
  expect(resolveRouteIdFromBaseUrl('https://llmtr.com/v1#proxy')).toBeNull()
  expect(
    resolveRouteCredentialValue({
      routeId: 'llmtr',
      baseUrl: 'https://llmtr.com/v1',
      processEnv,
    }),
  ).toBe('llmtr-key')
  expect(
    resolveRouteCredentialValue({
      routeId: 'custom',
      baseUrl: 'https://proxy.example/v1',
      processEnv,
    }),
  ).toBeUndefined()
  expect(
    resolveRouteCredentialValue({
      routeId: 'llmtr',
      baseUrl: 'https://proxy.example/v1',
      processEnv,
    }),
  ).toBeUndefined()
  expect(
    resolveActiveRouteIdFromEnv(
      {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://proxy.example/v1',
      },
      {
        activeProfileProvider: 'llmtr',
        activeProfileBaseUrl: 'https://proxy.example/v1',
      },
    ),
  ).toBe('custom')
  expect(
    resolveActiveRouteIdFromEnv(processEnv),
  ).not.toBe('llmtr')
})

test('LLMTR discovery keeps tool-capable Chat Completions models', () => {
  expect(
    mapLlmtrModel({
      id: 'example/chat-model',
      name: 'Chat Model',
      context_length: 131_072,
      top_provider: {
        max_completion_tokens: 32_768,
      },
      architecture: {
        input_modalities: ['text', 'image'],
      },
      reasoning: {},
      supported_parameters: ['tools', 'reasoning'],
      supported_operations: ['CHAT_COMPLETIONS'],
      supported_endpoints: ['/v1/chat/completions'],
    }),
  ).toEqual({
    id: 'example/chat-model',
    apiName: 'example/chat-model',
    label: 'Chat Model',
    capabilities: {
      supportsFunctionCalling: true,
      supportsVision: true,
      supportsReasoning: true,
    },
    contextWindow: 131_072,
    maxOutputTokens: 32_768,
  })
})

test.each([
  ['Responses-only', ['RESPONSES'], ['/v1/responses'], ['tools']],
  ['no tools', ['CHAT_COMPLETIONS'], ['/v1/chat/completions'], []],
  ['wrong endpoint', ['CHAT_COMPLETIONS'], ['/v1/responses'], ['tools']],
])('LLMTR discovery rejects %s models', (_label, operations, endpoints, parameters) => {
  expect(
    mapLlmtrModel({
      id: 'example/incompatible',
      supported_operations: operations,
      supported_endpoints: endpoints,
      supported_parameters: parameters,
    }),
  ).toBeNull()
})
