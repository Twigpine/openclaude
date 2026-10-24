// @aws-sdk/credential-provider-node and @smithy/node-http-handler are imported
// dynamically in getAWSClientProxyConfig() to defer ~929KB of AWS SDK.
// undici is lazy-required inside getProxyAgent/configureGlobalAgents to defer
// ~1.5MB when no HTTPS_PROXY/mTLS env vars are set (the common case).
import axios, { type AxiosInstance } from 'axios'
import type { LookupOptions } from 'dns'
import type { Agent } from 'http'
import { HttpsProxyAgent, type HttpsProxyAgentOptions } from 'https-proxy-agent'
import memoize from 'lodash-es/memoize.js'
import type { ConnectionOptions } from 'tls'
import type * as undici from 'undici'
import { getCACertificates } from './caCerts.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import {
  getMTLSAgent,
  getMTLSConfig,
  getTLSFetchOptions,
  type TLSConfig,
} from './mtls.js'
import { importOptionalRuntimeModule } from './optionalRuntimeModule.js'

// Environment settings captured by cached TLS/proxy agents. Check NO_PROXY
// separately via getNoProxy() so shadowed bypass values do not rebuild agents.
export const AGENT_CONFIG_ENV_VARS: ReadonlySet<string> = new Set([
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
])

// Disable fetch keep-alive after a stale-pool ECONNRESET so retries open a
// fresh TCP connection instead of reusing the dead pooled socket. Sticky for
// the process lifetime — once the pool is known-bad, don't trust it again.
// Works under Bun (native fetch respects keepalive:false for pooling).
// Under Node/undici, keepalive is a no-op for pooling, but undici
// naturally evicts dead sockets from the pool on ECONNRESET.
let keepAliveDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_KEEPALIVE)

export function disableKeepAlive(): void {
  keepAliveDisabled = true
}

export function _resetKeepAliveForTesting(): void {
  keepAliveDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_KEEPALIVE)
}

/**
 * Convert dns.LookupOptions.family to a numeric address family value
 * Handles: 0 | 4 | 6 | 'IPv4' | 'IPv6' | undefined
 */
export function getAddressFamily(options: LookupOptions): 0 | 4 | 6 {
  switch (options.family) {
    case 0:
    case 4:
    case 6:
      return options.family
    case 'IPv6':
      return 6
    case 'IPv4':
    case undefined:
      return 4
    default:
      throw new Error(`Unsupported address family: ${options.family}`)
  }
}

type EnvLike = Record<string, string | undefined>

/**
 * Get the active proxy URL if one is configured
 * Prefers lowercase variants over uppercase (https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY)
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
}

/**
 * Get the NO_PROXY environment variable value
 * Prefers lowercase over uppercase (no_proxy > NO_PROXY)
 * @param env Environment variables to check (defaults to process.env for production use)
 */
export function getNoProxy(env: EnvLike = process.env): string | undefined {
  return env.no_proxy ?? env.NO_PROXY
}

/**
 * Check if a URL should bypass the proxy based on NO_PROXY environment variable
 * Supports:
 * - Exact hostname matches (e.g., "localhost")
 * - Bare domain matches, covering the domain and its subdomains
 *   (e.g., "example.com" matches "example.com" and "api.example.com")
 * - Domain suffix matches with leading dot (e.g., ".example.com")
 * - Wildcard "*" to bypass all
 * - Port-specific matches (e.g., "example.com:8080")
 * - IP addresses (e.g., "127.0.0.1")
 * @param urlString URL to check
 * @param noProxy NO_PROXY value (defaults to getNoProxy() for production use)
 */
