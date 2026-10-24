import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
  directory = await mkdtemp(join(tmpdir(), 'undici-fetch-'))
  modulePath = join(directory, 'network.mjs')
  const entrypoint = join(directory, 'entry.ts')
  await writeFile(entrypoint, `
    export { getProxyFetchOptions, configureGlobalAgents, clearProxyCache } from ${JSON.stringify(join(import.meta.dir, 'proxy.ts'))};
    export { clearMTLSCache } from ${JSON.stringify(join(import.meta.dir, 'mtls.ts'))};
    export { clearCACertsCache } from ${JSON.stringify(join(import.meta.dir, 'caCerts.ts'))};
    export { createCombinedAbortSignal } from ${JSON.stringify(join(import.meta.dir, 'combinedAbortSignal.ts'))};
  `)
  // Exercise the Node branches with real dependencies, isolated from suite mocks.
  const result = await Bun.build({
    entrypoints: [entrypoint],
    target: 'node',
    plugins: [{
      name: 'node-network-fixture',
      setup(build) {
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
  if (!result.success) throw new AggregateError(result.logs, 'Could not build Node network fixture')
  await writeFile(modulePath, await result.outputs[0].text())
  await writeFile(join(directory, 'ca.pem'), cert)
  await writeFile(join(directory, 'client.pem'), cert)
  await writeFile(join(directory, 'client.key'), key)
})

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

for (const mode of ['proxy', 'bypass', 'wildcard-bypass', 'direct', 'global', 'global-direct', 'http'] as const) {
  // The child has a 6s deadline; leave time for assertions and socket cleanup.
  const title = mode === 'http'
    ? 'Node fetch preserves HTTP CONNECT with native and legacy dispatchers'
    : `Node fetch validates custom CA and mTLS with ${mode} dispatchers`
  test(title, async () => {
    const sockets = new Set<Socket>()
    let connects = 0
    let requests = 0
    let authorizedRequests = 0
    const handleRequest = (request: IncomingMessage, response: ServerResponse) => {
      requests++
      if ('authorized' in request.socket && request.socket.authorized) authorizedRequests++
      response.end('authenticated response')
    }
    const target = mode === 'http'
      ? createServer(handleRequest)
      : createHttpsServer({
        key, cert, ca: cert, requestCert: true, rejectUnauthorized: true,
      }, handleRequest)
    const proxy = createServer()
    for (const server of [target, proxy]) {
      server.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
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
      for (const key of [
        'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
        'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
        'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY', 'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      ]) delete env[key]
      const config = {
        mode,
        ca: join(directory, 'ca.pem'),
        cert: join(directory, 'client.pem'),
        key: join(directory, 'client.key'),
        proxy: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        url: `${mode === 'http' ? 'http' : 'https'}://127.0.0.1:${targetPort}/`,
      }
      const { stdout } = await run('node', ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { pathToFileURL } from 'node:url';
        const { getGlobalDispatcher, setGlobalDispatcher } = await import(pathToFileURL(${JSON.stringify(Bun.resolveSync('undici/index.js', import.meta.dir))}));
        const network = await import(pathToFileURL(process.argv[1]));
        const config = JSON.parse(process.argv[2]);
        // Configure after startup so trust comes from our CA loader.
        process.env.CLAUDE_CODE_CLIENT_CERT = config.cert;
        process.env.CLAUDE_CODE_CLIENT_KEY = config.key;
        if (config.mode !== 'direct' && config.mode !== 'global-direct') process.env.HTTPS_PROXY = config.proxy;
        if (config.mode === 'bypass') process.env.NO_PROXY = '127.0.0.1';
        if (config.mode === 'wildcard-bypass') process.env.NO_PROXY = 'unused.invalid, *.127.0.0.1';
        if (config.mode !== 'http') {
          const untrusted = network.getProxyFetchOptions();
          const untrustedTimeout = network.createCombinedAbortSignal(undefined, { timeoutMs: 2000 });
          try {
            await assert.rejects(fetch(config.url, { ...untrusted, signal: untrustedTimeout.signal }),
              error => { assert.equal(error.cause?.code, 'DEPTH_ZERO_SELF_SIGNED_CERT'); return true; });
          } finally { untrustedTimeout.cleanup(); }
          await untrusted.dispatcher.destroy();
        }
        process.env.NODE_EXTRA_CA_CERTS = config.ca;
        // Fresh helpers invalidate memoized CA/TLS/proxy configuration.
        network.clearCACertsCache();
        network.clearMTLSCache();
        network.clearProxyCache();
        const options = network.getProxyFetchOptions();
        const previousGlobalDispatcher = getGlobalDispatcher();
        const dispatchers = new Set([options.dispatcher]);
        try {
          if (config.mode.startsWith('global')) {
            network.configureGlobalAgents();
            const globalDispatcher = getGlobalDispatcher();
            dispatchers.add(globalDispatcher);
            assert.notEqual(globalDispatcher, previousGlobalDispatcher);
            assert.equal(globalDispatcher === options.dispatcher, config.mode === 'global');
          }
          const trustedTimeout = network.createCombinedAbortSignal(undefined, { timeoutMs: 2000 });
          try {
            const response = await fetch(config.url, {
              ...(config.mode.startsWith('global') ? {} : options), signal: trustedTimeout.signal,
            });
            assert.equal(response.status, 200);
            assert.equal(await response.text(), 'authenticated response');
          } finally { trustedTimeout.cleanup(); }
          // Node 24 uses these v1 callbacks even when Node 26 runs this test.
          const legacyBody = await new Promise((resolve, reject) => {
            let body = '';
            options.dispatcher.dispatch({ origin: config.url, path: '/', method: 'GET' }, {
              onConnect() {},
              onHeaders(status) { assert.equal(status, 200); },
              onData(chunk) { body += chunk.toString(); },
              onComplete() { resolve(body); },
              onError: reject,
            });
          });
          assert.equal(legacyBody, 'authenticated response');
        } finally {
          setGlobalDispatcher(previousGlobalDispatcher);
          await Promise.all([...dispatchers].map(dispatcher => dispatcher.close()));
        }
        console.log('verified');
      `, modulePath, JSON.stringify(config)], { env, timeout: 6000 })
      expect(stdout.trim()).toBe('verified')
      expect(requests).toBe(2)
      expect(authorizedRequests).toBe(mode === 'http' ? 0 : 2)
      expect(connects).toBe(mode === 'http' ? 2 : mode === 'proxy' || mode === 'global' ? 3 : 0)
    } finally {
      for (const socket of sockets) socket.destroy()
      await Promise.all([target, proxy].map(server => new Promise<void>(resolve => {
        server.close(() => resolve())
      })))
    }
  }, 10000)
}
