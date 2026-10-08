import * as path from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { withTimeout } from '../../utils/sleep.js'
import { getAllLspServers } from './config.js'
import {
  getLspDocumentIdentity,
  readLspDocumentContents,
  type LspDocumentIdentity,
} from './documentIdentity.js'
import { recordLSPDiagnosticFileActivity } from './LSPDiagnosticRegistry.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
  type LSPServerInstanceOptions,
} from './LSPServerInstance.js'
import type { ScopedLspServerConfig } from './types.js'

type OpenLspDocumentState = {
  serverName: string
  serverGeneration: number
  revision: number
  closeEpoch: number
  version: number
  fileUri: string
  activityPath: string
}

type PendingOpenLspDocumentState = Omit<
  OpenLspDocumentState,
  'revision' | 'closeEpoch'
>

export type LspGenerationRequestResult<T> = {
  result: T
  serverGeneration: number
  documentRevision: number
  documentCloseEpoch: number
}

export const LSP_SERVER_GENERATION_CHANGED = 'LSP_SERVER_GENERATION_CHANGED'
export const LSP_DOCUMENT_REVISION_CHANGED = 'LSP_DOCUMENT_REVISION_CHANGED'
export const LSP_DOCUMENT_CLOSED = 'LSP_DOCUMENT_CLOSED'

export function isLspServerGenerationChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === LSP_SERVER_GENERATION_CHANGED
  )
}

export function isLspDocumentRevisionChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === LSP_DOCUMENT_REVISION_CHANGED
  )
}

function generationChangedError(
  serverName: string,
  expectedGeneration: number,
  actualGeneration: number,
): Error & { code: typeof LSP_SERVER_GENERATION_CHANGED } {
  return Object.assign(
    new Error(
      `LSP server '${serverName}' changed generation from ${expectedGeneration} to ${actualGeneration}`,
    ),
    { code: LSP_SERVER_GENERATION_CHANGED },
  ) as Error & { code: typeof LSP_SERVER_GENERATION_CHANGED }
}

function documentRevisionChangedError(
  filePath: string,
  expectedRevision: number,
  actualRevision: number | undefined,
): Error & { code: typeof LSP_DOCUMENT_REVISION_CHANGED } {
  return Object.assign(
    new Error(
      `LSP document '${filePath}' changed document revision from ${expectedRevision} to ${actualRevision ?? 'closed'}`,
    ),
    { code: LSP_DOCUMENT_REVISION_CHANGED },
  ) as Error & { code: typeof LSP_DOCUMENT_REVISION_CHANGED }
}

function documentClosedError(
  filePath: string,
  expectedCloseEpoch: number,
  actualCloseEpoch: number,
): Error & { code: typeof LSP_DOCUMENT_CLOSED } {
  return Object.assign(
    new Error(
      `LSP document '${filePath}' was explicitly closed (close epoch changed from ${expectedCloseEpoch} to ${actualCloseEpoch})`,
    ),
    { code: LSP_DOCUMENT_CLOSED },
  ) as Error & { code: typeof LSP_DOCUMENT_CLOSED }
}

export type LspGenerationRequestOptions = {
  expectedGeneration?: number
  expectedDocumentRevision?: number
  expectedDocumentCloseEpoch?: number
}

export type LSPServerManagerDependencies = {
  loadServerConfigs: typeof getAllLspServers
  createServerInstance: (
    name: string,
    config: ScopedLspServerConfig,
    options: LSPServerInstanceOptions,
  ) => LSPServerInstance
  readDocument: (filePath: string) => Promise<string>
  recordFileActivity: (filePath: string) => void
  lifecycleNotificationTimeoutMs: number
}

const DEFAULT_LSP_LIFECYCLE_NOTIFICATION_TIMEOUT_MS = 2_000

const DEFAULT_DEPENDENCIES: LSPServerManagerDependencies = {
  loadServerConfigs: getAllLspServers,
  createServerInstance: (name, config, options) =>
    createLSPServerInstance(name, config, options),
  readDocument: readLspDocumentContents,
  recordFileActivity: recordLSPDiagnosticFileActivity,
  lifecycleNotificationTimeoutMs:
    DEFAULT_LSP_LIFECYCLE_NOTIFICATION_TIMEOUT_MS,
}

