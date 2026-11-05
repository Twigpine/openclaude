import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { clearManagedProfileEnv } from '../../utils/providerProfile.js'
import requesty, { mapRequestyModel } from './requesty.js'

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

// Run the shim in a fresh process with a clean provider env: inherited
// provider flags, Azure mode or auth settings cannot reach the request, and
// the test never mutates this process's env. 30s covers the child's startup.
test('sends REQUESTY_API_KEY only to canonical Requesty URLs', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'requesty-gate-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  delete env.REQUESTY_API_KEY
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
        id: 'chatcmpl-requesty', model: 'openai/gpt-5-mini',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const results = {};
    for (const baseUrl of ${JSON.stringify([
      'https://router.requesty.ai/v1',
      'https://router.eu.requesty.ai/v1',
      'https://router.us.requesty.ai/v1',
      'https://router.ap.requesty.ai/v1',
      'http://router.requesty.ai/v1',
      'https://router.requesty.ai:8443/v1',
      'https://proxy.example/v1',
    ])}) {
      for (const openAIKey of [undefined, 'openai-key']) {
        process.env.CLAUDE_CODE_USE_OPENAI = '1';
        process.env.OPENAI_BASE_URL = baseUrl;
        process.env.OPENAI_MODEL = 'openai/gpt-5-mini';
        process.env.REQUESTY_API_KEY = 'requesty-key';
        if (openAIKey) process.env.OPENAI_API_KEY = openAIKey;
        else delete process.env.OPENAI_API_KEY;
        authorization = null;
        await createOpenAIShimClient({}).beta.messages.create({
          model: 'openai/gpt-5-mini',
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
    const requesty = 'Bearer requesty-key'
    const openai = 'Bearer openai-key'
    expect(JSON.parse(stdout)).toEqual({
      'https://router.requesty.ai/v1': requesty,
      'https://router.requesty.ai/v1 +openai': requesty,
      'https://router.eu.requesty.ai/v1': requesty,
      'https://router.eu.requesty.ai/v1 +openai': requesty,
      'https://router.us.requesty.ai/v1': requesty,
      'https://router.us.requesty.ai/v1 +openai': requesty,
      'https://router.ap.requesty.ai/v1': requesty,
      'https://router.ap.requesty.ai/v1 +openai': requesty,
      'http://router.requesty.ai/v1': null,
      'http://router.requesty.ai/v1 +openai': openai,
      'https://router.requesty.ai:8443/v1': null,
      'https://router.requesty.ai:8443/v1 +openai': openai,
      'https://proxy.example/v1': null,
      'https://proxy.example/v1 +openai': openai,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
