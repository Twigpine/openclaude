import { describe, expect, test } from 'bun:test'

import { shouldCompressNativeToolHistory } from './claude.js'

// The routing decision queryModel applies before mutating request messages:
// every Anthropic-native transport compresses tool history ONLY while prompt
// caching is inactive, and never for shim-routed providerOverride requests.
// Parameterized here because the predicate guards a request-mutating branch
// across four transports and two exclusions.

const NATIVE_CASES = [
  { apiProvider: 'firstParty', isFirstPartyBaseUrl: true, isGithubNativeAnthropic: false },
  { apiProvider: 'bedrock', isFirstPartyBaseUrl: false, isGithubNativeAnthropic: false },
  { apiProvider: 'vertex', isFirstPartyBaseUrl: false, isGithubNativeAnthropic: false },
  // GitHub-native-Anthropic reports its own provider id; the mode flag is
  // what marks it native.
  { apiProvider: 'github', isFirstPartyBaseUrl: false, isGithubNativeAnthropic: true },
] as const

describe('shouldCompressNativeToolHistory', () => {
  for (const transport of NATIVE_CASES) {
    const name = transport.isGithubNativeAnthropic
      ? `${transport.apiProvider} (native-Anthropic mode)`
      : transport.apiProvider

    test(`${name}: compresses with caching off`, () => {
      expect(
        shouldCompressNativeToolHistory({
          ...transport,
          hasProviderOverride: false,
          promptCachingEnabled: false,
        }),
      ).toBe(true)
    })

    test(`${name}: cached sessions stay unmodified`, () => {
      expect(
        shouldCompressNativeToolHistory({
          ...transport,
          hasProviderOverride: false,
          promptCachingEnabled: true,
        }),
      ).toBe(false)
    })

    test(`${name}: providerOverride requests are shim-routed, never compressed here`, () => {
      expect(
        shouldCompressNativeToolHistory({
          ...transport,
          hasProviderOverride: true,
          promptCachingEnabled: false,
        }),
      ).toBe(false)
    })
  }

  test('non-native providers never compress at this layer, cached or not', () => {
    for (const apiProvider of ['openai', 'codex', 'gemini', 'minimax', 'xai']) {
      for (const promptCachingEnabled of [false, true]) {
        expect(
          shouldCompressNativeToolHistory({
            apiProvider,
            isFirstPartyBaseUrl: false,
            isGithubNativeAnthropic: false,
            hasProviderOverride: false,
            promptCachingEnabled,
          }),
        ).toBe(false)
      }
    }
  })

  test('firstParty on a custom ANTHROPIC_BASE_URL is NOT native — no compression', () => {
    // A custom first-party base URL (proxy / Anthropic-compatible endpoint)
    // reports firstParty AND caching-disabled; without the base-URL guard it
    // would be compressed against an endpoint we make no assumptions about.
    expect(
      shouldCompressNativeToolHistory({
        apiProvider: 'firstParty',
        isFirstPartyBaseUrl: false,
        isGithubNativeAnthropic: false,
        hasProviderOverride: false,
        promptCachingEnabled: false,
      }),
    ).toBe(false)
  })
})
