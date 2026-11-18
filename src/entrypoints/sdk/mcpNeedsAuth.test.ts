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
import { feature } from 'bun:bundle'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { snapshotEnv } from '../../test/envSnapshot.js'
import type { McpAuthOutput } from '../../tools/McpAuthTool/McpAuthTool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { Tool } from '../../Tool.js'
import type { SDKSession } from './v2.js'
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
import type { CanUseToolCallback } from './shared.js'
import { saveIdpIdTokenFromJwt } from '../../services/mcp/xaaIdpLogin.js'
import {
  getSessionSettingsCache,
  resetSettingsCache,
  setSessionSettingsCache,
} from '../../utils/settings/settingsCache.js'

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
const { fetchMcpSkillsForClient } = await import('../../skills/mcpSkills.js')
let reconnects = 0
/** A hook a test sets to run when the mocked reconnect settles. */
let onReconnectSettled:
  | ((result: Awaited<ReturnType<typeof realClient.reconnectMcpServerImpl>>) => void)
  | null = null
mock.module('../../services/mcp/client.js', () => ({
  ...realClient,
  reconnectMcpServerImpl: (...args: Parameters<typeof realClient.reconnectMcpServerImpl>) => {
    reconnects++
    const result = realClient.reconnectMcpServerImpl(...args)
    // Attached here, before the host awaits the same promise, so the
    // hook runs before the host's continuation resumes.
    if (onReconnectSettled) void result.then(onReconnectSettled)
    return result
  },
}))

// The XAA exchange and its OIDC discovery refuse plaintext token endpoints
// by design, and the stand-in is plain http: the exchange's own legs are
// covered by xaa.test.ts with mocked fetch, so answer both here and keep
// the reads, the token save and the reconnect live.
const realXaaIdpLogin = { ...(await import('../../services/mcp/xaaIdpLogin.js')) }
mock.module('../../services/mcp/xaaIdpLogin.js', () => ({
  ...realXaaIdpLogin,
  discoverOidc: async (
    issuer: string,
  ): Promise<Awaited<ReturnType<typeof realXaaIdpLogin.discoverOidc>>> => ({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    code_challenge_methods_supported: ['S256'],
  }),
}))
const realXaa = { ...(await import('../../services/mcp/xaa.js')) }
mock.module('../../services/mcp/xaa.js', () => ({
  ...realXaa,
  performCrossAppAccess: async (
    serverUrl: string,
  ): Promise<Awaited<ReturnType<typeof realXaa.performCrossAppAccess>>> => ({
    access_token: 'token-for-xaa',
    token_type: 'Bearer',
    expires_in: 3600,
    authorizationServerUrl: new URL(serverUrl).origin,
  }),
}))

const realInit = { ...(await import('../init.js')) }
/** Calls the mocked init has made, counting the wrapper rather than the memoized real one. */
let initCalls = 0
/** When set, the mocked init throws instead of initializing. */
let failInit = false
/** An init the mocked init keeps waiting until the test lets it answer. */
let heldInit: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
// Initialization is memoized in the real module, so a host flow that runs
// it twice still initializes once — and a test that holds or fails it
// cannot tell whether the flow called it at all. Wrap it with flags and a
// counter, passing every call through, so a test can hold initialization
// while it changes the turn state, or fail it to see which error wins.
//
// The wrapper must stay transparent to callers that patch the memoized
// init's cache: tests/sdk/query-concurrency.test.ts replaces `init.cache`
// with a probe to observe the session id during init. A plain wrapper would
// swallow that patch — the probe would never fire and the test would fail
// whenever this mock is registered first (shard 8) — so `.cache` is
// forwarded to the real memoized function instead of living on the wrapper.
const mockedInit = (() => {
  initCalls++
  if (failInit) throw new Error('init failed for the test')
  if (heldInit) {
    heldInit.arrived = true
    return heldInit.answered.then(() => realInit.init())
  }
  return realInit.init()
}) as typeof realInit.init
Object.defineProperty(mockedInit, 'cache', {
  get: () => (realInit.init as unknown as { cache: unknown }).cache,
  set: value => {
    ;(realInit.init as unknown as { cache: unknown }).cache = value
  },
  configurable: true,
})
mock.module('../init.js', () => ({
  ...realInit,
  init: mockedInit,
}))

// Agent loading runs inside the turn's environment-mutex hold, before the
// turn connects: a test can hold the turn there by gating the load, so a
// pre-turn sign-in reaches setup while the turn holds the mutex. The
// wrapper passes through to the real loader whenever no gate is set, so
// other tests see no change.
const realLoadAgentsDir = { ...(await import('../../tools/AgentTool/loadAgentsDir.js')) }
/** An agent-definition load the mock keeps waiting until the test lets it answer. */
let heldAgentDefinitions: {
  arrived: boolean
  answer: () => void
  answered: Promise<void>
} | null = null
mock.module('../../tools/AgentTool/loadAgentsDir.js', () => ({
  ...realLoadAgentsDir,
  getAgentDefinitionsWithOverrides: async (
    ...args: Parameters<typeof realLoadAgentsDir.getAgentDefinitionsWithOverrides>
  ) => {
    const held = heldAgentDefinitions
    if (held) {
      held.arrived = true
      await held.answered
    }
    return realLoadAgentsDir.getAgentDefinitionsWithOverrides(...args)
  },
}))

const { connectSdkMcpServers, captureCredentialScope } = await import('./permissions.js')
const { unstable_v2_createSession } = await import('./v2.js')

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
/** An authorized MCP initialize the stand-in keeps waiting until the test lets it answer. */
let heldInitialize: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** A tools/list the stand-in keeps waiting until the test lets it answer. */
let heldToolsList: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** When set, the stand-in answers tools/list in two pages: hello, then world. */
let pagedToolsList = false
/** When set, the stand-in lists only its own tool named `authenticate`. */
let offerRemoteAuthenticate = false
/** The Authorization header of each tools/list request, in order. */
const toolsListAuth: string[] = []
/** When set, the stand-in answers prompts/list in two pages: prompt-a, then prompt-b. */
let pagedPromptsList = false
/** The Authorization header of each prompts/list request, in order. */
const promptsListAuth: string[] = []
/** A prompts/list the stand-in keeps waiting until the test lets it answer. */
let heldPromptsList: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** When set, the stand-in answers resources/list in two pages. */
let pagedResourcesList = false
/** The Authorization header of each resources/list request, in order. */
const resourcesListAuth: string[] = []
/** A resources/list the stand-in keeps waiting until the test lets it answer. */
let heldResourcesList: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** The Authorization header of each resources/read request, in order. */
const skillReadAuth: string[] = []
/** When set, the first tools/list page-two request fails once, then succeeds. */
let failToolsListPage2Once = false
/** When set, the stand-in advertises the prompts capability. */
let offerPrompts = false
/** When set, the stand-in advertises the resources capability. */
let offerResources = false
/** A skill resources/read the stand-in keeps waiting until the test lets it answer. */
let heldSkillRead: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** Authorized initialize requests the stand-in has answered, so a test can tell a dial from a cache lookup. */
let initializes = 0
/** A turn gate a test opened; teardown releases it, so a failed assertion before the test's own release cannot leave the fake engine holding the environment mutex. */
let pendingTurnRelease: (() => void) | null = null
/** When set, the stand-in answers 401 to a bearer token it would accept. */
let rejectTokens = false
/** When set, the stand-in asks the client for its roots over the SSE stream. */
let offerRootsList = false
/** Roots URIs the client reported in answer to roots/list requests. */
let rootsSeen: string[] = []
/** Roots/list requests the stand-in has sent, for unique ids. */
let rootsRequests = 0
/** Authorization-server metadata the stand-in sends headers for, then holds. */
let heldMetadata: { arrived: boolean; answer: () => void; answered: Promise<void> } | null = null
/** Every session a test opens; teardown closes them, whatever the test did. */
const sessions: AbortController[] = []
/** SDK sessions a proposal-2 test opens; teardown closes them. */
const sdkSessions: SDKSession[] = []

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
      if (path === '/mcp' && request.method === 'GET' && offerRootsList) {
        // The client opens this stream after initialize to hear server
        // requests. Ask it for its roots at once: the answer comes back as
        // a POST, and the roots it reports show which directory the client
        // believes the session works in.
        const requestId = `roots-${++rootsRequests}`
        return new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(
                new TextEncoder().encode(
                  `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'roots/list', params: {} })}\n\n`,
                ),
              )
            },
          }),
          {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            },
          },
        )
      }
      if (path === '/mcp' && request.headers.get('authorization')?.startsWith('Bearer token-for-') && !rejectTokens) {
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        const rpc = (await request.json()) as {
          id?: string | number
          method: string
          params?: { cursor?: string }
        }
        // A JSON-RPC response to a server request (no method): the client's
        // answer to roots/list. Record the roots it reported.
        if (rpc.method === undefined) {
          const roots = (
            rpc as unknown as { result?: { roots?: { uri: string }[] } }
          ).result?.roots
          if (roots) rootsSeen.push(...roots.map(root => root.uri))
          return new Response(null, { status: 202 })
        }
        // A notification gets no body back.
        if (rpc.id === undefined) return new Response(null, { status: 202 })
        // A reconnect's initialize can be held, so a test can act while the
        // reconnect is pending — abort it, supersede it, close the session.
        if (rpc.method === 'initialize') initializes++
        if (rpc.method === 'initialize' && heldInitialize) {
          heldInitialize.arrived = true
          await heldInitialize.answered
        }
        // A reconnect's tools/list can be held the same way, so a test can
        // act while discovery is pending — abort it, and the reconnect must
        // reject instead of waiting out the request timeout. Only the first
        // page is held: a later page is the work that outlives the caller.
        if (rpc.method === 'tools/list') {
          toolsListAuth.push(request.headers.get('authorization') ?? '')
        }
        if (rpc.method === 'tools/list' && heldToolsList && !rpc.params?.cursor) {
          heldToolsList.arrived = true
          await heldToolsList.answered
        }
        // A reconnect's prompts/list can be held the same way. Only the
        // first page is held: a later page is the work that outlives the
        // caller.
        if (rpc.method === 'prompts/list') {
          promptsListAuth.push(request.headers.get('authorization') ?? '')
        }
        if (rpc.method === 'prompts/list' && heldPromptsList && !rpc.params?.cursor) {
          heldPromptsList.arrived = true
          await heldPromptsList.answered
        }
        // A reconnect's resources/list can be held the same way.
        if (rpc.method === 'resources/list') {
          resourcesListAuth.push(request.headers.get('authorization') ?? '')
        }
        if (rpc.method === 'resources/list' && heldResourcesList && !rpc.params?.cursor) {
          heldResourcesList.arrived = true
          await heldResourcesList.answered
        }
        // A reconnect's skill resources/read can be held the same way:
        // with the resources capability advertised, discovery reads the
        // skill, and a cancel during that read must reject the attempt
        // instead of waiting out the request timeout.
        if (rpc.method === 'resources/read') {
          skillReadAuth.push(request.headers.get('authorization') ?? '')
        }
        if (rpc.method === 'resources/read' && heldSkillRead) {
          heldSkillRead.arrived = true
          await heldSkillRead.answered
        }
        // The tools/list retry branch: the first page-two request fails
        // once, so the traversal retries it — a later credential read
        // under the surviving scope, not the first page's.
        if (
          failToolsListPage2Once &&
          rpc.method === 'tools/list' &&
          rpc.params?.cursor === 'page-2'
        ) {
          failToolsListPage2Once = false
          return new Response(null, { status: 500 })
        }
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2025-03-26',
                capabilities: {
                  tools: {},
                  ...(heldSkillRead || offerResources ? { resources: {} } : {}),
                  ...(offerPrompts ? { prompts: {} } : {}),
                },
                serverInfo: { name: 'gated', version: '1' },
              }
            : rpc.method === 'tools/list'
              ? pagedToolsList
                ? rpc.params?.cursor === 'page-2'
                  ? { tools: [{ name: 'world', description: 'world', inputSchema: { type: 'object', properties: {} } }] }
                  : {
                      tools: [{ name: 'hello', description: 'hello', inputSchema: { type: 'object', properties: {} } }],
                      nextCursor: 'page-2',
                    }
                : offerRemoteAuthenticate
                  ? { tools: [{ name: 'authenticate', description: 'Sign in through the remote server', inputSchema: { type: 'object', properties: {} } }] }
                  : { tools: [{ name: 'hello', description: 'hello', inputSchema: { type: 'object', properties: {} } }] }
              : rpc.method === 'resources/list'
                ? pagedResourcesList
                  ? rpc.params?.cursor === 'resources-2'
                    ? {
                        resources: [
                          {
                            uri: 'file:///second',
                            name: 'second',
                            mimeType: 'text/plain',
                          },
                        ],
                      }
                    : {
                        resources: [
                          {
                            uri: 'skill://review',
                            name: 'review',
                            mimeType: 'text/markdown',
                          },
                        ],
                        nextCursor: 'resources-2',
                      }
                  : {
                      resources: [
                        {
                          uri: 'skill://review',
                          name: 'review',
                          mimeType: 'text/markdown',
                        },
                      ],
                    }
                : rpc.method === 'prompts/list'
                  ? pagedPromptsList
                    ? rpc.params?.cursor === 'prompts-2'
                      ? { prompts: [{ name: 'prompt-b', description: 'prompt-b' }] }
                      : {
                          prompts: [{ name: 'prompt-a', description: 'prompt-a' }],
                          nextCursor: 'prompts-2',
                        }
                    : { prompts: [] }
                : rpc.method === 'resources/read'
                  ? {
                      contents: [
                        {
                          uri: 'skill://review',
                          mimeType: 'text/markdown',
                          text: '---\nname: review\ndescription: Review skill\n---\n# Review\n',
                        },
                      ],
                    }
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
 * A second, minimal MCP endpoint with no auth, serving a single tool.
 * Stands in for a same-named peer server at a different URL; the caller
 * stops it. Its initialize is never held by the shared hold flags.
 */
function servePeerWithTool(toolName: string): { url: string; stop: () => void } {
  const peer = Bun.serve({
    port: 0,
    fetch: async request => {
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      const rpc = (await request.json()) as {
        id?: string | number
        method: string
      }
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
            ? {
                tools: [
                  {
                    name: toolName,
                    description: `${toolName} tool`,
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              }
            : {}
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result })
    },
  })
  return { url: `http://127.0.0.1:${peer.port}/mcp`, stop: () => peer.stop(true) }
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

/** Makes the stand-in hold its answer to an authorized initialize. */
function holdInitialize() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldInitialize = { arrived: false, answer, answered }
  return heldInitialize
}

/** Makes the stand-in hold its answer to a tools/list. */
function holdToolsList() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldToolsList = { arrived: false, answer, answered }
  return heldToolsList
}

/** Makes the stand-in answer tools/list in two pages, recording each page's bearer. */
function pageToolsList() {
  pagedToolsList = true
  toolsListAuth.length = 0
}

/** Makes the stand-in answer prompts/list in two pages, recording each page's bearer. */
function pagePromptsList() {
  pagedPromptsList = true
  promptsListAuth.length = 0
}

/** Makes the stand-in hold its answer to a prompts/list. */
function holdPromptsList() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldPromptsList = { arrived: false, answer, answered }
  return heldPromptsList
}

/** Makes the stand-in answer resources/list in two pages, recording each page's bearer. */
function pageResourcesList() {
  pagedResourcesList = true
  resourcesListAuth.length = 0
}

/** Makes the stand-in hold its answer to a resources/list. */
function holdResourcesList() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldResourcesList = { arrived: false, answer, answered }
  return heldResourcesList
}

/**
 * A competing owner that queues on the environment mutex, applies its own
 * environment, and holds the mutex until the test releases it. Returns the
 * release and the promise that resolves once it has applied and released.
 */
function queueCompetitor(configDir: string): {
  release: () => void
  applied: Promise<void>
} {
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const applied = (async () => {
    const { acquired } = await acquireEnvMutex()
    expect(acquired).toBe(true)
    process.env.OPENCLAUDE_CONFIG_DIR = configDir
    await held
    releaseEnvMutex()
  })()
  return { release, applied }
}

/** Makes the stand-in hold its answer to a skill resources/read. */
function holdSkillRead() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldSkillRead = { arrived: false, answer, answered }
  return heldSkillRead
}

/** Makes the mocked init hold until the test lets it answer. */
function holdInit() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldInit = { arrived: false, answer, answered }
  return heldInit
}

/** Makes the mocked agent-definition load hold until the test lets it answer. */
function holdAgentDefinitions() {
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldAgentDefinitions = { arrived: false, answer, answered }
  return heldAgentDefinitions
}

/**
 * A headersHelper script that blocks until the test releases it, so a
 * connect can be held in header setup — before any transport exists.
 * The script records its arrival in `arrivedFile` and waits for `goFile`
 * to appear before printing `{}`; the test passes both paths through
 * the environment the helper inherits. Returns the script and file paths.
 */
async function holdHeaders(): Promise<{
  script: string
  arrivedFile: string
  goFile: string
}> {
  const arrivedFile = join(configHome, 'headers-arrived')
  const goFile = join(configHome, 'headers-go')
  const script = join(configHome, 'headers-helper.cjs')
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.MCP_HEADER_HELPER_ARRIVED, 'arrived')
const start = Date.now()
while (!fs.existsSync(process.env.MCP_HEADER_HELPER_GO)) {
  if (Date.now() - start > 9000) break
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
}
console.log('{}')
`,
  )
  await chmod(script, 0o755)
  return { script, arrivedFile, goFile }
}

/**
 * A headersHelper script that records the environment it runs in: it
 * writes the value of MCP_SIBLING_PROBE to a probe file (whose path it
 * reads from MCP_SIBLING_PROBE_FILE) and prints {}, so the sibling keeps
 * its static Authorization header. Returns the script and probe file.
 */
async function probeSiblingEnv(): Promise<{
  script: string
  probeFile: string
}> {
  const probeFile = join(configHome, 'sibling-probe')
  const script = join(configHome, 'sibling-helper.cjs')
  await writeFile(
    script,
    `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(process.env.MCP_SIBLING_PROBE_FILE, process.env.MCP_SIBLING_PROBE ?? 'unset')
