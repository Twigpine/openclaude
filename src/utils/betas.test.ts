import { afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  CLAUDE_CODE_20250219_BETA_HEADER,
} from '../constants/betas.js'
import { setSdkBetas } from '../bootstrap/state.js'

// Beta headers are Anthropic-specific. PR #1533 added a provider gate so that
// non-Anthropic providers (OpenAI, Gemini, etc.) never receive Anthropic-only
// beta headers — they would reject requests with unknown headers. These tests
// pin that gate: getMergedBetas() must return [] for non-Anthropic providers
// and a non-empty list for Anthropic providers (plus GitHub Native Anthropic).

// The list of provider/profile env vars these tests touch. We do NOT keep
// an "original" snapshot of process.env (the snapshot would itself be
// polluted by test files that run before this one in the smoke suite). Instead
// we scrub every key before and after each test, and each test sets only the
// vars it explicitly needs.
const PROVIDER_ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'NVIDIA_NIM',
  'MINIMAX_API_KEY',
  'XAI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'NEARAI_API_KEY',
  // FIREWORKS_API_KEY was added in PR #1590 / commit `2002e4c` as a
  // Fireworks-AI-only route trigger (see hasFireworksEnvOnlyProviderIntent
  // in src/integrations/routeMetadata.ts). If leaked from a prior test,
  // resolveActiveRouteIdFromEnv returns 'fireworks' which falls into
  // getAPIProvider's default branch and returns 'firstParty' — the
  // exact path that was tripping the openai/gemini/bedrock/etc tests in
  // the smoke run. The dedicated 'fireworks' provider has no branch in
  // the getAPIProvider switch, so a leaked key is interpreted as the
  // default anthropic provider.
  'FIREWORKS_API_KEY',
  'LONGCAT_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_BETAS',
  'OPENAI_BASE_URL',
  // OPENAI_API_BASE is the legacy alias for OPENAI_BASE_URL and is still
  // consulted by resolveActiveRouteIdFromEnv.
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'USER_TYPE',
  'CLAUDE_CODE_ENTRYPOINT',
  'DISABLE_INTERLEAVED_THINKING',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
] as const

function clearProviderEnv(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    delete process.env[key]
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/betas.test.ts')
  clearProviderEnv()
})

afterEach(() => {
  // Scrub provider env vars after each test so leaks from one test do not
  // contaminate the next test in this file or any other test file that shares
  // the same process.
  try {
    clearProviderEnv()
    setSdkBetas(undefined)
  } finally {
    releaseSharedMutationLock()
  }
})

// Several earlier test files in the smoke suite call
// mock.module('./model/providers.js', ...) to stub getAPIProvider. bun:test's
// mock.module() registry is process-global and mock.restore() does NOT clear it,
// so the cached bare-path import of providers.js inside betas.ts resolves to
// that stub unless we override it. We import the real providers module through
// a cache-busting URL and re-register it under the bare specifier at MODULE
// LEVEL (top-level await) so the override is in place before any test code runs.
// The explicit function references are used instead of spreading the namespace
// object to avoid potential issues with Bun's mock.module handling.
const _realProvidersModule = await import(
  `./model/providers.js?real=${Date.now()}-${Math.random()}`
)
mock.module('./model/providers.js', () => ({
  getAPIProvider: _realProvidersModule.getAPIProvider,
  usesAnthropicAccountFlow: _realProvidersModule.usesAnthropicAccountFlow,
  isGithubNativeAnthropicMode: _realProvidersModule.isGithubNativeAnthropicMode,
  getAPIProviderForStatsig: _realProvidersModule.getAPIProviderForStatsig,
  isFirstPartyAnthropicBaseUrl: _realProvidersModule.isFirstPartyAnthropicBaseUrl,
}))

// Fresh import per test resets the memoize caches inside betas.js so the
// provider detection (read live from process.env) is re-evaluated cleanly.
async function importFreshBetas() {
  return import(`./betas.js?ts=${Date.now()}-${Math.random()}`)
}

