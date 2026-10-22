import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { acquireEnvMutex, releaseEnvMutex } from '../../entrypoints/sdk/shared.js'
import { saveGlobalConfig } from '../config.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'

const providerSpecifier = './providers.js'
const realProvidersForCleanup = {
  ...await import(
    `${providerSpecifier}?real=${Date.now()}-${Math.random()}`
  ),
}

afterAll(() => {
  mock.restore()
  mock.module(providerSpecifier, () => realProvidersForCleanup)
})

async function importFreshModelOptionsModule() {
  mock.restore()
  mock.module('./providers.js', () => ({
    getAPIProvider: () => 'openai',
    getAPIProviderForStatsig: () => 'openai',
    isFirstPartyAnthropicBaseUrl: () => false,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
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
  CODEX_API_KEY: process.env.CODEX_API_KEY,
  CODEX_CREDENTIAL_SOURCE: process.env.CODEX_CREDENTIAL_SOURCE,
  CHATGPT_ACCOUNT_ID: process.env.CHATGPT_ACCOUNT_ID,
  CODEX_ACCOUNT_ID: process.env.CODEX_ACCOUNT_ID,
  HICAP_API_KEY: process.env.HICAP_API_KEY,
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

test('Hicap GLM discovered aliases reuse the static model option', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'zai-org/GLM-5.2'
  process.env.HICAP_API_KEY = 'hicap-test-key'

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).toContain('glm-5.2')
  expect(values).not.toContain('zai-org/GLM-5.2')
  expect(values.filter(value => value === 'glm-5.2')).toHaveLength(1)
})
test('Hicap Responses models expose the static route catalog in /model options', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.HICAP_API_KEY = 'hicap-test-key'

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).toContain('gpt-5.4')
  expect(values).toContain('gpt-5.5')
  expect(values).toContain('glm-5.2')
  expect(values).toContain('claude-opus-4.8')
  expect(values).toContain('claude-opus-4.7')
})

test('Hicap active profile model options merge with the static route catalog', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.HICAP_API_KEY = 'hicap-test-key'

  saveGlobalConfig(current => ({
    ...current,
    providerProfiles: [
      {
        id: 'hicap-profile',
        name: 'Hicap',
        provider: 'hicap',
        baseUrl: 'https://api.hicap.ai/v1',
        model: 'gpt-5.4',
      },
    ],
    activeProviderProfileId: 'hicap-profile',
    openaiAdditionalModelOptionsCacheByProfile: {
      'hicap-profile': [
        {
          value: 'gpt-5.4',
          label: 'GPT-5.4',
          description: 'Provider: Hicap',
        },
      ],
    },
  }))

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values.filter(value => value === 'gpt-5.4')).toHaveLength(1)
  expect(values).toContain('gpt-5.5')
  expect(values).toContain('glm-5.2')
  expect(values).toContain('claude-opus-4.8')
  expect(values).toContain('claude-opus-4.7')
})

test('Hicap Responses catalog ignores stale legacy OpenAI model cache', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.hicap.ai/v1'
  process.env.OPENAI_MODEL = 'gpt-5.4'
  process.env.HICAP_API_KEY = 'hicap-test-key'

  saveGlobalConfig(current => ({
    ...current,
    openaiAdditionalModelOptionsCache: [
      {
        value: 'stale-other-route-model',
        label: 'Stale model',
        description: 'Provider: Previous route',
      },
    ],
  }))

  const values = (await getOpenAIModelOptions()).map(option => option.value)

  expect(values).not.toContain('stale-other-route-model')
  expect(values).toContain('gpt-5.4')
  expect(values).toContain('gpt-5.5')
  expect(values).toContain('glm-5.2')
  expect(values).toContain('claude-opus-4.7')
})
