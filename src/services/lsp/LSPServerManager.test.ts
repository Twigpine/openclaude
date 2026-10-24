import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, jest, mock, test } from 'bun:test'
import type { ChildProcess } from 'child_process'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import {
  getLspDocumentIdentity,
  LspDocumentTooLargeError,
  MAX_LSP_FILE_SIZE_BYTES,
  readLspDocumentContents,
} from './documentIdentity.js'
import {
  createLSPClient,
  type LSPClientDependencies,
} from './LSPClient.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
  type LSPServerInstanceOptions,
} from './LSPServerInstance.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

const TYPESCRIPT_CONFIG: ScopedLspServerConfig = {
  command: 'unused-typescript-lsp',
  extensionToLanguage: {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
  },
  scope: 'project',
  source: 'test',
}

const PYTHON_CONFIG: ScopedLspServerConfig = {
  command: 'unused-python-lsp',
  extensionToLanguage: { '.py': 'python' },
  scope: 'project',
  source: 'test',
}

const managers: LSPServerManager[] = []

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.shutdown()))
})

type ServerEvent =
  | {
      kind: 'notification'
      generation: number
      method: string
      params: unknown
      strict: boolean
    }
  | {
      kind: 'request'
      generation: number
      method: string
      params: unknown
    }

type FakeServerControl = {
  server: LSPServerInstance
  events: ServerEvent[]
  startCalls: ReturnType<typeof mock>
  stopCalls: ReturnType<typeof mock>
  blockNextNotification(method: string): {
    started: Promise<void>
    release(): void
  }
  blockNextRequest(method: string, error?: Error): {
    started: Promise<void>
    release(): void
  }
  holdNextRequest<TResult>(method: string, result: TResult): {
    started: Promise<void>
    release(): void
  }
  failNextNotification(method: string, error?: Error): void
  holdNextStart(): { started: Promise<void>; release(): void }
  waitForStartCalls(count: number): Promise<void>
  simulateCrash(notifyManager?: boolean): void
  replaceGeneration(): void
  setCrashRecoveryExhausted(exhausted: boolean): void
}

