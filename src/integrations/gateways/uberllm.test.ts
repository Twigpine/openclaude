import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { clearManagedProfileEnv } from '../../utils/providerProfile.js'
import uberllm, { mapUberllmModel } from './uberllm.js'

describe('uberllm gateway live model mapping', () => {
  test('uses hybrid discovery against the public models list', () => {
    expect(uberllm.catalog?.source).toBe('hybrid')
    expect(uberllm.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        requiresAuth: false,
      }),
    )
    expect(uberllm.catalog?.discovery?.mapModel).toBe(mapUberllmModel)
  })

  test('maps UberLLM model fields into catalog entries', () => {
    expect(
      mapUberllmModel({
        id: 'deepseek/deepseek-v4-flash',
        object: 'model',
        type: 'chat',
        available: true,
        context_length: 1000000,
        max_output_tokens: 128000,
        supports_tools: true,
        supports_reasoning: true,
        supports_vision: false,
        output_modalities: ['text'],
      }),
    ).toEqual({
      id: 'deepseek/deepseek-v4-flash',
      apiName: 'deepseek/deepseek-v4-flash',
      label: 'deepseek/deepseek-v4-flash',
      contextWindow: 1000000,
      maxOutputTokens: 128000,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapUberllmModel({
        id: 'openai/gpt-5.5',
        type: 'chat',
        context_length: 1000000,
        max_output_tokens: 0,
        supports_tools: false,
        supports_reasoning: false,
      }),
    ).toEqual({
      id: 'openai/gpt-5.5',
      apiName: 'openai/gpt-5.5',
      label: 'openai/gpt-5.5',
      contextWindow: 1000000,
    })
  })

  test('filters non-chat, unavailable and non-coding models', () => {
    expect(
      mapUberllmModel({
        id: 'openai/text-embedding-3-small',
        type: 'embedding',
      }),
    ).toBeNull()

    expect(
      mapUberllmModel({
        id: 'vendor/some-model',
        type: 'image',
      }),
    ).toBeNull()

    expect(
      mapUberllmModel({
        id: 'vendor/offline-model',
        type: 'chat',
        available: false,
      }),
    ).toBeNull()

    expect(mapUberllmModel({ id: 'openai/text-embedding-3-large' })).toBeNull()
    expect(mapUberllmModel({})).toBeNull()
    expect(mapUberllmModel({ id: '   ' })).toBeNull()
    expect(mapUberllmModel(null)).toBeNull()
    expect(mapUberllmModel('deepseek/deepseek-v4-flash')).toBeNull()
  })

  test('drops model ids carrying control or ANSI escape characters', () => {
    expect(
      mapUberllmModel({ id: 'openai/gpt-5.5\u001b[31m', type: 'chat' }),
    ).toBeNull()
    expect(
      mapUberllmModel({ id: 'openai/gpt\u0007-5.5', type: 'chat' }),
    ).toBeNull()
    expect(
      mapUberllmModel({ id: 'openai/gpt-5.5\u009b', type: 'chat' }),
    ).toBeNull()
  })
})

// Run the shim in a fresh process with a clean provider env: inherited
// provider flags, Azure mode or auth settings cannot reach the request, and
// the test never mutates this process's env. 30s covers the child's startup.
test('sends UBERLLM_API_KEY only to the canonical UberLLM URL', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'uberllm-gate-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  delete env.UBERLLM_API_KEY
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  const source = `
    import { enableConfigs } from './src/utils/config.ts';
    import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
    enableConfigs();
    let authorization = null;
    globalThis.fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response(JSON.stringify({
        id: 'chatcmpl-uberllm', model: 'deepseek/deepseek-v4-flash',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const results = {};
    for (const baseUrl of ${JSON.stringify([
      'https://api.uberllm.dev/v1',
      'http://api.uberllm.dev/v1',
      'https://api.uberllm.dev:8443/v1',
      'https://proxy.example/v1',
    ])}) {
      for (const openAIKey of [undefined, 'openai-key']) {
        process.env.CLAUDE_CODE_USE_OPENAI = '1';
        process.env.OPENAI_BASE_URL = baseUrl;
        process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-flash';
        process.env.UBERLLM_API_KEY = 'uberllm-key';
        if (openAIKey) process.env.OPENAI_API_KEY = openAIKey;
        else delete process.env.OPENAI_API_KEY;
        authorization = null;
        await createOpenAIShimClient({}).beta.messages.create({
          model: 'deepseek/deepseek-v4-flash',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 32,
          stream: false,
        });
        results[baseUrl + (openAIKey ? ' +openai' : '')] = authorization;
      }
    }
    process.stdout.write(JSON.stringify(results));
  `
  try {
    const child = Bun.spawn([process.execPath, '--eval', source], {
      cwd: join(import.meta.dir, '../../..'),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
    const uberllmAuth = 'Bearer uberllm-key'
    const openai = 'Bearer openai-key'
    expect(JSON.parse(stdout)).toEqual({
      'https://api.uberllm.dev/v1': uberllmAuth,
      'https://api.uberllm.dev/v1 +openai': uberllmAuth,
      'http://api.uberllm.dev/v1': null,
      'http://api.uberllm.dev/v1 +openai': openai,
      'https://api.uberllm.dev:8443/v1': null,
      'https://api.uberllm.dev:8443/v1 +openai': openai,
      'https://proxy.example/v1': null,
      'https://proxy.example/v1 +openai': openai,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
