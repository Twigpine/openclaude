import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { createTestTlsFixture } from '../test/tlsFixture.js'

const run = promisify(execFile)
const { key, cert } = createTestTlsFixture()
let directory: string
let modulePath: string
let proxyModulePath: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'proxy-no-proxy-'))
  await Promise.all([
    writeFile(join(directory, 'ca.pem'), cert),
    writeFile(join(directory, 'client.pem'), cert),
    writeFile(join(directory, 'client.key'), key),
  ])
  modulePath = join(directory, 'network.mjs')
  proxyModulePath = join(directory, 'proxy.mjs')
  const entrypoint = join(directory, 'entry.ts')
  await writeFile(entrypoint, `
    export { getProxyAgent, getProxyFetchOptions, getNoProxy, shouldBypassProxy, configureGlobalAgents, clearProxyCache } from ${JSON.stringify(join(import.meta.dir, 'proxy.ts'))};
    export { StructuredIO } from ${JSON.stringify(join(import.meta.dir, '../cli/structuredIO.ts'))};
    export { clearCACertsCache, getCACertificates } from ${JSON.stringify(join(import.meta.dir, 'caCerts.ts'))};
    export { clearMTLSCache, getMTLSConfig, getMTLSAgent } from ${JSON.stringify(join(import.meta.dir, 'mtls.ts'))};
  `)
  const result = await Bun.build({
    entrypoints: [entrypoint, join(import.meta.dir, 'proxy.ts')],
    target: 'node',
    plugins: [{
      name: 'node-proxy-environment-fixture',
      setup(build) {
        // Isolate the unrelated permission/hook subsystem. Environment message
        // parsing, mutation, proxy caching, dispatchers and network I/O are real.
        build.onResolve({ filter: /./ }, args => {
          if (args.importer === join(import.meta.dir, '../cli/structuredIO.ts') &&
            /(?:\/permissions\/|\/hooks\.js$|\/types\/hooks\.js$|\/sessionState\.js$)/.test(args.path)) {
            return { path: args.path, namespace: 'unused-permissions' }
          }
        })
        build.onLoad({ filter: /./, namespace: 'unused-permissions' }, () => ({
          contents: `
            const unused = () => { throw new Error('Unexpected permission/hook call'); };
            export {
              unused as hookJSONOutputSchema, unused as permissionPromptToolResultToPermissionDecision,
              unused as outputSchema, unused as checkPlanModePermissions,
              unused as checkRuleBasedPermissions, unused as hasPermissionsToUseTool,
              unused as revalidatePlanModePermissionAllowWithRaceGuard, unused as samePermissionAskConstraint,
              unused as executePermissionRequestHooks, unused as filterPermissionRequestHookUpdates,
              unused as persistPermissionUpdates, unused as applyPermissionUpdatesToLiveContext,
              unused as notifySessionStateChanged
            };
          `,
          loader: 'js',
        }))
        build.onResolve({ filter: /^[^./]/ }, args => {
          if (!args.importer || isAbsolute(args.path)) return
          if (args.path.startsWith('node:') || args.path.startsWith('bun:')) return
          if (args.path.startsWith('src/')) return
          const specifier = args.path === 'undici' ? 'undici/index.js' : args.path
          return { path: Bun.resolveSync(specifier, args.resolveDir), external: true }
        })
      },
    }],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Could not build proxy environment fixture')
  await writeFile(modulePath, await result.outputs[0].text())
  await writeFile(proxyModulePath, await result.outputs[1].text())
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.each([
  'combined certificate and no_proxy',
  'certificate-only',
  'proxy-clear-ca',
  'proxy-clear-mtls',
] as const)('structured I/O refreshes certificate caches with a %s update', async mode => {
  const caPath = join(directory, 'ca.pem')
  const certPath = join(directory, 'client.pem')
  const keyPath = join(directory, 'client.key')
  const sockets = new Set<Socket>()
  let connects = 0
  let requests = 0
  let authorizedRequests = 0
  const target = createHttpsServer({
    key, cert, ca: cert, requestCert: mode !== 'proxy-clear-ca', rejectUnauthorized: true,
  }, (request, response) => {
    requests++
    if ('authorized' in request.socket && request.socket.authorized) authorizedRequests++
    response.end('authenticated response')
  })
  const proxy = createServer()
  for (const server of [target, proxy]) {
    server.on('connection', socket => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
    })
  }
  try {
    target.listen(0, '127.0.0.1')
    await once(target, 'listening')
    const targetPort = (target.address() as AddressInfo).port
    proxy.on('connect', (request, client, head) => {
      connects++
      expect(request.url).toBe(`127.0.0.1:${targetPort}`)
      const upstream = connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream).pipe(client)
      })
      sockets.add(upstream)
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      client.on('close', () => upstream.destroy())
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const env = { ...process.env }
    for (const name of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
      'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ]) delete env[name]
    const config = {
      mode, caPath, certPath, keyPath,
      proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      url: `https://127.0.0.1:${targetPort}/`,
    }
    const { stdout } = await run('node', ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const { getGlobalDispatcher, setGlobalDispatcher } = await import(pathToFileURL(${JSON.stringify(Bun.resolveSync('undici/index.js', import.meta.dir))}));
      const network = await import(pathToFileURL(process.argv[1]));
      const config = JSON.parse(process.argv[2]);
      process.env.HTTPS_PROXY = config.proxy;
      process.env.no_proxy = config.mode === 'certificate-only' ? 'unused.invalid' : '*.127.0.0.1';
      assert.equal(network.getCACertificates(), undefined);
      assert.equal(network.getMTLSConfig(), undefined);
      assert.equal(network.getMTLSAgent(), undefined);
      const cached = network.getProxyAgent(config.proxy);
      const previousGlobalDispatcher = getGlobalDispatcher();
      network.configureGlobalAgents();
      const agents = new Set([cached]);
      const tlsAgents = new Set();
      const update = async variables => {
        const io = new network.StructuredIO((async function* () {
          yield JSON.stringify({ type: 'update_environment_variables', variables }) + '\\n';
        })());
        for await (const message of io.structuredInput) {
          assert.fail('Environment updates must be consumed internally: ' + message.type);
        }
      };
      try {
        await update({
          NODE_EXTRA_CA_CERTS: config.caPath,
          ...(config.mode !== 'proxy-clear-ca' && {
            CLAUDE_CODE_CLIENT_CERT: config.certPath,
            CLAUDE_CODE_CLIENT_KEY: config.keyPath,
          }),
          ...(config.mode !== 'certificate-only' && { no_proxy: 'unused.invalid' }),
        });
        agents.add(getGlobalDispatcher());
        tlsAgents.add(network.getMTLSAgent());
        if (config.mode.startsWith('proxy-clear')) {
          const proxied = await fetch(config.url);
          assert.equal(await proxied.text(), 'authenticated response');
          await update({ HTTPS_PROXY: '' });
          agents.add(getGlobalDispatcher());
          tlsAgents.add(network.getMTLSAgent());
          const direct = await fetch(config.url);
          assert.equal(direct.status, 200);
          assert.equal(await direct.text(), 'authenticated response');
        } else {
          const expectedCert = readFileSync(config.certPath, 'utf8');
          const expectedKey = readFileSync(config.keyPath, 'utf8');
          assert.deepEqual(network.getMTLSConfig(), { cert: expectedCert, key: expectedKey });
          assert.ok(network.getCACertificates().includes(readFileSync(config.caPath, 'utf8')));
          assert.equal(network.getMTLSAgent().options.cert, expectedCert);
          assert.equal(network.getMTLSAgent().options.key, expectedKey);
          for (const noProxy of ['unused.invalid', '*.127.0.0.1']) {
            if (network.getNoProxy() !== noProxy) await update({ no_proxy: noProxy });
            const dispatcher = network.getProxyAgent(config.proxy);
            agents.add(dispatcher);
            assert.notEqual(dispatcher, cached);
            for (const options of [{ dispatcher }, {}]) {
              const response = await fetch(config.url, options);
              assert.equal(response.status, 200);
              assert.equal(await response.text(), 'authenticated response');
            }
          }
        }
        console.log('verified');
      } finally {
        setGlobalDispatcher(previousGlobalDispatcher);
        await Promise.all([...agents].map(dispatcher => dispatcher.destroy()));
        for (const agent of tlsAgents) agent.destroy();
      }
    `, modulePath, JSON.stringify(config)], { env, timeout: 6000 })
    expect(stdout.trim()).toBe('verified')
    expect(connects).toBe(mode.startsWith('proxy-clear') ? 1 : 2)
    expect(requests).toBe(mode.startsWith('proxy-clear') ? 2 : 4)
    expect(authorizedRequests).toBe(mode === 'proxy-clear-ca' ? 0 : mode === 'proxy-clear-mtls' ? 2 : 4)
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([target, proxy].map(server => new Promise<void>(resolve => {
      server.close(() => resolve())
    })))
  }
}, 10000)

test.each(['TLS/proxy settings', 'unrelated session token'] as const)(
  'structured I/O cache refresh for %s', async mode => {
    const env = { ...process.env }
    for (const name of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
      'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ]) delete env[name]
    const { stdout } = await run('node', ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const { getGlobalDispatcher, setGlobalDispatcher } = await import(pathToFileURL(${JSON.stringify(Bun.resolveSync('undici/index.js', import.meta.dir))}));
      const network = await import(pathToFileURL(process.argv[1]));
      const { mode, directory } = JSON.parse(process.argv[2]);
      const proxy = 'http://127.0.0.1:1';
      const settings = {
        NODE_EXTRA_CA_CERTS: join(directory, 'ca.pem'),
        CLAUDE_CODE_CLIENT_CERT: join(directory, 'client.pem'),
        CLAUDE_CODE_CLIENT_KEY: join(directory, 'client.key'),
        CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: 'test-passphrase',
      };
      Object.assign(process.env, settings, { HTTPS_PROXY: proxy, no_proxy: 'unused.invalid' });
      const updates = mode === 'unrelated session token'
        ? { CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'refreshed-token' }
        : { ...settings, NODE_OPTIONS: '--use-system-ca',
            HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
            CLAUDE_CODE_PROXY_RESOLVES_HOSTS: 'true' };
      const previousGlobalDispatcher = getGlobalDispatcher();
      const dispatchers = new Set();
      const tlsAgents = new Set();
      const snapshot = () => {
        const state = [network.getCACertificates(), network.getMTLSConfig(),
          network.getMTLSAgent(), network.getProxyAgent(proxy), getGlobalDispatcher()];
        tlsAgents.add(state[2]);
        dispatchers.add(state[3]);
        dispatchers.add(state[4]);
        return state;
      };
      try {
        network.configureGlobalAgents();
        for (const [name, value] of Object.entries(updates)) {
          const before = snapshot();
          const io = new network.StructuredIO((async function* () {
            yield JSON.stringify({ type: 'update_environment_variables', variables: { [name]: value } }) + '\\n';
          })());
          for await (const message of io.structuredInput) {
            assert.fail('Environment updates must be consumed internally: ' + message.type);
          }
          const after = snapshot();
          assert.equal(process.env[name], value);
          assert.equal(network.getNoProxy(), 'unused.invalid');
          for (let index = 0; index < before.length; index++) {
            if (mode === 'unrelated session token') assert.equal(after[index], before[index], name);
            else assert.notEqual(after[index], before[index], name);
          }
          assert.equal(getGlobalDispatcher(), network.getProxyAgent(proxy));
        }
        console.log('verified');
      } finally {
        setGlobalDispatcher(previousGlobalDispatcher);
        await Promise.all([...dispatchers].map(dispatcher => dispatcher.destroy()));
        for (const agent of tlsAgents) agent.destroy();
      }
    `, modulePath, JSON.stringify({ mode, directory })], { env, timeout: 6000 })
    expect(stdout.trim()).toBe('verified')
  }, 10000,
)

for (const mode of [
  'lowercase-bypass', 'lowercase-proxy', 'empty-lowercase',
  'refresh-uppercase', 'refresh-lowercase', 'cache-wildcard',
  'update-uppercase', 'update-lowercase', 'clear-cache',
  'clear-proxy', 'clear-unset', 'retained-proxy',
] as const) {
  // The Node child has a 6s deadline; allow extra time for cleanup.
  test(`Node NO_PROXY routing: ${mode}`, async () => {
    const sockets = new Set<Socket>()
    let connects = 0
    let requests = 0
    const target = createServer((_request, response) => {
      requests++
      response.end('direct')
    })
    const proxy = createServer()
    const replacementProxy = mode === 'retained-proxy' ? createServer() : undefined
    const proxies = [proxy, ...(replacementProxy ? [replacementProxy] : [])]
    for (const server of proxies) server.on('connect', (_request, client) => {
      connects++
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.once('data', () => {
        client.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy')
      })
    })
    const servers = [target, ...proxies]
    for (const server of servers) {
      server.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        socket.on('error', () => socket.destroy())
      })
    }
    try {
      target.listen(0, '127.0.0.1')
      await once(target, 'listening')
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      if (replacementProxy) {
        replacementProxy.listen(0, '127.0.0.1')
        await once(replacementProxy, 'listening')
      }
      const env = { ...process.env }
      for (const key of [
        'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
        'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
        'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      ]) delete env[key]
      const config = {
        mode,
        proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        replacementProxy: replacementProxy
          ? `http://127.0.0.1:${(replacementProxy.address() as AddressInfo).port}`
          : undefined,
        url: `http://127.0.0.1:${(target.address() as AddressInfo).port}/`,
      }
      const { stdout } = await run('node', ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { pathToFileURL } from 'node:url';
        const network = await import(pathToFileURL(process.argv[1]));
        const { getGlobalDispatcher, setGlobalDispatcher } = await import(pathToFileURL(${JSON.stringify(Bun.resolveSync('undici/index.js', import.meta.dir))}));
        const { mode, proxy, replacementProxy, url } = JSON.parse(process.argv[2]);
        const previousGlobalDispatcher = getGlobalDispatcher();
        if (mode !== 'clear-unset') process.env.HTTPS_PROXY = proxy;
        const agents = new Set();
        const agent = () => {
          const result = network.getProxyAgent(proxy);
          agents.add(result);
          return result;
        };
        const request = async (expected, dispatcher) => {
          const response = await fetch(url, dispatcher ? { dispatcher } : {});
          assert.equal(response.status, 200);
          assert.equal(await response.text(), expected);
        };
        const update = async variables => {
          const io = new network.StructuredIO((async function* () {
            yield JSON.stringify({ type: 'update_environment_variables', variables }) + '\\n';
          })());
          for await (const message of io.structuredInput) {
            assert.fail('Environment updates must be consumed internally: ' + message.type);
          }
        };
        try {
          if (mode === 'retained-proxy') {
            const retained = network.getProxyFetchOptions().dispatcher;
            agents.add(retained);
            network.configureGlobalAgents();
            assert.equal(getGlobalDispatcher(), retained);
            await request('proxy');
            await update({ HTTPS_PROXY: replacementProxy });
            agents.add(getGlobalDispatcher());
            assert.notEqual(getGlobalDispatcher(), retained);
            await request('proxy');
            await request('proxy', retained);
            await update({ HTTPS_PROXY: '' });
            agents.add(getGlobalDispatcher());
            await request('direct');
            await request('proxy', retained);
          } else if (mode === 'clear-proxy' || mode === 'clear-unset') {
            if (mode === 'clear-proxy') {
              network.configureGlobalAgents();
              const installed = agent();
              let closed = 0;
              const close = installed.close.bind(installed);
              installed.close = () => { closed++; return close(); };
              network.configureGlobalAgents();
              assert.equal(closed, 0, 'the active cached dispatcher must stay open');
              await request('proxy');
              await update({ HTTPS_PROXY: '' });
              agents.add(getGlobalDispatcher());
              await request('direct');
              assert.equal(closed, 0, 'retained proxy dispatchers must stay open');
              // Reusing the same proxy must use the refreshed cache.
              process.env.HTTPS_PROXY = proxy;
              network.configureGlobalAgents();
              agents.add(getGlobalDispatcher());
              await request('proxy');
              await update({ HTTPS_PROXY: '' });
            } else {
              await update({ HTTPS_PROXY: '' });
            }
            agents.add(getGlobalDispatcher());
            await request('direct');
            await update({ HTTPS_PROXY: '' });
            agents.add(getGlobalDispatcher());
            await request('direct');
          } else if (mode.startsWith('lowercase') || mode === 'empty-lowercase') {
            process.env.NO_PROXY = mode === 'lowercase-bypass' ? 'unused.invalid' : '127.0.0.1';
            process.env.no_proxy = mode === 'lowercase-bypass' ? '127.0.0.1' :
              mode === 'empty-lowercase' ? '' : 'unused.invalid';
            const bypass = mode === 'lowercase-bypass';
            assert.equal(network.getNoProxy(), process.env.no_proxy);
            assert.equal(network.shouldBypassProxy(url), bypass);
            await request(bypass ? 'direct' : 'proxy', agent());
          } else if (mode.startsWith('refresh')) {
            const key = mode === 'refresh-uppercase' ? 'NO_PROXY' : 'no_proxy';
            process.env[key] = 'unused.invalid';
            const cached = agent();
            assert.equal(agent(), cached);
            network.configureGlobalAgents();
            await request('proxy', cached);
            process.env[key] = '127.0.0.1';
            await request('direct', cached);
            await request('direct');
            delete process.env[key];
            await request('proxy', cached);
            await request('proxy');
          } else {
            const key = mode === 'update-lowercase' ? 'no_proxy' : 'NO_PROXY';
            process.env[key] = 'unused.invalid, *.127.0.0.1';
            const cached = agent();
            assert.equal(agent(), cached);
            network.configureGlobalAgents();
            await request('direct', cached);
            await request('direct');
            const change = async value => {
              if (mode.startsWith('update')) await update({ [key]: value });
              else {
                process.env[key] = value;
                if (mode === 'clear-cache') {
                  network.clearProxyCache();
                  network.configureGlobalAgents();
                }
              }
            };
            await change('unused.invalid');
            const changed = agent();
            assert.notEqual(changed, cached);
            await request('proxy', changed);
            if (mode !== 'cache-wildcard') await request('proxy');
            await change('*.127.0.0.1');
            await request('direct', agent());
            if (mode !== 'cache-wildcard') await request('direct');
          }
          console.log('verified');
        } finally {
          setGlobalDispatcher(previousGlobalDispatcher);
          for (const dispatcher of agents) await dispatcher.destroy();
        }
      `, modulePath, JSON.stringify(config)], { env, timeout: 6000 })
      expect(stdout.trim()).toBe('verified')
      const expectedConnects = mode === 'retained-proxy' ? 4 : mode === 'clear-proxy' ? 2 : mode === 'clear-unset' ? 0 : mode === 'lowercase-bypass' ? 0 :
        mode.startsWith('refresh') ? 3 : mode.startsWith('update') || mode === 'clear-cache' ? 2 : 1
      const expectedDirect = mode === 'retained-proxy' ? 1 : mode === 'clear-proxy' ? 3 : mode === 'clear-unset' ? 2 : mode === 'lowercase-bypass' ? 1 :
        mode.startsWith('lowercase') || mode === 'empty-lowercase' ? 0 :
          mode.startsWith('update') || mode === 'clear-cache' ? 4 : mode === 'cache-wildcard' ? 3 : 2
      expect(connects).toBe(expectedConnects)
      expect(requests).toBe(expectedDirect)
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all(servers.map(server => new Promise<void>(resolve => {
        server.close(() => resolve())
      })))
    }
  }, 10000)
}

test('empty configuration does not load or install a global dispatcher', async () => {
  const env = { ...process.env }
  for (const name of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
    'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CLIENT_CERT',
    'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  ]) delete env[name]
  const { stdout } = await run('node', ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Module from 'node:module';
    import { pathToFileURL } from 'node:url';
    const load = Module._load;
    Module._load = function(specifier, ...args) {
      assert.ok(!specifier.includes('undici'), 'empty configuration must stay lazy');
      return load.call(this, specifier, ...args);
    };
    const symbols = ['undici.globalDispatcher.1', 'undici.globalDispatcher.2'].map(Symbol.for);
    try {
      const network = await import(pathToFileURL(process.argv[1]));
      // Importing HTTP clients may initialize Node's built-in fetch dispatcher.
      const before = symbols.map(symbol => globalThis[symbol]);
      network.configureGlobalAgents();
      network.configureGlobalAgents();
      assert.deepEqual(symbols.map(symbol => globalThis[symbol]), before);
      // The full fixture imports unrelated services which can eagerly load
      // dispatchers. Only the environment-update operation must stay lazy.
      Module._load = load;
      const structured = await import(pathToFileURL(process.argv[2]));
      const structuredBefore = symbols.map(symbol => globalThis[symbol]);
      Module._load = function(specifier, ...args) {
        assert.ok(!specifier.includes('undici'), 'empty update must stay lazy');
        return load.call(this, specifier, ...args);
      };
      const io = new structured.StructuredIO((async function* () {
        yield JSON.stringify({ type: 'update_environment_variables', variables: { HTTPS_PROXY: '' } }) + '\\n';
      })());
      for await (const message of io.structuredInput) assert.fail(message.type);
      assert.deepEqual(symbols.map(symbol => globalThis[symbol]), structuredBefore);
      console.log('verified');
    } finally { Module._load = load; }
  `, proxyModulePath, modulePath], { env, timeout: 6000 })
  expect(stdout.trim()).toBe('verified')
}, 10000)

test.each(['shared TLS', 'TLS clear', 'TLS refresh', 'proxy replacement', 'external replacement'] as const)(
  'global dispatcher ownership: %s', async mode => {
    const env = { ...process.env }
    for (const name of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
      'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ]) delete env[name]
    const { stdout } = await run('node', ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const undici = (await import(pathToFileURL(${JSON.stringify(Bun.resolveSync('undici/index.js', import.meta.dir))}))).default;
      const network = await import(pathToFileURL(process.argv[1]));
      const { mode, directory } = JSON.parse(process.argv[2]);
      const original = undici.getGlobalDispatcher();
      const setGlobalDispatcher = undici.setGlobalDispatcher;
      const dispatchers = new Set();
      undici.setGlobalDispatcher = dispatcher => {
        dispatchers.add(dispatcher);
        setGlobalDispatcher(dispatcher);
      };
      const countCloses = dispatcher => {
        const close = dispatcher.close;
        let count = 0;
        dispatcher.close = function(...args) { count++; return close.apply(this, args); };
        return () => count;
      };
      const defaultCloses = countCloses(original);
      try {
        network.configureGlobalAgents();
        assert.equal(undici.getGlobalDispatcher(), original);
        if (mode === 'shared TLS' || mode.startsWith('TLS')) {
          process.env.NODE_EXTRA_CA_CERTS = directory + '/ca.pem';
          network.clearCACertsCache();
          network.clearMTLSCache();
          network.configureGlobalAgents();
          const shared = undici.getGlobalDispatcher();
          assert.notEqual(shared, original, 'CA configuration must install a TLS dispatcher');
          const sharedCloses = countCloses(shared);
          network.configureGlobalAgents();
          assert.equal(undici.getGlobalDispatcher(), shared, 'cached TLS dispatcher must be reused');
          assert.equal(sharedCloses(), 0, 'cached TLS dispatcher must stay open');
          if (mode.startsWith('TLS')) {
            if (mode === 'TLS clear') delete process.env.NODE_EXTRA_CA_CERTS;
            network.clearCACertsCache();
            network.clearMTLSCache();
            network.configureGlobalAgents();
            const replacement = undici.getGlobalDispatcher();
            assert.notEqual(replacement, shared, 'invalidated TLS configuration must be replaced');
            if (mode === 'TLS clear') assert.ok(replacement instanceof undici.Agent);
            assert.equal(sharedCloses(), 1, 'retired TLS dispatcher must be closed after cache invalidation');
            network.configureGlobalAgents();
            if (mode === 'TLS clear') assert.equal(undici.getGlobalDispatcher(), replacement);
          } else {
            process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
            network.configureGlobalAgents();
            delete process.env.HTTPS_PROXY;
            network.clearProxyCache();
            network.configureGlobalAgents();
            assert.equal(sharedCloses(), 0, 'retained cached TLS dispatcher must stay open');
          }
        } else {
          process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
          network.configureGlobalAgents();
          const first = undici.getGlobalDispatcher();
          const firstCloses = countCloses(first);
          if (mode === 'external replacement') {
            const external = new undici.Agent();
            undici.setGlobalDispatcher(external);
            delete process.env.HTTPS_PROXY;
            network.configureGlobalAgents();
            assert.equal(undici.getGlobalDispatcher(), external);
            assert.equal(firstCloses(), 0, 'a cached proxy must stay open');
          } else {
            process.env.HTTPS_PROXY = 'http://127.0.0.1:2';
            network.configureGlobalAgents();
            const second = undici.getGlobalDispatcher();
            assert.equal(firstCloses(), 0, 'replaced shared proxy must stay open');
            assert.notEqual(second, first);
            assert.equal(network.getProxyAgent(process.env.HTTPS_PROXY), second);
            const recreated = network.getProxyAgent('http://127.0.0.1:1');
            dispatchers.add(recreated);
            assert.notEqual(recreated, first, 'retired proxy must leave the cache');
          }
        }
        assert.equal(defaultCloses(), 0, 'the default dispatcher must stay open');
        console.log('verified');
      } finally {
        undici.setGlobalDispatcher = setGlobalDispatcher;
        setGlobalDispatcher(original);
        await Promise.all([...dispatchers].map(dispatcher => dispatcher.destroy()));
        network.getMTLSAgent()?.destroy();
      }
    `, modulePath, JSON.stringify({ mode, directory })], { env, timeout: 6000 })
    expect(stdout.trim()).toBe('verified')
  }, 10000,
)
