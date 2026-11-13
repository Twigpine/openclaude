/**
 * V2 API for the SDK — persistent sessions and one-shot prompt.
 *
 * Provides SDKSession, SDKSessionImpl, createEngineFromOptions,
 * and the unstable_v2_* functions.
 */

import { randomUUID } from 'crypto'
import { dirname } from 'path'
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import { QueryEngine } from '../../QueryEngine.js'
import {
  getDefaultAppState,
  type AppState,
} from '../../state/AppStateStore.js'
import { createStore, type Store } from '../../state/store.js'
import {
  type Tool,
  type ToolPermissionContext,
} from '../../Tool.js'
import { AuthenticationCancelledError, performMCPOAuthFlow } from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  connectToServer,
  getServerCacheKey,
  reconnectMcpServerImpl,
  releaseUnownedMcpClient,
} from '../../services/mcp/client.js'
import { resumeIn, type ActiveCredentialScope } from '../../services/mcp/credentialScope.js'
import { getMcpPrefix } from '../../services/mcp/mcpStringUtils.js'
import {
  createMcpAuthTool,
  getSdkSignInEntryKeys,
  registerSdkSignIn,
} from '../../tools/McpAuthTool/McpAuthTool.js'
import type {
  MCPServerConnection,
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { assembleToolPool, getTools } from '../../tools.js'
import { createFileStateCacheWithSizeLimit } from '../../utils/fileStateCache.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearOAuthTokenCache,
} from '../../utils/auth.js'
import { requestSdkRootAbort } from './interruption.js'
import { init } from '../init.js'
import {
  resolveSessionFilePath,
  readTranscriptForLoad,
  SKIP_PRECOMPACT_THRESHOLD,
} from '../../utils/sessionStoragePortable.js'
import { readJSONLFile } from '../../utils/json.js'
import { stat } from 'fs/promises'
import {
  switchSession,
  bindSdkContextToAsyncGenerator,
  runOutsideSdkContext,
} from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import {
  getAgentDefinitionsWithOverrides,
  type AgentDefinitionsResult,
} from '../../tools/AgentTool/loadAgentsDir.js'
import type {
  PermissionResult,
  SDKResultMessage as GeneratedSDKResultMessage,
  McpServerStatus,
} from './coreTypes.generated.js'
import type { Message } from '../../types/message.js'
import type {
  SDKMessage,
  SDKPermissionTimeoutMessage,
  SDKAgentLoadFailureMessage,
  JsonlEntry,
  QueryPermissionMode,
  CanUseToolCallback,
  SDKPermissionRequestMessage,
} from './shared.js'
import {
  acquireEnvMutex,
  assertValidSessionId,
  mapMessageToSDK,
  releaseEnvMutex,
} from './shared.js'
import {
  buildPermissionContext,
  captureCredentialScope,
  createExternalCanUseTool,
  connectSdkMcpServers,
  createDefaultCanUseTool,
  createOnceOnlyResolve,
  type PermissionResolveDecision,
  type PermissionTarget,
} from './permissions.js'
import {
  parseJsonlEntries,
  findLastCompactBoundary,
  applyPreservedSegmentRelinks,
  buildConversationChain as buildChain,
  stripExtraFields as stripChainFields,
} from './transcript.js'
import {
  buildSdkUserAgents,
  mergeSdkUserAgents,
  type SdkAgentDefinitionInput,
} from './agentDefinitions.js'

// ============================================================================
// V2 API Types
// ============================================================================

/**
 * Options for creating a persistent SDK session.
 * Used by unstable_v2_createSession and unstable_v2_resumeSession.
 */
export type SDKSessionOptions = {
  /** Working directory for the session. Required. */
  cwd: string
  /** Model to use (e.g. 'claude-sonnet-4-6'). */
  model?: string
  /** Permission mode for tool access. */
  permissionMode?: QueryPermissionMode
  /** Skip permission prompts entirely (dangerous). */
  allowDangerouslySkipPermissions?: boolean
  /** AbortController to cancel the session. */
  abortController?: AbortController
  /**
   * Environment variables to apply while this session's turns run.
   *
   * `QueryOptions` already accepts this; a session could not, so a host that
   * keeps several sessions in one process had to share one environment
   * between them. That is a problem when the variable in question selects the
   * provider: `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and the matching keys
   * are read per request, so two sessions pointed at different endpoints
   * silently used whichever was set last.
   *
   * Applied around each turn and restored afterwards, under the same
   * process-wide env mutex `query()` uses, so a session's variables cannot
   * leak into another session's turn. That mutex also means turns with
   * different environments SERIALISE rather than overlap: with one process
   * environment there is no honest alternative, and serialising is the
   * behaviour that is correct rather than merely concurrent.
   *
   * Provider-derived routing/authentication variables are restored too.
   * A value of `undefined` removes the variable for the turn.
   *
   * What it does NOT do, exactly as in `query()`: a turn belonging to a
   * session without `env` takes no mutex, so it can run while another
   * session's variables are in place. In one process there is one
   * environment; isolating readers as well as writers would mean serialising
   * every turn in the process. So set `env` on every session that cares which
   * provider it reaches, not only on the odd one out.
   *
   * TWO WAYS TO DEADLOCK YOURSELF, because the lock is held for the whole
   * turn and not just while the variables are written:
   *
   * 1. A PAUSED ITERATOR STILL HOLDS IT. Stopping half way through
   *    `for await (… of session.sendMessage(…))` to await another
   *    env-carrying turn waits forever: the first turn cannot finish while
   *    the second waits for the lock it holds. Finish the turn, or leave the
   *    loop with `break`/`return` — which calls the generator's `return` and
   *    frees the lock — before awaiting another one.
   * 2. A `canUseTool` CALLBACK IS INSIDE THE TURN. Awaiting an env-carrying
   *    `query()` or session turn from it is the same deadlock, one level
   *    down. Answer the permission from what the callback already has.
   *    `authenticateMcpServer` is the exception: a turn lends its
   *    environment to the sign-in the callback starts, so awaiting it
   *    there does not wait on the turn's own mutex.
   *
   * Neither applies to sessions without `env`: they take no lock.
   */
  env?: Record<string, string | undefined>

  /**
   * Callback invoked before each tool use. Return `{ behavior: 'allow' }` to
   * permit the call or `{ behavior: 'deny', message?: string }` to reject it.
   *
   * **Secure-by-default**: If neither `canUseTool` nor `onPermissionRequest`
   * is provided, ALL tool uses are denied. You MUST provide at least one of
   * these callbacks to allow tool execution.
   */
  canUseTool?: CanUseToolCallback
  /** MCP server configurations for this session. */
  mcpServers?: Record<string, unknown>
  /**
   * Callback invoked when a tool needs permission approval. The host receives
   * the request immediately and can resolve it via respondToPermission().
   */
  onPermissionRequest?: (message: SDKPermissionRequestMessage) => void
  /** Tools to disallow (blanket deny by tool name). */
  disallowedTools?: string[]
  /** Agent definitions to register with the session engine. */
  agents?: Record<string, SdkAgentDefinitionInput>
}

