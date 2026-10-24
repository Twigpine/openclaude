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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'proxy-no-proxy-'))
  await Promise.all([
    writeFile(join(directory, 'ca.pem'), cert),
    writeFile(join(directory, 'client.pem'), cert),
    writeFile(join(directory, 'client.key'), key),
  ])
  modulePath = join(directory, 'network.mjs')
  const entrypoint = join(directory, 'entry.ts')
  await writeFile(entrypoint, `
    export { getProxyAgent, getNoProxy, shouldBypassProxy, configureGlobalAgents, clearProxyCache } from ${JSON.stringify(join(import.meta.dir, 'proxy.ts'))};
    export { StructuredIO } from ${JSON.stringify(join(import.meta.dir, '../cli/structuredIO.ts'))};
    export { getCACertificates } from ${JSON.stringify(join(import.meta.dir, 'caCerts.ts'))};
    export { getMTLSConfig, getMTLSAgent } from ${JSON.stringify(join(import.meta.dir, 'mtls.ts'))};
  `)
  const result = await Bun.build({
    entrypoints: [entrypoint],
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
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

test.each([
  'combined certificate and no_proxy',
  'certificate-only',
] as const)('structured I/O refreshes certificate caches with a %s update', async mode => {
  const caPath = join(directory, 'ca.pem')
  const certPath = join(directory, 'client.pem')
  const keyPath = join(directory, 'client.key')
  const sockets = new Set<Socket>()
  let connects = 0
  let requests = 0
  let authorizedRequests = 0
  const target = createHttpsServer({
    key, cert, ca: cert, requestCert: true, rejectUnauthorized: true,
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
          CLAUDE_CODE_CLIENT_CERT: config.certPath,
          CLAUDE_CODE_CLIENT_KEY: config.keyPath,
          ...(config.mode !== 'certificate-only' && { no_proxy: 'unused.invalid' }),
        });
        agents.add(getGlobalDispatcher());
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
        console.log('verified');
      } finally {
        setGlobalDispatcher(previousGlobalDispatcher);
        await Promise.all([...agents].map(dispatcher => dispatcher.close()));
      }
    `, modulePath, JSON.stringify(config)], { env, timeout: 6000 })
    expect(stdout.trim()).toBe('verified')
    expect(connects).toBe(2)
    expect(requests).toBe(4)
    expect(authorizedRequests).toBe(4)
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
        await Promise.all([...dispatchers].map(dispatcher => dispatcher.close()));
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
    proxy.on('connect', (_request, client) => {
      connects++
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.once('data', () => {
        client.end('HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nproxy')
      })
    })
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
      proxy.listen(0, '127.0.0.1')
      await once(proxy, 'listening')
      const env = { ...process.env }
      for (const key of [
        'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
        'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS',
        'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      ]) delete env[key]
      const config = {
        mode,
        proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        url: `http://127.0.0.1:${(target.address() as AddressInfo).port}/`,
      }
      const { stdout } = await run('node', ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { pathToFileURL } from 'node:url';
        const network = await import(pathToFileURL(process.argv[1]));
        const { mode, proxy, url } = JSON.parse(process.argv[2]);
        process.env.HTTPS_PROXY = proxy;
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
          if (mode.startsWith('lowercase') || mode === 'empty-lowercase') {
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
          for (const dispatcher of agents) await dispatcher.close();
        }
      `, modulePath, JSON.stringify(config)], { env, timeout: 6000 })
      expect(stdout.trim()).toBe('verified')
      const expectedConnects = mode === 'lowercase-bypass' ? 0 :
        mode.startsWith('refresh') ? 3 : mode.startsWith('update') || mode === 'clear-cache' ? 2 : 1
      const expectedDirect = mode === 'lowercase-bypass' ? 1 :
        mode.startsWith('lowercase') || mode === 'empty-lowercase' ? 0 :
          mode.startsWith('update') || mode === 'clear-cache' ? 4 : mode === 'cache-wildcard' ? 3 : 2
      expect(connects).toBe(expectedConnects)
      expect(requests).toBe(expectedDirect)
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, proxy].map(server => new Promise<void>(resolve => {
        server.close(() => resolve())
      })))
    }
  }, 10000)
}
