/**
 * A server that wants OAuth must not be a dead end for an embedder.
 *
 * The CLI already surfaces the `authenticate` pseudo-tool for a `needs-auth`
 * client, so the model can start the flow and hand the user a URL. The SDK
 * path kept tools only for a connected client, which left a host with a
 * status it could read (`system:init.mcp_servers`) and nothing it could do.
 *
 * The server here is a real local one rather than a stub of `connectToServer`:
 * `needs-auth` is not decided by the 401 alone — the MCP SDK walks RFC 9728
 * resource metadata, RFC 8414 authorization-server metadata and dynamic client
 * registration first, and only then reports that a redirect is needed. A stub
 * would assert our guess about that chain instead of the behaviour.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { snapshotEnv } from '../../test/envSnapshot.js'
import type { McpAuthOutput } from '../../tools/McpAuthTool/McpAuthTool.js'
import type { Tool } from '../../Tool.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import type { SecureStorage, SecureStorageData } from '../../utils/secureStorage/index.js'
import { createFallbackStorage } from '../../utils/secureStorage/fallbackStorage.js'
import { plainTextStorage } from '../../utils/secureStorage/plainTextStorage.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from '../../utils/secureStorage/macOsKeychainHelpers.js'
import { acquireEnvMutex, releaseEnvMutex, resetEnvMutexForTesting } from './shared.js'

// Discovery and client registration write credentials through
// getSecureStorage, which prefers the OS vault (Keychain, libsecret) under a
// service name taken from OPENCLAUDE_CONFIG_DIR before any test override —
// outside the temporary config home and possibly the developer's own. Keep
// them in memory instead, one store per vault entry, chosen as the real
// backends choose theirs: by service name — which carries the config home and
// the OAuth namespace — and account. The module is swapped before the code
// under test is imported, so that code never sees the real one.
//
// A copy of the exports, not the live namespace: mock.module rewrites the
// namespace's bindings, so restoring the namespace in afterAll would restore
// the mock.
const realSecureStorage = { ...(await import('../../utils/secureStorage/index.js')) }
const stores = new Map<string, SecureStorageData>()
const namespace = () =>
  JSON.stringify([getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getUsername()])
/** What is stored in one vault entry — the one the environment selects unless named. */
const stored = (store = namespace()): SecureStorageData => stores.get(store) ?? {}
const memoryStorage: SecureStorage = {
  name: 'mcp-needs-auth-test',
  read: () => stored(),
  readAsync: async () => stored(),
  update: data => {
    stores.set(namespace(), data)
    return { success: true }
  },
  delete: () => {
    stores.delete(namespace())
    return true
  },
}
let testStorage = memoryStorage
mock.module('../../utils/secureStorage/index.js', () => ({
  ...realSecureStorage,
  getSecureStorage: () => testStorage,
}))

// The tool returns its URL and carries on in the background: the OAuth flow
// finishes later, and the CLI would then reconnect. Watch both, passing every
// call through, so a test can wait for a flow to end and see whether a
// reconnect started instead of sleeping and hoping.
const realAuth = { ...(await import('../../services/mcp/auth.js')) }
/** Each flow the tool started; resolves once that flow has ended, either way. */
let flows: Promise<unknown>[] = []
mock.module('../../services/mcp/auth.js', () => ({
  ...realAuth,
  performMCPOAuthFlow: (...args: Parameters<typeof realAuth.performMCPOAuthFlow>) => {
    const flow = realAuth.performMCPOAuthFlow(...args)
    flows.push(flow.catch(() => {}))
    return flow
  },
}))
const realClient = { ...(await import('../../services/mcp/client.js')) }
let reconnects = 0
mock.module('../../services/mcp/client.js', () => ({
  ...realClient,
  reconnectMcpServerImpl: (...args: Parameters<typeof realClient.reconnectMcpServerImpl>) => {
    reconnects++
    return realClient.reconnectMcpServerImpl(...args)
  },
}))

const { connectSdkMcpServers } = await import('./permissions.js')

let server: ReturnType<typeof Bun.serve> | null = null
let configHome = ''
let originalConfigOverride: string | undefined
let hadMacro = false
let savedMacro: unknown
/** Clients registered so far; each sign-in attempt registers its own. */
let registrations = 0
/** Code exchanges the stand-in refused because another client presented the code. */
let refusedExchanges = 0
let failMcpRequests = false
/** A token exchange the stand-in keeps waiting until the test lets it answer. */
let heldExchange: {
  clientId: string
  refuse: boolean
  arrived: boolean
  answer: () => void
  answered: Promise<void>
} | null = null
/** Authorization-server metadata the stand-in sends headers for, then holds. */
let heldMetadata: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** Every session a test opens; teardown closes them, whatever the test did. */
const sessions: AbortController[] = []

/**
 * A server that asks to be signed into, and answers the discovery the MCP
 * SDK does on the way there. It issues a token only when a test completes
 * the browser step by calling the callback itself, and — like a real
 * authorization server — only to the client the code was issued to. Shown
 * a token it issued, it answers as an MCP server with one tool, `hello`.
 */