/**
 * A persistent session wrapping a QueryEngine for multi-turn conversations.
 *
 * Each call to `sendMessage` starts a new turn within the same conversation.
 * State (messages, file cache, usage, etc.) persists across turns.
 *
 * **IMPORTANT: Resource Cleanup**
 * You MUST call `close()` when finished with a session to prevent memory leaks.
 * Abandoned sessions retain internal buffers (pending permission prompts, timeout
 * queues, agent failure queues) until explicitly closed. In long-running processes,
 * failing to close sessions can cause unbounded memory growth.
 *
 * @example
 * ```typescript
 * const session = unstable_v2_createSession({ cwd: '/my/project' });
 * try {
 *   for await (const msg of session.sendMessage('Hello!')) {
 *     console.log(msg);
 *   }
 * } finally {
 *   session.close(); // ALWAYS close the session
 * }
 * ```
 */
export interface SDKSession {
  /** Unique identifier for this session. */
  sessionId: string
  /** Send a message and yield responses as an AsyncIterable of SDKMessage. */
  sendMessage(content: string): AsyncIterable<SDKMessage>
  /** Return all messages accumulated so far in this session. */
  getMessages(): SDKMessage[]
  /** Abort the current in-flight query. */
  interrupt(): void
  /** Close the session; active turns unwind before their environment is restored. */
  close(): void
  /**
   * Respond to a pending permission prompt asynchronously.
   * Use this when no canUseTool callback was provided — the SDK emits a
   * permission-request message and the host resolves it via this method.
   */
  respondToPermission(toolUseId: string, decision: PermissionResult): void
  /**
   * Start the OAuth flow for one of the session's MCP servers and await it —
   * the host-facing half of issue #2294 proposal 2, for a UI with a
   * "Sign in" button that also needs to know when authorization finished.
   *
   * The authorization URL is delivered to `options.onAuthorizationUrl` as
   * soon as it is known, so the host can open it (or show it) while the
   * flow runs. The returned promise resolves once the flow settles and the
   * server has been reconnected, with the server's new status in the same
   * shape `system:init.mcp_servers` reports — the next turn's `system:init`
   * carries it too, since it is built from the session's MCP clients. The
   * flow may complete without a redirect (a cached IdP token signs in
   * silently); then `onAuthorizationUrl` is never called and the promise
   * still resolves with the connected status.
   *
   * A successful flow whose reconnect still does not connect (the server
   * still answers 401, or is down) resolves with that status instead of
   * rejecting — read `status` and `error`. A flow that itself fails, is
   * cancelled, or is superseded by a newer call for the same server rejects.
   * Calling this before the first turn connects the session's MCP servers
   * first, so a settings page can sign in before anyone chats.
   *
   * Only `http`/`sse` servers support this. The flow runs in the
   * environment captured when the call starts — a session's `env`
   * overrides are not applied to a call made outside a turn. A call made
   * by `canUseTool` during an environment-carrying turn is the exception:
   * it uses that turn's environment, lent rather than re-acquired, so the
   * sign-in does not wait on the mutex the turn holds. Closing the
   * session aborts an in-flight flow.
   */
  authenticateMcpServer(
    name: string,
    options?: {
      /** Called with the authorization URL as soon as it is known. */
      onAuthorizationUrl?: (url: string) => void
      /** Abort this sign-in without closing the session. */
      signal?: AbortSignal
    },
  ): Promise<McpServerStatus>
}

/**
 * An SDKResultMessage is the final message emitted by a query turn,
 * containing the result text, usage stats, and cost information.
 * Re-exports the full generated type from coreTypes.generated.ts.
 */
export type SDKResultMessage = GeneratedSDKResultMessage

// ============================================================================
// SdkMcpToolDefinition — tool() return type
// ============================================================================

/**
 * Describes a tool definition created by the `tool()` factory function.
 * These definitions can be passed to `createSdkMcpServer()` to register
 * custom MCP tools.
 */
export interface SdkMcpToolDefinition<Schema = unknown> {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: any, extra: unknown) => Promise<CallToolResult>
  annotations?: ToolAnnotations
  searchHint?: string
  alwaysLoad?: boolean
}

// ============================================================================
// SDKSessionImpl — concrete SDKSession
// ============================================================================

/**
 * Whether the connection cache still holds this client: another session
 * may have adopted it while a reconnect was in flight, or a later
 * connection may reuse it instead of dialling again. Used by the
 * tool-swap error path before releasing a reconnected client, so a shared
 * client's transport is never closed under a session that is using it.
 * Cache membership alone is not adoption — the cancellation path tracks
 * adoption instead — but a client the cache still holds is adoptable, and
 * the next connection reuses it.
 */
async function isClientCached(
  name: string,
  config: ScopedMcpServerConfig,
  client: MCPServerConnection,
): Promise<boolean> {
  const key = getServerCacheKey(name, config)
  const cached = connectToServer.cache.get(key)
  return cached !== undefined && (await cached) === client
}

class SDKSessionImpl implements SDKSession {
  private _engine: QueryEngine | null = null
  private get engine(): QueryEngine {
    if (!this._engine) {
      throw new Error('SDKSessionImpl: engine not initialized. Call setEngine() first.')
    }
    return this._engine
  }
  private _sessionId: string
  private options: SDKSessionOptions
  private _appStateStore: Store<AppState> | null = null
  private get appStateStore(): Store<AppState> {
    if (!this._appStateStore) {
      throw new Error('SDKSessionImpl: appStateStore not initialized. Call setAppStateStore() first.')
    }
    return this._appStateStore
  }
  private _abortController: AbortController | null = null
  private closed = false
  private activeEnvTurns = new Set<AsyncGenerator<SDKMessage>>()
  private agentsLoaded = false
  private mcpServers?: Record<string, unknown>
  private mcpConnected = false
  /** In-flight MCP connect, shared by the first turn and pre-turn auth. */
  private mcpConnectPromise: Promise<boolean> | null = null
  /** The session's current MCP tools, for rebuilding the pool after a reconnect. */
  private mcpTools: Tool[] = []
  /** In-flight OAuth flows, one per server — a newer call supersedes the old. */
  private pendingMcpAuth = new Map<string, AbortController>()
  /**
   * The active turn's environment, lent to credential work the turn itself
   * starts — a canUseTool callback awaiting authenticateMcpServer, or the
   * authenticate pseudo-tool — so that work runs in the turn's environment
   * instead of waiting on the mutex the turn holds. Null outside a turn
   * that holds the mutex (a turn without env takes none).
   */
  private turnCredentialScope: ActiveCredentialScope | null = null
  private pendingPermissionPrompts = new Map<string, {
    resolve: (decision: PermissionResolveDecision) => void
  }>()
  private timeoutQueue: SDKPermissionTimeoutMessage[] = []
  private agentFailureQueue: SDKAgentLoadFailureMessage[] = []
  /** Resolved transcript directory — dirname of the JSONL file, or null for default project dir */
  private _sessionProjectDir: string | null = null

