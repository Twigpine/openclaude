import { afterEach, beforeEach, expect, mock, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import { asMockFetch } from '../test/typedMocks.js'

async function loadProviderDiscoveryModule() {
  return import(`./providerDiscovery.js?ts=${Date.now()}-${Math.random()}`)
}

const originalFetch = globalThis.fetch
const originalEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
}

function restoreEnv(key: keyof typeof originalEnv): void {
  if (originalEnv[key] === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = originalEnv[key]
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('providerDiscovery.test.ts')
})

afterEach(() => {
  try {
    mock.restore()
    globalThis.fetch = originalFetch
    restoreEnv('OPENAI_BASE_URL')
  } finally {
    releaseSharedMutationLock()
  }
})

test('lists models from a local openai-compatible /models endpoint', async () => {
  const { listOpenAICompatibleModels } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock((input, init) => {
    const url = typeof input === 'string' ? input : input.url
    expect(url).toBe('http://localhost:1234/v1/models')
    expect(init?.headers).toEqual({ Authorization: 'Bearer local-key' })

    return Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'qwen2.5-coder-7b-instruct' },
            { id: 'llama-3.2-3b-instruct' },
            { id: 'qwen2.5-coder-7b-instruct' },
          ],
        }),
        { status: 200 },
      ),
    )
  }))

  await expect(
    listOpenAICompatibleModels({
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'local-key',
    }),
  ).resolves.toEqual([
    'qwen2.5-coder-7b-instruct',
    'llama-3.2-3b-instruct',
  ])
})

test('returns null when a local openai-compatible /models request fails', async () => {
  const { listOpenAICompatibleModels } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(() =>
    Promise.resolve(new Response('not available', { status: 503 })),
  ))

  await expect(
    listOpenAICompatibleModels({ baseUrl: 'http://localhost:1234/v1' }),
  ).resolves.toBeNull()
})

test('detects LM Studio from the default localhost port', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(getLocalOpenAICompatibleProviderLabel('http://localhost:1234/v1')).toBe(
    'LM Studio',
  )
})

test('detects common local openai-compatible providers by hostname', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('http://localai.local:8080/v1'),
  ).toBe('LocalAI')
  expect(
    getLocalOpenAICompatibleProviderLabel('http://vllm.local:8000/v1'),
  ).toBe('vLLM')
})

test('detects Moonshot AI from descriptor route metadata', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('https://api.moonshot.ai/v1'),
  ).toBe('Moonshot AI')
})

test('detects AI/ML API from descriptor route metadata', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('https://api.aimlapi.com/v1'),
  ).toBe('aimlapi.com')
})

test('detects Z.AI from descriptor route metadata', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('https://api.z.ai/api/coding/paas/v4'),
  ).toBe('Z.AI')
})

test('detects Moonshot AI - Kimi Code from api.kimi.com/coding hostname', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('https://api.kimi.com/coding/v1'),
  ).toBe('Moonshot AI - Kimi Code')
})

test('detects xAI from api.x.ai hostname', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('https://api.x.ai/v1'),
  ).toBe('xAI')
})

test('falls back to a generic local openai-compatible label', async () => {
  const { getLocalOpenAICompatibleProviderLabel } =
    await loadProviderDiscoveryModule()

  expect(
    getLocalOpenAICompatibleProviderLabel('http://127.0.0.1:8080/v1'),
  ).toBe('Local OpenAI-compatible')
})

test('ollama generation readiness reports unreachable when tags endpoint is down', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  const calledUrls: string[] = []
  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    calledUrls.push(url)
    return Promise.resolve(new Response('not available', { status: 503 }))
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
    }),
  ).resolves.toMatchObject({
    state: 'unreachable',
    models: [],
  })

  expect(calledUrls).toEqual([
    'http://localhost:11434/api/tags',
  ])
})

