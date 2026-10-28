import { describe, expect, spyOn, test } from 'bun:test'
import { snapshotEnv } from '../src/test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../src/test/sharedMutationLock.js'
import { getOpenAIConfigurationState, main } from './provider-recommend.ts'

function envWithOpenAI(
  patch: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...patch }
  for (const key of ['OPENAI_API_KEYS', 'OPENAI_API_KEY']) {
    if (patch[key] === undefined) {
      delete env[key]
    }
  }
  return env
}

describe('provider-recommend OpenAI credential detection', () => {
  test('detects valid pooled OpenAI credentials', () => {
    expect(
      getOpenAIConfigurationState(
        envWithOpenAI({
          OPENAI_API_KEYS: 'key-a,key-b',
          OPENAI_API_KEY: undefined,
        }),
      ),
    ).toEqual({ configured: true, invalid: false })
  })

  test('ignores placeholder OPENAI_API_KEY when OPENAI_API_KEYS is usable', () => {
    expect(
      getOpenAIConfigurationState(
        envWithOpenAI({
          OPENAI_API_KEYS: 'key-a,key-b',
          OPENAI_API_KEY: 'SUA_CHAVE',
        }),
      ),
    ).toEqual({ configured: true, invalid: false })
  })

  test('distinguishes placeholder pools from unset credentials', () => {
    expect(
      getOpenAIConfigurationState(
        envWithOpenAI({
          OPENAI_API_KEYS: 'key-a,SUA_CHAVE',
          OPENAI_API_KEY: undefined,
        }),
      ),
    ).toEqual({ configured: false, invalid: true })

    expect(
      getOpenAIConfigurationState(
        envWithOpenAI({
          OPENAI_API_KEYS: undefined,
          OPENAI_API_KEY: undefined,
        }),
      ),
    ).toEqual({ configured: false, invalid: false })
  })

  test('profile:recommend openai path runs with pooled credentials', async () => {
    await acquireSharedMutationLock('scripts/provider-recommend.test.ts')
    const restoreEnv = snapshotEnv(['OPENAI_API_KEYS', 'OPENAI_API_KEY', 'NO_COLOR'])
    const originalArgv = process.argv
    const stdout = spyOn(console, 'log').mockImplementation(() => {})
    const stderr = spyOn(console, 'error').mockImplementation(() => {})
    const exit = spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`Unexpected process.exit(${code})`)
    })
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('Explicit OpenAI recommendations must not use discovery')
    })

    try {
      process.env.OPENAI_API_KEYS = 'key-a,key-b'
      delete process.env.OPENAI_API_KEY
      process.env.NO_COLOR = '1'
      process.argv = [
        process.execPath,
        'scripts/provider-recommend.ts',
        '--provider',
        'openai',
        '--json',
      ]

      // Exercise the real CLI path without racing child startup and cold imports.
      await expect(main()).resolves.toBeUndefined()
      expect(stderr).not.toHaveBeenCalled()
      expect(exit).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(stdout).toHaveBeenCalledTimes(1)
      expect(JSON.parse(stdout.mock.calls[0]![0]).openAIConfigured).toBe(true)
    } finally {
      fetch.mockRestore()
      exit.mockRestore()
      stderr.mockRestore()
      stdout.mockRestore()
      process.argv = originalArgv
      restoreEnv()
      releaseSharedMutationLock()
    }
  })
})