  constructor(
    engine: QueryEngine | null,
    sessionId: string,
    options: SDKSessionOptions,
    appStateStore: Store<AppState> | null,
    abortController?: AbortController | null,
  ) {
    if (engine) this._engine = engine
    this._sessionId = sessionId
    this.options = options
    if (appStateStore) this._appStateStore = appStateStore
    if (abortController) this._abortController = abortController
    this.mcpServers = options.mcpServers
  }

  /** Late-bind the engine (used when session is created before engine). */
  setEngine(engine: QueryEngine): void {
    this._engine = engine
  }

  /** Late-bind the app state store (used when session is created before store). */
  setAppStateStore(store: Store<AppState>): void {
    this._appStateStore = store
  }

  /** Late-bind the abort controller (used when session is created before engine). */
  setAbortController(ac: AbortController): void {
    this._abortController = ac
  }

  /** Set the resolved transcript directory (called by resumeSession after resolving the JSONL path). */
  setSessionProjectDir(dir: string): void {
    this._sessionProjectDir = dir
  }

  get sessionId(): string {
    return this._sessionId
  }

  /**
   * Apply this session's `env`, remembering what was there.
   *
   * Returns the snapshot to restore, or null when the session set no `env` —
   * in which case the mutex is never taken and a session without `env` costs
   * nothing.
   *
   * If reading or writing a variable throws half way through — an `env` whose
   * properties are getters, say — what was already applied is put back and the
   * mutex is released before the error leaves. Otherwise the lock would be
   * held by a turn that never started, and every later env-setting turn in the
   * process would wait on it forever.
   */
  private async applySessionEnv(): Promise<Record<string, string | undefined> | null> {
    const overrides = this.options.env
    if (!overrides) return null
    // ENUMERATED ONCE, AND BEFORE THE MUTEX. Raised in review: the snapshot
    // loop read `Object.keys` and the apply loop `Object.entries`, which a
    // Proxy may answer differently — a key seen only by the apply loop would
    // be set and never restored. Reading the host's object before the lock
    // also means a throwing getter cannot leave the mutex held: nothing has
    // been taken yet.
    const entries = Object.entries(overrides)
    if (entries.length === 0) return null
    await acquireEnvMutex()
    // Null-prototype: `__proto__` is a variable name like any other here, and
    // on a plain object it would be swallowed by the prototype setter instead
    // of being remembered — leaving the one key we must restore unrestorable.
    const snapshot: Record<string, string | undefined> = Object.create(null)
    try {
      // Provider construction normalizes routing and hydrates saved credentials.
      // These outputs belong to the turn even when not explicit overrides.
      const keys = new Set([
        ...entries.map(([key]) => key),
        'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL',
        'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_OPENAI',
        'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_BASE_URL', 'OPENAI_MODEL',
        'OPENAI_API_FORMAT', 'OPENAI_AZURE_STYLE', 'OPENAI_AUTH_HEADER',
        'OPENAI_AUTH_SCHEME', 'OPENAI_AUTH_HEADER_VALUE',
        'GEMINI_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GITHUB_COPILOT_KEY',
        'CLAUDE_CODE_GITHUB_TOKEN_HYDRATED',
      ])
      for (const key of keys) {
        snapshot[key] = Object.hasOwn(process.env, key) ? process.env[key] : undefined
      }
      for (const [key, value] of entries) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      // Authentication readers cache results independently of process.env.
      // A scoped turn must not reuse credentials from the previous environment.
      clearOAuthTokenCache()
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
    } catch (error) {
      this.restoreSessionEnv(snapshot)
      throw error
    }
    return snapshot
  }

  /** Put back what `applySessionEnv` found, and let the next turn in. */
  private restoreSessionEnv(snapshot: Record<string, string | undefined> | null): void {
    if (!snapshot) return
    for (const key of Object.keys(snapshot)) {
      const original = snapshot[key]
      if (original === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = original
      }
    }
    clearOAuthTokenCache()
    clearApiKeyHelperCache()
    clearAwsCredentialsCache()
    releaseEnvMutex()
  }