export function shouldBypassProxy(
  urlString: string,
  noProxy: string | undefined = getNoProxy(),
): boolean {
  if (!noProxy) return false

  // Handle wildcard
  if (noProxy === '*') return true

  try {
    const url = new URL(urlString)
    const hostname = url.hostname.toLowerCase()
    const port = url.port || (
      url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80'
    )

    // Split by comma or space and trim each entry
    const noProxyList = noProxy.split(/[,\s]+/).filter(Boolean)

    return noProxyList.some(rawPattern => {
      let pattern = rawPattern.toLowerCase().trim()

      // Port-qualified entry (e.g. `example.com:8080`). Split the port off and
      // require it to match FIRST, then fall through to the same host predicate
      // below — undici parses the port separately (`/^(.+):(\d+)$/`) and applies
      // the exact-or-subdomain host check once the port matches, so a bare
      // `hostWithPort === pattern` string compare would miss `api.example.com:8080`.
      const portMatch = pattern.match(/^(.+):(\d+)$/)
      if (portMatch) {
        if (portMatch[2] !== port) {
          return false
        }
        pattern = portMatch[1]!
      }

      // Normalize a leading `*.` wildcard to the leading-dot suffix form.
      // undici strips `*.` when parsing NO_PROXY, and upstream proxy lists use
      // that form for hosts such as `*.githubusercontent.com`; without this,
      // those entries bypass on the undici/fetch path but not here.
      if (pattern.startsWith('*.')) {
        pattern = pattern.slice(1) // `*.example.com` -> `.example.com`
      }

      // Leading-dot suffix (e.g. `.example.com`): match the apex and any
      // subdomain, but NOT `notexample.com`.
      if (pattern.startsWith('.')) {
        return hostname === pattern.slice(1) || hostname.endsWith(pattern)
      }

      // Bare domain / exact host / IP: match the host exactly OR any subdomain
      // of it. This mirrors the undici EnvHttpProxyAgent path this module also
      // drives via getProxyAgent (which bypasses subdomains for a bare NO_PROXY
      // entry), and the curl/Go/deno NO_PROXY convention. Without the subdomain
      // arm, `NO_PROXY=example.com` bypasses `api.example.com` on the
      // fetch/undici path but routes it THROUGH the proxy on the axios/WebSocket
      // path — the same env var, two decisions. `notexample.com` still does not
      // match (the leading `.` is required); IP-address patterns never gain a
      // spurious subdomain match.
      return hostname === pattern || hostname.endsWith(`.${pattern}`)
    })
  } catch {
    // If URL parsing fails, don't bypass proxy
    return false
  }
}

/**
 * Keep target TLS defaults separate from the proxy connection options.
 * HttpsProxyAgent's constructor options configure only the socket to the proxy;
 * the target TLS upgrade takes its options from connect().
 */
class TargetTLSHttpsProxyAgent extends HttpsProxyAgent<string> {
  private readonly targetTLSOptions: Pick<
    ConnectionOptions,
    'ca' | 'cert' | 'key' | 'passphrase'
  >

  constructor(
    proxyUrl: string,
    options: HttpsProxyAgentOptions<string> & ConnectionOptions,
  ) {
    super(proxyUrl, options)
    const { ca, cert, key, passphrase } = options
    this.targetTLSOptions = { ca, cert, key, passphrase }
  }

  override connect(...[req, opts]: Parameters<HttpsProxyAgent<string>['connect']>) {
    return super.connect(req, { ...this.targetTLSOptions, ...opts })
  }
}

/**
 * Create an HttpsProxyAgent with optional mTLS configuration
 * Skips local DNS resolution to let the proxy handle it
 */
function createHttpsProxyAgent(
  proxyUrl: string,
  extra: HttpsProxyAgentOptions<string> = {},
): HttpsProxyAgent<string> {
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  const agentOptions: HttpsProxyAgentOptions<string> = {
    ...(mtlsConfig && {
      cert: mtlsConfig.cert,
      key: mtlsConfig.key,
      passphrase: mtlsConfig.passphrase,
    }),
    ...(caCerts && { ca: caCerts }),
  }

  if (isEnvTruthy(process.env.CLAUDE_CODE_PROXY_RESOLVES_HOSTS)) {
    // Skip local DNS resolution - let the proxy resolve hostnames
    // This is needed for environments where DNS is not configured locally
    // and instead handled by the proxy (as in sandboxes)
    agentOptions.lookup = (hostname, options, callback) => {
      callback(null, hostname, getAddressFamily(options))
    }
  }

  return new TargetTLSHttpsProxyAgent(proxyUrl, { ...agentOptions, ...extra })
}