function serveNeedingAuth(invalidClient = false): string {
  let base = ''
  server = Bun.serve({
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname
      if (path === '/mcp' && failMcpRequests) return new Response(null, { status: 500 })
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (
        path.startsWith('/.well-known/oauth-authorization-server') ||
        path.startsWith('/.well-known/openid-configuration')
      ) {
        const metadata = {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        }
        const held = heldMetadata
        if (held) {
          held.arrived = true
          return new Response(
            new ReadableStream({
              async start(stream) {
                // A first byte sends the headers; the rest waits.
                stream.enqueue(new TextEncoder().encode(' '))
                await held.answered
                stream.enqueue(new TextEncoder().encode(JSON.stringify(metadata)))
                stream.close()
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (path === '/register') {
        return Response.json(
          {
            client_id: `stand-in-client-${++registrations}`,
            client_secret: 'not-a-secret',
            redirect_uris: ['http://127.0.0.1:1/callback'],
            client_id_issued_at: Math.floor(Date.now() / 1000),
          },
          { status: 201 },
        )
      }
      if (path === '/token') {
        if (invalidClient) {
          return Response.json(
            { error: 'invalid_client', error_description: 'Client not found' },
            { status: 400 },
          )
        }
        const form = new URLSearchParams(await request.text())
        const basic = request.headers.get('authorization')?.replace(/^Basic /, '')
        const clientId =
          form.get('client_id') ??
          (basic ? decodeURIComponent(atob(basic).split(':')[0]!) : undefined)
        if (form.get('code') !== codeFor(clientId)) {
          refusedExchanges++
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        const tokens = { access_token: `token-for-${clientId}`, token_type: 'Bearer', expires_in: 3600 }
        // Captured: teardown clears the shared slot while this answer waits.
        const held = heldExchange
        if (held && held.clientId === clientId) {
          held.arrived = true
          if (held.refuse) {
            await held.answered
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
          // A grant's headers go out at once and its body waits, as a slow
          // or stalled server's would.
          const answered = held.answered
          return new Response(
            new ReadableStream({
              async start(stream) {
                // A first byte sends the headers; the rest waits.
                stream.enqueue(new TextEncoder().encode(' '))
                await answered
                stream.enqueue(new TextEncoder().encode(JSON.stringify(tokens)))
                stream.close()
              },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          )
        }
        return Response.json(tokens)
      }
      if (path === '/mcp' && request.headers.get('authorization')?.startsWith('Bearer token-for-')) {
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        const rpc = (await request.json()) as { id?: string | number; method: string }
        // A notification gets no body back.
        if (rpc.id === undefined) return new Response(null, { status: 202 })
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'gated', version: '1' },
              }
            : rpc.method === 'tools/list'
              ? { tools: [{ name: 'hello', description: 'hello', inputSchema: { type: 'object', properties: {} } }] }
              : {}
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result })
      }
      return Response.json(
        { error: 'invalid_token', error_description: 'sign in first' },
        {
          status: 401,
          headers: {
            'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
          },
        },
      )
    },
  })
  base = `http://127.0.0.1:${server.port}`
  return `${base}/mcp`
}

/** A server that is simply broken, with nothing to sign into. */
function serveBroken(): string {
  server = Bun.serve({ port: 0, fetch: () => new Response('nope', { status: 500 }) })
  return `http://127.0.0.1:${server.port}/mcp`
}

/**
 * A controller standing in for an SDK session's: close() and interrupt()
 * abort the root every tool's controller descends from. Teardown aborts it
 * too, so a failed test cannot leave a callback listener behind.
 */
function openSession(): AbortController {
  const session = new AbortController()
  sessions.push(session)
  return session
}

/**
 * Makes the stand-in hold its answer to this client's code exchange, then
 * grant it — headers at once, the body held — or, as a server that has since
 * let the code go would, refuse it.
 */
function holdExchangeFor(clientId: string, refuse: boolean) {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldExchange = { clientId, refuse, arrived: false, answer, answered }
  return heldExchange
}

/** Calls the authenticate tool the way the engine does, within a session. */
async function startSignIn(tool: Tool, session: AbortController) {
  const setAppState = mock(() => {})
  const { data } = await tool.call(
    {},
    { abortController: session, setAppState } as never,
    (() => {}) as never,
    {} as never,
  )
  return { result: data as McpAuthOutput, setAppState }
}

/** The client a sign-in URL was issued to. */
function clientOf(result: McpAuthOutput): string {
  return new URL(result.authUrl!).searchParams.get('client_id')!
}

/** The code the stand-in issues to one client, and accepts only from it. */
function codeFor(clientId: string | null | undefined): string {
  return `code-for-${clientId}`
}

/** The browser's last step: the provider redirects back with a code. */
function callbackFor(authUrl: string): string {
  const params = new URL(authUrl).searchParams
  const callback = new URL(params.get('redirect_uri')!)
  callback.searchParams.set('code', codeFor(params.get('client_id')))
  callback.searchParams.set('state', params.get('state')!)
  return callback.toString()
}

/**
 * Waits for the flow a sign-in started to end, then for what the tool chains
 * onto it — the reconnect, or not — to have begun.
 */
async function flowEnded(index: number): Promise<void> {
  await waitFor(() => flows.length > index)
  await flows[index]
  await new Promise(resolve => setImmediate(resolve))
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

function storedAccessTokens(store?: string): string[] {
  return Object.values(stored(store).mcpOAuth ?? {}).map(entry => entry.accessToken).filter(Boolean)
}

/** The vault entry a config home selects, the rest of the environment as it is. */
function storeIn(configDir: string): string {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  process.env.OPENCLAUDE_CONFIG_DIR = configDir
  try {
    return namespace()
  } finally {
    restoreEnv()
  }
}

// Not under the shared mutation lock: that lock is the SDK's env mutex, and
// a sign-in's completion takes that mutex to finish in the store it started
// in, as a session's turn takes it to apply its `env` (v2.sessionEnvTurn
// runs without the lock for the same reason). Globals are restored in
// teardown instead.
beforeAll(() => {
  // Build-time constants the connection path reads through. Absent, the
  // failure is "MACRO is not defined" and says nothing about MCP.
  hadMacro = Object.hasOwn(globalThis, 'MACRO')
  savedMacro = (globalThis as Record<string, unknown>).MACRO
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '0.0.0-test',
    DISPLAY_VERSION: '0.0.0-test',
    BUILD_TIME: 'test',
    ISSUES_EXPLAINER: 'test',
    PACKAGE_URL: 'test',
    NATIVE_PACKAGE_URL: undefined,
  }
})

afterAll(() => {
  mock.module('../../services/mcp/client.js', () => realClient)
  mock.module('../../services/mcp/auth.js', () => realAuth)
  mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
  if (hadMacro) (globalThis as Record<string, unknown>).MACRO = savedMacro
  else delete (globalThis as Record<string, unknown>).MACRO
  // A test that failed while holding the mutex must not lock the next file out.
  resetEnvMutexForTesting()
})

beforeEach(async () => {
  originalConfigOverride = getClaudeConfigHomeDirOverrideForTesting()
  // The 15-minute needs-auth cache is a file keyed to the config home.
  // Somewhere disposable, so this touches neither the developer's own cache
  // nor the next test.
  configHome = await mkdtemp(join(tmpdir(), 'openclaude-mcp-auth-'))
  setClaudeConfigHomeDirForTesting(configHome)
  stores.clear()
  flows = []
  reconnects = 0
  registrations = 0
  refusedExchanges = 0
  failMcpRequests = false
})

afterEach(async () => {
  for (const session of sessions.splice(0)) session.abort()
  heldExchange?.answer()
  heldExchange = null
  heldMetadata?.answer()
  heldMetadata = null
  server?.stop(true)
  server = null
  stores.clear()
  setClaudeConfigHomeDirForTesting(originalConfigOverride)
  await rm(configHome, { recursive: true, force: true })
})

test('A SERVER THAT NEEDS SIGNING INTO ARRIVES WITH THE AUTHENTICATE TOOL', async () => {
  const url = serveNeedingAuth()

  const { clients, tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })

  expect(clients.map(one => one.type)).toEqual(['needs-auth'])
  expect(tools.map(one => one.name)).toEqual(['mcp__gated__authenticate'])
  // The registration landed in the stand-in store, not the OS vault.
  expect(JSON.stringify(stored())).toContain('stand-in-client')
  // The description is what the model reads to decide whether to call it, so
  // it has to name the server and say what calling it does.
  // Both arguments are ignored by this tool — the text is fixed when it is
  // built — but the Tool interface asks for them.
  const said = await tools[0]!.description({} as never, {} as never)
  expect(said).toContain('gated')
  expect(said).toContain('authentication')
  // The embedder's session connects its MCP servers once and does not pick
  // the real tools up after auth (v2.ts, self.mcpConnected), so the SDK path
  // must not promise that it will. Raised in review on the PR.
  expect(said).toContain('new session')
}, 30_000)

/**
 * Calling the tool is the point of offering it: the model gets a URL to hand
 * the user. The flow it starts belongs to the session, so closing the session
 * before the user finishes must stop listening for the browser's callback.
 */
test('the tool hands back a sign-in URL, and closing the session stops the flow', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const { result } = await startSignIn(tools[0]!, session)

  expect(result.status).toBe('auth_url')
  expect(result.authUrl).toStartWith(new URL('/authorize', url).toString())
  expect(result.message).toContain(result.authUrl!)
  expect(result.message).toContain('new session')

  session.abort()

  // The user finishing in the browser after close reaches nothing.
  await expect(fetch(callbackFor(result.authUrl!))).rejects.toThrow()
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([])
  expect(reconnects).toBe(0)
}, 30_000)

/**
 * A finished sign-in stores the tokens for the next session. It must not
 * reconnect here: the session would never use that client, and close() only
 * cleans up the clients the session connected itself.
 */
test('finishing sign-in stores the tokens without opening a client the session cannot close', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const { result, setAppState } = await startSignIn(tools[0]!, session)
  const callback = await fetch(callbackFor(result.authUrl!))
  expect(callback.status).toBe(200)

  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(result)}`])
  expect(reconnects).toBe(0)
  expect(setAppState).not.toHaveBeenCalled()

  // Closing afterwards has nothing left to stop, and changes nothing.
  session.abort()
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(result)}`])
}, 30_000)

