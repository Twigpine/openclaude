import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  test,
} from 'bun:test'
import { access, mkdir, mkdtemp, rm, utimes } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type {
  SecureStorage,
  SecureStorageData,
} from '../../utils/secureStorage/index.js'
import { resetSettingsCache, setSessionSettingsCache } from '../../utils/settings/settingsCache.js'
import type { McpHTTPServerConfig } from './types.js'

const realSecureStorage = await import('../../utils/secureStorage/index.js')
const realKeychainHelpers = await import(
  '../../utils/secureStorage/macOsKeychainHelpers.js'
)
const realLockfile = await import('../../utils/lockfile.js')
const realSleep = await import('../../utils/sleep.js')
const realDebug = await import('../../utils/debug.js')
const realLog = await import('../../utils/log.js')
const realBrowser = await import('../../utils/browser.js')
const realXaaIdpLogin = await import('./xaaIdpLogin.js')
const originalLock = realLockfile.lock
const originalSleep = realSleep.sleep
const originalLogForDebugging = realDebug.logForDebugging
const originalLogMCPDebug = realLog.logMCPDebug
const originalOpenBrowser = realBrowser.openBrowser

type SharedTestStorage = SecureStorage & {
  getData(): SecureStorageData
  setData(next: SecureStorageData): void
  updateCalls: number
  readCalls: number
}

let activeStorage: SharedTestStorage
let clearCacheCalls = 0
let lockAttempts: string[] = []
let debugMessages: string[] = []
let mcpDebugMessages: string[] = []
let debugShouldThrow = false
let browserOpenCalls = 0
let lockOverride: typeof originalLock | undefined
let sleepOverride: typeof originalSleep | undefined

mock.module('../../utils/secureStorage/index.js', () => ({
  ...realSecureStorage,
  getSecureStorage: () => activeStorage,
}))
mock.module('../../utils/secureStorage/macOsKeychainHelpers.js', () => ({
  ...realKeychainHelpers,
  clearKeychainCache: () => {
    clearCacheCalls++
  },
}))
mock.module('../../utils/lockfile.js', () => ({
  ...realLockfile,
  lock: (...args: Parameters<typeof originalLock>) => {
    lockAttempts.push(args[0])
    return (lockOverride ?? originalLock)(...args)
  },
}))
mock.module('../../utils/sleep.js', () => ({
  ...realSleep,
  sleep: (...args: Parameters<typeof originalSleep>) =>
    (sleepOverride ?? originalSleep)(...args),
}))
mock.module('../../utils/debug.js', () => ({
  ...realDebug,
  logForDebugging: (message: string) => {
    debugMessages.push(message)
    if (debugShouldThrow) throw new Error('simulated diagnostic failure')
  },
}))
mock.module('../../utils/log.js', () => ({
  ...realLog,
  logMCPDebug: (_serverName: string, message: string) => {
    mcpDebugMessages.push(message)
  },
}))
mock.module('../../utils/browser.js', () => ({
  ...realBrowser,
  openBrowser: async () => {
    browserOpenCalls++
    return true
  },
}))
mock.module('./xaaIdpLogin.js', () => ({
  ...realXaaIdpLogin,
  getCachedIdpIdToken: (idpIssuer: string) => {
    const issuer = idpIssuer.endsWith('/') ? idpIssuer : `${idpIssuer}/`
    const entry = activeStorage.read()?.mcpXaaIdp?.[issuer]
    if (!entry || entry.expiresAt <= Date.now() + 60_000) return undefined
    return entry.idToken
  },
  getIdpClientSecret: (idpIssuer: string) => {
    const issuer = idpIssuer.endsWith('/') ? idpIssuer : `${idpIssuer}/`
    return activeStorage.read()?.mcpXaaIdpConfig?.[issuer]?.clientSecret
  },
  getXaaIdpSettings: () => ({
    issuer: IDP_ISSUER,
    clientId: 'idp-client',
  }),
}))

const { ClaudeAuthProvider, getServerKey, wrapFetchWithStepUpDetection } =
  await import('./auth.js')
const { getMcpRefreshLockPath } = await import('./refreshLock.js')

const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag'
const IDP_ISSUER = 'https://idp.example.test'
const MCP_URL = 'https://mcp.example.test/mcp'
const AS_ISSUER = 'https://as.example.test'

let configDir: string
let originalFetch: typeof globalThis.fetch
let originalXaaFlag: string | undefined
let originalConfigDir: string | undefined

function cloneData(data: SecureStorageData | null): SecureStorageData | null {
  return data === null ? null : structuredClone(data)
}