console.log('{}')
`,
  )
  await chmod(script, 0o755)
  return { script, probeFile }
}

/**
 * A session with a gated server to sign into and a sibling at the same
 * URL whose header helper records the environment its connect runs in.
 * The sibling carries a static token, so it connects during setup.
 */
function openSiblingSession(url: string, script: string): SDKSession {
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    mcpServers: {
      gated: { type: 'http', url },
      sibling: {
        type: 'http',
        url,
        headers: { Authorization: 'Bearer token-for-seeded' },
        headersHelper: script,
      },
    },
    env: { MCP_SIBLING_PROBE: 'session-value' },
  })
  sdkSessions.push(session)
  return session
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

/**
 * A promise that rejects if `promise` does not settle within `ms` — so a
 * test fails promptly (and loudly) instead of hanging on a 30s timeout when
 * cancellation does not propagate through a stalled operation.
 */
function settlesWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  const timeout = Bun.sleep(ms).then(() => {
    throw new Error(`did not settle within ${ms}ms`)
  })
  return Promise.race([promise, timeout])
}

function storedAccessTokens(store?: string): string[] {
  return Object.values(stored(store).mcpOAuth ?? {}).map(entry => entry.accessToken).filter(Boolean)
}

/** Seeds a valid stored token for a server, so its next connect is authorized. */
function seedStoredToken(name: string, url: string, accessToken: string): void {
  const key = realAuth.getServerKey(name, { type: 'http', url } as never)
  const data = stored()
  testStorage.update({
    ...data,
    mcpOAuth: {
      ...(data.mcpOAuth ?? {}),
      [key]: {
        serverName: name,
        serverUrl: url,
        accessToken,
        expiresAt: Date.now() + 3600_000,
        clientId: 'seeded',
        clientSecret: 'seeded',
      },
    },
  })
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
  mock.module('../../services/mcp/xaaIdpLogin.js', () => realXaaIdpLogin)
  mock.module('../../services/mcp/xaa.js', () => realXaa)
  mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
  // The init wrapper too: it forwards `cache` to the real memoized init,
  // so leaving it registered makes the next file in the shard see the
  // wrapper instead of the real export.
  mock.module('../init.js', () => realInit)
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
  onReconnectSettled = null
  registrations = 0
  refusedExchanges = 0
  failMcpRequests = false
  rejectTokens = false
  offerRootsList = false
  pagedToolsList = false
  offerRemoteAuthenticate = false
  toolsListAuth.length = 0
  pagedPromptsList = false
  promptsListAuth.length = 0
  pagedResourcesList = false
  resourcesListAuth.length = 0
  skillReadAuth.length = 0
  failToolsListPage2Once = false
  offerPrompts = false
  offerResources = false
  rootsSeen = []
  rootsRequests = 0
  initializes = 0
  initCalls = 0
  failInit = false
})

afterEach(async () => {
  // A turn gate the test opened but never released — a failed assertion
  // before the test's own release — is released first, so the fake engine
  // does not hold the environment mutex into the next test.
  pendingTurnRelease?.()
  pendingTurnRelease = null
  for (const session of sessions.splice(0)) session.abort()
  for (const sdkSession of sdkSessions.splice(0)) sdkSession.close()
  heldExchange?.answer()
  heldExchange = null
  heldInitialize?.answer()
  heldInitialize = null
  heldToolsList?.answer()
  heldToolsList = null
  heldPromptsList?.answer()
  heldPromptsList = null
  heldResourcesList?.answer()
  heldResourcesList = null
  heldSkillRead?.answer()
  heldSkillRead = null
  heldInit?.answer()
  heldInit = null
  heldAgentDefinitions?.answer()
  heldAgentDefinitions = null
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
      // The entries run read-and-clear, registration, exchange, cleanup.
      // The exchange is the third entry; its failure releases the scope,
      // and cleanup is the fourth entry, which must acquire it again and
      // may wait behind another SDK turn.
      if (++scopeEntries === 4) await gate
      return work()
    },
  })
  const outcome = flow.catch(error => error)
  try {
    await waitFor(() => loginUrl !== undefined)
    expect((await fetch(callbackFor(loginUrl!))).status).toBe(200)
    await waitFor(() => scopeEntries === 4)
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

// ============================================================================
// Proposal 2 (#2294): a host-facing way to start the OAuth flow, know when
// authorization finished, and reconnect afterwards.
// ============================================================================

/** An SDK session holding the gated server, before any turn. */
function openGatedSession(url: string): SDKSession {
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    mcpServers: { gated: { type: 'http', url } },
  })
  sdkSessions.push(session)
  return session
}

/**
 * REPRO: the session reports needs-auth in system:init and offers the host
 * no way to act — no method to start the flow, await it, or reconnect.
 * Fails until authenticateMcpServer exists on SDKSession.
 */
test('THE SESSION OFFERS A HOST-FACING authenticateMcpServer METHOD', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  expect(typeof (session as unknown as { authenticateMcpServer?: unknown }).authenticateMcpServer).toBe('function')
}, 30_000)

/** An SDK session holding arbitrary servers, before any turn. */
function openSessionWith(mcpServers: Record<string, unknown>): SDKSession {
  const session = unstable_v2_createSession({ cwd: process.cwd(), mcpServers })
  sdkSessions.push(session)
  return session
}

/** An engine that records what the session swaps into it, and does nothing else. */
function recordingEngine(onUpdateTools?: (tools: Tool[]) => void) {
  const calls: { setMcpClients: MCPServerConnection[][]; updateTools: Tool[][] } = {
    setMcpClients: [],
    updateTools: [],
  }
  const engine = {
    // Everything the session touches on an engine, doing nothing.
    injectAgents: () => {},
    setMcpClients: (clients: MCPServerConnection[]) => {
      calls.setMcpClients.push([...clients])
    },
    updateTools: (tools: Tool[]) => {
      calls.updateTools.push([...tools])
      onUpdateTools?.(tools)
    },
    getMcpClients: () => calls.setMcpClients.at(-1) ?? [],
    getMessages: () => [],
    interrupt: () => {},
    submitMessage: async function* (): AsyncGenerator<never> {},
  }
  return { engine, calls }
}

/** Swap a session's engine for a recording one, as v2.sessionEnvTurn does. */
function recordEngine(session: SDKSession, onUpdateTools?: (tools: Tool[]) => void) {
  const recorded = recordingEngine(onUpdateTools)
  ;(session as unknown as { setEngine: (engine: unknown) => void }).setEngine(recorded.engine)
  return recorded.calls
}

/**
 * The whole point: a host with a "Sign in" button gets the URL, the user
 * finishes in the browser, and the same session — no new session, no new
 * turn — ends up with the server's real tools.
 */
test('authenticateMcpServer DELIVERS THE URL, AWAITS THE FLOW, AND RECONNECTS IN PLACE', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect(seenUrls[0]).toStartWith(new URL('/authorize', url).toString())

  // The browser's last step: the provider redirects back with a code.
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)

  const status = await done
  expect(status.name).toBe('gated')
  expect(status.status).toBe('connected')
  expect(status.serverInfo).toEqual({ name: 'gated', version: '1' })
  expect(status.tools?.map(tool => tool.name)).toEqual(['hello'])
  expect(reconnects).toBe(1)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`])
}, 30_000)

/**
 * The status reports the tools the model actually sees: with hello
 * disallowed, the reconnected pool drops it, so status.tools must not
 * list it either — the public API promises the model-visible list, not
 * the raw discovery list (CodeRabbit #2493 review 5956557301).
 */
test('authenticateMcpServer REPORTS ONLY THE TOOLS THE POOL INSTALLS', async () => {
  const url = serveNeedingAuth()
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    mcpServers: { gated: { type: 'http', url } },
    disallowedTools: ['mcp__gated__hello'],
  })
  sdkSessions.push(session)
  const calls = recordEngine(session)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  const status = await done
  expect(status.status).toBe('connected')
  // The reconnected pool holds no hello, and neither does the status.
  expect(calls.updateTools.at(-1)!.map(tool => tool.name)).not.toContain('mcp__gated__hello')
  expect(status.tools?.map(tool => tool.name)).toEqual([])
}, 30_000)

/**
 * The swap itself: the reconnected client replaces the needs-auth one, and
 * the tool pool drops the authenticate pseudo-tool for the real tools.
 * Observed through a recording engine — no provider is needed to see it.
 */
test('authenticateMcpServer SWAPS THE CLIENT AND THE REAL TOOLS INTO THE SESSION', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  const status = await done
  expect(status.status).toBe('connected')

  // At connect time the pool held the authenticate pseudo-tool, not hello.
  expect(calls.updateTools.length).toBeGreaterThanOrEqual(2)
  const atConnect = calls.updateTools[0]!.map(tool => tool.name)
  expect(atConnect).toContain('mcp__gated__authenticate')
  expect(atConnect).not.toContain('mcp__gated__hello')
  // After the reconnect the pool holds the real tool, not the pseudo-tool.
  const afterReconnect = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterReconnect).toContain('mcp__gated__hello')
  expect(afterReconnect).not.toContain('mcp__gated__authenticate')
  // And the client list the next turn's system:init is built from holds the
  // connected client, not the needs-auth one.
  const clients = calls.setMcpClients.at(-1)!
  expect(clients.map(client => [client.name, client.type])).toEqual([['gated', 'connected']])
}, 30_000)

/** Completes the browser step of a sign-in and awaits its status. */
async function completeSignIn(session: SDKSession, name: string) {
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer(name, {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  return done
}

/**
 * Pre-turn MCP work runs in the session's SDK context: a session whose cwd
 * differs from the process directory must see its own directory in a real
 * server-initiated roots/list request — for the fresh client the first
 * connect creates and for the fresh client the reconnect creates. Outside
 * the context, both would report the process directory instead.
 */
test('PRE-TURN AUTHENTICATION INITIALIZES A FRESH SERVER IN THE SESSION DIRECTORY', async () => {
  const url = serveNeedingAuth()
  offerRootsList = true
  // A session whose cwd differs from the process directory.
  const sessionDir = await mkdtemp(join(tmpdir(), 'openclaude-mcp-roots-'))
  try {
    seedStoredToken('gated', url, 'token-for-seeded')
    const session = unstable_v2_createSession({
      cwd: sessionDir,
      mcpServers: { gated: { type: 'http', url } },
    })
    sdkSessions.push(session)

    const status = await completeSignIn(session, 'gated')
    expect(status.status).toBe('connected')
    // One roots/list per fresh client: the first connect and the reconnect.
    await waitFor(() => rootsSeen.length >= 2)
    expect(rootsSeen.length).toBeGreaterThan(0)
    for (const uri of rootsSeen) {
      expect(uri).toBe(`file://${sessionDir}`)
    }
  } finally {
    await rm(sessionDir, { recursive: true, force: true })
  }
}, 30_000)

/**
 * The tool swap must replace tools by exact server ownership, not by a
 * display-name prefix: `gated` and `gated__other` are distinct servers,
 * and signing in `gated` must not delete the sibling's already-usable
 * tool — the prefix mcp__gated__ matches mcp__gated__other__hello.
 */
test('AUTHENTICATING ONE SERVER KEEPS A SIBLING WHOSE NAME EXTENDS ITS OWN', async () => {
  const url = serveNeedingAuth()
  const session = openSessionWith({
    gated: { type: 'http', url },
    gated__other: { type: 'http', url },
  })
  const calls = recordEngine(session)

  // The sibling signs in first, so its real tool is in the pool.
  expect((await completeSignIn(session, 'gated__other')).status).toBe('connected')
  expect(calls.updateTools.at(-1)!.map(tool => tool.name)).toContain('mcp__gated__other__hello')

  // Signing in `gated` swaps only `gated`.
  expect((await completeSignIn(session, 'gated')).status).toBe('connected')
  const afterGated = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterGated).toContain('mcp__gated__hello')
  expect(afterGated).toContain('mcp__gated__other__hello')
}, 30_000)

/**
 * The failed outcome drops the failed server's stale tools — and only
 * those. The same prefix that deletes the sibling's tool on success
 * deletes it here too, while dropping the target's stale tools.
 */
test('A FAILED RECONNECT DROPS ONLY THE FAILED SERVER, NOT ITS NAME-EXTENDING SIBLING', async () => {
  const url = serveNeedingAuth()
  const session = openSessionWith({
    gated: { type: 'http', url },
    gated__other: { type: 'http', url },
  })
  const calls = recordEngine(session)

  expect((await completeSignIn(session, 'gated__other')).status).toBe('connected')

  // The server is down for the next reconnect: /mcp answers 500.
  failMcpRequests = true
  try {
    expect((await completeSignIn(session, 'gated')).status).toBe('failed')
  } finally {
    failMcpRequests = false
  }
  const afterFailed = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterFailed).toContain('mcp__gated__other__hello')
  expect(afterFailed).not.toContain('mcp__gated__hello')
  expect(afterFailed).not.toContain('mcp__gated__authenticate')
}, 30_000)

/**
 * The needs-auth outcome replaces the target's stale real tools with its
 * authenticate tool — and only the target's. The prefix membership check
 * would treat the sibling's real tool as the target's stale one and
 * replace it too.
 */
test('A RECONNECT THAT STILL NEEDS AUTH REPLACES ONLY ITS OWN SERVER, NOT ITS NAME-EXTENDING SIBLING', async () => {
  const url = serveNeedingAuth()
  const session = openSessionWith({
    gated: { type: 'http', url },
    gated__other: { type: 'http', url },
  })
  const calls = recordEngine(session)

  expect((await completeSignIn(session, 'gated__other')).status).toBe('connected')

  // The server stops accepting the tokens it issued.
  rejectTokens = true
  try {
    expect((await completeSignIn(session, 'gated')).status).toBe('needs-auth')
  } finally {
    rejectTokens = false
  }
  const afterNeedsAuth = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterNeedsAuth).toContain('mcp__gated__authenticate')
  expect(afterNeedsAuth).toContain('mcp__gated__other__hello')
}, 30_000)

/**
 * A needs-auth outcome replaces a remote tool named `authenticate` with
 * the local recovery tool: the remote tool shares the qualified name and
 * owner metadata, so the name alone cannot tell them apart — and the
 * stale remote description would otherwise stay in the pool after
 * reconnect, offering the model a sign-in that goes nowhere.
 */
test('A RECONNECT THAT STILL NEEDS AUTH REPLACES A REMOTE authenticate TOOL WITH THE LOCAL RECOVERY TOOL', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  // The server exposes its own tool named `authenticate`.
  offerRemoteAuthenticate = true
  try {
    expect((await completeSignIn(session, 'gated')).status).toBe('connected')
    // The pool holds only the remote tool: no stale real tool beside it,
    // so the name alone would pass for the local recovery tool.
    const afterConnect = calls.updateTools.at(-1)!.map(tool => tool.name)
    expect(afterConnect).toContain('mcp__gated__authenticate')
    expect(afterConnect).not.toContain('mcp__gated__hello')

    // The server stops accepting the tokens it issued.
    rejectTokens = true
    try {
      expect((await completeSignIn(session, 'gated')).status).toBe('needs-auth')
    } finally {
      rejectTokens = false
    }
    const afterNeedsAuth = calls.updateTools.at(-1)!
    expect(afterNeedsAuth.map(tool => tool.name)).not.toContain('mcp__gated__hello')
    const authTool = afterNeedsAuth.find(tool => tool.name === 'mcp__gated__authenticate')
    expect(authTool).toBeDefined()
    // Description oracle: the installed tool is the local recovery tool,
    // not the remote tool that shared its name.
    const description = await authTool!.description({} as never, {} as never)
    expect(description).toContain('requires authentication')
    expect(description).not.toContain('remote server')
  } finally {
    offerRemoteAuthenticate = false
  }
}, 30_000)

/**
 * A host reconnect installs tools from its own endpoint, not a
 * same-named peer's: discovery is shared by display name, so a peer
 * discovering mid-reconnect can repopulate the memo the host then reads
 * — and the swap would install the peer's tools alongside the host's
 * connected status, dispatching to the wrong endpoint.
 */
test('A HOST RECONNECT INSTALLS TOOLS FROM ITS OWN ENDPOINT, NOT A SAME-NAMED PEER', async () => {
  const url = serveNeedingAuth()
  const peer = servePeerWithTool('peer-tool')
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  try {
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)
    // The initial connect is done once the URL is out: hold the
    // reconnect's initialize, so the peer can discover while the host
    // reconnect waits for its fresh connection.
    const held = holdInitialize()
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    await waitFor(() => held.arrived)

    // The peer discovers mid-reconnect: same display name, different
    // endpoint. Its tools must not become the host's.
    const peerClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url: peer.url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(peerClient.type).toBe('connected')
    const peerTools = await realClient.fetchToolsForClient(peerClient)
    expect(peerTools.map(tool => tool.mcpInfo?.toolName ?? tool.name)).toEqual(['peer-tool'])

    held.answer()
    const status = await done
    expect(status.status).toBe('connected')
    // The returned status and the installed pool carry the host's tool,
    // not the peer's — and the installed tool is the host's own object,
    // so it dispatches to the host endpoint.
    expect(status.tools?.map(tool => tool.name)).toEqual(['hello'])
    const installed = calls.updateTools.at(-1)!
    expect(installed.map(tool => tool.name)).toContain('mcp__gated__hello')
    expect(installed.map(tool => tool.name)).not.toContain('mcp__gated__peer-tool')
    expect(installed.find(tool => tool.name === 'mcp__gated__peer-tool')).toBeUndefined()
  } finally {
    peer.stop()
  }
}, 30_000)

/**
 * The user-visible behaviour the recording engine above cannot show: what
 * the next turn actually reports. system:init is yielded before the model
 * is called, so taking it and stopping needs no provider — the turn never
 * gets that far.
 */
async function systemInitOf(session: SDKSession): Promise<{
  mcp_servers: { name: string; status: string }[]
  tools: string[]
}> {
  for await (const msg of session.sendMessage('hi')) {
    if (msg.type === 'system' && msg.subtype === 'init') {
      return msg as unknown as {
        mcp_servers: { name: string; status: string }[]
        tools: string[]
      }
    }
  }
  throw new Error('turn ended without system:init')
}

test('THE NEXT TURN AFTER AUTHENTICATION REPORTS THE CONNECTED SERVER AND ITS REAL TOOL', async () => {
  // system:init reports the key's source, so a key must be present to build
  // it — a placeholder, never sent anywhere: the turn stops at system:init,
  // before the model is called.
  const restoreEnv = snapshotEnv(['ANTHROPIC_API_KEY'])
  process.env.ANTHROPIC_API_KEY = 'test-key-for-system-init'
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  try {
    const before = await systemInitOf(session)
    expect(before.mcp_servers).toContainEqual({ name: 'gated', status: 'needs-auth' })
    expect(before.tools).toContain('mcp__gated__authenticate')
    expect(before.tools).not.toContain('mcp__gated__hello')

    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    expect((await done).status).toBe('connected')

    const after = await systemInitOf(session)
    expect(after.mcp_servers).toContainEqual({ name: 'gated', status: 'connected' })
    expect(after.tools).toContain('mcp__gated__hello')
    expect(after.tools).not.toContain('mcp__gated__authenticate')
  } finally {
    restoreEnv()
  }
}, 60_000)

/** A name the session never configured is a host error, not a connection outcome. */
test('authenticateMcpServer REJECTS AN UNKNOWN SERVER', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  await expect(session.authenticateMcpServer('nope')).rejects.toThrow('Server not found: nope')
  expect(reconnects).toBe(0)
}, 30_000)

/** In-process SDK tools have no OAuth flow to start. */
test('authenticateMcpServer REJECTS A SERVER WITHOUT AN OAUTH TRANSPORT', async () => {
  const session = openSessionWith({ local: { type: 'sdk', name: 'local', tools: [] } })

  await expect(session.authenticateMcpServer('local')).rejects.toThrow(
    'Server type "sdk" does not support OAuth authentication',
  )
  expect(reconnects).toBe(0)
}, 30_000)

/**
 * Asking again replaces the first attempt rather than racing it — same rule
 * as the authenticate tool and cli/print.ts mcp_authenticate, for the same
 * reason: each attempt registers its own client, and the first one left
 * running would exchange its code with the second's client.
 */
