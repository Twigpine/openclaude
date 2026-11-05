import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { isAzureStyleBaseUrl } from '../services/api/providerConfig.js'
import type { GlobalConfig } from './config.js'
import {
  enableConfigs,
  getGlobalConfig,
  saveGlobalConfig,
} from './config.js'
import {
  clearRememberedEnvFileValuesForTests,
  loadEnvFile,
  rememberLoadedEnvFileValues,
} from './envFile.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from './managedEnv.js'
import {
  applyModelFlagFromArgs,
  clearRememberedModelFlagForTests,
} from './providerFlag.js'
import {
  applyProviderProfileToProcessEnv,
  clearProviderProfileEnvFromProcessEnv,
  updateProviderProfile,
} from './providerProfiles.js'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'
import { getSmallFastModel } from './model/model.js'
import { getCommandcodeChatCompletionsModelError } from '../integrations/gateways/commandcode.js'

const ENV_KEYS = [
  'GEMINI_ACCESS_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CMD_API_KEY',
  'COMMANDCODE_API_KEY',
  'COMMAND_CODE_API_KEY',
  'API_ROUTE_API_KEY',
  'API_ROUTE_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_AZURE_STYLE',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
]

const originalEnv = new Map<string, string | undefined>()
let originalConfigEnv: Record<string, string> = {}
let originalProviderProfiles: GlobalConfig['providerProfiles']
let originalActiveProviderProfileId: GlobalConfig['activeProviderProfileId']
let tempDir: string

beforeEach(async () => {
  await acquireSharedMutationLock('utils/managedEnv.test.ts')
  enableConfigs()
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-managed-env-test-'))

  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }

  const currentConfig = getGlobalConfig()
  originalConfigEnv = { ...currentConfig.env }
  originalProviderProfiles = currentConfig.providerProfiles
    ? [...currentConfig.providerProfiles]
    : undefined
  originalActiveProviderProfileId = currentConfig.activeProviderProfileId
  saveGlobalConfig(current => ({
    ...current,
    activeProviderProfileId: undefined,
    env: {},
    providerProfiles: [],
  }))
})