  async *sendMessage(content: string): AsyncIterable<SDKMessage> {
    const sdkContext = {
      sessionId: this._sessionId as SessionId,
      sessionProjectDir: this._sessionProjectDir,
      cwd: this.options.cwd,
      originalCwd: this.options.cwd,
    }

    const self = this
    const inner = bindSdkContextToAsyncGenerator(
      sdkContext,
      (async function* (): AsyncGenerator<SDKMessage> {
        // Fast exit: if the caller's AbortController was already aborted
        // before iteration starts, do not initialize or submit a turn.
        if (self.closed || self._abortController?.signal.aborted) return

        await runOutsideSdkContext(init)
        if (self.closed) return

        // The session's own environment, for the length of the turn and no
        // longer. Applied AFTER init() with a full-duration mutex, the way
        // query() does it (SEC-1): init is memoized and configures proxies,
        // mTLS and the global agents process-wide, so it must not be
        // configured out of one session's variables.
        //
        // Inside the generator rather than around `yield* inner`, so an
        // abandoned iterator still restores: breaking out of the loop calls
        // the generator's return, which runs this finally with it.
        const envSnapshot = await self.applySessionEnv()
        // A turn holding the environment lends it to credential work the
        // turn itself starts — a canUseTool callback awaiting
        // authenticateMcpServer, or the authenticate pseudo-tool — so that
        // work runs in the turn's environment instead of waiting on the
        // mutex the turn holds. Without this the turn cannot finish and the
        // sign-in cannot start: the same deadlock query() avoids by lending
        // its environment (query.ts). A turn without env takes no mutex and
        // lends nothing.
        let acceptingCredentialWork = true
        const credentialWork = new Set<Promise<unknown>>()
        let runInTurnEnv: ActiveCredentialScope | null = null
        if (envSnapshot) {
          runInTurnEnv = work => {
            if (!acceptingCredentialWork) return undefined
            const pending = Promise.resolve().then(work)
            credentialWork.add(pending)
            const release = () => {
              credentialWork.delete(pending)
            }
            void pending.then(release, release)
            return pending
          }
          self.turnCredentialScope = runInTurnEnv
        }
        try {
          if (self.closed || self._abortController?.signal.aborted) return
          // Load agent definitions once (not on every sendMessage call)
          if (!self.agentsLoaded) {
            let agentDefs: AgentDefinitionsResult = { activeAgents: [], allAgents: [] }
            const reportDefinitionFailure = (errorMessage: string) => {
              self.pushAgentFailure({
                type: 'agent_load_failure',
                stage: 'definitions',
                error_message: errorMessage,
              })
            }
            try {
              agentDefs = await getAgentDefinitionsWithOverrides(self.options.cwd)
              if (self.closed) return
              for (const failedFile of agentDefs.failedFiles ?? []) {
                reportDefinitionFailure(
                  `Failed to load agent definition '${failedFile.path}': ${failedFile.error}`,
                )
              }
            } catch (err) {
              // Agent loading failed — continue without filesystem agents but emit failure event
              const errorMessage = err instanceof Error ? err.message : String(err)
              console.warn('SDK: agent loading failed:', errorMessage)
              reportDefinitionFailure(errorMessage)
            }

            if (self.closed) return
            const userAgents = buildSdkUserAgents(
              self.options.agents,
              (name, errorMessage) => {
                self.pushAgentFailure({
                  type: 'agent_load_failure',
                  stage: 'injection',
                  error_message: `Invalid SDK agent '${name}': ${errorMessage}`,
                })
              },
            )
            const mergedAgentDefs = mergeSdkUserAgents(agentDefs, userAgents)
            if (mergedAgentDefs.activeAgents.length > 0) {
              self.appStateStore.setState(prev => ({
                ...prev,
                agentDefinitions: mergedAgentDefs,
              }))
              try {
                self.engine.injectAgents(mergedAgentDefs.activeAgents)
              } catch (err) {
                // Agent injection failed — continue without agents but emit failure event
                const errorMessage = err instanceof Error ? err.message : String(err)
                console.warn('SDK: agent injection failed:', errorMessage)
                self.appStateStore.setState(prev => ({
                  ...prev,
                  agentDefinitions: { activeAgents: [], allAgents: [] },
                }))
                self.pushAgentFailure({
                  type: 'agent_load_failure',
                  stage: 'injection',
                  error_message: errorMessage,
                })
              }
            } else {
              self.appStateStore.setState(prev => ({
                ...prev,
                agentDefinitions: mergedAgentDefs,
              }))
            }
            self.agentsLoaded = true
          }

          // Connect MCP servers once (lazy, on first use)
          if (!(await self.ensureMcpConnected())) return

          // Switch session for transcript writes using session's own resolved dir
          switchSession(self._sessionId as SessionId, self._sessionProjectDir)

          try {
            if (self.closed || self._abortController?.signal.aborted) return
            yield* self.drainAgentFailureQueue()
            for await (const engineMsg of self.engine.submitMessage(content)) {
              if (self.closed || self._abortController?.signal.aborted) break
              yield engineMsg
              yield* self.drainTimeoutQueue()
              yield* self.drainAgentFailureQueue()
            }
            // Final drain for timeout/failure messages that fired on the last engine yield
            yield* self.drainTimeoutQueue()
            yield* self.drainAgentFailureQueue()
          } finally {
            self.timeoutQueue.length = 0
            self.agentFailureQueue.length = 0
          }
        } finally {
          // Stop lending before waiting: later continuations take the mutex
          // normally. An exchange already using our env must finish first.
          acceptingCredentialWork = false
          await Promise.allSettled(credentialWork)
          if (runInTurnEnv && self.turnCredentialScope === runInTurnEnv) {
            self.turnCredentialScope = null
          }
          self.restoreSessionEnv(envSnapshot)
        }
      })(),
    )

    if (this.options.env) this.activeEnvTurns.add(inner)
    try {
      yield* inner
    } finally {
      this.activeEnvTurns.delete(inner)
    }
  }

  getMessages(): SDKMessage[] {
    return this.engine.getMessages().map(msg => mapMessageToSDK(msg as Record<string, unknown>))
  }

  interrupt(): void {
    this.interruptWithSource('sdk_interrupt')
  }

  private interruptWithSource(source: string): void {
    if (this._engine) {
      this._engine.interrupt(source)
    } else if (this._abortController) {
      requestSdkRootAbort(this._abortController, source, 'sdk_session')
    }
    // Deny all pending permission prompts before clearing
    for (const [, pending] of this.pendingPermissionPrompts) {
      pending.resolve({
        behavior: 'deny',
        message: 'Session interrupted',
        decisionReason: { type: 'mode', mode: 'default' },
      })
    }
    this.timeoutQueue.length = 0
    this.pendingPermissionPrompts.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const wrapperController = this._abortController
    this.interruptWithSource('sdk_close')
    if (wrapperController) {
      requestSdkRootAbort(wrapperController, 'sdk_close', 'sdk_session')
    }
    this._abortController = null
    // Disconnect MCP clients to prevent resource leaks
    const mcpClients = this._engine?.getMcpClients?.() ?? []
    for (const client of mcpClients) {
      if (client.type === 'connected' && client.cleanup) {
        // Fire-and-forget cleanup — close() is synchronous
        void client.cleanup().catch(err => {
          console.warn('SDK: MCP client cleanup error:', err instanceof Error ? err.message : String(err))
        })
      }
    }
    // Return paused turns and let pending engine work unwind before their
    // finally restores the environment. A queued turn has not acquired an
    // environment and must not keep the closed session's engine/store alive.
    for (const turn of this.activeEnvTurns) {
      void turn.return(undefined).catch(error => {
        console.warn('SDK: turn cleanup error:', error)
      })
    }
    this.activeEnvTurns.clear()
    this._engine = null
    this._appStateStore = null
  }

  /**
   * Register a pending permission prompt for external resolution.
   * Returns a Promise that resolves when respondToPermission() is called
   * with the matching toolUseId.
   */
  registerPendingPermission(toolUseId: string): Promise<PermissionResolveDecision> {
    return new Promise(resolve => {
      const wrappedResolve = createOnceOnlyResolve(resolve)
      this.pendingPermissionPrompts.set(toolUseId, { resolve: wrappedResolve })
    })
  }

  /** Delete a pending permission prompt without resolving it. */
  deletePendingPermission(toolUseId: string): void {
    this.pendingPermissionPrompts.delete(toolUseId)
  }

  /** Deny a pending permission prompt with a message and clean up. */
  denyPendingPermission(toolUseId: string, message: string): void {
    const pending = this.pendingPermissionPrompts.get(toolUseId)
    if (pending) {
      pending.resolve({
        behavior: 'deny',
        message,
        decisionReason: { type: 'mode', mode: 'default' },
      })
      this.pendingPermissionPrompts.delete(toolUseId)
    }
  }

