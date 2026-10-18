import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import { resetModelStringsForTestingOnly } from '../../bootstrap/state.js'
import { acquireEnvMutex, releaseEnvMutex } from '../../entrypoints/sdk/shared.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from '../settings/settingsCache.js'

// Picker recovery for persisted Codex models while a NON-Codex provider is
// active (the curated Codex options are only appended for the openai/codex
// providers): the persisted value must surface the curated label/description
// instead of a generic "Custom model" entry — including [1m]-tagged picks,
// whose exact tagged value must be preserved on the option.

async function importFreshModelOptionsModule(provider: string) {
  mock.restore()
  mock.module('./providers.js', () => ({
    getAPIProvider: () => provider,
    getAPIProviderForStatsig: () => provider,
    isFirstPartyAnthropicBaseUrl: () => false,
    isFirstPartyAnthropicProvider: () => false,
    isCustomAnthropicProvider: () => false,
    isGithubNativeAnthropicMode: () => false,
    usesAnthropicAccountFlow: () => false,
  }))
  const nonce = `${Date.now()}-${Math.random()}`
  const modelModule = await import(`./model.js?codexRecoveryTest=${nonce}`)
  mock.module('./model.js', () => modelModule)
  return import(`./modelOptions.js?ts=${nonce}`)
}

const ENV_KEYS = [
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'ANTHROPIC_MODEL',
] as const

const originalEnv: Record<string, string | undefined> = {}

beforeEach(async () => {
  await acquireEnvMutex()
  mock.restore()
  setSessionSettingsCache({ settings: {}, errors: [] })
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key]
    delete process.env[key]
  }
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  try {
    mock.restore()
    resetSettingsCache()
    for (const key of ENV_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  } finally {
    releaseEnvMutex()
  }
})

test('persisted [1m]-tagged Codex model surfaces its curated option under a non-Codex provider', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'gpt-5.6-terra[1m]'
  const { getModelOptions } = await importFreshModelOptionsModule('xai')

  const options = getModelOptions()
  const recovered = options.filter(opt => opt.value === 'gpt-5.6-terra[1m]')

  expect(recovered).toHaveLength(1)
  // Exact tagged value preserved (selection matching stays exact) with the
  // curated Codex label/description, not a generic "Custom model" entry.
  expect(recovered[0]!.label).toBe('gpt-5.6-terra')
  expect(recovered[0]!.description).toBe(
    'GPT-5.6 Terra · Balanced everyday workhorse',
  )
  expect(options.some(opt => opt.description === 'Custom model')).toBe(false)
})

test('persisted untagged Codex model never degrades to a "Custom model" entry', async () => {
  // The untagged form may be served by an earlier path (the OpenAI-compat
  // route catalog supplies its own labeled option) rather than the Codex
  // recovery branch — either way the user must see a real label, never the
  // generic custom-model fallback.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_MODEL = 'gpt-5.6-luna'
  const { getModelOptions } = await importFreshModelOptionsModule('xai')

  const options = getModelOptions()
  const recovered = options.filter(opt => opt.value === 'gpt-5.6-luna')

  expect(recovered).toHaveLength(1)
  expect(recovered[0]!.description).not.toBe('Custom model')
  expect(recovered[0]!.label.toLowerCase()).toContain('gpt-5.6')
})