function createSharedStorage(
  initialData: SecureStorageData,
  staleAsyncReads: Array<SecureStorageData | null>,
  options?: { updateOutcomes?: boolean[] },
): SharedTestStorage {
  let data = structuredClone(initialData)
  const queuedReads = staleAsyncReads.map(value => structuredClone(value))
  const updateOutcomes = [...(options?.updateOutcomes ?? [])]
  let observedClearCalls = clearCacheCalls
  return {
    name: 'shared-test-storage',
    updateCalls: 0,
    readCalls: 0,
    getData: () => structuredClone(data),
    setData: next => {
      data = structuredClone(next)
    },
    read() {
      this.readCalls++
      return cloneData(data)
    },
    readAsync: async () => {
      if (clearCacheCalls > observedClearCalls) {
        observedClearCalls = clearCacheCalls
        return cloneData(data)
      }
      return cloneData(queuedReads.length > 0 ? queuedReads.shift()! : data)
    },
    update(next) {
      this.updateCalls++
      const success = updateOutcomes.shift() ?? true
      if (success) data = structuredClone(next)
      return { success }
    },
    delete: () => true,
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function installSuccessfulXaaFetch(): { exchangeCalls: () => number } {
  let exchangeCalls = 0
  globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString()
    if (url === `${IDP_ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({
        issuer: IDP_ISSUER,
        authorization_endpoint: `${IDP_ISSUER}/authorize`,
        token_endpoint: `${IDP_ISSUER}/token`,
        jwks_uri: `${IDP_ISSUER}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (url.includes('/.well-known/oauth-protected-resource')) {
      const resourceUrl = new URL(url)
      return jsonResponse({
        resource: `${resourceUrl.origin}/mcp`,
        authorization_servers: [AS_ISSUER],
      })
    }
    if (url === `${AS_ISSUER}/.well-known/oauth-authorization-server`) {
      return jsonResponse({
        issuer: AS_ISSUER,
        authorization_endpoint: `${AS_ISSUER}/authorize`,
        token_endpoint: `${AS_ISSUER}/token`,
        response_types_supported: ['code'],
        grant_types_supported: [JWT_BEARER_GRANT],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      })
    }
    if (url === `${IDP_ISSUER}/token` && init?.method === 'POST') {
      exchangeCalls++
      return jsonResponse({
        access_token: 'id-jag-secret',
        issued_token_type: ID_JAG_TOKEN_TYPE,
        expires_in: 300,
      })
    }
    if (url === `${AS_ISSUER}/token` && init?.method === 'POST') {
      return jsonResponse({
        access_token: 'winner-access-secret',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'mcp:read',
      })
    }
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof globalThis.fetch
  return { exchangeCalls: () => exchangeCalls }
}

function makeXaaFixture(
  serverName = 'enterprise',
  serverUrl = MCP_URL,
): {
  config: McpHTTPServerConfig
  initialData: SecureStorageData
} {
  const config: McpHTTPServerConfig = {
    type: 'http',
    url: serverUrl,
    oauth: { xaa: true, clientId: 'as-client' },
  }
  const serverKey = getServerKey(serverName, config)
  const initialData: SecureStorageData = {
    mcpOAuth: {
      [serverKey]: {
        serverName,
        serverUrl,
        accessToken: 'stale-access-secret',
        expiresAt: Date.now() + 60_000,
      },
    },
    mcpOAuthClientConfig: {
      [serverKey]: { clientSecret: 'as-client-secret' },
    },
    mcpXaaIdp: {
      [`${IDP_ISSUER}/`]: {
        idToken: 'id-token-secret',
        expiresAt: Date.now() + 3_600_000,
      },
    },
  }
  return { config, initialData }
}

beforeEach(async () => {
  originalFetch = globalThis.fetch
  originalXaaFlag = process.env.CLAUDE_CODE_ENABLE_XAA
  originalConfigDir = process.env.OPENCLAUDE_CONFIG_DIR
  process.env.CLAUDE_CODE_ENABLE_XAA = '1'
  configDir = await mkdtemp(join(tmpdir(), 'openclaude-mcp-refresh-test-'))
  process.env.OPENCLAUDE_CONFIG_DIR = configDir
  clearCacheCalls = 0
  lockAttempts = []
  debugMessages = []
  mcpDebugMessages = []
  debugShouldThrow = false
  browserOpenCalls = 0
  lockOverride = undefined
  sleepOverride = undefined
  setSessionSettingsCache({
    settings: {
      xaaIdp: { issuer: IDP_ISSUER, clientId: 'idp-client' },
    } as never,
    errors: [],
  })
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (originalXaaFlag === undefined) {
    delete process.env.CLAUDE_CODE_ENABLE_XAA
  } else {
    process.env.CLAUDE_CODE_ENABLE_XAA = originalXaaFlag
  }
  if (originalConfigDir === undefined) {
    delete process.env.OPENCLAUDE_CONFIG_DIR
  } else {
    process.env.OPENCLAUDE_CONFIG_DIR = originalConfigDir
  }
  resetSettingsCache()
  await rm(configDir, { recursive: true, force: true })
})

afterAll(() => {
  mock.module('../../utils/secureStorage/index.js', () => realSecureStorage)
  mock.module(
    '../../utils/secureStorage/macOsKeychainHelpers.js',
    () => realKeychainHelpers,
  )
  mock.module('../../utils/lockfile.js', () => ({
    ...realLockfile,
    lock: originalLock,
  }))
  mock.module('../../utils/sleep.js', () => ({
    ...realSleep,
    sleep: originalSleep,
  }))
  mock.module('../../utils/debug.js', () => ({
    ...realDebug,
    logForDebugging: originalLogForDebugging,
  }))
  mock.module('../../utils/log.js', () => ({
    ...realLog,
    logMCPDebug: originalLogMCPDebug,
  }))
  mock.module('../../utils/browser.js', () => ({
    ...realBrowser,
    openBrowser: originalOpenBrowser,
  }))
  mock.module('./xaaIdpLogin.js', () => realXaaIdpLogin)
})

test(
  'two provider instances share one XAA exchange and reuse the persisted winner',
  async () => {
    const { config, initialData } = makeXaaFixture()
    activeStorage = createSharedStorage(initialData, [initialData, initialData])
    let cachedRead = cloneData(initialData)
    let observedClearCalls = clearCacheCalls
    activeStorage.read = function () {
      this.readCalls++
      if (clearCacheCalls > observedClearCalls) {
        observedClearCalls = clearCacheCalls
        cachedRead = cloneData(this.getData())
      }
      return cloneData(cachedRead)
    }
    const network = installSuccessfulXaaFetch()
    const firstProvider = new ClaudeAuthProvider('enterprise', config)
    const secondProvider = new ClaudeAuthProvider('enterprise', config)

    const [first, second] = await Promise.all([
      firstProvider.prepareRequest(),
      secondProvider.prepareRequest(),
    ])

    expect(network.exchangeCalls()).toBe(1)
    expect(activeStorage.updateCalls).toBe(1)
    expect(clearCacheCalls).toBeGreaterThanOrEqual(2)
    expect(first?.access_token).toBe('winner-access-secret')
    expect(second?.access_token).toBe('winner-access-secret')
  },
  10_000,
)

test('two XAA callers on one provider reuse its in-process refresh', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const network = installSuccessfulXaaFetch()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const [first, second] = await Promise.all([
    provider.prepareRequest(),
    provider.prepareRequest(),
  ])

  expect(first?.access_token).toBe('winner-access-secret')
  expect(second?.access_token).toBe('winner-access-secret')
  expect(network.exchangeCalls()).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
  expect(lockAttempts).toHaveLength(1)
})

test('aborting one XAA caller does not cancel another in-process waiter', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const network = installSuccessfulXaaFetch()
  const baseFetch = globalThis.fetch
  const exchangeStarted = deferred()
  const releaseExchange = deferred()
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (
        input.toString() === `${IDP_ISSUER}/token` &&
        init?.method === 'POST'
      ) {
        exchangeStarted.resolve()
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(init.signal?.reason)
          init.signal?.addEventListener('abort', onAbort, { once: true })
          releaseExchange.promise.then(() => {
            init.signal?.removeEventListener('abort', onAbort)
            resolve()
          })
        })
      }
      return baseFetch(input, init)
    },
  ) as unknown as typeof globalThis.fetch
  const firstController = new AbortController()
  const secondController = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const first = provider.prepareRequest(firstController.signal)
  const second = provider.prepareRequest(secondController.signal)
  const secondOutcome = second.catch(error => error as Error)
  await exchangeStarted.promise
  firstController.abort(new DOMException('first cancelled', 'AbortError'))

  await expect(first).rejects.toMatchObject({ name: 'AbortError' })
  releaseExchange.resolve()
  expect(await secondOutcome).toMatchObject({
    access_token: 'winner-access-secret',
  })
  expect(network.exchangeCalls()).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
})

test('an already-aborted late waiter does not cancel the active XAA owner', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const secondReadStarted = deferred()
  const resumeSecondRead = deferred()
  let asyncReads = 0
  activeStorage.readAsync = async () => {
    asyncReads++
    if (asyncReads === 3) {
      secondReadStarted.resolve()
      await resumeSecondRead.promise
    }
    return cloneData(initialData)
  }
  const network = installSuccessfulXaaFetch()
  const baseFetch = globalThis.fetch
  const exchangeStarted = deferred()
  const releaseExchange = deferred()
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (
        input.toString() === `${IDP_ISSUER}/token` &&
        init?.method === 'POST'
      ) {
        exchangeStarted.resolve()
        await releaseExchange.promise
      }
      return baseFetch(input, init)
    },
  ) as unknown as typeof globalThis.fetch
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const owner = provider.prepareRequest()
  await exchangeStarted.promise
  const lateWaiter = provider.prepareRequest(controller.signal)
  await secondReadStarted.promise
  controller.abort(new DOMException('late waiter cancelled', 'AbortError'))
  resumeSecondRead.resolve()

  await expect(lateWaiter).rejects.toMatchObject({ name: 'AbortError' })
  releaseExchange.resolve()
  expect((await owner)?.access_token).toBe('winner-access-secret')
  expect(network.exchangeCalls()).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
})