/**
 * Asking again replaces the first attempt rather than racing it. Each attempt
 * registers its own client in the one stored entry for the server, so the
 * first one, left running, would finish its exchange with the second's
 * client: the authorization server refuses that, and the user who opened the
 * first link gets nothing for it. The CLI's mcp_authenticate handler aborts
 * the earlier flow for the same reason (cli/print.ts).
 */
test('asking to sign in again stops the earlier attempt, and the new one completes', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const first = await startSignIn(tools[0]!, session)
  const second = await startSignIn(tools[0]!, session)
  const firstClient = clientOf(first.result)
  const secondClient = clientOf(second.result)
  expect(secondClient).not.toBe(firstClient)

  // The first link no longer leads anywhere.
  await expect(fetch(callbackFor(first.result.authUrl!))).rejects.toThrow()
  await flowEnded(0)
  expect(refusedExchanges).toBe(0)
  expect(storedAccessTokens()).toEqual([])

  // The second does, with the client it was issued to.
  expect((await fetch(callbackFor(second.result.authUrl!))).status).toBe(200)
  await flowEnded(1)
  expect(storedAccessTokens()).toEqual([`token-for-${secondClient}`])
  expect(refusedExchanges).toBe(0)
  expect(reconnects).toBe(0)
}, 30_000)

/**
 * Replacing an attempt has to reach past its callback. Once the browser has
 * come back, the first attempt is exchanging its code — as the first client,
 * read before the second attempt replaced it — and whatever the exchange
 * answers is written to the server's one entry. Answering after the second
 * attempt has finished, a grant would put the first client's tokens and
 * registration over the second's, and a refusal would make the SDK
 * invalidate the stored tokens, which by then are the second's.
 */
