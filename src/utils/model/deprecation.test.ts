import { afterEach, describe, expect, mock, test } from 'bun:test'
import * as providersModule from './providers.js'
import type { LegacyAPIProvider } from './providers.js'
import { getModelDeprecationWarning } from './deprecation.js'

// getModelDeprecationWarning resolves the active provider through
// getAPIProvider(), which reads global env/route state that other tests in the
// full suite mutate (leaked CLAUDE_CODE_USE_* flags, mock.module on providers).
// Mock the provider directly so these assertions stay hermetic and
// order-independent instead of racing on process.env.
function mockApiProvider(provider: LegacyAPIProvider): void {
  mock.module('./providers.js', () => ({
    ...providersModule,
    getAPIProvider: () => provider,
  }))
}

function restoreApiProvider(): void {
  mock.module('./providers.js', () => ({ ...providersModule }))
}

// claude-3-opus is deprecated under first-party / Anthropic-wire providers.
const DEPRECATED_FIRST_PARTY_MODEL = 'claude-3-opus-20240229'

describe('getModelDeprecationWarning — Gemini Vertex bypass', () => {
  afterEach(restoreApiProvider)

  test('first-party provider still surfaces the deprecation warning', () => {
    mockApiProvider('firstParty')
    // Sanity anchor: the bypass below is only meaningful if this model is
    // otherwise reported as deprecated.
    expect(getModelDeprecationWarning(DEPRECATED_FIRST_PARTY_MODEL)).toContain(
      'Claude 3 Opus',
    )
  })

  test('Gemini Vertex provider bypasses model deprecation warnings', () => {
    mockApiProvider('gemini-vertex')
    // Gemini Vertex serves its own model catalog, so Anthropic retirement dates
    // must never leak into its deprecation banner.
    expect(getModelDeprecationWarning(DEPRECATED_FIRST_PARTY_MODEL)).toBeNull()
  })
})