test(
  'normal OAuth refresh and XAA for the same server contend on one lock',
  async () => {
    const { config: xaaConfig, initialData: noRefreshData } = makeXaaFixture()
    const serverKey = getServerKey('enterprise', xaaConfig)
    const normalView = structuredClone(noRefreshData)
    normalView.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
    normalView.mcpOAuth![serverKey]!.clientId = 'normal-client'
    activeStorage = createSharedStorage(normalView, [normalView, noRefreshData])

    const xaaNetwork = installSuccessfulXaaFetch()
    const xaaFetch = globalThis.fetch
    const normalStarted = deferred()
    const releaseNormal = deferred()
    const normalTokenEndpoint = 'https://normal-as.example.test/token'
    globalThis.fetch = mock(
      async (input: string | URL, init?: RequestInit) => {
        if (
          input.toString() === normalTokenEndpoint &&
          init?.method === 'POST'
        ) {
          normalStarted.resolve()
          await releaseNormal.promise
          return jsonResponse({
            access_token: 'normal-winner-access-secret',
            refresh_token: 'normal-rotated-refresh-secret',
            token_type: 'Bearer',
            expires_in: 3600,
            scope: 'mcp:read',
          })
        }
        return xaaFetch(input, init)
      },
    ) as unknown as typeof globalThis.fetch

    const normalConfig: McpHTTPServerConfig = {
      type: 'http',
      url: MCP_URL,
      oauth: { clientId: 'normal-client' },
    }
    const normalProvider = new ClaudeAuthProvider('enterprise', normalConfig)
    normalProvider.setMetadata({
      issuer: 'https://normal-as.example.test',
      authorization_endpoint: 'https://normal-as.example.test/authorize',
      token_endpoint: normalTokenEndpoint,
      response_types_supported: ['code'],
    } as never)
    const xaaProvider = new ClaudeAuthProvider('enterprise', xaaConfig)

    const normalPromise = normalProvider.prepareRequest()
    await normalStarted.promise
    const xaaPromise = xaaProvider.prepareRequest()
    await waitFor(() => lockAttempts.length >= 2)
    expect(new Set(lockAttempts).size).toBe(1)
    releaseNormal.resolve()

    const [normalTokens, xaaTokens] = await Promise.all([
      normalPromise,
      xaaPromise,
    ])

    expect(normalTokens?.access_token).toBe('normal-winner-access-secret')
    expect(xaaTokens?.access_token).toBe('normal-winner-access-secret')
    expect(xaaNetwork.exchangeCalls()).toBe(0)
    expect(activeStorage.updateCalls).toBe(1)
  },
  10_000,
)

test('two reactive 401 refreshes share the server lock and persisted winner', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        return jsonResponse({
          access_token: 'normal-winner-access-secret',
          refresh_token: 'normal-rotated-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:read',
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const metadata = {
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never
  const firstProvider = new ClaudeAuthProvider('enterprise', normalConfig)
  const secondProvider = new ClaudeAuthProvider('enterprise', normalConfig)
  firstProvider.setMetadata(metadata)
  secondProvider.setMetadata(metadata)
  const retryAuthorizationHeaders: Array<string | null> = []
  const unauthorizedOnce = () => {
    let calls = 0
    return async (_url: string | URL, init?: RequestInit) => {
      if (calls++ === 0) return new Response(null, { status: 401 })
      const authorization = new Headers(init?.headers).get('Authorization')
      retryAuthorizationHeaders.push(authorization)
      return new Response(null, {
        status:
          authorization === 'Bearer normal-winner-access-secret' ? 200 : 401,
      })
    }
  }

  const responses = await Promise.all([
    wrapFetchWithStepUpDetection(unauthorizedOnce(), firstProvider)(MCP_URL),
    wrapFetchWithStepUpDetection(unauthorizedOnce(), secondProvider)(MCP_URL),
  ])
  const [first, second] = await Promise.all([
    firstProvider.tokens(),
    secondProvider.tokens(),
  ])

  expect(refreshCalls).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
  expect(responses.map(response => response.status)).toEqual([200, 200])
  expect(retryAuthorizationHeaders).toEqual([
    'Bearer normal-winner-access-secret',
    'Bearer normal-winner-access-secret',
  ])
  expect(first?.access_token).toBe('normal-winner-access-secret')
  expect(second?.access_token).toBe('normal-winner-access-secret')
})

test('overlapping reactive 401 handlers retain per-call force intent', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  const refreshStarted = deferred()
  const releaseRefresh = deferred()
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        refreshStarted.resolve()
        await releaseRefresh.promise
        return jsonResponse({
          access_token: 'normal-winner-access-secret',
          refresh_token: 'normal-rotated-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:read',
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  const makeResourceFetch = () => {
    let calls = 0
    return async (_url: string | URL, init?: RequestInit) => {
      if (calls++ === 0) return new Response(null, { status: 401 })
      const authorization = new Headers(init?.headers).get('Authorization')
      return new Response(null, {
        status:
          authorization === 'Bearer normal-winner-access-secret' ? 200 : 401,
      })
    }
  }

  const first = wrapFetchWithStepUpDetection(makeResourceFetch(), provider)(
    MCP_URL,
  )
  await refreshStarted.promise
  const second = wrapFetchWithStepUpDetection(makeResourceFetch(), provider)(
    MCP_URL,
  )
  releaseRefresh.resolve()
  expect((await first).status).toBe(200)
  expect((await second).status).toBe(200)
  expect(refreshCalls).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
})

test('a delayed 401 reuses a newer stored access token without refreshing', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'old-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(async () => {
    refreshCalls++
    throw new Error('A fresh stored winner must skip the token endpoint')
  }) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  let resourceCalls = 0
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async (_url, init) => {
      resourceCalls++
      if (resourceCalls === 1) {
        const winnerData = activeStorage.getData()
        winnerData.mcpOAuth![serverKey]!.accessToken =
          'external-winner-access-secret'
        winnerData.mcpOAuth![serverKey]!.refreshToken =
          'external-winner-refresh-secret'
        winnerData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
        activeStorage.setData(winnerData)
        return new Response(null, { status: 401 })
      }
      const authorization = new Headers(init?.headers).get('Authorization')
      return new Response(null, {
        status:
          authorization === 'Bearer external-winner-access-secret' ? 200 : 401,
      })
    },
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  const response = await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })

  expect(response.status).toBe(200)
  expect(resourceCalls).toBe(2)
  expect(refreshCalls).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('reactive recovery preserves explicit Authorization precedence', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.accessToken = 'stored-oauth-access-secret'
  initialData.mcpOAuth![serverKey]!.refreshToken = 'stored-oauth-refresh-secret'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData])
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  let resourceCalls = 0
  const seenAuthorization: Array<string | null> = []
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async (_url, init) => {
      resourceCalls++
      seenAuthorization.push(
        new Headers(init?.headers).get('Authorization'),
      )
      return new Response(null, { status: 401 })
    },
    provider,
    { allowUnauthorizedRefresh: false },
  )

  const response = await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer configured-access-secret' },
  })

  expect(response.status).toBe(401)
  expect(resourceCalls).toBe(1)
  expect(seenAuthorization).toEqual(['Bearer configured-access-secret'])
  expect(lockAttempts).toHaveLength(0)
})

