import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { acquireEnvMutex, releaseEnvMutex } from '../../entrypoints/sdk/shared.js'
import { saveGlobalConfig } from '../config.js'
import { resolveActiveRouteIdFromEnv } from '../../integrations/routeMetadata.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'

async function importFreshModelOptionsModule(
  provider = 'openai',
  isFirstPartyAnthropicBaseUrl = false,
) {
  mock.restore()
  mock.module('./providers.js', () => ({
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => isFirstPartyAnthropicBaseUrl,
    isFirstPartyAnthropicProvider: () =>
      provider === 'firstParty' && isFirstPartyAnthropicBaseUrl,
    isCustomAnthropicProvider: () =>
      provider === 'firstParty' && !isFirstPartyAnthropicBaseUrl,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const modelModule = await import(`./model.js?modelOptionsTest=${nonce}`)
  mock.module('./model.js', () => modelModule)
  return import(`./modelOptions.js?ts=${nonce}`)
}

async function getOpenAIModelOptions() {
  const { getModelOptions } = await importFreshModelOptionsModule()
  return getModelOptions()
}
const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_FORMAT: process.env.OPENAI_API_FORMAT,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  ATLAS_CLOUD_API_KEY: process.env.ATLAS_CLOUD_API_KEY,
  CODEX_API_KEY: process.env.CODEX_API_KEY,
  CODEX_CREDENTIAL_SOURCE: process.env.CODEX_CREDENTIAL_SOURCE,
  CHATGPT_ACCOUNT_ID: process.env.CHATGPT_ACCOUNT_ID,
  CODEX_ACCOUNT_ID: process.env.CODEX_ACCOUNT_ID,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
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
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    mock.restore()
    resetSettingsCache()
    for (const key of Object.keys(originalEnv) as (keyof typeof originalEnv)[]) {
      restoreEnvValue(key)
    }
    saveGlobalConfig(current => ({
      ...current,
      additionalModelOptionsCache: [],
      additionalModelOptionsCacheScope: undefined,
      openaiAdditionalModelOptionsCache: [],
      openaiAdditionalModelOptionsCacheByProfile: {},
      providerProfiles: [],
      activeProviderProfileId: undefined,
    }))
    resetModelStringsForTestingOnly()
  } finally {
    releaseEnvMutex()
  }
})

test('OpenRouter keeps static catalog entries and the active custom model', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'deepseek/deepseek-chat'
  process.env.OPENROUTER_API_KEY = 'sk-openrouter-test'

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).toContain('openai/gpt-5-mini')
  expect(values).toContain('deepseek/deepseek-chat')
})

test('Kimi Code keeps context variants distinct in the active route picker', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  process.env.OPENAI_MODEL = 'k3-256k'
  process.env.OPENAI_API_KEY = 'sk-kimi-test'

  const options = await getOpenAIModelOptions()
  expect(options.find(option => option.value === 'k3')?.label).toBe('Kimi K3 (1M)')
  expect(options.find(option => option.value === 'k3-256k')?.label).toBe('Kimi K3 (256K)')
})

test('Z.AI surfaces GLM-5.3-Flash once ahead of GLM-5.3 without changing the default', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_API_KEY = 'sk-zai-test'

  const options = await getOpenAIModelOptions()
  const values = options.map(option => option.value)

  expect(values.filter(value => value === 'glm-5.3-flash')).toHaveLength(1)
  expect(values.filter(value => value === 'glm-5.3')).toHaveLength(1)
  expect(values.indexOf('glm-5.3-flash')).toBeLessThan(values.indexOf('glm-5.3'))
  expect(values.indexOf('glm-5.3')).toBeLessThan(values.indexOf('glm-5.2'))
  expect(options.find(option => option.value === 'glm-5.3-flash')?.label).toBe(
    'GLM-5.3-Flash',
  )
  expect(options.find(option => option.value === 'glm-5.3')?.label).toBe('GLM-5.3')
  expect(options.find(option => option.value === null)?.description).toContain('glm-5.2')
})