// Pre-warm the import in beforeAll so the first test does not pay the full
// module-load cost (growthbook feature-flag init takes ~4s on first import).
// The first importFreshBetas() in any test would otherwise burn the 5s default
// test timeout, and the cache-busting query string ensures every subsequent
// call is a real fresh import. After pre-warming, the per-test import is
// sub-second and well under the 5s budget.
beforeAll(async () => {
  await importFreshBetas()
})

const MODEL = 'claude-sonnet-4-5'

// --- getMergedBetas: non-Anthropic providers return [] ---

test('getMergedBetas returns [] for the openai provider', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL)).toEqual([])
})

test('getMergedBetas returns [] for the gemini provider', async () => {
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL)).toEqual([])
})

// --- getMergedBetas: Anthropic providers return a non-empty list ---

test('getMergedBetas returns a non-empty list for the firstParty provider', async () => {
  // No provider env set => firstParty.
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL).length).toBeGreaterThan(0)
})

test('modelSupportsStructuredOutputs covers the recent Opus models (4.8/4.7/4.6) on firstParty (#1769)', async () => {
  // No provider env set => firstParty. Pre-fix, 4.7/4.8 were absent from the
  // allowlist, so first-party requests on the new default Opus 4.8 lost the
  // structured-output support that 4.6 had.
  const { modelSupportsStructuredOutputs } = await importFreshBetas()
  expect(modelSupportsStructuredOutputs('claude-opus-4-8')).toBe(true)
  expect(modelSupportsStructuredOutputs('claude-opus-4-7')).toBe(true)
  expect(modelSupportsStructuredOutputs('claude-opus-4-6')).toBe(true)
  // A model outside the allowlist stays false.
  expect(modelSupportsStructuredOutputs('claude-3-opus')).toBe(false)
})

test('getMergedBetas returns a non-empty list for the bedrock provider', async () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL).length).toBeGreaterThan(0)
})

test('getMergedBetas returns a non-empty list for the vertex provider', async () => {
  process.env.CLAUDE_CODE_USE_VERTEX = '1'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL).length).toBeGreaterThan(0)
})

test('getMergedBetas returns a non-empty list for the foundry provider', async () => {
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL).length).toBeGreaterThan(0)
})

test('getMergedBetas returns a non-empty list in GitHub Native Anthropic mode', async () => {
  // GitHub resolves to the (non-Anthropic) "github" provider, but when the
  // model is a Claude model the request uses Anthropic native format, so the
  // beta headers must still flow through.
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.ANTHROPIC_BASE_URL = 'https://api.githubcopilot.com'
  process.env.ANTHROPIC_API_KEY = 'gh-token'
  process.env.OPENAI_MODEL = MODEL
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas(MODEL).length).toBeGreaterThan(0)
})

test('getMergedBetas returns [] for GitHub with a non-Claude model', async () => {
  // The risky half of the provider gate: CLAUDE_CODE_USE_GITHUB=1 with a
  // non-Claude model resolves to the "github" provider, but since the model
  // is not a Claude model, isGithubNativeAnthropicMode() returns false and
  // the gate must strip the Anthropic-only beta headers. A future broadening
  // of isGithubNativeAnthropicMode() (e.g. matching on the wrong substring)
  // would silently re-introduce these for OpenAI-style models.
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  process.env.ANTHROPIC_BASE_URL = 'https://api.githubcopilot.com'
  process.env.ANTHROPIC_API_KEY = 'gh-token'
  process.env.OPENAI_MODEL = 'gpt-4o-mini'
  const { getMergedBetas } = await importFreshBetas()
  expect(getMergedBetas('gpt-4o-mini')).toEqual([])
})

// --- isAnthropicProvider ---

test('isAnthropicProvider is true for firstParty', async () => {
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(true)
})

