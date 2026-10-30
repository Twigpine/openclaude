import reject from 'lodash-es/reject.js'
import { resolve } from 'node:path'
import { z } from 'zod/v4'
import { getServerKey, performMCPOAuthFlow } from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  connectToServer,
  getServerCacheKey,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import {
  type CredentialScope,
  resumeIn,
} from '../../services/mcp/credentialScope.js'
import {
  buildMcpToolName,
  getMcpPrefix,
} from '../../services/mcp/mcpStringUtils.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from '../../utils/secureStorage/macOsKeychainHelpers.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

const inputSchema = lazySchema(() => z.object({}))
type InputSchema = ReturnType<typeof inputSchema>

// SDK tools are rebuilt per session, but registrations share a credential
// entry. Keep only active attempts; abort and settlement both release them.
const pendingSdkSignIns = new Map<string, AbortController>()

export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}

function getConfigUrl(config: ScopedMcpServerConfig): string | undefined {
  if ('url' in config) return config.url
  return undefined
}

/**
 * Creates a pseudo-tool for an MCP server that is installed but not
 * authenticated. Surfaced in place of the server's real tools so the model
 * knows the server exists and can start the OAuth flow on the user's behalf.
 *
 * When called, starts performMCPOAuthFlow with skipBrowserOpen and returns
 * the authorization URL. The OAuth callback completes in the background;
 * once it fires, reconnectMcpServerImpl runs and the server's real tools
 * are swapped into appState.mcp.tools via the existing prefix-based
 * replacement (useManageMCPConnections.updateServer wipes anything matching
 * mcp__<server>__*, so this pseudo-tool is removed automatically).
 *
 * That last step only happens where appState feeds the tool pool — the CLI.
 * A v2 SDK session connects its MCP servers once and does not re-read the
 * pool after a reconnect, so `realToolsInCurrentContext` lets that caller
 * tell the model the truth instead of promising tools the session cannot
 * offer. See issue #2294.
 */
export type McpAuthToolOptions = {
  /**
   * Whether the host exposes the server's real tools in the current context
   * once authorization completes. Defaults to `true` (the CLI behavior).
   * Pass `false` from an embedder whose session will not pick them up, so the
   * model is told to start a new session rather than promised automatic
   * availability. The flow then also belongs to the calling context: its
   * abort signal (the embedder's close/interrupt) releases the pending
   * callback listener, a newer call replaces an attempt still pending, and
   * completion stores the tokens — and drops the connector's memoized
   * needs-auth result, so the next session's connection tries them — without
   * opening a client the session would never use or clean up.
   */
  realToolsInCurrentContext?: boolean
  /**
   * Captures the environment a call runs in, for the part of the
   * sign-in that runs after the call has returned: the user's return from the
   * browser, the token exchange, the stored tokens and the dropped needs-auth
   * cache entry. An embedder's session applies its `env` for the turn and
   * restores the process's own afterwards, while the credential store is
   * chosen from the environment at each read and write; without this a
   * sign-in started in one session's store would finish in another's. The
   * scope re-applies the turn's environment under the env mutex the turns
   * hold, so a sign-in finishing during another session's turn waits for it.
   * The CLI's environment does not change, so it passes none.
   */
  captureCredentialScope?: () => CredentialScope
  /** SDK root owner, distinct from an executor's per-tool cancellation. */
  sessionSignal?: AbortSignal
}

