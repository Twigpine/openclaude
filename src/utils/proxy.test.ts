import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { snapshotEnv } from '../test/envSnapshot.js'
import { clearCACertsCache } from './caCerts.js'
import { clearMTLSCache } from './mtls.js'
import { shouldBypassProxy } from './proxy.js'

// Other suites can leave a process-wide axios mock behind. Give this copy of
// proxy.ts and the global-client test the same real axios, without registering
// a global mock. Keep other imports external so CA/mTLS caches stay shared.
const axiosPath = `${require.resolve('axios')}?connect=${Date.now()}-${Math.random()}`
const { default: axios } = await import(axiosPath) as typeof import('axios')
const proxyBuild = await Bun.build({
  entrypoints: [join(import.meta.dir, 'proxy.ts')],
  target: 'bun',
  plugins: [{
    name: 'connect-test-real-axios',
    setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        if (!args.importer) return
        return {
          path: args.path === 'axios'
            ? axiosPath
            : Bun.resolveSync(args.path, args.resolveDir),
          external: true,
        }
      })
    },
  }],
})
if (!proxyBuild.success) {
  throw new AggregateError(proxyBuild.logs, 'Could not build proxy.ts for CONNECT tests')
}
const { clearProxyCache, configureGlobalAgents, createAxiosInstance } = await import(
  `data:text/javascript;base64,${Buffer.from(await proxyBuild.outputs[0].text()).toString('base64')}`
) as typeof import('./proxy.js')

describe('runtime CA certificates through CONNECT', () => {
  test.each(['instance', 'global'] as const)('%s axios trusts a runtime CA', async path => {
    const restoreEnv = snapshotEnv([
      'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy',
      'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS',
      'CLAUDE_CODE_CLIENT_CERT', 'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE', 'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
    ], { clear: true })
    const defaults = {
      proxy: axios.defaults.proxy,
      httpAgent: axios.defaults.httpAgent,
      httpsAgent: axios.defaults.httpsAgent,
    }
    const dispatcher = getGlobalDispatcher()
    const directory = mkdtempSync(join(tmpdir(), 'proxy-ca-'))
    const sockets = new Set<Socket>()
    const proxy = createHttpServer()
    let target: ReturnType<typeof createHttpsServer> | undefined
    let connectCount = 0
    let instance: ReturnType<typeof createAxiosInstance> | undefined

    try {
      const certFile = join(directory, 'cert.pem')
      const keyFile = join(directory, 'key.pem')
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
        '-keyout', keyFile, '-out', certFile,
      ], { stdio: 'ignore', timeout: 5000 })
      target = createHttpsServer({
        cert: readFileSync(certFile),
        key: readFileSync(keyFile),
      }, (_req, res) => res.end('trusted target'))
      for (const server of [proxy, target]) {
        server.on('connection', socket => {
          sockets.add(socket)
          socket.on('close', () => sockets.delete(socket))
        })
      }
      await new Promise<void>(resolve => target!.listen(0, '127.0.0.1', resolve))
      const targetPort = (target.address() as AddressInfo).port
      proxy.on('connect', (req, client, head) => {
        connectCount++
        const upstream = connect(targetPort, '127.0.0.1', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.write(head)
          client.pipe(upstream).pipe(client)
        })
        sockets.add(upstream)
        upstream.on('close', () => {
          sockets.delete(upstream)
          client.destroy()
        })
        client.on('close', () => upstream.destroy())
        client.on('error', () => upstream.destroy())
        upstream.on('error', () => client.destroy())
        expect(req.url).toBe(`localhost:${targetPort}`)
      })
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
      process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
      // Applied after boot, just like settings loaded by caCertsConfig.ts.
      process.env.NODE_EXTRA_CA_CERTS = certFile
      clearCACertsCache()
      clearMTLSCache()
      clearProxyCache()

      if (path === 'global') configureGlobalAgents()
      else instance = createAxiosInstance()
      const response = await (instance ?? axios).get(`https://localhost:${targetPort}/`, {
        adapter: 'http',
        timeout: 3000,
      })
      expect(response.status).toBe(200)
      expect(response.data).toBe('trusted target')
      expect(connectCount).toBe(1)
    } finally {
      instance?.defaults.httpsAgent?.destroy()
      for (const socket of sockets) socket.destroy()
      await Promise.all([proxy, ...(target ? [target] : [])].map(server => new Promise<void>(resolve => {
        server.close(() => resolve())
      })))
      const testDispatcher = getGlobalDispatcher()
      delete process.env.HTTPS_PROXY
      delete process.env.NODE_EXTRA_CA_CERTS
      clearCACertsCache()
      clearMTLSCache()
      clearProxyCache()
      configureGlobalAgents() // Eject the test's global axios interceptor.
      Object.assign(axios.defaults, defaults)
      setGlobalDispatcher(dispatcher)
      if (testDispatcher !== dispatcher) await testDispatcher.close?.()
      restoreEnv()
      clearCACertsCache()
      clearMTLSCache()
      rmSync(directory, { recursive: true, force: true })
    }
    // Allow time for the 5s OpenSSL deadline plus requests and cleanup.
  }, 15000)
})

