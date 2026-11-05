import { describe, expect, mock, test } from 'bun:test'

import { createOpenAIShimClient } from '../../services/api/openaiShim.js'
import { PROVIDER_SELECTION_FLAGS } from '../../utils/providerSelectionFlags.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'
import requesty, { mapRequestyModel } from './requesty.js'

type OpenAIShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

describe('requesty gateway live model mapping', () => {
  test('uses hybrid discovery against the public models list', () => {
    expect(requesty.catalog?.source).toBe('hybrid')
    expect(requesty.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        requiresAuth: false,
      }),
    )
    expect(requesty.catalog?.discovery?.mapModel).toBe(mapRequestyModel)
  })

  test('maps Requesty model fields into catalog entries', () => {
    expect(
      mapRequestyModel({
        id: 'anthropic/claude-sonnet-4-6',
        object: 'model',
        api: 'chat',
        context_window: 1000000,
        max_output_tokens: 64000,
        supports_tool_calling: true,
        supports_reasoning: true,
        supports_vision: true,
        input_price: 0.000003,
      }),
    ).toEqual({
      id: 'anthropic/claude-sonnet-4-6',
      apiName: 'anthropic/claude-sonnet-4-6',
      label: 'anthropic/claude-sonnet-4-6',
      contextWindow: 1000000,
      maxOutputTokens: 64000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapRequestyModel({
        id: 'xai/grok-4.6',
        api: 'chat',
        context_window: 256000,
        max_output_tokens: 0,
        supports_tool_calling: false,
        supports_reasoning: false,
      }),
    ).toEqual({
      id: 'xai/grok-4.6',
      apiName: 'xai/grok-4.6',
      label: 'xai/grok-4.6',
      contextWindow: 256000,
    })
  })

  test('filters non-chat and non-coding models', () => {
    expect(
      mapRequestyModel({
        id: 'openai/text-embedding-3-small',
        api: 'embedding',
      }),
    ).toBeNull()

    expect(
      mapRequestyModel({
        id: 'vendor/some-model',
        api: 'image',
      }),
    ).toBeNull()

    expect(mapRequestyModel({ id: 'openai/text-embedding-3-large' })).toBeNull()
    expect(mapRequestyModel({})).toBeNull()
    expect(mapRequestyModel({ id: '   ' })).toBeNull()
    expect(mapRequestyModel(null)).toBeNull()
    expect(mapRequestyModel('openai/gpt-5-mini')).toBeNull()
  })

  test('drops model ids carrying control or ANSI escape characters', () => {
    expect(
      mapRequestyModel({ id: 'openai/gpt-5-mini\u001b[31m', api: 'chat' }),
    ).toBeNull()
    expect(
      mapRequestyModel({ id: 'openai/gpt\u0007-5-mini', api: 'chat' }),
    ).toBeNull()
    expect(
      mapRequestyModel({ id: 'openai/gpt-5-mini\u009b', api: 'chat' }),
    ).toBeNull()
  })
})

// Every variable that selects the provider or supplies request auth.
const REQUEST_ENV_KEYS = [
  ...PROVIDER_SELECTION_FLAGS,
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_PROVIDER_ROUTE_ID',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'OPENAI_API_FORMAT',
  'OPENAI_AUTH_HEADER',
  'OPENAI_AUTH_SCHEME',
  'OPENAI_AUTH_HEADER_VALUE',
  'ANTHROPIC_CUSTOM_HEADERS',
  'REQUESTY_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_ACCESS_TOKEN',
  'MISTRAL_API_KEY',
]

describe('requesty request-time credential gate', () => {
  test('sends REQUESTY_API_KEY only to canonical Requesty URLs', async () => {
    await acquireSharedMutationLock('requesty.test.ts')
    const restoreEnv = snapshotEnv(REQUEST_ENV_KEYS)
    const originalFetch = globalThis.fetch
    let authorization: string | null = null
    try {
      globalThis.fetch = asMockFetch(mock((_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'chatcmpl-requesty',
              model: 'openai/gpt-5-mini',
              choices: [
                { message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }))
      const send = async (
        baseUrl: string,
        openAIKey?: string,
      ): Promise<string | null> => {
        for (const name of REQUEST_ENV_KEYS) {
          delete process.env[name]
        }
        process.env.CLAUDE_CODE_USE_OPENAI = '1'
        process.env.OPENAI_BASE_URL = baseUrl
        process.env.OPENAI_MODEL = 'openai/gpt-5-mini'
        process.env.REQUESTY_API_KEY = 'requesty-key'
        if (openAIKey) process.env.OPENAI_API_KEY = openAIKey
        authorization = null
        const client = createOpenAIShimClient({}) as OpenAIShimClient
        await client.beta.messages.create({
          model: 'openai/gpt-5-mini',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 32,
          stream: false,
        })
        return authorization
      }

      for (const canonical of [
        'https://router.requesty.ai/v1',
        'https://router.eu.requesty.ai/v1',
        'https://router.us.requesty.ai/v1',
        'https://router.ap.requesty.ai/v1',
      ]) {
        expect(await send(canonical)).toBe('Bearer requesty-key')
        expect(await send(canonical, 'openai-key')).toBe('Bearer requesty-key')
      }
      for (const noncanonical of [
        'http://router.requesty.ai/v1',
        'https://router.requesty.ai:8443/v1',
        'https://proxy.example/v1',
      ]) {
        expect(await send(noncanonical)).toBeNull()
        expect(await send(noncanonical, 'openai-key')).toBe('Bearer openai-key')
      }
    } finally {
      mock.restore()
      globalThis.fetch = originalFetch
      restoreEnv()
      releaseSharedMutationLock()
    }
  })
})
