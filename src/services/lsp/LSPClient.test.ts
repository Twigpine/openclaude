import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, mock, test } from 'bun:test'
import type { ChildProcess } from 'child_process'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import {
  createLSPClient,
  type LSPClientDependencies,
} from './LSPClient.js'

type FakeConnection = {
  connection: MessageConnection
  notificationMethods: string[]
  requestMethods: string[]
  sentRequestMethods: string[]
  emitNotification(method: string, params: unknown): void
  emitRequest(method: string, params: unknown): Promise<unknown>
  emitError(error: Error): void
  emitClose(): void
}

type FakeConnectionOptions = {
  failTransportDuringRequest?: { method: string; error: Error }
  pendingRequest?: string
  rejectNotification?: string
  rejectRequest?: string
  retainHandlersOnDispose?: boolean
}

function createFakeProcess(autoSpawn = true): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: mock(() => true),
  })
  if (autoSpawn) queueMicrotask(() => child.emit('spawn'))
  return child
}

const spawnFakeProcess = (() => createFakeProcess()) as
  LSPClientDependencies['spawnProcess']

function createFakeConnection(
  options: FakeConnectionOptions = {},
): FakeConnection {
  const notificationMethods: string[] = []
  const requestMethods: string[] = []
  const sentRequestMethods: string[] = []
  let errorHandler: ((error: [Error, unknown, number]) => void) | undefined
  let closeHandler: (() => void) | undefined
  let pendingRequestReject: ((error: Error) => void) | undefined
  const notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >()
  const requestHandlers = new Map<
    string,
    (params: unknown) => unknown | Promise<unknown>
  >()

  const connection = {
    listen: mock(() => {}),
    trace: mock(async () => {}),
    onError: mock((handler: (error: [Error, unknown, number]) => void) => {
      errorHandler = handler
    }),
    onClose: mock((handler: () => void) => {
      closeHandler = handler
    }),
    onNotification: mock((method: string, handler: (params: unknown) => void) => {
      notificationMethods.push(method)
      notificationHandlers.set(method, handler)
    }),
    onRequest: mock(
      (
        method: string,
        handler: (params: unknown) => unknown | Promise<unknown>,
      ) => {
      requestMethods.push(method)
        requestHandlers.set(method, handler)
      },
    ),
    sendRequest: mock(async (method: string) => {
      sentRequestMethods.push(method)
      if (method === options.pendingRequest) {
        return await new Promise((_resolve, reject) => {
          pendingRequestReject = reject
        })
      }
      if (method === options.rejectRequest) {
        throw new Error('request rejected')
      }
      if (method === options.failTransportDuringRequest?.method) {
        queueMicrotask(() => {
          errorHandler?.([
            options.failTransportDuringRequest!.error,
            undefined,
            0,
          ])
        })
      }
      return method === 'initialize' ? { capabilities: {} } : null
    }),
    sendNotification: mock(async (method: string) => {
      if (method === options.rejectNotification) {
        throw new Error('writer rejected')
      }
    }),
    dispose: mock(() => {
      pendingRequestReject?.(new Error('connection disposed'))
      pendingRequestReject = undefined
      if (!options.retainHandlersOnDispose) {
        errorHandler = undefined
        closeHandler = undefined
      }
    }),
  } as unknown as MessageConnection

  return {
    connection,
    notificationMethods,
    requestMethods,
    sentRequestMethods,
    emitNotification(method, params) {
      notificationHandlers.get(method)?.(params)
    },
    async emitRequest(method, params) {
      const handler = requestHandlers.get(method)
      if (!handler) throw new Error(`No request handler registered for ${method}`)
      return await handler(params)
    },
    emitError(error) {
      errorHandler?.([error, undefined, 0])
    },
    emitClose() {
      closeHandler?.()
    },
  }
}

function initializeParams() {
  return {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  }
}

