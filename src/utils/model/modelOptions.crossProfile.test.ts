import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'

// Mock surface: keep the original providerProfiles export shape and only
// override `getProviderProfiles` / `getActiveProviderProfile` /
// `getProfileModelOptions` per test. Anything else (setActiveProviderProfile,
// etc.) stays as the real implementation so we don't break unrelated callers
// loaded in the same `bun test` invocation. See `src/utils/user.test.ts` for
// the canonical pattern; this is the same lesson as the 2026-04-30 mock-leak
// note in lessons_learned.md.
import type { ModelOption } from './modelOptions.js'
import type { ProviderProfile } from '../config.js'
import type { SettingsJson } from '../settings/types.js'

const providerSpecifier = './providers.js'
const realNonce = `${Date.now()}-${Math.random()}`
const realProvidersForCleanup = {
  ...await import(
    `${providerSpecifier}?real=${realNonce}`
  ),
}

// Snapshot the real modules with cache-busted imports before any mock.module
// runs. bun live-repoints bare-import namespaces to the active mock, so these
// plain-object copies bypass earlier mocks and keep the genuine implementations.
const realProviderProfiles = { ...await import(`../providerProfiles.js?real=${realNonce}`) }
const realProviders = realProvidersForCleanup
const realAuth = { ...await import(`../auth.js?real=${realNonce}`) }
const realProviderConfig = { ...await import(`../../services/api/providerConfig.js?real=${realNonce}`) }
const realSettings = { ...await import(`../settings/settings.js?real=${realNonce}`) }
const realModelAllowlist = { ...await import(`./modelAllowlist.js?real=${realNonce}`) }
const realOllamaModels = { ...await import(`./ollamaModels.js?real=${realNonce}`) }
const realNvidiaModels = { ...await import(`./nvidiaNimModels.js?real=${realNonce}`) }
const realMiniMaxModels = { ...await import(`./minimaxModels.js?real=${realNonce}`) }
const realXiaomiModels = { ...await import(`./xiaomi-mimoModels.js?real=${realNonce}`) }

afterAll(() => {
  mock.restore()
  mock.module(providerSpecifier, () => realProvidersForCleanup)
  mock.module('../providerProfiles.js', () => realProviderProfiles)
  mock.module('../auth.js', () => realAuth)
  mock.module('../../services/api/providerConfig.js', () => realProviderConfig)
  mock.module('../settings/settings.js', () => realSettings)
  mock.module('./modelAllowlist.js', () => realModelAllowlist)
  mock.module('./ollamaModels.js', () => realOllamaModels)
  mock.module('./nvidiaNimModels.js', () => realNvidiaModels)
  mock.module('./minimaxModels.js', () => realMiniMaxModels)
  mock.module('./xiaomi-mimoModels.js', () => realXiaomiModels)
})