function createFakeServer(
  name: string,
  config: ScopedLspServerConfig,
  options: LSPServerInstanceOptions = {},
): FakeServerControl {
  let state: LspServerState = 'stopped'
  let generation = 0
  let startEpoch = 0
  let startPromise: Promise<void> | undefined
  let nextStartGate:
    | { startedResolve: () => void; wait: Promise<void>; release: () => void }
    | undefined
  let notificationGate:
    | {
        method: string
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined
  let notificationFailure: { method: string; error: Error } | undefined
  let requestGate:
    | {
        method: string
        result?: unknown
        error?: Error
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined
  let startInvocationCount = 0
  let crashRecoveryExhausted = false
  const startWaiters: Array<{ count: number; resolve: () => void }> = []
  const events: ServerEvent[] = []

  const startCalls = mock(async () => {
    startInvocationCount++
    for (const waiter of startWaiters) {
      if (startInvocationCount >= waiter.count) waiter.resolve()
    }
    if (state === 'running') return
    if (startPromise) return startPromise
    state = 'starting'
    const epoch = startEpoch
    const pending = (async () => {
      nextStartGate?.startedResolve()
      if (nextStartGate) {
        await nextStartGate.wait
        nextStartGate = undefined
      }
      if (epoch !== startEpoch) return
      generation++
      state = 'running'
    })()
    startPromise = pending.finally(() => {
      startPromise = undefined
    })
    return startPromise
  })

  const stopCalls = mock(async () => {
    const stoppedGeneration = generation
    startEpoch++
    state = 'stopped'
    nextStartGate?.release()
    nextStartGate = undefined
    options.onUnavailable?.(stoppedGeneration)
  })

  const server: LSPServerInstance = {
    name,
    config,
    get state() {
      return state
    },
    get generation() {
      return generation
    },
    get startTime() {
      return undefined
    },
    get lastError() {
      return undefined
    },
    get restartCount() {
      return 0
    },
    get isCrashRecoveryExhausted() {
      return crashRecoveryExhausted
    },
    start: startCalls,
    stop: stopCalls,
    async restart() {
      await server.stop()
      await server.start()
    },
    isHealthy() {
      return state === 'running'
    },
    async sendRequest<TResult>(method: string, params: unknown) {
      events.push({ kind: 'request', generation, method, params })
      if (requestGate?.method === method) {
        const gate = requestGate
        gate.startedResolve()
        await gate.wait
        requestGate = undefined
        if (gate.error) throw gate.error
        return gate.result as TResult
      }
      return null as TResult
    },
    async sendNotification(method: string, params: unknown) {
      events.push({
        kind: 'notification',
        generation,
        method,
        params,
        strict: false,
      })
    },
    async sendNotificationStrict(method: string, params: unknown) {
      events.push({
        kind: 'notification',
        generation,
        method,
        params,
        strict: true,
      })
      if (notificationGate?.method === method) {
        notificationGate.startedResolve()
        await notificationGate.wait
        notificationGate = undefined
      }
      if (notificationFailure?.method === method) {
        const error = notificationFailure.error
        notificationFailure = undefined
        throw error
      }
    },
    onNotification() {},
    onRequest() {},
  }

  return {
    server,
    events,
    startCalls,
    stopCalls,
    blockNextNotification(method) {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      notificationGate = { method, startedResolve, wait, release }
      return { started, release }
    },
    blockNextRequest(method, error = new Error('request interrupted')) {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      requestGate = { method, error, startedResolve, wait, release }
      return { started, release }
    },
    holdNextRequest(method, result) {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      requestGate = { method, result, startedResolve, wait, release }
      return { started, release }
    },
    failNextNotification(method, error = new Error('transport rejected')) {
      notificationFailure = { method, error }
    },
    holdNextStart() {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      nextStartGate = { startedResolve, wait, release }
      return { started, release }
    },
    waitForStartCalls(count) {
      if (startInvocationCount >= count) return Promise.resolve()
      return new Promise<void>(resolve => {
        startWaiters.push({ count, resolve })
      })
    },
    simulateCrash(notifyManager = true) {
      const crashedGeneration = generation
      state = 'error'
      if (notifyManager) options.onUnavailable?.(crashedGeneration)
    },
    replaceGeneration() {
      generation++
      state = 'running'
    },
    setCrashRecoveryExhausted(exhausted) {
      crashRecoveryExhausted = exhausted
    },
  }
}

async function createManager(options?: {
  configs?: Record<string, ScopedLspServerConfig>
  readDocument?: (filePath: string) => Promise<string>
  recordFileActivity?: (filePath: string) => void
  lifecycleNotificationTimeoutMs?: number
}): Promise<{
  manager: LSPServerManager
  controls: Map<string, FakeServerControl>
}> {
  const configs = options?.configs ?? { typescript: TYPESCRIPT_CONFIG }
  const controls = new Map<string, FakeServerControl>()
  const manager = createLSPServerManager({
    loadServerConfigs: async () => ({ servers: configs }),
    createServerInstance: (name, config, instanceOptions) => {
      const control = createFakeServer(name, config, instanceOptions)
      controls.set(name, control)
      return control.server
    },
    readDocument: options?.readDocument ?? (async () => 'current contents'),
    recordFileActivity: options?.recordFileActivity ?? (() => {}),
    lifecycleNotificationTimeoutMs:
      options?.lifecycleNotificationTimeoutMs,
  })
  await manager.initialize()
  managers.push(manager)
  return { manager, controls }
}

type IntegratedConnectionEvent = {
  kind: 'notification' | 'request'
  method: string
  params: unknown
}

type IntegratedTransport = {
  child: ChildProcess
  connection: MessageConnection
  events: IntegratedConnectionEvent[]
  emitConnectionError(error: Error): void
  emitConnectionClose(): void
}

function createIntegratedTransport(): IntegratedTransport {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: mock(() => true),
  })
  queueMicrotask(() => child.emit('spawn'))

  const events: IntegratedConnectionEvent[] = []
  let errorHandler: ((error: [Error, unknown, number]) => void) | undefined
  let closeHandler: (() => void) | undefined
  const connection = {
    listen: mock(() => {}),
    trace: mock(async () => {}),
    onError: mock((handler: (error: [Error, unknown, number]) => void) => {
      errorHandler = handler
    }),
    onClose: mock((handler: () => void) => {
      closeHandler = handler
    }),
    onNotification: mock(() => {}),
    onRequest: mock(() => {}),
    sendRequest: mock(async (method: string, params: unknown) => {
      events.push({ kind: 'request', method, params })
      return method === 'initialize' ? { capabilities: {} } : null
    }),
    sendNotification: mock(async (method: string, params: unknown) => {
      events.push({ kind: 'notification', method, params })
    }),
    dispose: mock(() => {}),
  } as unknown as MessageConnection

  return {
    child,
    connection,
    events,
    emitConnectionError(error) {
      errorHandler?.([error, undefined, 0])
    },
    emitConnectionClose() {
      closeHandler?.()
    },
  }
}

function documentVersions(
  events: ServerEvent[],
  uri: string,
): Array<{ method: string; version: number }> {
  return events.flatMap(event => {
    if (event.kind !== 'notification') return []
    const params = event.params as {
      textDocument?: { uri?: string; version?: number }
    }
    if (params.textDocument?.uri !== uri) return []
    const version = params.textDocument.version
    return typeof version === 'number'
      ? [{ method: event.method, version }]
      : []
  })
}

