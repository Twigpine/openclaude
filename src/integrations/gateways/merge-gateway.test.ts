import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, mock, test } from 'bun:test'

import '../index.js'
import {
  getRouteCredentialEnvVars,
  resolveActiveRouteIdFromEnv,
} from '../routeMetadata.js'
import { clearManagedProfileEnv } from '../../utils/providerProfile.js'
import { applyProviderFlag } from '../../utils/providerFlag.js'
import { createOpenAIShimClient } from '../../services/api/openaiShim.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { asMockFetch } from '../../test/typedMocks.js'
import mergeGateway from './merge-gateway.js'

const mapModel = mergeGateway.catalog?.discovery?.mapModel
type OpenAIShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

describe('Merge Gateway', () => {
  test('uses a dedicated OpenAI-compatible gateway route', () => {
    expect(mergeGateway.id).toBe('merge-gateway')
    expect(mergeGateway.defaultBaseUrl).toBe(
      'https://api-gateway.merge.dev/v1/openai',
    )
    expect(mergeGateway.setup.credentialEnvVars).toEqual([
      'MERGE_GATEWAY_API_KEY',
    ])
    expect(mergeGateway.setup.dedicatedCredentialsOnly).toBe(true)
    expect(mergeGateway.transportConfig.kind).toBe('openai-compatible')
    expect(
      mergeGateway.transportConfig.openaiShim?.supportsApiFormatSelection,
    ).toBe(true)
  })

  test('keeps routing policy and concrete model fallbacks in the catalog', () => {
    expect(mergeGateway.catalog?.source).toBe('hybrid')
    expect(mergeGateway.catalog?.discovery?.requiresAuth).toBe(true)
    expect(mergeGateway.catalog?.models?.map(model => model.apiName)).toEqual([
      'default_routing',
      'openai/gpt-5.5',
    ])
  })

  test('--provider selects the route and uses only its dedicated credential', async () => {
    await acquireSharedMutationLock('merge-gateway.test.ts')
    expect(getRouteCredentialEnvVars('merge-gateway')).toEqual([
      'MERGE_GATEWAY_API_KEY',
    ])

    const previousEnv = { ...process.env }
    const originalFetch = globalThis.fetch
    try {
      process.env.MERGE_GATEWAY_API_KEY = 'merge-key'
      process.env.OPENAI_API_KEY = 'unrelated-openai-key'
      delete process.env.OPENAI_BASE_URL

      expect(
        applyProviderFlag('merge-gateway', [
          '--provider',
          'merge-gateway',
          '--model',
          'default_routing',
        ]),
      ).toEqual({})
      expect(String(process.env.OPENAI_BASE_URL)).toBe(
        'https://api-gateway.merge.dev/v1/openai',
      )
      expect(String(process.env.OPENAI_MODEL)).toBe('default_routing')
      expect(resolveActiveRouteIdFromEnv(process.env)).toBe('merge-gateway')

      let authorization: string | null = null
      globalThis.fetch = asMockFetch(mock((_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'chatcmpl-merge',
              model: 'default_routing',
              choices: [
                {
                  message: { role: 'assistant', content: 'ok' },
                  finish_reason: 'stop',
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        )
      }))

      const client = createOpenAIShimClient({}) as OpenAIShimClient
      await client.beta.messages.create({
        model: 'default_routing',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32,
        stream: false,
      })

      expect<string | null>(authorization).toBe('Bearer merge-key')
    } finally {
      mock.restore()
      globalThis.fetch = originalFetch
      for (const name of Object.keys(process.env)) {
        if (!(name in previousEnv)) delete process.env[name]
      }
      Object.assign(process.env, previousEnv)
      releaseSharedMutationLock()
    }
  })

  test('maps native and OpenAI-compatible model list shapes', () => {
    if (!mapModel) throw new Error('mapModel missing')

    expect(
      mapModel({
        model: 'anthropic/claude-sonnet-5',
        display_name: 'Claude Sonnet 5',
      }),
    ).toEqual({
      id: 'merge-gateway-anthropic/claude-sonnet-5',
      apiName: 'anthropic/claude-sonnet-5',
      label: 'Claude Sonnet 5 (via Merge Gateway)',
    })
    expect(mapModel({ id: 'openai/gpt-5.5' })).toEqual({
      id: 'merge-gateway-openai/gpt-5.5',
      apiName: 'openai/gpt-5.5',
      label: 'openai/gpt-5.5 (via Merge Gateway)',
    })
    expect(mapModel({})).toBeNull()
    expect(mapModel(null)).toBeNull()
  })
})

// Use separate processes so profile creation cannot mask a missing startup key.
test('Merge saved profiles authorize inference and discovery after a fresh startup', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'merge-profile-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  const run = async (source: string) => {
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
    expect({ exit, stderr, stdout }).toEqual({ exit: 0, stderr: '', stdout: '' })
  }
  try {
    await run(`
      import assert from 'node:assert/strict';
      import { addProviderProfile } from './src/utils/providerProfiles.ts';
      import { applyProviderFlag } from './src/utils/providerFlag.ts';
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }));
      const profile = addProviderProfile({
        provider: 'merge-gateway', name: 'Merge',
        baseUrl: 'https://api-gateway.merge.dev/v1/openai',
        model: 'openai/gpt-5.5', apiKey: 'saved-merge-key', apiFormat: 'chat',
      });
      assert.ok(profile);
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, 'saved-merge-key');
      applyProviderFlag('openai', ['--provider', 'openai']);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
    `)
    await run(`
      import assert from 'node:assert/strict';
      import { applyStartupEnvFromProfile } from './src/utils/providerProfile.ts';
      import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
      import { discoverModelsForRoute } from './src/integrations/discoveryService.ts';
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, undefined);
      assert.equal(await applyStartupEnvFromProfile(), null);
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(String(url).endsWith('/models')
          ? { data: [{ id: 'openai/gpt-5.5' }] }
          : { id: 'chatcmpl-merge', model: 'openai/gpt-5.5', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'Content-Type': 'application/json' } });
      };
      await createOpenAIShimClient({}).beta.messages.create({
        model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: false,
      });
      await discoverModelsForRoute('merge-gateway', { forceRefresh: true });
      assert.deepEqual(calls, [
        { url: 'https://api-gateway.merge.dev/v1/openai/chat/completions', auth: 'Bearer saved-merge-key' },
        { url: 'https://api-gateway.merge.dev/v1/models', auth: 'Bearer saved-merge-key' },
      ]);
    `)
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('Merge credentials are withheld from retargeted inference and startup', async () => {
  const { resolveRouteCredentialValue } = await import('../routeMetadata.js')
  const { buildLaunchEnv, createProfileFile } = await import('../../utils/providerProfile.js')
  for (const baseUrl of [
    'https://proxy.example/v1',
    'http://api-gateway.merge.dev/v1/openai',
    'https://api-gateway.merge.dev:8443/v1/openai',
    'https://api-gateway.merge.dev/v1/openai?tenant=proxy',
    'https://api-gateway.merge.dev/v1/openai#proxy',
    'https://api-gateway.merge.dev/v1/other',
  ]) {
    expect(resolveRouteCredentialValue({
      routeId: 'merge-gateway', baseUrl,
      processEnv: { MERGE_GATEWAY_API_KEY: 'merge-key' },
    })).toBeUndefined()
    const env = await buildLaunchEnv({
      profile: 'openai',
      goal: 'balanced',
      persisted: createProfileFile('openai', {
        CLAUDE_CODE_PROVIDER_ROUTE_ID: 'merge-gateway',
        OPENAI_BASE_URL: baseUrl, OPENAI_MODEL: 'openai/gpt-5.5',
        OPENAI_API_KEY: 'merge-key', MERGE_GATEWAY_API_KEY: 'merge-key',
      }),
      processEnv: { MERGE_GATEWAY_API_KEY: 'ambient-merge-key', OPENAI_API_KEY: 'ambient-merge-key' },
    })
    expect(env.MERGE_GATEWAY_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
  }
})

test('a startup URL override cannot inherit a saved Merge credential', async () => {
  const { buildLaunchEnv, createProfileFile } = await import('../../utils/providerProfile.js')
  const persisted = createProfileFile('openai', {
    OPENAI_BASE_URL: 'https://api-gateway.merge.dev/v1/openai',
    OPENAI_MODEL: 'openai/gpt-5.5', OPENAI_API_KEY: 'saved-merge-key',
    MERGE_GATEWAY_API_KEY: 'saved-merge-key',
  })
  for (const customKey of [undefined, 'custom-proxy-key']) {
    const env = await buildLaunchEnv({
      profile: 'openai', goal: 'balanced', persisted,
      processEnv: { OPENAI_BASE_URL: 'https://proxy.example/v1', OPENAI_API_KEY: customKey },
    })
    expect(env.MERGE_GATEWAY_API_KEY).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBe(customKey)
  }
})