describe('LSP client notification delivery', () => {
  test('best-effort notifications preserve lifecycle preflight errors', async () => {
    const fakeConnection = createFakeConnection()
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await expect(
      client.sendNotification('textDocument/didSave', {}),
    ).rejects.toThrow('LSP client not started')

    await client.start('unused', [])
    await client.initialize(initializeParams())
    fakeConnection.emitError(new Error('connection failed'))

    await expect(
      client.sendNotification('textDocument/didSave', {}),
    ).rejects.toThrow('connection failed')
    await client.stop()
  })

  test('strict notifications reject while best-effort notifications keep resolving', async () => {
    const fakeConnection = createFakeConnection({
      rejectNotification: 'textDocument/didOpen',
    })
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())

    await expect(
      client.sendNotificationStrict('textDocument/didOpen', {}),
    ).rejects.toThrow('writer rejected')
    await expect(
      client.sendNotification('textDocument/didOpen', {}),
    ).resolves.toBeUndefined()

    await client.stop()
  })

  test('every unexpected transport termination enters crash recovery once', async () => {
    const createStartedClient = async () => {
      const child = createFakeProcess()
      const fakeConnection = createFakeConnection()
      const onCrash = mock((_error: Error) => {})
      const client = createLSPClient('typescript', onCrash, {
        spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
        createConnection: () => fakeConnection.connection,
      })
      await client.start('unused', [])
      await client.initialize(initializeParams())
      return { child, client, fakeConnection, onCrash }
    }

    type StartedClient = Awaited<ReturnType<typeof createStartedClient>>
    const scenarios: Array<{
      name: string
      terminate: (started: StartedClient) => void
    }> = [
      {
        name: 'JSON-RPC error',
        terminate: ({ fakeConnection }) =>
          fakeConnection.emitError(new Error('connection failed')),
      },
      {
        name: 'JSON-RPC close',
        terminate: ({ fakeConnection }) => fakeConnection.emitClose(),
      },
      {
        name: 'child-process error',
        terminate: ({ child }) =>
          child.emit('error', new Error('process transport error')),
      },
      {
        name: 'clean child exit',
        terminate: ({ child }) => child.emit('exit', 0, null),
      },
      {
        name: 'signal child exit',
        terminate: ({ child }) => child.emit('exit', null, 'SIGTERM'),
      },
      {
        name: 'nonzero child exit',
        terminate: ({ child }) => child.emit('exit', 1, null),
      },
    ]

    for (const scenario of scenarios) {
      const started = await createStartedClient()
      scenario.terminate(started)

      expect(started.client.isInitialized, scenario.name).toBe(false)
      expect(started.onCrash, scenario.name).toHaveBeenCalledTimes(1)
      expect(started.child.kill, scenario.name).toHaveBeenCalledTimes(1)

      started.fakeConnection.emitClose()
      started.child.emit('exit', 1, null)
      expect(started.onCrash, scenario.name).toHaveBeenCalledTimes(1)
      await started.client.stop({ force: true })
    }
  })

  test('ignores a stale close callback after connection replacement', async () => {
    const connections: FakeConnection[] = []
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => {
        const fake = createFakeConnection({ retainHandlersOnDispose: true })
        connections.push(fake)
        return fake.connection
      },
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    await client.start('unused', [])
    await client.initialize(initializeParams())

    connections[0]?.emitClose()
    expect(client.isInitialized).toBe(true)

    await client.stop()
  })

  test('starts after an overlapping shutdown request fails', async () => {
    const shutdownErrorConnection = createFakeConnection({
      rejectRequest: 'shutdown',
    })
    const replacementConnection = createFakeConnection()
    const connections = [shutdownErrorConnection, replacementConnection]
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => connections.shift()!.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())

    const stopOutcome = client.stop().then(
      () => undefined,
      error => error,
    )
    const restart = client.start('unused', [])

    expect(await stopOutcome).toEqual(new Error('request rejected'))
    await expect(restart).resolves.toBeUndefined()
    await client.initialize(initializeParams())
    expect(client.isInitialized).toBe(true)

    await client.stop()
  })

  test('force stop skips the graceful shutdown request', async () => {
    const fakeConnection = createFakeConnection()
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    await client.stop({ force: true })

    expect(fakeConnection.sentRequestMethods).toEqual(['initialize'])
  })

  test('force stop supersedes an in-flight graceful shutdown', async () => {
    const child = createFakeProcess()
    const fakeConnection = createFakeConnection({ pendingRequest: 'shutdown' })
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    const gracefulStop = client.stop()
    await Promise.resolve()

    const forcedStop = client.stop({ force: true })
    const outcome = await Promise.race([
      forcedStop.then(() => 'stopped' as const),
      new Promise<'timed-out'>(resolve =>
        setTimeout(() => resolve('timed-out'), 50),
      ),
    ])

    try {
      expect(outcome).toBe('stopped')
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      fakeConnection.connection.dispose()
      await Promise.allSettled([gracefulStop, forcedStop])
    }
  })

  test('bounds an unanswered graceful shutdown exchange', async () => {
    const child = createFakeProcess()
    const fakeConnection = createFakeConnection({ pendingRequest: 'shutdown' })
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
      createConnection: () => fakeConnection.connection,
      gracefulShutdownTimeoutMs: 5,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    const gracefulStop = client.stop()
    const outcome = await Promise.race([
      gracefulStop.then(() => 'stopped' as const),
      new Promise<'timed-out'>(resolve =>
        setTimeout(() => resolve('timed-out'), 50),
      ),
    ])

    try {
      expect(outcome).toBe('stopped')
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      fakeConnection.connection.dispose()
      await gracefulStop.catch(() => {})
    }
  })

  test('an immediate stop settles an in-flight spawn wait', async () => {
    const child = createFakeProcess(false)
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
    })

    const start = client.start('unused', [])
    await client.stop({ force: true })

    await expect(start).rejects.toThrow('cancelled during spawn')
    expect(() =>
      child.emit('error', new Error('late missing-command ENOENT')),
    ).not.toThrow()
  })

  test('transport failure rejects a pending initialization', async () => {
    const fakeConnection = createFakeConnection({ pendingRequest: 'initialize' })
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    const initialize = client.initialize(initializeParams())
    fakeConnection.emitError(new Error('connection lost'))

    try {
      await expect(initialize).rejects.toThrow('connection disposed')
      expect(client.isInitialized).toBe(false)
    } finally {
      await client.stop({ force: true }).catch(() => {})
      await initialize.catch(() => {})
    }
  })

  test('transport failure cannot be overwritten by initialization success', async () => {
    const transportError = new Error('late transport failure')
    const fakeConnection = createFakeConnection({
      failTransportDuringRequest: {
        method: 'initialize',
        error: transportError,
      },
    })
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    try {
      await expect(client.initialize(initializeParams())).rejects.toBe(
        transportError,
      )
      expect(client.isInitialized).toBe(false)
    } finally {
      await client.stop().catch(() => {})
    }
  })

  test('reinstalls registered handlers on a replacement connection', async () => {
    const connections: FakeConnection[] = []
    const nextConnection = () => {
      const fake = createFakeConnection()
      connections.push(fake)
      return fake.connection
    }
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: nextConnection,
    })

    const notificationHandler = mock((_params: unknown) => {})
    const requestHandler = mock((params: unknown) => ({ configured: params }))
    client.onNotification(
      'textDocument/publishDiagnostics',
      notificationHandler,
    )
    client.onRequest('workspace/configuration', requestHandler)

    await client.start('unused', [])
    await client.initialize(initializeParams())
    connections[0]?.emitNotification('textDocument/publishDiagnostics', {
      generation: 1,
    })
    expect(
      await connections[0]?.emitRequest('workspace/configuration', {
        generation: 1,
      }),
    ).toEqual({ configured: { generation: 1 } })
    await client.stop()
    await client.start('unused', [])
    await client.initialize(initializeParams())
    connections[1]?.emitNotification('textDocument/publishDiagnostics', {
      generation: 2,
    })
    expect(
      await connections[1]?.emitRequest('workspace/configuration', {
        generation: 2,
      }),
    ).toEqual({ configured: { generation: 2 } })

    expect(connections).toHaveLength(2)
    expect(connections[0]?.notificationMethods).toEqual([
      'textDocument/publishDiagnostics',
    ])
    expect(connections[1]?.notificationMethods).toEqual([
      'textDocument/publishDiagnostics',
    ])
    expect(connections[0]?.requestMethods).toEqual(['workspace/configuration'])
    expect(connections[1]?.requestMethods).toEqual(['workspace/configuration'])
    expect(notificationHandler).toHaveBeenCalledTimes(2)
    expect(notificationHandler).toHaveBeenNthCalledWith(1, { generation: 1 })
    expect(notificationHandler).toHaveBeenNthCalledWith(2, { generation: 2 })
    expect(requestHandler).toHaveBeenCalledTimes(2)

    await client.stop()
  })
})
