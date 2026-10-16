import { type ChildProcess, spawn } from 'child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  Trace,
} from 'vscode-jsonrpc/node.js'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
/**
 * LSP client interface.
 */
export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start: (
    command: string,
    args: string[],
    options?: {
      env?: Record<string, string>
      cwd?: string
    },
  ) => Promise<void>
  initialize: (params: InitializeParams) => Promise<InitializeResult>
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>
  sendNotification: (method: string, params: unknown) => Promise<void>
  sendNotificationStrict: (method: string, params: unknown) => Promise<void>
  onNotification: (method: string, handler: (params: unknown) => void) => void
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ) => void
  stop: (options?: { force?: boolean }) => Promise<void>
}

export type LSPClientDependencies = {
  spawnProcess: typeof spawn
  createConnection: typeof createMessageConnection
  gracefulShutdownTimeoutMs: number
}

const DEFAULT_DEPENDENCIES: LSPClientDependencies = {
  spawnProcess: spawn,
  createConnection: createMessageConnection,
  gracefulShutdownTimeoutMs: 2_000,
}

/**
 * Create an LSP client wrapper using vscode-jsonrpc.
 * Manages communication with an LSP server process via stdio.
 *
 * @param onCrash - Called when the active process or JSON-RPC connection becomes
 *   unavailable outside intentional shutdown. Allows the owner to propagate
 *   crash state so the server can be restarted on next use.
 */
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
  dependencyOverrides: Partial<LSPClientDependencies> = {},
): LSPClient {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  // State variables in closure
  let process: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let isInitialized = false
  let startFailed = false
  let startError: Error | undefined
  let isStopping = false // Track intentional shutdown to avoid spurious error logging
  let unavailableReported = false
  let stopPromise: Promise<void> | undefined
  let stopMode: 'graceful' | 'force' | undefined
  let forceCurrentStop: (() => void) | undefined
  let spawnWait:
    | { process: ChildProcess; reject: (error: Error) => void }
    | undefined
  // Retain handlers for the client lifetime so replacement connections receive them.
  const notificationHandlers: Array<{
    method: string
    handler: (params: unknown) => void
  }> = []
  const requestHandlers: Array<{
    method: string
    handler: (params: unknown) => unknown | Promise<unknown>
  }> = []

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`)
    }
  }

  function reportUnavailable(error: Error): void {
    if (isStopping || unavailableReported) return
    unavailableReported = true
    isInitialized = false
    capabilities = undefined
    startFailed = true
    startError = error
    const unavailableConnection = connection
    const unavailableProcess = process
    connection = undefined
    process = undefined
    disposeResources(unavailableConnection, unavailableProcess)
    onCrash?.(error)
  }

  function disposeResources(
    targetConnection: MessageConnection | undefined,
    targetProcess: ChildProcess | undefined,
  ): void {
    if (targetConnection) {
      try {
        targetConnection.dispose()
      } catch (error) {
        logForDebugging(
          `Connection disposal failed for ${serverName}: ${errorMessage(error)}`,
        )
      }
    }

    if (!targetProcess) return
    const activeSpawnWait = spawnWait
    const cancelledDuringSpawn = activeSpawnWait?.process === targetProcess
    if (cancelledDuringSpawn) {
      activeSpawnWait.reject(
        new Error(`LSP server ${serverName} start was cancelled during spawn`),
      )
    }
    targetProcess.removeAllListeners('error')
    targetProcess.removeAllListeners('exit')
    if (cancelledDuringSpawn) {
      // spawn() may report a real launch error after an immediate force-stop.
      // Keep a one-shot sink after detaching the cancelled start listener so
      // that late error cannot become an uncaught EventEmitter error.
      targetProcess.once('error', () => {})
    }
    targetProcess.stdin?.removeAllListeners('error')
    targetProcess.stderr?.removeAllListeners('data')
    try {
      targetProcess.kill()
    } catch (error) {
      logForDebugging(
        `Process kill failed for ${serverName} (may already be dead): ${errorMessage(error)}`,
      )
    }
  }

  async function sendNotificationStrict(
    method: string,
    params: unknown,
  ): Promise<void> {
    checkStartFailed()
    if (!connection) {
      throw new Error('LSP client not started')
    }

    try {
      await connection.sendNotification(method, params)
    } catch (error) {
      const notificationError = new Error(
        `LSP server ${serverName} notification ${method} failed: ${errorMessage(error)}`,
      )
      logError(notificationError)
      throw notificationError
    }
  }

  return {
    get capabilities(): ServerCapabilities | undefined {
      return capabilities
    },

    get isInitialized(): boolean {
      return isInitialized
    },

    async start(
      command: string,
      args: string[],
      options?: {
        env?: Record<string, string>
        cwd?: string
      },
    ): Promise<void> {
      if (stopPromise) await stopPromise.catch(() => {})

      // A crashed transport may leave handles behind even though its owner has
      // already marked the server unavailable. Detach those handles before a
      // replacement is installed so they cannot leak across generations.
      if (connection || process) {
        const staleConnection = connection
        const staleProcess = process
        connection = undefined
        process = undefined
        disposeResources(staleConnection, staleProcess)
      }

      try {
        unavailableReported = false
        startFailed = false
        startError = undefined
        isInitialized = false
        capabilities = undefined

        // 1. Spawn LSP server process
        const spawnedProcess = dependencies.spawnProcess(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...subprocessEnv(), ...options?.env },
          cwd: options?.cwd,
          // Prevent visible console window on Windows (no-op on other platforms)
          windowsHide: true,
        })
        process = spawnedProcess

        if (!spawnedProcess.stdout || !spawnedProcess.stdin) {
          throw new Error('LSP server process stdio not available')
        }

        // 1.5. Wait for process to successfully spawn before using streams
        // This is CRITICAL: spawn() returns immediately, but the 'error' event
        // (e.g., ENOENT for command not found) fires asynchronously.
        // If we use the streams before confirming spawn succeeded, we get
        // unhandled promise rejections when writes fail on invalid streams.
        await new Promise<void>((resolve, reject) => {
          const resolveWait = (): void => {
            cleanup()
            resolve()
          }
          const rejectWait = (error: Error): void => {
            cleanup()
            reject(error)
          }
          const cleanup = (): void => {
            spawnedProcess.removeListener('spawn', resolveWait)
            spawnedProcess.removeListener('error', rejectWait)
            if (spawnWait?.process === spawnedProcess) spawnWait = undefined
          }
          spawnWait = { process: spawnedProcess, reject: rejectWait }
          spawnedProcess.once('spawn', resolveWait)
          spawnedProcess.once('error', rejectWait)
        })

        // Capture stderr for server diagnostics and errors
        if (spawnedProcess.stderr) {
          spawnedProcess.stderr.on('data', (data: Buffer) => {
            const output = data.toString().trim()
            if (output) {
              logForDebugging(`[LSP SERVER ${serverName}] ${output}`)
            }
          })
        }

        // Handle process errors (after successful spawn, e.g., crash during operation)
        spawnedProcess.on('error', error => {
          if (process !== spawnedProcess || isStopping) return
          reportUnavailable(error)
          logError(
            new Error(
              `LSP server ${serverName} failed to start: ${error.message}`,
            ),
          )
        })

        spawnedProcess.on('exit', (code, signal) => {
          if (process !== spawnedProcess || isStopping) return
          const exitDetail =
            code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`
          const crashError = new Error(
            `LSP server ${serverName} exited unexpectedly with ${exitDetail}`,
          )
          logError(crashError)
          reportUnavailable(crashError)
        })

        // Handle stdin stream errors to prevent unhandled promise rejections
        // when the LSP server process exits before we finish writing
        spawnedProcess.stdin.on('error', (error: Error) => {
          if (process === spawnedProcess && !isStopping) {
            logForDebugging(
              `LSP server ${serverName} stdin error: ${error.message}`,
            )
          }
          // Error is logged but not thrown - the connection error handler will catch this
        })

        // 2. Create JSON-RPC connection
        const reader = new StreamMessageReader(spawnedProcess.stdout)
        const writer = new StreamMessageWriter(spawnedProcess.stdin)
        const startedConnection = dependencies.createConnection(reader, writer)
        connection = startedConnection

        // 2.5. Register error/close handlers BEFORE listen() to catch all errors
        // This prevents unhandled promise rejections when the server crashes or closes unexpectedly
        startedConnection.onError(([error, _message, _code]) => {
          if (connection !== startedConnection || isStopping) return
          reportUnavailable(error)
          logError(
            new Error(
              `LSP server ${serverName} connection error: ${error.message}`,
            ),
          )
        })

        startedConnection.onClose(() => {
          if (connection !== startedConnection || isStopping) return
          // Only treat as error if not intentionally stopping
          const closeError = new Error(
            `LSP server ${serverName} connection closed unexpectedly`,
          )
          logForDebugging(closeError.message)
          reportUnavailable(closeError)
        })

        // 3. Start listening for messages
        startedConnection.listen()

        // 3.5. Enable protocol tracing for debugging
        // Note: trace() sends a $/setTrace notification which can fail if the server
        // process has already exited. We catch and log the error rather than letting
        // it become an unhandled promise rejection.
        startedConnection
          .trace(Trace.Verbose, {
            log: (message: string) => {
              logForDebugging(`[LSP PROTOCOL ${serverName}] ${message}`)
            },
          })
          .catch((error: Error) => {
            logForDebugging(
              `Failed to enable tracing for ${serverName}: ${error.message}`,
            )
          })

        // 4. Apply all retained notification handlers to this connection
        for (const { method, handler } of notificationHandlers) {
          startedConnection.onNotification(method, handler)
          logForDebugging(
            `Applied notification handler for ${serverName}.${method}`,
          )
        }

        // 5. Apply all retained request handlers to this connection
        for (const { method, handler } of requestHandlers) {
          startedConnection.onRequest(method, handler)
          logForDebugging(
            `Applied request handler for ${serverName}.${method}`,
          )
        }

        logForDebugging(`LSP client started for ${serverName}`)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(`LSP server ${serverName} failed to start: ${err.message}`),
        )
        throw error
      }
    },

    async initialize(params: InitializeParams): Promise<InitializeResult> {
      checkStartFailed()
      if (!connection) {
        throw new Error('LSP client not started')
      }
      const initializingConnection = connection

      try {
        const result: InitializeResult = await initializingConnection.sendRequest(
          'initialize',
          params,
        )
        checkStartFailed()
        if (connection !== initializingConnection) {
          throw new Error(
            `LSP server ${serverName} connection changed during initialization`,
          )
        }

        // Send initialized notification
        await initializingConnection.sendNotification('initialized', {})
        checkStartFailed()

        if (connection !== initializingConnection) {
          throw new Error(
            `LSP server ${serverName} connection changed during initialization`,
          )
        }

        capabilities = result.capabilities
        isInitialized = true
        logForDebugging(`LSP server ${serverName} initialized`)

        return result
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} initialize failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

    async sendRequest<TResult>(
      method: string,
      params: unknown,
    ): Promise<TResult> {
      checkStartFailed()
      if (!connection) {
        throw new Error('LSP client not started')
      }

      if (!isInitialized) {
        throw new Error('LSP server not initialized')
      }

      try {
        return await connection.sendRequest(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} request ${method} failed: ${err.message}`,
          ),
        )
        throw error
      }
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      checkStartFailed()
      if (!connection) {
        throw new Error('LSP client not started')
      }

      try {
        await connection.sendNotification(method, params)
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `LSP server ${serverName} notification ${method} failed: ${err.message}`,
          ),
        )
        // Don't re-throw for notifications - they're fire-and-forget
        logForDebugging(`Notification ${method} failed but continuing`)
      }
    },

    sendNotificationStrict,

    onNotification(method: string, handler: (params: unknown) => void): void {
      notificationHandlers.push({ method, handler })
      if (!connection) {
        logForDebugging(
          `Queued notification handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onNotification(method, handler)
    },

    onRequest<TParams, TResult>(
      method: string,
      handler: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      requestHandlers.push({
        method,
        handler: handler as (params: unknown) => unknown | Promise<unknown>,
      })
      if (!connection) {
        logForDebugging(
          `Queued request handler for ${serverName}.${method} (connection not ready)`,
        )
        return
      }

      checkStartFailed()

      connection.onRequest(method, handler)
    },

    stop(options?: { force?: boolean }): Promise<void> {
      const force = options?.force === true
      if (stopPromise) {
        if (force && stopMode === 'graceful') {
          stopMode = 'force'
          forceCurrentStop?.()
        }
        return stopPromise
      }

      const stoppingConnection = connection
      const stoppingProcess = process
      let requestForce!: () => void
      const forceRequested = new Promise<void>(resolve => {
        requestForce = resolve
      })
      stopMode = force ? 'force' : 'graceful'
      forceCurrentStop = requestForce
      const pending = (async () => {
        let shutdownError: Error | undefined

        // Mark as stopping to prevent error handlers from logging spurious errors
        isStopping = true

        try {
          if (stoppingConnection && !force) {
            let timeout: ReturnType<typeof setTimeout> | undefined
            const gracefulExchange = (async () => {
              await stoppingConnection.sendRequest('shutdown', {})
              await stoppingConnection.sendNotification('exit', {})
              return 'completed' as const
            })()
            const timedOut = new Promise<'timed-out'>(resolve => {
              timeout = setTimeout(
                () => resolve('timed-out'),
                dependencies.gracefulShutdownTimeoutMs,
              )
            })
            const forced = forceRequested.then(() => 'forced' as const)

            let outcome: 'completed' | 'timed-out' | 'forced'
            try {
              outcome = await Promise.race([
                gracefulExchange,
                timedOut,
                forced,
              ])
            } finally {
              if (timeout) clearTimeout(timeout)
            }
            if (outcome === 'timed-out') {
              logForDebugging(
                `LSP server ${serverName} graceful shutdown timed out after ${dependencies.gracefulShutdownTimeoutMs}ms`,
              )
            }
          }
        } catch (error) {
          const err = error as Error
          logError(
            new Error(`LSP server ${serverName} stop failed: ${err.message}`),
          )
          shutdownError = err
          // Continue to cleanup despite shutdown failure
        } finally {
          // Always cleanup the resources captured for this stop attempt.
          if (connection === stoppingConnection) connection = undefined
          if (process === stoppingProcess) process = undefined
          disposeResources(stoppingConnection, stoppingProcess)

          if (!connection) {
            isInitialized = false
            capabilities = undefined
          }
          isStopping = false // Reset for potential restart
          // Don't reset startFailed - preserve error state for diagnostics
          if (shutdownError) {
            startFailed = true
            startError = shutdownError
          }

          logForDebugging(`LSP client stopped for ${serverName}`)
        }

        // Re-throw shutdown error after cleanup is complete
        if (shutdownError) throw shutdownError
      })()

      stopPromise = pending.finally(() => {
        stopPromise = undefined
        stopMode = undefined
        forceCurrentStop = undefined
      })
      return stopPromise
    },
  }
}
