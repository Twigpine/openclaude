/**
 * Loopback HTTP server that receives the xAI OAuth redirect.
 *
 * Unlike OpenClaude's general `AuthCodeListener`, this one explicitly answers
 * CORS preflight (`OPTIONS`) for the xAI auth origins (`auth.x.ai`,
 * `accounts.x.ai`). xAI's web client pushes the authorization code to the
 * loopback URL via a browser-side fetch; without echoing CORS the browser
 * blocks the push and the auth page falls back to "Could not establish
 * connection". This mirrors openclaw's `waitForLocalOAuthCallback`.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    ch =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[ch] ?? ch,
  )
}

export type XaiOAuthCallbackResult = {
  code: string
  state: string
}

export type XaiOAuthCallbackHandle = {
  port: number
  /** Resolves with the code+state once xAI hits the loopback. */
  waitForCallback: () => Promise<XaiOAuthCallbackResult>
  close: () => void
}

const DEFAULT_CORS_ALLOWLIST = ['auth.x.ai', 'accounts.x.ai'] as const

function isAllowedOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!origin) return false
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return allowlist.some(allowed => host === allowed)
  } catch {
    return false
  }
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowlist: readonly string[],
): void {
  const origin = typeof req.headers.origin === 'string'
    ? req.headers.origin
    : undefined
  if (!isAllowedOrigin(origin, allowlist)) return
  res.setHeader('Access-Control-Allow-Origin', origin!)
  res.setHeader(
    'Vary',
    'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  )
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  const requestedHeaders = req.headers['access-control-request-headers']
  res.setHeader(
    'Access-Control-Allow-Headers',
    typeof requestedHeaders === 'string' && requestedHeaders.trim().length > 0
      ? requestedHeaders
      : 'content-type',
  )
  // Chrome / Edge require this header when an HTTPS origin (auth.x.ai)
  // fetches a private-network address (127.0.0.1). Without it the
  // preflight succeeds but the actual GET is blocked, our server never
  // receives the callback, and xAI's auth page falls back to manual code
  // paste even though sign-in succeeded. See:
  // https://wicg.github.io/private-network-access/
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Access-Control-Max-Age', '600')
}

export async function startXaiOAuthCallback(params: {
  port: number
  host: string
  callbackPath: string
  expectedState: string
  successTitle?: string
  corsOriginAllowlist?: readonly string[]
}): Promise<XaiOAuthCallbackHandle> {
  const allowlist = params.corsOriginAllowlist ?? DEFAULT_CORS_ALLOWLIST
  const successTitle = params.successTitle ?? 'xAI OAuth complete'

  let resolveCallback:
    | ((result: XaiOAuthCallbackResult) => void)
    | null = null
  let rejectCallback: ((error: Error) => void) | null = null
  let settled = false

  const callbackPromise = new Promise<XaiOAuthCallbackResult>(
    (resolve, reject) => {
      resolveCallback = resolve
      rejectCallback = reject
    },
  )
  // Install a no-op rejection guard so closing the server before anyone has
  // awaited the callback (e.g. cancel() during cleanup) doesn't surface as
  // an unhandled rejection. Real awaiters still see the rejection via .then
  // / await; this only neutralizes the "no listener attached yet" case.
  callbackPromise.catch(() => undefined)

  function settle(
    next: () => void,
    handler: () => void,
  ): void {
    if (settled) return
    settled = true
    try {
      handler()
    } finally {
      next()
    }
  }

  const server = createServer((req, res) => {
    try {
      applyCors(req, res, allowlist)
      const url = new URL(req.url ?? '/', `http://${params.host}:${params.port}`)

      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }

      if (url.pathname !== params.callbackPath) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain')
        res.end('Not found')
        return
      }

      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('Allow', 'GET, OPTIONS')
        res.setHeader('Content-Type', 'text/plain')
        res.end('Method not allowed')
        return
      }

      // Unauthenticated requests must not consume the pending OAuth flow.
      // Check the exact state before either error or code can settle it.
      const state = url.searchParams.get('state')
      if (!state || state !== params.expectedState) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.end('Invalid state')
        return
      }

      const error = url.searchParams.get('error')
      if (error) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.end(`Authentication failed: ${error}`)
        settle(
          () => undefined,
          () => rejectCallback?.(new Error(`xAI OAuth error: ${error}`)),
        )
        return
      }

      const code = url.searchParams.get('code')?.trim()

      if (!code) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain')
        res.end('Missing code or state')
        settle(
          () => undefined,
          () => rejectCallback?.(new Error('xAI OAuth callback missing code or state')),
        )
        return
      }

      const safeTitle = escapeHtml(successTitle)
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"/><title>${safeTitle}</title></head>` +
          `<body style="font-family:sans-serif;padding:32px;line-height:1.5;color:#111827">` +
          `<h1 style="margin:0 0 12px;font-size:22px">${safeTitle}</h1>` +
          `<p>You can return to OpenClaude — the CLI will finish setup automatically.</p>` +
          `</body></html>`,
      )
      settle(
        () => undefined,
        () => resolveCallback?.({ code, state }),
      )
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      settle(
        () => undefined,
        () => rejectCallback?.(wrapped),
      )
    }
  })

  let boundPort = params.port
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(params.port, params.host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      if (address && typeof address === 'object') {
        boundPort = address.port
      }
      resolve()
    })
  })

  server.on('error', err => {
    if (!settled) {
      rejectCallback?.(err)
    }
  })

  return {
    port: boundPort,
    waitForCallback: () => callbackPromise,
    close: () => {
      if (!settled) {
        settled = true
        rejectCallback?.(new Error('xAI OAuth callback server closed.'))
      }
      try {
        server.close()
      } catch {
        // ignore
      }
    },
  }
}
