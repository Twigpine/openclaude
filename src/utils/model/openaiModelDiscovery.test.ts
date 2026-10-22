import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import axios from 'axios'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

const providerSpecifier = './providers.js'
const realProvidersForCleanup = {
  ...await import(
    `${providerSpecifier}?real=${Date.now()}-${Math.random()}`
  ),
}

afterAll(() => {
  mock.restore()
  mock.module(providerSpecifier, () => realProvidersForCleanup)
})

const originalAxiosGet = axios.get
const originalEnv = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_API_KEYS: process.env.OPENAI_API_KEYS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function clearCompetingProviderEnv(): void {
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'CHATGPT_ACCOUNT_ID',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_GITHUB',
    'CLAUDE_CODE_USE_MISTRAL',
    'CLAUDE_CODE_USE_VERTEX',
    'CODEX_ACCOUNT_ID',
    'CODEX_API_KEY',
    'CODEX_CREDENTIAL_SOURCE',
    'GEMINI_API_KEY',
    'GITHUB_COPILOT_KEY',
    'GITHUB_ENTERPRISE_URL',
    'MIMO_API_KEY',
    'MINIMAX_API_KEY',
    'MISTRAL_API_KEY',
    'NVIDIA_API_KEY',
    'NVIDIA_NIM',
    'OPENAI_API_BASE',
    'OPENAI_API_FORMAT',
    'OPENAI_AUTH_HEADER',
    'OPENAI_AUTH_HEADER_VALUE',
    'OPENAI_AUTH_SCHEME',
    'XAI_API_KEY',
    'XAI_CREDENTIAL_SOURCE',
  ]) {
    delete process.env[key]
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/model/openaiModelDiscovery.test.ts')
  mock.restore()
  mock.module('./providers.js', () => ({ getAPIProvider: () => 'openai' }))
  clearCompetingProviderEnv()
})

afterEach(() => {
  try {
    mock.restore()
    axios.get = originalAxiosGet
    restoreEnv(
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      originalEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    )
    restoreEnv('CLAUDE_CODE_USE_OPENAI', originalEnv.CLAUDE_CODE_USE_OPENAI)
    restoreEnv('OPENAI_BASE_URL', originalEnv.OPENAI_BASE_URL)
    restoreEnv('OPENAI_API_KEY', originalEnv.OPENAI_API_KEY)
    restoreEnv('OPENAI_API_KEYS', originalEnv.OPENAI_API_KEYS)
    restoreEnv('OPENAI_MODEL', originalEnv.OPENAI_MODEL)
  } finally {
    releaseSharedMutationLock()
  }
})

test('skips legacy OpenAI-compatible model discovery when nonessential traffic is disabled', async () => {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:1234/v1'
  process.env.OPENAI_MODEL = 'local-model'

  const getSpy = mock(async () => {
    throw new Error('unexpected legacy model discovery request')
  })
  axios.get = getSpy as typeof axios.get

  const { discoverOpenAICompatibleModelOptions } = await import(
    `./openaiModelDiscovery.js?privacy=${Date.now()}-${Math.random()}`
  )

  await expect(discoverOpenAICompatibleModelOptions()).resolves.toEqual([])
  expect(getSpy).not.toHaveBeenCalled()
})

test('legacy OpenAI-compatible model discovery falls back to singular key for unusable pooled credentials', async () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://custom.example/v1'
  process.env.OPENAI_API_KEYS = 'sk-openai-a,SUA_CHAVE'
  process.env.OPENAI_API_KEY = 'sk-openai-single'
  process.env.OPENAI_MODEL = 'gpt-5.5'

  const getSpy = mock(async (_url: string, options?: { headers?: Record<string, string> }) => {
    expect(options?.headers).toEqual({ Authorization: 'Bearer sk-openai-single' })
    return {
      data: {
        data: [{ id: 'gpt-5.5' }],
      },
    }
  })
  axios.get = getSpy as typeof axios.get

  const { discoverOpenAICompatibleModelOptions } = await import(
    `./openaiModelDiscovery.js?invalid-pooled=${Date.now()}-${Math.random()}`
  )

  await expect(discoverOpenAICompatibleModelOptions()).resolves.toEqual([
    {
      description: 'Discovered from OpenAI-compatible endpoint',
      label: 'gpt-5.5',
      value: 'gpt-5.5',
    },
  ])
})

test('legacy OpenAI-compatible model discovery uses the first pooled credential', async () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://custom.example/v1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  delete process.env.OPENAI_API_KEY
  process.env.OPENAI_MODEL = 'gpt-5.5'

  const getSpy = mock(async (_url: string, options?: { headers?: Record<string, string> }) => {
    expect(options?.headers).toEqual({ Authorization: 'Bearer key-a' })
    return {
      data: {
        data: [{ id: 'gpt-5.5' }],
      },
    }
  })
  axios.get = getSpy as typeof axios.get

  const { discoverOpenAICompatibleModelOptions } = await import(
    `./openaiModelDiscovery.js?pooled=${Date.now()}-${Math.random()}`
  )

  await expect(discoverOpenAICompatibleModelOptions()).resolves.toEqual([
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      description: 'Discovered from OpenAI-compatible endpoint',
    },
  ])
  expect(getSpy).toHaveBeenCalled()
})

test('legacy OpenAI-compatible model discovery ignores placeholder singular key when pool is usable', async () => {
  delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://custom.example/v1'
  process.env.OPENAI_API_KEYS = 'key-a,key-b'
  process.env.OPENAI_API_KEY = 'SUA_CHAVE'
  process.env.OPENAI_MODEL = 'gpt-5.5'

  const getSpy = mock(async (_url: string, options?: { headers?: Record<string, string> }) => {
    expect(options?.headers).toEqual({ Authorization: 'Bearer key-a' })
    return {
      data: {
        data: [{ id: 'gpt-5.5' }],
      },
    }
  })
  axios.get = getSpy as typeof axios.get

  const { discoverOpenAICompatibleModelOptions } = await import(
    `./openaiModelDiscovery.js?pooled-singular-placeholder=${Date.now()}-${Math.random()}`
  )

  await expect(discoverOpenAICompatibleModelOptions()).resolves.toEqual([
    {
      value: 'gpt-5.5',
      label: 'gpt-5.5',
      description: 'Discovered from OpenAI-compatible endpoint',
    },
  ])
  expect(getSpy).toHaveBeenCalled()
})
