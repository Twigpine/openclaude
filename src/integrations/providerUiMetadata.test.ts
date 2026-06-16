import { describe, expect, test } from 'bun:test'
import { getProviderPresetUiMetadata } from './providerUiMetadata.js'

// Pass an empty env so credential lookups stay deterministic regardless of the
// developer/CI machine's ambient provider variables.
const EMPTY_ENV = {} as NodeJS.ProcessEnv

describe('getProviderPresetUiMetadata — API-key prompt gating', () => {
  test('the ADC-only Gemini Vertex preset does not require an API key', () => {
    const metadata = getProviderPresetUiMetadata('gemini-vertex', EMPTY_ENV)

    expect(metadata.authMode).toBe('adc')
    // ADC profiles have no key to enter; pushing them through the generic
    // API-key step makes the /provider Vertex flow unusable.
    expect(metadata.requiresApiKey).toBe(false)
  })

  test('a genuine api-key preset still requires an API key', () => {
    const metadata = getProviderPresetUiMetadata('gemini', EMPTY_ENV)

    expect(metadata.authMode).toBe('api-key')
    expect(metadata.requiresApiKey).toBe(true)
  })
})