test('ASKING AGAIN SUPERSEDES THE EARLIER ATTEMPT, AND THE NEW ONE COMPLETES', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  const firstUrls: string[] = []
  const secondUrls: string[] = []
  const first = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => firstUrls.push(seen),
  })
  // A handler now, not after the second call: the supersede rejects this
  // while the test is still waiting for the second URL, and a rejection
  // with no handler yet is an unhandled error. (A plain .catch, as the
  // file does for background flows — expect().rejects attached this early
  // hangs the runner.)
  const firstRejected = first.catch(() => 'caught')
  await waitFor(() => firstUrls.length > 0)
  const second = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => secondUrls.push(seen),
  })
  await waitFor(() => secondUrls.length > 0)
  expect(secondUrls[0]).not.toBe(firstUrls[0])

  // The first link no longer leads anywhere, and its promise rejects.
  await expect(firstRejected).resolves.toBe('caught')
  await expect(fetch(callbackFor(firstUrls[0]!))).rejects.toThrow()
  expect(storedAccessTokens()).toEqual([])

  // The second does, with the client it was issued to.
  expect((await fetch(callbackFor(secondUrls[0]!))).status).toBe(200)
  const status = await second
  expect(status.status).toBe('connected')
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf({ authUrl: secondUrls[0] } as McpAuthOutput)}`])
  expect(refusedExchanges).toBe(0)
}, 30_000)

/**
 * Closing the session stops the flow, as the authenticate tool's does: the
 * callback listener goes away, nothing is stored, nothing reconnects.
 */
test('CLOSING THE SESSION ABORTS AN IN-FLIGHT FLOW', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)

  session.close()

  await expect(done).rejects.toThrow()
  // The user finishing in the browser after close reaches nothing.
  await expect(fetch(callbackFor(seenUrls[0]!))).rejects.toThrow()
  expect(storedAccessTokens()).toEqual([])
  expect(reconnects).toBe(0)
}, 30_000)

/**
 * A flow that fails — here the stand-in refuses the code exchange — rejects
 * instead of resolving with a status, and leaves nothing half-connected.
 */
test('A FAILED EXCHANGE REJECTS, AND NOTHING RECONNECTS', async () => {
  const url = serveNeedingAuth(true)
  const session = openGatedSession(url)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)

  await expect(done).rejects.toThrow()
  expect(storedAccessTokens()).toEqual([])
  expect(reconnects).toBe(0)
}, 30_000)

// ============================================================================
// CodeRabbit follow-up on #2493.
// ============================================================================

/**
 * The first turn and a pre-turn sign-in share one initialization: if both
 * start it, the turn's delayed install must not put the needs-auth client
 * and pseudo-tool back over the reconnected server.
 *
 * The turn starts first, so its connect is the one stalled in
 * authorization-server metadata; the sign-in then joins the same
 * initialization instead of starting its own. (The stall is released
 * promptly: the MCP SDK times out a held metadata fetch on its own.)
 */
test('A FIRST TURN OVERLAPPING PRE-TURN AUTHENTICATION INSTALLS THE MCP SERVERS ONCE', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldMetadata = { arrived: false, answer, answered }
  const held = heldMetadata

  // The first turn starts first: its connect stalls in metadata, and its
  // sendMessage has already run init(), so the sign-in below reaches the
  // shared initialization within a tick.
  const turn = (async () => {
    for await (const _ of session.sendMessage('hi')) {
      // The recording engine yields nothing; the turn ends after the connect.
    }
  })()
  await waitFor(() => held.arrived)

  const seenUrls: string[] = []
  const auth = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  // A rejection with no handler yet is an unhandled error; the flow is
  // abandoned at teardown, when the session closes.
  const authCaught = auth.catch(() => 'caught')
  // Let the sign-in reach the shared initialization before releasing the
  // stall: init is memoized by now, so a tick of microtasks is enough.
  await Bun.sleep(10)
  held.answer()
  await turn
  await waitFor(() => seenUrls.length > 0)

  // The connect installed once, for both callers.
  expect(calls.setMcpClients).toHaveLength(1)
  expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'needs-auth'],
  ])
  expect(calls.updateTools).toHaveLength(1)
  expect(calls.updateTools[0]!.map(tool => tool.name)).toContain('mcp__gated__authenticate')

  session.close()
  await expect(authCaught).resolves.toBe('caught')
}, 30_000)

/**
 * An aborted sign-in must not wait for an unrelated server's connection
 * timeout: the caller's signal is observed while initialization runs, and
 * the initialization itself keeps running for the session — a first turn
 * still gets its servers.
 */
test('ABORTING A SIGN-IN DURING MCP INITIALIZATION REJECTS AT ONCE, AND THE CONNECT STILL LANDS', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldMetadata = { arrived: false, answer, answered }
  const held = heldMetadata

  const caller = new AbortController()
  const done = session.authenticateMcpServer('gated', { signal: caller.signal })
  const rejected = done.catch(error => error)
  await waitFor(() => held.arrived)
  caller.abort()

  // The sign-in rejects while the metadata is still held — it did not wait
  // for the connect to finish.
  const error = await Promise.race([
    rejected,
    Bun.sleep(2_000).then(() => {
      throw new Error('sign-in still pending after the caller aborted')
    }),
  ])
  expect(error).toBeInstanceOf(realAuth.AuthenticationCancelledError)

  // The session's own initialization was not cancelled with it.
  held.answer()
  await waitFor(() => calls.setMcpClients.length > 0)
  expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'needs-auth'],
  ])
}, 30_000)

/**
 * The flow's credentials belong to the namespace it started in. Another
 * session's turn may apply its own environment while the user is in the
 * browser; the exchange, the cache clear and the reconnect must still land
 * where the flow began.
 */
test('authenticateMcpServer FINISHES IN THE NAMESPACE IT STARTED IN WHEN THE ENVIRONMENT CHANGES MID-FLOW', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const session = openGatedSession(url)
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)

    // Another session's turn applies its own environment while the user is
    // in the browser.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)

    const status = await done
    expect(status.status).toBe('connected')
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
    expect(stores.has(storeIn(ambient))).toBe(false)
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * A caller abort that lands while the reconnect is pending must not install
 * the reconnected client or resolve: the attempt is over, and the session
 * keeps its needs-auth client and pseudo-tool. The abort must propagate
 * through the stalled reconnect: the promise rejects within a bounded
 * interval while the response is still held — not when the server
 * eventually answers — and the reconnect must have released the
 * environment mutex it held, so another environment-scoped operation can
 * progress while the response is still held.
 */
test('ABORTING DURING THE RECONNECT REJECTS AND INSTALLS NOTHING', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdInitialize()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  await waitFor(() => held.arrived)
  caller.abort()
  try {
    await expect(settlesWithin(done, 5_000)).rejects.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
    // Only the initial connect installed; the cancelled reconnect installed
    // nothing.
    expect(calls.setMcpClients).toHaveLength(1)
    expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
      ['gated', 'needs-auth'],
    ])
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * Closing the session while the reconnect is pending must reject, not
 * report a successful status for a connection the closed session will
 * never use. The close must propagate through the stalled reconnect: the
 * promise rejects within a bounded interval while the response is still
 * held, and the reconnect must have released the environment mutex it
 * held, so another environment-scoped operation can progress while the
 * response is still held.
 */
test('CLOSING DURING THE RECONNECT REJECTS INSTEAD OF REPORTING SUCCESS', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdInitialize()

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  await waitFor(() => held.arrived)
  session.close()
  try {
    await expect(settlesWithin(done, 5_000)).rejects.toThrow('SDK session is closed')
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
    expect(calls.setMcpClients).toHaveLength(1)
    expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
      ['gated', 'needs-auth'],
    ])
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * A newer sign-in that starts while the earlier attempt's reconnect is
 * pending supersedes it: the earlier attempt must not install its result
 * or resolve — only the new attempt's client lands.
 */
test('SUPERSEDING DURING THE RECONNECT INSTALLS ONLY THE NEW ATTEMPT', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdInitialize()

  const firstUrls: string[] = []
  const first = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => firstUrls.push(seen),
  })
  const firstRejected = first.catch(error => error)
  await waitFor(() => firstUrls.length > 0)
  expect((await fetch(callbackFor(firstUrls[0]!))).status).toBe(200)
  await waitFor(() => held.arrived)

  const secondUrls: string[] = []
  const second = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => secondUrls.push(seen),
  })
  const secondOutcome = second.then(
    status => ({ ok: true as const, status }),
    error => ({ ok: false as const, error }),
  )
  await waitFor(() => secondUrls.length > 0)
  expect((await fetch(callbackFor(secondUrls[0]!))).status).toBe(200)
  // Superseding cancels the first attempt's reconnect, so the second flow's
  // exchange no longer waits behind the stalled first reconnect — only the
  // second reconnect's own initialize is still held. Release it: the first
  // attempt is then fenced off, and the second flow completes.
  held.answer()
  await waitFor(() => reconnects === 2)

  await expect(firstRejected).resolves.toBeInstanceOf(realAuth.AuthenticationCancelledError)
  const outcome = await secondOutcome
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.status.status).toBe('connected')
  // The initial connect, then only the new attempt's install.
  expect(calls.setMcpClients).toHaveLength(2)
  expect(calls.setMcpClients.at(-1)!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'connected'],
  ])
}, 30_000)

/**
 * If the tool pool rejects the swap — here an agent references the
 * authenticate tool the reconnect drops — the reconnected client was never
 * installed, so close() cannot clean it up. It stays in the connection
 * cache instead of being closed: another session may have adopted it while
 * the reconnect was in flight, and closing it would close its transport
 * and fail its in-flight MCP calls. The next connection reuses it instead
 * of dialling again.
 */
test('A REJECTED TOOL SWAP LEAVES THE RECONNECTED CLIENT IN THE SHARED CACHE', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session, tools => {
    // The real engine's validation: an agent referencing a tool the new
    // pool drops rejects the swap before anything is committed.
    if (!tools.some(tool => tool.name === 'mcp__gated__authenticate')) {
      throw new TypeError(
        `updateTools: agent 'auth-agent' references tool 'mcp__gated__authenticate' which is not in the new tool set`,
      )
    }
  })

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)

  await expect(done).rejects.toThrow('references tool')
  expect(calls.setMcpClients).toHaveLength(1)

  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  const cached = realClient.connectToServer.cache.get(key) as Promise<MCPServerConnection> | undefined
  expect(cached).toBeDefined()
  const kept = (await cached!) as MCPServerConnection
  expect(kept.type).toBe('connected')

  // The next connection reuses it instead of dialling again.
  const adopted = await connectSdkMcpServers({ gated: { type: 'http', url } })
  try {
    expect(adopted.clients[0]).toBe(kept)
  } finally {
    for (const client of adopted.clients) {
      if (client.type === 'connected') await client.cleanup()
    }
  }
}, 30_000)

/**
 * While one session's reconnect is in flight, another session can adopt
 * the cached client it is dialling. If the first session's tool swap then
 * fails, its cleanup must not close the client the second session is
 * using — the second session's calls must still work.
 */
test('A REJECTED TOOL SWAP DOES NOT CLOSE A CLIENT ANOTHER SESSION ADOPTED', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session, tools => {
    // The real engine's validation: an agent referencing a tool the new
    // pool drops rejects the swap before anything is committed.
    if (!tools.some(tool => tool.name === 'mcp__gated__authenticate')) {
      throw new TypeError(
        `updateTools: agent 'auth-agent' references tool 'mcp__gated__authenticate' which is not in the new tool set`,
      )
    }
  })
  const held = holdInitialize()

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  await waitFor(() => held.arrived)

  // A second session adopts the client this reconnect is dialling.
  const adoptedPromise = connectSdkMcpServers({ gated: { type: 'http', url } })
  held.answer()
  const adopted = await adoptedPromise
  const adoptedClient = adopted.clients[0]!
  expect(adoptedClient.type).toBe('connected')
  try {
    await expect(done).rejects.toThrow('references tool')
    expect(calls.setMcpClients).toHaveLength(1)
    // The adopted client is still alive: its calls work.
    if (adoptedClient.type !== 'connected') throw new Error('expected a connected client')
    const listed = await adoptedClient.client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['hello'])
  } finally {
    for (const client of adopted.clients) {
      if (client.type === 'connected') await client.cleanup()
    }
  }
}, 30_000)

/**
 * The fence after the connect has settled: a cancelled attempt must not
 * close a connection another session adopted while its reconnect was in
 * flight. The reconnect's connect has settled by the time its tools
 * fetch runs, so a second caller dialling the same server adopts the
 * connected client from the cache — and an abort landing in that window
 * must fence the attempt off without closing the adopted transport.
 * The shared-reconnect test covers the abort landing while the connect
 * is still stalled; this one covers the abort landing after it settled.
 */
test('ABORTING DURING THE RECONNECT DOES NOT CLOSE A CLIENT ANOTHER SESSION ADOPTED', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // Hold the reconnect's tools fetch: its connect has settled by then, so
  // the client is live and cached while the fence is still to come.
  const held = holdToolsList()
  await waitFor(() => held.arrived)
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  // A second caller dialling the same server adopts the connected client
  // from the cache — through connectToServer, as a real session would, so
  // the adoption registers before the abort below. Reading the cache
  // directly would hold the client without adopting it.
  const adopted = (await realClient.connectToServer('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)) as MCPServerConnection
  expect(adopted.type).toBe('connected')
  if (adopted.type !== 'connected') throw new Error('expected a connected client')
  // Another session adopted it: count cleanups on the shared object.
  let cleanups = 0
  const originalCleanup = adopted.cleanup
  adopted.cleanup = async () => {
    cleanups++
    return originalCleanup()
  }
  try {
    caller.abort()
    held.answer()
    await expect(settlesWithin(done, 5_000)).rejects.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The fence left the adopted client alone: still cached, still the
    // same object, never cleaned up — and the session installed nothing.
    expect(cleanups).toBe(0)
    expect(await realClient.connectToServer.cache.get(key)).toBe(adopted)
    expect(calls.setMcpClients).toHaveLength(1)
    // The adopted client is still alive: its calls work.
    const listed = await adopted.client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['hello'])
  } finally {
    adopted.cleanup = originalCleanup
    held.answer()
    await adopted.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * A reconnect that fails must report the failure with a reason and drop
 * the server's stale tools — a host that only sees `failed` with no
 * error cannot tell a dead server from a refused token, and calls to the
 * stale tools would fail with nothing offering recovery.
 */
test('A RECONNECT THAT FAILS REPORTS FAILED WITH AN ERROR AND DROPS THE STALE TOOLS', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  // First sign-in: the pool holds the server's real tool.
  const firstUrls: string[] = []
  const first = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => firstUrls.push(seen),
  })
  await waitFor(() => firstUrls.length > 0)
  expect((await fetch(callbackFor(firstUrls[0]!))).status).toBe(200)
  expect((await first).status).toBe('connected')
  expect(calls.updateTools.at(-1)!.map(tool => tool.name)).toContain('mcp__gated__hello')

  // The server is down for the next reconnect: its initialize fails.
  failMcpRequests = true
  try {
    const secondUrls: string[] = []
    const second = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => secondUrls.push(seen),
    })
    await waitFor(() => secondUrls.length > 0)
    expect((await fetch(callbackFor(secondUrls[0]!))).status).toBe(200)

    const status = await second
    expect(status.status).toBe('failed')
    expect(typeof status.error).toBe('string')
    expect(status.error!.length).toBeGreaterThan(0)
    expect(calls.updateTools.at(-1)!.map(tool => tool.name)).not.toContain('mcp__gated__hello')
    expect(calls.setMcpClients.at(-1)!.map(client => [client.name, client.type])).toEqual([
      ['gated', 'failed'],
    ])
  } finally {
    failMcpRequests = false
  }
}, 30_000)

/**
 * A previously connected server can still answer 401 after OAuth — its
 * tokens are no good any more. The session must not keep the real tools:
 * calls to them would fail, and nothing offers recovery. The pool gets
 * the authenticate tool instead, as a server that starts out needs-auth
 * does.
 */
test('A RECONNECT THAT STILL NEEDS AUTH REPLACES THE STALE REAL TOOLS WITH THE AUTHENTICATE TOOL', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  const firstUrls: string[] = []
  const first = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => firstUrls.push(seen),
  })
  await waitFor(() => firstUrls.length > 0)
  expect((await fetch(callbackFor(firstUrls[0]!))).status).toBe(200)
  expect((await first).status).toBe('connected')
  expect(calls.updateTools.at(-1)!.map(tool => tool.name)).toContain('mcp__gated__hello')

  // The server stops accepting the tokens it issued.
  rejectTokens = true
  const secondUrls: string[] = []
  const second = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => secondUrls.push(seen),
  })
  await waitFor(() => secondUrls.length > 0)
  expect((await fetch(callbackFor(secondUrls[0]!))).status).toBe(200)
  const status = await second
  expect(status.status).toBe('needs-auth')

  const afterReconnect = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterReconnect).toContain('mcp__gated__authenticate')
  expect(afterReconnect).not.toContain('mcp__gated__hello')
  expect(calls.setMcpClients.at(-1)!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'needs-auth'],
  ])
}, 30_000)

/**
 * The late-client case, written down: a session that closes while its
 * first connect is still in flight discards a client the connection cache
 * still owns. The next session reuses that same client instead of dialling
 * again, so nothing is orphaned — which is why close-mid-connect releases
 * nothing here. If that retention ever goes away, this test fails first.
 */
test('CLOSING WHILE THE FIRST CONNECT IS IN FLIGHT LEAVES THE SHARED CONNECTION FOR THE NEXT SESSION', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  let answer!: () => void
  const answered = new Promise<void>(resolve => {
    answer = resolve
  })
  heldMetadata = { arrived: false, answer, answered }
  const held = heldMetadata
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)

  const seenUrls: string[] = []
  const auth = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  const authCaught = auth.catch(() => 'caught')
  await waitFor(() => held.arrived)
  const inFlight = realClient.connectToServer.cache.get(key) as Promise<unknown> | undefined
  expect(inFlight).toBeDefined()

  session.close()
  held.answer()
  await expect(authCaught).resolves.toBe('caught')
  const late = (await inFlight) as MCPServerConnection
  expect(late.type).toBe('needs-auth')

  // The next session gets that same client, not a fresh connection.
  const next = await connectSdkMcpServers({ gated: { type: 'http', url } })
  try {
    expect(next.clients[0]).toBe(late)
  } finally {
    for (const client of next.clients) {
      if (client.type === 'connected') await client.cleanup()
    }
  }
}, 30_000)

// ============================================================================
// Round 2 (#2493): CodeRabbit re-review follow-ups.
// ============================================================================

/**
 * If the first connection fails, the pool holds no tools for the server at
 * all — and a later reconnect that still needs auth must still offer the
 * model the authenticate tool. The next turn would otherwise report
 * needs-auth with no way to act on it.
 */
test('A RECONNECT THAT STILL NEEDS AUTH INSTALLS THE AUTHENTICATE TOOL WHEN THE SERVER HAS NO TOOLS', async () => {
  const url = serveNeedingAuth()
  failMcpRequests = true
  const session = openGatedSession(url)
  const calls = recordEngine(session)

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  // The initial connect failed above, so the pool holds nothing for the
  // server; only now does the server answer again — and refuse the tokens.
  await waitFor(() => seenUrls.length > 0)
  failMcpRequests = false
  rejectTokens = true
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)

  const status = await done
  expect(status.status).toBe('needs-auth')
  const afterReconnect = calls.updateTools.at(-1)!.map(tool => tool.name)
  expect(afterReconnect).toContain('mcp__gated__authenticate')
  expect(calls.setMcpClients.at(-1)!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'needs-auth'],
  ])
}, 30_000)

/**
 * The connected-client half of the late-connection case: a session that
 * closes while its first connect is still in flight discards a client the
 * connection cache still owns. The next session reuses that same client
 * instead of dialling again — and closing the session that adopted it
 * cleans it up, so the transport is not left behind.
 */
test('CLOSING WHILE THE FIRST CONNECT IS IN FLIGHT KEEPS THE CONNECTED CLIENT FOR THE NEXT SESSION, WHICH CLEANS IT UP ON CLOSE', async () => {
  const url = serveNeedingAuth()
  const first = openGatedSession(url)
  const firstUrls: string[] = []
  const firstDone = first.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => firstUrls.push(seen),
  })
  await waitFor(() => firstUrls.length > 0)
  expect((await fetch(callbackFor(firstUrls[0]!))).status).toBe(200)
  expect((await firstDone).status).toBe('connected')
  expect(storedAccessTokens()).toHaveLength(1)

  // The next session dials fresh — drop the connected client the first
  // session cached — and stalls at an authorized initialize.
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  realClient.connectToServer.cache.delete(key)
  const second = openGatedSession(url)
  const held = holdInitialize()
  const auth = second.authenticateMcpServer('gated', {
    onAuthorizationUrl: () => {},
  })
  const authCaught = auth.catch(() => 'caught')
  await waitFor(() => held.arrived)
  const inFlight = realClient.connectToServer.cache.get(key) as Promise<unknown> | undefined
  expect(inFlight).toBeDefined()

  second.close()
  held.answer()
  await expect(authCaught).resolves.toBe('caught')
  const late = (await inFlight) as MCPServerConnection
  expect(late.type).toBe('connected')

  // The next session adopts that same client, not a fresh connection.
  const next = openGatedSession(url)
  const calls = recordEngine(next)
  for await (const _ of next.sendMessage('hi')) {
  }
  expect(calls.setMcpClients.at(-1)?.[0]).toBe(late)

  // And closing the session that adopted it cleans it up: the cache entry
  // is gone, so nothing still owns the transport.
  next.close()
  await waitFor(() => realClient.connectToServer.cache.get(key) === undefined)
}, 30_000)

/** An SDK session holding the gated server, with env and a canUseTool callback. */
function openGatedSessionWithEnv(url: string, canUseTool: CanUseToolCallback): SDKSession {
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    mcpServers: { gated: { type: 'http', url } },
    // Any nonempty env makes the turn hold the environment mutex; the
    // variable itself is inert and touches no credential namespace.
    env: { OPENCLAUDE_TEST_TURN: '1' },
    canUseTool,
  })
  sdkSessions.push(session)
  return session
}

/**
 * An engine whose turn asks the host's canUseTool before a tool runs — the
 * stand-in for the real engine's permission check — and otherwise does
 * nothing. The turn holds the session's environment for its whole duration,
 * so the callback runs inside the turn's mutex hold.
 */
function recordCanUseToolEngine(session: SDKSession, onPermission: () => Promise<unknown>) {
  const recorded = recordingEngine()
  const engine = {
    ...recorded.engine,
    submitMessage: async function* (): AsyncGenerator<never> {
      await onPermission()
    },
  }
  ;(session as unknown as { setEngine: (engine: unknown) => void }).setEngine(engine)
  return recorded.calls
}

/**
 * A canUseTool callback that awaits authenticateMcpServer during a turn
 * with env: the turn holds the environment mutex, and the sign-in must
 * borrow that turn's environment instead of waiting on its own turn's
 * mutex — otherwise neither the turn nor the sign-in can ever finish.
 */
test('A canUseTool CALLBACK THAT SIGNS IN DURING AN ENV TURN DOES NOT DEADLOCK', async () => {
  const url = serveNeedingAuth()
  let signIn: ReturnType<SDKSession['authenticateMcpServer']> | undefined
  const seenUrls: string[] = []
  const canUseTool: CanUseToolCallback = async () => {
    signIn = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    const status = await signIn
    expect(status.status).toBe('connected')
    return { behavior: 'allow' as const }
  }
  const session = openGatedSessionWithEnv(url, canUseTool)
  const calls = recordCanUseToolEngine(session, () => canUseTool('mcp__gated__authenticate', {}))

  const turn = (async () => {
    for await (const _ of session.sendMessage('hi')) {
    }
  })()
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The turn — and the sign-in it awaited — finish within a bound instead
  // of waiting on the mutex forever.
  await settlesWithin(turn, 10_000)
  expect(signIn).toBeDefined()
  await expect(signIn!).resolves.toMatchObject({ status: 'connected' })
  expect(calls.setMcpClients.at(-1)!.map(client => [client.name, client.type])).toEqual([
    ['gated', 'connected'],
  ])
}, 30_000)

/**
 * The mirror image: a pre-turn sign-in that waits on init() while the
 * first turn takes the environment mutex for agent loading. When the
 * sign-in resumes, its setup must not publish a shared connect the turn
 * then joins while holding that mutex — the turn would wait on
 * initialization that waits on the turn, and neither could finish. The
 * turn connects in its own environment instead, and the sign-in follows
 * once the turn releases the mutex.
 *
 * The ordering is exercised, not assumed: the sign-in starts first, so
 * its registration finishes before the turn takes the mutex — the turn
 * is then held in agent loading while the sign-in reaches setup, and the
 * turn must finish before the sign-in gets the mutex. A setup that
 * published its promise before entering the scope would let the turn
 * join it at the connect below and deadlock, instead of finishing.
 */
test('A PRE-TURN SIGN-IN HELD ON INIT DOES NOT DEADLOCK THE FIRST TURN', async () => {
  const url = serveNeedingAuth()
  const canUseTool: CanUseToolCallback = async () => ({ behavior: 'allow' as const })
  const session = openGatedSessionWithEnv(url, canUseTool)
  recordEngine(session)
  const held = holdInit()
  const heldAgents = holdAgentDefinitions()

  // Hold the mutex in the test so the sign-in's registration queues
  // behind it: when init answers, the sign-in reaches registration only
  // after the test releases the mutex — and the turn, started in the
  // same synchronous block as that release, takes the mutex before the
  // sign-in's setup acquire is queued. The sign-in therefore reaches
  // setup while the turn holds the mutex, instead of waiting at
  // registration: if setup published its connect before entering the
  // scope, the turn would join it and deadlock.
  const { acquired: testMutexAcquired } = await acquireEnvMutex()
  expect(testMutexAcquired).toBe(true)
  let testMutexHeld = true
  try {
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    void done.catch(() => {})
    held.answer()
    // Let the sign-in's init resolve and its registration acquire queue
    // behind the test-held mutex; the sign-in produces no URL while it
    // waits at registration.
    await Bun.sleep(1_000)
    expect(seenUrls).toHaveLength(0)

    // Release the mutex and start the turn in one synchronous block:
    // the release wakes the registration waiter first, the turn's init
    // is already resolved so its mutex acquire is queued next, and the
    // sign-in's setup acquire is queued last — the turn holds the mutex
    // through agent loading while the sign-in waits at setup.
    releaseEnvMutex()
    testMutexHeld = false
    const turn = (async () => {
      for await (const _ of session.sendMessage('hi')) {
      }
    })()
    // The turn is held in agent loading, holding the mutex; the sign-in
    // has reached setup by now and waits on that mutex — it has
    // published no shared connect for the turn to join.
    await waitFor(() => heldAgents.arrived)
    // The turn can finish before the sign-in gets the mutex: releasing
    // the agent-loading hold lets the turn connect in its own
    // environment and finish, while the sign-in still waits for the
    // mutex.
    heldAgents.answer()
    await settlesWithin(turn, 10_000)
    // The sign-in reaches its browser step instead of waiting on a
    // connect the turn joined: the URL arrives within a bound.
    await settlesWithin(waitFor(() => seenUrls.length > 0), 5_000)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // And the sign-in finishes once the turn releases the mutex.
    await expect(settlesWithin(done, 5_000)).resolves.toMatchObject({ status: 'connected' })
  } finally {
    if (testMutexHeld) releaseEnvMutex()
  }
}, 30_000)

/**
 * The reconnect scope and the surviving-discovery scope share one
 * snapshot of the session env: a host env whose getter answers
 * differently per read must not give the two scopes different
 * credential homes. The host object is read once per key — for the
 * snapshot — not once per scope.
 */
test('THE TWO CREDENTIAL SCOPES SHARE ONE SNAPSHOT OF THE SESSION ENV', async () => {
  const url = serveNeedingAuth()
  let reads = 0
  const target = { OPENCLAUDE_TEST_SNAPSHOT: '1' }
  const env = new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === 'OPENCLAUDE_TEST_SNAPSHOT') reads++
      return Reflect.get(t, prop, receiver)
    },
  })
  const session = unstable_v2_createSession({
    cwd: process.cwd(),
    mcpServers: { gated: { type: 'http', url } },
    env,
  })
  sdkSessions.push(session)
  recordEngine(session)
  const readsAtSignIn = reads
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  void done.catch(() => {})
  await settlesWithin(waitFor(() => seenUrls.length > 0), 5_000)
  // Both scopes were captured before the browser step: the host env was
  // read once, for the snapshot — a second read would mean one scope
  // read the live object again.
  expect(reads - readsAtSignIn).toBe(1)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  await expect(settlesWithin(done, 5_000)).resolves.toMatchObject({ status: 'connected' })
}, 30_000)

/**
 * The snapshot reads `this.options.env` once: a host env getter that
 * answers differently per read must not give the snapshot the second
 * answer — reading the value in both the condition and the spread
 * would snapshot the later object, and the sign-in would store its
 * token in the wrong namespace (CodeRabbit #2493 review 5955577457).
 */
test('THE CREDENTIAL SNAPSHOT READS THE SESSION ENV GETTER ONCE', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const homeA = join(configHome, 'getter-first')
  const homeB = join(configHome, 'getter-later')
  try {
    const url = serveNeedingAuth()
    let reads = 0
    const options: Parameters<typeof unstable_v2_createSession>[0] = {
      cwd: process.cwd(),
      mcpServers: { gated: { type: 'http', url } },
    }
    Object.defineProperty(options, 'env', {
      configurable: true,
      get() {
        reads++
        return reads === 1
          ? { OPENCLAUDE_CONFIG_DIR: homeA }
          : { OPENCLAUDE_CONFIG_DIR: homeB }
      },
    })
    const session = unstable_v2_createSession(options)
    sdkSessions.push(session)
    recordEngine(session)

    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The snapshot holds the first answer: the token lands in the
    // first namespace, and the later namespace was never touched.
    expect(storedAccessTokens(storeIn(homeA))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
    expect(stores.has(storeIn(homeB))).toBe(false)
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * An abort that lands after the registration callback is scheduled but
 * before it runs must not register: registration would supersede another
 * session's pending sign-in for the same credential entry, and the
 * replacement then rejects without starting OAuth. The abort lands in
 * the same synchronous block as the mutex release that schedules the
 * callback, so the callback runs with the attempt already aborted —
 * while the other session's sign-in still completes.
 */
test('AN ABORTED SIGN-IN DOES NOT SUPERSEDE ANOTHER SESSION\'S PENDING SIGN-IN', async () => {
  const url = serveNeedingAuth()
  // Session A registers first and waits at its browser step.
  const sessionA = openGatedSession(url)
  recordEngine(sessionA)
  const seenA: string[] = []
  const doneA = sessionA.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenA.push(seen),
  })
  const doneACaught = doneA.catch(error => error)
  await waitFor(() => seenA.length > 0)
  // Hold the mutex so session B's registration waits on it.
  const { acquired } = await acquireEnvMutex()
  expect(acquired).toBe(true)
  let held = true
  const callerB = new AbortController()
  try {
    const sessionB = openGatedSession(url)
    recordEngine(sessionB)
    const seenB: string[] = []
    const doneB = sessionB.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenB.push(seen),
      signal: callerB.signal,
    })
    const doneBCaught = doneB.catch(error => error)
    // B reached its registration wait: it produced no URL while the
    // mutex was held.
    await new Promise(resolve => setImmediate(resolve))
    expect(seenB).toHaveLength(0)
    // Release the mutex and abort B in the same synchronous block: the
    // registration callback is scheduled by the release but has not run.
    releaseEnvMutex()
    held = false
    callerB.abort()
    // B rejects as cancelled without registering...
    await expect(settlesWithin(doneBCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // ...and A was not superseded: its browser step still completes it.
    expect((await fetch(callbackFor(seenA[0]!))).status).toBe(200)
    await expect(settlesWithin(doneACaught, 5_000)).resolves.toMatchObject({
      status: 'connected',
    })
  } finally {
    // Abort first: while B is still queued, the abort settles its mutex
    // wait as cancelled, so the registration callback never runs.
    callerB.abort()
    if (held) releaseEnvMutex()
  }
}, 30_000)

/**
 * On Windows, process.env is case-insensitive but the pre-turn scope
 * builds its env from a case-sensitive Map: an `env` override that
 * deletes `openclaude_config_dir` must remove an inherited
 * `OPENCLAUDE_CONFIG_DIR`, or pre-turn authentication uses the ambient
 * config home instead of the session's override. Other platforms keep
 * exact-key matching.
 */
test('AN ENV OVERRIDE DELETES AN INHERITED VARIABLE CASE-INSENSITIVELY ON WINDOWS', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', 'openclaude_config_dir'])
  const originalPlatform = process.platform
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = join(configHome, 'ambient')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const scope = captureCredentialScope(undefined, {
      env: { openclaude_config_dir: undefined },
    })
    expect(await scope(async () => process.env.OPENCLAUDE_CONFIG_DIR)).toBeUndefined()
    // On other platforms the same override deletes only its exact key.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const linuxScope = captureCredentialScope(undefined, {
      env: { openclaude_config_dir: undefined },
    })
    expect(await linuxScope(async () => process.env.OPENCLAUDE_CONFIG_DIR)).toBe(
      join(configHome, 'ambient'),
    )
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    restoreEnv()
  }
}, 30_000)

/**
 * The defined-write mirror of the deletion case above: on Windows, an
 * `env` override that sets `openclaude_config_dir` must replace an
 * inherited `OPENCLAUDE_CONFIG_DIR` — keeping both spellings would let
 * replay restore the stale inherited value last when the ambient key
 * was recreated in lowercase, so pre-turn authentication would use the
 * ambient config home instead of the session's override. Other
 * platforms keep exact-key matching (CodeRabbit #2493 review
 * 5955577457).
 */
test('AN ENV OVERRIDE REPLACES AN INHERITED VARIABLE CASE-INSENSITIVELY ON WINDOWS', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', 'openclaude_config_dir'])
  const originalPlatform = process.platform
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = join(configHome, 'ambient')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const scope = captureCredentialScope(undefined, {
      env: { openclaude_config_dir: join(configHome, 'session') },
    })
    // The snapshot keeps one entry per case-insensitive key: the
    // inherited spelling is gone, so replay deletes it and the
    // override's spelling carries the session home. (On Linux the two
    // spellings are distinct variables, so the override lands under its
    // own spelling while the inherited one is removed; on Windows both
    // spellings are the one variable, which ends as the session home.)
    // The assertions below read process.env, whose case rules come from
    // the real host — stubbing process.platform does not change them —
    // so the inherited spelling's expected value is derived from the
    // platform captured before stubbing, not the stubbed one: on native
    // Windows both spellings read the session home, elsewhere the
    // inherited spelling keeps the ambient value (CodeRabbit #2493
    // review 5956557301).
    const isNativeWindows = originalPlatform === 'win32'
    expect(
      await scope(async () => [
        process.env.OPENCLAUDE_CONFIG_DIR,
        process.env.openclaude_config_dir,
      ]),
    ).toEqual([
      isNativeWindows ? join(configHome, 'session') : undefined,
      join(configHome, 'session'),
    ])
    // On other platforms the same override sets only its exact key and
    // the inherited spelling survives.
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const linuxScope = captureCredentialScope(undefined, {
      env: { openclaude_config_dir: join(configHome, 'session') },
    })
    expect(
      await linuxScope(async () => [
        process.env.OPENCLAUDE_CONFIG_DIR,
        process.env.openclaude_config_dir,
      ]),
    ).toEqual([
      isNativeWindows ? join(configHome, 'session') : join(configHome, 'ambient'),
      join(configHome, 'session'),
    ])
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    })
    restoreEnv()
  }
}, 30_000)

/**
 * The authenticate pseudo-tool, called during a turn with env, borrows the
 * turn's environment the same way: its exchange must finish while the turn
 * holds the mutex, not wait for a turn that cannot finish until the tool
 * returns. The tool is the session's own, read out of its pool — the one
 * its connect installed — and the turn is held open in its engine while
 * the tool runs.
 */
test('THE AUTHENTICATE TOOL CALLED DURING AN ENV TURN DOES NOT DEADLOCK', async () => {
  const url = serveNeedingAuth()
  const canUseTool: CanUseToolCallback = async () => ({ behavior: 'allow' as const })
  const session = openGatedSessionWithEnv(url, canUseTool)
  let releaseTurn!: () => void
  const turnReleased = new Promise<void>(resolve => {
    releaseTurn = resolve
  })
  // Teardown releases the gate if an assertion above fails before the
  // test's own release below.
  pendingTurnRelease = releaseTurn
  recordCanUseToolEngine(session, () => turnReleased)

  const turn = (async () => {
    for await (const _ of session.sendMessage('hi')) {
    }
  })()
  // The turn's first connect installed the authenticate tool.
  await waitFor(
    () =>
      (session as unknown as { mcpTools: Tool[] }).mcpTools.some(
        tool => tool.name === 'mcp__gated__authenticate',
      ),
  )
  const tool = (session as unknown as { mcpTools: Tool[] }).mcpTools.find(
    tool => tool.name === 'mcp__gated__authenticate',
  )!
  const toolSession = openSession()
  const { result } = await startSignIn(tool, toolSession)
  expect(result.status).toBe('auth_url')
  expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
  await flowEnded(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(result)}`])
  releaseTurn()
  pendingTurnRelease = null
  await settlesWithin(turn, 10_000)
}, 30_000)

