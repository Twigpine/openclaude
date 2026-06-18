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

describe('getProviderPresetUiMetadata — Gemini Vertex credential metadata', () => {
  test('credentialEnvVars are real credentials, not routing/config vars', () => {
    const metadata = getProviderPresetUiMetadata('gemini-vertex', EMPTY_ENV)

    expect(metadata.credentialEnvVars).toEqual([
      'GEMINI_ACCESS_TOKEN',
      'GOOGLE_APPLICATION_CREDENTIALS',
    ])
  })

  test('does not prefill apiKey with the enablement flag or project id', () => {
    // Generic consumers treat credentialEnvVars as "the credential", so the
    // routing flag / project id must never be surfaced as an api key.
    const metadata = getProviderPresetUiMetadata('gemini-vertex', {
      CLAUDE_CODE_USE_GEMINI_VERTEX: '1',
      GEMINI_VERTEX_PROJECT: 'my-gcp-project',
    } as NodeJS.ProcessEnv)

    expect(metadata.apiKey).toBe('')
  })

  test('access-token credential is still discoverable', () => {
    const metadata = getProviderPresetUiMetadata('gemini-vertex', {
      GEMINI_ACCESS_TOKEN: 'ya29.test-bearer',
    } as NodeJS.ProcessEnv)

    expect(metadata.apiKey).toBe('ya29.test-bearer')
  })
})

describe('getProviderPresetUiMetadata — Gemini Vertex preset routes through the full form', () => {
  test('baseUrl is a placeholder so the preset collects a project id', () => {
    const metadata = getProviderPresetUiMetadata('gemini-vertex', EMPTY_ENV)

    // A placeholder (not the endpoint URL) forces canUseStreamlinedPresetFlow()
    // to fall back to the full setup form, which collects the project id rather
    // than silently saving the endpoint URL as the project.
    expect(metadata.baseUrl).toMatch(/<[^>]+>/)
    expect(metadata.baseUrl).not.toMatch(/^https?:\/\//)
  })
})