/**
 * LSP Server Manager interface returned by createLSPServerManager.
 * Manages multiple LSP server instances and routes requests based on file extensions.
 */
export type LSPServerManager = {
  /** Initialize the manager by loading all configured LSP servers */
  initialize(): Promise<void>
  /** Shutdown all running servers and clear state */
  shutdown(): Promise<void>
  /** Get the LSP server instance for a given file path */
  getServerForFile(filePath: string): LSPServerInstance | undefined
  /** Ensure the appropriate LSP server is started for the given file */
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  /** Send a request after synchronizing the document to the current server generation */
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  /** Send a request and report its server generation and document revision. */
  sendRequestWithGeneration<T>(
    filePath: string,
    method: string,
    params: unknown,
    options?: LspGenerationRequestOptions,
  ): Promise<LspGenerationRequestResult<T> | undefined>
  /** Get all running server instances */
  getAllServers(): Map<string, LSPServerInstance>
  /** Synchronize file open to LSP server (sends didOpen notification) */
  openFile(filePath: string, content: string): Promise<void>
  /** Synchronize file change to LSP server (sends didChange notification) */
  changeFile(filePath: string, content: string): Promise<void>
  /** Synchronize file save to LSP server (sends didSave notification) */
  saveFile(filePath: string): Promise<void>
  /** Synchronize file close to LSP server (sends didClose notification) */
  closeFile(filePath: string): Promise<void>
  /** Check if a file is open on its current compatible LSP server generation */
  isFileOpen(filePath: string): boolean
}

/**
 * Creates an LSP server manager instance.
 *
 * Server processes remain lazy-started. Document lifecycle operations are
 * serialized per canonical document key, while unrelated documents remain
 * independent after sharing any in-flight server initialization.
 */