/**
 * The flow's first credential operations belong to the namespace it
 * started in. Another session's turn may apply its own environment while
 * the initial connection is still running; the flow's read of the stored
 * entry and its clearing of it must still land where the flow began — a
 * clear in the other session's namespace would delete that session's saved
 * credentials.
 */
test('authenticateMcpServer KEEPS ITS INITIAL CREDENTIAL OPERATIONS IN THE NAMESPACE IT STARTED IN', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const serverKey = realAuth.getServerKey('gated', { type: 'http', url } as never)
    // Another session's saved entry for this server, in its own store.
    const seeded = {
      serverName: 'gated',
      serverUrl: url,
      accessToken: 'ambient-token',
      refreshToken: 'ambient-refresh',
      expiresAt: Date.now() + 3_600_000,
      clientId: 'ambient-client',
    }
    stores.set(storeIn(ambient), { mcpOAuth: { [serverKey]: seeded } })
    let answer!: () => void
    const answered = new Promise<void>(resolve => {
      answer = resolve
    })
    heldMetadata = { arrived: false, answer, answered }
    const held = heldMetadata

    const session = openGatedSession(url)
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held.arrived)
    // Another session's turn applies its own environment while this flow's
    // initial connection is still running.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    held.answer()

    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The flow's tokens landed where it started...
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
    // ...and the other session's saved entry survived the flow's initial
    // clear. The initial connection, which still runs in the ambient
    // environment, may add its discovery bookkeeping to the entry — the
    // credentials themselves must be intact, byte for byte.
    expect(stored(storeIn(ambient)).mcpOAuth?.[serverKey]).toMatchObject(seeded)
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * Sign-ins for one server share one credential entry, however they start.
 * A host-facing sign-in replaces a tool-started attempt still pending: the
 * tool's callback reaches nothing, and only the host attempt's tokens land.
 */
