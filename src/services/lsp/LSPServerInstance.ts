import * as path from 'path'
import { pathToFileURL } from 'url'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import type { createLSPClient as createLSPClientType } from './LSPClient.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

/**
 * LSP error code for "content modified" - indicates the server's state changed
 * during request processing (e.g., rust-analyzer still indexing the project).
 * This is a transient error that can be retried.
 */
const LSP_ERROR_CONTENT_MODIFIED = -32801

/**
 * Maximum number of retries for transient LSP errors like "content modified".
 */
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3

/**
 * Base delay in milliseconds for exponential backoff on transient errors.
 * Actual delays: 500ms, 1000ms, 2000ms
 */
const RETRY_BASE_DELAY_MS = 500

const DEFAULT_LSP_STARTUP_TIMEOUT_MS = 30_000
/**
 * LSP server instance interface returned by createLSPServerInstance.
 * Manages the lifecycle of a single LSP server with state tracking and health monitoring.
 */
export type LSPServerInstance = {
  /** Unique server identifier */
  readonly name: string
  /** Server configuration */
  readonly config: ScopedLspServerConfig
  /** Current server state */
  readonly state: LspServerState
  /** When the server was last started */
  readonly startTime: Date | undefined
  /** Last error encountered */
  readonly lastError: Error | undefined
  /** Number of times restart() has been called */
  readonly restartCount: number
  /** Successful initialization generation for the current process lifecycle */
  readonly generation: number
  /** Whether automatic recovery has exhausted the configured failure budget */
  readonly isCrashRecoveryExhausted: boolean
  /** Start the server and initialize it */
  start(): Promise<void>
  /** Stop the server gracefully */
  stop(): Promise<void>
  /** Manually restart the server (stop then start) */
  restart(): Promise<void>
  /** Check if server is healthy and ready for requests */
  isHealthy(): boolean
  /** Send an LSP request to the server */
  sendRequest<T>(method: string, params: unknown): Promise<T>
  /** Send an LSP notification to the server (fire-and-forget) */
  sendNotification(method: string, params: unknown): Promise<void>
  /** Send an LSP notification and surface transport/write failure */
  sendNotificationStrict(method: string, params: unknown): Promise<void>
  /** Register a handler for LSP notifications */
  onNotification(method: string, handler: (params: unknown) => void): void
  /** Register a handler for LSP requests from the server */
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
}

export type LSPServerInstanceOptions = {
  createClient?: typeof createLSPClientType
  onUnavailable?: (generation: number) => void
  defaultStartupTimeoutMs?: number
}

/**
 * Creates and manages a single LSP server instance.
 *
 * Uses factory function pattern with closures for state encapsulation (avoiding classes).
 * Provides state tracking, health monitoring, and request forwarding for an LSP server.
 * Supports manual restart with configurable retry limits.
 *
 * State machine transitions:
 * - stopped → starting → running
 * - running → stopping → stopped
 * - any → error (on failure)
 * - error → starting (on retry)
 *
 * @param name - Unique identifier for this server instance
 * @param config - Server configuration including command, args, and limits
 * @returns LSP server instance with lifecycle management methods
 *
 * @example
 * const instance = createLSPServerInstance('my-server', config)
 * await instance.start()
 * const result = await instance.sendRequest('textDocument/definition', params)
 * await instance.stop()
 */