/**
 * Axios instance with its own proxy agent. Same NO_PROXY/mTLS/CA
 * resolution as the global interceptor, but agent options stay
 * scoped to this instance.
 */
export function createAxiosInstance(
  extra: HttpsProxyAgentOptions<string> = {},
): AxiosInstance {
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()
  const instance = axios.create({ proxy: false })

  if (!proxyUrl) {
    if (mtlsAgent) instance.defaults.httpsAgent = mtlsAgent
    return instance
  }

  const proxyAgent = createHttpsProxyAgent(proxyUrl, extra)
  instance.interceptors.request.use(config => {
    if (config.url && shouldBypassProxy(config.url)) {
      config.httpsAgent = mtlsAgent
      config.httpAgent = mtlsAgent
    } else {
      config.httpsAgent = proxyAgent
      config.httpAgent = proxyAgent
    }
    return config
  })
  return instance
}

function getProxyAgentCacheKey(uri: string): string {
  return JSON.stringify([uri, getNoProxy()])
}

/**
 * Get or create a proxy agent cached by URI and effective NO_PROXY value.
 * Include the bypass list because wildcard normalization pins it on the agent.
 */
export const getProxyAgent = memoize((uri: string): undici.Dispatcher => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  const mtlsConfig = getMTLSConfig()
  const caCerts = getCACertificates()

  // Use EnvHttpProxyAgent to respect NO_PROXY
  const noProxy = getNoProxy()
  const normalizedNoProxy = noProxy?.replace(/(^|[,\s])\*\./g, '$1.')
  const proxyOptions: undici.EnvHttpProxyAgent.Options = {
    // Override both HTTP and HTTPS proxy with the provided URI
    httpProxy: uri,
    httpsProxy: uri,
    // Keep the v7 CONNECT default for HTTP targets as well as HTTPS targets.
    proxyTunnel: true,
    // v8 excludes the apex for *.domain entries. Preserve our existing
    // apex-and-subdomain contract, shared with the Axios/WebSocket helpers.
    // Leave ordinary values unset so undici rereads the environment. Explicit
    // normalized values are refreshed via the cache key and env reconfiguration.
    ...(normalizedNoProxy !== noProxy && { noProxy: normalizedNoProxy }),
  }

  // Set both connect and requestTls so TLS options apply to both paths:
  // - requestTls: used by ProxyAgent for the TLS connection through CONNECT tunnels
  // - connect: used by Agent for direct (no-proxy) connections
  if (mtlsConfig || caCerts) {
    const tlsOpts = {
      ...(mtlsConfig && {
        cert: mtlsConfig.cert,
        key: mtlsConfig.key,
        passphrase: mtlsConfig.passphrase,
      }),
      ...(caCerts && { ca: caCerts }),
    }
    proxyOptions.connect = tlsOpts
    proxyOptions.requestTls = tlsOpts
  }

  // Node 24's native fetch still uses dispatcher v1 callbacks. The public
  // bridge also accepts v2 handlers and preserves HTTP/1.1 for legacy callers.
  const agent = new undiciMod.EnvHttpProxyAgent(proxyOptions)
  return typeof Bun === 'undefined'
    ? new undiciMod.Dispatcher1Wrapper(agent)
    : agent
}, getProxyAgentCacheKey)

/**
 * Get an HTTP agent configured for WebSocket proxy support
 * Returns undefined if no proxy is configured or URL should bypass proxy
 */
export function getWebSocketProxyAgent(url: string): Agent | undefined {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return undefined
  }

  // Check if URL should bypass proxy
  if (shouldBypassProxy(url)) {
    return undefined
  }

  return createHttpsProxyAgent(proxyUrl)
}