test.each([
  ['grants the first code', false],
  ['refuses the first code', true],
])('a replaced attempt whose exchange answers late leaves the new sign-in alone: server %s', async (_, refuse) => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const first = await startSignIn(tools[0]!, session)
  const slow = holdExchangeFor(clientOf(first.result), refuse)
  expect((await fetch(callbackFor(first.result.authUrl!))).status).toBe(200)
  await waitFor(() => slow.arrived)

  const second = await startSignIn(tools[0]!, session)
  const secondClient = clientOf(second.result)
  expect((await fetch(callbackFor(second.result.authUrl!))).status).toBe(200)
  await flowEnded(1)
  expect(storedAccessTokens()).toEqual([`token-for-${secondClient}`])

  slow.answer()
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${secondClient}`])
  expect(Object.values(stored().mcpOAuth ?? {}).map(entry => entry.clientId)).toEqual([secondClient])
}, 30_000)

/**
 * Closing the session has to end a sign-in even while its code exchange is
 * still answering: the flow belongs to the session, and a server that never
 * finishes answering must not keep it alive.
 */
test('closing the session while the code exchange answers ends the flow', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const { result } = await startSignIn(tools[0]!, session)
  const slow = holdExchangeFor(clientOf(result), false)
  expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
  await waitFor(() => slow.arrived)
  session.abort()

  await Promise.race([
    flowEnded(0),
    Bun.sleep(2_000).then(() => {
      throw new Error('sign-in still pending after the session closed')
    }),
  ])
  expect(storedAccessTokens()).toEqual([])
  expect(reconnects).toBe(0)
}, 30_000)

/**
 * The same holds before there is a URL to hand back: the flow first reads the
 * authorization server's metadata, and a server that sends the headers and
 * then stalls must not keep the sign-in — or the tool call — alive past close.
 */
test('closing the session while the server metadata answers ends the sign-in', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldMetadata = { arrived: false, answer, answered }
  const held = heldMetadata

  const call = startSignIn(tools[0]!, session)
  await waitFor(() => held.arrived)
  session.abort()

  const { result } = await Promise.race([
    call,
    Bun.sleep(2_000).then(() => {
      throw new Error('sign-in still pending after the session closed')
    }),
  ])
  expect(result.status).toBe('error')
  expect(storedAccessTokens()).toEqual([])
}, 30_000)

/**
 * A sign-in asked for once the session has closed belongs to nothing and must
 * change nothing. Every flow starts by clearing the server's stored entry
 * for a fresh registration, so starting one regardless would throw away the
 * sign-in the user already completed.
 */
test('a sign-in asked for after the session closed leaves the stored sign-in alone', async () => {
  const url = serveNeedingAuth()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const session = openSession()

  const done = await startSignIn(tools[0]!, session)
  expect((await fetch(callbackFor(done.result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  const signedIn = structuredClone(stored())
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(done.result)}`])

  session.abort()
  const late = await startSignIn(tools[0]!, session)

  expect(late.result.status).toBe('error')
  await flowEnded(1)
  expect(stored()).toEqual(signedIn)
}, 30_000)

/**
 * A sign-in finishes where it started. The session applies its `env` for the
 * turn and puts the process's own environment back when the turn ends
 * (v2.ts, applySessionEnv), and the credential store is chosen from that
 * environment at each read and write: the config home, which also holds the
 * needs-auth cache, and the vault entry, whose service name carries the config
 * home and the OAuth namespace and whose account is the user's. The user comes
 * back from the browser after the turn: the exchange must still find the
 * client the flow registered, and the tokens and the dropped cache entry must
 * land in the store the model was signing into, not whichever the process has
 * by then. A variable for each part of that store a turn can change, and both
 * ways a client comes about, since a registered one is only in the store it
 * was registered in.
 */
const storeSelectors: Record<string, { variable: string; value: (turn: 'origin' | 'ambient') => string | undefined }> = {
  'config home': { variable: 'OPENCLAUDE_CONFIG_DIR', value: turn => join(configHome, turn) },
  'vault account': { variable: 'USER', value: turn => `${turn}-user` },
  // An approved endpoint, whose sign-ins have a vault service of their own.
  'OAuth namespace': {
    variable: 'CLAUDE_CODE_CUSTOM_OAUTH_URL',
    value: turn => (turn === 'origin' ? 'https://claude.fedstart.com' : undefined),
  },
}
const clientsOf: Record<string, object> = {
  'a registered client': {},
  'a configured client': { oauth: { clientId: 'fixed-client' } },
}
test.each(
  Object.keys(storeSelectors).flatMap(selector => Object.keys(clientsOf).map(client => [selector, client])),
)('a sign-in finishing after the turn restored the environment lands in the store it started in: %s, %s', async (selector, client) => {
  const { variable, value } = storeSelectors[selector]!
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', variable])
  const enterTurn = (turn: 'origin' | 'ambient') => {
    const next = value(turn)
    if (next === undefined) delete process.env[variable]
    else process.env[variable] = next
  }
  // Real config homes, so the needs-auth cache file is where a session's
  // OPENCLAUDE_CONFIG_DIR puts it rather than under the test override.
  setClaudeConfigHomeDirForTesting(undefined)
  const cacheFile = (configDir: string) => join(configDir, 'mcp-needs-auth-cache.json')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = join(configHome, 'origin')
    enterTurn('origin')
    const originHome = process.env.OPENCLAUDE_CONFIG_DIR!
    const origin = namespace()
    const url = serveNeedingAuth()
    const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url, ...clientsOf[client] } })
    await waitFor(() => existsSync(cacheFile(originHome)))
    const session = openSession()
    const { result } = await startSignIn(tools[0]!, session)

    // The turn ends: the session restores the process's own environment.
    enterTurn('ambient')
    const ambientHome = process.env.OPENCLAUDE_CONFIG_DIR!
    const ambient = namespace()
    expect(ambient).not.toBe(origin)
    expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
    await flowEnded(0)

    expect(refusedExchanges).toBe(0)
    expect(storedAccessTokens(origin)).toEqual([`token-for-${clientOf(result)}`])
    expect(stores.has(ambient)).toBe(false)
    await waitFor(() => !existsSync(cacheFile(originHome)))
    expect(existsSync(cacheFile(ambientHome))).toBe(false)
    // And the process's own environment is back once the flow is done with it.
    expect(process.env[variable]).toBe(value('ambient'))
  } finally {
    restoreEnv()
  }
}, 30_000)

/**
 * The environment is one per process, so a flow puts its own environment
 * back only under the mutex the sessions' turns hold: a sign-in whose user
 * comes back during another session's turn waits for that turn rather than
 * finishing under its variables.
 */