// bun's mock.module is process-wide and mock.restore() does NOT undo it, so
// per-test mocks installed in a harness would persist and leak into later
// suites (e.g. providerConfig's cache-scope tests reading a pinned
// getAPIProvider). Instead install each mock ONCE here, gated on this flag, and
// delegate to the real implementation whenever a cross-profile test is not
// actively running. afterEach clears the flag, so the persisted mock becomes a
// transparent passthrough for every other file. Same pattern as the
// cross-spawn/file-suggestions leak fix (#1667).
let activeProfilesOverride: Partial<typeof import('../providerProfiles.js')> | null = null
// Overrides getAdditionalModelOptionsCacheScope (used by getModelOptions to pick
// the openai-scope branch) only while a test sets it. Keeps the full
// providerConfig surface so the persisted mock doesn't strip resolveProviderRequest
// etc. from later suites (e.g. providerConfig.local).
let activeCacheScopeOverride: string | null = null
// Overrides getSettings_DEPRECATED (read by BOTH the filterModelOptionsByAllowlist
// gate in modelOptions.ts AND isModelAllowed in modelAllowlist.js) only while an
// allowlist test sets it. Many sibling suites (ModelPicker/ProviderManager/...)
// mock.module('../settings/settings.js') process-wide, which defeats
// setSessionSettingsCache, so drive the allowlist deterministically here rather
// than through the shared settings cache. Gated + passthrough so it doesn't leak.
let activeSettingsOverride: SettingsJson | null = null
// Drives the Ollama early-return branch in getModelOptionsBase. When set, the
// gated mock reports an Ollama provider with this fixed cached-model list so a
// cross-profile test can assert the branch still appends inactive-profile
// options (#1164). Gated + passthrough so it can't leak into other suites.
let activeOllamaOverride: { cachedModels: ModelOption[] } | null = null
// Pins getAPIProvider to a specific value (e.g. 'github') so the corresponding
// early-return branch in getModelOptionsBase runs. Gated + passthrough.
let activeApiProviderOverride: string | null = null
// Drives the NVIDIA NIM catalog early-return branch. Gated + passthrough.
let activeNvidiaOverride: { cachedModels: ModelOption[] } | null = null
// Flips the Claude subscriber branch on (and optionally Max tier). Gated so it
// doesn't leak subscriber state into sibling suites.
let activeSubscriberOverride: { max?: boolean } | null = null
// Drive the MiniMax / Xiaomi MiMo catalog early-return branches. Gated + passthrough.
let activeMiniMaxOverride: { cachedModels: ModelOption[] } | null = null
let activeXiaomiOverride: { cachedModels: ModelOption[] } | null = null

mock.module('./ollamaModels.js', () => ({
  ...realOllamaModels,
  isOllamaProvider: () =>
    activeOllamaOverride ? true : realOllamaModels.isOllamaProvider(),
  getCachedOllamaModelOptions: () =>
    activeOllamaOverride
      ? activeOllamaOverride.cachedModels
      : realOllamaModels.getCachedOllamaModelOptions(),
}))

mock.module('./nvidiaNimModels.js', () => ({
  ...realNvidiaModels,
  isNvidiaNimProvider: () =>
    activeNvidiaOverride ? true : realNvidiaModels.isNvidiaNimProvider(),
  getCachedNvidiaNimModelOptions: () =>
    activeNvidiaOverride
      ? activeNvidiaOverride.cachedModels
      : realNvidiaModels.getCachedNvidiaNimModelOptions(),
}))

mock.module('./minimaxModels.js', () => ({
  ...realMiniMaxModels,
  isMiniMaxProvider: () =>
    activeMiniMaxOverride ? true : realMiniMaxModels.isMiniMaxProvider(),
  getCachedMiniMaxModelOptions: () =>
    activeMiniMaxOverride
      ? activeMiniMaxOverride.cachedModels
      : realMiniMaxModels.getCachedMiniMaxModelOptions(),
}))

mock.module('./xiaomi-mimoModels.js', () => ({
  ...realXiaomiModels,
  isXiaomiMimoProvider: () =>
    activeXiaomiOverride ? true : realXiaomiModels.isXiaomiMimoProvider(),
  getCachedXiaomiMimoModelOptions: () =>
    activeXiaomiOverride
      ? activeXiaomiOverride.cachedModels
      : realXiaomiModels.getCachedXiaomiMimoModelOptions(),
}))

mock.module('../settings/settings.js', () => ({
  ...realSettings,
  getSettings_DEPRECATED: () =>
    activeSettingsOverride ?? realSettings.getSettings_DEPRECATED(),
}))

// Sibling suites (ModelPicker/...) also mock modelAllowlist's isModelAllowed
// process-wide, so override it here too (gated + passthrough) and drive it from
// the same activeSettingsOverride allowlist, matching the gate above. Mirrors
// the agent.test.ts allowlist pattern.
mock.module('./modelAllowlist.js', () => ({
  ...realModelAllowlist,
  isModelAllowed: (model: string) => {
    const allowlist = activeSettingsOverride?.availableModels
    return allowlist ? allowlist.includes(model) : realModelAllowlist.isModelAllowed(model)
  },
}))