describe('LSP document versions', () => {
  test('increments changes monotonically and independently per document', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const first = '/repo/src/first.ts'
    const second = '/repo/src/second.tsx'

    await manager.openFile(first, 'one')
    await manager.changeFile(first, 'two')
    await manager.changeFile(first, 'three')
    await manager.openFile(second, 'alpha')
    await manager.changeFile(second, 'beta')

    expect(
      documentVersions(server.events, getLspDocumentIdentity(first).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
      { method: 'textDocument/didChange', version: 3 },
    ])
    expect(
      documentVersions(server.events, getLspDocumentIdentity(second).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
    ])
  })

  test('close and reopen starts a new lifecycle at version one', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/reopen.ts'

    await manager.openFile(file, 'one')
    await manager.changeFile(file, 'two')
    await manager.closeFile(file)
    await manager.openFile(file, 'three')

    expect(
      server.events
        .filter(event => event.kind === 'notification')
        .map(event => ({
          method: event.method,
          version: (event.params as { textDocument?: { version?: number } })
            .textDocument?.version,
        })),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
      { method: 'textDocument/didClose', version: undefined },
      { method: 'textDocument/didOpen', version: 1 },
    ])
  })
})

describe('LSP lifecycle notification failures', () => {
  test('generation replacement during open leaves no committed state', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/open-generation-change.ts'
    const gate = server.blockNextNotification('textDocument/didOpen')

    const open = manager.openFile(file, 'one')
    await gate.started
    server.replaceGeneration()
    gate.release()

    await expect(open).rejects.toThrow('generation changed')
    expect(manager.isFileOpen(file)).toBe(false)

    await manager.changeFile(file, 'two')
    expect(manager.isFileOpen(file)).toBe(true)
    expect(
      documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didOpen', version: 1 },
    ])
  })

  test('generation replacement during change forces a version-one reopen', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/change-generation-change.ts'

    await manager.openFile(file, 'one')
    const gate = server.blockNextNotification('textDocument/didChange')
    const change = manager.changeFile(file, 'two')
    await gate.started
    server.replaceGeneration()
    gate.release()

    await expect(change).rejects.toThrow('generation changed')
    expect(manager.isFileOpen(file)).toBe(false)

    await manager.changeFile(file, 'three')
    expect(manager.isFileOpen(file)).toBe(true)
    expect(
      documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
      { method: 'textDocument/didOpen', version: 1 },
    ])
  })

  test('failed open creates no state and a later open retries', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/open-failure.ts'
    server.failNextNotification('textDocument/didOpen')

    await expect(manager.openFile(file, 'one')).rejects.toThrow(
      'Failed to sync file open',
    )
    expect(manager.isFileOpen(file)).toBe(false)

    await manager.openFile(file, 'two')
    expect(manager.isFileOpen(file)).toBe(true)
    expect(
      documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didOpen', version: 1 },
    ])
  })

  test('failed change invalidates state and the next request performs a full open', async () => {
    const readDocument = mock(async () => 'latest complete contents')
    const { manager, controls } = await createManager({ readDocument })
    const server = controls.get('typescript')!
    const file = '/repo/src/change-failure.ts'

    await manager.openFile(file, 'one')
    server.failNextNotification('textDocument/didChange')
    await expect(manager.changeFile(file, 'two')).rejects.toThrow(
      'Failed to sync file change',
    )
    expect(server.stopCalls).toHaveBeenCalledTimes(1)
    expect(manager.isFileOpen(file)).toBe(false)
    await manager.saveFile(file)
    expect(
      server.events.some(
        event =>
          event.kind === 'notification' &&
          event.method === 'textDocument/didSave',
      ),
    ).toBe(false)

    await manager.sendRequest(file, 'textDocument/hover', {})

    expect(readDocument).toHaveBeenCalledTimes(1)
    expect(
      documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
      { method: 'textDocument/didOpen', version: 1 },
    ])
    expect(server.events.at(-1)?.kind).toBe('request')
  })

  test('failed close removes local state and allows a version-one reopen', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/close-failure.ts'

    await manager.openFile(file, 'one')
    server.failNextNotification('textDocument/didClose')
    await expect(manager.closeFile(file)).rejects.toThrow(
      'Failed to sync file close',
    )
    expect(manager.isFileOpen(file)).toBe(false)

    await manager.openFile(file, 'two')
    expect(
      documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
    ).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didOpen', version: 1 },
    ])
  })

  test('bounds shutdown while a lifecycle notification is stuck', async () => {
    jest.useFakeTimers()
    const { manager, controls } = await createManager({
      lifecycleNotificationTimeoutMs: 5,
    })
    const server = controls.get('typescript')!
    const gate = server.blockNextNotification('textDocument/didOpen')
    const open = manager.openFile('/repo/src/stuck-open.ts', 'contents')
    await gate.started
    const shutdown = manager.shutdown()

    try {
      jest.advanceTimersByTime(5)
      await expect(shutdown).resolves.toBeUndefined()
      await expect(open).rejects.toThrow('timed out after 5ms')
    } finally {
      gate.release()
      jest.runAllTimers()
      jest.useRealTimers()
      await Promise.allSettled([open, shutdown])
    }
  })

  test('a stale lifecycle timeout does not stop the replacement generation', async () => {
    jest.useFakeTimers()
    const { manager, controls } = await createManager({
      lifecycleNotificationTimeoutMs: 5,
    })
    const server = controls.get('typescript')!
    const gate = server.blockNextNotification('textDocument/didOpen')
    const open = manager.openFile('/repo/src/stale-open.ts', 'contents')
    await gate.started
    server.replaceGeneration()

    try {
      jest.advanceTimersByTime(5)
      await expect(open).rejects.toThrow('timed out after 5ms')
      expect(server.server.state).toBe('running')
      expect(server.server.generation).toBe(2)
      expect(server.stopCalls).not.toHaveBeenCalled()
    } finally {
      gate.release()
      jest.runAllTimers()
      jest.useRealTimers()
      await open.catch(() => {})
    }
  })
})