test('request auth preserves caller-owned Bearer and Basic credentials by default', async () => {
  const seenAuthorization: Array<string | null> = []
  let prepareCalls = 0
  const provider = {
    prepareRequest: async () => {
      prepareCalls++
      return { access_token: 'provider-access-secret' }
    },
    refreshAfterUnauthorized: async () => undefined,
    markStepUpPending: () => {},
  }
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async (_url, init) => {
      seenAuthorization.push(
        new Headers(init?.headers).get('Authorization'),
      )
      return new Response(null, { status: 200 })
    },
    provider as never,
    { resourceUrl: MCP_URL },
  )

  await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer configured-access-secret' },
  })
  await wrappedFetch(`${AS_ISSUER}/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic Y2xpZW50OnNlY3JldA==' },
  })

  expect(seenAuthorization).toEqual([
    'Bearer configured-access-secret',
    'Basic Y2xpZW50OnNlY3JldA==',
  ])
  expect(prepareCalls).toBe(0)
})

test('a rejected retry preserves the original 401 and cancels the retry body', async () => {
  let retryBodyCancelled = false
  const original = new Response('original challenge', {
    status: 401,
    headers: {
      'WWW-Authenticate':
        'Bearer resource_metadata="https://mcp.example.test/oauth"',
    },
  })
  const retry = new Response(
    new ReadableStream({
      cancel: () => {
        retryBodyCancelled = true
      },
    }),
    { status: 401 },
  )
  let calls = 0
  const provider = {
    prepareRequest: async () => ({ access_token: 'rejected-access-secret' }),
    refreshAfterUnauthorized: async () => ({
      access_token: 'replacement-access-secret',
    }),
    markStepUpPending: () => {},
  }
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async () => (++calls === 1 ? original : retry),
    provider as never,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  const response = await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer rejected-access-secret' },
  })

  expect(response).toBe(original)
  expect(response.headers.get('WWW-Authenticate')).toContain(
    'resource_metadata',
  )
  expect(retryBodyCancelled).toBe(true)
  expect(calls).toBe(2)
})

test('a successful 401 retry cancels the superseded original body', async () => {
  let originalBodyCancelled = false
  const original = new Response(
    new ReadableStream({
      cancel: () => {
        originalBodyCancelled = true
      },
    }),
    { status: 401 },
  )
  const recovered = new Response(null, { status: 200 })
  let calls = 0
  const provider = {
    prepareRequest: async () => ({ access_token: 'rejected-access-secret' }),
    refreshAfterUnauthorized: async () => ({
      access_token: 'replacement-access-secret',
    }),
    markStepUpPending: () => {},
  }
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async () => (++calls === 1 ? original : recovered),
    provider as never,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  expect(
    (
      await wrappedFetch(MCP_URL, {
        headers: { Authorization: 'Bearer rejected-access-secret' },
      })
    ).status,
  ).toBe(200)
  expect(originalBodyCancelled).toBe(true)
})

test('reactive recovery bypasses a stale null cache and reuses a disk winner', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.accessToken =
    'external-winner-access-secret'
  initialData.mcpOAuth![serverKey]!.refreshToken =
    'external-winner-refresh-secret'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [null])
  const provider = new ClaudeAuthProvider('enterprise', {
    type: 'http',
    url: MCP_URL,
  })

  const tokens = await provider.refreshAfterUnauthorized(
    undefined,
    'rejected-access-secret',
  )

  expect(tokens?.access_token).toBe('external-winner-access-secret')
  expect(clearCacheCalls).toBeGreaterThanOrEqual(1)
  expect(lockAttempts).toHaveLength(0)
})

test('bearer-less reactive recovery also bypasses a stale null cache', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.accessToken =
    'external-winner-access-secret'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [null])
  const provider = new ClaudeAuthProvider('enterprise', {
    type: 'http',
    url: MCP_URL,
  })

  const tokens = await provider.refreshAfterUnauthorized(undefined, undefined)

  expect(tokens?.access_token).toBe('external-winner-access-secret')
  expect(clearCacheCalls).toBeGreaterThanOrEqual(1)
  expect(lockAttempts).toHaveLength(0)
})

test('expired or malformed no-refresh records do not suppress explicit fallback auth', async () => {
  const { config, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  delete initialData.mcpOAuth![serverKey]!.refreshToken
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() - 60_000
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const provider = new ClaudeAuthProvider('enterprise', {
    type: 'http',
    url: MCP_URL,
  })

  expect(await provider.tokens()).toBeUndefined()
  expect(await provider.prepareRequest()).toBeUndefined()

  const malformedData = structuredClone(initialData)
  malformedData.mcpOAuth![serverKey]!.expiresAt = Number.NaN
  activeStorage = createSharedStorage(malformedData, [malformedData, malformedData])
  const malformedProvider = new ClaudeAuthProvider('enterprise', {
    type: 'http',
    url: MCP_URL,
  })
  expect(await malformedProvider.tokens()).toBeUndefined()
  expect(await malformedProvider.prepareRequest()).toBeUndefined()
})

test('transport-owned provider redirect handling never opens a browser', async () => {
  activeStorage = createSharedStorage({}, [])
  const config: McpHTTPServerConfig = { type: 'http', url: MCP_URL }
  const transportProvider = new ClaudeAuthProvider('enterprise', config)

  await transportProvider.redirectToAuthorization(
    new URL(`${AS_ISSUER}/authorize?scope=mcp%3Aread`),
  )
  expect(browserOpenCalls).toBe(0)

  const interactiveProvider = new ClaudeAuthProvider(
    'enterprise',
    config,
    'http://127.0.0.1:31337/callback',
    true,
  )
  await interactiveProvider.redirectToAuthorization(
    new URL(`${AS_ISSUER}/authorize?scope=mcp%3Aread`),
  )
  expect(browserOpenCalls).toBe(1)
})

test('abort during 401 recovery cancels the abandoned original response body', async () => {
  let originalBodyCancelled = false
  const original = new Response(
    new ReadableStream({
      cancel: () => {
        originalBodyCancelled = true
      },
    }),
    { status: 401 },
  )
  const controller = new AbortController()
  const provider = {
    prepareRequest: async () => ({ access_token: 'rejected-access-secret' }),
    refreshAfterUnauthorized: async () => {
      controller.abort(new DOMException('cancelled', 'AbortError'))
      throw controller.signal.reason
    },
    markStepUpPending: () => {},
  }
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async () => original,
    provider as never,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  await expect(
    wrappedFetch(MCP_URL, {
      headers: { Authorization: 'Bearer rejected-access-secret' },
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(originalBodyCancelled).toBe(true)
})

test('a failed second reactive refresh remains a soft failure', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData])
  let acquisitionCalls = 0
  lockOverride = async (...args) => {
    acquisitionCalls++
    if (acquisitionCalls === 1) return originalLock(...args)
    throw Object.assign(new Error('held'), { code: 'ELOCKED' })
  }
  sleepOverride = async () => {}
  const tokenEndpoint = 'https://normal-as.example.test/token'
  globalThis.fetch = mock(async input => {
    if (input.toString() === tokenEndpoint) {
      return jsonResponse({
        access_token: 'stale-access-secret',
        refresh_token: 'normal-rotated-refresh-secret',
        token_type: 'Bearer',
        expires_in: 3600,
      })
    }
    throw new Error(`Unexpected fetch: ${input}`)
  }) as unknown as typeof globalThis.fetch
  const provider = new ClaudeAuthProvider('enterprise', {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  })
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)

  const tokens = await provider.refreshAfterUnauthorized(
    undefined,
    'stale-access-secret',
  )

  expect(tokens).toBeUndefined()
  expect(acquisitionCalls).toBe(6)
})

test('silent XAA refresh preserves cached protected-resource discovery state', async () => {
  const { config, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  initialData.mcpOAuth![serverKey]!.discoveryState = {
    authorizationServerUrl: 'https://old-as.example.test',
    resourceMetadataUrl:
      'https://mcp.example.test/.well-known/oauth-protected-resource',
  }
  activeStorage = createSharedStorage(initialData, [initialData])
  installSuccessfulXaaFetch()
  const provider = new ClaudeAuthProvider('enterprise', config)

  await provider.prepareRequest()

  expect(
    activeStorage.getData().mcpOAuth?.[serverKey]?.discoveryState
      ?.resourceMetadataUrl,
  ).toBe('https://mcp.example.test/.well-known/oauth-protected-resource')
})

test('a reactive waiter never retries the bearer rejected during a shared refresh', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  activeStorage = createSharedStorage(initialData, [initialData, initialData])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  const refreshStarted = deferred()
  const releaseRefresh = deferred()
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        refreshStarted.resolve()
        if (refreshCalls === 1) await releaseRefresh.promise
        return jsonResponse({
          access_token:
            refreshCalls === 1
              ? 'stale-access-secret'
              : 'second-generation-access-secret',
          refresh_token: `normal-rotated-refresh-secret-${refreshCalls}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:read',
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  let resourceCalls = 0
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async (_url, init) => {
      resourceCalls++
      if (resourceCalls === 1) return new Response(null, { status: 401 })
      const authorization = new Headers(init?.headers).get('Authorization')
      return new Response(null, {
        status:
          authorization === 'Bearer second-generation-access-secret'
            ? 200
            : 401,
      })
    },
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  const proactive = provider.prepareRequest()
  await refreshStarted.promise
  const reactive = wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })
  await waitFor(
    () =>
      (
        provider as unknown as {
          _refreshInProgress?: { waiters: number }
        }
      )._refreshInProgress?.waiters === 2,
  )
  releaseRefresh.resolve()

  expect((await proactive)?.access_token).toBe('stale-access-secret')
  expect((await reactive).status).toBe(200)
  expect(resourceCalls).toBe(2)
  expect(refreshCalls).toBe(2)
  expect(activeStorage.updateCalls).toBe(2)
})