test("a sign-in finishing during another session's turn waits for that turn", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  const origin = join(configHome, 'origin')
  const other = join(configHome, 'other')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
    const session = openSession()
    const { result } = await startSignIn(tools[0]!, session)
    const slow = holdExchangeFor(clientOf(result), false)

    // Another session's turn, with its own environment, holds the mutex.
    await acquireEnvMutex()
    process.env.OPENCLAUDE_CONFIG_DIR = other
    try {
      expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
      // Bounded wait for what must not happen: no exchange, no write, no
      // change to the running turn's environment.
      await Bun.sleep(200)
      expect(slow.arrived).toBe(false)
      expect(stores.has(storeIn(other))).toBe(false)
      expect(process.env.OPENCLAUDE_CONFIG_DIR).toBe(other)
    } finally {
      delete process.env.OPENCLAUDE_CONFIG_DIR
      releaseEnvMutex()
    }

    await waitFor(() => slow.arrived)
    slow.answer()
    await flowEnded(0)
    expect(storedAccessTokens(storeIn(origin))).toEqual([`token-for-${clientOf(result)}`])
    expect(stores.has(storeIn(other))).toBe(false)
    expect(stores.has(namespace())).toBe(false)
    expect(process.env.OPENCLAUDE_CONFIG_DIR).toBeUndefined()
  } finally {
    restoreEnv()
  }
}, 30_000)

/**
 * The tokens are for the next session, and that session connects through the
 * same connector, which memoizes what it found by server name and config.
 * Left in place, the needs-auth result — and the authenticate tool — would
 * be what the next session gets, stored tokens or not. The stand-in accepts
 * the token it issued, so a connection that tries it comes back with the
 * server's real tool.
 */
test('after sign-in, a new session with the same server reaches its real tools', async () => {
  const url = serveNeedingAuth()
  const config = { gated: { type: 'http' as const, url } }
  const first = await connectSdkMcpServers(config)
  expect(first.tools.map(one => one.name)).toEqual(['mcp__gated__authenticate'])
  const session = openSession()

  const { result } = await startSignIn(first.tools[0]!, session)
  expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(result)}`])
  // The session is done; close() cleans up only clients it connected itself.
  session.abort()

  const next = await connectSdkMcpServers(config)
  try {
    expect(next.clients.map(one => one.type)).toEqual(['connected'])
    expect(next.tools.map(one => one.name)).toEqual(['mcp__gated__hello'])
    expect(reconnects).toBe(0)
  } finally {
    for (const client of next.clients) {
      if (client.type === 'connected') await client.cleanup()
    }
  }
}, 30_000)

test.each([false, true])('queued invalid-client cleanup honours cancellation: %s', async cancelled => {
  const url = serveNeedingAuth(true)
  const session = openSession()
  const config = { type: 'http' as const, url, oauth: { clientId: 'fixed-client' } }
  let loginUrl: string | undefined
  let scopeEntries = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const flow = realAuth.performMCPOAuthFlow('gated', config, value => {
    loginUrl = value
  }, session.signal, {
    skipBrowserOpen: true,
    credentialScope: async work => {
      // The first entry exchanges the code. Its failure releases the scope;
      // cleanup must acquire it again and may wait behind another SDK turn.
      if (++scopeEntries === 2) await gate
      return work()
    },
  })
  const outcome = flow.catch(error => error)
  try {
    await waitFor(() => loginUrl !== undefined)
    expect((await fetch(callbackFor(loginUrl!))).status).toBe(200)
    await waitFor(() => scopeEntries === 2)
    if (cancelled) session.abort()
    const key = realAuth.getServerKey('gated', config)
    const entry = {
      serverName: 'gated', serverUrl: url, clientId: 'newer-client',
      clientSecret: 'newer-secret', accessToken: 'newer-token',
      expiresAt: Date.now() + 3_600_000,
    }
    stores.set(namespace(), { mcpOAuth: { [key]: { ...entry } } })
    release()
    const error = await outcome
    expect(error).toBeInstanceOf(Error)
    if (cancelled) {
      expect(stored().mcpOAuth?.[key]).toEqual(entry)
      expect(error).toBeInstanceOf(realAuth.AuthenticationCancelledError)
    } else {
      expect(error.message).toContain('Client not found')
      const { clientId: _id, clientSecret: _secret, ...retained } = entry
      expect(stored().mcpOAuth?.[key]).toEqual(retained)
    }
  } finally {
    session.abort()
    release()
    await outcome
  }
}, 30_000)

/**
 * The branch is about authentication, not about failure in general. A server
 * that is simply broken has nothing to sign into, and offering the model a
 * sign-in for it would invite a wasted turn.
 */
test('a server that fails for another reason still gets no tool', async () => {
  const url = serveBroken()

  const { clients, tools } = await connectSdkMcpServers({ broken: { type: 'http', url } })

  expect(clients.map(one => one.type)).toEqual(['failed'])
  expect(tools).toEqual([])
}, 30_000)


// A completed query can restore the config directory while leaving the native
// cache populated from its own store. Exercise that handoff with real cache
// reads and query orchestration; vault commands and provider work stay local.
test("resuming sign-in discards another query's native credential cache", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  const { clearKeychainCache, keychainCacheState } = await import('../../utils/secureStorage/macOsKeychainHelpers.js')
  const realExec = { ...(await import('../../utils/execFileNoThrowPortable.js')) }
  const originalStorage = { ...memoryStorage }
  const origin = join(configHome, 'origin')
  const other = join(configHome, 'other')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
    const { result } = await startSignIn(tools[0]!, openSession())
    mock.module('../../utils/execFileNoThrowPortable.js', () => ({
      ...realExec, execSyncWithDefaults_DEPRECATED: () => JSON.stringify(stored()),
    }))
    const { macOsKeychainStorage } = await import('../../utils/secureStorage/macOsKeychainStorage.js')
    memoryStorage.read = () => macOsKeychainStorage.read()
    memoryStorage.readAsync = async () => macOsKeychainStorage.read()
    memoryStorage.update = data => { clearKeychainCache(); return originalStorage.update(data) }
    stores.set(storeIn(other), { pluginSecrets: { other: { key: 'other-account' } } })
    const { query } = await import('./query.js')
    const otherQuery = query({ prompt: 'fixture', options: { cwd: configHome, env: { OPENCLAUDE_CONFIG_DIR: other } } })
    ;(otherQuery as unknown as { setEngine: (engine: unknown) => void }).setEngine({
      injectAgents() {}, getMcpClients: () => [], getMessages: () => [], interrupt() {},
      async *submitMessage() {
        expect(process.env.OPENCLAUDE_CONFIG_DIR).toBe(other)
        // Model a normal read after the native cache's TTL expires.
        keychainCacheState.cache.cachedAt = 0
        memoryStorage.read()
        yield { type: 'assistant', message: { content: [] }, session_id: 'fixture' }
      },
    })
    try { for await (const _ of otherQuery) { /* drain the real env lifecycle */ } }
    finally { otherQuery.close() }
    expect(process.env.OPENCLAUDE_CONFIG_DIR).toBe(origin)
    expect(keychainCacheState.cache.data?.pluginSecrets).toEqual({ other: { key: 'other-account' } })
    expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
    await flowEnded(0)
    expect(storedAccessTokens(storeIn(origin))).toEqual([`token-for-${clientOf(result)}`])
    expect(stored(storeIn(origin)).pluginSecrets).toBeUndefined()
    expect(stored(storeIn(other)).pluginSecrets).toEqual({ other: { key: 'other-account' } })
  } finally {
    Object.assign(memoryStorage, originalStorage)
    mock.module('../../utils/execFileNoThrowPortable.js', () => realExec)
    clearKeychainCache()
    restoreEnv()
  }
}, 30_000)

test.each([{}, { oauth: { clientId: 'fixed-client' } }])('separate SDK tools replace sign-ins sharing a credential entry: %j', async oauth => {
  const url = serveNeedingAuth()
  const first = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const second = await connectSdkMcpServers({ gated: { type: 'http', url, ...oauth } })
  const a = await startSignIn(first.tools[0]!, openSession())
  const b = await startSignIn(second.tools[0]!, openSession())
  expect((await fetch(callbackFor(b.result.authUrl!))).status).toBe(200)
  await flowEnded(1)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(b.result)}`])
  // Returning to an older browser tab cannot invalidate the completed grant.
  await expect(fetch(callbackFor(a.result.authUrl!))).rejects.toThrow()
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(b.result)}`])
  expect(refusedExchanges).toBe(0)
}, 30_000)

test('a closed SDK context cannot replace another session\'s pending sign-in', async () => {
  const url = serveNeedingAuth()
  const config = { gated: { type: 'http' as const, url } }
  const closed = await connectSdkMcpServers(config)
  const live = await connectSdkMcpServers(config)
  const session = openSession()
  session.abort()
  const b = await startSignIn(live.tools[0]!, openSession())
  expect((await startSignIn(closed.tools[0]!, session)).result.status).toBe('error')
  expect((await fetch(callbackFor(b.result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(b.result)}`])
}, 30_000)

