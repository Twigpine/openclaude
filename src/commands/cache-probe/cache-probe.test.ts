import { expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'

import {
  call,
  resolveCacheProbeApiKey,
  resolveCacheProbeRequestApiKey,
  supportsCacheProbeFields,
} from './cache-probe.js'

test('cache-probe only sends OpenAI cache extensions to direct OpenAI API hosts (#2042)', () => {
  expect(supportsCacheProbeFields('https://api.openai.com/v1')).toBe(true)
  expect(supportsCacheProbeFields('https://eu.api.openai.com/v1')).toBe(true)
  expect(supportsCacheProbeFields('https://resource.openai.azure.com/openai/v1')).toBe(true)
  expect(supportsCacheProbeFields('https://resource.services.ai.azure.com/v1')).toBe(true)
  expect(
    supportsCacheProbeFields('https://azure-proxy.example.test/v1', {
      OPENAI_AZURE_STYLE: '1',
    }),
  ).toBe(true)
  expect(supportsCacheProbeFields('https://integrate.api.nvidia.com/v1')).toBe(false)
  expect(supportsCacheProbeFields('https://compatible.example.test/v1')).toBe(false)
  expect(supportsCacheProbeFields('not a URL')).toBe(false)
})

async function captureFirstProbeBody(
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  let sentBody: Record<string, unknown> | undefined
  try {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, env)
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response('unsupported fields', { status: 400 })
    }) as unknown as typeof globalThis.fetch
    globalThis.fetch = mockFetch

    await call('', {} as any)
    expect(sentBody).toBeDefined()
    return sentBody!
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, originalEnv)
  }
}

test('cache-probe retains cache extensions for supported Chat and Responses endpoints (#2042)', async () => {
  await acquireSharedMutationLock('commands/cache-probe/cache-probe.test.ts')
  try {
    const chatBody = await captureFirstProbeBody({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_KEY: 'test-key',
    })
    expect(chatBody).toMatchObject({ store: false })
    expect(chatBody).toHaveProperty('prompt_cache_key')
    expect(chatBody).not.toHaveProperty('prompt_cache_retention')

    const responsesBody = await captureFirstProbeBody({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://resource.openai.azure.com/openai/v1',
      OPENAI_MODEL: 'gpt-5.4',
      OPENAI_API_FORMAT: 'responses',
      OPENAI_API_KEY: 'test-key',
    })
    expect(responsesBody).toMatchObject({
      store: false,
      prompt_cache_retention: '24h',
    })
    expect(responsesBody).toHaveProperty('prompt_cache_key')

    const compatResponsesBody = await captureFirstProbeBody({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://api.openai.com/v1',
      OPENAI_MODEL: 'gpt-4o',
      OPENAI_API_FORMAT: 'responses_compat',
      OPENAI_API_KEY: 'test-key',
    })
    expect(compatResponsesBody).toMatchObject({
      input: [{ content: [{ type: 'text', text: 'Say "hello" and nothing else.' }] }],
      prompt_cache_retention: '24h',
    })
  } finally {
    releaseSharedMutationLock()
  }
})

test('cache-probe omits cache extensions from NVIDIA NIM requests (#2042)', async () => {
  await acquireSharedMutationLock('commands/cache-probe/cache-probe.test.ts')
  const originalEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  let sentBody: Record<string, unknown> | undefined
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
    process.env.OPENAI_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct'
    process.env.OPENAI_API_KEY = 'test-key'
    process.env.NVIDIA_NIM = '1'
    process.env.NVIDIA_API_KEY = 'test-key'
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sentBody = JSON.parse(String(init?.body))
      return new Response('unsupported fields', { status: 400 })
    }) as unknown as typeof globalThis.fetch
    globalThis.fetch = mockFetch

    const result = await call('', {} as any)

    expect(result.type).toBe('text')
    expect(sentBody).toBeDefined()
    expect(sentBody).not.toHaveProperty('prompt_cache_key')
    expect(sentBody).not.toHaveProperty('prompt_cache_retention')
    expect(sentBody).not.toHaveProperty('store')
  } finally {
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    releaseSharedMutationLock()
  }
})

test('resolveCacheProbeApiKey prefers the first usable OPENAI_API_KEYS entry', () => {
  expect(
    resolveCacheProbeApiKey({
      OPENAI_API_KEYS: 'key-a,key-b',
      OPENAI_API_KEY: 'single-key',
    } as NodeJS.ProcessEnv),
  ).toBe('key-a')
})

test('resolveCacheProbeApiKey ignores placeholder OPENAI_API_KEY when OPENAI_API_KEYS is usable', () => {
  expect(
    resolveCacheProbeApiKey({
      OPENAI_API_KEYS: 'key-a,key-b',
      OPENAI_API_KEY: 'SUA_CHAVE',
    } as NodeJS.ProcessEnv),
  ).toBe('key-a')
})

test('resolveCacheProbeApiKey rejects placeholder values inside credential pools', () => {
  expect(
    resolveCacheProbeApiKey({
      OPENAI_API_KEYS: 'key-a,SUA_CHAVE',
      OPENAI_API_KEY: 'key-single',
    } as NodeJS.ProcessEnv),
  ).toBe('')
})

test('resolveCacheProbeApiKey falls back to comma-separated OPENAI_API_KEY', () => {
  expect(
    resolveCacheProbeApiKey({
      OPENAI_API_KEY: 'key-a,key-b',
    } as NodeJS.ProcessEnv),
  ).toBe('key-a')
})

test('resolveCacheProbeRequestApiKey prefers GitHub credentials in GitHub mode', () => {
  expect(
    resolveCacheProbeRequestApiKey(
      {
        CLAUDE_CODE_USE_GITHUB: '1',
        OPENAI_API_KEYS: 'openai-key-a,openai-key-b',
        GITHUB_TOKEN: 'github-token',
      } as NodeJS.ProcessEnv,
      { isGithub: true },
    ),
  ).toBe('github-token')
})

test('cache-probe no-key guidance mentions pooled OpenAI credentials', async () => {
  await acquireSharedMutationLock('commands/cache-probe/cache-probe.test.ts')
  const originalEnv = { ...process.env }
  try {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-5.5'

    const result = await call('', {} as any)

    expect(result.type).toBe('text')
    if (result.type !== 'text') throw new Error('expected text result')
    expect(result.value).toContain('OPENAI_API_KEYS or OPENAI_API_KEY')
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    releaseSharedMutationLock()
  }
})
