/**
 * These tests avoid static imports so Bun can mock secureStorage before
 * codexCredentials is first loaded.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

// mock.restore() does not undo mock.module(), so put the real storage modules
// back once this file is done. Otherwise a later file in the same process
// (e.g. src/entrypoints/sdk/mcpNeedsAuth.test.ts) reads the stubs below.
const nonce = `${Date.now()}-${Math.random()}`
const realPlainTextStorage = {
  ...await import(`./secureStorage/plainTextStorage.js?real=${nonce}`),
}
const realSecureStorage = {
  ...await import(`./secureStorage/index.js?real=${nonce}`),
}

afterAll(() => {
  mock.module('./secureStorage/plainTextStorage.js', () => realPlainTextStorage)
  mock.module('./secureStorage/index.js', () => realSecureStorage)
})

type CodexCredentialsModule = typeof import('./codexCredentials.js')

function importFreshCodexCredentials(
  cacheKey: string,
): Promise<CodexCredentialsModule> {
  return import(
    `./codexCredentials.js?${cacheKey}`
  ) as Promise<CodexCredentialsModule>
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.signature`
}

describe('codexCredentials', () => {
  const originalSimple = process.env.CLAUDE_CODE_SIMPLE
  const originalCodeKey = process.env.CODEX_API_KEY
  const originalFetch = globalThis.fetch
  let mockedPlainTextStorageState: Record<string, unknown> | null = null
  let mockedPlainTextStorageUpdateResult: {
    success: boolean
    warning?: string
  } = {
    success: true,
    warning: 'Warning: Storing credentials in plaintext.',
  }
  let mockedPlainTextStorageDeleteResult = true
  let mockedPlainTextStorageUpdates: Record<string, unknown>[] = []

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/codexCredentials.test.ts')
    mockedPlainTextStorageState = null
    mockedPlainTextStorageUpdateResult = {
      success: true,
      warning: 'Warning: Storing credentials in plaintext.',
    }
    mockedPlainTextStorageDeleteResult = true
    mockedPlainTextStorageUpdates = []

    mock.module('./secureStorage/plainTextStorage.js', () => ({
      plainTextStorage: {
        read: () => mockedPlainTextStorageState,
        readAsync: async () => mockedPlainTextStorageState,
        update: (next: Record<string, unknown>) => {
          mockedPlainTextStorageUpdates.push(next)
          if (mockedPlainTextStorageUpdateResult.success) {
            mockedPlainTextStorageState = next
          }
          return mockedPlainTextStorageUpdateResult
        },
        delete: () => {
          if (mockedPlainTextStorageDeleteResult) {
            mockedPlainTextStorageState = null
          }
          return mockedPlainTextStorageDeleteResult
        },
      },
    }))
  })

  afterEach(() => {
    try {
      mock.restore()
      globalThis.fetch = originalFetch

      if (originalSimple === undefined) {
        delete process.env.CLAUDE_CODE_SIMPLE
      } else {
        process.env.CLAUDE_CODE_SIMPLE = originalSimple
      }

      if (originalCodeKey === undefined) {
        delete process.env.CODEX_API_KEY
      } else {
        process.env.CODEX_API_KEY = originalCodeKey
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('save returns failure in bare mode', async () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'

    const { saveCodexCredentials } =
      await importFreshCodexCredentials('save-bare-mode')

    const result = saveCodexCredentials({
      accessToken: 'token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toContain('Bare mode')
  })

  test('saveCodexCredentials allows plaintext fallback when native secure storage is unavailable', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let nativeStorageState: Record<string, unknown> | null = null
    const getSecureStorage = mock(
      (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: () => ({
            success: false,
            warning:
              'Secure storage is unavailable on this platform without plaintext fallback.',
          }),
          delete: () => true,
        }
      },
    )

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage,
    }))

    const { readCodexCredentials, saveCodexCredentials } =
      await importFreshCodexCredentials('save-plaintext-fallback')

    const result = saveCodexCredentials({
      accessToken: 'fallback-access-token',
      refreshToken: 'fallback-refresh-token',
      accountId: 'acct_123',
    })

    expect(getSecureStorage).toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.warning).toBe('Warning: Storing credentials in plaintext.')
    expect(readCodexCredentials()).toMatchObject({
      accessToken: 'fallback-access-token',
      refreshToken: 'fallback-refresh-token',
      accountId: 'acct_123',
    })
  })

  test('saveCodexCredentials keeps plaintext fallback scoped to Codex credentials', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const nativeStorageState: Record<string, unknown> = {
      mcpOAuth: {
        server: {
          serverName: 'Server',
          serverUrl: 'https://example.test',
          accessToken: 'native-mcp-access-token',
          refreshToken: 'native-mcp-refresh-token',
          expiresAt: Date.now() + 60_000,
          clientSecret: 'native-mcp-client-secret',
        },
      },
      trustedDeviceToken: 'native-trusted-device-token',
      pluginSecrets: {
        plugin: {
          secret: 'native-plugin-secret',
        },
      },
    }
    mockedPlainTextStorageState = {
      pluginSecrets: {
        alreadyPlaintext: {
          secret: 'existing-plaintext-secret',
        },
      },
    }
    let attemptedNativeWrite: Record<string, unknown> | undefined

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: (next: Record<string, unknown>) => {
            attemptedNativeWrite = next
            return { success: false, warning: 'native write failed' }
          },
          delete: () => true,
        }
      },
    }))

    const { saveCodexCredentials } =
      await importFreshCodexCredentials('save-scoped-plaintext-fallback')

    const result = saveCodexCredentials({
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(true)
    expect(result.warning).toBe('Warning: Storing credentials in plaintext.')
    expect(attemptedNativeWrite?.mcpOAuth).toBe(nativeStorageState.mcpOAuth)
    expect(mockedPlainTextStorageState?.codex).toMatchObject({
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'acct_123',
    })
    expect(mockedPlainTextStorageState?.pluginSecrets).toEqual({
      alreadyPlaintext: {
        secret: 'existing-plaintext-secret',
      },
    })
    expect(mockedPlainTextStorageState).not.toHaveProperty('mcpOAuth')
    expect(mockedPlainTextStorageState).not.toHaveProperty('trustedDeviceToken')
  })

  test('saveCodexCredentials fails closed when native Codex would shadow scoped fallback', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const nativeStorageState: Record<string, unknown> = {
      codex: {
        accessToken: 'native-codex-access-token',
        refreshToken: 'native-codex-refresh-token',
        accountId: 'acct_old',
      },
      mcpOAuth: {
        server: {
          serverName: 'Server',
          serverUrl: 'https://example.test',
          accessToken: 'native-mcp-access-token',
          expiresAt: Date.now() + 60_000,
          clientSecret: 'native-mcp-client-secret',
        },
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: () => ({ success: false, warning: 'native write failed' }),
          delete: () => true,
        }
      },
    }))

    const { saveCodexCredentials } = await importFreshCodexCredentials(
      'save-fail-closed-shadowed-fallback',
    )

    const result = saveCodexCredentials({
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toBe('native write failed')
    expect(mockedPlainTextStorageUpdates).toHaveLength(0)
    expect(mockedPlainTextStorageState).toBeNull()
  })

  test('saveCodexCredentials fails when stale native Codex cannot be removed after fallback write', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const nativeStorageState: Record<string, unknown> = {
      codex: {
        accessToken: 'native-codex-access-token',
        refreshToken: 'native-codex-refresh-token',
        accountId: 'acct_old',
      },
    }
    let nativeDeleteAttempts = 0

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: () => ({ success: false, warning: 'native write failed' }),
          delete: () => {
            nativeDeleteAttempts += 1
            return false
          },
        }
      },
    }))

    const { readCodexCredentials, saveCodexCredentials } =
      await importFreshCodexCredentials('save-fail-closed-stale-native-delete')

    const result = saveCodexCredentials({
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toBe(
      'Codex credentials were written to plaintext fallback, but stale native secure storage could not be removed.',
    )
    expect(nativeDeleteAttempts).toBe(1)
    expect(mockedPlainTextStorageState?.codex).toMatchObject({
      accessToken: 'codex-access-token',
      refreshToken: 'codex-refresh-token',
      accountId: 'acct_123',
    })
    expect(readCodexCredentials()?.accessToken).toBe(
      'native-codex-access-token',
    )
  })

  test('saveCodexCredentials warns when native save succeeds but plaintext fallback cleanup fails', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let nativeStorageState: Record<string, unknown> | null = null
    mockedPlainTextStorageState = {
      codex: {
        accessToken: 'plaintext-codex-access-token',
        refreshToken: 'plaintext-codex-refresh-token',
        accountId: 'acct_plaintext',
      },
    }
    mockedPlainTextStorageDeleteResult = false

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: (next: Record<string, unknown>) => {
            nativeStorageState = next
            return { success: true }
          },
          delete: () => true,
        }
      },
    }))

    const { readCodexCredentials, saveCodexCredentials } =
      await importFreshCodexCredentials(
        'save-native-success-plaintext-cleanup-fails',
      )

    const result = saveCodexCredentials({
      accessToken: 'native-codex-access-token',
      refreshToken: 'native-codex-refresh-token',
      accountId: 'acct_native',
    })

    expect(result.success).toBe(true)
    expect(result.warning).toBe(
      'Codex credentials were saved, but stale plaintext fallback credentials could not be removed.',
    )
    expect(readCodexCredentials()?.accessToken).toBe(
      'native-codex-access-token',
    )
    expect(mockedPlainTextStorageState?.codex).toMatchObject({
      accessToken: 'plaintext-codex-access-token',
    })
  })

  test('saveCodexCredentials rejects incomplete credential blobs', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const getSecureStorage = mock(() => ({
      read: () => null,
      readAsync: async () => null,
      update: () => ({ success: true }),
      delete: () => true,
    }))

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage,
    }))

    const { saveCodexCredentials } =
      await importFreshCodexCredentials('save-incomplete')

    const result = saveCodexCredentials({
      accessToken: '',
      refreshToken: 'fallback-refresh-token',
      accountId: 'acct_123',
    })

    expect(result.success).toBe(false)
    expect(result.warning).toBe('Codex credentials are incomplete.')
    expect(getSecureStorage).not.toHaveBeenCalled()
  })

  test('refreshCodexAccessTokenIfNeeded refreshes expired stored credentials', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = mock(
      async (_input, init) => {
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : ''

        if (
          bodyText.includes('grant_type=refresh_token') ||
          bodyText.includes('"grant_type":"refresh_token"')
        ) {
          return new Response(
            JSON.stringify({
              access_token: freshAccessToken,
              refresh_token: 'refresh-new',
              id_token: freshIdToken,
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        return new Response(
          JSON.stringify({
            access_token: 'codex-api-key-token',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        )
      },
    ) as unknown as typeof fetch

    const { refreshCodexAccessTokenIfNeeded, readCodexCredentials } =
      await importFreshCodexCredentials('refresh-success')

    const result = await refreshCodexAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)

    const stored = readCodexCredentials()
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBe('codex-api-key-token')
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshCodexAccessTokenIfNeeded backs off after a failed refresh attempt', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let refreshAttempts = 0
    globalThis.fetch = mock(async () => {
      refreshAttempts += 1
      return new Response(
        JSON.stringify({
          error: {
            code: 'invalid_grant',
            message: 'refresh token expired',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshCodexAccessTokenIfNeeded, readCodexCredentials } =
      await importFreshCodexCredentials('refresh-cooldown')

    await expect(refreshCodexAccessTokenIfNeeded()).rejects.toThrow(
      'Codex token refresh failed (invalid_grant): refresh token expired',
    )

    const afterFailure = readCodexCredentials()
    expect(typeof afterFailure?.lastRefreshFailureAt).toBe('number')

    const secondAttempt = await refreshCodexAccessTokenIfNeeded()
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })

  test('refreshCodexAccessTokenIfNeeded drops a stale api key when id-token exchange fails', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      codex: {
        apiKey: 'stale-api-key',
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    globalThis.fetch = mock(
      async (_input, init) => {
        const bodyText =
          typeof init?.body === 'string'
            ? init.body
            : init?.body instanceof URLSearchParams
              ? init.body.toString()
              : ''

        if (bodyText.includes('grant_type=refresh_token')) {
          return new Response(
            JSON.stringify({
              access_token: freshAccessToken,
              refresh_token: 'refresh-new',
              id_token: freshIdToken,
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json',
              },
            },
          )
        }

        return new Response('exchange failed', {
          status: 500,
        })
      },
    ) as unknown as typeof fetch

    const { refreshCodexAccessTokenIfNeeded, readCodexCredentials } =
      await importFreshCodexCredentials('refresh-drop-stale-api-key')

    const result = await refreshCodexAccessTokenIfNeeded()
    expect(result.refreshed).toBe(true)

    const stored = readCodexCredentials()
    expect(stored?.accessToken).toBe(freshAccessToken)
    expect(stored?.apiKey).toBeUndefined()
    expect(stored?.refreshToken).toBe('refresh-new')
    expect(stored?.accountId).toBe('acct_new')
  })

  test('refreshCodexAccessTokenIfNeeded deduplicates concurrent refresh attempts', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })
    const freshAccessToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_new',
    })
    const freshIdToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_new',
      },
    })

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    let refreshAttempts = 0
    let releaseRefresh: (() => void) | undefined
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve
    })

    globalThis.fetch = mock(async (_input, init) => {
      const bodyText =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : ''

      if (bodyText.includes('grant_type=refresh_token')) {
        refreshAttempts += 1
        await refreshGate
        return new Response(
          JSON.stringify({
            access_token: freshAccessToken,
            refresh_token: 'refresh-new',
            id_token: freshIdToken,
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          },
        )
      }

      return new Response(
        JSON.stringify({
          access_token: 'codex-api-key-token',
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshCodexAccessTokenIfNeeded } =
      await importFreshCodexCredentials('refresh-dedupe')

    const firstRefresh = refreshCodexAccessTokenIfNeeded()
    const secondRefresh = refreshCodexAccessTokenIfNeeded()
    releaseRefresh?.()

    const [firstResult, secondResult] = await Promise.all([
      firstRefresh,
      secondRefresh,
    ])

    expect(refreshAttempts).toBe(1)
    expect(firstResult).toEqual(secondResult)
    expect(firstResult.refreshed).toBe(true)
    expect(firstResult.credentials?.accessToken).toBe(freshAccessToken)
  })

  test('saveCodexCredentials preserves an existing linked profile id', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
        profileId: 'profile_codex_oauth',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const { readCodexCredentials, saveCodexCredentials } =
      await importFreshCodexCredentials('preserve-profile-id')

    const saved = saveCodexCredentials({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
      accountId: 'acct_new',
    })

    expect(saved.success).toBe(true)
    expect(readCodexCredentials()?.profileId).toBe('profile_codex_oauth')
  })

  test('attachCodexProfileIdToStoredCredentials links the saved profile id', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const {
      attachCodexProfileIdToStoredCredentials,
      readCodexCredentials,
    } = await importFreshCodexCredentials('attach-profile-id')

    const result =
      attachCodexProfileIdToStoredCredentials('profile_codex_oauth')

    expect(result.success).toBe(true)
    expect(readCodexCredentials()?.profileId).toBe('profile_codex_oauth')
  })

  test('clearCodexCredentials does not copy unrelated native secrets to plaintext when native update fails', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE

    const nativeStorageState: Record<string, unknown> = {
      codex: {
        accessToken: 'access-old',
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
      mcpOAuth: {
        server: {
          serverName: 'Server',
          serverUrl: 'https://example.test',
          accessToken: 'native-mcp-access-token',
          expiresAt: Date.now() + 60_000,
          clientSecret: 'native-mcp-client-secret',
        },
      },
      trustedDeviceToken: 'native-trusted-device-token',
    }
    mockedPlainTextStorageState = null

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: (options?: { allowPlainTextFallback?: boolean }) => {
        expect(options?.allowPlainTextFallback).toBe(false)
        return {
          read: () => nativeStorageState,
          readAsync: async () => nativeStorageState,
          update: () => ({ success: false, warning: 'native write failed' }),
          delete: () => true,
        }
      },
    }))

    const { clearCodexCredentials } =
      await importFreshCodexCredentials('clear-scoped-plaintext-fallback')

    const result = clearCodexCredentials()

    expect(result.success).toBe(false)
    expect(result.warning).toBe('native write failed')
    expect(mockedPlainTextStorageUpdates).toHaveLength(0)
    expect(mockedPlainTextStorageState).toBeNull()
  })

  test('refreshCodexAccessTokenIfNeeded uses async secure-storage reads in its request path', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY

    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3_600_000) / 1000),
      chatgpt_account_id: 'acct_async',
    })

    let storageState: Record<string, unknown> = {
      codex: {
        accessToken: freshToken,
        refreshToken: 'refresh-async',
        accountId: 'acct_async',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => {
          throw new Error(
            'sync storage read should not run during refresh checks',
          )
        },
        readAsync: async () => storageState,
        update: (next: Record<string, unknown>) => {
          storageState = next
          return { success: true }
        },
      }),
    }))

    const { refreshCodexAccessTokenIfNeeded } =
      await importFreshCodexCredentials('refresh-async-read')

    const result = await refreshCodexAccessTokenIfNeeded()
    expect(result.refreshed).toBe(false)
    expect(result.credentials?.accessToken).toBe(freshToken)
  })

  test('refreshCodexAccessTokenIfNeeded keeps a cooldown in memory when secure storage cannot persist it', async () => {
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.CODEX_API_KEY
    mockedPlainTextStorageUpdateResult = { success: false }

    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      chatgpt_account_id: 'acct_old',
    })

    const storageState: Record<string, unknown> = {
      codex: {
        accessToken: expiredToken,
        refreshToken: 'refresh-old',
        accountId: 'acct_old',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => storageState,
        readAsync: async () => storageState,
        update: () => ({
          success: false,
          warning: 'secure storage unavailable',
        }),
      }),
    }))

    let refreshAttempts = 0
    globalThis.fetch = mock(async () => {
      refreshAttempts += 1
      return new Response(
        JSON.stringify({
          error: {
            code: 'invalid_grant',
            message: 'refresh token expired',
          },
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
          },
        },
      )
    }) as unknown as typeof fetch

    const { refreshCodexAccessTokenIfNeeded } =
      await importFreshCodexCredentials('refresh-memory-cooldown')

    await expect(refreshCodexAccessTokenIfNeeded()).rejects.toThrow(
      'Codex token refresh failed (invalid_grant): refresh token expired',
    )

    const secondAttempt = await refreshCodexAccessTokenIfNeeded()
    expect(secondAttempt.refreshed).toBe(false)
    expect(secondAttempt.credentials?.accessToken).toBe(expiredToken)
    expect(refreshAttempts).toBe(1)
  })
})
