import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../bootstrap/state.js'
import { acquireEnvMutex, releaseEnvMutex } from '../entrypoints/sdk/shared.js'
import { saveGlobalConfig } from '../utils/config.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../utils/settings/settingsCache.js'
import * as actualAuth from '../utils/auth.js'
import * as actualModelOptions from '../utils/model/modelOptions.js'
import * as actualProviderProfiles from '../utils/providerProfiles.js'
import * as actualProviders from '../utils/model/providers.js'
import type { ProviderProfile } from '../utils/config.js'

// Snapshot the real modules before any mock.module runs. bun live-repoints the
// `actual*` namespaces to the active mock, so these plain-object copies are the
// stable handle on the genuine implementations (2026-04-30 mock-leak lesson).
const realAuth = { ...actualAuth }
const realModelOptions = { ...actualModelOptions }
const realProviderProfiles = { ...actualProviderProfiles }
const realProviders = { ...actualProviders }

// bun's mock.module is process-wide and mock.restore() does NOT undo it, so
// each mock is gated and falls through to the real implementation whenever
// activeProfilesOverride is null — a transparent passthrough for every other
// suite in the same `bun test` run.
let activeProfilesOverride: Partial<typeof actualProviderProfiles> | null = null

mock.module('../utils/model/providers.js', () => ({
  ...realProviders,
  getAPIProvider: () =>
    activeProfilesOverride ? 'openai' : realProviders.getAPIProvider(),
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

mock.module('../utils/auth.js', () => ({
  ...realAuth,
  isClaudeAISubscriber: (...args: Parameters<typeof realAuth.isClaudeAISubscriber>) =>
    activeProfilesOverride ? false : realAuth.isClaudeAISubscriber(...args),
  isMaxSubscriber: (...args: Parameters<typeof realAuth.isMaxSubscriber>) =>
    activeProfilesOverride ? false : realAuth.isMaxSubscriber(...args),
  isTeamPremiumSubscriber: (...args: Parameters<typeof realAuth.isTeamPremiumSubscriber>) =>
    activeProfilesOverride
      ? false
      : realAuth.isTeamPremiumSubscriber(...args),
}))

mock.module('../utils/providerProfiles.js', () => ({
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

// ModelPicker imports getModelOptions from modelOptions.js, whose providers /
// auth / providerProfiles bindings are resolved at ITS load time. Fresh-import
// modelOptions (with nonce) so those imports hit the gated mocks above, then
// mock modelOptions for the fresh ModelPicker import so its isGenuineSwitch-
// ProfileValue is bound to the fresh instance.
async function importFreshModelPicker(
  profilesMock: Partial<typeof actualProviderProfiles>,
  options: {
    trackGetModelOptions?: boolean
  } = {},
) {
  activeProfilesOverride = profilesMock
  const nonce = `${Date.now()}-${Math.random()}`
  const modelOptionsModule = await import(
    `../utils/model/modelOptions.js?switchProfile=${nonce}`
  )
  // Wrap getModelOptions in a call-through spy when a test opts in, so the
  // binding ModelPicker captures is itself tracked. Install before
  // mock.module / the picker import so the live export slot is the spy.
  const getModelOptionsSpy = options.trackGetModelOptions
    ? mock(
        (...args: Parameters<typeof modelOptionsModule.getModelOptions>) =>
          modelOptionsModule.getModelOptions(...args),
      )
    : null
  const gatedModelOptionsModule = getModelOptionsSpy
    ? { ...modelOptionsModule, getModelOptions: getModelOptionsSpy }
    : modelOptionsModule
  // Gated on the profile override: when no test is actively driving the
  // profiles, later suites importing modelOptions.js keep resolving to the
  // real canonical module instead of a stale fresh instance.
  mock.module('../utils/model/modelOptions.js', () =>
    activeProfilesOverride ? gatedModelOptionsModule : realModelOptions,
  )
  const pickerModule = await import(`./ModelPicker.js?switchProfile=${nonce}`)
  return {
    ...pickerModule,
    modelOptionsModule,
    getModelOptionsSpy,
  }
}

function buildProfileFixture(
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

const originalEnv = {
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}

function restoreEnvValue(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireEnvMutex()
  mock.restore()
  activeProfilesOverride = null
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [],
    activeProviderProfileId: undefined,
  }))
})

afterEach(() => {
  try {
    mock.restore()
    activeProfilesOverride = null
    resetSettingsCache()
    for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
      restoreEnvValue(key)
    }
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))
    resetModelStringsForTestingOnly()
  } finally {
    releaseEnvMutex()
  }
})