  /** Push a timeout message into the queue for later draining. */
  pushTimeout(msg: SDKPermissionTimeoutMessage): void {
    this.timeoutQueue.push(msg)
  }

  /** Drain all queued timeout messages. */
  private *drainTimeoutQueue(): Generator<SDKPermissionTimeoutMessage> {
    while (this.timeoutQueue.length > 0) {
      yield this.timeoutQueue.shift()!
    }
  }

  /** Push an agent load failure message into the queue for later draining. */
  pushAgentFailure(msg: SDKAgentLoadFailureMessage): void {
    this.agentFailureQueue.push(msg)
  }

  /** Drain all queued agent failure messages. */
  private *drainAgentFailureQueue(): Generator<SDKAgentLoadFailureMessage> {
    while (this.agentFailureQueue.length > 0) {
      yield this.agentFailureQueue.shift()!
    }
  }

  respondToPermission(toolUseId: string, decision: PermissionResult): void {
    const pending = this.pendingPermissionPrompts.get(toolUseId)
    if (!pending) return

    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message ?? 'Permission denied',
        decisionReason: { type: 'mode', mode: 'default' },
      })
    }
    this.pendingPermissionPrompts.delete(toolUseId)
  }

  /**
   * Connect the session's MCP servers once (lazy, on first use).
   *
   * Returns false when the session closed while connecting, so the caller
   * stops instead of starting work on a closed session. A failed connect
   * still counts as connected — same as before the extraction — so a later
   * turn does not re-dial servers that already failed.
   *
   * The connect itself runs once: a first turn and a pre-turn sign-in that
   * overlap share the in-flight promise instead of each installing their
   * own snapshot, which would let the turn's earlier needs-auth install
   * land after the sign-in's reconnect and put the pseudo-tool back.
   */
  private async ensureMcpConnected(): Promise<boolean> {
    if (this.mcpConnected || !this.mcpServers || Object.keys(this.mcpServers).length === 0) {
      return !this.closed
    }
    const inFlight = this.mcpConnectPromise
    if (inFlight) return inFlight
    const promise = this.connectMcpServersOnce()
    this.mcpConnectPromise = promise
    try {
      return await promise
    } finally {
      if (this.mcpConnectPromise === promise) this.mcpConnectPromise = null
    }
  }

  /**
   * Await the shared MCP connect, but stop waiting when this sign-in is
   * aborted — the connect itself keeps running for a first turn that may
   * still be awaiting it, so an aborted sign-in does not cancel another
   * session user's initialization.
   *
   * Returns false when the session closed or the sign-in was aborted; the
   * caller tells those apart.
   */
  private async ensureMcpConnectedForAuth(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    let onAbort: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AuthenticationCancelledError())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([this.ensureMcpConnected(), aborted])
    } catch (error) {
      if (error instanceof AuthenticationCancelledError) return false
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort!)
    }
  }

  private async connectMcpServersOnce(): Promise<boolean> {
    try {
      // The authenticate tool the connect installs borrows the environment
      // of the turn that calls it, when there is one — resolved when the
      // tool is called, so a tool created before any turn still lends the
      // turn that runs it, and the scope it lends is the one that turn
      // started with, not a later turn's.
      const { clients: mcpClients, tools: mcpTools } = await connectSdkMcpServers(
        this.mcpServers,
        () => this.turnCredentialScope ?? undefined,
        this._abortController?.signal,
      )
      if (this.closed) return false
      if (mcpClients.length > 0) {
        this.engine.setMcpClients(mcpClients)
      }
      if (mcpTools.length > 0) {
        const permissionContext = this.appStateStore.getState().toolPermissionContext
        this.engine.updateTools(assembleToolPool(permissionContext, mcpTools))
      }
      this.mcpTools = mcpTools
    } catch (err) {
      // MCP connection failed — continue without MCP tools
      console.warn('SDK: MCP server connection failed:', err instanceof Error ? err.message : String(err))
    }
    this.mcpConnected = true
    return !this.closed
  }

  /**
   * Host-facing OAuth entry point for one MCP server — the implementation
   * behind the `SDKSession.authenticateMcpServer` contract above: the URL
   * goes to `options.onAuthorizationUrl` as soon as it is known, and the
   * returned promise resolves with the server's status once the flow has
   * settled and the server has been reconnected.
   */
  async authenticateMcpServer(
    name: string,
    options?: {
      onAuthorizationUrl?: (url: string) => void
      signal?: AbortSignal
    },
  ): Promise<McpServerStatus> {
    if (this.closed) {
      throw new Error('SDK session is closed')
    }
    const rawConfig = this.mcpServers?.[name]
    if (rawConfig === undefined) {
      throw new Error(`Server not found: ${name}`)
    }
    if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
      throw new Error(
        `Invalid MCP server config for '${name}': expected object, got ${rawConfig === null ? 'null' : Array.isArray(rawConfig) ? 'array' : typeof rawConfig}`,
      )
    }
    // Same scoped config connectSdkMcpServers built for this server.
    const config = {
      ...(rawConfig as Record<string, unknown>),
      scope: 'session',
    } as unknown as ScopedMcpServerConfig
    if (config.type !== 'sse' && config.type !== 'http') {
      throw new Error(`Server type "${config.type}" does not support OAuth authentication`)
    }
    const serverConfig = config as unknown as McpSSEServerConfig | McpHTTPServerConfig

    // A host call whose signal is already aborted — or a session whose
    // signal already aborted — must not supersede the attempt still
    // pending: check before aborting it or registering a replacement, and
    // leave that sign-in to finish. Check before init, too: an aborted
    // call must not wait out initialization, and an initialization error
    // must not replace the cancellation error. The check after init stays,
    // for an abort that lands while it runs.
    const sessionSignal = this._abortController?.signal
    if (options?.signal?.aborted || sessionSignal?.aborted) {
      throw new AuthenticationCancelledError()
    }
    // The namespace the flow's credentials belong to is the environment as
    // it is now — before another session's turn can change it while the
    // user is in the browser. Snapshot the turn that called this method
    // before init awaits: by the time the flow starts, another turn may
    // hold the field, and the exchange would then run in that turn's
    // namespace instead of this call's.
    const entryCredentialScope = this.turnCredentialScope

    // Process-wide networking (proxy, mTLS client certificate, CA certs) is
    // configured by init() — which sendMessage runs before the first turn —
    // and the OAuth fetch uses the global dispatcher it installs. A settings
    // page signs in before any turn, so run it here too, outside the
    // session's environment, or a configured client certificate would never
    // reach the OAuth endpoint.
    await runOutsideSdkContext(init)
    if (this.closed) {
      throw new Error('SDK session is closed')
    }
    if (options?.signal?.aborted || sessionSignal?.aborted) {
      throw new AuthenticationCancelledError()
    }

    // A newer call for this server replaces the attempt still pending. Each
    // attempt registers its own client, so one left running would exchange
    // its code with the newer one's client and fail after the user had
    // signed in — same rule as cli/print.ts mcp_authenticate.
    this.pendingMcpAuth.get(name)?.abort()
    const attempt = new AbortController()
    this.pendingMcpAuth.set(name, attempt)
    // The same rule across the host-facing method and the authenticate
    // pseudo-tool: attempts share one credential entry, so a sign-in
    // started either way replaces an attempt still pending for that entry.
    const releaseSharedSignIn = registerSdkSignIn(
      getSdkSignInEntryKeys(name, serverConfig),
      attempt,
    )
    const stopAttempt = () => attempt.abort()
    options?.signal?.addEventListener('abort', stopAttempt, { once: true })
    sessionSignal?.addEventListener('abort', stopAttempt, { once: true })
    if (sessionSignal?.aborted || options?.signal?.aborted) attempt.abort()

    // The namespace the flow's credentials belong to is the environment as
    // it is now — before another session's turn can change it while the
    // user is in the browser. The flow's exchange, the cache clear and the
    // reconnect all run back inside it. Called from a canUseTool callback
    // during a turn, this is that turn's environment, lent rather than
    // re-acquired: the turn holds the mutex the scope would otherwise wait
    // on. The scope's mutex wait is abortable by this attempt, so a cancel
    // or a session close while it waits ends the flow instead of holding
    // the mutex until another turn releases it. The turn is the one this
    // call started in, not whichever holds the field by now.
    const credentialScope = captureCredentialScope(
      () => entryCredentialScope ?? undefined,
      { signal: attempt.signal },
    )

    try {
      // A settings page signs in before the first turn; connect first so the
      // server list — and the tool pool the reconnect swaps into — exists.
      // An aborted sign-in stops waiting here, while the shared connect
      // keeps running for a first turn that may still need it.
      if (!(await this.ensureMcpConnectedForAuth(attempt.signal))) {
        if (this.closed) throw new Error('SDK session is closed')
        throw new AuthenticationCancelledError()
      }
      // Mirror cli/print.ts mcp_authenticate and the authenticate tool:
      // start the flow with skipBrowserOpen, capture the URL via
      // onAuthorizationUrl, let the callback complete in the background.
      // No race is needed here — the callback IS the URL delivery, and the
      // awaited promise IS the completion signal; a flow that completes
      // without a redirect simply never calls the callback.
      await performMCPOAuthFlow(
        name,
        serverConfig,
        url => options?.onAuthorizationUrl?.(url),
        attempt.signal,
        { skipBrowserOpen: true, credentialScope },
      )
      // Drop the 15-minute needs-auth memo, or the reconnect below would
      // hand it back, stored tokens or not — as the authenticate tool does.
      // In the namespace the flow began in, not whichever the process has
      // by now.
      await resumeIn(credentialScope, async () => clearMcpAuthCache())
      // The reconnect reads the tokens the flow just stored; read them
      // where the flow began, too. Its connect carries the attempt's signal,
      // so a cancel while it is stalled closes the transport instead of
      // waiting out the connection timeout — the scope above is released
      // with it, and the attempt rejects rather than hanging.
      const result = await resumeIn(credentialScope, () =>
        reconnectMcpServerImpl(name, config, attempt.signal),
      )

      // The attempt may have been cancelled or superseded while the
      // reconnect was pending, or the session closed: a cancelled attempt
      // must not install its result or resolve, and a closed session must
      // not report a successful status for a connection it will never use.
      // The reconnected client is released below unless another session
      // adopted it while the reconnect was in flight.
      if (this.closed || attempt.signal.aborted || this.pendingMcpAuth.get(name) !== attempt) {
        await this.releaseUnownedClient(name, config, result.client)
        if (this.closed) throw new Error('SDK session is closed')
        throw new AuthenticationCancelledError()
      }

      // Swap just this server in, as the CLI does (prefix-based replacement):
      // the reconnected tools replace the server's old ones — including the
      // authenticate pseudo-tool on success — and the client record is
      // replaced so the next turn's system:init reports the new status.
      // updateTools validates (and commits) before setMcpClients runs, so a
      // validation failure leaves both untouched — but the reconnected client
      // was never installed either, and close() only cleans up installed
      // clients, so a failed swap releases it here instead of leaving its
      // transport or subprocess behind.
      const prefix = getMcpPrefix(name)
      const permissionContext = this.appStateStore.getState().toolPermissionContext
      try {
        if (result.client.type === 'connected') {
          const nextTools = [
            ...this.mcpTools.filter(tool => !tool.name?.startsWith(prefix)),
            ...result.tools,
          ]
          this.engine.updateTools(assembleToolPool(permissionContext, nextTools))
          this.mcpTools = nextTools
        } else if (result.client.type === 'failed') {
          // The server's tools are stale — drop them. A server that still
          // needs auth keeps its authenticate tool (below), so the host or
          // the model can try again.
          const nextTools = this.mcpTools.filter(tool => !tool.name?.startsWith(prefix))
          this.engine.updateTools(assembleToolPool(permissionContext, nextTools))
          this.mcpTools = nextTools
        } else if (result.client.type === 'needs-auth') {
          // The server was connected before, so the pool still holds its
          // real tools — calls to them would fail, and nothing offers
          // recovery. Replace them with the session's authenticate tool, as
          // the initial connect does for a server that starts out
          // needs-auth. A pool that already holds only the authenticate
          // tool keeps it as it is.
          const authTool = createMcpAuthTool(name, config, {
            realToolsInCurrentContext: false,
            captureCredentialScope: signal =>
              captureCredentialScope(
                () => this.turnCredentialScope ?? undefined,
                signal ? { signal } : undefined,
              ),
            sessionSignal: this._abortController?.signal,
          })
          // Install the authenticate tool when the pool holds the server's
          // real tools — they are stale — or when it holds nothing for the
          // server at all: a first connection that failed, or an earlier
          // reconnect that failed, leaves no tool to offer the next turn.
          // A pool that already holds only the authenticate tool keeps it.
          if (
            !this.mcpTools.some(tool => tool.name === authTool.name) ||
            this.mcpTools.some(tool => tool.name?.startsWith(prefix) && tool.name !== authTool.name)
          ) {
            const nextTools = [
              ...this.mcpTools.filter(tool => !tool.name?.startsWith(prefix)),
              authTool,
            ]
            this.engine.updateTools(assembleToolPool(permissionContext, nextTools))
            this.mcpTools = nextTools
          }
        }
        const clients = this.engine.getMcpClients()
        this.engine.setMcpClients(
          clients.some(client => client.name === name)
            ? clients.map(client => (client.name === name ? result.client : client))
            : [...clients, result.client],
        )
      } catch (error) {
        if (result.client.type === 'connected') {
          // The reconnected client is cached by server key, and another
          // session may have adopted it while the reconnect was in flight.
          // Closing it here would close its transport and fail its
          // in-flight MCP calls. Only release a client the cache no longer
          // holds: one still cached is shared, or adoptable, and the next
          // connection reuses it instead of dialling again.
          if (!(await isClientCached(name, config, result.client))) {
            await result.client.cleanup().catch(() => {})
          }
        }
        throw error
      }
      return this.toMcpServerStatus(name, result)
    } finally {
      options?.signal?.removeEventListener('abort', stopAttempt)
      sessionSignal?.removeEventListener('abort', stopAttempt)
      releaseSharedSignIn()
      if (this.pendingMcpAuth.get(name) === attempt) this.pendingMcpAuth.delete(name)
    }
  }

  /**
   * Releases a reconnected client no session adopted. A cancelled attempt
   * leaves a connected client the cache holds but no session installed,
   * and its transport stays open until something clears the cache. A
   * client another caller adopted from the shared connect — or one this
   * session installed — is shared: closing it would fail that session's
   * in-flight MCP calls, so it stays cached for the next connection
   * instead. Cache membership alone is not adoption: the cache holds the
   * client this reconnect created whether or not anyone adopted it.
   */
  private async releaseUnownedClient(
    name: string,
    config: ScopedMcpServerConfig,
    client: MCPServerConnection,
  ): Promise<void> {
    if (client.type !== 'connected') return
    if (this.engine.getMcpClients().some(installed => installed === client)) return
    await releaseUnownedMcpClient(name, config, client)
  }

  /**
   * The reconnected server's status in the shape system:init reports it —
   * same fields cli/print.ts builds for mcp_status, minus the config, which
   * stays with the session. Tools are listed only once connected, with the
   * names the model sees.
   */
  private toMcpServerStatus(
    name: string,
    result: Awaited<ReturnType<typeof reconnectMcpServerImpl>>,
  ): McpServerStatus {
    return {
      name,
      status: result.client.type,
      serverInfo: result.client.type === 'connected' ? result.client.serverInfo : undefined,
      error: result.client.type === 'failed' ? result.client.error : undefined,
      tools:
        result.client.type === 'connected'
          ? result.tools.map(tool => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined,
    }
  }
}

