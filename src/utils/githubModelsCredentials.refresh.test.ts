import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

// Module namespaces have live bindings: keep detached exports so a module mock
// cannot replace the implementations that cleanup needs to restore.
const nonce = `${Date.now()}-${Math.random()}`
const realDeviceFlow = {
  ...await import(`../services/github/deviceFlow.js?real=${nonce}`),
}
const realSecureStorage = {
  ...await import(`./secureStorage/index.js?real=${nonce}`),
}

async function importFreshModule() {
  mock.restore()
  return import(`./githubModelsCredentials.ts?ts=${Date.now()}-${Math.random()}`)
}

function getGithubTokenEnv(): string | undefined {
  return process.env.GITHUB_TOKEN
}

describe('refreshGithubModelsTokenIfNeeded', () => {
  const orig = {
    CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  }

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/githubModelsCredentials.refresh.test.ts')
    mock.restore()
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => realSecureStorage)
      mock.module('../services/github/deviceFlow.js', () => realDeviceFlow)
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) {
          delete process.env[k as keyof typeof orig]
        } else {
          process.env[k as keyof typeof orig] = v
        }
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('refreshes expired Copilot token using stored OAuth token', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    let store: Record<string, unknown> = {
      githubModels: {
        accessToken: 'tid=stale;exp=1;sku=free',
        oauthAccessToken: 'ghu_oauth_secret',
      },
    }

    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        read: () => store,
        update: (next: Record<string, unknown>) => {
          store = next
          return { success: true }
        },
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      ...realDeviceFlow,
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: async () => ({
        token: `tid=fresh;exp=${futureExp};sku=free`,
        expires_at: futureExp,
        refresh_in: 1500,
        endpoints: { api: 'https://api.githubcopilot.com' },
      }),
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded()
    expect(refreshed).toBe(true)
    expect(getGithubTokenEnv()?.startsWith('tid=fresh;exp=')).toBe(true)

    const githubModels = (store.githubModels ?? {}) as {
      accessToken?: string
      oauthAccessToken?: string
    }
    expect(githubModels.accessToken?.startsWith('tid=fresh;exp=')).toBe(true)
    expect(githubModels.oauthAccessToken).toBe('ghu_oauth_secret')
  })

  test('does not refresh when current Copilot token is valid', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.CLAUDE_CODE_SIMPLE
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN

    const futureExp = Math.floor(Date.now() / 1000) + 3600
    const exchangeSpy = mock(async () => ({
      token: `tid=unexpected;exp=${futureExp};sku=free`,
      expires_at: futureExp,
      refresh_in: 1500,
      endpoints: { api: 'https://api.githubcopilot.com' },
    }))

    mock.module('./secureStorage/index.js', () => ({
      ...realSecureStorage,
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: `tid=already-valid;exp=${futureExp};sku=free`,
            oauthAccessToken: 'ghu_oauth_secret',
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      ...realDeviceFlow,
      DEFAULT_GITHUB_DEVICE_SCOPE: 'read:user',
      exchangeForCopilotToken: exchangeSpy,
    }))

    const { refreshGithubModelsTokenIfNeeded } = await importFreshModule()

    const refreshed = await refreshGithubModelsTokenIfNeeded()
    expect(refreshed).toBe(false)
    expect(exchangeSpy).not.toHaveBeenCalled()
    expect(getGithubTokenEnv()?.startsWith('tid=already-valid;exp=')).toBe(
      true,
    )
  })
})

type GithubModelsCredentialsModule =
  typeof import('./githubModelsCredentials.js')

function importFreshGithubModelsCredentials(
  cacheKey: string,
): Promise<GithubModelsCredentialsModule> {
  return import(
    `./githubModelsCredentials.js?${cacheKey}`
  ) as Promise<GithubModelsCredentialsModule>
}

const STORED_OAUTH_TOKEN = 'gho_stored_oauth_token_xyz'
const STORED_COPILOT_TOKEN = 'stored-copilot-token-abc'
const FRESH_COPILOT_TOKEN = 'fresh-copilot-token-def'