test('saved Z.AI profile follows explicit runtime endpoints across the model picker lifecycle', async () => {
  const codingPlanUrl = 'https://api.z.ai/api/coding/paas/v4'
  const profileId = 'zai-coding-profile'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_API_KEY = 'sk-zai-test'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED = '1'
  process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID = profileId

  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [{
      id: profileId,
      name: 'Z.AI Coding Plan',
      provider: 'zai',
      baseUrl: codingPlanUrl,
      model: 'glm-5.2',
    }],
    activeProviderProfileId: profileId,
  }))

  for (const baseUrl of [
    'https://api.z.ai/api/paas/v4',
    'https://proxy.example.test/v1',
  ]) {
    process.env.OPENAI_BASE_URL = baseUrl
    expect(resolveActiveRouteIdFromEnv(process.env, {
      activeProfileProvider: 'zai',
      activeProfileBaseUrl: codingPlanUrl,
    })).toBe('custom')
    const values = (await getOpenAIModelOptions()).map(option => option.value)
    expect(values).not.toContain('glm-5.3-flash')
    expect(values).not.toContain('glm-5.3')
    expect(values).toContain('glm-5.2')
  }

  process.env.OPENAI_BASE_URL = codingPlanUrl
  expect(resolveActiveRouteIdFromEnv(process.env, {
    activeProfileProvider: 'zai',
    activeProfileBaseUrl: codingPlanUrl,
  })).toBe('zai')
  const restored = await getOpenAIModelOptions()
  const restoredValues = restored.map(option => option.value)
  expect(restoredValues).toContain('glm-5.3-flash')
  expect(restoredValues).toContain('glm-5.3')
  expect(restored.find(option => option.value === null)?.description).toContain(
    'glm-5.2',
  )
})

test('custom Anthropic endpoints use the third-party default description', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
  process.env.ANTHROPIC_MODEL = 'proxy-model'
  process.env.ANTHROPIC_API_KEY = 'proxy-key'

  const { getModelOptions } = await importFreshModelOptionsModule('firstParty')
  const defaultOption = getModelOptions().find(option => option.value === null)

  expect(defaultOption?.description).toContain('currently proxy-model')
  expect(defaultOption?.description).not.toContain('$')
})

test('custom Anthropic endpoints omit first-party pricing from every model option', async () => {
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'
  process.env.ANTHROPIC_API_KEY = 'proxy-key'

  const { getModelOptions } = await importFreshModelOptionsModule('firstParty')
  const options = getModelOptions()

  expect(options.length).toBeGreaterThan(1)
  for (const option of options) {
    expect(option.description).not.toContain('$')
  }
})

test('OpenRouter active profile cache merges with the static route catalog', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  process.env.OPENAI_MODEL = 'qwen/qwen3-32b'
  process.env.OPENROUTER_API_KEY = 'sk-openrouter-test'

  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [
      {
        id: 'openrouter-profile',
        name: 'OpenRouter',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/qwen3-32b',
      },
    ],
    activeProviderProfileId: 'openrouter-profile',
    openaiAdditionalModelOptionsCacheByProfile: {
      'openrouter-profile': [
        {
          value: 'qwen/qwen3-32b',
          label: 'Qwen3 32B',
          description: 'Provider: OpenRouter',
        },
      ],
    },
  }))

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).toContain('qwen/qwen3-32b')
  expect(values).toContain('openai/gpt-5-mini')
  expect(values).toContain('x-ai/grok-4.6')
  expect(values).toContain('x-ai/grok-4.5')
})

test('Atlas Cloud canonicalizes static catalog aliases without hiding the catalog', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.atlascloud.ai/v1'
  process.env.OPENAI_MODEL = 'claude-opus-4-8'
  process.env.ATLAS_CLOUD_API_KEY = 'sk-atlas-test'

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).toContain('anthropic/claude-opus-4.8')
  expect(values).toContain('deepseek-ai/deepseek-v4-pro')
  expect(values).toContain('xai/grok-build-0.1')
  expect(values).toContain('xai/grok-4.6')
  expect(values).toContain('xai/grok-4.5')
  expect(values).toContain('xai/grok-4.3')
  expect(values).not.toContain('claude-opus-4-8')
  expect(values).not.toContain('grok-code-fast-1')
  expect(values).not.toContain('grok-4')
})