/**
 * Get the proxy URL for WebSocket connections under Bun.
 * Bun's native WebSocket supports a `proxy` string option instead of Node's `agent`.
 * Returns undefined if no proxy is configured or URL should bypass proxy.
 */
export function getWebSocketProxyUrl(url: string): string | undefined {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return undefined
  }

  if (shouldBypassProxy(url)) {
    return undefined
  }

  return proxyUrl
}

/**
 * Get fetch options for the Anthropic SDK with proxy and mTLS configuration
 * Returns fetch options with appropriate dispatcher for proxy and/or mTLS
 *
 * @param opts.forAnthropicAPI - Enables ANTHROPIC_UNIX_SOCKET tunneling. This
 *   env var is set by `claude ssh` on the remote CLI to route API calls through
 *   an ssh -R forwarded unix socket to a local auth proxy. It MUST NOT leak
 *   into non-Anthropic-API fetch paths (MCP HTTP/SSE transports, etc.) or those
 *   requests get misrouted to api.anthropic.com. Only the Anthropic SDK client
 *   should pass `true` here.
 */
export function getProxyFetchOptions(opts?: { forAnthropicAPI?: boolean }): {
  tls?: TLSConfig
  dispatcher?: undici.Dispatcher
  proxy?: string
  unix?: string
  keepalive?: false
} {
  const base = keepAliveDisabled ? ({ keepalive: false } as const) : {}

  // ANTHROPIC_UNIX_SOCKET tunnels through the `claude ssh` auth proxy, which
  // hardcodes the upstream to the Anthropic API. Scope to the Anthropic API
  // client so MCP/SSE/other callers don't get their requests misrouted.
  if (opts?.forAnthropicAPI) {
    const unixSocket = process.env.ANTHROPIC_UNIX_SOCKET
    if (unixSocket && typeof Bun !== 'undefined') {
      return { ...base, unix: unixSocket }
    }
  }

  const proxyUrl = getProxyUrl()

  // If we have a proxy, use the proxy agent (which includes mTLS config)
  if (proxyUrl) {
    if (typeof Bun !== 'undefined') {
      return { ...base, proxy: proxyUrl, ...getTLSFetchOptions() }
    }
    return { ...base, dispatcher: getProxyAgent(proxyUrl) }
  }

  // Otherwise, use TLS options directly if available
  return { ...base, ...getTLSFetchOptions() }
}

/**
 * Configure global HTTP agents for both axios and undici
 * This ensures all HTTP requests use the proxy and/or mTLS if configured
 */
let proxyInterceptorId: number | undefined
let installedDispatcher: undici.Dispatcher | undefined
let installedProxyCacheKey: string | undefined
let installedTLSDispatcher = false
let installedTLSAgent: ReturnType<typeof getMTLSAgent>
let ownsInstalledDispatcher = false