test('concurrent failed reactive refreshes never expose refresh credentials', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData], {
    updateOutcomes: [false],
  })
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        return jsonResponse({
          access_token: 'unpersisted-access-secret',
          refresh_token: 'unpersisted-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  const unauthorized = async () => new Response(null, { status: 401 })

  const responses = await Promise.all([
    wrapFetchWithStepUpDetection(unauthorized, provider)(MCP_URL),
    wrapFetchWithStepUpDetection(unauthorized, provider)(MCP_URL),
  ])
  const sdkTokens = await Promise.all([
    provider.tokens(),
    provider.tokens(),
    provider.tokens(),
  ])

  expect(responses.map(response => response.status)).toEqual([401, 401])
  expect(refreshCalls).toBe(1)
  expect(sdkTokens.map(tokens => tokens?.access_token)).toEqual([
    'stale-access-secret',
    'stale-access-secret',
    'stale-access-secret',
  ])
  expect(sdkTokens.every(tokens => tokens?.refresh_token === undefined)).toBe(
    true,
  )
})

test('SDK-facing token reads never expose refresh credentials', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'sdk-must-not-see-secret'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData])
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)

  const tokens = await provider.tokens()

  expect(tokens?.access_token).toBe('stale-access-secret')
  expect(tokens?.refresh_token).toBeUndefined()
})

test('a failed recovery does not poison a later request using an external winner', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [initialData], {
    updateOutcomes: [false],
  })
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        return jsonResponse({
          access_token: 'unpersisted-access-secret',
          refresh_token: 'unpersisted-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  const failed = await wrapFetchWithStepUpDetection(
    async () => new Response(null, { status: 401 }),
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })
  expect(failed.status).toBe(401)

  const winnerData = activeStorage.getData()
  winnerData.mcpOAuth![serverKey]!.accessToken =
    'external-winner-access-secret'
  winnerData.mcpOAuth![serverKey]!.refreshToken =
    'external-winner-refresh-secret'
  winnerData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage.setData(winnerData)
  let resourceCalls = 0
  const recovered = await wrapFetchWithStepUpDetection(
    async (_url, init) => {
      resourceCalls++
      const authorization = new Headers(init?.headers).get('Authorization')
      return new Response(null, {
        status:
          authorization === 'Bearer external-winner-access-secret' ? 200 : 401,
      })
    },
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })

  expect(recovered.status).toBe(200)
  expect(resourceCalls).toBe(1)
  expect(refreshCalls).toBe(1)
  expect((await provider.tokens())?.access_token).toBe(
    'external-winner-access-secret',
  )
})

test('different MCP servers can run XAA exchanges concurrently', async () => {
  const firstFixture = makeXaaFixture(
    'enterprise-one',
    'https://mcp-one.example.test/mcp',
  )
  const secondFixture = makeXaaFixture(
    'enterprise-two',
    'https://mcp-two.example.test/mcp',
  )
  const sharedData: SecureStorageData = {
    mcpOAuth: {
      ...firstFixture.initialData.mcpOAuth,
      ...secondFixture.initialData.mcpOAuth,
    },
    mcpOAuthClientConfig: {
      ...firstFixture.initialData.mcpOAuthClientConfig,
      ...secondFixture.initialData.mcpOAuthClientConfig,
    },
    mcpXaaIdp: firstFixture.initialData.mcpXaaIdp,
  }
  activeStorage = createSharedStorage(sharedData, [sharedData, sharedData])
  const network = installSuccessfulXaaFetch()
  const baseFetch = globalThis.fetch
  const bothExchangesStarted = deferred()
  let activeExchanges = 0
  let maxActiveExchanges = 0
  let exchangeArrivals = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (
        input.toString() === `${IDP_ISSUER}/token` &&
        init?.method === 'POST'
      ) {
        exchangeArrivals++
        activeExchanges++
        maxActiveExchanges = Math.max(maxActiveExchanges, activeExchanges)
        if (exchangeArrivals === 2) bothExchangesStarted.resolve()
        await bothExchangesStarted.promise
        try {
          return await baseFetch(input, init)
        } finally {
          activeExchanges--
        }
      }
      return baseFetch(input, init)
    },
  ) as unknown as typeof globalThis.fetch
  const firstProvider = new ClaudeAuthProvider(
    'enterprise-one',
    firstFixture.config,
  )
  const secondProvider = new ClaudeAuthProvider(
    'enterprise-two',
    secondFixture.config,
  )

  const [first, second] = await Promise.all([
    firstProvider.prepareRequest(),
    secondProvider.prepareRequest(),
  ])

  expect(first?.access_token).toBe('winner-access-secret')
  expect(second?.access_token).toBe('winner-access-secret')
  expect(network.exchangeCalls()).toBe(2)
  expect(maxActiveExchanges).toBe(2)
  expect(new Set(lockAttempts).size).toBe(2)
  const persisted = activeStorage.getData().mcpOAuth
  expect(
    persisted?.[getServerKey('enterprise-one', firstFixture.config)]
      ?.accessToken,
  ).toBe('winner-access-secret')
  expect(
    persisted?.[getServerKey('enterprise-two', secondFixture.config)]
      ?.accessToken,
  ).toBe('winner-access-secret')
})

