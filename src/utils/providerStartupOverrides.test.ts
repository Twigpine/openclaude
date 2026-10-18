import { describe, expect, mock, test } from 'bun:test'

async function importStartupOverridesForTest() {
  return import(
    `./providerStartupOverrides.ts?startupOverridesTest=${Date.now()}-${Math.random()}`
  )
}

describe('clearStartupProviderOverrides', () => {
  test('removes stale provider env from user settings and global config env', async () => {
    const { clearStartupProviderOverrides } = await importStartupOverridesForTest()
    const updateUserSettings = mock(() => ({ error: null }))
    const saveConfig = mock((updater: (current: {
      env: Record<string, string>
    }) => { env: Record<string, string> }) =>
      updater({
        env: {
          CLAUDE_CODE_USE_OPENAI: '1',
          OPENAI_BASE_URL: 'https://api.minimax.io/v1',
          OPENAI_MODEL: 'minimax-m2.7',
          OPENAI_API_KEYS: 'pool-a,pool-b',
          OPENAI_API_KEY: 'single-key',
          LLMTR_API_KEY: 'llmtr-key',
          CMD_API_KEY: 'cmd-key',
          MINIMAX_API_KEY: 'sk-minimax',
          VENICE_API_KEY: 'sk-venice',
          LONGCAT_API_KEY: 'sk-longcat',
          ANTHROPIC_AUTH_TOKEN: 'stale-proxy-token',
          KEEP_ME: '1',
        },
      }),
    )

    const error = clearStartupProviderOverrides({
      updateUserSettings,
      saveConfig: saveConfig as any,
    })

    expect(error).toBeNull()
    expect(updateUserSettings).toHaveBeenCalledWith(
      'userSettings',
      expect.objectContaining({
        env: expect.objectContaining({
          CLAUDE_CODE_USE_OPENAI: undefined,
          OPENAI_BASE_URL: undefined,
          OPENAI_MODEL: undefined,
          OPENAI_API_KEYS: undefined,
          OPENAI_API_KEY: undefined,
          LLMTR_API_KEY: undefined,
          CMD_API_KEY: undefined,
          MINIMAX_API_KEY: undefined,
          VENICE_API_KEY: undefined,
          LONGCAT_API_KEY: undefined,
          ANTHROPIC_AUTH_TOKEN: undefined,
        }),
      }),
    )
    expect(
      (saveConfig.mock.results[0]?.value as { env: Record<string, string> }).env,
    ).toEqual({ KEEP_ME: '1' })
  })
})
