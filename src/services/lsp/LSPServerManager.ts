import * as path from 'node:path'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
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
  version: number
  fileUri: string
  activityPath: string
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
}

const DEFAULT_DEPENDENCIES: LSPServerManagerDependencies = {
  loadServerConfigs: getAllLspServers,
  createServerInstance: (name, config, options) =>
    createLSPServerInstance(name, config, options),
  readDocument: readLspDocumentContents,
  recordFileActivity: recordLSPDiagnosticFileActivity,
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
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const servers = new Map<string, LSPServerInstance>()
  const extensionMap = new Map<string, string[]>()
  const openedDocuments = new Map<string, OpenLspDocumentState>()
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
    const targetGeneration = server.generation

    try {
      await server.sendNotificationStrict('textDocument/didOpen', {
        textDocument: {
          uri: identity.fileUri,
          languageId,
          version: 1,
          text: content,
        },
      })
    } catch (error) {
      openedDocuments.delete(identity.stateKey)
      const syncError = new Error(
        `Failed to sync file open ${filePath}: ${errorMessage(error)}`,
      )
      logError(syncError)
      throw syncError
    }

    if (
      server.state !== 'running' ||
      server.generation !== targetGeneration
    ) {
      openedDocuments.delete(identity.stateKey)
      const syncError = new Error(
        `Failed to sync file open ${filePath}: LSP server generation changed during notification`,
      )
      logError(syncError)
      throw syncError
    }

    openedDocuments.set(identity.stateKey, {
      serverName: server.name,
      serverGeneration: targetGeneration,
      version: 1,
      fileUri: identity.fileUri,
      activityPath: identity.activityPath,
    })
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

  /** Synchronize the current generation, then send the request under the document lock. */
  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const identity = getLspDocumentIdentity(filePath)
    return withDocumentLock(identity.stateKey, async () => {
      try {
        for (let generationRetry = 0; generationRetry <= 1; generationRetry++) {
          const server = await ensureServerStarted(filePath)
          if (!server) return undefined

          if (!getCurrentDocumentState(identity, server)) {
            const content = await dependencies.readDocument(identity.resolvedPath)
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

          try {
            return await server.sendRequest<T>(
              method,
              useDocumentUri(params, state.fileUri),
            )
          } catch (error) {
            const generationChanged =
              server.generation !== state.serverGeneration ||
              server.state !== 'running'
            if (generationChanged && generationRetry === 0) {
              openedDocuments.delete(identity.stateKey)
              continue
            }
            throw error
          }
        }

        throw new Error(
          `LSP request failed for file ${filePath}: server generation kept changing`,
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
    })
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
      const targetGeneration = server.generation
      try {
        await server.sendNotificationStrict('textDocument/didChange', {
          textDocument: {
            uri: state.fileUri,
            version: nextVersion,
          },
          contentChanges: [{ text: content }],
        })
      } catch (error) {
        openedDocuments.delete(identity.stateKey)
        const syncError = new Error(
          `Failed to sync file change ${filePath}: ${errorMessage(error)}`,
        )
        logError(syncError)
        throw syncError
      }

      if (
        server.state !== 'running' ||
        server.generation !== targetGeneration
      ) {
        openedDocuments.delete(identity.stateKey)
        const syncError = new Error(
          `Failed to sync file change ${filePath}: LSP server generation changed during notification`,
        )
        logError(syncError)
        throw syncError
      }

      openedDocuments.set(identity.stateKey, {
        ...state,
        version: nextVersion,
      })
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
      if (!state) return
      dependencies.recordFileActivity(state.activityPath)

      // Best-effort by design: didSave carries no version or content, so a
      // dropped notification cannot desynchronize the document version space.
      await server.sendNotification('textDocument/didSave', {
        textDocument: {
          uri: state.fileUri,
        },
      })
      logForDebugging(`LSP: Sent didSave for ${filePath}`)
    })
  }

  /** Close the current document lifecycle, forgetting local state on every outcome. */
  async function closeFile(filePath: string): Promise<void> {
    const identity = getLspDocumentIdentity(filePath)
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
        await server.sendNotificationStrict('textDocument/didClose', {
          textDocument: { uri: state.fileUri },
        })
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
    getAllServers,
    openFile,
    changeFile,
    saveFile,
    closeFile,
    isFileOpen,
  }
}