// ============================================================================
// createEngineFromOptions
// ============================================================================

/**
 * Shared helper that builds a QueryEngine and its supporting state from
 * SDKSessionOptions. Used by both createSession and resumeSession.
 */
function createEngineFromOptions(
  options: SDKSessionOptions,
  permissionTarget: PermissionTarget & { pushTimeout?: (msg: SDKPermissionTimeoutMessage) => void },
  initialMessages?: Message[],
  sessionId?: string,
): { engine: QueryEngine; appStateStore: Store<AppState>; abortController: AbortController } {
  const {
    cwd,
    model,
    abortController,
    permissionMode,
    allowDangerouslySkipPermissions,
  } = options

  if (!cwd) {
    throw new Error('SDKSessionOptions requires cwd')
  }

  // NOTE: cwd is NOT set on global state here. SDKSessionImpl.sendMessage()
  // sets/restores it per-message via the cwd mutex to prevent concurrent
  // sessions from overwriting each other's working directory.

  // Build permission context
  const permissionContext = buildPermissionContext({
    cwd,
    permissionMode,
    allowDangerouslySkipPermissions,
    disallowedTools: options.disallowedTools,
  })

  // Create AppState store (minimal, headless)
  const initialAppState = getDefaultAppState()
  const stateWithPermissions = {
    ...initialAppState,
    toolPermissionContext: permissionContext,
  }
  if (model) {
    stateWithPermissions.mainLoopModel = model
    stateWithPermissions.mainLoopModelForSession = model
  }
  const appStateStore = createStore<AppState>(stateWithPermissions)

  // Build thinkingConfig from initial state
  // thinkingEnabled defaults to true via getDefaultAppState() -> shouldEnableThinkingByDefault()
  // Explicit false disables thinking, undefined defaults to enabled (adaptive mode)
  const thinkingEnabled = stateWithPermissions.thinkingEnabled ?? true
  const thinkingConfig = thinkingEnabled
    ? (stateWithPermissions.thinkingBudgetTokens
      ? { type: 'enabled' as const, budgetTokens: stateWithPermissions.thinkingBudgetTokens }
      : { type: 'adaptive' as const })
    : { type: 'disabled' as const }

  // Get tools filtered by permission context
  const tools = getTools(permissionContext)

  // Create file state cache
  const readFileCache = createFileStateCacheWithSizeLimit(100)

  // Build the canUseTool callback with external permission resolution support.
  // When no user canUseTool callback is provided, this creates a pending
  // prompt entry that respondToPermission() can resolve asynchronously.
  const defaultCanUseTool = createDefaultCanUseTool(permissionContext)
  const canUseTool = createExternalCanUseTool(
    options.canUseTool ?? undefined,
    defaultCanUseTool,
    permissionTarget,
    options.onPermissionRequest,
    (msg) => { permissionTarget.pushTimeout?.(msg) },
    30000, // Default timeout
    sessionId,
  )

  // Abort controller
  const ac = abortController ?? new AbortController()

  // Create QueryEngine config
  const engineConfig = {
    cwd,
    tools,
    commands: [] as Array<never>,
    mcpClients: [],
    agents: [],
    canUseTool,
    getAppState: () => appStateStore.getState(),
    setAppState: (f: (prev: AppState) => AppState) => appStateStore.setState(f),
    readFileCache,
    userSpecifiedModel: model,
    abortController: ac,
    thinkingConfig,
    ...(initialMessages ? { initialMessages } : {}),
  }

  const engine = new QueryEngine(engineConfig)

  return { engine, appStateStore, abortController: ac }
}