export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
  options: McpAuthToolOptions = {},
): Tool<InputSchema, McpAuthOutput> {
  const url = getConfigUrl(config)
  const transport = config.type ?? 'stdio'
  const location = url ? `${transport} at ${url}` : transport
  const realToolsInCurrentContext = options.realToolsInCurrentContext ?? true

  const afterAuth = realToolsInCurrentContext
    ? `Once the user completes authorization in their browser, the server's real tools will become available automatically.`
    : `Once the user completes authorization in their browser, start a new session to use the server's real tools — this one connects its MCP servers once and will not pick them up.`

  const description =
    `The \`${serverName}\` MCP server (${location}) is installed but requires authentication. ` +
    `Call this tool to start the OAuth flow — you'll receive an authorization URL to share with the user. ` +
    afterAuth

  // Also retain session-local replacement if its credential namespace changes.
  let pendingSignIn: AbortController | undefined

  /**
   * Starts an embedder's attempt, owned by the session's controller. Every
   * attempt clears the server's stored entry and registers its own client
   * there, so an older attempt left running would exchange its code with the
   * newer one's client and fail after the user had signed in. Stop it, as
   * cli/print.ts does for mcp_authenticate.
   */
  function beginSessionSignIn(
    toolSignal: AbortSignal,
    serverConfig: McpSSEServerConfig | McpHTTPServerConfig,
    resultSignal?: AbortSignal,
  ) {
    const sessionSignal = options.sessionSignal ?? toolSignal
    const aborted = [sessionSignal, toolSignal, resultSignal].find(signal => signal?.aborted)
    if (aborted) {
      return {
        signal: aborted,
        release: () => {}, returnedUrl: () => {},
      }
    }
    const serverKey = getServerKey(serverName, serverConfig)
    // Default storage can read/write either the native entry or its plaintext
    // fallback. USER and OAuth namespace partition only the native entry;
    // even a working vault may fall back on a later write. Own both aliases.
    const entryKeys = [
      JSON.stringify(['native', getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX), getUsername(), serverKey]),
      JSON.stringify(['plaintext', resolve(getClaudeConfigHomeDir()), serverKey]),
    ]
    pendingSignIn?.abort()
    for (const key of entryKeys) pendingSdkSignIns.get(key)?.abort()
    const attempt = new AbortController()
    pendingSignIn = attempt
    for (const key of entryKeys) pendingSdkSignIns.set(key, attempt)
    const stop = () => attempt.abort()
    const separateToolSignal = toolSignal !== sessionSignal && toolSignal !== resultSignal
    // A completed tool hands background ownership to the session/result.
    const returnedUrl = () => {
      if (separateToolSignal) toolSignal.removeEventListener('abort', stop)
    }
    const release = () => {
      sessionSignal.removeEventListener('abort', stop)
      resultSignal?.removeEventListener('abort', stop)
      returnedUrl()
      attempt.signal.removeEventListener('abort', release)
      if (pendingSignIn === attempt) pendingSignIn = undefined
      for (const key of entryKeys) {
        if (pendingSdkSignIns.get(key) === attempt) pendingSdkSignIns.delete(key)
      }
    }
    attempt.signal.addEventListener('abort', release, { once: true })
    sessionSignal.addEventListener('abort', stop, { once: true })
    resultSignal?.addEventListener('abort', stop, { once: true })
    if (separateToolSignal) toolSignal.addEventListener('abort', stop, { once: true })
    if (sessionSignal.aborted || toolSignal.aborted || resultSignal?.aborted) stop()
    return { signal: attempt.signal, release, returnedUrl }
  }

  return {
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - authenticate (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () => `Authenticate ${serverName} MCP server`,
    async description() {
      return description
    },
    async prompt() {
      return description
    },
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    async checkPermissions(input): Promise<PermissionDecision> {
      return { behavior: 'allow', updatedInput: input }
    },
    async call(_input, context) {
      // claude.ai connectors use a separate auth flow (handleClaudeAIAuth in
      // MCPRemoteServerMenu) that we don't invoke programmatically here —
      // just point the user at /mcp.
      if (config.type === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `This is a claude.ai MCP connector. Ask the user to run /mcp and select "${serverName}" to authenticate.`,
          },
        }
      }

      // performMCPOAuthFlow only accepts sse/http. needs-auth state is only
      // set on HTTP 401 (UnauthorizedError) so other transports shouldn't
      // reach here, but be defensive.
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `Server "${serverName}" uses ${transport} transport which does not support OAuth from this tool. Ask the user to run /mcp and authenticate manually.`,
          },
        }
      }

      const sseOrHttpConfig = config as (
        | McpSSEServerConfig
        | McpHTTPServerConfig
      ) & { scope: ScopedMcpServerConfig['scope'] }

      // Mirror cli/print.ts mcp_authenticate: start the flow, capture the
      // URL via onAuthorizationUrl, return it immediately. The flow's
      // Promise resolves later when the browser callback fires.
      let resolveAuthUrl: ((url: string) => void) | undefined
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      // The CLI's flow outlives the turn that started it, so nothing aborts it
      // but its own timeout. The SDK supplies its root owner so a completed
      // tool's callback survives sibling failures, while close/interrupt and
      // intentional discard still shut it down.
      const signIn = realToolsInCurrentContext
        ? { signal: new AbortController().signal, release: () => {}, returnedUrl: () => {} }
        : beginSessionSignIn(context.abortController.signal, sseOrHttpConfig, context.toolResultAbortSignal)
      const { setAppState } = context
      // Captured now, inside the call: the flow's reads and writes after the
      // user's browser comes back belong here, however the environment has
      // changed by then.
      const credentialScope = options.captureCredentialScope?.()

      const oauthPromise = performMCPOAuthFlow(
        serverName,
        sseOrHttpConfig,
        u => resolveAuthUrl?.(u),
        signIn.signal,
        { skipBrowserOpen: true, credentialScope },
      )

      // Background continuation: once OAuth completes, reconnect and swap
      // the real tools into appState. Prefix-based replacement removes this
      // pseudo-tool since it shares the mcp__<server>__ prefix.
      void oauthPromise
        .then(async () => {
          // Drop the needs-auth cache either way, so the next connection —
          // here or in a new session — tries the stored tokens. The cache
          // file lives in the config home the flow began in.
          await resumeIn(credentialScope, async () => clearMcpAuthCache())
          if (!realToolsInCurrentContext) {
            // Nothing here would use a reconnected client, and the session's
            // cleanup would never close it. A new session connects instead —
            // through the connector, which memoizes what it found by server
            // name and config and would hand the new session this needs-auth
            // result back, stored tokens or not. Retry disconnected results,
            // including a failed attempt made while auth was pending, but
            // preserve another session's connected replacement. These results
            // fetched no tools and need no client/fetch-cache cleanup.
            const key = getServerCacheKey(serverName, config)
            const cached = connectToServer.cache.get(key)
            if (
              cached &&
              (await cached).type !== 'connected' &&
              connectToServer.cache.get(key) === cached
            ) {
              connectToServer.cache.delete(key)
            }
            logMCPDebug(serverName, `OAuth complete; tools available in a new session`)
            return
          }
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c => c.name?.startsWith(prefix)),
                ...result.commands,
              ],
              resources: result.resources
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : prev.mcp.resources,
            },
          }))
          logMCPDebug(
            serverName,
            `OAuth complete, reconnected with ${result.tools.length} tool(s)`,
          )
        })
        .catch(err => {
          logMCPError(
            serverName,
            `OAuth flow failed after tool-triggered start: ${errorMessage(err)}`,
          )
        })
        .finally(signIn.release)

      try {
        // Race: get the URL, or the flow completes without needing one
        // (e.g. XAA with cached IdP token — silent auth).
        const authUrl = await Promise.race([
          authUrlPromise,
          oauthPromise.then(() => null as string | null),
        ])

        if (authUrl) {
          signIn.returnedUrl()
          return {
            data: {
              status: 'auth_url' as const,
              authUrl,
              message:
                `Ask the user to open this URL in their browser to authorize the ${serverName} MCP server:\n\n${authUrl}\n\n` +
                (realToolsInCurrentContext
                  ? `Once they complete the flow, the server's tools will become available automatically.`
                  : `Once they complete the flow, start a new session to use the server's tools.`),
            },
          }
        }

        return {
          data: {
            status: 'auth_url' as const,
            message: realToolsInCurrentContext
              ? `Authentication completed silently for ${serverName}. The server's tools should now be available.`
              : `Authentication completed silently for ${serverName}. Start a new session to use the server's tools.`,
          },
        }
      } catch (err) {
        return {
          data: {
            status: 'error' as const,
            message: `Failed to start OAuth flow for ${serverName}: ${errorMessage(err)}. Ask the user to run /mcp and authenticate manually.`,
          },
        }
      }
    },
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.message,
      }
    },
  } satisfies Tool<InputSchema, McpAuthOutput>
}
