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

  const connection = {
    listen: mock(() => {}),
    trace: mock(async () => {}),
    onError: mock((handler: (error: [Error, unknown, number]) => void) => {
      errorHandler = handler
    }),
    onClose: mock((handler: () => void) => {
      closeHandler = handler
    }),
    onNotification: mock((method: string) => {
      notificationMethods.push(method)
    }),
    onRequest: mock((method: string) => {
      requestMethods.push(method)
    }),
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

  test('connection-only failures stay outside crash recovery until a nonzero exit', async () => {
    const child = createFakeProcess()
    const fakeConnection = createFakeConnection()
    const onCrash = mock((_error: Error) => {})
    const client = createLSPClient('typescript', onCrash, {
      spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    fakeConnection.emitError(new Error('connection failed'))
    fakeConnection.emitClose()

    expect(client.isInitialized).toBe(false)
    expect(onCrash).not.toHaveBeenCalled()

    child.emit('exit', 1, null)
    expect(onCrash).toHaveBeenCalledTimes(1)
    await client.stop({ force: true })
  })

  test('only nonzero process exits enter crash recovery', async () => {
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
      return { child, client, onCrash }
    }

    const cleanExit = await createStartedClient()
    cleanExit.child.emit('exit', 0, null)
    expect(cleanExit.onCrash).not.toHaveBeenCalled()
    await cleanExit.client.stop({ force: true })

    const signalExit = await createStartedClient()
    signalExit.child.emit('exit', null, 'SIGTERM')
    expect(signalExit.onCrash).not.toHaveBeenCalled()
    await signalExit.client.stop({ force: true })

    const processError = await createStartedClient()
    processError.child.emit('error', new Error('process transport error'))
    expect(processError.onCrash).not.toHaveBeenCalled()
    await processError.client.stop({ force: true })

    const crash = await createStartedClient()
    crash.child.emit('exit', 1, null)
    expect(crash.onCrash).toHaveBeenCalledTimes(1)
    await crash.client.stop({ force: true })
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

  test('an immediate stop settles an in-flight spawn wait', async () => {
    const child = createFakeProcess(false)
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: (() => child) as LSPClientDependencies['spawnProcess'],
    })

    const start = client.start('unused', [])
    await client.stop({ force: true })

    await expect(start).rejects.toThrow('cancelled during spawn')
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

    client.onNotification('textDocument/publishDiagnostics', () => {})
    client.onRequest('workspace/configuration', () => [])

    await client.start('unused', [])
    await client.initialize(initializeParams())
    await client.stop()
    await client.start('unused', [])
    await client.initialize(initializeParams())

    expect(connections).toHaveLength(2)
    expect(connections[0]?.notificationMethods).toEqual([
      'textDocument/publishDiagnostics',
    ])
    expect(connections[1]?.notificationMethods).toEqual([
      'textDocument/publishDiagnostics',
    ])
    expect(connections[0]?.requestMethods).toEqual(['workspace/configuration'])
    expect(connections[1]?.requestMethods).toEqual(['workspace/configuration'])

    await client.stop()
  })
})
