import assert from 'node:assert/strict'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

import {
  appendBoundedMcpStderr,
  attachMcpRequestCancellationHandler,
  buildMcpSseEventSourceHeaders,
  buildMcpSseRequestHeaders,
  cleanupFailedConnection,
  buildMcpStdioCommand,
  logMcpServerStderr,
  wrapFetchWithRequestCancellation,
} from './client.js'
import { wrapFetchWithStepUpDetection } from './auth.js'
import {
  _resetErrorLogForTesting,
  attachErrorLogSink,
  type ErrorLogSink,
} from '../../utils/log.js'

function withCapturedMcpLogEvents(
  fn: (events: Array<['debug' | 'error', string, unknown]>) => void,
): void {
  const events: Array<['debug' | 'error', string, unknown]> = []
  const sink: ErrorLogSink = {
    logError: error => events.push(['error', 'global', error]),
    logMCPError: (serverName, error) =>
      events.push(['error', serverName, error]),
    logMCPDebug: (serverName, message) =>
      events.push(['debug', serverName, message]),
    getErrorsPath: () => '/tmp/errors.log',
    getMCPLogsPath: serverName => `/tmp/${serverName}.log`,
  }

  _resetErrorLogForTesting()
  try {
    attachErrorLogSink(sink)
    fn(events)
  } finally {
    _resetErrorLogForTesting()
  }
}

test('buildMcpSseEventSourceHeaders preserves a refreshed Headers bearer', () => {
  const headers = buildMcpSseEventSourceHeaders(
    new Headers({
      Authorization: 'Bearer refreshed-access-secret',
      'User-Agent': 'custom-agent',
      Accept: 'application/json',
    }),
  )

  assert.equal(headers.get('Authorization'), 'Bearer refreshed-access-secret')
  assert.equal(headers.get('User-Agent'), 'custom-agent')
  assert.equal(headers.get('Accept'), 'text/event-stream')
})

test('buildMcpSseRequestHeaders preserves SDK headers and explicit precedence', () => {
  const sdkHeaders = new Headers({
    Authorization: 'Bearer sdk-stale-secret',
    'MCP-Protocol-Version': '2025-06-18',
  })
  const providerHeaders = buildMcpSseRequestHeaders(sdkHeaders, {
    'X-Configured': 'configured-value',
  })
  const explicitHeaders = buildMcpSseRequestHeaders(sdkHeaders, {
    Authorization: 'Bearer configured-secret',
  })

  assert.equal(providerHeaders.get('Authorization'), 'Bearer sdk-stale-secret')
  assert.equal(providerHeaders.get('MCP-Protocol-Version'), '2025-06-18')
  assert.equal(providerHeaders.get('X-Configured'), 'configured-value')
  assert.equal(
    explicitHeaders.get('Authorization'),
    'Bearer configured-secret',
  )
})

