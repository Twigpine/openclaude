import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import {
  createServer as createHttpsServer,
  get,
  request,
  type RequestOptions,
} from 'node:https'
import { connect, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { snapshotEnv } from '../test/envSnapshot.js'
import { clearCACertsCache } from './caCerts.js'
import { clearMTLSCache, getMTLSAgent, getWebSocketTLSOptions } from './mtls.js'

// Cache-busting proxy.ts alone still imports any leaked global Axios mock.
// Build a fresh copy of the production module with only its Axios import
// redirected to the real CommonJS entry. Keep the other imports external so
// CA/mTLS caches stay shared, without changing any global mock registration.
const nonce = `${Date.now()}-${Math.random()}`
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
            ? `${require.resolve('axios')}?real=${nonce}`
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
const { createAxiosInstance, getWebSocketProxyAgent } = await import(
  `data:text/javascript;base64,${Buffer.from(await proxyBuild.outputs[0].text()).toString('base64')}`
) as typeof import('./proxy.js')

// Self-signed test certificate and key, valid only for the loopback target.
const cert = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUAtOYg4xV7C9catkY/bwZc7XywMgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAyNDA4NTUxNloYDzIxMjYwOTMw
MDg1NTE2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAS5HiqEES/b1Oe+NOKT+Cg3Gh89Rk0O7bSu0aDJpwdMzOxgOT2jTBmK
2H5TUBnDWHjLktPtbmQQ4nMAb1kD4oKWo28wbTAdBgNVHQ4EFgQUu+xqnGfB/gu8
DbNNHlVonV69Y64wHwYDVR0jBBgwFoAUu+xqnGfB/gu8DbNNHlVonV69Y64wDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgPy5jbT1ECH7LFy5r5JrV7xfsOkhwtbuwqVeidDBynFACIQCp
sTyTz0llkGsTStOnpDBTzTUQzcDT8z6ZgqqxbY29nw==
-----END CERTIFICATE-----`
const key = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgXc/iw7bBMrZkWHsr
tDvMDJ6qPLsspu6IH8lHZ3ccGvihRANCAAS5HiqEES/b1Oe+NOKT+Cg3Gh89Rk0O
7bSu0aDJpwdMzOxgOT2jTBmK2H5TUBnDWHjLktPtbmQQ4nMAb1kD4oKW
-----END PRIVATE KEY-----`

describe('HTTPS_PROXY CONNECT transport', () => {
  let restoreEnv: () => void
  let directory: string
  const sockets = new Set<Duplex>()
  let target: ReturnType<typeof createHttpsServer>
  let proxy: ReturnType<typeof createHttpServer>
  let targetUrl: string
  let connects: string[]

  beforeEach(async () => {
    restoreEnv = snapshotEnv([
      'HTTPS_PROXY',
      'https_proxy',
      'HTTP_PROXY',
      'http_proxy',
      'NO_PROXY',
      'no_proxy',
      'NODE_EXTRA_CA_CERTS',
      'NODE_OPTIONS',
      'NODE_TLS_REJECT_UNAUTHORIZED',
      'CLAUDE_CODE_CLIENT_CERT',
      'CLAUDE_CODE_CLIENT_KEY',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
    ], { clear: true })
    directory = mkdtempSync(join(tmpdir(), 'proxy-connect-'))
    const caPath = join(directory, 'ca.pem')
    writeFileSync(caPath, cert)
    process.env.NODE_EXTRA_CA_CERTS = caPath
    clearCACertsCache()
    clearMTLSCache()
    connects = []

    target = createHttpsServer({ key, cert }, (_request, response) => {
      response.end('secure response')
    })
    target.listen(0, '127.0.0.1')
    await once(target, 'listening')
    const targetPort = (target.address() as AddressInfo).port
    targetUrl = `https://127.0.0.1:${targetPort}/test`

    proxy = createHttpServer()
    proxy.on('connect', (request, client, head) => {
      connects.push(request.url!)
      // Forward only to this test's target; assert the CONNECT authority below.
      const upstream = connect(targetPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      sockets.add(client)
      sockets.add(upstream)
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    getMTLSAgent()?.destroy()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    target?.closeAllConnections()
    await Promise.all(
      [target, proxy].filter(Boolean).map(server =>
        new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve())
        }),
      ),
    )
    restoreEnv()
    clearCACertsCache()
    clearMTLSCache()
    rmSync(directory, { recursive: true, force: true })
  })

  test('Axios tunnels HTTPS through HTTPS_PROXY and bypasses it for NO_PROXY', async () => {
    const client = createAxiosInstance()
    // Native TLS reads NODE_EXTRA_CA_CERTS only at startup. Pass the runtime
    // CA loader's result to the target request; agent options configure the proxy.
    client.defaults.transport = {
      request: (
        options: RequestOptions,
        callback: (response: IncomingMessage) => void,
      ) => request({ ...options, ...getWebSocketTLSOptions() }, callback),
    }
    const response = await client.get(targetUrl, { timeout: 3000 })
    expect(response.data).toBe('secure response')
    expect(connects).toEqual([new URL(targetUrl).host])

    process.env.NO_PROXY = '127.0.0.1'
    const direct = await client.get(targetUrl, { timeout: 3000 })
    expect(direct.data).toBe('secure response')
    expect(connects).toHaveLength(1)
  })

  test('WebSocket agent tunnels HTTPS and is omitted for NO_PROXY', async () => {
    const agent = getWebSocketProxyAgent(targetUrl.replace('https:', 'wss:'))
    expect(agent).toBeDefined()
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const request = get(
          targetUrl,
          { agent, ...getWebSocketTLSOptions() },
          response => {
            response.setEncoding('utf8')
            let data = ''
            response.on('data', chunk => { data += chunk })
            response.on('end', () => resolve(data))
            response.on('error', reject)
          },
        )
        request.on('error', reject)
        request.setTimeout(3000, () =>
          request.destroy(new Error('HTTPS request timed out')),
        )
      })
      expect(body).toBe('secure response')
      expect(connects).toEqual([new URL(targetUrl).host])
      process.env.NO_PROXY = '127.0.0.1'
      expect(getWebSocketProxyAgent(targetUrl.replace('https:', 'wss:'))).toBeUndefined()
    } finally {
      agent?.destroy()
    }
  })
})
