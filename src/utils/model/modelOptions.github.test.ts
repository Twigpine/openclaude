import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mock } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
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
    getAPIProvider: () => 'github',
    getAPIProviderForStatsig: () => 'github',
    isFirstPartyAnthropicBaseUrl: () => false,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./modelOptions.js?ts=${nonce}`)
}

const originalEnv = {
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  ANTHROPIC_CUSTOM_MODEL_OPTION: process.env.ANTHROPIC_CUSTOM_MODEL_OPTION,
}
const initialConfig = getGlobalConfig()
const originalConfig = {
  additionalModelOptionsCache: structuredClone(
    initialConfig.additionalModelOptionsCache ?? [],
  ),
  additionalModelOptionsCacheScope:
    initialConfig.additionalModelOptionsCacheScope,
  openaiAdditionalModelOptionsCache: structuredClone(
    initialConfig.openaiAdditionalModelOptionsCache ?? [],
  ),
  openaiAdditionalModelOptionsCacheByProfile: structuredClone(
    initialConfig.openaiAdditionalModelOptionsCacheByProfile ?? {},
  ),
  providerProfiles: structuredClone(initialConfig.providerProfiles ?? []),
  activeProviderProfileId: initialConfig.activeProviderProfileId,
}

function restoreEnvValue(
  key: keyof typeof originalEnv,
): void {
  const value = originalEnv[key]
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('model/modelOptions.github.test.ts')
  mock.restore()
  setSessionSettingsCache({ settings: {}, errors: [] })
  delete process.env.CLAUDE_CODE_USE_GITHUB
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    mock.restore()
    resetSettingsCache()
    restoreEnvValue('CLAUDE_CODE_USE_GITHUB')
    restoreEnvValue('CLAUDE_CODE_USE_OPENAI')
    restoreEnvValue('CLAUDE_CODE_USE_GEMINI')
    restoreEnvValue('CLAUDE_CODE_USE_BEDROCK')
    restoreEnvValue('CLAUDE_CODE_USE_VERTEX')
    restoreEnvValue('CLAUDE_CODE_USE_FOUNDRY')
    restoreEnvValue('OPENAI_MODEL')
    restoreEnvValue('OPENAI_BASE_URL')
    restoreEnvValue('ANTHROPIC_CUSTOM_MODEL_OPTION')
    saveGlobalConfig(current => ({
      ...current,
      additionalModelOptionsCache: originalConfig.additionalModelOptionsCache,
      additionalModelOptionsCacheScope: originalConfig.additionalModelOptionsCacheScope,
      openaiAdditionalModelOptionsCache: originalConfig.openaiAdditionalModelOptionsCache,
      openaiAdditionalModelOptionsCacheByProfile:
        originalConfig.openaiAdditionalModelOptionsCacheByProfile,
      providerProfiles: originalConfig.providerProfiles,
      activeProviderProfileId: originalConfig.activeProviderProfileId,
    }))
    resetModelStringsForTestingOnly()
  } finally {
    releaseSharedMutationLock()
  }
})

test('GitHub provider exposes default + all Copilot models in /model options', async () => {
  process.env.CLAUDE_CODE_USE_GITHUB = '1'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_USE_GEMINI
  delete process.env.CLAUDE_CODE_USE_BEDROCK
  delete process.env.CLAUDE_CODE_USE_VERTEX
  delete process.env.CLAUDE_CODE_USE_FOUNDRY

  process.env.OPENAI_MODEL = 'gpt-4o'
  delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION

  const { getModelOptions } = await importFreshModelOptionsModule()
  const options = getModelOptions(false)
  const nonDefault = options.filter(
    (option: { value: unknown }) => option.value !== null,
  )

  expect(nonDefault.length).toBeGreaterThan(1)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-4o')).toBe(true)
  expect(nonDefault.some((o: { value: unknown }) => o.value === 'gpt-5.3-codex')).toBe(true)
})