export function configureGlobalAgents(): void {
  const proxyUrl = getProxyUrl()
  const mtlsAgent = getMTLSAgent()

  // Eject previous interceptor to avoid stacking on repeated calls
  if (proxyInterceptorId !== undefined) {
    axios.interceptors.request.eject(proxyInterceptorId)
    proxyInterceptorId = undefined
  }

  // Reset proxy-related defaults so reconfiguration is clean
  axios.defaults.proxy = undefined
  axios.defaults.httpAgent = undefined
  axios.defaults.httpsAgent = undefined

  if (proxyUrl) {
    // workaround for https://github.com/axios/axios/issues/4531
    axios.defaults.proxy = false

    // Create proxy agent with mTLS options if available
    const proxyAgent = createHttpsProxyAgent(proxyUrl)

    // Add axios request interceptor to handle NO_PROXY
    proxyInterceptorId = axios.interceptors.request.use(config => {
      // Check if URL should bypass proxy based on NO_PROXY
      if (config.url && shouldBypassProxy(config.url)) {
        // Bypass proxy - use mTLS agent if configured, otherwise undefined
        if (mtlsAgent) {
          config.httpsAgent = mtlsAgent
          config.httpAgent = mtlsAgent
        } else {
          // Remove any proxy agents to use direct connection
          delete config.httpsAgent
          delete config.httpAgent
        }
      } else {
        // Use proxy agent
        config.httpsAgent = proxyAgent
        config.httpAgent = proxyAgent
      }
      return config
    })
  } else {
    axios.defaults.httpsAgent = mtlsAgent
  }

  // Keep the ordinary direct path lazy. Only clear our proxy/TLS installation
  // while it is still global; another caller may have installed a replacement.
  if (!proxyUrl && !mtlsAgent && installedProxyCacheKey === undefined && !installedTLSDispatcher) return
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undiciMod = require('undici') as typeof undici
  if (!proxyUrl && !mtlsAgent && undiciMod.getGlobalDispatcher() !== installedDispatcher) return

  // Reuse our TLS installation while its source configuration remains cached.
  const cachedTLSDispatcher = !proxyUrl && mtlsAgent && installedTLSDispatcher &&
    installedTLSAgent === mtlsAgent ? installedDispatcher : undefined
  const tlsOptions = proxyUrl || cachedTLSDispatcher ? undefined : getTLSFetchOptions()
  const dispatcher = proxyUrl ? getProxyAgent(proxyUrl) :
    cachedTLSDispatcher ?? tlsOptions?.dispatcher ?? new undiciMod.Agent({ connect: tlsOptions?.tls })
  undiciMod.setGlobalDispatcher(dispatcher)

  if (installedDispatcher && installedDispatcher !== dispatcher) {
    // Evict only the retired proxy, leaving the active dispatcher cached.
    if (installedProxyCacheKey !== undefined &&
        getProxyAgent.cache.get(installedProxyCacheKey) === installedDispatcher) {
      getProxyAgent.cache.delete(installedProxyCacheKey)
    }
    // Proxy dispatchers are shared with callers that can retain fetch options.
    // Eviction does not prove those references are gone, so leave them open.
    if (ownsInstalledDispatcher || (installedTLSDispatcher && installedTLSAgent !== mtlsAgent)) {
      try {
        // Graceful close lets in-flight requests finish without blocking updates.
        void installedDispatcher.close().catch(() => {})
      } catch {
        // Dispatcher cleanup is best effort.
      }
    }
  }
  installedDispatcher = dispatcher
  installedProxyCacheKey = proxyUrl ? getProxyAgentCacheKey(proxyUrl) : undefined
  installedTLSDispatcher = !proxyUrl && !!mtlsAgent
  installedTLSAgent = mtlsAgent
  // Only the plain direct dispatcher is private; proxy options are handed out.
  ownsInstalledDispatcher = !proxyUrl && !mtlsAgent
}

/**
 * Get AWS SDK client configuration with proxy support
 * Returns configuration object that can be spread into AWS service client constructors
 */
export async function getAWSClientProxyConfig(): Promise<object> {
  const proxyUrl = getProxyUrl()

  if (!proxyUrl) {
    return {}
  }

  const [{ NodeHttpHandler }, { defaultProvider }] = await Promise.all([
    importOptionalRuntimeModule<typeof import('@smithy/node-http-handler')>(
      '@smithy/node-http-handler',
      'AWS proxy support',
    ),
    importOptionalRuntimeModule<typeof import('@aws-sdk/credential-provider-node')>(
      '@aws-sdk/credential-provider-node',
      'AWS proxy support',
    ),
  ])

  const agent = createHttpsProxyAgent(proxyUrl)
  const requestHandler = new NodeHttpHandler({
    httpAgent: agent,
    httpsAgent: agent,
  })

  return {
    requestHandler,
    credentials: defaultProvider({
      clientConfig: { requestHandler },
    }),
  }
}

/**
 * Clear proxy agent cache.
 */
export function clearProxyCache(): void {
  getProxyAgent.cache.clear?.()
  logForDebugging('Cleared proxy agent cache')
}
