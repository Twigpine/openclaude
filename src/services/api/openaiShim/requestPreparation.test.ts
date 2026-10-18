import { expect, test } from 'bun:test'
import { ensureIntegrationsLoaded } from '../../../integrations/index.js'
import { resolveProviderRequest } from '../providerConfig.js'
import { prepareOpenAIRequest } from './requestPreparation.js'

const convertedTools = [{
  type: 'function',
  function: {
    name: 'Read',
    description: 'Read a file',
    parameters: { type: 'object', properties: {} },
  },
}]

const dependencies = {
  convertMessages: (
    messages: Array<{ role: string; content?: unknown }>,
    system: unknown,
  ) => [
    ...(system ? [{ role: 'system', content: String(system) }] : []),
    ...messages,
  ],
  convertSystemPrompt: (system: unknown) => String(system ?? ''),
  convertTools: () => convertedTools,
  hasGeminiApiHost: () => false,
  isGeminiMode: () => false,
  shouldPreserveGeminiThoughtSignature: () => false,
}

test('keeps store: false by default and removes it only for configured routes', async () => {
  await ensureIntegrationsLoaded()
  const prepare = (model: string, processEnv: NodeJS.ProcessEnv) =>
    prepareOpenAIRequest({
      request: resolveProviderRequest({ model, processEnv }),
      requestProcessEnv: processEnv,
      params: {
        model,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      },
      dependencies,
    })

  const generic = prepare('gpt-4o', {
    OPENAI_BASE_URL: 'https://gateway.example.test/v1',
    OPENAI_API_KEY: 'test-key',
  })
  expect(generic.body.store).toBe(false)

  const mistral = prepare('codestral-2508', {
    OPENAI_BASE_URL: 'https://api.mistral.ai/v1',
    OPENAI_API_KEY: 'test-key',
  })
  expect(mistral.shimConfig.removeBodyFields).toContain('store')
  expect(mistral.body).not.toHaveProperty('store')
})

test('removes store for Anthropic models on a custom OpenAI-compatible gateway (#2242)', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'https://litellm.example.test/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const prepare = (model: string) =>
    prepareOpenAIRequest({
      request: resolveProviderRequest({ model, processEnv }),
      requestProcessEnv: processEnv,
      params: {
        model,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
      },
      dependencies,
    })

  for (const model of [
    'claude-sonnet-4-6',
    'anthropic/claude-opus-4-1',
    'openrouter/anthropic/claude-haiku-4-5',
    'bedrock/us.anthropic.claude-sonnet-4-6',
    'sonnet-4-6',
    'opus-4-1',
    'haiku-4-5',
  ]) {
    const prepared = prepare(model)
    expect(prepared.shimConfig.removeBodyFields).toContain('store')
    expect(prepared.body).not.toHaveProperty('store')
  }

  for (const model of [
    'gpt-4o',
    'my-sonnet-rag',
    'magnum-opus',
    'Helsinki-NLP/opus-mt-en-de',
  ]) {
    expect(prepare(model).body.store).toBe(false)
  }
})

test('prepares a chat-completions request without executing transport', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'https://gateway.example.test/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const request = resolveProviderRequest({
    model: 'gpt-4o',
    processEnv,
  })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model: 'gpt-4o',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      temperature: 0.2,
      stream: false,
    },
    dependencies,
  })

  expect(prepared.effectiveTransport).toBe('chat_completions')
  expect(prepared.body).toMatchObject({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
    ],
    max_completion_tokens: 64,
    temperature: 0.2,
    stream: false,
    store: false,
  })
  expect(prepared.body).not.toHaveProperty('stream_options')
})

test('prepares tools and streaming options for a remote chat route', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'https://gateway.example.test/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const request = resolveProviderRequest({ model: 'gpt-4o', processEnv })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'Read',
        description: 'Read a file',
        input_schema: { type: 'object', properties: {} },
      }],
      tool_choice: { type: 'tool', name: 'Read' },
      max_tokens: 64,
      stream: true,
    },
    dependencies,
  })

  expect(prepared.body.stream_options).toEqual({ include_usage: true })
  expect(prepared.body.tools).toEqual(convertedTools)
  expect(prepared.body.tool_choice).toEqual({
    type: 'function',
    function: { name: 'Read' },
  })
})

test('requests streaming usage from a custom loopback chat route', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const request = resolveProviderRequest({
    model: 'local-openai-model',
    processEnv,
  })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model: 'local-openai-model',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    dependencies,
  })

  expect(prepared.body.stream_options).toEqual({ include_usage: true })
})

test.each([
  ['LM Studio', 'http://localhost:1234/v1', 'local-model'],
  ['non-native Ollama', 'http://192.168.1.10:11434/v1', 'llama3.1:8b'],
  ['remote Ollama', 'https://ollama.com/v1', 'qwen3-coder-next:cloud'],
])('requests streaming usage from a compatible %s route', async (
  _label,
  baseUrl,
  model,
) => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: baseUrl,
    OPENAI_API_KEY: 'test-key',
  }
  const request = resolveProviderRequest({ model, processEnv })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    dependencies,
  })

  expect(prepared.useNativeOllamaChat).toBe(false)
  expect(JSON.parse(prepared.serializeBody()).stream_options).toEqual({
    include_usage: true,
  })
})

test('keeps native Ollama streaming options off the wire', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'http://localhost:11434/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const model = 'llama3.1:8b'
  const request = resolveProviderRequest({ model, processEnv })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    dependencies,
  })

  expect(prepared.useNativeOllamaChat).toBe(true)
  expect(JSON.parse(prepared.serializeBody())).not.toHaveProperty(
    'stream_options',
  )
})

test('lets explicit stream_options removal override streaming usage', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'https://api.xiaomimimo.com/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const model = 'mimo-v2.5-pro'
  const request = resolveProviderRequest({ model, processEnv })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: true,
    },
    dependencies,
  })

  expect(prepared.shimConfig.removeBodyFields).toContain('stream_options')
  expect(prepared.body).not.toHaveProperty('stream_options')
})

test('omits streaming options from a non-streaming loopback request', async () => {
  await ensureIntegrationsLoaded()
  const processEnv = {
    OPENAI_BASE_URL: 'http://127.0.0.1:8000/v1',
    OPENAI_API_KEY: 'test-key',
  }
  const model = 'local-openai-model'
  const request = resolveProviderRequest({ model, processEnv })
  const prepared = prepareOpenAIRequest({
    request,
    requestProcessEnv: processEnv,
    params: {
      model,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64,
      stream: false,
    },
    dependencies,
  })

  expect(prepared.body).not.toHaveProperty('stream_options')
})