describe('LSP generation resynchronization', () => {
  test('recognizes request-context changes without throwing on non-object errors', async () => {
    const {
      isLspDocumentRevisionChanged,
      isLspServerGenerationChanged,
      LSP_DOCUMENT_REVISION_CHANGED,
      LSP_SERVER_GENERATION_CHANGED,
    } = await import('./LSPServerManager.js')

    for (const value of [null, undefined, 'context changed']) {
      expect(isLspServerGenerationChanged(value)).toBe(false)
      expect(isLspDocumentRevisionChanged(value)).toBe(false)
    }
    expect(
      isLspServerGenerationChanged({ code: LSP_SERVER_GENERATION_CHANGED }),
    ).toBe(true)
    expect(
      isLspDocumentRevisionChanged({ code: LSP_DOCUMENT_REVISION_CHANGED }),
    ).toBe(true)
  })

  test('generation-bound requests reject instead of replaying opaque params', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/generation-bound.ts'

    await manager.openFile(file, 'one')
    const gate = server.blockNextRequest('callHierarchy/incomingCalls')
    const request = manager.sendRequestWithGeneration(
      file,
      'callHierarchy/incomingCalls',
      { item: { data: { generation: 1 } } },
      { expectedGeneration: 1 },
    )
    await gate.started
    server.replaceGeneration()
    gate.release()

    await expect(request).rejects.toMatchObject({
      code: 'LSP_SERVER_GENERATION_CHANGED',
    })
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(1)
  })

  test('opens current contents on a replacement generation before the request', async () => {
    const readDocument = mock(async () => 'contents after crash')
    const { manager, controls } = await createManager({ readDocument })
    const server = controls.get('typescript')!
    const file = '/repo/src/restart.ts'

    await manager.openFile(file, 'before crash')
    server.simulateCrash(false)
    expect(manager.isFileOpen(file)).toBe(false)

    await manager.sendRequest(file, 'textDocument/definition', {})

    expect(server.server.generation).toBe(2)
    expect(readDocument).toHaveBeenCalledTimes(1)
    expect(server.events.slice(-2).map(event => event.kind)).toEqual([
      'notification',
      'request',
    ])
    const reopen = server.events.at(-2)
    expect(reopen).toMatchObject({
      kind: 'notification',
      generation: 2,
      method: 'textDocument/didOpen',
      params: { textDocument: { version: 1, text: 'contents after crash' } },
    })
  })

  test('generation mismatch is sufficient even when prior cleanup did not run', async () => {
    const { manager, controls } = await createManager({
      readDocument: async () => 'replacement contents',
    })
    const server = controls.get('typescript')!
    const file = '/repo/src/generation.ts'

    await manager.openFile(file, 'old')
    server.replaceGeneration()
    await manager.sendRequest(file, 'textDocument/hover', {})

    expect(server.events.slice(-2)).toMatchObject([
      {
        kind: 'notification',
        generation: 2,
        method: 'textDocument/didOpen',
        params: { textDocument: { version: 1, text: 'replacement contents' } },
      },
      { kind: 'request', generation: 2, method: 'textDocument/hover' },
    ])
  })

  test('resynchronizes before retrying a request interrupted by a generation change', async () => {
    const { manager, controls } = await createManager({
      readDocument: async () => 'replacement contents',
    })
    const server = controls.get('typescript')!
    const file = '/repo/src/retry-generation.ts'
    const uri = getLspDocumentIdentity(file).fileUri

    await manager.openFile(file, 'old contents')
    const gate = server.blockNextRequest(
      'textDocument/hover',
      new Error('generation changed'),
    )
    const request = manager.sendRequest(file, 'textDocument/hover', {
      textDocument: { uri },
    })
    await gate.started
    server.replaceGeneration()
    gate.release()

    await expect(request).resolves.toBeNull()
    expect(server.events.slice(-3)).toMatchObject([
      { kind: 'request', generation: 1, method: 'textDocument/hover' },
      {
        kind: 'notification',
        generation: 2,
        method: 'textDocument/didOpen',
      },
      { kind: 'request', generation: 2, method: 'textDocument/hover' },
    ])
  })

  test('stopping one server clears only that server generation documents', async () => {
    const { manager, controls } = await createManager({
      configs: { typescript: TYPESCRIPT_CONFIG, python: PYTHON_CONFIG },
    })
    const tsFile = '/repo/src/file.ts'
    const pyFile = '/repo/src/file.py'

    await manager.openFile(tsFile, 'const value = 1')
    await manager.openFile(pyFile, 'value = 1')
    await controls.get('typescript')!.server.stop()

    expect(manager.isFileOpen(tsFile)).toBe(false)
    expect(manager.isFileOpen(pyFile)).toBe(true)
  })
})