test('credentials and XAA prerequisites are re-checked after waiting for the lock', async () => {
  const { config, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  const releaseBlocker = await originalLock(
    getMcpRefreshLockPath(serverKey, configDir),
    { realpath: false },
  )
  const retryDelayStarted = deferred()
  const resumeRetry = deferred()
  sleepOverride = async () => {
    retryDelayStarted.resolve()
    await resumeRetry.promise
  }
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest()
  await retryDelayStarted.promise
  const removedCredentials = structuredClone(initialData)
  delete removedCredentials.mcpOAuth?.[serverKey]
  activeStorage.setData(removedCredentials)
  process.env.CLAUDE_CODE_ENABLE_XAA = '0'
  await releaseBlocker()
  resumeRetry.resolve()

  const result = await tokens
  expect(result).toBeUndefined()
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('normal OAuth does not return a credential record removed while waiting', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  activeStorage = createSharedStorage(initialData, [initialData])
  const releaseBlocker = await originalLock(
    getMcpRefreshLockPath(serverKey, configDir),
    { realpath: false },
  )
  const retryDelayStarted = deferred()
  const resumeRetry = deferred()
  sleepOverride = async () => {
    retryDelayStarted.resolve()
    await resumeRetry.promise
  }
  let networkCalls = 0
  globalThis.fetch = mock(async () => {
    networkCalls++
    throw new Error('Refresh network must not run without current credentials')
  }) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)

  const tokens = provider.prepareRequest()
  await retryDelayStarted.promise
  const removedCredentials = structuredClone(initialData)
  delete removedCredentials.mcpOAuth?.[serverKey]
  activeStorage.setData(removedCredentials)
  await releaseBlocker()
  resumeRetry.resolve()

  expect(await tokens).toBeUndefined()
  expect(networkCalls).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test(
  'a failed XAA owner releases the lock so a waiter can exchange and persist',
  async () => {
    const { config, initialData } = makeXaaFixture()
    activeStorage = createSharedStorage(initialData, [initialData, initialData])
    const successfulFetch = installSuccessfulXaaFetch()
    const baseFetch = globalThis.fetch
    let idpAttempts = 0
    const firstAttemptStarted = deferred()
    const releaseFirstAttempt = deferred()
    globalThis.fetch = mock(
      async (input: string | URL, init?: RequestInit) => {
        if (
          input.toString() === `${IDP_ISSUER}/token` &&
          init?.method === 'POST' &&
          idpAttempts++ === 0
        ) {
          firstAttemptStarted.resolve()
          await releaseFirstAttempt.promise
          return jsonResponse({ error: 'temporarily_unavailable' }, 503)
        }
        return baseFetch(input, init)
      },
    ) as unknown as typeof globalThis.fetch

    const firstProvider = new ClaudeAuthProvider('enterprise', config)
    const secondProvider = new ClaudeAuthProvider('enterprise', config)
    const firstPromise = firstProvider.prepareRequest()
    await firstAttemptStarted.promise
    const secondPromise = secondProvider.prepareRequest()
    await waitFor(() => lockAttempts.length >= 2)
    releaseFirstAttempt.resolve()
    const [first, second] = await Promise.all([
      firstPromise,
      secondPromise,
    ])

    expect(idpAttempts).toBe(2)
    expect(successfulFetch.exchangeCalls()).toBe(1)
    expect(activeStorage.updateCalls).toBe(1)
    expect(first?.access_token).toBe('stale-access-secret')
    expect(second?.access_token).toBe('winner-access-secret')
  },
  10_000,
)

test('a normal OAuth storage failure is not returned as refresh success', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.refreshToken = 'normal-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  activeStorage = createSharedStorage(initialData, [initialData, initialData], {
    updateOutcomes: [false, true],
  })
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        return jsonResponse({
          access_token: 'normal-winner-access-secret',
          refresh_token: 'normal-rotated-refresh-secret',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'mcp:read',
        })
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const metadata = {
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never
  const firstProvider = new ClaudeAuthProvider('enterprise', normalConfig)
  firstProvider.setMetadata(metadata)

  const failed = await firstProvider.prepareRequest()

  expect(failed?.access_token).toBe('stale-access-secret')
  expect(activeStorage.getData().mcpOAuth?.[serverKey]?.accessToken).toBe(
    'stale-access-secret',
  )

  const secondProvider = new ClaudeAuthProvider('enterprise', normalConfig)
  secondProvider.setMetadata(metadata)
  const succeeded = await secondProvider.prepareRequest()

  expect(succeeded?.access_token).toBe('normal-winner-access-secret')
  expect(refreshCalls).toBe(2)
  expect(activeStorage.updateCalls).toBe(2)
})

test('normal OAuth refresh does not log an echoed refresh token', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  const refreshToken = 'opaque-refresh-value-7Qm2'
  initialData.mcpOAuth![serverKey]!.refreshToken = refreshToken
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  activeStorage = createSharedStorage(initialData, [initialData])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        return jsonResponse(
          {
            error: 'invalid_grant',
            error_description: `provider echoed ${refreshToken}`,
          },
          400,
        )
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)

  await provider.prepareRequest()

  expect(mcpDebugMessages.some(message => message.includes('invalid_grant')))
    .toBe(true)
  expect(mcpDebugMessages.join('\n')).not.toContain(refreshToken)
})

test('reactive invalid_grant does not reuse the rejected access token', async () => {
  const { config: xaaConfig, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', xaaConfig)
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  initialData.mcpOAuth![serverKey]!.refreshToken = 'invalid-refresh-secret'
  initialData.mcpOAuth![serverKey]!.clientId = 'normal-client'
  activeStorage = createSharedStorage(initialData, [initialData])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        const externallyChanged = activeStorage.getData()
        externallyChanged.mcpOAuth![serverKey]!.refreshToken =
          'externally-rotated-refresh-secret'
        activeStorage.setData(externallyChanged)
        return jsonResponse({ error: 'invalid_grant' }, 400)
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const normalConfig: McpHTTPServerConfig = {
    type: 'http',
    url: MCP_URL,
    oauth: { clientId: 'normal-client' },
  }
  const provider = new ClaudeAuthProvider('enterprise', normalConfig)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  let resourceCalls = 0
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async () => {
      resourceCalls++
      return new Response(null, { status: 401 })
    },
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  const response = await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })

  expect(response.status).toBe(401)
  expect(refreshCalls).toBe(1)
  expect(resourceCalls).toBe(1)
  expect(activeStorage.getData().mcpOAuth?.[serverKey]?.accessToken).toBe('')
  expect(activeStorage.getData().mcpOAuth?.[serverKey]?.refreshToken).toBeUndefined()
})