function makeNeedsAuthTransportFixture() {
  const resourceUrl = 'https://mcp.example.test/mcp'
  const resourceMetadataUrl =
    'https://mcp.example.test/.well-known/oauth-protected-resource'
  const authorizationServerUrl = 'https://auth.example.test'
  let resourceAuthorization: string | null = null
  let metadataAuthorization: string | null = null
  let redirectCalls = 0
  const provider = {
    redirectUrl: 'http://127.0.0.1:31337/callback',
    clientMetadata: {
      client_name: 'OpenClaude test',
      redirect_uris: ['http://127.0.0.1:31337/callback'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientInformation: async () => ({ client_id: 'test-client' }),
    tokens: async () => undefined,
    state: async () => 'test-state',
    saveCodeVerifier: async () => {},
    redirectToAuthorization: async () => {
      redirectCalls++
    },
    prepareRequest: async () => ({ access_token: 'resource-access-secret' }),
    refreshAfterUnauthorized: async () => undefined,
    markStepUpPending: () => {},
  }
  const baseFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input.toString()
    const authorization = new Headers(init?.headers).get('Authorization')
    if (url === resourceUrl) {
      resourceAuthorization = authorization
      return new Response(null, {
        status: 401,
        headers: {
          'WWW-Authenticate':
            `Bearer resource_metadata="${resourceMetadataUrl}"`,
        },
      })
    }
    metadataAuthorization = authorization
    if (url === resourceMetadataUrl) {
      return Response.json({
        resource: resourceUrl,
        authorization_servers: [authorizationServerUrl],
      })
    }
    if (
      url ===
      `${authorizationServerUrl}/.well-known/oauth-authorization-server`
    ) {
      return Response.json({
        issuer: authorizationServerUrl,
        authorization_endpoint: `${authorizationServerUrl}/authorize`,
        token_endpoint: `${authorizationServerUrl}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    return new Response(null, { status: 404 })
  }
  const wrappedFetch = wrapFetchWithStepUpDetection(
    baseFetch,
    provider as never,
    { resourceUrl, providerOwnsAuthorization: true },
  )
  return {
    provider,
    resourceUrl,
    wrappedFetch,
    getResourceAuthorization: () => resourceAuthorization,
    getMetadataAuthorization: () => metadataAuthorization,
    getRedirectCalls: () => redirectCalls,
  }
}

test('HTTP failed recovery reaches UnauthorizedError without leaking the resource bearer to OAuth metadata', async () => {
  const fixture = makeNeedsAuthTransportFixture()
  const transport = new StreamableHTTPClientTransport(
    new URL(fixture.resourceUrl),
    {
      authProvider: fixture.provider as never,
      fetch: fixture.wrappedFetch,
    },
  )
  await transport.start()
  try {
    await assert.rejects(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      UnauthorizedError,
    )
  } finally {
    await transport.close()
  }

  assert.equal(fixture.getMetadataAuthorization(), null)
  assert.equal(
    fixture.getResourceAuthorization(),
    'Bearer resource-access-secret',
  )
  assert.equal(fixture.getRedirectCalls(), 1)
})

test('SSE failed recovery reaches UnauthorizedError without leaking the resource bearer to OAuth metadata', async () => {
  const fixture = makeNeedsAuthTransportFixture()
  const transport = new SSEClientTransport(new URL(fixture.resourceUrl), {
    authProvider: fixture.provider as never,
    fetch: fixture.wrappedFetch,
    eventSourceInit: { fetch: fixture.wrappedFetch },
  })
  try {
    await assert.rejects(transport.start(), UnauthorizedError)
  } finally {
    await transport.close()
  }

  assert.equal(fixture.getMetadataAuthorization(), null)
  assert.equal(
    fixture.getResourceAuthorization(),
    'Bearer resource-access-secret',
  )
  assert.equal(fixture.getRedirectCalls(), 1)
})

test('timed-out Streamable HTTP tool calls cancel the response stream after headers', async () => {
  const activeRequests = new Map<string | number, AbortController>()
  let streamCancelled = false
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === 'GET') {
        return new Response(null, { status: 405 })
      }
      const text = await request.text()
      if (!text) return new Response(null, { status: 202 })
      const payload = JSON.parse(text) as { id: number; method: string }
      if (payload.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            serverInfo: { name: 'timeout-stream-test', version: '1.0.0' },
          },
        })
      }
      if (payload.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (payload.method === 'tools/call') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {},
            cancel() {
              streamCancelled = true
            },
          }),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.port}/mcp`),
    {
      fetch: wrapFetchWithRequestCancellation(fetch, activeRequests),
    },
  )
  attachMcpRequestCancellationHandler(transport, activeRequests)
  const client = new Client({ name: 'timeout-test', version: '1.0.0' })

  try {
    await client.connect(transport)
    await assert.rejects(
      client.callTool(
        { name: 'slow-tool', arguments: {} },
        CallToolResultSchema,
        { timeout: 20 },
      ),
    )

    const cancellationDeadline = Date.now() + 1_000
    while (
      (!streamCancelled || activeRequests.size !== 0) &&
      Date.now() < cancellationDeadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(streamCancelled, true)
    assert.equal(activeRequests.size, 0)
  } finally {
    await client.close()
    server.stop(true)
  }
})

test('cleanupFailedConnection awaits transport close before resolving', async () => {
  let closed = false
  let resolveClose: (() => void) | undefined

  const transport = {
    close: async () =>
      await new Promise<void>(resolve => {
        resolveClose = () => {
          closed = true
          resolve()
        }
      }),
  }

  const cleanupPromise = cleanupFailedConnection(transport)

  assert.equal(closed, false)
  resolveClose?.()
  await cleanupPromise
  assert.equal(closed, true)
})

test('cleanupFailedConnection closes in-process server and transport', async () => {
  let inProcessClosed = false
  let transportClosed = false

  const inProcessServer = {
    close: async () => {
      inProcessClosed = true
    },
  }

  const transport = {
    close: async () => {
      transportClosed = true
    },
  }

  await cleanupFailedConnection(transport, inProcessServer)

  assert.equal(inProcessClosed, true)
  assert.equal(transportClosed, true)
})

test('successful MCP startup stderr is logged as debug, not error', () => {
  withCapturedMcpLogEvents(events => {
    logMcpServerStderr(
      'context7',
      'Context7 Documentation MCP Server running on stdio',
      true,
    )

    assert.deepEqual(events, [
      [
        'debug',
        'context7',
        'Server stderr: Context7 Documentation MCP Server running on stdio',
      ],
    ])
  })
})

test('failed MCP startup stderr remains error-level', () => {
  withCapturedMcpLogEvents(events => {
    logMcpServerStderr('context7', 'startup failed', false)

    assert.deepEqual(events, [
      ['error', 'context7', 'Server stderr: startup failed'],
    ])
  })
})

test('appendBoundedMcpStderr caps retained stderr and marks truncation', () => {
  const output = appendBoundedMcpStderr('', Buffer.alloc(300 * 1024, 'x'))

  assert.equal(output.length, 256 * 1024)
  assert.match(output, /\.\.\.\[stderr truncated\]$/)
})

test('appendBoundedMcpStderr ignores chunks after truncation', () => {
  const output = appendBoundedMcpStderr('', Buffer.alloc(300 * 1024, 'x'))
  const after = appendBoundedMcpStderr(output, 'more stderr')

  assert.equal(after, output)
})

test('buildMcpStdioCommand — no prefix passes command and args through unchanged', () => {
  const { command, args } = buildMcpStdioCommand(
    'node',
    ['server.js', '--port=8080'],
    undefined,
  )
  assert.equal(command, 'node')
  assert.deepEqual(args, ['server.js', '--port=8080'])
})

test('buildMcpStdioCommand — empty string prefix is treated as no prefix', () => {
  const { command, args } = buildMcpStdioCommand(
    'uvx',
    ['mcp-server'],
    '',
  )
  assert.equal(command, 'uvx')
  assert.deepEqual(args, ['mcp-server'])
})

test('buildMcpStdioCommand — single-part prefix: prefix is command, original command is first arg', () => {
  const { command, args } = buildMcpStdioCommand(
    'npx',
    ['@modelcontextprotocol/server-everything', '--debug'],
    'bunx',
  )
  assert.equal(command, 'bunx')
  assert.deepEqual(args, [
    'npx',
    '@modelcontextprotocol/server-everything',
    '--debug',
  ])
})

test('buildMcpStdioCommand — multi-part prefix: structured argv with no shell join', () => {
  const { command, args } = buildMcpStdioCommand(
    'some-server',
    ['--path=/tmp;rm -rf /', '--arg=$(whoami)'],
    'docker run --rm -i',
  )
  assert.equal(command, 'docker')
  assert.deepEqual(args, [
    'run',
    '--rm',
    '-i',
    'some-server',
    '--path=/tmp;rm -rf /',
    '--arg=$(whoami)',
  ])
})

test('buildMcpStdioCommand — whitespace in prefix is normalized (multiple spaces, tabs)', () => {
  const { command, args } = buildMcpStdioCommand(
    'cmd',
    [],
    '  sudo   -u   bob  ',
  )
  assert.equal(command, 'sudo')
  assert.deepEqual(args, ['-u', 'bob', 'cmd'])
})

test('buildMcpStdioCommand — shell -c prefix joins command+args as single string (sh -c pattern)', () => {
  const { command, args } = buildMcpStdioCommand(
    'some-server',
    ['--port=8080', '--debug'],
    'sh -c',
  )
  assert.equal(command, 'sh')
  assert.deepEqual(args, ['-c', "'some-server' '--port=8080' '--debug'"])
})

test('buildMcpStdioCommand — shell -c prefix escapes args to prevent injection', () => {
  const { command, args } = buildMcpStdioCommand(
    'some-server',
    ['--path=/tmp; touch /tmp/pwned', 'normal-arg'],
    'sh -c',
  )
  assert.equal(command, 'sh')
  // The semicolon and spaces inside the arg are inside single quotes,
  // so the shell treats them as a literal string, not as syntax.
  assert.deepEqual(args, ['-c', "'some-server' '--path=/tmp; touch /tmp/pwned' 'normal-arg'"])
})

test('buildMcpStdioCommand — shell -c prefix escapes embedded single quotes', () => {
  const { command, args } = buildMcpStdioCommand(
    "some-server",
    ["it's a test"],
    'sh -c',
  )
  assert.equal(command, 'sh')
  // Embedded single quote is escaped: 'it'\''s test'
  assert.deepEqual(args, ['-c', "'some-server' 'it'\\''s a test'"])
})

test('buildMcpStdioCommand — shell -c prefix with spaced executable path (Windows Git Bash)', () => {
  const { command, args } = buildMcpStdioCommand(
    'some-server',
    ['--port=8080'],
    'C:\\Program Files\\Git\\bin\\bash.exe -c',
  )
  assert.equal(command, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.deepEqual(args, ['-c', "'some-server' '--port=8080'"])
})