test('ollama generation readiness reports no models when server is reachable', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  const calledUrls: string[] = []
  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    calledUrls.push(url)
    return Promise.resolve(
      new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
    }),
  ).resolves.toMatchObject({
    state: 'no_models',
    models: [],
  })

  expect(calledUrls).toEqual([
    'http://localhost:11434/api/tags',
  ])
})

test('ollama generation readiness reports generation_failed when requested model is missing', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  const calledUrls: string[] = []
  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    calledUrls.push(url)
    return Promise.resolve(
      new Response(
        JSON.stringify({
          models: [{ name: 'llama3.1:8b', size: 1024 }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b',
    }),
  ).resolves.toMatchObject({
    state: 'generation_failed',
    probeModel: 'qwen2.5-coder:7b',
    detail: 'requested model not installed: qwen2.5-coder:7b',
  })

  expect(calledUrls).toEqual(['http://localhost:11434/api/tags'])
})

test('ollama generation readiness reports generation failures when chat probe fails', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ name: 'qwen2.5-coder:7b', size: 42 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }

    return Promise.resolve(new Response('model not found', { status: 404 }))
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
      model: 'qwen2.5-coder:7b',
    }),
  ).resolves.toMatchObject({
    state: 'generation_failed',
    probeModel: 'qwen2.5-coder:7b',
  })
})

test('ollama generation readiness reports generation_failed when chat probe returns invalid JSON', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.1:8b', size: 1024 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }

    return Promise.resolve(
      new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    )
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
    }),
  ).resolves.toMatchObject({
    state: 'generation_failed',
    probeModel: 'llama3.1:8b',
    detail: 'invalid JSON response',
  })
})

test('ollama generation readiness reports ready when chat probe succeeds', async () => {
  const { probeOllamaGenerationReadiness } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    if (url.endsWith('/api/tags')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            models: [{ name: 'llama3.1:8b', size: 1024 }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      )
    }

    return Promise.resolve(
      new Response(
        JSON.stringify({
          message: { role: 'assistant', content: 'OK' },
          done: true,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    )
  }))

  await expect(
    probeOllamaGenerationReadiness({
      baseUrl: 'http://localhost:11434',
    }),
  ).resolves.toMatchObject({
    state: 'ready',
    probeModel: 'llama3.1:8b',
  })
})

test('atomic chat readiness reports unreachable when /v1/models is down', async () => {
  const { probeAtomicChatReadiness } = await loadProviderDiscoveryModule()

  const calledUrls: string[] = []
  globalThis.fetch = asMockFetch(mock(input => {
    const url = typeof input === 'string' ? input : input.url
    calledUrls.push(url)
    return Promise.resolve(new Response('unavailable', { status: 503 }))
  }))

  await expect(
    probeAtomicChatReadiness({ baseUrl: 'http://127.0.0.1:1337' }),
  ).resolves.toEqual({ state: 'unreachable' })

  expect(calledUrls[0]).toBe('http://127.0.0.1:1337/v1/models')
})

test('atomic chat readiness reports no_models when server is reachable but empty', async () => {
  const { probeAtomicChatReadiness } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  ))

  await expect(
    probeAtomicChatReadiness({ baseUrl: 'http://127.0.0.1:1337' }),
  ).resolves.toEqual({ state: 'no_models' })
})

test('atomic chat readiness returns loaded model ids when ready', async () => {
  const { probeAtomicChatReadiness } = await loadProviderDiscoveryModule()

  globalThis.fetch = asMockFetch(mock(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [
            { id: 'Qwen3_5-4B_Q4_K_M' },
            { id: 'llama-3.1-8b-instruct' },
          ],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    ),
  ))

  await expect(
    probeAtomicChatReadiness({ baseUrl: 'http://127.0.0.1:1337' }),
  ).resolves.toEqual({
    state: 'ready',
    models: ['Qwen3_5-4B_Q4_K_M', 'llama-3.1-8b-instruct'],
  })
})
