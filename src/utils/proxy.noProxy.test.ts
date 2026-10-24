import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
let directory: string
let modulePath: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'proxy-no-proxy-'))
  modulePath = join(directory, 'network.mjs')
  const entrypoint = join(directory, 'entry.ts')
  await writeFile(entrypoint, `
    export { getProxyAgent, getNoProxy, shouldBypassProxy, configureGlobalAgents, clearProxyCache } from ${JSON.stringify(join(import.meta.dir, 'proxy.ts'))};
    export { StructuredIO } from ${JSON.stringify(join(import.meta.dir, '../cli/structuredIO.ts'))};
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