test.each(['store', 'server'])('SDK sign-ins for another %s remain independent', async different => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  const origin = join(configHome, 'origin')
  const other = different === 'store' ? join(configHome, 'other') : origin
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    // Both the native entry and its fallback must follow the selected home.
    setClaudeConfigHomeDirForTesting(undefined)
    const url = serveNeedingAuth()
    const first = await connectSdkMcpServers({ gated: { type: 'http', url } })
    const a = await startSignIn(first.tools[0]!, openSession())
    process.env.OPENCLAUDE_CONFIG_DIR = other
    const second = await connectSdkMcpServers({ [different === 'store' ? 'gated' : 'other']: { type: 'http', url } })
    const b = await startSignIn(second.tools[0]!, openSession())
    expect((await fetch(callbackFor(b.result.authUrl!))).status).toBe(200)
    await flowEnded(1)
    expect((await fetch(callbackFor(a.result.authUrl!))).status).toBe(200)
    await flowEnded(0)
    expect(storedAccessTokens(storeIn(origin))).toContain(`token-for-${clientOf(a.result)}`)
    expect(storedAccessTokens(storeIn(other))).toContain(`token-for-${clientOf(b.result)}`)
    expect(refusedExchanges).toBe(0)
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

test("re-authentication preserves another session's connected client", async () => {
  const url = serveNeedingAuth()
  const config = { gated: { type: 'http' as const, url } }
  const first = await connectSdkMcpServers(config)
  const session = openSession()
  const a = await startSignIn(first.tools[0]!, session)
  expect((await fetch(callbackFor(a.result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  const next = await connectSdkMcpServers(config)
  const client = next.clients[0]!
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected connected client')
  try {
    expect((await client.client.listTools()).tools.map(tool => tool.name)).toEqual(['hello'])
    const b = await startSignIn(first.tools[0]!, session)
    expect((await fetch(callbackFor(b.result.authUrl!))).status).toBe(200)
    await flowEnded(1)
    expect((await client.client.listTools()).tools.map(tool => tool.name)).toEqual(['hello'])
  } finally { await client.cleanup() }
}, 30_000)

test('auth completion also evicts a failed replacement connection', async () => {
  const url = serveNeedingAuth()
  const config = { gated: { type: 'http' as const, url } }
  const first = await connectSdkMcpServers(config)
  const a = await startSignIn(first.tools[0]!, openSession())
  await realClient.clearServerCache('gated', first.clients[0]!.config)
  failMcpRequests = true
  const failed = await connectSdkMcpServers(config)
  expect(failed.clients[0]!.type).toBe('failed')
  failMcpRequests = false
  expect((await fetch(callbackFor(a.result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  const next = await connectSdkMcpServers(config)
  try {
    expect(next.clients[0]!.type).toBe('connected')
    expect(next.tools.map(tool => tool.name)).toEqual(['mcp__gated__hello'])
  } finally {
    for (const client of next.clients) {
      if (client.type === 'connected') await client.cleanup()
    }
  }
}, 30_000)

test.each(['open', 'ending', 'ended'])('streaming query sign-in completes with its input %s', async inputState => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  process.env.OPENCLAUDE_CONFIG_DIR = configHome
  setClaudeConfigHomeDirForTesting(undefined)
  const { query } = await import('./query.js')
  const url = serveNeedingAuth()
  const origin = join(configHome, 'query-origin')
  const session = openSession()
  let tools: Tool[] = []
  let auth: McpAuthOutput | undefined
  let waitingForInput = false
  let finished = false
  let finishInput!: () => void
  const inputGate = new Promise<void>(resolve => { finishInput = resolve })
  async function* prompts() {
    yield { type: 'user', message: { role: 'user', content: 'sign in' }, parent_tool_use_id: null, session_id: '' } as const
    waitingForInput = true
    await inputGate
  }
  const q = query({ prompt: prompts(), options: {
    cwd: configHome, env: { OPENCLAUDE_CONFIG_DIR: origin },
    abortController: session, mcpServers: { gated: { type: 'http', url } },
  } })
  ;(q as unknown as { setEngine: (engine: unknown) => void }).setEngine({
    injectAgents() {}, getMcpClients: () => [], getMessages: () => [], interrupt() {},
    setMcpClients() {}, updateTools(pool: Tool[]) { tools = pool },
    async *submitMessage() {
      auth = (await startSignIn(tools.find(tool => tool.name === 'mcp__gated__authenticate')!, session)).result
      yield { type: 'assistant', message: { content: [] }, session_id: 'fixture' }
    },
  })
  const drain = (async () => { for await (const _ of q) { /* drive real query ownership */ } finished = true })()
  try {
    await waitFor(() => waitingForInput)
    expect(auth?.status).toBe('auth_url')
    if (inputState === 'ended') { finishInput(); await drain }
    const exchange = holdExchangeFor(clientOf(auth!), false)
    expect((await fetch(callbackFor(auth!.authUrl!))).status).toBe(200)
    await waitFor(() => exchange.arrived)
    if (inputState === 'ending') {
      finishInput()
      await new Promise(resolve => setImmediate(resolve))
      expect(finished).toBe(false)
      expect(process.env.OPENCLAUDE_CONFIG_DIR).toBe(origin)
    }
    exchange.answer()
    await waitFor(() => storedAccessTokens(storeIn(origin)).length === 1)
    await flowEnded(0)
    expect(storedAccessTokens(storeIn(origin))).toEqual([`token-for-${clientOf(auth!)}`])
    if (inputState === 'open') expect(finished).toBe(false)
    finishInput()
    await drain
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const next = await connectSdkMcpServers({ gated: { type: 'http', url } })
    try {
      // The memoized needs-auth result must be gone after completion.
      expect(next.clients[0]!.type).toBe('connected')
      expect(next.tools.map(tool => tool.name)).toEqual(['mcp__gated__hello'])
    } finally {
      for (const client of next.clients) if (client.type === 'connected') await client.cleanup()
    }
  } finally {
    session.abort()
    heldExchange?.answer()
    finishInput()
    await drain
    q.close()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

test.each(['USER', 'namespace'])('fallback sign-ins sharing a file replace each other across %s', async selector => {
  const restoreEnv = snapshotEnv(['USER', 'CLAUDE_CODE_CUSTOM_OAUTH_URL'])
  // Exercise the real fallback and file backend without touching an OS vault.
  const unavailable: SecureStorage = {
    name: 'unavailable-vault', read: () => null, readAsync: async () => null,
    update: () => ({ success: false }), delete: () => true,
  }
  testStorage = createFallbackStorage(unavailable, plainTextStorage)
  try {
    const url = serveNeedingAuth()
    const config = { gated: { type: 'http' as const, url } }
    process.env.USER = 'account-A'
    delete process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL
    const first = await connectSdkMcpServers(config)
    const a = await startSignIn(first.tools[0]!, openSession())
    if (selector === 'USER') process.env.USER = 'account-B'
    else process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL = 'https://claude.fedstart.com'
    const second = await connectSdkMcpServers(config)
    const b = await startSignIn(second.tools[0]!, openSession())
    expect((await fetch(callbackFor(b.result.authUrl!))).status).toBe(200)
    await flowEnded(1)
    const tokens = () => Object.values(plainTextStorage.read()?.mcpOAuth ?? {}).map(entry => entry.accessToken)
    expect(tokens()).toEqual([`token-for-${clientOf(b.result)}`])
    // A stale callback must not erase the newer grant in the shared file.
    try { await fetch(callbackFor(a.result.authUrl!)) } catch { /* cancelled listener */ }
    await flowEnded(0)
    expect(tokens()).toEqual([`token-for-${clientOf(b.result)}`])
    expect(refusedExchanges).toBe(0)
  } finally {
    for (const session of sessions) session.abort()
    await Promise.all(flows)
    testStorage = memoryStorage
    restoreEnv()
  }
}, 30_000)

test("initial SDK sign-in discards a previous query's native credential cache", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  const { clearKeychainCache, keychainCacheState } = await import('../../utils/secureStorage/macOsKeychainHelpers.js')
  const realExec = { ...(await import('../../utils/execFileNoThrowPortable.js')) }
  const originalStorage = { ...memoryStorage }
  const origin = join(configHome, 'origin')
  const other = join(configHome, 'other')
  const session = openSession()
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const config = { gated: { type: 'http', url } }
    await connectSdkMcpServers(config)
    stores.set(storeIn(origin), { ...stored(storeIn(origin)), pluginSecrets: { plugin: { key: 'origin-secret' } } })
    stores.set(storeIn(other), { pluginSecrets: { plugin: { key: 'other-secret' } } })
    mock.module('../../utils/execFileNoThrowPortable.js', () => ({ ...realExec, execSyncWithDefaults_DEPRECATED: () => JSON.stringify(stored()) }))
    const { macOsKeychainStorage } = await import('../../utils/secureStorage/macOsKeychainStorage.js')
    memoryStorage.read = () => macOsKeychainStorage.read()
    memoryStorage.readAsync = async () => macOsKeychainStorage.read()
    memoryStorage.update = data => { clearKeychainCache(); return originalStorage.update(data) }
    const { query } = await import('./query.js')
    for (const dir of [other, origin]) {
      let tools: Tool[] = []
      const q = query({ prompt: 'fixture', options: { cwd: configHome, abortController: dir === origin ? session : openSession(), env: { OPENCLAUDE_CONFIG_DIR: dir }, ...(dir === origin ? { mcpServers: config } : {}) } })
      ;(q as unknown as { setEngine: (engine: unknown) => void }).setEngine({
        injectAgents() {}, getMcpClients: () => [], getMessages: () => [], interrupt() {}, setMcpClients() {}, updateTools(pool: Tool[]) { tools = pool },
        async *submitMessage() {
          if (dir === other) { keychainCacheState.cache.cachedAt = 0; memoryStorage.read() }
          else {
            expect(stored(storeIn(origin)).pluginSecrets).toEqual({ plugin: { key: 'origin-secret' } })
            expect((await startSignIn(tools.find(t => t.name === 'mcp__gated__authenticate')!, session)).result.status).toBe('auth_url')
          }
          yield { type: 'assistant', message: { content: [] }, session_id: 'fixture' }
        },
      })
      try { for await (const _ of q) {} } finally { q.close() }
    }
    expect(stored(storeIn(origin)).pluginSecrets).toEqual({ plugin: { key: 'origin-secret' } })
  } finally {
    session.abort()
    await Promise.all(flows)
    Object.assign(memoryStorage, originalStorage)
    mock.module('../../utils/execFileNoThrowPortable.js', () => realExec)
    clearKeychainCache()
    restoreEnv()
  }
}, 30_000)

test.each(['property order', 'OAuth client'])('a new session retries saved credentials across %s configurations', async variant => {
  const url = serveNeedingAuth()
  const firstConfig = { gated: { type: 'http' as const, url } }
  const secondConfig = { gated: variant === 'property order'
    ? { url, type: 'http' as const }
    : { type: 'http' as const, url, oauth: { clientId: 'fixed-client' } } }
  const first = await connectSdkMcpServers(firstConfig)
  const second = await connectSdkMcpServers(secondConfig)
  expect(first.clients[0]!.type).toBe('needs-auth')
  expect(second.clients[0]!.type).toBe('needs-auth')
  const a = await startSignIn(second.tools[0]!, openSession())
  expect((await fetch(callbackFor(a.result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  for (const config of [firstConfig, secondConfig]) {
    const next = await connectSdkMcpServers(config)
    try {
      expect(next.clients[0]!.type).toBe('connected')
      expect(next.tools.map(t => t.name)).toEqual(['mcp__gated__hello'])
    } finally { for (const client of next.clients) if (client.type === 'connected') await client.cleanup() }
  }
}, 30_000)

test.each(['success', 'sibling-error', 'close', 'discard', 'sibling-error-close', 'sibling-error-discard'])('SDK sign-in keeps session ownership after executor result: %s', async outcome => {
  const { StreamingToolExecutor } = await import('../../services/tools/StreamingToolExecutor.js')
  const { createToolFixture } = await import('../../test/toolFixtures.js')
  const { z } = await import('zod/v4')
  const { getEmptyToolPermissionContext } = await import('../../Tool.js')
  const { QueryLifecycleOperationTracker } = await import('../../utils/queryLifecycle.js')
  const url = serveNeedingAuth()
  const root = openSession()
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } }, undefined, root.signal)
  const original = tools[0]!
  let auth: McpAuthOutput | undefined
  const authTool = { ...original, async call(...args: Parameters<typeof original.call>) {
    const result = await original.call(...args)
    auth = result.data as McpAuthOutput
    return result
  } }
  const bash = createToolFixture(z.object({}), { name: 'Bash', async call() {
    if (outcome.startsWith('sibling-error')) throw new Error('controlled Bash failure')
    return { data: 'ok' }
  } })
  const defs = [authTool, bash]
  const context = {
    abortController: root, messages: [], queryLifecycle: new QueryLifecycleOperationTracker(),
    options: { tools: defs, commands: [], debug: false, verbose: false, mainLoopModel: 'test-model', mcpClients: [], mcpResources: {}, isNonInteractiveSession: false },
    getAppState: () => ({ toolPermissionContext: getEmptyToolPermissionContext(), sessionHooks: new Map() }),
    setAppState() {}, setInProgressToolUseIDs() {}, setHasInterruptibleToolInProgress() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
  }
  const executor = new StreamingToolExecutor(defs, (async () => ({ behavior: 'allow' })) as never, context as never)
  const assistant = { uuid: 'fixture', requestId: 'fixture', message: { id: 'fixture', content: [] } }
  try {
    for (const [index, tool] of defs.entries()) {
      executor.addTool({ type: 'tool_use', id: `tool-${index}`, name: tool.name, input: {} } as never, assistant as never)
      for await (const _ of executor.getRemainingResults()) {}
      if (index === 0) expect(auth?.status).toBe('auth_url')
    }
    if (outcome.endsWith('close')) root.abort()
    if (outcome.endsWith('discard')) executor.discard()
    expect(root.signal.aborted).toBe(outcome.endsWith('close'))
    let status: number | undefined
    try { status = (await fetch(callbackFor(auth!.authUrl!))).status } catch {}
    expect(status).toBe(outcome.endsWith('close') || outcome.endsWith('discard') ? undefined : 200)
  } finally { root.abort(); await Promise.all(flows) }
}, 30_000)