export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
  options: LSPServerInstanceOptions = {},
): LSPServerInstance {
  // Validate that unimplemented fields are not set
  if (config.restartOnCrash !== undefined) {
    throw new Error(
      `LSP server '${name}': restartOnCrash is not yet implemented. Remove this field from the configuration.`,
    )
  }
  if (config.shutdownTimeout !== undefined) {
    throw new Error(
      `LSP server '${name}': shutdownTimeout is not yet implemented. Remove this field from the configuration.`,
    )
  }

  // Private state encapsulated via closures. Lazy-require LSPClient so
  // vscode-jsonrpc (~129KB) only loads when an LSP server is actually
  // instantiated, not when the static import chain reaches this module.
  let createLSPClient = options.createClient
  if (!createLSPClient) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const clientModule = require('./LSPClient.js') as {
      createLSPClient: typeof createLSPClientType
    }
    createLSPClient = clientModule.createLSPClient
  }
  let state: LspServerState = 'stopped'
  const maxRestarts = config.maxRestarts ?? 3
  let startTime: Date | undefined
  let lastError: Error | undefined
  let restartCount = 0
  let automaticRecoveryFailureCount = 0
  let generation = 0
  let startEpoch = 0
  let startPromise: Promise<void> | undefined
  let stopPromise: Promise<void> | undefined
  let lastUnavailableGeneration: number | undefined
  const notifyUnavailable = (unavailableGeneration: number): void => {
    if (lastUnavailableGeneration === unavailableGeneration) return
    lastUnavailableGeneration = unavailableGeneration
    options.onUnavailable?.(unavailableGeneration)
  }

  // Automatic recovery is bounded across both startup failures and unexpected
  // transport loss. Successful lazy replacement does not reset this budget;
  // only an explicit restart does. Intentional stop/cancellation is excluded.
  const recordAutomaticRecoveryFailure = (error: unknown): void => {
    state = 'error'
    lastError =
      error instanceof Error ? error : new Error(errorMessage(error))
    automaticRecoveryFailureCount++
    notifyUnavailable(generation)
  }

  // Propagate crash state so ensureServerStarted can restart on next use.
  // Without this, state stays 'running' after crash and the server is never
  // restarted (zombie state).
  const client = createLSPClient(name, error => {
    startEpoch++
    recordAutomaticRecoveryFailure(error)
  })

  /**
   * Starts the LSP server and initializes it with workspace information.
   *
   * If the server is already running it returns immediately. Concurrent callers
   * while starting share and await the same initialization promise.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to start or initialize
   */
  function start(): Promise<void> {
    if (stopPromise) return stopPromise.catch(() => {}).then(start)
    if (state === 'running') return Promise.resolve()
    if (startPromise) return startPromise

    const epoch = ++startEpoch
    const pending = startInternal(epoch)
    startPromise = pending.finally(() => {
      startPromise = undefined
    })
    return startPromise
  }

  async function startInternal(epoch: number): Promise<void> {
    // Cap automatic recovery so a persistently crashing or unstartable server
    // doesn't spawn unbounded child processes on every incoming request.
    if (automaticRecoveryFailureCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max automatic recovery attempts (${maxRestarts})`,
      )
      lastError = error
      logError(error)
      throw error
    }

    let initPromise: Promise<unknown> | undefined
    try {
      state = 'starting'
      logForDebugging(`Starting LSP server instance: ${name}`)

      const startupTimeoutMs =
        config.startupTimeout ??
        options.defaultStartupTimeoutMs ??
        DEFAULT_LSP_STARTUP_TIMEOUT_MS

      // Start the client
      await withTimeout(
        client.start(config.command, config.args || [], {
          env: config.env,
          cwd: config.workspaceFolder,
        }),
        startupTimeoutMs,
        `LSP server '${name}' timed out after ${startupTimeoutMs}ms during process startup`,
      )
      if (epoch !== startEpoch) {
        throw new Error(`LSP server '${name}' start was cancelled`)
      }

      // Initialize with workspace info
      const workspaceFolder = config.workspaceFolder || getCwd()
      const workspaceUri = pathToFileURL(workspaceFolder).href

      const initParams: InitializeParams = {
        processId: process.pid,

        // Pass server-specific initialization options from plugin config
        // Required by vue-language-server, optional for others
        // Provide empty object as default to avoid undefined errors in servers
        // that expect this field to exist
        initializationOptions: config.initializationOptions ?? {},

        // Modern approach (LSP 3.16+) - required for Pyright, gopls
        workspaceFolders: [
          {
            uri: workspaceUri,
            name: path.basename(workspaceFolder),
          },
        ],

        // Deprecated fields - some servers still need these for proper URI resolution
        rootPath: workspaceFolder, // Deprecated in LSP 3.8 but needed by some servers
        rootUri: workspaceUri, // Deprecated in LSP 3.16 but needed by typescript-language-server for goToDefinition

        // Client capabilities - declare what features we support
        capabilities: {
          workspace: {
            // Don't claim to support workspace/configuration since we don't implement it
            // This prevents servers from requesting config we can't provide
            configuration: false,
            // Don't claim to support workspace folders changes since we don't handle
            // workspace/didChangeWorkspaceFolders notifications
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: {
                valueSet: [1, 2], // Unnecessary (1), Deprecated (2)
              },
              versionSupport: false,
              codeDescriptionSupport: true,
              dataSupport: false,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: {
              dynamicRegistration: false,
              linkSupport: true,
            },
            references: {
              dynamicRegistration: false,
            },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: {
              dynamicRegistration: false,
            },
          },
          general: {
            positionEncodings: ['utf-16'],
          },
        },
      }

      initPromise = client.initialize(initParams)
      await withTimeout(
        initPromise,
        startupTimeoutMs,
        `LSP server '${name}' timed out after ${startupTimeoutMs}ms during initialization`,
      )
      if (epoch !== startEpoch) {
        throw new Error(`LSP server '${name}' start was cancelled`)
      }
      if (state !== 'starting' || !client.isInitialized) {
        throw new Error(
          `LSP server '${name}' did not finish initialization in a healthy state`,
        )
      }

      generation++
      state = 'running'
      startTime = new Date()
      logForDebugging(`LSP server instance started: ${name}`)
    } catch (error) {
      // Clean up the spawned child process on timeout/error
      await client.stop({ force: true }).catch(() => {})
      // Prevent unhandled rejection from abandoned initialize promise
      initPromise?.catch(() => {})
      if (epoch === startEpoch) {
        recordAutomaticRecoveryFailure(error)
        logError(error)
      }
      throw error
    }
  }

  /**
   * Stops the LSP server gracefully.
   *
   * If already stopped or stopping, returns immediately.
   * On failure, sets state to 'error', logs for monitoring, and throws.
   *
   * @throws {Error} If server fails to stop
   */
  function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') {
      return stopPromise ?? Promise.resolve()
    }
    if (stopPromise) return stopPromise

    const pending = stopInternal()
    stopPromise = pending.finally(() => {
      stopPromise = undefined
    })
    return stopPromise
  }

  async function stopInternal(): Promise<void> {
    const stoppedGeneration = generation
    const force = state === 'starting'
    startEpoch++
    let stopError: unknown
    state = 'stopping'
    try {
      await client.stop({ force })
    } catch (error) {
      stopError = error
    }

    await startPromise?.catch(() => {})
    notifyUnavailable(stoppedGeneration)

    if (stopError) {
      state = 'error'
      lastError = stopError as Error
      logError(stopError)
      throw stopError
    }

    state = 'stopped'
    logForDebugging(`LSP server instance stopped: ${name}`)
  }

  /**
   * Manually restarts the server by stopping and starting it.
   *
   * Increments restartCount and enforces maxRestarts limit.
   * Note: This is NOT automatic - must be called explicitly.
   *
   * @throws {Error} If stop or start fails, or if restartCount exceeds config.maxRestarts (default: 3)
   */
  async function restart(): Promise<void> {
    try {
      await stop()
    } catch (error) {
      const stopError = new Error(
        `Failed to stop LSP server '${name}' during restart: ${errorMessage(error)}`,
      )
      logError(stopError)
      throw stopError
    }

    restartCount++

    if (restartCount > maxRestarts) {
      const error = new Error(
        `Max restart attempts (${maxRestarts}) exceeded for server '${name}'`,
      )
      logError(error)
      throw error
    }

    // A manual restart is the explicit operator action that resets the
    // automatic-recovery budget. Ordinary stop/start cleanup must not.
    automaticRecoveryFailureCount = 0

    try {
      await start()
    } catch (error) {
      const startError = new Error(
        `Failed to start LSP server '${name}' during restart (attempt ${restartCount}/${maxRestarts}): ${errorMessage(error)}`,
      )
      logError(startError)
      throw startError
    }
  }

  /**
   * Checks if the server is healthy and ready to handle requests.
   *
   * @returns true if state is 'running' AND the client has completed initialization
   */
  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  /**
   * Sends an LSP request to the server with retry logic for transient errors.
   *
   * Checks server health before sending and wraps errors with context.
   * Automatically retries on "content modified" errors (code -32801) which occur
   * when servers like rust-analyzer are still indexing. This is expected LSP behavior
   * and clients should retry silently per the LSP specification.
   *
   * @param method - LSP method name (e.g., 'textDocument/definition')
   * @param params - Method-specific parameters
   * @returns The server's response
   * @throws {Error} If server is not healthy or request fails after all retries
   */
  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`,
      )
      logError(error)
      throw error
    }

    const requestGeneration = generation
    let lastAttemptError: Error | undefined

    for (
      let attempt = 0;
      attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS;
      attempt++
    ) {
      if (generation !== requestGeneration || !isHealthy()) {
        throw new Error(
          `LSP request '${method}' aborted because server '${name}' changed generation or became unavailable`,
        )
      }
      try {
        const result = await client.sendRequest<T>(method, params)
        if (generation !== requestGeneration || !isHealthy()) {
          throw new Error(
            `LSP request '${method}' aborted because server '${name}' changed generation or became unavailable`,
          )
        }
        return result
      } catch (error) {
        lastAttemptError = error as Error

        // Check if this is a transient "content modified" error that we should retry
        // This commonly happens with rust-analyzer during initial project indexing.
        // We use duck typing instead of instanceof because there may be multiple
        // versions of vscode-jsonrpc in the dependency tree (8.2.0 vs 8.2.1).
        const errorCode = (error as { code?: number }).code
        const isContentModifiedError =
          typeof errorCode === 'number' &&
          errorCode === LSP_ERROR_CONTENT_MODIFIED

        if (
          isContentModifiedError &&
          attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS
        ) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          logForDebugging(
            `LSP request '${method}' to '${name}' got ContentModified error, ` +
              `retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES_FOR_TRANSIENT_ERRORS})…`,
          )
          await sleep(delay)
          continue
        }

        // Non-retryable error or max retries exceeded
        break
      }
    }

    // All retries failed or non-retryable error
    const requestError = new Error(
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? 'unknown error'}`,
    )
    logError(requestError)
    throw requestError
  }

  /**
   * Send a notification to the LSP server (fire-and-forget).
   * Used for file synchronization (didOpen, didChange, didClose).
   */
  async function sendNotification(
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      )
      logError(error)
      throw error
    }

    try {
      await client.sendNotification(method, params)
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      )
      logError(notificationError)
      throw notificationError
    }
  }

  /**
   * Send a notification while preserving transport/write failure for callers
   * whose local state depends on acceptance by the JSON-RPC writer.
   */
  async function sendNotificationStrict(
    method: string,
    params: unknown,
  ): Promise<void> {
    if (!isHealthy()) {
      const error = new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      )
      logError(error)
      throw error
    }

    try {
      await client.sendNotificationStrict(method, params)
    } catch (error) {
      const notificationError = new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      )
      logError(notificationError)
      throw notificationError
    }
  }

  /**
   * Registers a handler for LSP notifications from the server.
   *
   * @param method - LSP notification method (e.g., 'window/logMessage')
   * @param handler - Callback function to handle the notification
   */
  function onNotification(
    method: string,
    handler: (params: unknown) => void,
  ): void {
    client.onNotification(method, handler)
  }

  /**
   * Registers a handler for LSP requests from the server.
   *
   * Some LSP servers send requests TO the client (reverse direction).
   * This allows registering handlers for such requests.
   *
   * @param method - LSP request method (e.g., 'workspace/configuration')
   * @param handler - Callback function to handle the request and return a response
   */
  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    client.onRequest(method, handler)
  }

  // Return public API
  return {
    name,
    config,
    get state() {
      return state
    },
    get startTime() {
      return startTime
    },
    get lastError() {
      return lastError
    },
    get restartCount() {
      return restartCount
    },
    get generation() {
      return generation
    },
    get isCrashRecoveryExhausted() {
      return automaticRecoveryFailureCount > maxRestarts
    },
    start,
    stop,
    restart,
    isHealthy,
    sendRequest,
    sendNotification,
    sendNotificationStrict,
    onNotification,
    onRequest,
  }
}

/**
 * Race a promise against a timeout. Cleans up the timer regardless of outcome
 * to avoid unhandled rejections from orphaned setTimeout callbacks.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout((rej, msg) => rej(new Error(msg)), ms, reject, message)
  })
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timer!),
  )
}
