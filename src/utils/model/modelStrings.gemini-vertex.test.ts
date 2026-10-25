import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test.each(['flag'] as const)(
  'native Vertex %s initialization preserves defaults and built-in recovery',
  selection => {
    const configDir = mkdtempSync(join(tmpdir(), 'vertex-model-lifecycle-'))
    try {
      // A separate process uses real routing, config and model modules without
      // inheriting module mocks or cached model strings from other suites.
      const childEnv = { ...process.env }
      // Baseline defaults must not inherit the invoking shell's model override.
      delete childEnv.GEMINI_VERTEX_MODEL
      const result = Bun.spawnSync([process.execPath, '-e', `
        Object.assign(globalThis, { MACRO: { VERSION: 'test' } })
        const { enableConfigs } = await import('./src/utils/config.ts')
        enableConfigs()
        const profiles = await import('./src/utils/providerProfiles.ts')
        const models = await import('./src/utils/model/model.ts')
        const strings = await import('./src/utils/model/modelStrings.ts')
        const { getAPIProvider } = await import('./src/utils/model/providers.ts')
        const { getHardcodedTeammateModelFallback } = await import('./src/utils/swarm/teammateModel.ts')
        const { getPrimaryModel } = await import('./src/utils/providerModels.ts')
        process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
        const provider = getAPIProvider()
        const display = models.renderModelName('gemini-2.5-flash')
        await strings.ensureModelStringsInitialized()
        const native = {
          provider, display, strings: Object.values(strings.getModelStrings()),
          main: getPrimaryModel(models.getDefaultMainLoopModelSetting()),
          teammate: getHardcodedTeammateModelFallback(),
        }
        process.env.GEMINI_VERTEX_MODEL = 'gemini-3.5-flash'
        const overriddenTeammate = getHardcodedTeammateModelFallback()
        profiles.clearActiveProviderProfile()
        console.log(JSON.stringify({
          native, overriddenTeammate, restoredProvider: getAPIProvider(),
          restoredModel: getPrimaryModel(models.getDefaultMainLoopModelSetting()),
        }))
        process.exit(0)
      `], {
        cwd: resolve(import.meta.dir, '../../..'),
        env: {
          ...childEnv, OPENCLAUDE_CONFIG_DIR: configDir,
          CLAUDE_CONFIG_DIR: configDir, TEST_VERTEX_SELECTION: selection,
        },
      })
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      const output = JSON.parse(result.stdout.toString().trim().split('\n').at(-1)!)
      expect(output.native.provider).toBe('gemini-vertex')
      expect(output.native.display).not.toContain('undefined')
      for (const model of output.native.strings) {
        expect(typeof model).toBe('string')
        expect(model.length).toBeGreaterThan(0)
      }
      expect(output.native.main).toBe('gemini-2.5-flash')
      expect(output.native.teammate).toBe('gemini-2.5-pro')
      expect(output.overriddenTeammate).toBe('gemini-3.5-flash')
      expect(output.restoredProvider).toBe('firstParty')
      expect(output.restoredModel).toBe('claude-sonnet-4-6')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  },
)
