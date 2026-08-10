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
  emitError(error: Error): void
  emitClose(): void
}

function createFakeProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: mock(() => true),
  })
  queueMicrotask(() => child.emit('spawn'))
  return child
}

const spawnFakeProcess = (() => createFakeProcess()) as
  LSPClientDependencies['spawnProcess']

function createFakeConnection(
  rejectNotification?: string,
): FakeConnection {
  const notificationMethods: string[] = []
  const requestMethods: string[] = []
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
    onNotification: mock((method: string) => {
      notificationMethods.push(method)
    }),
    onRequest: mock((method: string) => {
      requestMethods.push(method)
    }),
    sendRequest: mock(async (method: string) =>
      method === 'initialize' ? { capabilities: {} } : null,
    ),
    sendNotification: mock(async (method: string) => {
      if (method === rejectNotification) {
        throw new Error('writer rejected')
      }
    }),
    dispose: mock(() => {
      errorHandler = undefined
      closeHandler = undefined
    }),
  } as unknown as MessageConnection

  return {
    connection,
    notificationMethods,
    requestMethods,
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
    const fakeConnection = createFakeConnection('textDocument/didOpen')
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

  test('active connection failures make the client unavailable exactly once', async () => {
    const fakeConnection = createFakeConnection()
    const onCrash = mock((_error: Error) => {})
    const client = createLSPClient('typescript', onCrash, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => fakeConnection.connection,
    })

    await client.start('unused', [])
    await client.initialize(initializeParams())
    fakeConnection.emitError(new Error('connection failed'))
    fakeConnection.emitClose()

    expect(client.isInitialized).toBe(false)
    expect(onCrash).toHaveBeenCalledTimes(1)
    await client.stop()
  })

  test('ignores a stale close callback after connection replacement', async () => {
    const connections: FakeConnection[] = []
    const client = createLSPClient('typescript', undefined, {
      spawnProcess: spawnFakeProcess,
      createConnection: () => {
        const fake = createFakeConnection()
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
