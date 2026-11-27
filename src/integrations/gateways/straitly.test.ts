import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { clearManagedProfileEnv } from '../../utils/providerProfile.js'
import straitly, { mapStraitlyModel } from './straitly.js'

describe('straitly gateway live model mapping', () => {
  test('uses hybrid discovery against the public models list', () => {
    expect(straitly.catalog?.source).toBe('hybrid')
    expect(straitly.catalog?.discovery).toEqual(
      expect.objectContaining({
        kind: 'openai-compatible',
        requiresAuth: false,
      }),
    )
    expect(straitly.catalog?.discovery?.mapModel).toBe(mapStraitlyModel)
  })

  test('maps Straitly model fields into catalog entries', () => {
    expect(
      mapStraitlyModel({
        id: 'claude-sonnet-5-5',
        name: 'Claude Sonnet 5.5',
        context_length: 1_000_000,
        architecture: {
          modality: 'text+image->text',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
        },
        top_provider: {
          context_length: 1_000_000,
          max_completion_tokens: 32_768,
        },
        catalog: {
          max_output_tokens: 128_000,
          reasoning: true,
        },
        supported_parameters: ['max_completion_tokens', 'reasoning', 'tools'],
        reasoning: {
          mandatory: false,
          default_enabled: true,
          default_effort: 'high',
        },
      }),
    ).toEqual({
      id: 'claude-sonnet-5-5',
      apiName: 'claude-sonnet-5-5',
      label: 'Claude Sonnet 5.5',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_768,
      capabilities: {
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
    })

    expect(
      mapStraitlyModel({
        id: 'deepseek/deepseek-v4-1-flash-1017',
        name: 'DeepSeek V4.1 Flash 1017',
        context_length: 1_048_576,
        top_provider: {
          context_length: 1_048_576,
          max_completion_tokens: 0,
        },
        supported_parameters: ['temperature'],
      }),
    ).toEqual({
      id: 'deepseek/deepseek-v4-1-flash-1017',
      apiName: 'deepseek/deepseek-v4-1-flash-1017',
      label: 'DeepSeek V4.1 Flash 1017',
      contextWindow: 1_048_576,
    })
  })

  test('filters non-text and non-coding models', () => {
    expect(
      mapStraitlyModel({
        id: 'vendor/image-gen',
        architecture: { output_modalities: ['image'] },
      }),
    ).toBeNull()

    expect(mapStraitlyModel({ id: 'openai/text-embedding-3-large' })).toBeNull()
    expect(mapStraitlyModel({})).toBeNull()
    expect(mapStraitlyModel({ id: '   ' })).toBeNull()
    expect(mapStraitlyModel(null)).toBeNull()
    expect(mapStraitlyModel('claude-sonnet-5-5')).toBeNull()
  })

  test('drops model ids carrying control or ANSI escape characters and sanitizes names', () => {
    expect(
      mapStraitlyModel({ id: 'claude-sonnet-5-5\u001b[31m' }),
    ).toBeNull()
    expect(
      mapStraitlyModel({ id: 'claude\u0007-sonnet-5-5' }),
    ).toBeNull()
    expect(
      mapStraitlyModel({ id: 'claude-sonnet-5-5\u009b' }),
    ).toBeNull()
    expect(
      mapStraitlyModel({
        id: 'claude-sonnet-5-5',
        name: 'Claude\u001b[31m',
      }),
    ).toEqual({
      id: 'claude-sonnet-5-5',
      apiName: 'claude-sonnet-5-5',
      label: 'claude-sonnet-5-5',
    })
  })
})

// Run the shim in a fresh process with a clean provider env: inherited
// provider flags, Azure mode or auth settings cannot reach the request, and
// the test never mutates this process's env. 30s covers the child's startup.
test('sends STRAITLY_API_KEY only to the canonical Straitly URL', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'straitly-gate-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  delete env.STRAITLY_API_KEY
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
        id: 'chatcmpl-straitly', model: 'deepseek/deepseek-v4-1-flash-1017',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }), { headers: { 'Content-Type': 'application/json' } });
    };
    const results = {};
    for (const baseUrl of ${JSON.stringify([
      'https://api.straitly.ai/v1',
      'http://api.straitly.ai/v1',
      'https://api.straitly.ai:8443/v1',
      'https://proxy.example/v1',
    ])}) {
      for (const openAIKey of [undefined, 'openai-key']) {
        process.env.CLAUDE_CODE_USE_OPENAI = '1';
        process.env.OPENAI_BASE_URL = baseUrl;
        process.env.OPENAI_MODEL = 'deepseek/deepseek-v4-1-flash-1017';
        process.env.STRAITLY_API_KEY = 'straitly-key';
        if (openAIKey) process.env.OPENAI_API_KEY = openAIKey;
        else delete process.env.OPENAI_API_KEY;
        authorization = null;
        await createOpenAIShimClient({}).beta.messages.create({
          model: 'deepseek/deepseek-v4-1-flash-1017',
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
    const straitlyAuth = 'Bearer straitly-key'
    const openaiAuth = 'Bearer openai-key'
    expect(JSON.parse(stdout)).toEqual({
      'https://api.straitly.ai/v1': straitlyAuth,
      'https://api.straitly.ai/v1 +openai': straitlyAuth,
      'http://api.straitly.ai/v1': null,
      'http://api.straitly.ai/v1 +openai': openaiAuth,
      'https://api.straitly.ai:8443/v1': null,
      'https://api.straitly.ai:8443/v1 +openai': openaiAuth,
      'https://proxy.example/v1': null,
      'https://proxy.example/v1 +openai': openaiAuth,
    })
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