mock.module('../../services/api/providerConfig.js', () => ({
  ...realProviderConfig,
  getAdditionalModelOptionsCacheScope: () =>
    activeCacheScopeOverride ??
    realProviderConfig.getAdditionalModelOptionsCacheScope(),
}))

mock.module('../providerProfiles.js', () => ({
  ...realProviderProfiles,
  getProviderProfiles: (...args: Parameters<typeof realProviderProfiles.getProviderProfiles>) =>
    (activeProfilesOverride?.getProviderProfiles ??
      realProviderProfiles.getProviderProfiles)(...args),
  getActiveProviderProfile: (...args: Parameters<typeof realProviderProfiles.getActiveProviderProfile>) =>
    (activeProfilesOverride?.getActiveProviderProfile ??
      realProviderProfiles.getActiveProviderProfile)(...args),
  getProfileModelOptions: (...args: Parameters<typeof realProviderProfiles.getProfileModelOptions>) =>
    (activeProfilesOverride?.getProfileModelOptions ??
      realProviderProfiles.getProfileModelOptions)(...args),
}))

// The 3P path reads getAPIProvider + subscriber checks; pin them to a stable
// 3P-openai non-subscriber shape only while a cross-profile test is active.
mock.module('./providers.js', () => ({
  ...realProviders,
  getAPIProvider: () =>
    activeApiProviderOverride ??
    (activeProfilesOverride ? 'openai' : realProviders.getAPIProvider()),
  getAPIProviderForStatsig: () =>
    activeProfilesOverride
      ? 'openai'
      : realProviders.getAPIProviderForStatsig(),
  isFirstPartyAnthropicBaseUrl: (...args: Parameters<typeof realProviders.isFirstPartyAnthropicBaseUrl>) =>
    activeProfilesOverride
      ? false
      : realProviders.isFirstPartyAnthropicBaseUrl(...args),
  isGithubNativeAnthropicMode: (...args: Parameters<typeof realProviders.isGithubNativeAnthropicMode>) =>
    activeProfilesOverride
      ? false
      : realProviders.isGithubNativeAnthropicMode(...args),
  usesAnthropicAccountFlow: (...args: Parameters<typeof realProviders.usesAnthropicAccountFlow>) =>
    activeProfilesOverride
      ? false
      : realProviders.usesAnthropicAccountFlow(...args),
}))

mock.module('../auth.js', () => ({
  ...realAuth,
  isClaudeAISubscriber: (...args: Parameters<typeof realAuth.isClaudeAISubscriber>) =>
    activeSubscriberOverride
      ? true
      : activeProfilesOverride ? false : realAuth.isClaudeAISubscriber(...args),
  isMaxSubscriber: (...args: Parameters<typeof realAuth.isMaxSubscriber>) =>
    activeSubscriberOverride
      ? !!activeSubscriberOverride.max
      : activeProfilesOverride ? false : realAuth.isMaxSubscriber(...args),
  isTeamPremiumSubscriber: (...args: Parameters<typeof realAuth.isTeamPremiumSubscriber>) =>
    activeProfilesOverride
      ? false
      : realAuth.isTeamPremiumSubscriber(...args),
}))

function buildProviderProfileFixture(
  overrides: Partial<ProviderProfile> = {},
): ProviderProfile {
  return {
    id: 'profile_default',
    name: 'Default Profile',
    provider: 'openai',
    baseUrl: 'https://api.example.com/v1',
    model: 'example-model',
    apiKey: 'sk-example',
    ...overrides,
  }
}