// ============================================================================
// V2 API Functions
// ============================================================================

/**
 * V2 API - UNSTABLE
 * Creates a persistent SDKSession wrapping a QueryEngine for multi-turn
 * conversations.
 *
 * @alpha
 *
 * @example
 * ```typescript
 * const session = unstable_v2_createSession({ cwd: '/my/project' })
 * for await (const msg of session.sendMessage('Hello!')) {
 *   console.log(msg)
 * }
 * // Continue the conversation:
 * for await (const msg of session.sendMessage('What did I just say?')) {
 *   console.log(msg)
 * }
 * ```
 */
export function unstable_v2_createSession(options: SDKSessionOptions): SDKSession {
  const sessionId = randomUUID()
  // Create SDKSessionImpl first (without engine) so we can pass its
  // pendingPermissionPrompts map to createEngineFromOptions for
  // external permission resolution support.
  const session = new SDKSessionImpl(null, sessionId, options, null)
  const { engine, appStateStore, abortController } = createEngineFromOptions(options, session, undefined, sessionId)
  // Wire the engine, store, and abort controller into the session
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)
  return session
}

/**
 * V2 API - UNSTABLE
 * Resume an existing session by ID. Loads the session's prior messages
 * from disk and passes them to the QueryEngine so the conversation
 * continues from where it left off.
 *
 * @alpha
 *
 * @param sessionId - UUID of the session to resume
 * @param options - Session options (cwd is required)
 * @returns SDKSession with prior conversation history loaded
 *
 * @example
 * ```typescript
 * const session = await unstable_v2_resumeSession(sessionId, { cwd: '/my/project' })
 * for await (const msg of session.sendMessage('Continue where we left off')) {
 *   console.log(msg)
 * }
 * ```
 */