test('A HOST SIGN-IN ABORTS THE TOOL STARTED SIGN-IN FOR THE SAME SERVER, AND COMPLETES ITSELF', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const toolSession = openSession()
  const { result: toolResult } = await startSignIn(tools[0]!, toolSession)
  expect(toolResult.status).toBe('auth_url')

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect(seenUrls[0]).not.toBe(toolResult.authUrl)

  // The tool's attempt is over: its callback reaches nothing.
  await expect(fetch(callbackFor(toolResult.authUrl!))).rejects.toThrow()
  await flowEnded(0)

  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  expect((await done).status).toBe('connected')
  expect(refusedExchanges).toBe(0)
  expect(storedAccessTokens()).toEqual([
    `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
  ])
}, 30_000)

/**
 * The other direction: a tool-started sign-in replaces a host-facing
 * attempt still pending. The host attempt rejects as cancelled, its
 * callback reaches nothing, and only the tool attempt's tokens land.
 */
test('A TOOL STARTED SIGN-IN ABORTS THE HOST SIGN-IN FOR THE SAME SERVER, AND COMPLETES ITSELF', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => seenUrls.length > 0)

  const { tools } = await connectSdkMcpServers({ gated: { type: 'http', url } })
  const toolSession = openSession()
  const { result: toolResult } = await startSignIn(tools[0]!, toolSession)
  expect(toolResult.status).toBe('auth_url')

  // The host attempt is over: its callback reaches nothing, and its
  // promise rejects as cancelled.
  await expect(fetch(callbackFor(seenUrls[0]!))).rejects.toThrow()
  await expect(doneCaught).resolves.toBeInstanceOf(realAuth.AuthenticationCancelledError)

  expect((await fetch(callbackFor(toolResult.authUrl!))).status).toBe(200)
  await flowEnded(1)
  expect(refusedExchanges).toBe(0)
  expect(storedAccessTokens()).toEqual([`token-for-${clientOf(toolResult)}`])
}, 30_000)

/**
 * A sign-in called with an already-cancelled signal must reject at once,
 * before it aborts the attempt still pending or registers a replacement:
 * the superseded attempt's flow still completes, and its tokens still land.
 */
test('authenticateMcpServer WITH AN ALREADY-ABORTED SIGNAL REJECTS WITHOUT SUPERSEDING THE PENDING FLOW', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  const seenUrls: string[] = []
  const first = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)

  const caller = new AbortController()
  caller.abort()
  await expect(
    session.authenticateMcpServer('gated', { signal: caller.signal }),
  ).rejects.toBeInstanceOf(realAuth.AuthenticationCancelledError)

  // The pending flow was not superseded: its callback still works, and
  // its tokens still land.
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  expect((await first).status).toBe('connected')
  expect(storedAccessTokens()).toEqual([
    `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
  ])
}, 30_000)

/**
 * Two pre-turn sign-ins from sessions whose `env` points at different
 * config homes must stay independent: each flow's credentials belong to
 * its own home, so the later sign-in must not abort the earlier one's
 * browser flow. The keys are derived from the frozen session
 * environment, not the ambient one — sessions that resolve to the same
 * home still supersede each other (see the supersede test above).
 */