describe('LSP transport recovery integration', () => {
  const scenarios: Array<{
    name: string
    terminate(transport: IntegratedTransport): void
  }> = [
    {
      name: 'JSON-RPC error',
      terminate: transport =>
        transport.emitConnectionError(new Error('connection failed')),
    },
    {
      name: 'JSON-RPC close',
      terminate: transport => transport.emitConnectionClose(),
    },
    {
      name: 'child-process error',
      terminate: transport =>
        transport.child.emit('error', new Error('process transport error')),
    },
    {
      name: 'clean child exit',
      terminate: transport => transport.child.emit('exit', 0, null),
    },
    {
      name: 'signal child exit',
      terminate: transport =>
        transport.child.emit('exit', null, 'SIGTERM'),
    },
    {
      name: 'nonzero child exit',
      terminate: transport => transport.child.emit('exit', 1, null),
    },
  ]

  for (const scenario of scenarios) {
    test(`${scenario.name} recreates the full stack and opens current contents`, async () => {
      const transports: IntegratedTransport[] = []
      let currentContent = 'before termination'
      const manager = createLSPServerManager({
        loadServerConfigs: async () => ({
          servers: { typescript: TYPESCRIPT_CONFIG },
        }),
        createServerInstance: (name, config, instanceOptions) =>
          createLSPServerInstance(name, config, {
            ...instanceOptions,
            createClient: (clientName, onCrash) =>
              createLSPClient(clientName, onCrash, {
                spawnProcess: (() => {
                  const transport = createIntegratedTransport()
                  transports.push(transport)
                  return transport.child
                }) as LSPClientDependencies['spawnProcess'],
                createConnection: () => transports.at(-1)!.connection,
                gracefulShutdownTimeoutMs: 5,
              }),
          }),
        readDocument: async () => currentContent,
        recordFileActivity: () => {},
      })
      await manager.initialize()

      try {
        const file = '/repo/src/integration.ts'
        await manager.openFile(file, currentContent)
        const server = manager.getServerForFile(file)!
        expect(server.generation).toBe(1)

        scenario.terminate(transports[0]!)
        expect(server.state).toBe('error')
        currentContent = 'after termination'

        await manager.sendRequest(file, 'textDocument/hover', {
          textDocument: { uri: 'stale-uri' },
          position: { line: 0, character: 0 },
        })

        expect(server.generation).toBe(2)
        expect(transports).toHaveLength(2)
        const replacementEvents = transports[1]!.events
        const openIndex = replacementEvents.findIndex(
          event =>
            event.kind === 'notification' &&
            event.method === 'textDocument/didOpen',
        )
        const requestIndex = replacementEvents.findIndex(
          event =>
            event.kind === 'request' && event.method === 'textDocument/hover',
        )
        expect(openIndex).toBeGreaterThan(-1)
        expect(requestIndex).toBeGreaterThan(openIndex)
        expect(replacementEvents[openIndex]!.params).toMatchObject({
          textDocument: {
            uri: getLspDocumentIdentity(file).fileUri,
            version: 1,
            text: 'after termination',
          },
        })
      } finally {
        await manager.shutdown()
      }
    })
  }
})