export async function unstable_v2_resumeSession(
  sessionId: string,
  options: SDKSessionOptions,
): Promise<SDKSession> {
  assertValidSessionId(sessionId)

  // Load prior messages from JSONL with compact-aware chain building.
  // Matches CLI's loadTranscriptFile → buildConversationChain → removeExtraFields.
  const resolved = await resolveSessionFilePath(sessionId, options.cwd)
  let initialMessages: Message[] = []

  if (resolved) {
    const { size: fileSize } = await stat(resolved.filePath)
    let entries: JsonlEntry[]
    let preservedSegment: { headUuid: string; tailUuid: string; anchorUuid: string } | null = null
    let boundaryIndex = -1

    if (fileSize > SKIP_PRECOMPACT_THRESHOLD) {
      const scan = await readTranscriptForLoad(resolved.filePath, fileSize)
      entries = parseJsonlEntries(scan.postBoundaryBuf.toString('utf8'))
      const boundary = findLastCompactBoundary(entries)
      preservedSegment = boundary.preservedSegment
      boundaryIndex = boundary.index
    } else {
      entries = await readJSONLFile<JsonlEntry>(resolved.filePath)
      const boundary = findLastCompactBoundary(entries)
      preservedSegment = boundary.preservedSegment
      boundaryIndex = boundary.index
    }

    // Step 1: Index ALL non-sidechain entries by UUID (user, assistant, system, etc.)
    // CLI indexes all transcript-chain entries — we need system compact_boundary
    // entries for cases where anchorUuid === boundary.uuid
    type ChainEntry = JsonlEntry & { parentUuid?: string | null }
    const byUuid = new Map<string, ChainEntry>()
    for (const entry of entries) {
      if (entry.isSidechain) continue
      if (entry.uuid) byUuid.set(entry.uuid, entry as ChainEntry)
    }

    // Apply preserved segment relinks
    let preservedUuids = new Set<string>()
    if (preservedSegment) {
      preservedUuids = applyPreservedSegmentRelinks(byUuid, preservedSegment)
    }

    // Prune pre-boundary entries (keep preserved + post-boundary)
    if (boundaryIndex >= 0 && !preservedSegment) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      for (const uuid of byUuid.keys()) {
        if (!postBoundaryUuids.has(uuid)) byUuid.delete(uuid)
      }
    } else if (boundaryIndex >= 0 && preservedSegment && preservedUuids.size > 0) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      // Keep: preserved entries + anchor + post-boundary entries
      // The anchor is needed because preserved head.parentUuid = anchor after relink
      const anchorUuid = preservedSegment.anchorUuid
      for (const uuid of byUuid.keys()) {
        if (!preservedUuids.has(uuid) && !postBoundaryUuids.has(uuid) && uuid !== anchorUuid) {
          byUuid.delete(uuid)
        }
      }
    } else if (boundaryIndex >= 0 && preservedSegment && preservedUuids.size === 0) {
      const postBoundaryUuids = new Set<string>()
      for (const entry of entries.slice(boundaryIndex + 1)) {
        if (entry.uuid && !entry.isSidechain) postBoundaryUuids.add(entry.uuid)
      }
      for (const uuid of byUuid.keys()) {
        if (!postBoundaryUuids.has(uuid)) byUuid.delete(uuid)
      }
    }

    if (byUuid.size > 0) {
      const parentUuids = new Set<string>()
      for (const e of byUuid.values()) {
        if (e.parentUuid) parentUuids.add(e.parentUuid)
      }
      let leaf: ChainEntry | undefined
      let bestTs = -1
      for (const e of byUuid.values()) {
        // Step 2: Only user/assistant entries can be conversation leaves
        // System entries (compact_boundary, etc.) are part of the chain but not leaves
        if (e.type !== 'user' && e.type !== 'assistant') continue
        if (parentUuids.has(e.uuid!)) continue
        const ts = e.timestamp ? new Date(e.timestamp as string).getTime() : 0
        if (ts >= bestTs) { bestTs = ts; leaf = e }
      }
      if (leaf) {
        const chain = buildChain(byUuid, leaf)
        initialMessages = stripChainFields(chain) as Message[]
      } else {
        initialMessages = []
      }
    } else {
      initialMessages = []
    }
  } else {
    initialMessages = []
  }

  const session = new SDKSessionImpl(null, sessionId, options, null)
  const { engine, appStateStore, abortController } = createEngineFromOptions(
    options,
    session,
    initialMessages,
    sessionId,
  )
  session.setEngine(engine)
  session.setAppStateStore(appStateStore)
  session.setAbortController(abortController)

  // Store the resolved transcript directory for correct routing in sendMessage()
  // and set global state so tests and legacy code can verify the routing.
  if (resolved) {
    const transcriptDir = dirname(resolved.filePath)
    session.setSessionProjectDir(transcriptDir)
    switchSession(sessionId as SessionId, transcriptDir)
  }

  return session
}

// @[MODEL LAUNCH]: Update the example model ID in this docstring.
/**
 * V2 API - UNSTABLE
 * One-shot convenience: creates a session, sends a single prompt, collects
 * the SDKResultMessage, and returns it.
 *
 * @alpha
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   cwd: '/my/project',
 *   model: 'claude-sonnet-4-6',
 * })
 * console.log(result.result) // text output
 * ```
 */
export async function unstable_v2_prompt(
  message: string,
  options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  const session = unstable_v2_createSession(options)
  try {
    let resultMessage: SDKResultMessage | undefined

    for await (const msg of session.sendMessage(message)) {
      if (msg.type === 'result') {
        resultMessage = msg as SDKResultMessage
      }
    }

    if (!resultMessage) {
      throw new Error('unstable_v2_prompt: query completed without a result message')
    }

    return resultMessage
  } finally {
    session.close()
  }
}