afterEach(() => {
  try {
    clearRememberedEnvFileValuesForTests()
    saveGlobalConfig(current => ({
      ...current,
      activeProviderProfileId: originalActiveProviderProfileId,
      env: originalConfigEnv,
      providerProfiles: originalProviderProfiles,
    }))

    for (const key of ENV_KEYS) {
      const originalValue = originalEnv.get(key)
      if (originalValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalValue
      }
    }
    originalEnv.clear()
    rmSync(tempDir, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

function writeTempEnvFile(content: string): string {
  const filePath = join(tempDir, '.env')
  writeFileSync(filePath, content, 'utf-8')
  return filePath
}

describe('host-managed API Route settings boundary', () => {
  for (const [name, applySettings] of [
    ['pre-trust', applySafeConfigEnvironmentVariables],
    ['post-trust', applyConfigEnvironmentVariables],
  ] as const) {
    it(`preserves host routing against API Route settings during ${name} merge`, () => {
      process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
      process.env.OPENAI_MODEL = 'host-model'
      process.env.OPENAI_API_KEY = 'host-key'
      process.env.GEMINI_ACCESS_TOKEN = 'host-google-token'
      saveGlobalConfig(current => ({
        ...current,
        env: {
          GEMINI_ACCESS_TOKEN: 'settings-google-token',
          API_ROUTE_API_KEY: 'settings-api-route-key',
          API_ROUTE_MODEL: 'settings-api-route-model',
        },
      }))

      applySettings()

      expect(process.env.API_ROUTE_API_KEY).toBeUndefined()
      expect(process.env.API_ROUTE_MODEL).toBeUndefined()
      expect(process.env.OPENAI_BASE_URL).toBe('https://api.openai.com/v1')
      expect(process.env.OPENAI_MODEL).toBe('host-model')
      expect(process.env.OPENAI_API_KEY).toBe('host-key')
      expect(process.env.GEMINI_ACCESS_TOKEN).toBe('host-google-token')
    })
  }
})

describe('applyConfigEnvironmentVariables', () => {
  it('preserves the complete host-managed Command Code route against settings env', () => {
    process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.commandcode.ai/provider/v1'
    process.env.OPENAI_MODEL = 'leader-model'
    process.env.OPENAI_API_KEY = 'leader-primary-key'
    process.env.CMD_API_KEY = 'leader-primary-key'
    process.env.COMMANDCODE_API_KEY = 'leader-fallback-key'
    process.env.COMMAND_CODE_API_KEY = 'leader-official-key'
    saveGlobalConfig(current => ({
      ...current,
      env: {
        CLAUDE_CODE_USE_OPENAI: '0',
        OPENAI_BASE_URL: 'https://settings.example/v1',
        OPENAI_MODEL: 'settings-model',
        OPENAI_API_KEY: 'settings-key',
        OPENAI_AZURE_STYLE: '1',
        CLAUDE_CODE_USE_GEMINI: '1',
        CLAUDE_CODE_USE_MISTRAL: '1',
        CMD_API_KEY: 'stale-settings-primary-key',
        COMMANDCODE_API_KEY: 'stale-settings-fallback-key',
        COMMAND_CODE_API_KEY: 'stale-settings-official-key',
      },
    }))

    applyConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_BASE_URL).toBe(
      'https://api.commandcode.ai/provider/v1',
    )
    expect(process.env.OPENAI_MODEL).toBe('leader-model')
    expect(process.env.OPENAI_API_KEY).toBe('leader-primary-key')
    expect(process.env.OPENAI_AZURE_STYLE).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_MISTRAL).toBeUndefined()
    expect(
      isAzureStyleBaseUrl(process.env.OPENAI_BASE_URL, process.env),
    ).toBe(false)
    expect(process.env.CMD_API_KEY).toBe('leader-primary-key')
    expect(process.env.COMMANDCODE_API_KEY).toBe('leader-fallback-key')
    expect(process.env.COMMAND_CODE_API_KEY).toBe('leader-official-key')
  })

  it('restores remembered provider env-file values after full settings env merge', () => {
    const filePath = writeTempEnvFile([
      'CLAUDE_CODE_USE_OPENAI=1',
      'OPENAI_API_KEY=file-key',
      'OPENAI_BASE_URL=https://file.example/v1',
      'OPENAI_MODEL=file-model',
    ].join('\n'))
    const loaded = loadEnvFile(filePath)
    rememberLoadedEnvFileValues(loaded)
    saveGlobalConfig(current => ({
      ...current,
      env: {
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_API_KEY: 'settings-key',
        OPENAI_BASE_URL: 'https://settings.example/v1',
        OPENAI_MODEL: 'settings-model',
      },
    }))

    applyConfigEnvironmentVariables()

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_API_KEY).toBe('file-key')
    expect(process.env.OPENAI_BASE_URL).toBe('https://file.example/v1')
    expect(process.env.OPENAI_MODEL).toBe('file-model')
  })
})

describe('standalone --model with an active saved profile', () => {
  const codexProfile = {
    id: 'codex-oauth',
    name: 'Codex OAuth',
    provider: 'openai',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    model: 'codexplan',
    apiKey: '',
  }
  let savedEnv: NodeJS.ProcessEnv
  let savedModelOptions: GlobalConfig['openaiAdditionalModelOptionsCache']
  let savedModelOptionsByProfile: GlobalConfig['openaiAdditionalModelOptionsCacheByProfile']

  beforeEach(() => {
    // Profile application clears credentials and route settings as well as
    // selection flags. Own that entire mutation boundary under the shared lock.
    savedEnv = { ...process.env }
    savedModelOptions = getGlobalConfig().openaiAdditionalModelOptionsCache
    savedModelOptionsByProfile = getGlobalConfig().openaiAdditionalModelOptionsCacheByProfile
    clearRememberedModelFlagForTests()
    clearProviderProfileEnvFromProcessEnv()
    for (const flag of PROVIDER_SELECTION_FLAGS) delete process.env[flag]
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    process.env.OPENCLAUDE_CONFIG_DIR = tempDir
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [codexProfile],
      activeProviderProfileId: codexProfile.id,
    }))
  })

  afterEach(() => {
    clearRememberedModelFlagForTests()
    saveGlobalConfig(current => ({
      ...current,
      openaiAdditionalModelOptionsCache: savedModelOptions,
      openaiAdditionalModelOptionsCacheByProfile: savedModelOptionsByProfile,
    }))
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
  })

  it('keeps the --model flag when settings env merges re-apply the profile (#2388)', () => {
    applySafeConfigEnvironmentVariables()
    expect(process.env.OPENAI_MODEL).toBe('codexplan')

    applyModelFlagFromArgs(['--model', 'gpt-5.6-terra'], {
      rememberForSettingsEnv: true,
    })
    applySafeConfigEnvironmentVariables()
    expect(process.env.OPENAI_MODEL).toBe('gpt-5.6-terra')

    applyConfigEnvironmentVariables()
    expect(process.env.OPENAI_MODEL).toBe('gpt-5.6-terra')
    expect(process.env.OPENAI_BASE_URL).toBe(codexProfile.baseUrl)
  })

  it('does not carry the --model flag onto a profile activated later', () => {
    applySafeConfigEnvironmentVariables()
    applyModelFlagFromArgs(['--model', 'gpt-5.6-terra'], {
      rememberForSettingsEnv: true,
    })

    const otherProfile = { ...codexProfile, id: 'codex-other', model: 'gpt-5.5' }
    saveGlobalConfig(current => ({
      ...current,
      providerProfiles: [codexProfile, otherProfile],
      activeProviderProfileId: otherProfile.id,
    }))
    applyProviderProfileToProcessEnv(otherProfile)
    applyConfigEnvironmentVariables()

    expect(process.env.OPENAI_MODEL).toBe('gpt-5.5')
  })

  for (const [name, applySettings] of [
    ['pre-trust', applySafeConfigEnvironmentVariables],
    ['post-trust', applyConfigEnvironmentVariables],
  ] as const) {
    it(`does not replay an env-only model after switching to GitHub during ${name} merge`, () => {
      saveGlobalConfig(current => ({
        ...current,
        providerProfiles: [],
        activeProviderProfileId: undefined,
      }))
      process.env.CLAUDE_CODE_USE_OPENAI = '1'
      process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
      applyModelFlagFromArgs(['--model', 'qwen3:30b'], {
        rememberForSettingsEnv: true,
      })
      applySettings()
      expect(process.env.OPENAI_MODEL).toBe('qwen3:30b')

      // The built-in GitHub activation clears profile markers and selects its
      // own model without creating a saved profile ID.
      clearProviderProfileEnvFromProcessEnv()
      process.env.CLAUDE_CODE_USE_GITHUB = '1'
      process.env.OPENAI_MODEL = 'github:copilot'
      applySettings()

      expect(getSmallFastModel()).toBe('github:copilot')
    })

    for (const [change, updates] of [
      ['gateway', {
        baseUrl: 'https://api.commandcode.ai/provider/v1',
        model: 'deepseek/deepseek-v4-flash',
      }],
      ['custom endpoint', { baseUrl: 'https://second.example/v1' }],
      ['API format', { apiFormat: 'responses' as const }],
    ] as const) {
      it(`does not replay onto an edited profile's ${change} during ${name} merge`, () => {
        const profile = {
          ...codexProfile,
          baseUrl: 'https://first.example/v1',
          model: 'gpt-4o',
          apiKey: 'test-key',
        }
        saveGlobalConfig(current => ({ ...current, providerProfiles: [profile] }))
        applyProviderProfileToProcessEnv(profile)
        applyModelFlagFromArgs(['--model', 'anthropic/claude-sonnet-4-6'], {
          rememberForSettingsEnv: true,
        })

        const edited = updateProviderProfile(profile.id, { ...profile, ...updates })
        expect(edited).not.toBeNull()
        applySettings()

        expect(getSmallFastModel()).toBe(edited!.model)
        expect(process.env.OPENAI_BASE_URL).toBe(edited!.baseUrl)
        if (change === 'gateway') {
          expect(getCommandcodeChatCompletionsModelError(getSmallFastModel())).toBeNull()
        }
      })
    }

    it(`retains the override after a same-route name/key edit during ${name} merge`, () => {
      applyProviderProfileToProcessEnv(codexProfile)
      applyModelFlagFromArgs(['--model', 'gpt-5.6-terra'], {
        rememberForSettingsEnv: true,
      })
      expect(updateProviderProfile(codexProfile.id, {
        ...codexProfile,
        name: 'Renamed profile',
        apiKey: 'replacement-key',
      })).not.toBeNull()

      applySettings()
      expect(getSmallFastModel()).toBe('gpt-5.6-terra')
    })
  }
})
