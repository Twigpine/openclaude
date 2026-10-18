import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { connect } from 'node:net'

import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { startXaiOAuthCallback } from './xaiOAuthCallback.js'
import { XaiOAuthService } from './xaiOAuth.js'

async function startTestServer() {
  const handle = await startXaiOAuthCallback({
    port: 0,
    host: '127.0.0.1',
    callbackPath: '/callback',
    expectedState: 'xyz',
    successTitle: 'xAI OAuth complete',
  })
  return { handle, port: handle.port }
}

type LoopbackResponse = {
  status: number
  headers: Record<string, string>
  body: string
}

async function requestLoopback(
  port: number,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs?: number
  } = {},
): Promise<LoopbackResponse> {
  const method = options.method ?? 'GET'
  const body = options.body ?? ''
  const timeoutMs = options.timeoutMs ?? 2_000
  const headers = {
    Host: `127.0.0.1:${port}`,
    Connection: 'close',
    ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}),
    ...options.headers,
  }
  const requestText = [
    `${method} ${path} HTTP/1.1`,
    ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
    '',
    body,
  ].join('\r\n')

  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    let settled = false

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(timeoutMs)

    socket.on('connect', () => {
      socket.write(requestText)
    })
    socket.on('data', chunk => {
      chunks.push(Buffer.from(chunk))
    })
    socket.on('timeout', () => {
      fail(new Error(`Loopback request timed out after ${timeoutMs}ms`))
    })
    socket.on('error', fail)
    socket.on('end', () => {
      if (settled) return
      settled = true
      const raw = Buffer.concat(chunks).toString('utf8')
      const [head, ...bodyParts] = raw.split('\r\n\r\n')
      const [statusLine, ...headerLines] = head.split('\r\n')
      const status = Number(statusLine.split(' ')[1] ?? 0)
      const responseHeaders: Record<string, string> = {}
      for (const line of headerLines) {
        const separator = line.indexOf(':')
        if (separator < 0) continue
        responseHeaders[line.slice(0, separator).toLowerCase()] = line
          .slice(separator + 1)
          .trim()
      }
      resolve({
        status,
        headers: responseHeaders,
        body: bodyParts.join('\r\n\r\n'),
      })
    })
  })
}