test('ordinary model ids are never switch values (prefix short-circuit)', async () => {
  const { isGenuineSwitchProfileValue, getModelOptionsSpy } =
    await importFreshModelPicker({}, { trackGetModelOptions: true })

  expect(isGenuineSwitchProfileValue('gpt-5.5')).toBe(false)
  expect(isGenuineSwitchProfileValue('deepseek-chat')).toBe(false)
  expect(isGenuineSwitchProfileValue('claude-sonnet-4-6')).toBe(false)

  // Ordinary ids don't start with the switch prefix, so the short-circuit
  // must skip the getModelOptions() rebuild entirely.
  expect(getModelOptionsSpy).toHaveBeenCalledTimes(0)
})

test('malformed prefixed values are not genuine switches', async () => {
  const { isGenuineSwitchProfileValue } = await importFreshModelPicker({})

  expect(isGenuineSwitchProfileValue('__switch_profile__')).toBe(false)
  expect(isGenuineSwitchProfileValue('__switch_profile__:')).toBe(false)
  expect(isGenuineSwitchProfileValue('__switch_profile__:only-id:')).toBe(false)
})

test('a switch option from the base list is a genuine switch', async () => {
  const active = buildProfileFixture({
    id: 'profile_active',
    name: 'Active',
    model: 'kimi-k2.6',
  })
  const inactive = buildProfileFixture({
    id: 'profile_inactive',
    name: 'GLM',
    model: 'glm-5.1',
  })

  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  try {
    const { isGenuineSwitchProfileValue, modelOptionsModule } =
      await importFreshModelPicker({
        getProviderProfiles: () => [active, inactive],
        getActiveProviderProfile: () => active,
        getProfileModelOptions: profile => [
          { value: profile.model, label: profile.model, description: profile.name },
        ],
      })
    const switchOption = modelOptionsModule.getModelOptions().find(
      option => option.switchToProfileId !== undefined,
    )

    expect(switchOption).toBeDefined()
    expect(isGenuineSwitchProfileValue(switchOption!.value)).toBe(true)
  } finally {
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  }
})

test('a prefixed value is not genuine without the marker-backed option (profile env not applied)', async () => {
  const active = buildProfileFixture({
    id: 'profile_active',
    name: 'Active',
    model: 'kimi-k2.6',
  })
  const inactive = buildProfileFixture({
    id: 'profile_inactive',
    name: 'GLM',
    model: 'glm-5.1',
  })

  const { isGenuineSwitchProfileValue } = await importFreshModelPicker({
    getProviderProfiles: () => [active, inactive],
    getActiveProviderProfile: () => active,
    getProfileModelOptions: profile => [
      { value: profile.model, label: profile.model, description: profile.name },
    ],
  })

  expect(
    isGenuineSwitchProfileValue('__switch_profile__:profile_inactive:glm-5.1'),
  ).toBe(false)
})

test('a literal custom model id that merely starts with the prefix is not decoded', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_API_KEY = 'sk-test'
  process.env.OPENAI_MODEL = '__switch_profile__:ghost:model'

  const { isGenuineSwitchProfileValue } = await importFreshModelPicker({})

  expect(isGenuineSwitchProfileValue('__switch_profile__:ghost:model')).toBe(
    false,
  )
})