describe('LSP request concurrency', () => {
  test('two simultaneous first requests send one open before either request', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const gate = server.blockNextNotification('textDocument/didOpen')
    const file = '/repo/src/concurrent.ts'

    const first = manager.sendRequest(file, 'textDocument/hover', { request: 1 })
    await gate.started
    const second = manager.sendRequest(file, 'textDocument/definition', {
      request: 2,
    })

    expect(server.events.filter(event => event.kind === 'request')).toHaveLength(0)
    expect(
      server.events.filter(
        event =>
          event.kind === 'notification' &&
          event.method === 'textDocument/didOpen',
      ),
    ).toHaveLength(1)

    gate.release()
    await Promise.all([first, second])

    expect(
      server.events.filter(
        event =>
          event.kind === 'notification' &&
          event.method === 'textDocument/didOpen',
      ),
    ).toHaveLength(1)
    expect(server.events.filter(event => event.kind === 'request')).toHaveLength(2)
  })

  test('delivers document changes while a stale request is still pending', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/pending-request.ts'
    await manager.openFile(file, 'before')
    const gate = server.holdNextRequest('textDocument/hover', 'stale response')
    const request = manager.sendRequest<string>(file, 'textDocument/hover', {})
    await gate.started

    const changeGate = server.blockNextNotification('textDocument/didChange')
    const change = manager.changeFile(file, 'after')
    await changeGate.started

    try {
      expect(
        server.events.filter(event => event.kind === 'request'),
      ).toHaveLength(1)
      changeGate.release()
      await change
      expect(
        documentVersions(server.events, getLspDocumentIdentity(file).fileUri),
      ).toEqual([
        { method: 'textDocument/didOpen', version: 1 },
        { method: 'textDocument/didChange', version: 2 },
      ])
    } finally {
      gate.release()
    }

    await expect(request).resolves.toBeNull()
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(2)
  })

  test('waits for a queued didChange before publishing a response', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/change-before-response.ts'
    await manager.openFile(file, 'before')
    const requestGate = server.holdNextRequest(
      'textDocument/hover',
      'stale response',
    )
    const request = manager.sendRequest<string>(file, 'textDocument/hover', {})
    await requestGate.started

    const changeGate = server.blockNextNotification('textDocument/didChange')
    const change = manager.changeFile(file, 'after')
    await changeGate.started

    try {
      requestGate.release()
      const outcome = await Promise.race([
        request.then(() => 'settled' as const),
        new Promise<'pending'>(resolve =>
          setTimeout(() => resolve('pending'), 20),
        ),
      ])
      expect(outcome).toBe('pending')
    } finally {
      changeGate.release()
      await Promise.allSettled([change, request])
    }

    await expect(change).resolves.toBeUndefined()
    await expect(request).resolves.toBeNull()
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(2)
  })

  test('does not replay a pending request after close and reopen', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/closed-pending-request.ts'
    const fileUri = getLspDocumentIdentity(file).fileUri
    await manager.openFile(file, 'before close')
    const gate = server.holdNextRequest('textDocument/hover', 'stale response')
    const request = manager.sendRequest<string>(file, 'textDocument/hover', {})
    await gate.started

    await manager.closeFile(file)
    expect(manager.isFileOpen(file)).toBe(false)
    await manager.openFile(file, 'after reopen')
    expect(manager.isFileOpen(file)).toBe(true)
    expect(
      server.events.map(event => ({ kind: event.kind, method: event.method })),
    ).toEqual([
      { kind: 'notification', method: 'textDocument/didOpen' },
      { kind: 'request', method: 'textDocument/hover' },
      { kind: 'notification', method: 'textDocument/didClose' },
      { kind: 'notification', method: 'textDocument/didOpen' },
    ])

    gate.release()
    await expect(request).rejects.toMatchObject({
      code: 'LSP_DOCUMENT_CLOSED',
    })
    expect(manager.isFileOpen(file)).toBe(true)
    expect(
      documentVersions(server.events, fileUri).filter(
        event => event.method === 'textDocument/didOpen',
      ),
    ).toHaveLength(2)
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(1)
  })

  test('does not retry a closed document after its server generation changes', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/closed-before-replacement.ts'
    const fileUri = getLspDocumentIdentity(file).fileUri
    await manager.openFile(file, 'before close')
    const gate = server.holdNextRequest('textDocument/hover', 'stale response')
    const request = manager.sendRequest<string>(file, 'textDocument/hover', {})
    await gate.started

    await manager.closeFile(file)
    server.replaceGeneration()
    gate.release()

    await expect(request).rejects.toMatchObject({
      code: 'LSP_DOCUMENT_CLOSED',
    })
    expect(manager.isFileOpen(file)).toBe(false)
    expect(documentVersions(server.events, fileUri)).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
    ])
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(1)
  })

  test('does not recover a request after close is queued behind didChange', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/close-queued-behind-change.ts'
    const fileUri = getLspDocumentIdentity(file).fileUri
    await manager.openFile(file, 'before')
    const requestGate = server.blockNextRequest('textDocument/hover')
    const request = manager.sendRequest(file, 'textDocument/hover', {})
    const requestOutcome = request.then(
      result => ({ status: 'resolved' as const, result }),
      error => ({ status: 'rejected' as const, error }),
    )
    await requestGate.started

    const changeGate = server.blockNextNotification('textDocument/didChange')
    const change = manager.changeFile(file, 'after')
    const changeOutcome = change.then(
      () => undefined,
      error => error,
    )
    await changeGate.started
    const close = manager.closeFile(file)

    server.replaceGeneration()
    requestGate.release()
    changeGate.release()
    await expect(changeOutcome).resolves.toBeInstanceOf(Error)
    await expect(close).resolves.toBeUndefined()

    expect(await requestOutcome).toMatchObject({ status: 'rejected' })
    expect(manager.isFileOpen(file)).toBe(false)
    expect(documentVersions(server.events, fileUri)).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
    ])
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(1)
  })

  test('does not recover after close interrupts the initial didOpen', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/close-during-initial-open.ts'
    const gate = server.blockNextNotification('textDocument/didOpen')
    const request = manager.sendRequest(file, 'textDocument/hover', {})
    await gate.started
    const close = manager.closeFile(file)
    server.simulateCrash(false)
    gate.release()

    await expect(request).rejects.toMatchObject({
      code: 'LSP_DOCUMENT_CLOSED',
    })
    await expect(close).resolves.toBeUndefined()
    expect(manager.isFileOpen(file)).toBe(false)
    expect(
      server.events.filter(
        event =>
          event.kind === 'notification' &&
          event.method === 'textDocument/didOpen',
      ),
    ).toHaveLength(1)
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(0)
  })

  test('generation-bound requests also require the prepared document revision', async () => {
    const { manager } = await createManager()
    const file = '/repo/src/revision-bound.ts'
    await manager.openFile(file, 'version one')

    const prepared = await manager.sendRequestWithGeneration<unknown>(
      file,
      'textDocument/prepareCallHierarchy',
      {},
    )
    expect(prepared).toBeDefined()
    await manager.changeFile(file, 'version two')

    await expect(
      manager.sendRequestWithGeneration(
        file,
        'callHierarchy/incomingCalls',
        { item: { data: 'version one' } },
        {
          expectedGeneration: prepared!.serverGeneration,
          expectedDocumentRevision: prepared!.documentRevision,
        },
      ),
    ).rejects.toThrow('changed document revision')
  })

  test('generation-bound requests preserve an explicit close as terminal', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const file = '/repo/src/closed-call-hierarchy.ts'
    const fileUri = getLspDocumentIdentity(file).fileUri
    await manager.openFile(file, 'version one')

    const prepared = await manager.sendRequestWithGeneration<unknown>(
      file,
      'textDocument/prepareCallHierarchy',
      {},
    )
    expect(prepared).toBeDefined()
    await manager.closeFile(file)

    await expect(
      manager.sendRequestWithGeneration(
        file,
        'callHierarchy/incomingCalls',
        { item: { data: 'version one' } },
        {
          expectedGeneration: prepared!.serverGeneration,
          expectedDocumentRevision: prepared!.documentRevision,
          expectedDocumentCloseEpoch: prepared!.documentCloseEpoch,
        },
      ),
    ).rejects.toMatchObject({ code: 'LSP_DOCUMENT_CLOSED' })
    expect(
      documentVersions(server.events, fileUri).filter(
        event => event.method === 'textDocument/didOpen',
      ),
    ).toHaveLength(1)
    expect(
      server.events.filter(event => event.kind === 'request'),
    ).toHaveLength(1)
  })

  test('different documents await one shared lazy server initialization', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const gate = server.holdNextStart()

    const first = manager.sendRequest('/repo/src/one.ts', 'textDocument/hover', {})
    await gate.started
    const second = manager.sendRequest(
      '/repo/src/two.tsx',
      'textDocument/definition',
      {},
    )
    await server.waitForStartCalls(2)

    expect(server.startCalls).toHaveBeenCalledTimes(2)
    expect(server.events).toHaveLength(0)

    gate.release()
    await Promise.all([first, second])

    expect(server.server.generation).toBe(1)
    expect(server.events.filter(event => event.kind === 'request')).toHaveLength(2)
  })

  test('shutdown stops a starting server and rejects its in-flight request', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const gate = server.holdNextStart()
    const requestOutcome = manager
      .sendRequest('/repo/src/shutdown.ts', 'textDocument/hover', {})
      .then(
        () => undefined,
        error => error,
      )

    await gate.started
    try {
      await manager.shutdown()
      expect(server.stopCalls).toHaveBeenCalledTimes(1)
      expect(await requestOutcome).toBeInstanceOf(Error)
      expect(server.server.state).toBe('stopped')
      expect(manager.getAllServers().size).toBe(0)
    } finally {
      gate.release()
      await requestOutcome
    }
  })
})