describe.serial('startXaiOAuthCallback (CORS-aware loopback for xAI auth)', () => {
  let cleanup: (() => void) | null = null

  beforeEach(async () => {
    await acquireSharedMutationLock('xaiOAuthCallback.test.ts')
    cleanup = null
  })

  afterEach(() => {
    try {
      cleanup?.()
      cleanup = null
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('OPTIONS preflight from auth.x.ai returns 204 with CORS echo', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://auth.x.ai',
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://auth.x.ai',
    )
    const allowMethods = res.headers['access-control-allow-methods'] ?? ''
    expect(allowMethods).toContain('GET')
    // Don't leak the callback resolution to OPTIONS — the wait promise
    // shouldn't have settled.
    let settled = false
    void handle.waitForCallback().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(20)
    expect(settled).toBe(false)
  })

  // Without this header, Chrome/Edge block xAI's HTTPS-origin fetch to
  // the loopback callback. The preflight succeeds, the actual GET never
  // fires, the CLI never auto-detects success, and the user has to fall
  // back to manual code paste. Regression-locked because this is silent
  // — the only symptom is "auto-detect doesn't work".
  test('OPTIONS preflight includes Access-Control-Allow-Private-Network', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://auth.x.ai',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Private-Network': 'true',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-private-network']).toBe(
      'true',
    )
  })

  test('OPTIONS from accounts.x.ai is also allowed', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: { Origin: 'https://accounts.x.ai' },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://accounts.x.ai',
    )
  })

  test('OPTIONS from untrusted origin gets 204 but no CORS headers', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example.com' },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('OPTIONS from http (non-https) x.ai is rejected', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: { Origin: 'http://auth.x.ai' },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('OPTIONS from subdomain-spoof (auth.x.ai.evil.example.com) is rejected', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'OPTIONS',
      headers: { Origin: 'https://auth.x.ai.evil.example.com' },
    })
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  test('GET /callback?code=&state= resolves waitForCallback with both', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const callbackPromise = handle.waitForCallback()
    const res = await requestLoopback(
      port,
      '/callback?code=ABC123&state=xyz',
      { headers: { Origin: 'https://auth.x.ai' } },
    )
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://auth.x.ai',
    )
    const result = await callbackPromise
    expect(result).toEqual({ code: 'ABC123', state: 'xyz' })
  })

  test('GET with a matching state and OAuth error rejects with a clear message', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const callbackPromise = handle.waitForCallback()
    const res = await requestLoopback(port, '/callback?error=access_denied&state=xyz')
    expect(res.status).toBe(400)
    await expect(callbackPromise).rejects.toThrow(/access_denied/)
  })

  for (const query of [
    'error=access_denied',
    'error=access_denied&state=wrong',
    'error=access_denied&state=',
    'code=forged&state=wrong',
    'code=forged',
    'state=wrong',
    '',
    'code=forged&state=%20xyz%20',
  ]) {
    test(`invalid state does not consume the callback: ${query || '(empty query)'}`, async () => {
      const { handle, port } = await startTestServer()
      cleanup = () => handle.close()
      let settled = false
      const callbackPromise = handle.waitForCallback()
      void callbackPromise.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        },
      )

      const rejected = await requestLoopback(port, `/callback?${query}`)
      expect(rejected.status).toBe(400)
      expect(settled).toBe(false)

      const accepted = await requestLoopback(
        port,
        '/callback?code=legitimate&state=xyz',
      )
      expect(accepted.status).toBe(200)
      await expect(callbackPromise).resolves.toEqual({
        code: 'legitimate',
        state: 'xyz',
      })
    })
  }

  for (const completion of ['callback', 'manual', 'cancel'] as const) {
    test(`OAuth service survives an invalid request before ${completion}`, async () => {
      const exchangedCodes: string[] = []
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
        Object.assign(
          async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = String(input)
            if (url.endsWith('/.well-known/openid-configuration')) {
              return Response.json({
                authorization_endpoint: 'https://auth.x.ai/authorize',
                token_endpoint: 'https://auth.x.ai/token',
              })
            }
            expect(url).toBe('https://auth.x.ai/token')
            const body = new URLSearchParams(String(init?.body))
            exchangedCodes.push(body.get('code') ?? '')
            return Response.json({
              access_token: 'test-access',
              refresh_token: 'test-refresh',
            })
          },
          { preconnect: globalThis.fetch.preconnect },
        ),
      )
      const service = new XaiOAuthService({
        callbackPort: 0,
        callbackHost: '127.0.0.1',
      })
      try {
        const flow = await service.beginOAuthFlow()
        const authUrl = new URL(flow.authUrl)
        const state = authUrl.searchParams.get('state')!
        const redirect = new URL(authUrl.searchParams.get('redirect_uri')!)
        const pending = flow.waitForTokens()
        let settled = false
        void pending.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        const invalid = await requestLoopback(
          Number(redirect.port),
          '/callback?error=access_denied',
        )
        expect(invalid.status).toBe(400)
        expect(settled).toBe(false)
        expect(exchangedCodes).toEqual([])

        if (completion === 'cancel') {
          flow.cancel()
          await expect(pending).rejects.toThrow(/cancelled|closed/)
          expect(exchangedCodes).toEqual([])
        } else {
          if (completion === 'callback') {
            const res = await requestLoopback(
              Number(redirect.port),
              `/callback?code=legitimate&state=${encodeURIComponent(state)}`,
            )
            expect(res.status).toBe(200)
          } else {
            flow.submitManualCode('legitimate')
          }
          expect((await pending).accessToken).toBe('test-access')
          expect(exchangedCodes).toEqual(['legitimate'])
        }
      } finally {
        service.cleanup()
        fetchSpy.mockRestore()
      }
    })
  }

  test('GET to wrong path returns 404 and does not settle the callback', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/something-else')
    expect(res.status).toBe(404)

    let settled = false
    void handle.waitForCallback().then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await Bun.sleep(20)
    expect(settled).toBe(false)
  })

  test('POST to /callback returns 405 with Allow header', async () => {
    const { handle, port } = await startTestServer()
    cleanup = () => handle.close()

    const res = await requestLoopback(port, '/callback', {
      method: 'POST',
      body: 'code=ABC&state=xyz',
    })
    expect(res.status).toBe(405)
    expect(res.headers.allow ?? '').toContain('GET')
  })

  test('successTitle is HTML-escaped in the success page', async () => {
    const handle = await startXaiOAuthCallback({
      port: 0,
      host: '127.0.0.1',
      callbackPath: '/callback',
      expectedState: 'B',
      successTitle: '<script>alert(1)</script>',
    })
    cleanup = () => handle.close()

    const callbackPromise = handle.waitForCallback()
    const res = await requestLoopback(handle.port, '/callback?code=A&state=B')
    const body = res.body
    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
    await callbackPromise
  })

  test('close() before callback rejects waitForCallback', async () => {
    const { handle } = await startTestServer()
    const callbackPromise = handle.waitForCallback()
    // Attach a no-op catch FIRST so the microtask rejection doesn't surface
    // as unhandled before the assertion is in place.
    callbackPromise.catch(() => undefined)
    handle.close()
    await expect(callbackPromise).rejects.toThrow(/closed/)
  })
})
