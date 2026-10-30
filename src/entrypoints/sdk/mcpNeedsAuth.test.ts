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
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import type { McpAuthOutput } from '../../tools/McpAuthTool/McpAuthTool.js'
import type { Tool } from '../../Tool.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import type { SecureStorage, SecureStorageData } from '../../utils/secureStorage/index.js'

// Discovery and client registration write credentials through
// getSecureStorage, which prefers the OS vault (Keychain, libsecret) under a
// service name taken from OPENCLAUDE_CONFIG_DIR before any test override —
// outside the temporary config home and possibly the developer's own. Keep
// them in memory instead. The module is swapped before the code under test
// is imported, so that code never sees the real one.
const realSecureStorage = await import('../../utils/secureStorage/index.js')
let stored: SecureStorageData = {}
const memoryStorage: SecureStorage = {
  name: 'mcp-needs-auth-test',
  read: () => stored,
  readAsync: async () => stored,
  update: data => {
    stored = data
    return { success: true }
  },
  delete: () => {
    stored = {}
    return true
  },
}
mock.module('../../utils/secureStorage/index.js', () => ({
  ...realSecureStorage,
  getSecureStorage: () => memoryStorage,
}))

const { connectSdkMcpServers } = await import('./permissions.js')

let server: ReturnType<typeof Bun.serve> | null = null
let configHome = ''
let originalConfigOverride: string | undefined
let hadMacro = false
let savedMacro: unknown
/** Requests that reached the MCP endpoint carrying a token — a reconnect. */
let authorizedMcpRequests = 0
/** Clients registered so far; each sign-in attempt registers its own. */
let registrations = 0
/** Code exchanges the stand-in refused because another client presented the code. */
let refusedExchanges = 0
/** A token exchange the stand-in keeps waiting until the test lets it answer. */
let heldExchange: {
  clientId: string
  refuse: boolean
  arrived: boolean
  answer: () => void
  answered: Promise<void>
} | null = null
/** Every session a test opens; teardown closes them, whatever the test did. */
const sessions: AbortController[] = []

/**
 * A server that asks to be signed into, and answers the discovery the MCP
 * SDK does on the way there. It issues a token only when a test completes
 * the browser step by calling the callback itself, and — like a real
 * authorization server — only to the client the code was issued to.
 */
function serveNeedingAuth(): string {
  let base = ''
  server = Bun.serve({
    port: 0,
    fetch: async request => {
      const path = new URL(request.url).pathname
      if (path.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] })
      }
      if (
        path.startsWith('/.well-known/oauth-authorization-server') ||
        path.startsWith('/.well-known/openid-configuration')
      ) {
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
        const form = new URLSearchParams(await request.text())
        const basic = request.headers.get('authorization')?.replace(/^Basic /, '')
        const clientId =
          form.get('client_id') ??
          (basic ? decodeURIComponent(atob(basic).split(':')[0]!) : undefined)
        if (form.get('code') !== codeFor(clientId)) {
          refusedExchanges++
          return Response.json({ error: 'invalid_grant' }, { status: 400 })
        }
        // Captured: teardown clears the shared slot while this answer waits.
        const held = heldExchange
        if (held && held.clientId === clientId) {
          held.arrived = true
          await held.answered
          if (held.refuse) {
            return Response.json({ error: 'invalid_grant' }, { status: 400 })
          }
        }
        return Response.json({
          access_token: `token-for-${clientId}`,
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      if (request.headers.has('authorization')) authorizedMcpRequests++
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
 * grant it or — as a server that has since let the code go would — refuse it.
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

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

function storedAccessTokens(): string[] {
  return Object.values(stored.mcpOAuth ?? {}).map(entry => entry.accessToken).filter(Boolean)
}

beforeAll(async () => {
  await acquireSharedMutationLock('entrypoints/sdk/mcpNeedsAuth.test.ts')
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
  mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
  if (hadMacro) (globalThis as Record<string, unknown>).MACRO = savedMacro
  else delete (globalThis as Record<string, unknown>).MACRO
  releaseSharedMutationLock()
})

beforeEach(async () => {
  originalConfigOverride = getClaudeConfigHomeDirOverrideForTesting()
  // The 15-minute needs-auth cache is a file keyed to the config home.
  // Somewhere disposable, so this touches neither the developer's own cache
  // nor the next test.
  configHome = await mkdtemp(join(tmpdir(), 'openclaude-mcp-auth-'))
  setClaudeConfigHomeDirForTesting(configHome)
  stored = {}
  authorizedMcpRequests = 0
  registrations = 0
  refusedExchanges = 0
})

afterEach(async () => {
  for (const session of sessions.splice(0)) session.abort()
  heldExchange?.answer()
  heldExchange = null
  server?.stop(true)
  server = null
  stored = {}
  setClaudeConfigHomeDirForTesting(originalConfigOverride)
  await rm(configHome, { recursive: true, force: true })
})

test('A SERVER THAT NEEDS SIGNING INTO ARRIVES WITH THE AUTHENTICATE TOOL', async () => {
  const url = serveNeedingAuth()

  const { clients, tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })

  expect(clients.map(one => one.type)).toEqual(['needs-auth'])
  expect(tools.map(one => one.name)).toEqual(['mcp__gated__authenticate'])
  // The registration landed in the stand-in store, not the OS vault.
  expect(JSON.stringify(stored)).toContain('stand-in-client')
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
  await Bun.sleep(50)
  expect(storedAccessTokens()).toEqual([])
  expect(authorizedMcpRequests).toBe(0)
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

  await waitFor(() => storedAccessTokens().length > 0)
  expect(storedAccessTokens()).toEqual([`token-for-${new URL(result.authUrl!).searchParams.get('client_id')}`])
  // Give a reconnect, were one started, time to reach the server.
  await Bun.sleep(250)
  expect(authorizedMcpRequests).toBe(0)
  expect(setAppState).not.toHaveBeenCalled()

  // Closing afterwards has nothing left to stop.
  session.abort()
  await Bun.sleep(50)
  expect(authorizedMcpRequests).toBe(0)
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
  await Bun.sleep(50)
  expect(refusedExchanges).toBe(0)
  expect(storedAccessTokens()).toEqual([])

  // The second does, with the client it was issued to.
  expect((await fetch(callbackFor(second.result.authUrl!))).status).toBe(200)
  await waitFor(() => storedAccessTokens().length > 0)
  expect(storedAccessTokens()).toEqual([`token-for-${secondClient}`])
  expect(refusedExchanges).toBe(0)
  expect(authorizedMcpRequests).toBe(0)
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
  await waitFor(() => storedAccessTokens().length > 0)

  slow.answer()
  // Give the late answer, were its attempt still owned, time to be written.
  await Bun.sleep(250)
  expect(storedAccessTokens()).toEqual([`token-for-${secondClient}`])
  expect(Object.values(stored.mcpOAuth ?? {}).map(entry => entry.clientId)).toEqual([secondClient])
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
