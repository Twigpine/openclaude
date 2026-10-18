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

const ENV_KEYS = [
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
      saveGlobalConfig(current => ({
        ...current,
        env: {
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