describe('shouldBypassProxy — NO_PROXY matching', () => {
  test('bare domain bypasses the domain and its subdomains', () => {
    // Regression: a bare NO_PROXY entry matched the host exactly only, so a
    // subdomain went THROUGH the proxy on the axios/WebSocket path even though
    // the fetch/undici path (undici EnvHttpProxyAgent, driven by getProxyAgent
    // in this same module) bypasses subdomains for a bare entry. The two paths
    // must agree for the same env var.
    expect(shouldBypassProxy('https://example.com/x', 'example.com')).toBe(true)
    expect(shouldBypassProxy('https://api.example.com/x', 'example.com')).toBe(
      true,
    )
    expect(
      shouldBypassProxy('https://a.b.example.com/x', 'example.com'),
    ).toBe(true)
  })

  test('a lookalike domain is not matched by a bare entry', () => {
    // The subdomain arm requires the leading dot, so a suffix that is not a
    // real subdomain boundary must not bypass.
    expect(shouldBypassProxy('https://notexample.com/x', 'example.com')).toBe(
      false,
    )
    expect(
      shouldBypassProxy('https://example.com.evil.test/x', 'example.com'),
    ).toBe(false)
  })

  test('leading-dot entry keeps matching the apex and subdomains', () => {
    expect(shouldBypassProxy('https://example.com/x', '.example.com')).toBe(
      true,
    )
    expect(shouldBypassProxy('https://api.example.com/x', '.example.com')).toBe(
      true,
    )
    expect(shouldBypassProxy('https://notexample.com/x', '.example.com')).toBe(
      false,
    )
  })

  test('exact host and wildcard still work; empty NO_PROXY never bypasses', () => {
    expect(shouldBypassProxy('http://localhost:3000/x', 'localhost')).toBe(true)
    expect(shouldBypassProxy('https://anything.test/x', '*')).toBe(true)
    expect(shouldBypassProxy('https://example.com/x', undefined)).toBe(false)
    expect(shouldBypassProxy('https://example.com/x', '')).toBe(false)
  })

  test('an IP-address entry is not widened into a subdomain suffix match', () => {
    expect(shouldBypassProxy('https://127.0.0.1/x', '127.0.0.1')).toBe(true)
    // A host that merely ends with the IP text is not a subdomain of it.
    expect(shouldBypassProxy('https://x127.0.0.1/x', '127.0.0.1')).toBe(false)
    // A host whose final label is all-numeric (e.g. `10.1.2.3.4`) is not a valid
    // WHATWG URL — `new URL()` attempts an IPv4 parse and throws — so it can
    // never reach the bare-domain suffix arm. The would-be dotted-IP subdomain
    // of `1.2.3.4` therefore does not bypass, on the reject-on-parse-failure path.
    expect(shouldBypassProxy('https://10.1.2.3.4/x', '1.2.3.4')).toBe(false)
    // Bracketed IPv6 literals match exactly, not by suffix.
    expect(shouldBypassProxy('https://[::1]/x', '[::1]')).toBe(true)
  })

  test('port-specific entries require a matching port and cover subdomains', () => {
    expect(
      shouldBypassProxy('https://example.com:8080/x', 'example.com:8080'),
    ).toBe(true)
    expect(
      shouldBypassProxy('https://example.com:9090/x', 'example.com:8080'),
    ).toBe(false)
    // Once the port matches, the same exact-or-subdomain host predicate applies
    // (aligning with undici), so a subdomain on the right port bypasses too.
    expect(
      shouldBypassProxy('https://api.example.com:8080/x', 'example.com:8080'),
    ).toBe(true)
    // Right host, wrong port must not bypass.
    expect(
      shouldBypassProxy('https://api.example.com:9090/x', 'example.com:8080'),
    ).toBe(false)
  })

  test('leading-wildcard entries are normalized like undici (`*.example.com`)', () => {
    expect(
      shouldBypassProxy('https://api.example.com/x', '*.example.com'),
    ).toBe(true)
    expect(shouldBypassProxy('https://example.com/x', '*.example.com')).toBe(
      true,
    )
    expect(
      shouldBypassProxy('https://notexample.com/x', '*.example.com'),
    ).toBe(false)
  })
})
