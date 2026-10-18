import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { applyAnthropicAttributionPolicy } from '../../utils/anthropicAttribution.js'
import {
  providerModuleIsMocked,
  REAL_PROVIDER_TEST_CHILD_ENV,
  REAL_PROVIDER_TEST_TIMEOUT_MS,
  runTestFileWithRealProviders,
} from '../../test/providerModuleIsolation.js'

// Bun keeps mock.module() registrations process-global across test files.
// Bind request modules only when the canonical provider module is real. When a
// prior file replaced it, run this file in a clean child process instead.
const _realProvidersModule = await import(
  `../../utils/model/providers.js?attributionReal=${Date.now()}-${Math.random()}`
)
const _loadedProvidersModule = await import('src/utils/model/providers.js')
const runInProviderIsolatedChild =
  process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1' &&
  providerModuleIsMocked(_loadedProvidersModule, _realProvidersModule)
type AuthRoutingModule = typeof import('./authRouting.js')
let resolveAnthropicAttributionAuthFromSources!: AuthRoutingModule['resolveAnthropicAttributionAuthFromSources']
let resolveCurrentAnthropicAttributionPolicy!: AuthRoutingModule['resolveCurrentAnthropicAttributionPolicy']
if (!runInProviderIsolatedChild) {
  ;({
    resolveAnthropicAttributionAuthFromSources,
    resolveCurrentAnthropicAttributionPolicy,
  } = await import(
    `./authRouting.js?attributionReal=${Date.now()}-${Math.random()}`
  ))
}

const routeEnvKeys = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_VERTEX',
  'MINIMAX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
] as const
const originalEnv = { ...process.env }

beforeEach(async () => {
  await acquireSharedMutationLock('authRouting.attribution.test.ts')
  for (const key of routeEnvKeys) delete process.env[key]
  process.env.ANTHROPIC_API_KEY = 'sk-test-attribution-routing'
})

afterEach(() => {
  try {
    for (const key of routeEnvKeys) {
      if (originalEnv[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalEnv[key]
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

if (runInProviderIsolatedChild) {
  test('runs attribution route cases with the real provider module', async () => {
    await runTestFileWithRealProviders(import.meta.path)
  }, { timeout: REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000 })
}

const describeAttribution = runInProviderIsolatedChild
  ? describe.skip
  : describe

describeAttribution('current Anthropic attribution route resolution', () => {
  for (const apiKeySource of [
    'ANTHROPIC_API_KEY',
    'apiKeyHelper',
  ] as const) {
    test(`ignores ${apiKeySource} when managed OAuth is effective`, () => {
      expect(
        resolveAnthropicAttributionAuthFromSources({
          apiKeySource,
          authTokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
          bareMode: false,
          isSubscriber: true,
          managedOAuthContext: true,
        }),
      ).toBe('oauth_subscription')
    })
  }

  for (const [apiKeySource, authTokenSource] of [
    ['ANTHROPIC_API_KEY', 'none'],
    ['apiKeyHelper', 'apiKeyHelper'],
  ] as const) {
    test(`preserves bare-mode ${apiKeySource} in a managed context`, () => {
      expect(
        resolveAnthropicAttributionAuthFromSources({
          apiKeySource,
          authTokenSource,
          bareMode: true,
          isSubscriber: false,
          managedOAuthContext: true,
        }),
      ).toBe('api_key')
    })
  }

  test('preserves a managed API key when managed OAuth is not effective', () => {
    expect(
      resolveAnthropicAttributionAuthFromSources({
        apiKeySource: '/login managed key',
        authTokenSource: 'none',
        bareMode: false,
        isSubscriber: false,
        managedOAuthContext: true,
      }),
    ).toBe('api_key')
  })

  test('does not force managed OAuth past an explicit non-subscriber result', () => {
    expect(
      resolveAnthropicAttributionAuthFromSources({
        apiKeySource: 'none',
        authTokenSource: 'CLAUDE_CODE_OAUTH_TOKEN',
        bareMode: false,
        isSubscriber: false,
        managedOAuthContext: true,
      }),
    ).toBe('unknown')
  })

  for (const [label, envKey, envValue] of [
    ['remote', 'CLAUDE_CODE_REMOTE', '1'],
    ['Claude Desktop', 'CLAUDE_CODE_ENTRYPOINT', 'claude-desktop'],
  ] as const) {
    test(`uses the effective OAuth credential for ${label} sessions`, () => {
      process.env[envKey] = envValue
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-test-token'

      expect(
        resolveCurrentAnthropicAttributionPolicy({
          attributionEnabled: false,
        }),
      ).toEqual({
        generate: true,
        retain: true,
        reason: 'official_oauth_required',
      })
    })
  }

  for (const [label, envKey] of [
    ['Bedrock', 'CLAUDE_CODE_USE_BEDROCK'],
    ['Vertex', 'CLAUDE_CODE_USE_VERTEX'],
    ['Foundry', 'CLAUDE_CODE_USE_FOUNDRY'],
  ] as const) {
    test(`does not emit first-party metadata on ${label}`, () => {
      process.env[envKey] = '1'

      const policy = resolveCurrentAnthropicAttributionPolicy({
        attributionEnabled: true,
      })

      expect(policy).toEqual({
        generate: false,
        retain: false,
        reason: 'non_official_route',
      })
      expect(
        applyAnthropicAttributionPolicy(
          ['x-anthropic-billing-header: stale', 'stable route prompt'],
          policy,
        ),
      ).toEqual(['stable route prompt'])
    })
  }

  test('does not emit through a provider override', () => {
    const policy = resolveCurrentAnthropicAttributionPolicy({
      attributionEnabled: true,
      providerOverride: {
        model: 'third-party-model',
        baseURL: 'https://provider.example/v1',
        apiKey: 'provider-test-key',
      },
    })

    expect(policy).toMatchObject({ generate: false, retain: false })
    expect(
      applyAnthropicAttributionPolicy(
        ['x-anthropic-billing-header: stale', 'stable route prompt'],
        policy,
      ),
    ).toEqual(['stable route prompt'])
  })

  test('treats a custom Anthropic Messages route as non-official', () => {
    process.env.ANTHROPIC_BASE_URL = 'https://messages.example/v1'
    process.env.ANTHROPIC_MODEL = 'claude-compatible'

    expect(
      resolveCurrentAnthropicAttributionPolicy({
        attributionEnabled: true,
      }),
    ).toMatchObject({ generate: false, retain: false })
  })
})
