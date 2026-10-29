import { clearManagedProfileEnv } from '../src/utils/providerProfile.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureSync } from "./subprocess.ts"
import { describe, expect, test } from 'bun:test'
import {
  runProcess,
  getOpenAILaunchCredentialError,
  hasUsableOpenAILaunchCredential,
} from './provider-launch.ts'

describe('provider-launch OpenAI credential validation', () => {
  test('accepts valid OPENAI_API_KEYS before placeholder OPENAI_API_KEY fallback', () => {
    expect(
      hasUsableOpenAILaunchCredential({
        OPENAI_API_KEYS: 'sk-openai-a,sk-openai-b',
        OPENAI_API_KEY: 'SUA_CHAVE',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  test('rejects placeholder OPENAI_API_KEYS before singular fallback', () => {
    expect(
      hasUsableOpenAILaunchCredential({
        OPENAI_API_KEYS: 'sk-openai-a,SUA_CHAVE',
        OPENAI_API_KEY: 'sk-openai-single',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  test('accepts a dedicated Command Code credential on its selected route', () => {
    expect(
      hasUsableOpenAILaunchCredential({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        CMD_API_KEY: 'cmd-key',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  test('accepts the Command Code fallback credential on its selected route', () => {
    expect(
      hasUsableOpenAILaunchCredential({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        COMMANDCODE_API_KEY: 'fallback-key',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
  })

  test('rejects a generic credential for the dedicated-only Command Code route', () => {
    expect(
      hasUsableOpenAILaunchCredential({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
        OPENAI_API_KEY: 'generic-key',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
  })

  test.each([
    'CMD_API_KEY',
    'COMMANDCODE_API_KEY',
    'COMMAND_CODE_API_KEY',
  ] as const)(
    'rejects a placeholder %s on the selected Command Code route',
    credentialEnvVar => {
      expect(
        hasUsableOpenAILaunchCredential({
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
          [credentialEnvVar]: 'SUA_CHAVE',
        } as NodeJS.ProcessEnv),
      ).toBe(false)
    },
  )

  test('reports Command Code credential guidance for its selected route', () => {
    expect(
      getOpenAILaunchCredentialError({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.commandcode.ai/provider/v1',
      } as NodeJS.ProcessEnv),
    ).toBe(
      'CMD_API_KEY is required for the Command Code route (fallbacks: COMMANDCODE_API_KEY or COMMAND_CODE_API_KEY) and cannot include placeholder values such as SUA_CHAVE. Set one of those environment variables, rerun the launcher, then use /provider to save the Command Code profile.',
    )
  })

  test('preserves generic OpenAI credential guidance outside Command Code', () => {
    expect(
      getOpenAILaunchCredentialError({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
      } as NodeJS.ProcessEnv),
    ).toBe(
      'OPENAI_API_KEYS or OPENAI_API_KEY is required for openai profile and cannot include SUA_CHAVE. Run: bun run profile:init -- --provider openai --api-key <key>',
    )
  })
})

describe('development process launches', () => {
  test('propagates nonzero exits and launch failures', async () => {
    expect(await runProcess(process.execPath, ['-e', 'process.exit(7)'], process.env)).toBe(7)
    expect(await runProcess('missing-development-command-l2', [], process.env)).toBe(1)
  })

  test('passes arguments, environment, and cwd literally', async () => {
    const literal = 'space ; $value & "quoted"'
    const code = await runProcess(process.execPath, ['-e', `
      process.exit(process.argv[1] === process.env.LAUNCH_LITERAL && process.cwd() === process.env.LAUNCH_CWD ? 0 : 9)
    `, literal], { ...process.env, LAUNCH_LITERAL: literal, LAUNCH_CWD: process.cwd() })
    expect(code).toBe(0)
  })

  test.skipIf(process.platform === 'win32')('maps a signaled child to the existing failure status', async () => {
    expect(await runProcess(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"], process.env)).toBe(1)
  })

  test('inherits both output streams', () => {
    const result = captureSync(process.execPath, ['-e', `
      const { runProcess } = await import(${JSON.stringify(import.meta.dir + '/provider-launch.ts')})
      process.exit(await runProcess(process.execPath, ['-e', "process.stdout.write('output'); process.stderr.write('diagnostic'); process.exit(7)"], process.env))
    `], { timeout: 3000 })
    expect(result.status).toBe(7)
    expect(result.stdout).toBe('output')
    expect(result.stderr).toBe('diagnostic')
  }, 5000)
})

// Exercise main and profile resolution; simulate only the external doctor/build/CLI.
test('auto-profile launches preserve CLI arguments after the passthrough boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'provider-launch-'))
  try {
    const childEnv = { ...process.env }
    clearManagedProfileEnv(childEnv)
    writeFileSync(join(directory, '.openclaude-profile.json'), JSON.stringify({
      profile: 'openai', env: { OPENAI_API_KEY: 'test-launch-key' },
    }))
    const preload = join(directory, 'capture.ts')
    writeFileSync(preload, `process.argv = [process.execPath, 'provider-launch.ts', ...JSON.parse(process.env.LAUNCH_ARGS)]
    Bun.spawn = (argv) => {
      if (argv[0] === 'node') console.log('CLI_ARGS=' + JSON.stringify(argv.slice(2)))
      return { exited: Promise.resolve(0), exitCode: 0, signalCode: null }
    }`)
    for (const [args, expected] of [
      [['--version'], ['--version']],
      [['fix tests', '--fast', 'ollama'], ['fix tests', '--fast', 'ollama']],
      [['--model', 'ollama', '--goal', 'coding'], ['--model', 'ollama', '--goal', 'coding']],
      [['-p', 'fix tests'], ['-p', 'fix tests']],
      [['--', 'openai', '--fast'], ['openai', '--fast']],
      [['openai', '--fast', '--goal', 'coding', '-p', 'fix tests'], ['-p', 'fix tests']],
    ]) {
      const result = captureSync(process.execPath, ['--preload', preload,
        join(import.meta.dir, 'provider-launch.ts'), ...args!], {
        cwd: directory,
        env: { ...childEnv, OPENCLAUDE_CONFIG_DIR: directory, LAUNCH_ARGS: JSON.stringify(args) },
        timeout: 5000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Launching profile: openai')
      expect(result.stdout).toContain('CLI_ARGS=' + JSON.stringify(expected))
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 35000) // Six children have five-second deadlines plus cleanup time.