async function importFreshModelOptionsModule(
  providerProfilesMock: Partial<typeof import('../providerProfiles.js')>,
) {
  activeProfilesOverride = providerProfilesMock
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

beforeEach(() => {
  activeProfilesOverride = null
  activeCacheScopeOverride = null
  activeSettingsOverride = null
  activeOllamaOverride = null
  activeApiProviderOverride = null
  activeNvidiaOverride = null
  activeSubscriberOverride = null
  activeMiniMaxOverride = null
  activeXiaomiOverride = null
  setSessionSettingsCache({ settings: {}, errors: [] })
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  // Clear the gates so the persisted provider/auth/profile/providerConfig/settings
  // mocks fall through to the real implementations for every later suite.
  activeProfilesOverride = null
  activeCacheScopeOverride = null
  activeSettingsOverride = null
  activeOllamaOverride = null
  activeApiProviderOverride = null
  activeNvidiaOverride = null
  activeSubscriberOverride = null
  activeMiniMaxOverride = null
  activeXiaomiOverride = null
  resetSettingsCache()
  resetModelStringsForTestingOnly()
})

test('parseSwitchProfileValue: round-trips encoded payload', async () => {
  const { encodeSwitchProfileValue, parseSwitchProfileValue } =
    await importFreshModelOptionsModule({})
  const encoded = encodeSwitchProfileValue('profile_kimi_k26', 'kimi-k2.6')
  expect(parseSwitchProfileValue(encoded)).toEqual({
    profileId: 'profile_kimi_k26',
    model: 'kimi-k2.6',
  })
})

test('parseSwitchProfileValue: preserves colons inside model name', async () => {
  // OpenRouter model strings carry `:` segments (`vendor/model:variant`); the
  // parser must split only on the FIRST colon after the prefix so the model
  // half keeps its inner colons. Regression guard against a naive
  // `value.split(':')`.
  const { encodeSwitchProfileValue, parseSwitchProfileValue } =
    await importFreshModelOptionsModule({})
  const encoded = encodeSwitchProfileValue(
    'profile_openrouter',
    'deepseek/deepseek-v4-flash:nitro',
  )
  expect(parseSwitchProfileValue(encoded)).toEqual({
    profileId: 'profile_openrouter',
    model: 'deepseek/deepseek-v4-flash:nitro',
  })
})

test('parseSwitchProfileValue: returns null for plain model strings', async () => {
  const { parseSwitchProfileValue } = await importFreshModelOptionsModule({})
  expect(parseSwitchProfileValue('claude-sonnet-4-6')).toBeNull()
  expect(parseSwitchProfileValue(null)).toBeNull()
  expect(parseSwitchProfileValue('__switch_profile__:')).toBeNull()
  expect(parseSwitchProfileValue('__switch_profile__:only-id:')).toBeNull()
})

test('getInactiveProviderProfileOptions: omits the active profile', async () => {
  const profileA = buildProviderProfileFixture({
    id: 'profile_a',
    name: 'A',
    baseUrl: 'https://a.example.com/v1',
    model: 'a-model',
  })
  const profileB = buildProviderProfileFixture({
    id: 'profile_b',
    name: 'B',
    baseUrl: 'https://b.example.com/v1',
    model: 'b-model',
  })
  const { getInactiveProviderProfileOptions } =
    await importFreshModelOptionsModule({
      getProviderProfiles: () => [profileA, profileB],
      getActiveProviderProfile: () => profileA,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })

  const options = getInactiveProviderProfileOptions('profile_a')
  expect(options).toHaveLength(1)
  expect(options[0]?.switchToProfileId).toBe('profile_b')
  expect(options[0]?.label).toContain('b-model')
  expect(options[0]?.label).toContain('B')
  expect(options[0]?.description).toContain('https://b.example.com/v1')
  expect(typeof options[0]?.value).toBe('string')
  expect(options[0]?.value).toContain('profile_b')
  expect(options[0]?.value).toContain('b-model')
})

test('getInactiveProviderProfileOptions: surfaces all configured profiles when none is active', async () => {
  // Edge: if the caller passes `undefined` (no active profile yet — e.g. on a
  // pristine first-run before env is applied), every configured profile should
  // appear. Guards against a stray `filter` that drops everything when the
  // active id is missing.
  const profileA = buildProviderProfileFixture({
    id: 'profile_a',
    name: 'A',
    model: 'a-model',
  })
  const profileB = buildProviderProfileFixture({
    id: 'profile_b',
    name: 'B',
    model: 'b-model',
  })
  const { getInactiveProviderProfileOptions } =
    await importFreshModelOptionsModule({
      getProviderProfiles: () => [profileA, profileB],
      getActiveProviderProfile: () => undefined,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })

  const options = getInactiveProviderProfileOptions(undefined)
  expect(options.map(o => o.switchToProfileId)).toEqual([
    'profile_a',
    'profile_b',
  ])
})

test('getInactiveProviderProfileOptions: explodes multi-model profiles into one option per model', async () => {
  // Issue #1119 use case: one OpenRouter profile with several `agentModels`
  // exposed as comma-separated `model`. Each model should become its own
  // picker entry so the user can pick the exact one they want, not just the
  // primary.
  const multi = buildProviderProfileFixture({
    id: 'profile_or',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4-flash:nitro,glm-5.1,MiniMax-M2.5',
  })
  const { getInactiveProviderProfileOptions } =
    await importFreshModelOptionsModule({
      getProviderProfiles: () => [multi],
      getActiveProviderProfile: () => undefined,
      getProfileModelOptions: () => [
        {
          value: 'deepseek/deepseek-v4-flash:nitro',
          label: 'deepseek/deepseek-v4-flash:nitro',
          description: 'OpenRouter',
        },
        { value: 'glm-5.1', label: 'glm-5.1', description: 'OpenRouter' },
        {
          value: 'MiniMax-M2.5',
          label: 'MiniMax-M2.5',
          description: 'OpenRouter',
        },
      ],
    })
  const options = getInactiveProviderProfileOptions(undefined)
  expect(options).toHaveLength(3)
  expect(options.every(o => o.switchToProfileId === 'profile_or')).toBe(true)
  expect(options.map(o => o.label.split(' · ')[0])).toEqual([
    'deepseek/deepseek-v4-flash:nitro',
    'glm-5.1',
    'MiniMax-M2.5',
  ])
})

test('getModelOptionsBase: 3P path includes inactive profile options when env applied', async () => {
  const active = buildProviderProfileFixture({
    id: 'profile_active',
    name: 'Active',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'kimi-k2.6',
  })
  const inactive = buildProviderProfileFixture({
    id: 'profile_inactive',
    name: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.1',
  })

  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  try {
    const { getModelOptions, parseSwitchProfileValue } =
      await importFreshModelOptionsModule({
        getProviderProfiles: () => [active, inactive],
        getActiveProviderProfile: () => active,
        getProfileModelOptions: profile => [
          { value: profile.model, label: profile.model, description: profile.name },
        ],
      })

    const options = getModelOptions(false)
    const switchOptions = options.filter(o => o.switchToProfileId !== undefined)
    expect(switchOptions.length).toBeGreaterThan(0)
    expect(switchOptions[0]?.switchToProfileId).toBe('profile_inactive')
    const parsed = parseSwitchProfileValue(switchOptions[0]!.value)
    expect(parsed).toEqual({
      profileId: 'profile_inactive',
      model: 'glm-5.1',
    })
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
})

test('getModelOptionsBase: local OpenAI-compatible scope still appends inactive profile options', async () => {
  // Regression for #1164: when the active profile is a local OpenAI-compatible
  // endpoint (Ollama, lm-studio, etc.), the scope-based early return used to
  // skip the inactive-profile compute and the cross-profile switcher
  // disappeared from `/model`. Now the inactive options are hoisted above the
  // early return and forwarded in this branch too.
  const active = buildProviderProfileFixture({
    id: 'profile_local',
    name: 'Local Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
  })
  const inactive = buildProviderProfileFixture({
    id: 'profile_remote',
    name: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.1',
  })

  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  // Force the local OpenAI-compatible branch by pinning the scope getter to
  // an `openai:` value (via the gated override installed at module load, which
  // keeps the rest of providerConfig real so it can't leak into other suites).
  activeCacheScopeOverride = 'openai:http://localhost:11434/v1'
  try {
    const { getModelOptions, parseSwitchProfileValue } =
      await importFreshModelOptionsModule({
        getProviderProfiles: () => [active, inactive],
        getActiveProviderProfile: () => active,
        getProfileModelOptions: profile => [
          { value: profile.model, label: profile.model, description: profile.name },
        ],
      })

    const options = getModelOptions(false)
    const switchOptions = options.filter(o => o.switchToProfileId !== undefined)
    expect(switchOptions.length).toBeGreaterThan(0)
    expect(switchOptions[0]?.switchToProfileId).toBe('profile_remote')
    const parsed = parseSwitchProfileValue(switchOptions[0]!.value)
    expect(parsed).toEqual({
      profileId: 'profile_remote',
      model: 'glm-5.1',
    })
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
})

test('getModelOptionsBase: active Ollama profile still surfaces inactive profile options', async () => {
  // Regression for #1164: the `isOllamaProvider()` early return ran before the
  // inactive-profile compute, so a user whose active profile is a local Ollama
  // endpoint only saw the Ollama models and lost the cross-profile switcher,
  // forcing the exact `/provider` round-trip this PR removes. The inactive
  // options are now hoisted above the Ollama branch and appended to its returns.
  const active = buildProviderProfileFixture({
    id: 'profile_ollama',
    name: 'Local Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
  })
  const inactive = buildProviderProfileFixture({
    id: 'profile_remote',
    name: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.1',
  })

  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  // Force the Ollama branch with a non-empty cached-model list so it takes the
  // `[default, ...ollamaModels, ...inactiveProfileOptions]` return path.
  activeOllamaOverride = {
    cachedModels: [
      { value: 'llama3.2', label: 'llama3.2', description: 'Local Ollama' },
    ],
  }
  try {
    const { getModelOptions, parseSwitchProfileValue } =
      await importFreshModelOptionsModule({
        getProviderProfiles: () => [active, inactive],
        getActiveProviderProfile: () => active,
        getProfileModelOptions: profile => [
          { value: profile.model, label: profile.model, description: profile.name },
        ],
      })

    const options = getModelOptions(false)
    // The Ollama model is still present...
    expect(options.some(o => o.value === 'llama3.2')).toBe(true)
    // ...and the inactive profile now appears as a switch option.
    const switchOptions = options.filter(o => o.switchToProfileId !== undefined)
    expect(switchOptions.length).toBeGreaterThan(0)
    expect(switchOptions[0]?.switchToProfileId).toBe('profile_remote')
    const parsed = parseSwitchProfileValue(switchOptions[0]!.value)
    expect(parsed).toEqual({ profileId: 'profile_remote', model: 'glm-5.1' })
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
})

test('getModelOptionsBase: 3P path omits inactive profile options when env NOT applied', async () => {
  // If the user hasn't gone through `/provider` yet (profile env not applied),
  // surfacing cross-profile switching would be confusing — they haven't opted
  // into the multi-profile workflow at all. Guard against that.
  const inactive = buildProviderProfileFixture({
    id: 'profile_inactive',
    name: 'GLM',
    model: 'glm-5.1',
  })
  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  try {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [inactive],
      getActiveProviderProfile: () => undefined,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const options = getModelOptions(false)
    expect(options.every(o => o.switchToProfileId === undefined)).toBe(true)
  } finally {
    if (previousFlag !== undefined) {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
})

test('getModelOptions: allowlist filters cross-profile options by the decoded target model', async () => {
  // Regression for #1119: filterModelOptionsByAllowlist must evaluate the
  // allowlist against the decoded target model (parseSwitchProfileValue(value).model),
  // not the raw `__switch_profile__:<id>:<model>` wrapper. An allowed cross-profile
  // model must stay; a denied one must drop. Uses this suite's per-test isolated
  // settings cache (set below, reset in afterEach) rather than the shared cache
  // that made the earlier version flaky.
  const active = buildProviderProfileFixture({
    id: 'profile_active',
    name: 'Active',
    baseUrl: 'https://api.kimi.com/coding/',
    model: 'kimi-k2.6',
  })
  const allowedInactive = buildProviderProfileFixture({
    id: 'profile_allowed',
    name: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.1',
  })
  const deniedInactive = buildProviderProfileFixture({
    id: 'profile_denied',
    name: 'Blocked',
    baseUrl: 'https://blocked.example/v1',
    model: 'blocked-model',
  })

  // Only glm-5.1 (and the active model) are permitted; blocked-model is not.
  // Drive the allowlist through the gated getSettings_DEPRECATED override so it
  // is immune to sibling suites that mock the settings module process-wide.
  activeSettingsOverride = {
    availableModels: ['kimi-k2.6', 'glm-5.1'],
  } as SettingsJson

  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  try {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, allowedInactive, deniedInactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })

    const switchTargets = getModelOptions(false)
      .filter(o => o.switchToProfileId !== undefined)
      .map(o => o.switchToProfileId)

    // Allowed cross-profile model kept; denied one filtered out by the decoded
    // (not the encoded) model id.
    expect(switchTargets).toContain('profile_allowed')
    expect(switchTargets).not.toContain('profile_denied')
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
})

// Shared fixtures for the "other provider branches also append inactive
// profiles" cases (#1164 [P2]). Each branch previously returned before the
// inactive-profile options were appended, dropping the cross-profile switcher.
function activeAndInactivePair() {
  const active = buildProviderProfileFixture({
    id: 'profile_active',
    name: 'Active',
    model: 'active-model',
  })
  const inactive = buildProviderProfileFixture({
    id: 'profile_remote',
    name: 'GLM',
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-5.1',
  })
  return { active, inactive }
}

async function withProfileEnvApplied(run: () => Promise<void>) {
  const previousFlag = process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  try {
    await run()
  } finally {
    if (previousFlag === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = previousFlag
    }
  }
}

test('getModelOptionsBase: GitHub Copilot branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeApiProviderOverride = 'github'
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const switchOptions = getModelOptions(false).filter(
      o => o.switchToProfileId !== undefined,
    )
    expect(switchOptions.map(o => o.switchToProfileId)).toContain(
      'profile_remote',
    )
  })
})

test('getModelOptionsBase: NVIDIA NIM catalog branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeNvidiaOverride = {
    cachedModels: [
      { value: 'nvidia/model', label: 'nvidia/model', description: 'NVIDIA' },
    ],
  }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const options = getModelOptions(false)
    // Catalog model still present, and the inactive switcher restored.
    expect(options.some(o => o.value === 'nvidia/model')).toBe(true)
    expect(
      options
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: Claude subscriber branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeSubscriberOverride = {} // Pro/standard tier
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    expect(
      getModelOptions(false)
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: MiniMax catalog branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeMiniMaxOverride = {
    cachedModels: [
      { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7', description: 'MiniMax' },
    ],
  }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const options = getModelOptions(false)
    expect(options.some(o => o.value === 'MiniMax-M2.7')).toBe(true)
    expect(
      options
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: Xiaomi MiMo catalog branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeXiaomiOverride = {
    cachedModels: [
      { value: 'mimo-v2.5-pro', label: 'mimo-v2.5-pro', description: 'MiMo' },
    ],
  }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const options = getModelOptions(false)
    expect(options.some(o => o.value === 'mimo-v2.5-pro')).toBe(true)
    expect(
      options
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: ant branch appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  const prevUserType = process.env.USER_TYPE
  process.env.USER_TYPE = 'ant'
  try {
    await withProfileEnvApplied(async () => {
      const { getModelOptions } = await importFreshModelOptionsModule({
        getProviderProfiles: () => [active, inactive],
        getActiveProviderProfile: () => active,
        getProfileModelOptions: profile => [
          { value: profile.model, label: profile.model, description: profile.name },
        ],
      })
      expect(
        getModelOptions(false)
          .filter(o => o.switchToProfileId !== undefined)
          .map(o => o.switchToProfileId),
      ).toContain('profile_remote')
    })
  } finally {
    if (prevUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = prevUserType
  }
})

test('getModelOptionsBase: Max/Team Premium subscriber branch appends inactive profile options', async () => {
  // The Pro/standard subscriber branch is covered above; this locks the
  // separate Max / Team Premium early return (isMaxSubscriber ||
  // isTeamPremiumSubscriber), which builds its own premiumOptions array and
  // must push ...inactiveProfileOptions before returning.
  const { active, inactive } = activeAndInactivePair()
  activeSubscriberOverride = { max: true }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    expect(
      getModelOptions(false)
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: NVIDIA NIM empty-catalog fallback still appends inactive profile options', async () => {
  // The catalog branch above exercises the non-empty return; this locks the
  // `[defaultOption, ...inactiveProfileOptions]` fallback taken when the cached
  // catalog is empty, which previously dropped the inactive switch options.
  const { active, inactive } = activeAndInactivePair()
  activeNvidiaOverride = { cachedModels: [] }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    const options = getModelOptions(false)
    // No catalog model surfaced, but the inactive switcher is still restored.
    expect(options.some(o => o.value === 'nvidia/model')).toBe(false)
    expect(
      options
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: MiniMax empty-catalog fallback still appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeMiniMaxOverride = { cachedModels: [] }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    expect(
      getModelOptions(false)
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptionsBase: Xiaomi MiMo empty-catalog fallback still appends inactive profile options', async () => {
  const { active, inactive } = activeAndInactivePair()
  activeXiaomiOverride = { cachedModels: [] }
  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active, inactive],
      getActiveProviderProfile: () => active,
      getProfileModelOptions: profile => [
        { value: profile.model, label: profile.model, description: profile.name },
      ],
    })
    expect(
      getModelOptions(false)
        .filter(o => o.switchToProfileId !== undefined)
        .map(o => o.switchToProfileId),
    ).toContain('profile_remote')
  })
})

test('getModelOptions: allowlist checks a non-switch custom id verbatim, not decoded', async () => {
  // Regression for #1164 [P2]: filterModelOptionsByAllowlist must only decode
  // genuine switch options (identified by `switchToProfileId`), not any string
  // that happens to start with `__switch_profile__:`. A custom model id with
  // that literal prefix but no marker must be checked as-is — decoding it would
  // evaluate the allowlist against the wrong (inner) model and wrongly drop it.
  const literal = '__switch_profile__:sneaky:real-model'
  const active = buildProviderProfileFixture({
    id: 'profile_active',
    name: 'Active',
    model: literal,
  })
  // Allow the literal id (verbatim). Its decoded inner model `real-model` is NOT
  // listed, so the old prefix-based decode would have dropped it.
  activeSettingsOverride = { availableModels: [literal] } as SettingsJson

  await withProfileEnvApplied(async () => {
    const { getModelOptions } = await importFreshModelOptionsModule({
      getProviderProfiles: () => [active],
      getActiveProviderProfile: () => active,
      // Active profile's own model options are appended WITHOUT a
      // switchToProfileId marker, so this exercises the non-switch path.
      getProfileModelOptions: () => [
        { value: literal, label: 'Sneaky', description: 'custom' },
      ],
    })
    const values = getModelOptions(false).map(o => o.value)
    expect(values).toContain(literal)
  })
})
