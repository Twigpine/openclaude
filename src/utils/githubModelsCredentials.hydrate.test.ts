/**
 * Hydrate tests live in a separate file with no static import of
 * githubModelsCredentials so Bun's mock.module can replace secureStorage
 * before that module is first loaded.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { snapshotEnv } from '../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

const nonce = `${Date.now()}-${Math.random()}`
const realSecureStorage = {
  ...await import(`./secureStorage/index.js?real=${nonce}`),
}

afterAll(() => {
  mock.module('./secureStorage/index.js', () => realSecureStorage)
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

function getEnvValue(name: string): string | undefined {
  return process.env[name]
}

describe('hydrateGithubModelsTokenFromSecureStorage', () => {
  let restoreEnv: () => void = () => {}

  beforeEach(async () => {
    await acquireSharedMutationLock('utils/githubModelsCredentials.hydrate.test.ts')
    restoreEnv = snapshotEnv([
      'CLAUDE_CODE_USE_GITHUB',
      'GITHUB_COPILOT_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
      'CLAUDE_CODE_SIMPLE',
    ])
  })

  afterEach(() => {
    try {
      mock.restore()
      restoreEnv()
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('sets GITHUB_TOKEN from secure storage when USE_GITHUB and env token empty', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=sets-token')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_TOKEN')).toBe('stored-secret')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBe('1')
  })

  test('sets GITHUB_COPILOT_KEY when secure storage contains a direct Copilot key', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'shell-token'
    delete process.env.GITHUB_COPILOT_KEY
    delete process.env.GH_TOKEN
    delete process.env.CLAUDE_CODE_SIMPLE

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: {
            accessToken: 'stored-enterprise-key',
            credentialType: 'copilot_key',
          },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=sets-copilot-key')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_COPILOT_KEY')).toBe('stored-enterprise-key')
    expect(getEnvValue('GITHUB_TOKEN')).toBe('shell-token')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBe('1')
  })

  test('does not override existing GITHUB_TOKEN', async () => {
    process.env.CLAUDE_CODE_USE_GITHUB = '1'
    process.env.GITHUB_TOKEN = 'already'
    delete process.env.CLAUDE_CODE_GITHUB_TOKEN_HYDRATED

    mock.module('./secureStorage/index.js', () => ({
      getSecureStorage: () => ({
        read: () => ({
          githubModels: { accessToken: 'stored-secret' },
        }),
      }),
    }))

    const { hydrateGithubModelsTokenFromSecureStorage } =
      await importFreshGithubModelsCredentials('hydrate=preserve-existing')
    hydrateGithubModelsTokenFromSecureStorage()
    expect(getEnvValue('GITHUB_TOKEN')).toBe('already')
    expect(getEnvValue('CLAUDE_CODE_GITHUB_TOKEN_HYDRATED')).toBeUndefined()
  })
})