export function createLSPServerManager(
  dependencyOverrides: Partial<LSPServerManagerDependencies> = {},
): LSPServerManager {
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencyOverrides,
    lifecycleNotificationTimeoutMs:
      dependencyOverrides.lifecycleNotificationTimeoutMs ??
      DEFAULT_LSP_LIFECYCLE_NOTIFICATION_TIMEOUT_MS,
  }
  const servers = new Map<string, LSPServerInstance>()
  const extensionMap = new Map<string, string[]>()
  const openedDocuments = new Map<string, OpenLspDocumentState>()
  const documentRevisions = new Map<string, number>()
  const documentCloseEpochs = new Map<string, number>()
  const documentOperations = new Map<string, Promise<void>>()
  let shuttingDown = false

  function invalidateServerDocuments(
    serverName: string,
    serverGeneration: number,
  ): void {
    for (const [documentKey, state] of openedDocuments) {
      if (
        state.serverName === serverName &&
        state.serverGeneration === serverGeneration
      ) {
        openedDocuments.delete(documentKey)
      }
    }
  }

  function getDocumentCloseEpoch(documentKey: string): number {
    return documentCloseEpochs.get(documentKey) ?? 0
  }

  function advanceDocumentRevision(documentKey: string): number {
    const revision = (documentRevisions.get(documentKey) ?? 0) + 1
    documentRevisions.set(documentKey, revision)
    return revision
  }

  async function withDocumentLock<T>(
    documentKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (shuttingDown) {
      throw new Error('LSP server manager is shutting down')
    }
    const previous = documentOperations.get(documentKey) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.catch(() => {}).then(() => gate)
    documentOperations.set(documentKey, tail)

    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (documentOperations.get(documentKey) === tail) {
        documentOperations.delete(documentKey)
      }
    }
  }

  function isCurrentDocumentState(
    state: OpenLspDocumentState | undefined,
    server: LSPServerInstance,
  ): state is OpenLspDocumentState {
    return (
      state !== undefined &&
      state.serverName === server.name &&
      state.serverGeneration === server.generation &&
      server.state === 'running'
    )
  }

  function getCurrentDocumentState(
    identity: LspDocumentIdentity,
    server: LSPServerInstance,
  ): OpenLspDocumentState | undefined {
    const state = openedDocuments.get(identity.stateKey)
    if (isCurrentDocumentState(state, server)) return state
    if (state) openedDocuments.delete(identity.stateKey)
    return undefined
  }

  function useDocumentUri(params: unknown, fileUri: string): unknown {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return params
    }
    const requestParams = params as Record<string, unknown>
    const textDocument = requestParams.textDocument
    if (
      !textDocument ||
      typeof textDocument !== 'object' ||
      Array.isArray(textDocument)
    ) {
      return params
    }
    return {
      ...requestParams,
      textDocument: {
        ...(textDocument as Record<string, unknown>),
        uri: fileUri,
      },
    }
  }

  async function notifyAndCommit(
    server: LSPServerInstance,
    identity: LspDocumentIdentity,
    description: string,
    method: string,
    params: unknown,
    nextState: (targetGeneration: number) => PendingOpenLspDocumentState,
  ): Promise<number> {
    const targetGeneration = server.generation
    try {
      await sendStrictLifecycleNotification(
        server,
        targetGeneration,
        method,
        params,
      )
    } catch (error) {
      openedDocuments.delete(identity.stateKey)
      const syncError = new Error(`${description}: ${errorMessage(error)}`)
      logError(syncError)
      throw syncError
    }

    if (
      server.state !== 'running' ||
      server.generation !== targetGeneration
    ) {
      openedDocuments.delete(identity.stateKey)
      const syncError = new Error(
        `${description}: LSP server generation changed during notification`,
      )
      logError(syncError)
      throw syncError
    }

    openedDocuments.set(identity.stateKey, {
      ...nextState(targetGeneration),
      revision: advanceDocumentRevision(identity.stateKey),
      closeEpoch: getDocumentCloseEpoch(identity.stateKey),
    })
    return targetGeneration
  }

  async function sendStrictLifecycleNotification(
    server: LSPServerInstance,
    targetGeneration: number,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      await withTimeout(
        server.sendNotificationStrict(method, params),
        dependencies.lifecycleNotificationTimeoutMs,
        `LSP lifecycle notification '${method}' timed out after ${dependencies.lifecycleNotificationTimeoutMs}ms`,
      )
    } catch (error) {
      if (server.generation === targetGeneration) {
        await server.stop().catch(stopError => {
          logForDebugging(
            `Failed to stop LSP server '${server.name}' after notification failure: ${errorMessage(stopError)}`,
          )
        })
      }
      throw error
    }
  }

  async function synchronizeOpenUnlocked(
    filePath: string,
    content: string,
    identity: LspDocumentIdentity,
    server: LSPServerInstance,
  ): Promise<void> {
    if (getCurrentDocumentState(identity, server)) {
      logForDebugging(
        `LSP: File already open, skipping didOpen for ${filePath}`,
      )
      return
    }

    const extension = path.extname(filePath).toLowerCase()
    const languageId =
      server.config.extensionToLanguage[extension] || 'plaintext'
    const targetGeneration = await notifyAndCommit(
      server,
      identity,
      `Failed to sync file open ${filePath}`,
      'textDocument/didOpen',
      {
        textDocument: {
          uri: identity.fileUri,
          languageId,
          version: 1,
          text: content,
        },
      },
      generation => ({
        serverName: server.name,
        serverGeneration: generation,
        version: 1,
        fileUri: identity.fileUri,
        activityPath: identity.activityPath,
      }),
    )
    logForDebugging(
      `LSP: Sent didOpen for ${filePath} (languageId: ${languageId}, generation: ${targetGeneration})`,
    )
  }

  /** Initialize the manager by loading configured server definitions. */
  async function initialize(): Promise<void> {
    shuttingDown = false
    let serverConfigs: Record<string, ScopedLspServerConfig>

    try {
      const result = await dependencies.loadServerConfigs()
      serverConfigs = result.servers
      logForDebugging(
        `[LSP SERVER MANAGER] getAllLspServers returned ${Object.keys(serverConfigs).length} server(s)`,
      )
    } catch (error) {
      const err = error as Error
      logError(
        new Error(`Failed to load LSP server configuration: ${err.message}`),
      )
      throw error
    }

    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        if (!config.command) {
          throw new Error(
            `Server ${serverName} missing required 'command' field`,
          )
        }
        if (
          !config.extensionToLanguage ||
          Object.keys(config.extensionToLanguage).length === 0
        ) {
          throw new Error(
            `Server ${serverName} missing required 'extensionToLanguage' field`,
          )
        }

        for (const extension of Object.keys(config.extensionToLanguage)) {
          const normalized = extension.toLowerCase()
          const serverNames = extensionMap.get(normalized) ?? []
          serverNames.push(serverName)
          extensionMap.set(normalized, serverNames)
        }

        const instance = dependencies.createServerInstance(
          serverName,
          config,
          {
            onUnavailable: generation =>
              invalidateServerDocuments(serverName, generation),
          },
        )
        servers.set(serverName, instance)

        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) => {
            logForDebugging(
              `LSP: Received workspace/configuration request from ${serverName}`,
            )
            return params.items.map(() => null)
          },
        )
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to initialize LSP server ${serverName}: ${err.message}`,
          ),
        )
      }
    }

    logForDebugging(`LSP manager initialized with ${servers.size} servers`)
  }

  /** Stop every server and clear manager-owned state. */
  async function shutdown(): Promise<void> {
    shuttingDown = true
    const operations = Array.from(documentOperations.values())
    const toStop = Array.from(servers.entries()).filter(
      ([, server]) => server.state !== 'stopped',
    )
    const results = await Promise.allSettled(
      toStop.map(([, server]) => server.stop()),
    )
    await Promise.allSettled(operations)

    servers.clear()
    extensionMap.clear()
    openedDocuments.clear()
    documentRevisions.clear()
    documentCloseEpochs.clear()
    documentOperations.clear()

    const errors = results
      .map((result, index) =>
        result.status === 'rejected'
          ? `${toStop[index]![0]}: ${errorMessage(result.reason)}`
          : null,
      )
      .filter((error): error is string => error !== null)

    if (errors.length > 0) {
      const shutdownError = new Error(
        `Failed to stop ${errors.length} LSP server(s): ${errors.join('; ')}`,
      )
      logError(shutdownError)
      throw shutdownError
    }
  }

  /** Return the first configured server for the file extension. */
  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const extension = path.extname(filePath).toLowerCase()
    const serverName = extensionMap.get(extension)?.[0]
    return serverName ? servers.get(serverName) : undefined
  }

  /** Lazily start or await the server selected for this file. */
  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    if (shuttingDown) {
      throw new Error('LSP server manager is shutting down')
    }
    const server = getServerForFile(filePath)
    if (!server) return undefined

    if (
      server.state === 'stopped' ||
      server.state === 'error' ||
      server.state === 'starting'
    ) {
      try {
        await server.start()
      } catch (error) {
        const err = error as Error
        logError(
          new Error(
            `Failed to start LSP server for file ${filePath}: ${err.message}`,
          ),
        )
        throw error
      }
    }

    if (shuttingDown) {
      throw new Error('LSP server manager is shutting down')
    }

    if (server.state !== 'running') {
      throw new Error(
        `LSP server '${server.name}' is not ready for file ${filePath}: server is ${server.state}`,
      )
    }

    return server
  }

  /** Synchronize under the document lock, then send without blocking later edits. */
  async function sendRequestWithGeneration<T>(
    filePath: string,
    method: string,
    params: unknown,
    options: LspGenerationRequestOptions = {},
  ): Promise<LspGenerationRequestResult<T> | undefined> {
    const identity = getLspDocumentIdentity(filePath)
    const requestCloseEpoch =
      options.expectedDocumentCloseEpoch ??
      getDocumentCloseEpoch(identity.stateKey)
    try {
      for (let generationRetry = 0; generationRetry <= 1; generationRetry++) {
        let server: LSPServerInstance | undefined
        let requestState: OpenLspDocumentState | undefined
        let requestGeneration = 0
        try {
          const context = await withDocumentLock(
            identity.stateKey,
            async () => {
              const currentDocumentCloseEpoch = getDocumentCloseEpoch(
                identity.stateKey,
              )
              if (
                currentDocumentCloseEpoch !== requestCloseEpoch
              ) {
                throw documentClosedError(
                  filePath,
                  requestCloseEpoch,
                  currentDocumentCloseEpoch,
                )
              }

              server = await ensureServerStarted(filePath)
              if (!server) return undefined
              requestGeneration = server.generation
              const expectedGeneration = options.expectedGeneration
              if (
                expectedGeneration !== undefined &&
                server.generation !== expectedGeneration
              ) {
                throw generationChangedError(
                  server.name,
                  expectedGeneration,
                  server.generation,
                )
              }

              if (!getCurrentDocumentState(identity, server)) {
                const content = await dependencies.readDocument(
                  identity.resolvedPath,
                )
                dependencies.recordFileActivity(identity.activityPath)
                await synchronizeOpenUnlocked(
                  filePath,
                  content,
                  identity,
                  server,
                )
              }

              const state = getCurrentDocumentState(identity, server)
              if (!state) {
                throw new Error(
                  `LSP document ${filePath} is not synchronized to server generation ${server.generation}`,
                )
              }
              requestGeneration = state.serverGeneration
              if (
                expectedGeneration !== undefined &&
                state.serverGeneration !== expectedGeneration
              ) {
                throw generationChangedError(
                  server.name,
                  expectedGeneration,
                  state.serverGeneration,
                )
              }
              const expectedDocumentRevision =
                options.expectedDocumentRevision
              if (
                expectedDocumentRevision !== undefined &&
                state.revision !== expectedDocumentRevision
              ) {
                throw documentRevisionChangedError(
                  filePath,
                  expectedDocumentRevision,
                  state.revision,
                )
              }
              requestState = state
              return { server, state }
            },
          )
          if (!context) return undefined

          const result = await context.server.sendRequest<T>(
            method,
            useDocumentUri(params, context.state.fileUri),
          )
          return await withDocumentLock(identity.stateKey, async () => {
            const currentDocumentCloseEpoch = getDocumentCloseEpoch(
              identity.stateKey,
            )
            if (currentDocumentCloseEpoch !== requestCloseEpoch) {
              throw documentClosedError(
                filePath,
                requestCloseEpoch,
                currentDocumentCloseEpoch,
              )
            }
            if (
              context.server.state !== 'running' ||
              context.server.generation !== context.state.serverGeneration
            ) {
              throw new Error(
                `LSP request '${method}' aborted because server '${context.server.name}' changed generation or became unavailable`,
              )
            }
            if (openedDocuments.get(identity.stateKey) !== context.state) {
              throw new Error(
                `LSP request '${method}' aborted because document ${filePath} changed while the request was pending`,
              )
            }
            return {
              result,
              serverGeneration: context.state.serverGeneration,
              documentRevision: context.state.revision,
              documentCloseEpoch: context.state.closeEpoch,
            }
          })
        } catch (error) {
          const currentDocumentCloseEpoch = getDocumentCloseEpoch(
            identity.stateKey,
          )
          if (currentDocumentCloseEpoch !== requestCloseEpoch) {
            throw documentClosedError(
              filePath,
              requestCloseEpoch,
              currentDocumentCloseEpoch,
            )
          }
          if (
            isLspServerGenerationChanged(error) ||
            isLspDocumentRevisionChanged(error)
          ) {
            throw error
          }
          if (
            server &&
            (server.generation !== requestGeneration ||
              server.state !== 'running')
          ) {
            if (openedDocuments.get(identity.stateKey) === requestState) {
              openedDocuments.delete(identity.stateKey)
            }
            if (options.expectedGeneration !== undefined) {
              throw generationChangedError(
                server.name,
                options.expectedGeneration,
                server.generation,
              )
            }
            if (generationRetry === 0) continue
          } else if (requestState) {
            const currentState = openedDocuments.get(identity.stateKey)
            if (
              options.expectedDocumentRevision !== undefined &&
              currentState !== requestState
            ) {
              throw documentRevisionChangedError(
                filePath,
                options.expectedDocumentRevision,
                currentState?.revision,
              )
            }
            if (
              currentState !== undefined &&
              currentState !== requestState &&
              options.expectedGeneration === undefined &&
              generationRetry === 0
            ) {
              continue
            }
          }
          throw error
        }
      }

      throw new Error(
        `LSP request failed for file ${filePath}: server generation or document state kept changing`,
      )
    } catch (error) {
      const err = error as Error
      logError(
        new Error(
          `LSP request failed for file ${filePath}, method '${method}': ${err.message}`,
        ),
      )
      throw error
    }
  }

  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    return (await sendRequestWithGeneration<T>(filePath, method, params))
      ?.result
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const identity = getLspDocumentIdentity(filePath)
    await withDocumentLock(identity.stateKey, async () => {
      const server = await ensureServerStarted(filePath)
      if (!server) return
      const state = getCurrentDocumentState(identity, server)
      dependencies.recordFileActivity(
        state?.activityPath ?? identity.activityPath,
      )
      await synchronizeOpenUnlocked(filePath, content, identity, server)
    })
  }

  async function changeFile(filePath: string, content: string): Promise<void> {
    const identity = getLspDocumentIdentity(filePath)
    await withDocumentLock(identity.stateKey, async () => {
      const server = await ensureServerStarted(filePath)
      if (!server) return

      const state = getCurrentDocumentState(identity, server)
      dependencies.recordFileActivity(
        state?.activityPath ?? identity.activityPath,
      )
      if (!state) {
        await synchronizeOpenUnlocked(filePath, content, identity, server)
        return
      }

      const nextVersion = state.version + 1
      await notifyAndCommit(
        server,
        identity,
        `Failed to sync file change ${filePath}`,
        'textDocument/didChange',
        {
          textDocument: {
            uri: state.fileUri,
            version: nextVersion,
          },
          contentChanges: [{ text: content }],
        },
        () => ({
          ...state,
          version: nextVersion,
        }),
      )
      logForDebugging(
        `LSP: Sent didChange for ${filePath} (version: ${nextVersion})`,
      )
    })
  }

  /** Send didSave after earlier same-document lifecycle operations settle. */
  async function saveFile(filePath: string): Promise<void> {
    const identity = getLspDocumentIdentity(filePath)
    await withDocumentLock(identity.stateKey, async () => {
      const server = getServerForFile(filePath)
      if (!server || server.state !== 'running') return
      const state = getCurrentDocumentState(identity, server)
      dependencies.recordFileActivity(
        state?.activityPath ?? identity.activityPath,
      )
      if (!state) return

      // Best-effort by design: didSave carries no version or content, so a
      // dropped notification cannot desynchronize the document version space.
      try {
        await withTimeout(
          server.sendNotification('textDocument/didSave', {
            textDocument: {
              uri: state.fileUri,
            },
          }),
          dependencies.lifecycleNotificationTimeoutMs,
          `LSP lifecycle notification 'textDocument/didSave' timed out after ${dependencies.lifecycleNotificationTimeoutMs}ms`,
        )
        logForDebugging(`LSP: Sent didSave for ${filePath}`)
      } catch (error) {
        logForDebugging(
          `LSP: Best-effort didSave failed for ${filePath}: ${errorMessage(error)}`,
        )
      }
    })
  }

  /** Close the current document lifecycle, forgetting local state on every outcome. */
  async function closeFile(filePath: string): Promise<void> {
    const identity = getLspDocumentIdentity(filePath)
    documentCloseEpochs.set(
      identity.stateKey,
      getDocumentCloseEpoch(identity.stateKey) + 1,
    )
    await withDocumentLock(identity.stateKey, async () => {
      const state = openedDocuments.get(identity.stateKey)
      if (!state) return
      openedDocuments.delete(identity.stateKey)

      const server = servers.get(state.serverName)
      if (
        !server ||
        server.state !== 'running' ||
        server.generation !== state.serverGeneration
      ) {
        return
      }

      try {
        await sendStrictLifecycleNotification(
          server,
          state.serverGeneration,
          'textDocument/didClose',
          {
            textDocument: { uri: state.fileUri },
          },
        )
        logForDebugging(`LSP: Sent didClose for ${filePath}`)
      } catch (error) {
        const syncError = new Error(
          `Failed to sync file close ${filePath}: ${errorMessage(error)}`,
        )
        logError(syncError)
        throw syncError
      }
    })
  }

  function isFileOpen(filePath: string): boolean {
    const identity = getLspDocumentIdentity(filePath)
    const state = openedDocuments.get(identity.stateKey)
    if (!state) return false
    const server = servers.get(state.serverName)
    if (server && isCurrentDocumentState(state, server)) return true
    openedDocuments.delete(identity.stateKey)
    return false
  }

  return {
    initialize,
    shutdown,
    getServerForFile,
    ensureServerStarted,
    sendRequest,
    sendRequestWithGeneration,
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
  }
}