test('reactive XAA fallback does not reuse the rejected access token', async () => {
  const { config, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  const latestData = structuredClone(initialData)
  latestData.mcpOAuth![serverKey]!.refreshToken = 'appeared-refresh-secret'
  activeStorage = createSharedStorage(latestData, [initialData])
  const tokenEndpoint = 'https://normal-as.example.test/token'
  let refreshCalls = 0
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (input.toString() === tokenEndpoint && init?.method === 'POST') {
        refreshCalls++
        return jsonResponse({ error: 'invalid_grant' }, 400)
      }
      throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${input}`)
    },
  ) as unknown as typeof globalThis.fetch
  const provider = new ClaudeAuthProvider('enterprise', config)
  provider.setMetadata({
    issuer: 'https://normal-as.example.test',
    authorization_endpoint: 'https://normal-as.example.test/authorize',
    token_endpoint: tokenEndpoint,
    response_types_supported: ['code'],
  } as never)
  let resourceCalls = 0
  const wrappedFetch = wrapFetchWithStepUpDetection(
    async () => {
      resourceCalls++
      return new Response(null, { status: 401 })
    },
    provider,
    { resourceUrl: MCP_URL, providerOwnsAuthorization: true },
  )

  const response = await wrappedFetch(MCP_URL, {
    headers: { Authorization: 'Bearer stale-access-secret' },
  })

  expect(response.status).toBe(401)
  expect(refreshCalls).toBe(1)
  expect(resourceCalls).toBe(1)
  expect(activeStorage.getData().mcpOAuth?.[serverKey]?.accessToken).toBe('')
  expect(activeStorage.getData().mcpOAuth?.[serverKey]?.refreshToken).toBeUndefined()
})

test('XAA refresh does not log an echoed identity token', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  installSuccessfulXaaFetch()
  const baseFetch = globalThis.fetch
  const identityToken = 'id-token-secret'
  globalThis.fetch = mock(
    async (input: string | URL, init?: RequestInit) => {
      if (
        input.toString() === `${IDP_ISSUER}/token` &&
        init?.method === 'POST'
      ) {
        return jsonResponse(
          {
            error: 'invalid_grant',
            error_description: `provider echoed ${identityToken}`,
          },
          400,
        )
      }
      return baseFetch(input, init)
    },
  ) as unknown as typeof globalThis.fetch
  const provider = new ClaudeAuthProvider('enterprise', config)

  await provider.prepareRequest()

  expect(mcpDebugMessages.some(message => message.includes('XAA'))).toBe(true)
  expect(mcpDebugMessages.join('\n')).not.toContain(identityToken)
})

test(
  'an XAA storage failure is not shared as success and releases the lock',
  async () => {
    const { config, initialData } = makeXaaFixture()
    activeStorage = createSharedStorage(initialData, [initialData, initialData], {
      updateOutcomes: [false, true],
    })
    const network = installSuccessfulXaaFetch()
    const baseFetch = globalThis.fetch
    const firstGrantStarted = deferred()
    const releaseFirstGrant = deferred()
    let grantCalls = 0
    globalThis.fetch = mock(
      async (input: string | URL, init?: RequestInit) => {
        if (
          input.toString() === `${AS_ISSUER}/token` &&
          init?.method === 'POST' &&
          grantCalls++ === 0
        ) {
          firstGrantStarted.resolve()
          await releaseFirstGrant.promise
        }
        return baseFetch(input, init)
      },
    ) as unknown as typeof globalThis.fetch
    const firstProvider = new ClaudeAuthProvider('enterprise', config)
    const secondProvider = new ClaudeAuthProvider('enterprise', config)

    const firstPromise = firstProvider.prepareRequest()
    await firstGrantStarted.promise
    const secondPromise = secondProvider.prepareRequest()
    await waitFor(() => lockAttempts.length >= 2)
    releaseFirstGrant.resolve()
    const [first, second] = await Promise.all([
      firstPromise,
      secondPromise,
    ])

    expect(network.exchangeCalls()).toBe(2)
    expect(activeStorage.updateCalls).toBe(2)
    expect(first?.access_token).toBe('stale-access-secret')
    expect(second?.access_token).toBe('winner-access-secret')
    expect(activeStorage.getData().mcpOAuth?.[getServerKey('enterprise', config)])
      .toMatchObject({ accessToken: 'winner-access-secret' })
  },
  10_000,
)

test('abort while waiting for a lock stops retries and does not exchange', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  lockOverride = async () => {
    throw Object.assign(new Error('held'), { code: 'ELOCKED' })
  }
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest(controller.signal)
  await waitFor(() => lockAttempts.length === 1)
  controller.abort(new DOMException('cancelled', 'AbortError'))

  await expect(tokens).rejects.toMatchObject({ name: 'AbortError' })
  expect(lockAttempts).toHaveLength(1)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('abort before joining the in-process refresh stops the exchange', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const readStarted = deferred()
  const resumeRead = deferred()
  activeStorage.readAsync = async () => {
    readStarted.resolve()
    await resumeRead.promise
    return cloneData(initialData)
  }
  const network = installSuccessfulXaaFetch()
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest(controller.signal)
  await readStarted.promise
  controller.abort(new DOMException('cancelled', 'AbortError'))
  resumeRead.resolve()

  await expect(tokens).rejects.toMatchObject({ name: 'AbortError' })
  expect(lockAttempts).toHaveLength(0)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('abort during a fresh storage read prevents returning credentials', async () => {
  const { config, initialData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  initialData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(initialData, [])
  const readStarted = deferred()
  const resumeRead = deferred()
  activeStorage.readAsync = async () => {
    readStarted.resolve()
    await resumeRead.promise
    return cloneData(initialData)
  }
  const network = installSuccessfulXaaFetch()
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest(controller.signal, undefined, true)
  await readStarted.promise
  controller.abort(new DOMException('cancelled', 'AbortError'))
  resumeRead.resolve()

  await expect(tokens).rejects.toMatchObject({ name: 'AbortError' })
  expect(lockAttempts).toHaveLength(0)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('abort stops a pending lock acquisition and releases a late lock', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  let resolveLock!: (release: () => Promise<void>) => void
  let releaseCalls = 0
  lockOverride = () =>
    new Promise(resolve => {
      resolveLock = resolve
    })
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest(controller.signal)
  await waitFor(() => lockAttempts.length === 1)
  controller.abort(new DOMException('cancelled', 'AbortError'))
  const promptOutcome = await Promise.race([
    tokens.then(
      () => 'resolved',
      error => (error as Error).name,
    ),
    new Promise<string>(resolve => setTimeout(() => resolve('timed-out'), 100)),
  ])

  expect(promptOutcome).toBe('AbortError')
  resolveLock(async () => {
    releaseCalls++
  })
  await waitFor(() => releaseCalls === 1)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test('release remains serialized after persistence even when the caller aborts', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  const releaseStarted = deferred()
  const finishRelease = deferred()
  lockOverride = async () => async () => {
    releaseStarted.resolve()
    await finishRelease.promise
  }
  const controller = new AbortController()
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest(controller.signal)
  await releaseStarted.promise
  controller.abort(new DOMException('cancelled', 'AbortError'))
  const outcome = await Promise.race([
    tokens.then(result => result?.access_token ?? 'no-token'),
    new Promise<string>(resolve => setTimeout(() => resolve('timed-out'), 100)),
  ])

  expect(outcome).toBe('timed-out')
  expect(network.exchangeCalls()).toBe(1)
  expect(activeStorage.updateCalls).toBe(1)
  finishRelease.resolve()
  expect((await tokens)?.access_token).toBe('winner-access-secret')
})

test(
  'abort during the XAA network chain releases the lock without persisting',
  async () => {
    const { config, initialData } = makeXaaFixture()
    activeStorage = createSharedStorage(initialData, [initialData, initialData])
    installSuccessfulXaaFetch()
    const baseFetch = globalThis.fetch
    const exchangeStarted = deferred()
    globalThis.fetch = mock(
      async (input: string | URL, init?: RequestInit) => {
        if (
          input.toString() === `${IDP_ISSUER}/token` &&
          init?.method === 'POST'
        ) {
          exchangeStarted.resolve()
          return new Promise<Response>((_resolve, reject) => {
            const signal = init.signal
            if (signal?.aborted) {
              reject(signal.reason)
              return
            }
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          })
        }
        return baseFetch(input, init)
      },
    ) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    const provider = new ClaudeAuthProvider('enterprise', config)

    const tokens = provider.prepareRequest(controller.signal)
    await exchangeStarted.promise
    controller.abort(new DOMException('cancelled', 'AbortError'))

    await expect(tokens).rejects.toMatchObject({ name: 'AbortError' })
    expect(activeStorage.updateCalls).toBe(0)

    const network = installSuccessfulXaaFetch()
    const retryProvider = new ClaudeAuthProvider('enterprise', config)
    const retry = await retryProvider.prepareRequest()
    expect(retry?.access_token).toBe('winner-access-secret')
    expect(network.exchangeCalls()).toBe(1)
    expect(activeStorage.updateCalls).toBe(1)
  },
  10_000,
)

test('bounded contention fails closed after one final read with a redacted warning', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  lockOverride = async () => {
    throw Object.assign(new Error('held'), { code: 'ELOCKED' })
  }
  let sleepCalls = 0
  sleepOverride = async () => {
    sleepCalls++
  }
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = await provider.prepareRequest()

  expect(tokens).toBeUndefined()
  expect(lockAttempts).toHaveLength(5)
  expect(sleepCalls).toBe(4)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
  expect(debugMessages.some(message => message.includes('refresh blocked'))).toBe(
    true,
  )
  const diagnosticSurface = `${lockAttempts.join('\n')}\n${debugMessages.join('\n')}`
  expect(lockAttempts.join('\n')).not.toContain('enterprise')
  expect(lockAttempts.join('\n')).not.toContain('mcp.example.test')
  for (const secret of [
    'stale-access-secret',
    'id-token-secret',
    'id-jag-secret',
    'as-client-secret',
    'winner-access-secret',
    'Authorization',
  ]) {
    expect(diagnosticSurface).not.toContain(secret)
  }
})

test('contention exhaustion performs a final fresh storage read', async () => {
  const { config, initialData: staleData } = makeXaaFixture()
  const serverKey = getServerKey('enterprise', config)
  const freshData = structuredClone(staleData)
  freshData.mcpOAuth![serverKey]!.accessToken = 'external-winner-secret'
  freshData.mcpOAuth![serverKey]!.expiresAt = Date.now() + 3_600_000
  activeStorage = createSharedStorage(freshData, [staleData])
  const network = installSuccessfulXaaFetch()
  lockOverride = async () => {
    throw Object.assign(new Error('held'), { code: 'ELOCKED' })
  }
  sleepOverride = async () => {}
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = await provider.prepareRequest()

  expect(tokens?.access_token).toBe('external-winner-secret')
  expect(lockAttempts).toHaveLength(5)
  expect(clearCacheCalls).toBeGreaterThanOrEqual(1)
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
})

test(
  'the established stale-lock policy recovers and removes the lock',
  async () => {
    const { config, initialData } = makeXaaFixture()
    const serverKey = getServerKey('enterprise', config)
    activeStorage = createSharedStorage(initialData, [initialData])
    const network = installSuccessfulXaaFetch()
    const staleLockDirectory = `${getMcpRefreshLockPath(serverKey, configDir)}.lock`
    await mkdir(staleLockDirectory)
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(staleLockDirectory, staleTime, staleTime)
    const provider = new ClaudeAuthProvider('enterprise', config)

    const tokens = await provider.prepareRequest()

    expect(tokens?.access_token).toBe('winner-access-secret')
    expect(network.exchangeCalls()).toBe(1)
    await expect(access(staleLockDirectory)).rejects.toBeDefined()
  },
  10_000,
)

test('a compromised lock aborts the operation with a controlled diagnostic', async () => {
  const { config, initialData } = makeXaaFixture()
  activeStorage = createSharedStorage(initialData, [initialData])
  const network = installSuccessfulXaaFetch()
  lockOverride = async (_path, options) => {
    options?.onCompromised?.(new Error('simulated compromise'))
    return async () => {}
  }
  debugShouldThrow = true
  const provider = new ClaudeAuthProvider('enterprise', config)

  const tokens = provider.prepareRequest()

  await expect(tokens).rejects.toMatchObject({ name: 'AbortError' })
  expect(network.exchangeCalls()).toBe(0)
  expect(activeStorage.updateCalls).toBe(0)
  expect(debugMessages.some(message => message.includes('compromised'))).toBe(
    true,
  )
})

test('fresh-token threshold skips just above five minutes and refreshes below it', async () => {
  const originalDateNow = Date.now
  const frozenNow = originalDateNow()
  Date.now = () => frozenNow
  try {
    const { config, initialData } = makeXaaFixture()
    const serverKey = getServerKey('enterprise', config)
    const aboveThreshold = structuredClone(initialData)
    aboveThreshold.mcpOAuth![serverKey]!.expiresAt = frozenNow + 301_000
    activeStorage = createSharedStorage(aboveThreshold, [aboveThreshold])
    const network = installSuccessfulXaaFetch()
    const freshProvider = new ClaudeAuthProvider('enterprise', config)

    const fresh = await freshProvider.prepareRequest()

    expect(fresh?.access_token).toBe('stale-access-secret')
    expect(network.exchangeCalls()).toBe(0)
    expect(lockAttempts).toHaveLength(0)

    const belowThreshold = structuredClone(initialData)
    belowThreshold.mcpOAuth![serverKey]!.expiresAt = frozenNow + 299_000
    activeStorage = createSharedStorage(belowThreshold, [belowThreshold])
    const staleProvider = new ClaudeAuthProvider('enterprise', config)

    const refreshed = await staleProvider.prepareRequest()

    expect(refreshed?.access_token).toBe('winner-access-secret')
    expect(network.exchangeCalls()).toBe(1)
    expect(lockAttempts).toHaveLength(1)
  } finally {
    Date.now = originalDateNow
  }
})