describe('LSP document identity and diagnostics activity', () => {
  test('keeps POSIX document identity canonical and case-sensitive', () => {
    if (process.platform === 'win32') return

    const mixedCase = getLspDocumentIdentity('/repo/Source File.ts')
    const lowerCase = getLspDocumentIdentity('/repo/source file.ts')

    expect(mixedCase).toEqual({
      resolvedPath: '/repo/Source File.ts',
      fileUri: 'file:///repo/Source%20File.ts',
      stateKey: 'file:///repo/Source%20File.ts',
      activityPath: '/repo/Source File.ts',
    })
    expect(lowerCase.stateKey).not.toBe(mixedCase.stateKey)
  })

  test('normalizes Windows drive paths into one stable URI and state key', async () => {
    const activityPaths: string[] = []
    const { manager, controls } = await createManager({
      recordFileActivity: filePath => activityPaths.push(filePath),
    })
    const server = controls.get('typescript')!
    const firstSpelling = String.raw`C:\Repo\Source File.ts`
    const secondSpelling = 'c:/repo/source file.ts'

    const firstIdentity = getLspDocumentIdentity(firstSpelling)
    const secondIdentity = getLspDocumentIdentity(secondSpelling)
    expect(firstIdentity.fileUri).toBe('file:///c:/Repo/Source%20File.ts')
    expect(secondIdentity).toMatchObject({
      fileUri: 'file:///c:/repo/source%20file.ts',
      stateKey: firstIdentity.stateKey,
    })

    await manager.openFile(firstSpelling, 'one')
    await manager.changeFile(secondSpelling, 'two')

    expect(manager.isFileOpen(firstSpelling)).toBe(true)
    expect(manager.isFileOpen(secondSpelling)).toBe(true)
    expect(documentVersions(server.events, firstIdentity.fileUri)).toEqual([
      { method: 'textDocument/didOpen', version: 1 },
      { method: 'textDocument/didChange', version: 2 },
    ])
    expect(activityPaths).toEqual([
      fileURLToPath(firstIdentity.fileUri),
      fileURLToPath(firstIdentity.fileUri),
    ])
  })

  test('case-folds Unicode Windows aliases before URI encoding', () => {
    const upper = getLspDocumentIdentity('C:\\Repo\\Ä.ts')
    const lower = getLspDocumentIdentity('c:/repo/ä.ts')

    expect(upper.fileUri).not.toBe(lower.fileUri)
    expect(upper.stateKey).toBe(lower.stateKey)
  })

  test('reuses the opened Windows URI for requests through a case alias', async () => {
    const { manager, controls } = await createManager()
    const server = controls.get('typescript')!
    const firstSpelling = String.raw`C:\Repo\Source File.ts`
    const secondSpelling = 'c:/repo/source file.ts'
    const openedUri = getLspDocumentIdentity(firstSpelling).fileUri
    const aliasUri = getLspDocumentIdentity(secondSpelling).fileUri

    await manager.openFile(firstSpelling, 'one')
    await manager.sendRequest(secondSpelling, 'textDocument/hover', {
      textDocument: { uri: aliasUri },
    })

    expect(server.events.slice(-2)).toMatchObject([
      {
        kind: 'notification',
        method: 'textDocument/didOpen',
        params: { textDocument: { uri: openedUri } },
      },
      {
        kind: 'request',
        method: 'textDocument/hover',
        params: { textDocument: { uri: openedUri } },
      },
    ])
  })

  test('records activity once for open, change fallback, change, save, and request reopen', async () => {
    const recordFileActivity = mock((_filePath: string) => {})
    const { manager, controls } = await createManager({ recordFileActivity })
    const server = controls.get('typescript')!
    const file = '/repo/src/activity.ts'

    await manager.changeFile(file, 'opened through change')
    await manager.changeFile(file, 'changed')
    await manager.saveFile(file)
    server.replaceGeneration()
    await manager.sendRequest(file, 'textDocument/hover', {})

    expect(recordFileActivity).toHaveBeenCalledTimes(4)
    expect(recordFileActivity.mock.calls.map(call => call[0])).toEqual([
      file,
      file,
      file,
      file,
    ])
  })

  test('records save activity when no document lifecycle is tracked', async () => {
    const recordFileActivity = mock((_filePath: string) => {})
    const { manager, controls } = await createManager({ recordFileActivity })
    const server = controls.get('typescript')!
    const file = '/repo/src/unopened-save.ts'

    await manager.ensureServerStarted(file)
    await manager.saveFile(file)

    expect(recordFileActivity).toHaveBeenCalledTimes(1)
    expect(recordFileActivity).toHaveBeenCalledWith(file)
    expect(
      server.events.some(
        event =>
          event.kind === 'notification' &&
          event.method === 'textDocument/didSave',
      ),
    ).toBe(false)
  })

  test('the shared document reader rejects files above the tool limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-size-'))
    const file = join(directory, 'large.ts')
    try {
      writeFileSync(file, '')
      truncateSync(file, MAX_LSP_FILE_SIZE_BYTES + 1)
      await expect(readLspDocumentContents(file)).rejects.toBeInstanceOf(
        LspDocumentTooLargeError,
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