test('custom Anthropic proxy endpoints do not receive first-party beta headers', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://tenant.example'
  process.env.ANTHROPIC_MODEL = 'tenant-model'
  process.env.ANTHROPIC_AUTH_TOKEN = 'tenant-token'
  process.env.ANTHROPIC_BETAS = 'tenant-beta-2026-01-01'

  const {
    getMergedBetas,
    getModelBetas,
    isAnthropicProvider,
    modelSupportsAutoMode,
    modelSupportsContextManagement,
    modelSupportsISP,
    modelSupportsStructuredOutputs,
    shouldIncludeFirstPartyOnlyBetas,
    shouldUseGlobalCacheScope,
  } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
  expect(getMergedBetas('tenant-model')).toEqual([])
  expect(getModelBetas('claude-sonnet-4-6')).toEqual([])
  expect(modelSupportsISP('claude-sonnet-4-5')).toBe(true)
  expect(modelSupportsContextManagement('claude-sonnet-4-5')).toBe(true)
  expect(modelSupportsStructuredOutputs('claude-sonnet-4-5')).toBe(false)
  expect(modelSupportsAutoMode('claude-sonnet-4-5')).toBe(false)
  expect(shouldIncludeFirstPartyOnlyBetas()).toBe(false)
  expect(shouldUseGlobalCacheScope()).toBe(false)
})

test('switching from first-party Anthropic to a custom proxy clears beta headers', async () => {
  const { getModelBetas } = await importFreshBetas()
  expect(getModelBetas('claude-sonnet-4-6')).not.toEqual([])

  process.env.ANTHROPIC_BASE_URL = 'https://tenant.example'
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-6'
  process.env.ANTHROPIC_AUTH_TOKEN = 'tenant-token'
  process.env.ANTHROPIC_BETAS = 'tenant-beta-2026-01-01'

  expect(getModelBetas('claude-sonnet-4-6')).toEqual([])
})

test('first-party Anthropic retains the beta gates excluded for custom proxies', async () => {
  const {
    shouldIncludeFirstPartyOnlyBetas,
    shouldUseGlobalCacheScope,
  } = await importFreshBetas()
  expect(shouldIncludeFirstPartyOnlyBetas()).toBe(true)
  expect(shouldUseGlobalCacheScope()).toBe(true)
})

test('isAnthropicProvider is true for bedrock', async () => {
  process.env.CLAUDE_CODE_USE_BEDROCK = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(true)
})

test('isAnthropicProvider is true for vertex', async () => {
  process.env.CLAUDE_CODE_USE_VERTEX = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(true)
})

test('isAnthropicProvider is true for foundry', async () => {
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(true)
})

test('isAnthropicProvider is false for the openai provider', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
})

test('isAnthropicProvider is false for the gemini provider', async () => {
  process.env.CLAUDE_CODE_USE_GEMINI = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
})

test('isAnthropicProvider is false for the mistral provider', async () => {
  process.env.CLAUDE_CODE_USE_MISTRAL = '1'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
})

test('isAnthropicProvider is false for the xai provider', async () => {
  process.env.XAI_API_KEY = 'xai-test-key'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
})

test('isAnthropicProvider is false for the minimax provider', async () => {
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  const { isAnthropicProvider } = await importFreshBetas()
  expect(isAnthropicProvider()).toBe(false)
})

// --- Anthropic-only beta header handling (from origin/main) ---

test('adds trimmed user-provided beta headers without empty entries', async () => {
  process.env.ANTHROPIC_BETAS =
    ' custom-beta-2026-01-01, ,second-beta-2026-02-02 '

  const { getAllModelBetas } = await importFreshBetas()
  const betas = getAllModelBetas('claude-3-haiku-20240307')

  expect(betas.slice(-2)).toEqual([
    'custom-beta-2026-01-01',
    'second-beta-2026-02-02',
  ])
  expect(betas).not.toContain('')
})

test('does not duplicate an env-provided agentic beta for Haiku requests', async () => {
  process.env.ANTHROPIC_BETAS = [
    CLAUDE_CODE_20250219_BETA_HEADER,
    'custom-beta-2026-01-01',
  ].join(',')

  const { getMergedBetas } = await importFreshBetas()
  const mergedBetas = getMergedBetas('claude-3-haiku-20240307', {
    isAgenticQuery: true,
  })

  expect(
    mergedBetas.filter(beta => beta === CLAUDE_CODE_20250219_BETA_HEADER),
  ).toHaveLength(1)
  expect(mergedBetas).toContain('custom-beta-2026-01-01')
})