test('SIGN-INS FROM SESSIONS WITH DIFFERENT CONFIG HOMES DO NOT SUPERSEDE EACH OTHER', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store: the
  // test override would make every session resolve to the same home.
  const savedOverride = getClaudeConfigHomeDirOverrideForTesting()
  setClaudeConfigHomeDirForTesting(undefined)
  const dirA = join(configHome, 'home-a')
  const dirB = join(configHome, 'home-b')
  process.env.OPENCLAUDE_CONFIG_DIR = join(configHome, 'home-ambient')
  try {
    const url = serveNeedingAuth()
    const openSession = (dir: string): SDKSession => {
      const session = unstable_v2_createSession({
        cwd: process.cwd(),
        mcpServers: { gated: { type: 'http', url } },
        env: { OPENCLAUDE_CONFIG_DIR: dir },
      })
      sdkSessions.push(session)
      return session
    }
    const sessionA = openSession(dirA)
    const sessionB = openSession(dirB)

    const urlsA: string[] = []
    const first = sessionA.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => urlsA.push(seen),
    })
    void first.catch(() => {})
    await waitFor(() => urlsA.length > 0)
    const urlsB: string[] = []
    const second = sessionB.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => urlsB.push(seen),
    })
    void second.catch(() => {})
    await waitFor(() => urlsB.length > 0)

    // The second sign-in registered under its own home: the first
    // attempt is still pending, so its callback still works.
    expect((await fetch(callbackFor(urlsA[0]!))).status).toBe(200)
    await expect(settlesWithin(first, 5_000)).resolves.toMatchObject({ status: 'connected' })
    expect((await fetch(callbackFor(urlsB[0]!))).status).toBe(200)
    await expect(settlesWithin(second, 5_000)).resolves.toMatchObject({ status: 'connected' })
    // Each flow's tokens landed in its own home's store.
    expect(storedAccessTokens(storeIn(dirA))).toEqual([
      `token-for-${clientOf({ authUrl: urlsA[0] } as McpAuthOutput)}`,
    ])
    expect(storedAccessTokens(storeIn(dirB))).toEqual([
      `token-for-${clientOf({ authUrl: urlsB[0] } as McpAuthOutput)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(savedOverride)
    restoreEnv()
  }
}, 30_000)

/**
 * A sign-in that is waiting on the environment mutex — another turn holds
 * it — must reject promptly when its caller aborts, instead of waiting for
 * the mutex. The wait is abandoned, not queued behind the holder: the
 * attempt rejects while the mutex is still held, and the mutex is free
 * again afterwards.
 */
test('ABORTING WHILE WAITING ON THE ENVIRONMENT MUTEX REJECTS PROMPTLY', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)

  // Another turn holds the mutex: the sign-in's first credential work
  // blocks behind it, before the browser step is reached.
  const held = await acquireEnvMutex({ timeoutMs: 5_000 })
  expect(held.acquired).toBe(true)
  try {
    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    // The flow reaches the mutex wait, not the browser step: no URL yet.
    await Bun.sleep(200)
    expect(seenUrls).toHaveLength(0)
    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
  } finally {
    releaseEnvMutex()
  }
  // The mutex is free again: a later operation can take it.
  const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
  expect(acquired.acquired).toBe(true)
  releaseEnvMutex()
}, 30_000)

/**
 * The flow's clear of the stored entry rechecks cancellation first: a
 * sign-in aborted while the clear waits on the mutex must not delete the
 * tokens another sign-in stored — the abort rejects, and the seeded entry
 * is intact. The clear runs before the browser step, so the flow is still
 * waiting on the mutex when the abort lands.
 */
test('ABORTING BEFORE THE CLEAR LEAVES THE STORED TOKENS INTACT', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const serverKey = realAuth.getServerKey('gated', { type: 'http', url } as never)
  const seeded = {
    serverName: 'gated',
    serverUrl: url,
    accessToken: 'seeded-token',
    refreshToken: 'seeded-refresh',
    expiresAt: Date.now() + 3_600_000,
    clientId: 'seeded-client',
  }
  stores.set(namespace(), { mcpOAuth: { [serverKey]: seeded } })

  // The clear waits on the mutex this test holds.
  const held = await acquireEnvMutex({ timeoutMs: 5_000 })
  expect(held.acquired).toBe(true)
  try {
    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    // The flow reaches the clear's mutex wait, not the browser step: no
    // URL yet, and the seeded entry is still there.
    await Bun.sleep(200)
    expect(seenUrls).toHaveLength(0)
    expect(stored().mcpOAuth?.[serverKey]).toMatchObject(seeded)
    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The aborted clear never ran: the seeded entry is intact.
    expect(stored().mcpOAuth?.[serverKey]).toMatchObject(seeded)
  } finally {
    releaseEnvMutex()
  }
}, 30_000)

/**
 * The flow's credential scope is bound to the turn it started in. A tool
 * flow that starts during one turn and finishes — the user coming back
 * from the browser — during a later turn must still store its tokens
 * where it started: the later turn's environment must not lend itself to
 * the earlier flow's resume. The later turn is on the same session, so
 * its runInTurnEnv is what a re-read delegate would pick up; the ambient
 * config home differs between the turns, so the stores differ too.
 */
test('A TOOL FLOW THAT FINISHES DURING A LATER TURN STORES ITS TOKENS WHERE IT STARTED', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const later = join(configHome, 'later')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const canUseTool: CanUseToolCallback = async () => ({ behavior: 'allow' as const })
    const session = openGatedSessionWithEnv(url, canUseTool)
    let releaseTurn1!: () => void
    const turn1Released = new Promise<void>(resolve => {
      releaseTurn1 = resolve
    })
    let releaseTurn2!: () => void
    const turn2Released = new Promise<void>(resolve => {
      releaseTurn2 = resolve
    })
    let gate = turn1Released
    let turnsEntered = 0
    recordCanUseToolEngine(session, async () => {
      turnsEntered++
      await gate
    })
    pendingTurnRelease = releaseTurn1

    // The origin turn: the tool flow starts here, in the origin store.
    const turn1 = (async () => {
      for await (const _ of session.sendMessage('hi')) {
      }
    })()
    await waitFor(() => turnsEntered === 1)
    await waitFor(() =>
      (session as unknown as { mcpTools: Tool[] }).mcpTools.some(
        tool => tool.name === 'mcp__gated__authenticate',
      ),
    )
    const tool = (session as unknown as { mcpTools: Tool[] }).mcpTools.find(
      tool => tool.name === 'mcp__gated__authenticate',
    )!
    const toolSession = openSession()
    const { result } = await startSignIn(tool, toolSession)
    expect(result.status).toBe('auth_url')
    releaseTurn1()
    pendingTurnRelease = null
    await settlesWithin(turn1, 10_000)

    // The later turn, on the same session, in another store.
    process.env.OPENCLAUDE_CONFIG_DIR = later
    gate = turn2Released
    pendingTurnRelease = releaseTurn2
    const turn2 = (async () => {
      for await (const _ of session.sendMessage('hi')) {
      }
    })()
    await waitFor(() => turnsEntered === 2)

    // The user finishes in the browser during the later turn.
    let flowSettled = false
    void flows[0]!.then(
      () => {
        flowSettled = true
      },
      () => {
        flowSettled = true
      },
    )
    expect((await fetch(callbackFor(result.authUrl!))).status).toBe(200)
    // While the later turn is still held, the flow must NOT have finished:
    // its resume waits on the mutex the turn holds. Before the fix, the
    // live delegate lent the later turn's env and the flow finished here,
    // storing its tokens in the later store.
    await Bun.sleep(500)
    expect(flowSettled).toBe(false)
    // Release the turn, and the flow can finish in the scope it started in.
    releaseTurn2()
    pendingTurnRelease = null
    await flowEnded(0)
    await settlesWithin(turn2, 10_000)

    // The tokens landed where the flow started, not in the later turn.
    expect(storedAccessTokens(storeIn(later))).toEqual([])
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf(result)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * Cancelling the session that started a shared reconnect must not close
 * the transport while another caller is still awaiting that connect: the
 * other caller's in-flight MCP calls must keep working. The cancelled
 * attempt still rejects, once the shared connect settles.
 */
test('ABORTING A SHARED RECONNECT KEEPS THE TRANSPORT ALIVE FOR THE OTHER WAITER', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdInitialize()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  await waitFor(() => held.arrived)

  // Another caller adopts the connect this reconnect is dialling — through
  // connectToServer directly, so the waiter is attached synchronously
  // before the abort below: connectSdkMcpServers' async preamble cannot
  // be observed, and an abort before it attaches would close the
  // transport for want of a waiter.
  const adoptedPromise = realClient.connectToServer('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  caller.abort()
  // The cancelled attempt is still pending: the held initialize has not
  // answered, and the abort must not have closed the transport under the
  // other waiter.
  let settled = false
  void doneCaught.then(() => {
    settled = true
  })
  await Bun.sleep(200)
  expect(settled).toBe(false)

  held.answer()
  const adoptedClient = (await adoptedPromise) as MCPServerConnection
  try {
    expect(adoptedClient.type).toBe('connected')
    // The adopted client is still alive: its calls work.
    if (adoptedClient.type !== 'connected') throw new Error('expected a connected client')
    const listed = await adoptedClient.client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['hello'])
    // The cancelled attempt rejects, and installed nothing.
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    expect(calls.setMcpClients).toHaveLength(1)
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
  } finally {
    if (adoptedClient.type === 'connected') await adoptedClient.cleanup()
  }
}, 30_000)

/**
 * A caller abort that lands while discovery is pending must reject
 * promptly, not wait out the request timeout or the retry backoff: the
 * attempt signal aborts the tools/list request itself. The reconnect
 * installs nothing, and releases the environment mutex it held.
 */
test('ABORTING DURING DISCOVERY REJECTS PROMPTLY INSTEAD OF WAITING OUT THE REQUEST TIMEOUT', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdToolsList()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect connected, and its discovery is stalled on tools/list.
  await waitFor(() => held.arrived)
  caller.abort()
  try {
    await expect(settlesWithin(done, 5_000)).rejects.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The surviving discovery holds the environment mutex until its
    // fetchers settle, so answer the held list before asking for it:
    // the cancelled attempt still rejects promptly, above.
    held.answer()
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
    // Only the initial connect installed; the cancelled reconnect installed
    // nothing.
    expect(calls.setMcpClients).toHaveLength(1)
    expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
      ['gated', 'needs-auth'],
    ])
    // And the cancelled reconnect's client is gone: it was never installed
    // and no other session adopted it, so its transport is released and
    // the cache no longer holds it — a later connection dials fresh
    // instead of reusing a closed client.
    const key = realClient.getServerCacheKey('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)
    expect(realClient.connectToServer.cache.get(key)).toBeUndefined()
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * Clearing the cache must not wait out a connect that is still in flight
 * when the caller is cancelled — and must not dial a fresh connection
 * just to clear an idle server. The SDK flow cannot deterministically
 * reach a pending clear (the shared connect cache and the shared sign-in
 * entry couple any two sessions' flows for one server), so this exercises
 * clearServerCache directly: one auth leaves its reconnect held on
 * initialize, and the clear is called on that pending connect.
 */
test('clearServerCache WITH AN ABORTED SIGNAL DOES NOT WAIT OUT A PENDING CONNECT', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const held = holdInitialize()

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect's connect is held on initialize: the cache holds a
  // connect that has not settled.
  await waitFor(() => held.arrived)

  // A cancelled clear rejects at once, while the connect is still held.
  const caller = new AbortController()
  caller.abort()
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  await expect(
    settlesWithin(
      realClient.clearServerCache(
        'gated',
        { type: 'http', url, scope: 'session' } as never,
        caller.signal,
      ),
      5_000,
    ),
  ).rejects.toBeInstanceOf(realAuth.AuthenticationCancelledError)
  // The held connect is untouched: it still completes when answered.
  held.answer()
  expect((await done).status).toBe('connected')
  const cached = realClient.connectToServer.cache.get(key) as Promise<MCPServerConnection> | undefined
  expect(cached).toBeDefined()
  expect((await cached!).type).toBe('connected')

  // And clearing an idle server dials nothing: with the cache empty, the
  // clear returns without connecting.
  await realClient.clearServerCache('gated', { type: 'http', url, scope: 'session' } as never)
  expect(realClient.connectToServer.cache.get(key)).toBeUndefined()

  // And a second clear, with the cache already empty, starts no
  // connection either: the cache still being empty afterwards cannot
  // detect a connection opened and closed during the call.
  const initializesBefore = initializes
  await realClient.clearServerCache('gated', { type: 'http', url, scope: 'session' } as never)
  expect(realClient.connectToServer.cache.get(key)).toBeUndefined()
  expect(initializes).toBe(initializesBefore)
}, 30_000)

/**
 * Releasing an older connection must not evict a newer generation's
 * cache entry: the old cleanup's close callback clears by key, and the
 * newer generation for that key is the entry by then.
 */
test('RELEASING AN OLDER CONNECTION KEEPS A NEWER GENERATION CACHED', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const oldClient = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(oldClient.type).toBe('connected')
  const initializesBefore = initializes
  // The entry is superseded by a newer generation: evict without
  // cleanup, then start the replacement while its initialize is held.
  realClient.connectToServer.cache.delete(key)
  const held = holdInitialize()
  const newConnect = realClient.connectToServer('gated', config)
  const newCaught = newConnect.catch(error => error)
  await waitFor(() => held.arrived)

  // The old generation's cleanup must not drop the newer's entry.
  await realClient.releaseUnownedMcpClient('gated', config, oldClient)
  await new Promise(resolve => setImmediate(resolve))
  expect(realClient.connectToServer.cache.get(key)).toBe(newConnect)
  held.answer()
  const newClient = (await settlesWithin(newConnect, 5_000)) as MCPServerConnection
  expect(newClient.type).toBe('connected')
  // The newer generation stays cached: a later connect reuses it
  // instead of dialling a third connection.
  expect(await realClient.connectToServer('gated', config)).toBe(newClient)
  expect(initializes).toBe(initializesBefore + 1)
  await settlesWithin(newCaught, 5_000).catch(() => {})
}, 30_000)

/**
 * Clearing an older connection must not evict a newer generation's
 * cache entry: the old cleanup's close callback evicts the entry, and a
 * concurrent connect for the same key stores a replacement in that gap.
 * The clear's final delete — and its fetch-cache clear — must keep a
 * different promise and its discovery caches (CodeRabbit #2493 review
 * 5956557301). The stub stands in for that interleaving: the replacement
 * is started after the real cleanup resolves, before the clear's
 * post-cleanup step runs, which is exactly the state the race leaves.
 */
test('CLEARING AN OLDER CONNECTION KEEPS A NEWER GENERATION CACHED', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const oldClient = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(oldClient.type).toBe('connected')
  if (oldClient.type !== 'connected') throw new Error('expected a connected client')
  // Populate the discovery caches before the clear: the close callback
  // clears them during cleanup, which is the legitimate path — the
  // trailing clear the identity check gates is what must not run when
  // a replacement is present, and it is skipped together with the
  // entry delete in the same check below.
  expect(
    (await realClient.fetchToolsForClient(oldClient)).map(
      tool => tool.mcpInfo?.toolName ?? tool.name,
    ),
  ).toEqual(['hello'])
  const realCleanup = oldClient.cleanup
  const held = holdInitialize()
  let replacement: Promise<MCPServerConnection> | undefined
  let newClient: MCPServerConnection | undefined
  oldClient.cleanup = async (...args: Parameters<typeof realCleanup>) => {
    await realCleanup(...args)
    // The close callback evicted the old entry; a concurrent connect
    // stores the replacement before the clear's final delete runs.
    realClient.connectToServer.cache.delete(key)
    replacement = realClient.connectToServer('gated', config)
  }
  try {
    await realClient.clearServerCache('gated', config)
    expect(replacement).toBeDefined()
    // The replacement's entry survived the clear: a later connect
    // reuses it instead of dialling a third connection.
    expect(realClient.connectToServer.cache.get(key)).toBe(replacement)
    await waitFor(() => held.arrived)
    held.answer()
    newClient = (await settlesWithin(replacement!, 5_000)) as MCPServerConnection
    expect(newClient.type).toBe('connected')
    expect(newClient).not.toBe(oldClient)
    expect(await realClient.connectToServer('gated', config)).toBe(newClient)
  } finally {
    oldClient.cleanup = realCleanup
    held.answer()
    await oldClient.cleanup().catch(() => {})
    if (newClient?.type === 'connected') await newClient.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * Reauthenticating one session must not close a transport another
 * session adopted from the shared connect: the reconnect detaches its
 * cache entry and dials fresh, while the adopter's in-flight calls
 * finish on the client it holds (Copilot #2493 review 5955514041).
 */
test('A RECONNECT DOES NOT CLOSE A TRANSPORT ANOTHER SESSION ADOPTED', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  // The first session creates the shared connect; the second joins it
  // and adopts it, so its calls ride the same transport.
  const creator = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(creator.type).toBe('connected')
  if (creator.type !== 'connected') throw new Error('expected a connected client')
  const joined = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(joined).toBe(creator)
  // Let the receipt marker run: the provisional claim consolidates
  // into the single permanent marker two ticks out.
  await waitFor(() => realClient.getMcpClientAdoptionClaimCountForTesting(creator) === 1)
  expect(realClient.isMcpClientAdopted(creator)).toBe(true)

  let fresh: MCPServerConnection | undefined
  try {
    // The first session reauthenticates: the reconnect dials fresh
    // without closing the transport the second session still uses.
    const initializesBefore = initializes
    const result = await realClient.reconnectMcpServerImpl('gated', config)
    fresh = result.client
    expect(result.client.type).toBe('connected')
    expect(result.client).not.toBe(creator)
    expect(initializes).toBe(initializesBefore + 1)
    // The cache holds the fresh client, and the adopted one still
    // answers: the other session's in-flight calls are not interrupted.
    expect(await realClient.connectToServer('gated', config)).toBe(result.client)
    expect((await creator.client.listTools()).tools.map(tool => tool.name)).toEqual(['hello'])
  } finally {
    await creator.cleanup().catch(() => {})
    if (fresh?.type === 'connected') await fresh.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * The release's cache probe, isolated: with the close callback stubbed
 * out, only the probe itself can evict the entry — and it must, when
 * the entry already settled to this client.
 */
test('RELEASING A CACHED CLIENT EVICTS ITS OWN SETTLED ENTRY', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const client = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  const realCleanup = client.cleanup
  let cleanedUp = 0
  // Stub the cleanup so no close callback runs: the entry can only go
  // away through the release's own eviction.
  client.cleanup = async () => {
    cleanedUp++
  }
  try {
    await realClient.releaseUnownedMcpClient('gated', config, client)
    expect(cleanedUp).toBe(1)
    expect(realClient.connectToServer.cache.get(key)).toBeUndefined()
  } finally {
    client.cleanup = realCleanup
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * A join that lands while the release's cache probe yields must keep the
 * client open: the join records its adoption in a `.then` queued behind
 * the probe's continuation, so a release that decides ownership from the
 * probe alone cleans up a client the joiner is about to receive. The
 * release must let that adoption land — and evict the entry before
 * cleanup starts — so the joiner keeps a live client.
 */
test('A JOIN DURING THE RELEASE PROBE KEEPS THE CLIENT OPEN', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const client = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  const realCleanup = client.cleanup
  let cleanedUp = 0
  // Count the cleanup instead of stubbing it: the transport must stay
  // live for the joiner, so a call here is the failure.
  client.cleanup = async (...args: Parameters<typeof realCleanup>) => {
    cleanedUp++
    return realCleanup(...args)
  }
  try {
    // The join is queued before the release runs: its adoption callback
    // lands behind the probe's continuation, in the microtask gap the
    // release must account for.
    let joinerClient: MCPServerConnection | undefined
    void Promise.resolve().then(async () => {
      joinerClient = (await realClient.connectToServer('gated', config)) as MCPServerConnection
    })
    await realClient.releaseUnownedMcpClient('gated', config, client)
    expect(cleanedUp).toBe(0)
    expect(joinerClient).toBe(client)
    expect(realClient.isMcpClientAdopted(client)).toBe(true)
    // The entry stays: the joiner reached it through the cache, and a
    // later connection reuses the live client instead of dialling again.
    expect(realClient.connectToServer.cache.get(key)).toBeDefined()
    // And the client is still usable: the joiner can list tools through it.
    const tools = await realClient.fetchToolsForClient(joinerClient!)
    expect(tools.map(tool => tool.mcpInfo?.toolName ?? tool.name)).toEqual(['hello'])
  } finally {
    client.cleanup = realCleanup
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * The same join, but its trigger queues behind the probe's first
 * continuation: the release has already yielded on its cache probe when
 * the join is scheduled, so the join's adoption callback would land
 * behind a second probe tick. A release that decides ownership from a
 * fixed number of ticks cleans up a client the joiner is about to
 * receive; the join must adopt synchronously instead, so the decision
 * sees it no matter which tick scheduled it.
 */
test('A JOIN QUEUED BEHIND THE RELEASE PROBE KEEPS THE CLIENT OPEN', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const client = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  const realCleanup = client.cleanup
  let cleanedUp = 0
  client.cleanup = async (...args: Parameters<typeof realCleanup>) => {
    cleanedUp++
    return realCleanup(...args)
  }
  try {
    let joinerClient: MCPServerConnection | undefined
    const release = realClient.releaseUnownedMcpClient('gated', config, client)
    // Queued after the release yielded on its probe: this trigger runs
    // behind the probe's first continuation.
    void Promise.resolve().then(async () => {
      joinerClient = (await realClient.connectToServer('gated', config)) as MCPServerConnection
    })
    await release
    expect(cleanedUp).toBe(0)
    expect(joinerClient).toBe(client)
    expect(realClient.isMcpClientAdopted(client)).toBe(true)
    expect(realClient.connectToServer.cache.get(key)).toBeDefined()
    const tools = await realClient.fetchToolsForClient(joinerClient!)
    expect(tools.map(tool => tool.mcpInfo?.toolName ?? tool.name)).toEqual(['hello'])
  } finally {
    client.cleanup = realCleanup
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * The settled mirror of the joiner that closes before its connect
 * settles: a join of an already-settled connect adopts synchronously,
 * before its await resumes. If that joiner aborts before its
 * continuation runs, it never installs the client — its claim must go,
 * or the cancelled creator's release returns early on the adoption and
 * the transport stays open and cached with no owner.
 */
test('AN ABORTED SETTLED JOIN LEAVES THE CLIENT UNOWNED FOR THE CREATOR\'S RELEASE', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const creator = new AbortController()
  const client = (await realClient.connectToServer(
    'gated',
    config,
    undefined,
    creator.signal,
  )) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  const realCleanup = client.cleanup
  let cleanedUp = 0
  client.cleanup = async (...args: Parameters<typeof realCleanup>) => {
    cleanedUp++
    return realCleanup(...args)
  }
  try {
    // The joiner joins the settled connect and aborts before its
    // continuation runs — in the same synchronous block, so the
    // adoption's receipt marker has not run yet.
    const joiner = new AbortController()
    const joinerConnect = realClient.connectToServer(
      'gated',
      config,
      undefined,
      joiner.signal,
    )
    const joinerCaught = joinerConnect.catch(error => error)
    joiner.abort()
    expect(realClient.isMcpClientAdopted(client)).toBe(false)
    // The creator cancels: the release must now close the transport and
    // evict the cache entry, instead of returning early on the stale claim.
    creator.abort()
    await realClient.releaseUnownedMcpClient('gated', config, client)
    expect(cleanedUp).toBe(1)
    await waitFor(() => realClient.connectToServer.cache.get(key) === undefined)
    // The cancelled joiner still receives the shared client object — the
    // abort withdraws its adoption claim, it does not reject the shared
    // connect — so assert the settled value directly instead of
    // swallowing any outcome (CodeRabbit #2493 review 5955577457).
    await expect(settlesWithin(joinerCaught, 5_000)).resolves.toBe(client)
  } finally {
    client.cleanup = realCleanup
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * Each join of a settled connect claims the client — one join per tool
 * call through ensureConnectedClient — so the claims must consolidate
 * once the caller holds the client: repeated joins keep the single
 * permanent marker instead of retaining one claim object each for the
 * client's lifetime, and the client stays adopted (CodeRabbit #2493
 * review 5955577457).
 */
test('REPEATED JOINS OF ONE CLIENT KEEP A SINGLE ADOPTION CLAIM', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const client = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  try {
    expect(realClient.getMcpClientAdoptionClaimCountForTesting(client)).toBe(0)
    for (let join = 0; join < 5; join++) {
      const joined = await realClient.connectToServer('gated', config)
      expect(joined).toBe(client)
      // Let the receipt marker run: it is two ticks out, after the
      // caller's continuation.
      await Promise.resolve()
      await Promise.resolve()
    }
    // The last join's receipt marker runs after the caller's
    // continuation; wait for every provisional claim to consolidate
    // instead of assuming a fixed tick count.
    await waitFor(
      () => realClient.getMcpClientAdoptionClaimCountForTesting(client) === 1,
    )
    expect(realClient.getMcpClientAdoptionClaimCountForTesting(client)).toBe(1)
    // The client stays adopted: a release is still declined.
    expect(realClient.isMcpClientAdopted(client)).toBe(true)
  } finally {
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * The other order: the creator's release runs first, while the settled
 * joiner's claim still stands, and is declined — then the joiner aborts.
 * Withdrawing the claim alone re-runs nothing, so the withdrawal must
 * re-run the blocked release itself, or the transport still stays open
 * and cached with no owner.
 */
test('A BLOCKED RELEASE RE-RUNS WHEN THE LAST SETTLED-JOIN CLAIM IS WITHDRAWN', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  const client = (await realClient.connectToServer('gated', config)) as MCPServerConnection
  expect(client.type).toBe('connected')
  if (client.type !== 'connected') throw new Error('expected a connected client')
  const realCleanup = client.cleanup
  let cleanedUp = 0
  client.cleanup = async (...args: Parameters<typeof realCleanup>) => {
    cleanedUp++
    return realCleanup(...args)
  }
  try {
    const joiner = new AbortController()
    const joinerConnect = realClient.connectToServer(
      'gated',
      config,
      undefined,
      joiner.signal,
    )
    const joinerCaught = joinerConnect.catch(error => error)
    // The joiner holds the client: a release now is declined.
    await realClient.releaseUnownedMcpClient('gated', config, client)
    expect(cleanedUp).toBe(0)
    expect(realClient.connectToServer.cache.get(key)).toBeDefined()
    // The joiner aborts before its continuation runs: the withdrawal
    // re-runs the blocked release, closing the transport and evicting
    // the cache entry without another release call.
    joiner.abort()
    await waitFor(() => cleanedUp === 1)
    await waitFor(() => realClient.connectToServer.cache.get(key) === undefined)
    // The cancelled joiner still receives the shared client object — the
    // abort withdraws its adoption claim, it does not reject the shared
    // connect — so assert the settled value directly instead of
    // swallowing any outcome (CodeRabbit #2493 review 5955577457).
    await expect(settlesWithin(joinerCaught, 5_000)).resolves.toBe(client)
  } finally {
    client.cleanup = realCleanup
    await client.cleanup().catch(() => {})
  }
}, 30_000)

/**
 * A failed tool swap must not close a client another caller adopted,
 * even when the cache entry has since been replaced by a pending
 * connect: the adoption evidence is on the client, not in the entry —
 * and a pending replacement must not make the rejection wait it out.
 */
test('A FAILED SWAP KEEPS AN ADOPTED CLIENT ITS CACHE ENTRY REPLACED', async () => {
  const url = serveNeedingAuth()
  const config = { type: 'http', url, scope: 'session' } as never
  const key = realClient.getServerCacheKey('gated', config)
  let failSwap = false
  const session = openGatedSession(url)
  recordEngine(session, () => {
    if (failSwap) throw new Error('swap failed for the test')
  })
  const heldTools = holdToolsList()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect's discovery is stalled on tools/list.
  await waitFor(() => heldTools.arrived)
  // Another caller joins the settled shared connect: it adopts the
  // client the reconnect resolves to.
  const joinerConnect = realClient.connectToServer('gated', config)
  const joinerCaught = joinerConnect.catch(error => error)
  // The cache entry is replaced by a newer generation, whose initialize
  // stays held while the swap runs.
  realClient.connectToServer.cache.delete(key)
  const heldInit = holdInitialize()
  const newConnect = realClient.connectToServer('gated', config)
  const newCaught = newConnect.catch(error => error)
  failSwap = true
  heldTools.answer()

  // The swap fails, and the rejection arrives promptly — it does not
  // wait out the newer pending connect.
  const error = await settlesWithin(doneCaught, 5_000)
  expect(error).toBeInstanceOf(Error)
  expect((error as Error).message).toBe('swap failed for the test')
  // The newer generation is untouched in the cache while its initialize
  // is still held.
  expect(realClient.connectToServer.cache.get(key)).toBe(newConnect)
  heldInit.answer()
  // The adopted client was never cleaned up: it still lists tools.
  const adopted = (await joinerConnect) as MCPServerConnection
  expect(adopted.type).toBe('connected')
  const tools = await realClient.fetchToolsForClient(adopted)
  expect(tools.map(tool => tool.mcpInfo?.toolName ?? tool.name)).toEqual(['hello'])
  const newer = (await settlesWithin(newConnect, 5_000)) as MCPServerConnection
  expect(newer.type).toBe('connected')
  await settlesWithin(joinerCaught, 5_000).catch(() => {})
  await settlesWithin(newCaught, 5_000).catch(() => {})
}, 30_000)

// Skill discovery is behind the MCP_SKILLS build flag, off by default
// under bun test: without it the stand-in never advertises resources and
// the read never runs, so the test is skipped rather than vacuous.
const skillReadTest = feature('MCP_SKILLS') ? test : test.skip

/**
 * A caller abort that lands while skill discovery is pending must reject
 * promptly, not wait out the request timeout: the attempt signal aborts
 * the resources/read request itself. The reconnect installs nothing, and
 * releases the environment mutex it held.
 */
skillReadTest('CANCELLING DURING A STALLED SKILL READ REJECTS PROMPTLY AND RELEASES THE ENVIRONMENT MUTEX', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdSkillRead()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect connected, and its discovery is stalled on the skill read.
  await waitFor(() => held.arrived)
  caller.abort()
  try {
    await expect(settlesWithin(done, 5_000)).rejects.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The surviving discovery holds the environment mutex until its
    // fetchers settle, so answer the held read before asking for it:
    // the cancelled attempt still rejects promptly, above.
    held.answer()
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
    // Only the initial connect installed; the cancelled reconnect installed
    // nothing.
    expect(calls.setMcpClients).toHaveLength(1)
    expect(calls.setMcpClients[0]!.map(client => [client.name, client.type])).toEqual([
      ['gated', 'needs-auth'],
    ])
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * A call whose signal is already aborted must not run initialization:
 * without the check, a failing init would replace the cancellation error
 * with its own, and a held init would stall a call that is already over.
 */
test('AN ALREADY-ABORTED CALL DOES NOT RUN INITIALIZATION', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const callsBefore = initCalls
  // Initialization fails: without the pre-init check, its error would
  // replace the cancellation error.
  failInit = true
  try {
    const caller = new AbortController()
    caller.abort()
    const done = session.authenticateMcpServer('gated', {
      signal: caller.signal,
    })
    await expect(settlesWithin(done, 5_000)).rejects.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // init never ran: the aborted call returns before it.
    expect(initCalls).toBe(callsBefore)
  } finally {
    failInit = false
  }
}, 30_000)

/**
 * Aborting the caller while initialization is held must reject at once,
 * before initialization is released: the later abortable MCP wait never
 * gets a chance to run, and the sign-in must not wait out init. The
 * shared initialization itself keeps waiting — only this sign-in ends.
 */
test('ABORTING THE CALLER WHILE INITIALIZATION IS HELD REJECTS AT ONCE', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const held = holdInit()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => held.arrived)
  caller.abort()
  try {
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The sign-in ended while init was still held: no URL was delivered.
    expect(seenUrls).toEqual([])
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * Closing the session while initialization is held rejects at once too,
 * with the session-closed error — not with a cancellation, and not after
 * initialization is released.
 */
test('CLOSING THE SESSION WHILE INITIALIZATION IS HELD REJECTS AT ONCE', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const held = holdInit()

  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
  })
  await waitFor(() => held.arrived)
  session.close()
  try {
    await expect(settlesWithin(done, 5_000)).rejects.toThrow('SDK session is closed')
    expect(seenUrls).toEqual([])
  } finally {
    held.answer()
  }
}, 30_000)

/**
 * The host flow must keep the credential namespace it started in even
 * when initialization waits: while init is held, another turn takes the
 * session's turn scope, and the flow must still sign in — and store its
 * tokens — in the namespace it started in, not the later turn's.
 */
test('THE HOST FLOW KEEPS THE CALL-ENTRY CREDENTIAL NAMESPACE ACROSS INITIALIZATION', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const later = join(configHome, 'later')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const session = openGatedSession(url)
    // Two credential scopes, one per namespace: the entry turn lends the
    // origin store, a later turn the later store. Only the entry scope may
    // be entered by this flow.
    const scopeFor =
      (dir: string) =>
      async <T>(work: () => Promise<T>): Promise<T> => {
        const prev = process.env.OPENCLAUDE_CONFIG_DIR
        process.env.OPENCLAUDE_CONFIG_DIR = dir
        try {
          return await work()
        } finally {
          if (prev === undefined) delete process.env.OPENCLAUDE_CONFIG_DIR
          else process.env.OPENCLAUDE_CONFIG_DIR = prev
        }
      }
    const entryScope = scopeFor(origin)
    const laterScope = scopeFor(later)
    const turnScope = session as unknown as { turnCredentialScope: unknown }
    turnScope.turnCredentialScope = entryScope

    // Hold initialization: while it waits, another turn takes the field.
    const held = holdInit()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held.arrived)
    turnScope.turnCredentialScope = laterScope
    held.answer()

    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The tokens landed where the flow started, not in the later turn's store.
    expect(storedAccessTokens(storeIn(later))).toEqual([])
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

test('THE HOST FLOW KEEPS THE CALL-ENTRY NAMESPACE ACROSS INITIALIZATION WITH NO TURN TO LEND IT', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    // Out of a turn: no delegate is lent, so only the environment
    // frozen at call entry can save the flow's namespace.
    const session = openGatedSession(url)
    expect(
      (session as unknown as { turnCredentialScope: unknown }).turnCredentialScope,
    ).toBeNull()

    const held = holdInit()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held.arrived)
    // Another turn applies its own environment while init waits.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    held.answer()

    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The tokens landed where the flow started, not in the later
    // turn's store.
    expect(storedAccessTokens(storeIn(ambient))).toEqual([])
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

test('THE HOST FLOW KEEPS THE CALL-ENTRY NAMESPACE WHEN ITS LENT TURN ENDS DURING INITIALIZATION', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    const url = serveNeedingAuth()
    const session = openGatedSession(url)
    // A turn lends its environment, then ends while init waits: the
    // delegate declines afterwards, so only the frozen environment can
    // save the flow's namespace.
    let delegateActive = true
    const scopeField = session as unknown as { turnCredentialScope: unknown }
    // An expired delegate declines by returning undefined, not a promise
    // resolving to undefined — that is how the scope falls back to its
    // frozen environment.
    scopeField.turnCredentialScope = <T>(work: () => Promise<T>): Promise<T> | undefined => {
      if (!delegateActive) return undefined
      return work()
    }

    const held = holdInit()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held.arrived)
    delegateActive = false
    // Another turn applies its own environment while init waits.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    held.answer()

    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The tokens landed where the flow started, not in the later
    // turn's store.
    expect(storedAccessTokens(storeIn(ambient))).toEqual([])
    expect(storedAccessTokens(storeIn(origin))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The fallback scopes overlay the session env only for pre-turn calls:
 * inside a turn the turn already applied its env at turn start, so a host
 * change to options.env while sign-in is pending must not replace the
 * namespace the turn wrote its registration under. The exchange reads
 * the turn's environment even when the turn ends before it runs
 * (CodeRabbit #2493 review 5956557301).
 */
test('THE HOST FLOW KEEPS THE TURN ENVIRONMENT WHEN OPTIONS.ENV CHANGES MID-SIGN-IN', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const turnHome = join(configHome, 'turn')
  const changedHome = join(configHome, 'changed')
  try {
    // The turn applied the session env at turn start: the process env
    // holds the turn home, and the turn lends its scope.
    process.env.OPENCLAUDE_CONFIG_DIR = turnHome
    const url = serveNeedingAuth()
    const options: Parameters<typeof unstable_v2_createSession>[0] = {
      cwd: process.cwd(),
      env: { OPENCLAUDE_CONFIG_DIR: turnHome },
      mcpServers: { gated: { type: 'http', url } },
    }
    const session = unstable_v2_createSession(options)
    sdkSessions.push(session)
    let delegateActive = true
    const scopeField = session as unknown as { turnCredentialScope: unknown }
    // An expired delegate declines by returning undefined, not a promise
    // resolving to undefined — that is how the scope falls back to its
    // frozen environment.
    scopeField.turnCredentialScope = <T>(work: () => Promise<T>): Promise<T> | undefined => {
      if (!delegateActive) return undefined
      return work()
    }
    // The host changes the session env while sign-in is pending: the
    // turn already applied the old value, so the exchange must still
    // read the turn's environment, not the changed one.
    options.env = { OPENCLAUDE_CONFIG_DIR: changedHome }

    const held = holdInit()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held.arrived)
    // The turn ends while init waits: the delegate declines afterwards,
    // so only the frozen environment can save the flow's namespace.
    delegateActive = false
    held.answer()

    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The token landed in the turn's namespace, not the changed one.
    expect(storedAccessTokens(storeIn(changedHome))).toEqual([])
    expect(storedAccessTokens(storeIn(turnHome))).toEqual([
      `token-for-${clientOf({ authUrl: seenUrls[0] } as McpAuthOutput)}`,
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

test('THE HOST FLOW READS XAA CREDENTIALS IN THE NAMESPACE IT STARTED IN', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_XAA'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  const savedSettings = getSessionSettingsCache()
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    process.env.CLAUDE_CODE_ENABLE_XAA = '1'
    const url = serveNeedingAuth()
    const base = new URL(url).origin
    // The IdP is the stand-in itself: its discovery, token-exchange and
    // jwt-bearer legs answer from the same server.
    setSessionSettingsCache({
      settings: { xaaIdp: { issuer: base, clientId: 'idp-client' } },
      errors: [],
    })
    // A registered client, stored tokens and a cached id_token, all in
    // the origin namespace: the initial connect is authorized, so its
    // initialize can be held while another environment is applied.
    realAuth.saveMcpClientSecret('gated', { type: 'http', url } as never, 'not-a-secret')
    seedStoredToken('gated', url, 'token-for-seeded')
    saveIdpIdTokenFromJwt(base, 'fake-id-token')
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      mcpServers: {
        gated: { type: 'http', url, oauth: { xaa: true, clientId: 'xaa-client' } },
      },
    })
    sdkSessions.push(session)
    const held = holdInitialize()
    const done = session.authenticateMcpServer('gated', {})
    await waitFor(() => held.arrived)
    // Another turn applies its own environment while setup is pending.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    held.answer()

    const status = await done
    expect(status.status).toBe('connected')
    // The exchange ran where the flow started: the new token is in the
    // origin store, and nothing landed in the later turn's store.
    expect(storedAccessTokens(storeIn(origin))).toEqual(['token-for-xaa'])
    expect(storedAccessTokens(storeIn(ambient))).toEqual([])
  } finally {
    if (savedSettings) setSessionSettingsCache(savedSettings)
    else resetSettingsCache()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * A pre-turn sign-in initializes every configured server, and a sibling
 * whose header helper reads its configured environment must see the
 * session's value — not the ambient one the process carries before any
 * turn.
 */
test('A PRE-TURN SIGN-IN INITIALIZES A SIBLING IN THE SESSION ENVIRONMENT', async () => {
  const restoreEnv = snapshotEnv(['MCP_SIBLING_PROBE', 'MCP_SIBLING_PROBE_FILE'])
  const url = serveNeedingAuth()
  process.env.MCP_SIBLING_PROBE = 'ambient-value'
  const { script, probeFile } = await probeSiblingEnv()
  process.env.MCP_SIBLING_PROBE_FILE = probeFile
  try {
    await rm(probeFile, { force: true })
    const session = openSiblingSession(url, script)
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    // The sibling's header helper ran during the pre-turn setup, in the
    // session environment — not the ambient one.
    expect(await readFile(probeFile, 'utf8')).toBe('session-value')
  } finally {
    restoreEnv()
  }
}, 30_000)

/**
 * The same setup, held on init while another turn's environment is
 * applied: the sibling must still see the environment the call began
 * in, not the one applied while it waited.
 */
test('A SIGN-IN HELD ON INIT STILL INITIALIZES ITS SIBLING IN THE ENTRY ENVIRONMENT', async () => {
  const restoreEnv = snapshotEnv(['MCP_SIBLING_PROBE', 'MCP_SIBLING_PROBE_FILE'])
  const url = serveNeedingAuth()
  process.env.MCP_SIBLING_PROBE = 'ambient-value'
  const { script, probeFile } = await probeSiblingEnv()
  process.env.MCP_SIBLING_PROBE_FILE = probeFile
  let held: ReturnType<typeof holdInit> | undefined
  try {
    await rm(probeFile, { force: true })
    const session = openSiblingSession(url, script)
    held = holdInit()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => held!.arrived)
    // Another turn applies its own environment while setup is pending.
    process.env.MCP_SIBLING_PROBE = 'turn-value'
    held.answer()
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    const status = await done
    expect(status.status).toBe('connected')
    expect(await readFile(probeFile, 'utf8')).toBe('session-value')
  } finally {
    held?.answer()
    restoreEnv()
  }
}, 30_000)

/**
 * The XAA enablement flag is read in the namespace the flow started
 * in: set at entry and deleted while the flow waits on initialize, the
 * exchange still proceeds via XAA and lands tokens in the origin store.
 */
test('THE HOST FLOW KEEPS XAA ENABLED WHEN THE FLAG IS DELETED MID-WAIT', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_XAA'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const savedSettings = getSessionSettingsCache()
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    process.env.CLAUDE_CODE_ENABLE_XAA = '1'
    const url = serveNeedingAuth()
    const base = new URL(url).origin
    setSessionSettingsCache({
      settings: { xaaIdp: { issuer: base, clientId: 'idp-client' } },
      errors: [],
    })
    realAuth.saveMcpClientSecret('gated', { type: 'http', url } as never, 'not-a-secret')
    seedStoredToken('gated', url, 'token-for-seeded')
    saveIdpIdTokenFromJwt(base, 'fake-id-token')
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      mcpServers: {
        gated: { type: 'http', url, oauth: { xaa: true, clientId: 'xaa-client' } },
      },
    })
    sdkSessions.push(session)
    const held = holdInitialize()
    const done = session.authenticateMcpServer('gated', {})
    await waitFor(() => held.arrived)
    // The flag is deleted while setup is pending.
    delete process.env.CLAUDE_CODE_ENABLE_XAA
    held.answer()

    const status = await done
    expect(status.status).toBe('connected')
    expect(storedAccessTokens(storeIn(origin))).toEqual(['token-for-xaa'])
  } finally {
    if (savedSettings) setSessionSettingsCache(savedSettings)
    else resetSettingsCache()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The other direction: the flag unset at entry and set while the flow
 * waits must not admit XAA — the flow rejects with the not-enabled
 * error instead of exchanging in the later ambient namespace.
 */
test('THE HOST FLOW REFUSES XAA WHEN THE FLAG WAS UNSET AT ENTRY', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_XAA'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const savedSettings = getSessionSettingsCache()
  let held: ReturnType<typeof holdInitialize> | undefined
  try {
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    delete process.env.CLAUDE_CODE_ENABLE_XAA
    const url = serveNeedingAuth()
    const base = new URL(url).origin
    setSessionSettingsCache({
      settings: { xaaIdp: { issuer: base, clientId: 'idp-client' } },
      errors: [],
    })
    realAuth.saveMcpClientSecret('gated', { type: 'http', url } as never, 'not-a-secret')
    seedStoredToken('gated', url, 'token-for-seeded')
    saveIdpIdTokenFromJwt(base, 'fake-id-token')
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
      mcpServers: {
        gated: { type: 'http', url, oauth: { xaa: true, clientId: 'xaa-client' } },
      },
    })
    sdkSessions.push(session)
    held = holdInitialize()
    const done = session.authenticateMcpServer('gated', {})
    const doneCaught = done.catch(error => error)
    await waitFor(() => held!.arrived)
    // The flag appears while setup is pending — too late for this call.
    process.env.CLAUDE_CODE_ENABLE_XAA = '1'
    held.answer()

    const error = await settlesWithin(doneCaught, 5_000)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('XAA is not enabled')
  } finally {
    held?.answer()
    if (savedSettings) setSessionSettingsCache(savedSettings)
    else resetSettingsCache()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * A session that joins a shared reconnect and then closes must not keep
 * that reconnect from closing when its own caller cancels: the joiner's
 * waiter leaves with it, so the abort can close the stalled transport
 * instead of holding the environment mutex until the connect times out.
 */
test('A JOINER THAT LEAVES DOES NOT KEEP A CANCELLED RECONNECT FROM CLOSING', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdInitialize()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect's connect is stalled on initialize.
  await waitFor(() => held.arrived)

  // Another session's initialization joins the same pending connect, then
  // that session closes: its waiter must leave with it, or the abort
  // below cannot close the stalled transport.
  const joiner = new AbortController()
  const joinedPromise = realClient.connectToServer(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    undefined,
    joiner.signal,
  )
  const joinedCaught = joinedPromise.catch(error => error)
  joiner.abort()
  // The joiner's waiter is gone; cancelling the attempt closes the transport.
  caller.abort()
  try {
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    const acquired = await acquireEnvMutex({ timeoutMs: 5_000 })
    expect(acquired.acquired).toBe(true)
    releaseEnvMutex()
    // Only the initial connect installed; the cancelled reconnect installed
    // nothing.
    expect(calls.setMcpClients).toHaveLength(1)
    // The joiner's connect ended with the transport: a failed client,
    // not a connection that outlived the cancel.
    expect((await joinedPromise).type).toBe('failed')
  } finally {
    held.answer()
    await settlesWithin(joinedCaught, 5_000).catch(() => {})
  }
}, 30_000)

/**
 * Cancelling one caller during discovery must not strip another caller's
 * tools: discovery is shared by client name, so the other caller's fetch
 * shares the reconnect's in-flight tools/list. The cancelled attempt
 * rejects promptly, and the adopter still gets the server's tools once
 * the list answers.
 */
test("ONE CALLER CANCELLING DISCOVERY DOES NOT STRIP ANOTHER CALLER'S TOOLS", async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const calls = recordEngine(session)
  const held = holdToolsList()

  const caller = new AbortController()
  const seenUrls: string[] = []
  const done = session.authenticateMcpServer('gated', {
    onAuthorizationUrl: seen => seenUrls.push(seen),
    signal: caller.signal,
  })
  const doneCaught = done.catch(error => error)
  await waitFor(() => seenUrls.length > 0)
  expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
  // The reconnect connected, and its discovery is stalled on tools/list.
  await waitFor(() => held.arrived)

  // Another caller adopts the in-flight discovery: it connects through
  // the shared client, then fetches the same tools/list the reconnect
  // started. Awaiting the connect lets the adoption register before the
  // abort below.
  const connectedClient = (await realClient.connectToServer('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)) as MCPServerConnection
  expect(connectedClient.type).toBe('connected')
  const adopterTools = realClient
    .fetchToolsForClient(connectedClient)
    // The names the model sees, as the status projects them.
    .then(tools => tools.map(tool => tool.mcpInfo?.toolName ?? tool.name))

  caller.abort()
  try {
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The cancelled attempt installed nothing.
    expect(calls.setMcpClients).toHaveLength(1)
  } finally {
    held.answer()
  }
  // The adopter still gets the server's tools once the list answers.
  await expect(settlesWithin(adopterTools, 5_000)).resolves.toEqual(['hello'])
}, 30_000)

/**
 * A discovery that outlives its caller keeps the namespace it began in:
 * another caller adopted the shared client, the creator cancels, and a
 * later turn applies its own environment before the next tools/list page
 * is read. The page must still carry the origin token, not the later
 * turn's — the prompt rejecting alone would not show that.
 */
test("A SURVIVING SHARED DISCOVERY KEEPS ITS ORIGINATING CREDENTIAL NAMESPACE", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  try {
    const url = serveNeedingAuth()
    // The later turn's token, in its own store: no page may carry it.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    pageToolsList()

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdToolsList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on page one.
    await waitFor(() => held.arrived)

    // Another caller adopts the in-flight discovery: it connects through
    // the shared client, then fetches the same tools/list the reconnect
    // started. Awaiting the connect lets the adoption register before the
    // abort below.
    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterTools = realClient
      .fetchToolsForClient(connectedClient)
      // The names the model sees, as the status projects them.
      .then(tools => tools.map(tool => tool.mcpInfo?.toolName ?? tool.name))

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The cancelled attempt installed nothing.
    expect(calls.setMcpClients).toHaveLength(1)

    // A later turn applies its own environment: it takes the mutex, so it
    // queues behind the surviving discovery's scope and only applies once
    // that discovery has settled.
    const laterTurnApplied = (async () => {
      const { acquired } = await acquireEnvMutex()
      expect(acquired).toBe(true)
      process.env.OPENCLAUDE_CONFIG_DIR = ambient
      releaseEnvMutex()
    })()
    // Page one answers: the second page is read while the later turn is
    // still queued, so it must carry the origin token, not the later
    // turn's.
    held.answer()
    await expect(settlesWithin(adopterTools, 5_000)).resolves.toEqual([
      'hello',
      'world',
    ])
    await laterTurnApplied
    expect(toolsListAuth).toEqual([
      'Bearer token-for-stand-in-client-2',
      'Bearer token-for-stand-in-client-2',
    ])
  } finally {
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The same surviving discovery, against a competitor that queued
 * BEFORE the cancellation: the competitor takes the mutex next and
 * holds it with its own environment applied. The surviving scope
 * queues with precedence over regular waiters, so it is picked before
 * the competitor when the caller's scope releases — a plain FIFO queue
 * would hand the mutex to the competitor first, and the next page
 * would read the competitor's credentials.
 */
test("A SURVIVING SHARED DISCOVERY KEEPS ITS NAMESPACE AGAINST A COMPETITOR QUEUED BEFORE THE CANCEL", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  try {
    const url = serveNeedingAuth()
    // The competitor's token, in its own store: no page may carry it.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    pageToolsList()

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdToolsList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on page one.
    await waitFor(() => held.arrived)

    // Another caller adopts the in-flight discovery: it connects through
    // the shared client, then fetches the same tools/list the reconnect
    // started. Awaiting the connect lets the adoption register before the
    // abort below.
    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterTools = realClient
      .fetchToolsForClient(connectedClient)
      // The names the model sees, as the status projects them.
      .then(tools => tools.map(tool => tool.mcpInfo?.toolName ?? tool.name))

    // A competing owner queues BEFORE the cancellation: it takes the
    // mutex next, applies its own environment, and holds it while the
    // next page is read.
    const competitorHeld = new Promise<void>(resolve => {
      releaseCompetitor = resolve
    })
    const competitorApplied = (async () => {
      const { acquired } = await acquireEnvMutex()
      expect(acquired).toBe(true)
      process.env.OPENCLAUDE_CONFIG_DIR = ambient
      await competitorHeld
      releaseEnvMutex()
    })()

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The cancelled attempt installed nothing.
    expect(calls.setMcpClients).toHaveLength(1)

    // Page one answers: the second page is read while the competitor
    // still holds the mutex with its own environment applied, so it
    // must carry the origin token, not the competitor's.
    held.answer()
    await expect(settlesWithin(adopterTools, 5_000)).resolves.toEqual([
      'hello',
      'world',
    ])
    expect(toolsListAuth).toEqual([
      'Bearer token-for-stand-in-client-2',
      'Bearer token-for-stand-in-client-2',
    ])
    releaseCompetitor?.()
    await competitorApplied
  } finally {
    releaseCompetitor?.()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The same surviving discovery, against a competitor that queued
 * BEFORE discovery started: it queues while the reconnect's connect is
 * held on initialize — the caller's scope holds the mutex then — so it
 * sits ahead of the surviving entry in a plain FIFO queue. The
 * surviving entry's precedence must pick it first when the caller's
 * scope releases on cancel, or the next page reads the competitor's
 * credentials.
 */
test('A SURVIVING SHARED DISCOVERY KEEPS ITS NAMESPACE AGAINST A COMPETITOR QUEUED BEFORE DISCOVERY', async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  // Real config homes, so OPENCLAUDE_CONFIG_DIR selects the store.
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  let competitorCancel: AbortController | undefined
  let competitorApplied: Promise<void> | undefined
  try {
    const url = serveNeedingAuth()
    // The competitor's token, in its own store: no page may carry it.
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    pageToolsList()

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdToolsList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    // Hold the reconnect's connect: the next initialize after this
    // point is the reconnect's, and the sign-in's scope holds the mutex
    // through it.
    const heldConnect = holdInitialize()
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect's connect is held on initialize, and its scope
    // holds the mutex: the competitor queues behind that scope — ahead
    // of the surviving entry, which is only entered at discovery start.
    await waitFor(() => heldConnect.arrived)
    // Cancellable: if an assertion below fails while discovery still
    // holds the mutex, the test's finally aborts this wait instead of
    // letting the queued competitor run after the environment is
    // restored — it would apply its own home and leave it set. A
    // competitor that already acquired restores its own environment
    // before releasing the mutex.
    competitorCancel = new AbortController()
    const competitorHeld = new Promise<void>(resolve => {
      releaseCompetitor = resolve
    })
    competitorApplied = (async () => {
      const { acquired } = await acquireEnvMutex({ signal: competitorCancel!.signal })
      if (!acquired) return
      try {
        process.env.OPENCLAUDE_CONFIG_DIR = ambient
        await competitorHeld
      } finally {
        process.env.OPENCLAUDE_CONFIG_DIR = origin
        releaseEnvMutex()
      }
    })()
    heldConnect.answer()
    // The reconnect connected, and its discovery is stalled on page one.
    await waitFor(() => held.arrived)

    // Another caller adopts the in-flight discovery: it connects through
    // the shared client, then fetches the same tools/list the reconnect
    // started. Awaiting the connect lets the adoption register before the
    // abort below.
    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterTools = realClient
      .fetchToolsForClient(connectedClient)
      // The names the model sees, as the status projects them.
      .then(tools => tools.map(tool => tool.mcpInfo?.toolName ?? tool.name))

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    // The cancelled attempt installed nothing.
    expect(calls.setMcpClients).toHaveLength(1)

    // Page one answers: the second page is read while the competitor
    // still waits for the mutex — the surviving entry took it first —
    // so it must carry the origin token, not the competitor's.
    held.answer()
    await expect(settlesWithin(adopterTools, 5_000)).resolves.toEqual([
      'hello',
      'world',
    ])
    // Both pages carry the origin flow's bearer: the stand-in client
    // the flow registered, never the competitor's seeded token.
    expect(toolsListAuth).toHaveLength(2)
    expect(toolsListAuth[0]).toContain('stand-in-client')
    expect(toolsListAuth[0]).toBe(toolsListAuth[1])
    expect(toolsListAuth[1]).not.toContain('other-session')
    releaseCompetitor?.()
    await competitorApplied
  } finally {
    // Cancel the queued competitor before restoring the environment:
    // resolving its hold alone does not cancel its mutex wait, and it
    // would apply its home after the restore. Awaiting its settlement
    // joins it either way; a competitor that already acquired restores
    // its own environment before releasing the mutex.
    competitorCancel?.abort()
    releaseCompetitor?.()
    await competitorApplied?.catch(() => {})
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The prompts branch of the same race: a later prompts/list page must
 * carry the origin token even when a competitor queued before the
 * cancel and holds the mutex with its own environment applied.
 */
test("A SURVIVING PROMPTS DISCOVERY KEEPS ITS ORIGINATING CREDENTIAL NAMESPACE", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  try {
    const url = serveNeedingAuth()
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    offerPrompts = true
    pagePromptsList()

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdPromptsList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on prompts
    // page one.
    await waitFor(() => held.arrived)

    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterCommands = realClient
      .fetchCommandsForClient(connectedClient)
      .then(commands => commands.map(command => command.name))

    const competitor = queueCompetitor(ambient)
    releaseCompetitor = competitor.release

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    expect(calls.setMcpClients).toHaveLength(1)

    held.answer()
    await expect(settlesWithin(adopterCommands, 5_000)).resolves.toEqual([
      'mcp__gated__prompt-a',
      'mcp__gated__prompt-b',
    ])
    expect(promptsListAuth).toEqual([
      'Bearer token-for-stand-in-client-2',
      'Bearer token-for-stand-in-client-2',
    ])
    releaseCompetitor?.()
    await competitor.applied
  } finally {
    releaseCompetitor?.()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The resources branch of the same race: a later resources/list page
 * must carry the origin token under a competitor queued before the
 * cancel.
 */
test("A SURVIVING RESOURCES DISCOVERY KEEPS ITS ORIGINATING CREDENTIAL NAMESPACE", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  try {
    const url = serveNeedingAuth()
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    offerResources = true
    pageResourcesList()

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdResourcesList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on resources
    // page one.
    await waitFor(() => held.arrived)

    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterResources = realClient
      .fetchResourcesForClient(connectedClient)
      .then(resources => resources.map(resource => resource.uri))

    const competitor = queueCompetitor(ambient)
    releaseCompetitor = competitor.release

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    expect(calls.setMcpClients).toHaveLength(1)

    held.answer()
    await expect(settlesWithin(adopterResources, 5_000)).resolves.toEqual([
      'skill://review',
      'file:///second',
    ])
    // Two pages per traversal; under MCP_SKILLS the skills fetch lists
    // resources too, so there are two traversals. Every request carries
    // the origin token, never the competitor's.
    expect(resourcesListAuth).toHaveLength(feature('MCP_SKILLS') ? 4 : 2)
    expect(
      resourcesListAuth.every(
        auth => auth === 'Bearer token-for-stand-in-client-2',
      ),
    ).toBe(true)
    releaseCompetitor?.()
    await competitor.applied
  } finally {
    releaseCompetitor?.()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The skills branch of the same race: the skill resources/read starts
 * only after the resources/list answers, so it is a later credential
 * operation — it must carry the origin token under a competitor queued
 * before the cancel. The list is the held branch here, not the read:
 * holding the read would only delay its answer, after its credential
 * was already read. Behind the MCP_SKILLS flag, like the other
 * skill-read test.
 */
skillReadTest("A SURVIVING SKILL READ KEEPS ITS ORIGINATING CREDENTIAL NAMESPACE", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  try {
    const url = serveNeedingAuth()
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    offerResources = true

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdResourcesList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on the
    // resources/list the skill read waits for.
    await waitFor(() => held.arrived)

    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterSkills = fetchMcpSkillsForClient(connectedClient)
      .then(commands => commands.map(command => command.name))

    const competitor = queueCompetitor(ambient)
    releaseCompetitor = competitor.release

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    expect(calls.setMcpClients).toHaveLength(1)

    // The list answers, and only then does the skill read start — its
    // credential is read while the competitor still holds the mutex
    // with its own environment applied, so it must carry the origin
    // token, not the competitor's.
    held.answer()
    await expect(settlesWithin(adopterSkills, 5_000)).resolves.toEqual([
      'mcp__gated__review',
    ])
    expect(skillReadAuth).toEqual(['Bearer token-for-stand-in-client-2'])
    releaseCompetitor?.()
    await competitor.applied
  } finally {
    releaseCompetitor?.()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The tools retry branch of the same race: a failed page-two request
 * retries after a backoff, and the retry must carry the origin token —
 * not the competitor's — under a competitor queued before the cancel.
 */
test("A SURVIVING TOOLS RETRY KEEPS ITS ORIGINATING CREDENTIAL NAMESPACE", async () => {
  const restoreEnv = snapshotEnv(['OPENCLAUDE_CONFIG_DIR'])
  setClaudeConfigHomeDirForTesting(undefined)
  const origin = join(configHome, 'origin')
  const ambient = join(configHome, 'ambient')
  let releaseCompetitor: (() => void) | undefined
  try {
    const url = serveNeedingAuth()
    process.env.OPENCLAUDE_CONFIG_DIR = ambient
    seedStoredToken('gated', url, 'token-for-other-session')
    process.env.OPENCLAUDE_CONFIG_DIR = origin
    pageToolsList()
    failToolsListPage2Once = true

    const session = openGatedSession(url)
    const calls = recordEngine(session)
    const held = holdToolsList()

    const caller = new AbortController()
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
      signal: caller.signal,
    })
    const doneCaught = done.catch(error => error)
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    // The reconnect connected, and its discovery is stalled on tools
    // page one.
    await waitFor(() => held.arrived)

    const connectedClient = (await realClient.connectToServer('gated', {
      type: 'http',
      url,
      scope: 'session',
    } as never)) as MCPServerConnection
    expect(connectedClient.type).toBe('connected')
    const adopterTools = realClient
      .fetchToolsForClient(connectedClient)
      .then(tools => tools.map(tool => tool.mcpInfo?.toolName ?? tool.name))

    const competitor = queueCompetitor(ambient)
    releaseCompetitor = competitor.release

    caller.abort()
    await expect(settlesWithin(doneCaught, 5_000)).resolves.toBeInstanceOf(
      realAuth.AuthenticationCancelledError,
    )
    expect(calls.setMcpClients).toHaveLength(1)

    held.answer()
    // Page two fails once, then retries after its backoff and succeeds.
    await expect(settlesWithin(adopterTools, 10_000)).resolves.toEqual([
      'hello',
      'world',
    ])
    expect(toolsListAuth).toEqual([
      'Bearer token-for-stand-in-client-2',
      'Bearer token-for-stand-in-client-2',
      'Bearer token-for-stand-in-client-2',
    ])
    releaseCompetitor?.()
    await competitor.applied
  } finally {
    releaseCompetitor?.()
    setClaudeConfigHomeDirForTesting(configHome)
    restoreEnv()
  }
}, 30_000)

/**
 * The SDK preamble joins a pending connect before awaiting it: a creator
 * abort while it waits must not close the transport the SDK session
 * still needs. An explicit Authorization header authorizes the connect
 * with no stored token, so the preamble's retry cannot save a failed
 * client by deleting the cache — only the waiter registration can.
 */
test('AN SDK SESSION JOINING A PENDING CONNECT SURVIVES THE CREATOR ABORTING', async () => {
  const url = serveNeedingAuth()
  const headers = { Authorization: 'Bearer token-for-seeded' }
  const config = { type: 'http', url, headers, scope: 'session' } as never
  const held = holdInitialize()

  const creator = new AbortController()
  const creatorConnect = realClient.connectToServer('gated', config, undefined, creator.signal)
  // The creator's connect is stalled on initialize.
  await waitFor(() => held.arrived)

  // The SDK session joins the pending connect: its preamble registers a
  // waiter before awaiting it.
  const sdkConnect = connectSdkMcpServers({
    gated: { type: 'http', url, headers },
  })
  // The creator aborts while the SDK session is still joining.
  creator.abort()
  held.answer()

  const { clients } = await sdkConnect
  expect(clients.map(client => client.type)).toEqual(['connected'])
  expect((await creatorConnect).type).toBe('connected')
}, 30_000)

/**
 * Waiter counts belong to their own generation: a cache clear and a fresh
 * connect for the same key must not let the older generation's creator
 * abort close a transport its joiner still needs.
 */
test('AN OLDER GENERATION KEEPS ITS TRANSPORT WHILE ITS JOINER STILL WAITS', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const held = holdInitialize()
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)

  const creator = new AbortController()
  const creatorConnect = realClient.connectToServer(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    undefined,
    creator.signal,
  )
  // A joiner on the same generation, still waiting when the creator aborts.
  const joinerConnect = realClient.connectToServer('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  await waitFor(() => held.arrived)
  // A cache clear forces the next connect to start a newer generation.
  realClient.connectToServer.cache.delete(key)
  const nextCreator = new AbortController()
  const nextConnect = realClient.connectToServer(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    undefined,
    nextCreator.signal,
  )
  // The older creator aborts: its generation's transport must stay open
  // for its joiner, even though a newer generation exists for the key.
  creator.abort()
  held.answer()

  expect((await joinerConnect).type).toBe('connected')
  expect((await creatorConnect).type).toBe('connected')
  expect((await nextConnect).type).toBe('connected')
}, 30_000)

/**
 * The creator cancelling during header setup — before any transport
 * exists — must not close the transport its live joiner still needs:
 * the wrapper drops the creator from the count first, so a count of one
 * after that is the joiner alone, not the creator alone.
 */
test('A CREATOR CANCELLING DURING HEADER SETUP KEEPS THE TRANSPORT FOR ITS JOINER', async () => {
  const restoreEnv = snapshotEnv(['MCP_HEADER_HELPER_ARRIVED', 'MCP_HEADER_HELPER_GO'])
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const held = await holdHeaders()
  process.env.MCP_HEADER_HELPER_ARRIVED = held.arrivedFile
  process.env.MCP_HEADER_HELPER_GO = held.goFile
  const config = { type: 'http', url, headersHelper: held.script, scope: 'session' } as never
  try {
    const creator = new AbortController()
    const creatorConnect = realClient.connectToServer('gated', config, undefined, creator.signal)
    // The creator is inside header setup: no transport exists yet.
    await waitFor(() => existsSync(held.arrivedFile))
    // The joiner shares the creator's pending connect.
    const joinerConnect = realClient.connectToServer('gated', config)
    const joinerCaught = joinerConnect.catch(error => error)

    creator.abort()
    // Release header setup: the transport is assigned now, with the
    // joiner still waiting on it.
    await writeFile(held.goFile, 'go')

    const joinerClient = (await settlesWithin(joinerConnect, 5_000)) as MCPServerConnection
    expect(joinerClient.type).toBe('connected')
    expect((await settlesWithin(creatorConnect, 5_000)) as MCPServerConnection).toBe(joinerClient)
    // The transport survived: the joiner can still list tools through it.
    const tools = await realClient.fetchToolsForClient(joinerClient)
    expect(tools.map(tool => tool.mcpInfo?.toolName ?? tool.name)).toEqual(['hello'])
    await settlesWithin(joinerCaught, 5_000).catch(() => {})
  } finally {
    // A failed assertion must not leave the helper blocked.
    await writeFile(held.goFile, 'go').catch(() => {})
    restoreEnv()
  }
}, 30_000)

/**
 * The same cancellation with no waiter left must still close the
 * abandoned transport once it is assigned, instead of holding the
 * caller until the connection timeout.
 */
test('A CREATOR CANCELLING DURING HEADER SETUP WITH NO WAITER CLOSES THE ABANDONED TRANSPORT', async () => {
  const restoreEnv = snapshotEnv(['MCP_HEADER_HELPER_ARRIVED', 'MCP_HEADER_HELPER_GO'])
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const held = await holdHeaders()
  process.env.MCP_HEADER_HELPER_ARRIVED = held.arrivedFile
  process.env.MCP_HEADER_HELPER_GO = held.goFile
  const config = { type: 'http', url, headersHelper: held.script, scope: 'session' } as never
  try {
    const creator = new AbortController()
    const creatorConnect = realClient.connectToServer('gated', config, undefined, creator.signal)
    await waitFor(() => existsSync(held.arrivedFile))
    creator.abort()
    await writeFile(held.goFile, 'go')
    // The abandoned transport closes once assigned, so the connect
    // settles promptly with a closed-connection error — not at the
    // connection timeout.
    const client = (await settlesWithin(creatorConnect, 5_000)) as MCPServerConnection
    expect(client.type).toBe('failed')
    if (client.type !== 'failed') throw new Error('expected a failed client')
    expect(client.error ?? '').not.toContain('timed out')
  } finally {
    await writeFile(held.goFile, 'go').catch(() => {})
    restoreEnv()
  }
}, 30_000)

/**
 * A joiner cancelled before its connect settles adopts nothing: a later
 * release must evict the cache instead of keeping a client no session
 * holds.
 */
test('A JOINER THAT CLOSES BEFORE ITS CONNECT SETTLES ADOPTS NOTHING', async () => {
  const url = serveNeedingAuth()
  seedStoredToken('gated', url, 'token-for-seeded')
  const held = holdInitialize()
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)

  const creator = new AbortController()
  const creatorConnect = realClient.connectToServer(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    undefined,
    creator.signal,
  )
  // The joiner closes while the connect is still stalled on initialize.
  const joiner = new AbortController()
  const joinerConnect = realClient.connectToServer(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    undefined,
    joiner.signal,
  )
  const joinerCaught = joinerConnect.catch(error => error)
  await waitFor(() => held.arrived)
  joiner.abort()
  held.answer()

  const client = await creatorConnect
  expect(client.type).toBe('connected')
  // The joiner adopted nothing, so the release evicts the cache.
  expect(realClient.isMcpClientAdopted(client)).toBe(false)
  await realClient.releaseUnownedMcpClient(
    'gated',
    { type: 'http', url, scope: 'session' } as never,
    client,
  )
  // The cleanup closes the transport, whose onclose evicts the cache.
  await waitFor(() => realClient.connectToServer.cache.get(key) === undefined)
  // The cancelled joiner still receives the shared client object — the
  // abort withdraws its adoption claim, it does not reject the shared
  // connect — so assert the settled value directly instead of swallowing
  // any outcome (CodeRabbit #2493 review 5955577457).
  await expect(settlesWithin(joinerCaught, 5_000)).resolves.toBe(client)
}, 30_000)

/** Whether a process with this pid is still running. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/**
 * A stalled stdio connect must close once its last waiter cancels. The
 * creator aborts while a joiner remains, so the creator preserves the
 * transport for the joiner; when the joiner then aborts, the last-waiter
 * path must find a closer and kill the subprocess instead of holding
 * both callers until the connection timeout. A plain stdio connect
 * reaches the closer registration without an await, so the wrapper has
 * not supplied the originating promise yet — the registration must be
 * deferred until it has.
 */
test('A STALLED STDIO CONNECT CLOSES ONCE ITS CREATOR AND JOINER HAVE BOTH ABORTED', async () => {
  // The fixture owns teardown from allocation on: a failure waiting for
  // the child or reading its PID must still release the subprocess, the
  // pending connects and the temp directory.
  let dir: string | undefined
  let pid: number | undefined
  const creator = new AbortController()
  const joiner = new AbortController()
  let creatorConnect: Promise<MCPServerConnection> | undefined
  let joinerConnect: Promise<MCPServerConnection> | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'openclaude-stalled-stdio-'))
    const pidFile = join(dir, 'server.pid')
    // A server that starts but never answers initialize: the connect stalls
    // until the transport closes or the connection timeout fires.
    const serverRef = {
      type: 'stdio',
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => {}, 120_000)`,
        pidFile,
      ],
      scope: 'session',
    } as never

    creatorConnect = realClient.connectToServer(
      'stalled-stdio',
      serverRef,
      undefined,
      creator.signal,
    )
    const creatorCaught = creatorConnect.catch(error => error)
    // The joiner shares the creator's pending connect.
    joinerConnect = realClient.connectToServer(
      'stalled-stdio',
      serverRef,
      undefined,
      joiner.signal,
    )
    const joinerCaught = joinerConnect.catch(error => error)

    // Wait until the subprocess has started and the connect is stalled on
    // initialize — only then is an abort a cancellation of a stalled
    // connect rather than a race with startup.
    await waitFor(() => existsSync(pidFile))
    const parsedPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10)
    expect(Number.isInteger(parsedPid)).toBe(true)
    pid = parsedPid
    expect(isProcessAlive(parsedPid)).toBe(true)

    // The creator aborts while the joiner remains: the transport is
    // preserved for the joiner, so the connect stays stalled.
    creator.abort()
    // The joiner aborts too: the last waiter cancels, so the transport
    // must close and the connect must reject — promptly, not at the
    // connection timeout.
    joiner.abort()
    // A failed connect resolves to a failed client, not a rejection — the
    // point is that it settles promptly with a closed-connection error,
    // not at the 30s connection timeout.
    const creatorClient = (await settlesWithin(
      creatorCaught,
      5_000,
    )) as MCPServerConnection
    expect(creatorClient.type).toBe('failed')
    if (creatorClient.type !== 'failed') {
      throw new Error('expected a failed client')
    }
    expect(creatorClient.error).not.toContain('timed out')
    expect(creatorClient.error).toContain('Connection closed')
    expect(await settlesWithin(joinerCaught, 5_000)).toBe(creatorClient)
    // The abandoned subprocess is gone, not left until the timeout.
    await waitFor(() => !isProcessAlive(parsedPid))
  } finally {
    // Abort both controllers so a stalled connect cannot outlive the
    // test; kill the child only once its PID was read, and remove the
    // temp directory whether setup or an assertion failed.
    creator.abort()
    joiner.abort()
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true })
    }
    if (creatorConnect) {
      await settlesWithin(creatorConnect.catch(error => error), 5_000).catch(() => {})
    }
    if (joinerConnect) {
      await settlesWithin(joinerConnect.catch(error => error), 5_000).catch(() => {})
    }
  }
}, 30_000)

/**
 * A close that lands after the reconnect succeeds but before the host
 * handles its result must report the session as closed, not fail on the
 * engine the close already cleared — and the unowned client must still
 * be released.
 */
test('A CLOSE AFTER THE RECONNECT SUCCEEDS REPORTS THE SESSION AS CLOSED', async () => {
  const url = serveNeedingAuth()
  const session = openGatedSession(url)
  const key = realClient.getServerCacheKey('gated', {
    type: 'http',
    url,
    scope: 'session',
  } as never)
  // Close the session the moment the reconnect settles: the mock's
  // continuation runs before the host's await resumes.
  onReconnectSettled = () => session.close()
  try {
    const seenUrls: string[] = []
    const done = session.authenticateMcpServer('gated', {
      onAuthorizationUrl: seen => seenUrls.push(seen),
    })
    await waitFor(() => seenUrls.length > 0)
    expect((await fetch(callbackFor(seenUrls[0]!))).status).toBe(200)
    await expect(settlesWithin(done, 5_000)).rejects.toThrow('SDK session is closed')
    // The unowned client was released: the cache no longer holds it.
    expect(realClient.connectToServer.cache.get(key)).toBeUndefined()
  } finally {
    onReconnectSettled = null
  }
}, 30_000)