describe('refreshCopilotTokenOn401', () => {
  const orig = {
    GITHUB_COPILOT_KEY: process.env.GITHUB_COPILOT_KEY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GITHUB_ENTERPRISE_URL: process.env.GITHUB_ENTERPRISE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    CLAUDE_CODE_SIMPLE: process.env.CLAUDE_CODE_SIMPLE,
  }

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/githubModelsCredentials.refresh.test.ts')
    // Clear early-exit guards so each test starts from a clean baseline
    // regardless of prior test failures or CI environment.
    delete process.env.GITHUB_COPILOT_KEY
    delete process.env.CLAUDE_CODE_SIMPLE
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('./secureStorage/index.js', () => realSecureStorage)
      mock.module('../services/github/deviceFlow.js', () => realDeviceFlow)
      for (const [k, v] of Object.entries(orig)) {
        if (v === undefined) {
          delete process.env[k as keyof typeof orig]
        } else {
          process.env[k as keyof typeof orig] = v
        }
      }
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('returns false in bare mode', async () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=bare-mode')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when GITHUB_COPILOT_KEY is set', async () => {
    process.env.GITHUB_COPILOT_KEY = 'direct-key'

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=direct-key-env')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when no stored credential blob exists', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => null,
      }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=no-blob')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when stored credential type is copilot_key', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            credentialType: 'copilot_key' as const,
          },
        }),
      }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=copilot-key-type')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when current credential does not match stored token', async () => {
    process.env.OPENAI_API_KEY = 'some-other-token'

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
      }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=cred-mismatch')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when current credential is empty', async () => {
    delete process.env.OPENAI_API_KEY

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
      }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=empty-cred')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when no OAuth token is stored', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
          },
        }),
      }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=no-oauth')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when exchange fails', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
        readAsync: () =>
          Promise.resolve({
            githubModels: {
              accessToken: STORED_COPILOT_TOKEN,
              oauthAccessToken: STORED_OAUTH_TOKEN,
            },
          }),
        update: () => ({ success: true }),
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: () =>
        Promise.reject(new Error('Exchange failed')),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=exchange-fail')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('returns false when save fails', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
        update: () => ({ success: false, warning: 'Storage full' }),
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: () =>
        Promise.resolve({ token: FRESH_COPILOT_TOKEN, expires_at: 9999999999, refresh_in: 1800, endpoints: { api: 'https://api.githubcopilot.com' } }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=save-fail')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(false)
  })

  test('successfully refreshes and updates env vars', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: () =>
        Promise.resolve({ token: FRESH_COPILOT_TOKEN, expires_at: 9999999999, refresh_in: 1800, endpoints: { api: 'https://api.githubcopilot.com' } }),
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=success')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(true)
    expect(process.env.GITHUB_TOKEN).toBe(FRESH_COPILOT_TOKEN)
    expect(process.env.OPENAI_API_KEY).toBe(FRESH_COPILOT_TOKEN)
  })

  test('supports GHE URL when GITHUB_ENTERPRISE_URL is set', async () => {
    process.env.OPENAI_API_KEY = STORED_COPILOT_TOKEN
    process.env.GITHUB_ENTERPRISE_URL = 'https://github.mycompany.com'

    let capturedGheUrl: string | undefined
    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: STORED_COPILOT_TOKEN,
            oauthAccessToken: STORED_OAUTH_TOKEN,
          },
        }),
        update: () => ({ success: true }),
      }),
    }))

    mock.module('../services/github/deviceFlow.js', () => ({
      exchangeForCopilotToken: (
        _token: string,
        _fetchImpl: unknown,
        gheUrl?: string,
      ) => {
        capturedGheUrl = gheUrl
        return Promise.resolve({ token: FRESH_COPILOT_TOKEN, expires_at: 9999999999, refresh_in: 1800, endpoints: { api: 'https://github.mycompany.com/api/copilot' } })
      },
    }))

    const { refreshCopilotTokenOn401 } =
      await importFreshGithubModelsCredentials('refresh=ghe')
    const result = await refreshCopilotTokenOn401()
    expect(result).toBe(true)
    expect(capturedGheUrl).toBe('https://github.mycompany.com')
  })
})
