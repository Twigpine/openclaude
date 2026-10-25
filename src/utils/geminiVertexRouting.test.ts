import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'

test('native env routing stays independent of deferred profile setup', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'vertex-routing-'))
  const env = { ...process.env, OPENCLAUDE_CONFIG_DIR: configDir, CLAUDE_CONFIG_DIR: configDir }
  for (const key of [...PROVIDER_SELECTION_FLAGS, 'NODE_ENV', 'DISABLE_ERROR_REPORTING', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY']) delete env[key]
  try {
    const child = Bun.spawnSync([process.execPath, '-e', `
      import assert from 'node:assert/strict'
      Object.assign(globalThis, { MACRO: { VERSION: 'test' } })
      const log = await import('./src/utils/log.ts')
      log.logError(new Error('before-config'))
      assert(log.getInMemoryErrors().some(entry => entry.error.includes('before-config')))
      const { enableConfigs, saveGlobalConfig } = await import('./src/utils/config.ts')
      enableConfigs()
      const profiles = await import('./src/utils/providerProfiles.ts')
      const legacy = await import('./src/utils/providerProfile.ts')
      const { VALID_PROVIDERS, applyProviderFlag } = await import('./src/utils/providerFlag.ts')
      const { ORDERED_PROVIDER_PRESETS } = await import('./src/integrations/providerUiMetadata.ts')
      const { resolveActiveRouteIdFromEnv } = await import('./src/integrations/routeMetadata.ts')
      const { getAPIProvider } = await import('./src/utils/model/providers.ts')
      assert(VALID_PROVIDERS.includes('gemini-vertex'))
      assert(!ORDERED_PROVIDER_PRESETS.includes('gemini-vertex'))

      const saved = { id: 'saved', name: 'OpenAI', provider: 'openai',
        baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o', apiKey: 'test-key' }
      const config = { providerProfiles: [saved], activeProviderProfileId: saved.id }
      saveGlobalConfig(current => ({ ...current, ...config }))
      const native = { CLAUDE_CODE_USE_GEMINI_VERTEX: '1', GEMINI_VERTEX_PROJECT: 'test-project',
        GEMINI_VERTEX_MODEL: 'gemini-2.5-flash', GEMINI_ACCESS_TOKEN: 'fixture-token' }
      const persisted = legacy.createProfileFile('openai', {
        OPENAI_BASE_URL: 'https://proxy.example/v1', OPENAI_MODEL: 'old-model',
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'concentrate', OPENAI_API_KEY: 'proxy-key',
      })
      for (const fallback of [null, persisted]) {
        for (const ambient of [{}, { NVIDIA_NIM: '1', NVIDIA_API_KEY: 'ambient-key',
          OPENAI_BASE_URL: 'https://integrate.api.nvidia.com/v1' }]) {
          for (const selection of [native, { CLAUDE_CODE_USE_GEMINI_VERTEX: '1', GEMINI_VERTEX_AUTH_MODE: 'adc' },
            { CLAUDE_CODE_USE_GEMINI_VERTEX: '1', GOOGLE_APPLICATION_CREDENTIALS: '/fixture/adc.json' }]) {
            const input = { ...selection, ...ambient }
            assert.strictEqual(await legacy.buildStartupEnvFromProfile({ persisted: fallback, processEnv: input }), input)
          }
        }
      }
      const ordinary = await legacy.buildStartupEnvFromProfile({ persisted: legacy.createProfileFile('openai', {
        OPENAI_BASE_URL: saved.baseUrl, OPENAI_MODEL: saved.model, OPENAI_API_KEY: saved.apiKey,
      }), processEnv: {} })
      assert.equal(ordinary.CLAUDE_CODE_USE_OPENAI, '1')

      Object.assign(process.env, native)
      assert.equal(profiles.applyActiveProviderProfileFromConfig(config), undefined)
      assert.equal(getAPIProvider(), 'gemini-vertex')
      profiles.applyProviderProfileToProcessEnv(saved)
      assert.equal(process.env.CLAUDE_CODE_USE_GEMINI_VERTEX, undefined)
      assert.equal(getAPIProvider(), 'openai')
      assert.equal(applyProviderFlag('gemini-vertex', ['--model', 'gemini-2.5-pro']).error, undefined)
      assert.equal(process.env.CLAUDE_CODE_USE_OPENAI, undefined)
      assert.equal(process.env.GEMINI_VERTEX_MODEL, 'gemini-2.5-pro')
      assert.equal(getAPIProvider(), 'gemini-vertex')

      const unsupported = { ...saved, provider: 'gemini-vertex' }
      assert.deepEqual(profiles.getProviderProfiles({ providerProfiles: [unsupported] }), [])
      for (const candidate of [{}, { CLAUDE_CODE_USE_OPENAI: '1' }]) {
        assert.notEqual(resolveActiveRouteIdFromEnv(candidate, {
          activeProfileProvider: 'gemini-vertex', activeProfileBaseUrl: 'test-project',
        }), 'gemini-vertex')
      }
      process.exit(0)
    `], {
      cwd: resolve(import.meta.dir, '../..'), env, timeout: 8000,
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(child.exitCode, child.stderr.toString()).toBe(0)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
  // The child has an 8-second deadline; leave time for assertions and cleanup.
}, 10000)
