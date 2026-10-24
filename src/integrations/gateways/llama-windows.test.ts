import { expect, test } from 'bun:test'

import { routeForPreset } from '../compatibility.js'
import { getProviderPresetUiMetadata } from '../providerUiMetadata.js'
import gateway from './llama-windows.js'

test('Llama for Windows uses its local OpenAI-compatible endpoint and discovers models', () => {
  expect(gateway.defaultBaseUrl).toBe('http://127.0.0.1:9931/v1')
  expect(gateway.setup).toMatchObject({
    requiresAuth: false,
    authMode: 'none',
  })
  expect(gateway.startup?.probeReadiness).toBe('openai-compatible-models')
  expect(gateway.transportConfig).toMatchObject({
    kind: 'local',
    openaiShim: {
      supportsApiFormatSelection: false,
      supportsAuthHeaders: false,
      maxTokensField: 'max_tokens',
    },
  })
  expect(gateway.catalog).toMatchObject({
    source: 'dynamic',
    discovery: { kind: 'openai-compatible' },
    allowManualRefresh: true,
  })
})

test('Llama for Windows preset resolves without an API key and keeps the /v1 URL', () => {
  expect(routeForPreset('llama-windows')).toEqual({
    vendorId: 'openai',
    gatewayId: 'llama-windows',
    routeId: 'llama-windows',
  })
  expect(getProviderPresetUiMetadata('llama-windows', {})).toMatchObject({
    apiKey: '',
    baseUrl: 'http://127.0.0.1:9931/v1',
    model: 'local-model',
    provider: 'llama-windows',
    requiresApiKey: false,
    routeId: 'llama-windows',
  })
})

test('Llama for Windows preset accepts a custom local server base URL', () => {
  expect(
    getProviderPresetUiMetadata('llama-windows', {
      LLAMA_WINDOWS_BASE_URL: 'http://192.168.1.20:8080/v1',
    }).baseUrl,
  ).toBe('http://192.168.1.20:8080/v1')
})
