import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, mock, test } from 'bun:test'

import { getCatalogForGateway } from '../index.js'
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
import {
  expectGatewayCatalog,
  type GatewayCatalogExpectations,
} from '../../test/gatewayCatalogTestHelpers.js'

const mapModel = mergeGateway.catalog?.discovery?.mapModel
type OpenAIShimClient = {
  beta: {
    messages: {
      create: (params: Record<string, unknown>) => Promise<unknown>
    }
  }
}

describe('Merge Gateway', () => {
  describe.each([
    {
      routeId: 'merge-gateway',
      expected: {
        baseUrl: 'https://api-gateway.merge.dev/v1/openai',
        defaultModel: 'openai/gpt-5.5',
        setup: {
          credentialEnvVars: ['MERGE_GATEWAY_API_KEY'],
          dedicatedCredentialsOnly: true,
        },
        openaiShim: { supportsApiFormatSelection: true },
        catalogSource: 'hybrid',
        discovery: { requiresAuth: true },
      } satisfies GatewayCatalogExpectations,
    },
  ])('$routeId catalog', ({ routeId, expected }) => {
    test('satisfies the registered gateway catalog contract', () => {
      expectGatewayCatalog(routeId, expected)
      expect(
        getCatalogForGateway(routeId)?.models?.some(
          model => model.apiName === 'default_routing',
        ),
      ).toBe(true)
    })
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
      process.env.OPENAI_AUTH_HEADER = 'X-Stale-Key'
      process.env.OPENAI_AUTH_SCHEME = 'Token'
      process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-secret'
      process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Stale-Secret: old-secret'

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

      for (const name of ['OPENAI_AUTH_HEADER', 'OPENAI_AUTH_SCHEME', 'OPENAI_AUTH_HEADER_VALUE', 'ANTHROPIC_CUSTOM_HEADERS']) {
        expect(process.env[name]).toBeUndefined()
      }
      // A direct canonical selection must also ignore stale settings at request time.
      process.env.OPENAI_AUTH_HEADER = 'X-Stale-Key'
      process.env.OPENAI_AUTH_SCHEME = 'Token'
      process.env.OPENAI_AUTH_HEADER_VALUE = 'stale-secret'
      process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Stale-Secret: old-secret'
      let authorization: string | null = null
      globalThis.fetch = asMockFetch(mock((_input, init) => {
        const headers = new Headers(init?.headers)
        expect(headers.get('x-stale-key')).toBeNull()
        expect(headers.get('x-stale-secret')).toBeNull()
        authorization = headers.get('authorization')
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

      const client = createOpenAIShimClient({ defaultHeaders: { 'X-Stale-Secret': 'old-secret' } }) as OpenAIShimClient
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
test.each(['merge-gateway', 'openai', 'custom'])('%s saved profiles authorize Merge inference and discovery after a fresh startup', async provider => {
  const configDir = mkdtempSync(join(tmpdir(), 'merge-profile-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  env.NODE_ENV = 'production'
  const run = async (source: string) => {
    const child = Bun.spawn([process.execPath, '--eval', "import { enableConfigs } from './src/utils/config.ts'; enableConfigs();\n" + source], {
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
      import { addProviderProfile, applyProviderProfileToProcessEnv } from './src/utils/providerProfiles.ts';
      import { clearManagedProfileEnv } from './src/utils/providerProfile.ts';
      import { applyProviderFlag } from './src/utils/providerFlag.ts';
      globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }));
      const profile = addProviderProfile({
        provider: '${provider}', name: 'Merge',
        baseUrl: 'https://api-gateway.merge.dev/v1/openai',
        model: 'openai/gpt-5.5', apiKey: 'saved-merge-key', apiFormat: 'chat',
      });
      assert.ok(profile);
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, 'saved-merge-key');
      applyProviderFlag('openai', ['--provider', 'openai']);
      assert.equal(process.env.OPENAI_API_KEY, undefined);
      for (const key of [undefined, 'undefined', 'null', 'SUA_CHAVE']) {
        clearManagedProfileEnv(process.env);
        applyProviderProfileToProcessEnv({ ...profile, apiKey: key });
        assert.equal(Object.hasOwn(process.env, 'MERGE_GATEWAY_API_KEY'), false);
      }
      process.env.MERGE_GATEWAY_API_KEY = 'ambient-merge-key';
      applyProviderProfileToProcessEnv({ ...profile, apiKey: undefined });
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, '${provider}' === 'merge-gateway' ? 'ambient-merge-key' : undefined);
    `)
    for (const startup of ['legacy', 'plural']) await run(`
      import assert from 'node:assert/strict';
      import { applyActiveProviderProfileFromConfig } from './src/utils/providerProfiles.ts';
      import { applyStartupEnvFromProfile } from './src/utils/providerProfile.ts';
      import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
      import { discoverModelsForRoute } from './src/integrations/discoveryService.ts';
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, undefined);
      if ('${startup}' === 'legacy') assert.equal(await applyStartupEnvFromProfile(), null);
      else assert.ok(applyActiveProviderProfileFromConfig());
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
}, 30_000)

test.each(['commandcode', 'apismart', 'concentrate', 'api-route', 'llmtr', 'gmi-cloud'])('%s credentials are not repurposed when a profile is retargeted to Merge', async provider => {
  const configDir = mkdtempSync(join(tmpdir(), 'merge-retarget-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  const source = `
    import assert from 'node:assert/strict';
    import { enableConfigs, getGlobalConfig } from './src/utils/config.ts';
    import { applyProviderProfileToProcessEnv, applyActiveProviderProfileFromConfig } from './src/utils/providerProfiles.ts';
    import { clearManagedProfileEnv } from './src/utils/providerProfile.ts';
    import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
    import { discoverModelsForRoute } from './src/integrations/discoveryService.ts';
    enableConfigs();
    const profile = { id: 'retargeted', name: 'Retargeted', provider: '${provider}',
      baseUrl: 'https://api-gateway.merge.dev/v1/openai', model: 'openai/gpt-5.5', apiKey: 'source-provider-secret' };
    for (const startup of [false, true]) for (const ambientKey of [undefined, 'ambient-merge-key']) {
      clearManagedProfileEnv(process.env);
      process.env.OPENAI_API_KEY = 'unrelated-generic-key';
      if (ambientKey) process.env.MERGE_GATEWAY_API_KEY = ambientKey;
      if (startup) applyActiveProviderProfileFromConfig({ ...getGlobalConfig(),
        providerProfiles: [profile], activeProviderProfileId: profile.id }, { force: true });
      else applyProviderProfileToProcessEnv(profile);
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
        return new Response(JSON.stringify(String(url).endsWith('/models')
          ? { data: [{ id: 'openai/gpt-5.5' }] }
          : { id: 'chatcmpl-merge', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }),
          { headers: { 'Content-Type': 'application/json' } });
      };
      await createOpenAIShimClient({}).beta.messages.create({
        model: 'openai/gpt-5.5', messages: [{ role: 'user', content: 'hello' }], max_tokens: 32, stream: false,
      });
      await discoverModelsForRoute('merge-gateway', { forceRefresh: true });
      const auth = null;
      assert.deepEqual(calls, [
        { url: 'https://api-gateway.merge.dev/v1/openai/chat/completions', auth },
        { url: 'https://api-gateway.merge.dev/v1/models', auth },
      ]);
    }
  `
  try {
    const child = Bun.spawn([process.execPath, '--eval', source], {
      cwd: join(import.meta.dir, '../../..'), env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])).toEqual([0, '', ''])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)

test('a retargeted profile cannot inherit the previous Merge session credential', async () => {
  await acquireSharedMutationLock('merge-gateway.test.ts')
  const previousEnv = { ...process.env }
  try {
    const { applyProviderProfileToProcessEnv } = await import('../../utils/providerProfiles.js')
    if (!mergeGateway.defaultBaseUrl) throw new Error('defaultBaseUrl missing')
    const profile = {
      id: 'merge-session', name: 'Merge', provider: 'merge-gateway',
      baseUrl: mergeGateway.defaultBaseUrl, model: 'default_routing',
      apiKey: 'saved-merge-key',
    }
    applyProviderProfileToProcessEnv(profile)
    expect(process.env.MERGE_GATEWAY_API_KEY).toBe('saved-merge-key')

    applyProviderProfileToProcessEnv({
      ...profile, id: 'retargeted', name: 'Retargeted', provider: 'apismart',
      apiKey: 'source-provider-secret',
    })
    expect(process.env.MERGE_GATEWAY_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in previousEnv)) delete process.env[name]
    }
    Object.assign(process.env, previousEnv)
    releaseSharedMutationLock()
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


test('configured and inherited Merge teammates authenticate in a fresh process', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'merge-teammate-'))
  const env = { ...process.env }
  clearManagedProfileEnv(env)
  env.CLAUDE_CONFIG_DIR = configDir
  env.OPENCLAUDE_CONFIG_DIR = configDir
  const source = `
    import assert from 'node:assert/strict';
    import { quote } from 'shell-quote';
    import { resolveOutOfProcessTeammateProvider, applyAgentProviderOverrideToEnv } from './src/services/api/agentRouting.ts';
    import { buildInheritedEnvVars } from './src/utils/swarm/spawnUtils.ts';
    const request = \`      import assert from 'node:assert/strict';
      import { createOpenAIShimClient } from './src/services/api/openaiShim.ts';
      import { enableConfigs, saveGlobalConfig } from './src/utils/config.ts';
      import { applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables } from './src/utils/managedEnv.ts';
      enableConfigs();
      saveGlobalConfig(current => ({ ...current, env: { MERGE_GATEWAY_API_KEY: 'settings-merge-key' } }));
      let auth;
      globalThis.fetch = async (url, init) => {
        auth = new Headers(init?.headers).get('authorization');
        return new Response(JSON.stringify({ id: 'chatcmpl-child', choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), { headers: { 'Content-Type': 'application/json' } });
      };
      assert.equal(process.env.MERGE_GATEWAY_API_KEY, process.env.EXPECTED_KEY);
      for (const applySettings of [applySafeConfigEnvironmentVariables, applyConfigEnvironmentVariables]) {
        for (const hostManaged of [true, false]) {
          process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = hostManaged ? '1' : '0';
          process.env.MERGE_GATEWAY_API_KEY = process.env.EXPECTED_KEY;
          applySettings();
          await createOpenAIShimClient({}).beta.messages.create({ model: 'openai/gpt-5.5', messages: [{role: 'user', content: 'hello'}], stream: false, max_tokens: 32 });
          assert.equal(auth, 'Bearer ' + (hostManaged ? process.env.EXPECTED_KEY : 'settings-merge-key'));
        }
      }
    \`;
    const run = async (command, childEnv) => {
      const child = Bun.spawn(command, { env: childEnv, stdout: 'pipe', stderr: 'pipe' });
      assert.deepEqual(await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]), [0, '', '']);
    };
    for (const parentKey of [undefined, 'parent-key']) {
      const childEnv = { ...process.env, EXPECTED_KEY: 'configured-agent-key' };
      if (parentKey) childEnv.MERGE_GATEWAY_API_KEY = parentKey;
      const override = resolveOutOfProcessTeammateProvider({
        cliModel: 'openai/gpt-5.5', agentName: 'worker', settings: {
          agentModels: { 'openai/gpt-5.5': { base_url: 'https://api-gateway.merge.dev/v1/openai', api_key: 'configured-agent-key' } },
        },
      });
      assert.ok(override);
      applyAgentProviderOverrideToEnv(override, childEnv);
      await run([process.execPath, '--eval', request], childEnv);
      applyAgentProviderOverrideToEnv({ ...override, baseURL: 'https://proxy.example/v1', apiKey: 'custom-key' }, childEnv);
      assert.equal(childEnv.MERGE_GATEWAY_API_KEY, undefined);
    }
    Object.assign(process.env, { CLAUDE_CODE_USE_OPENAI: '1', OPENAI_BASE_URL: 'https://api-gateway.merge.dev/v1/openai', OPENAI_MODEL: 'openai/gpt-5.5', OPENAI_API_KEY: 'parent-key', MERGE_GATEWAY_API_KEY: 'parent-key' });
    const forwarded = buildInheritedEnvVars();
    // A pane's shell may not have inherited any of the leader's credentials.
    if (process.platform !== 'win32') {
      await run(['/bin/sh', '-c', 'env ' + forwarded + ' ' + quote([process.execPath, '--eval', request])], {
        PATH: process.env.PATH, EXPECTED_KEY: 'parent-key',
      });
    }
  `
  try {
    const child = Bun.spawn([process.execPath, '--eval', source], {
      cwd: join(import.meta.dir, '../../..'), env, stdout: 'pipe', stderr: 'pipe',
    })
    expect(await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()])).toEqual([0, '', ''])
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}, 30_000)
