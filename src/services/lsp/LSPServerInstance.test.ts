import { describe, expect, mock, test } from 'bun:test'
import type { InitializeParams, InitializeResult } from 'vscode-languageserver-protocol'
import type { LSPClient } from './LSPClient.js'
import { createLSPServerInstance } from './LSPServerInstance.js'
import type { ScopedLspServerConfig } from './types.js'

const CONFIG: ScopedLspServerConfig = {
  command: 'unused-test-lsp',
  extensionToLanguage: { '.ts': 'typescript' },
  scope: 'project',
  source: 'test',
}

type FakeClientController = {
  createClient: (
    serverName: string,
    onCrash?: (error: Error) => void,
  ) => LSPClient
  crash(error?: Error): void
  failNextInitialize(error: Error): void
  holdNextInitialize(): { started: Promise<void>; release(): void }
  startCalls: ReturnType<typeof mock>
  initializeCalls: ReturnType<typeof mock>
}

function createFakeClientController(): FakeClientController {
  let initialized = false
  let onCrash: ((error: Error) => void) | undefined
  let initializeError: Error | undefined
  let initializeGate:
    | {
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined

  const startCalls = mock(async () => {})
  const initializeCalls = mock(async (_params: InitializeParams) => {
    initializeGate?.startedResolve()
    if (initializeGate) {
      await initializeGate.wait
      initializeGate = undefined
    }
    if (initializeError) {
      const error = initializeError
      initializeError = undefined
      throw error
    }
    initialized = true
    return { capabilities: {} } satisfies InitializeResult
  })

  const client: LSPClient = {
    get capabilities() {
      return {}
    },
    get isInitialized() {
      return initialized
    },
    start: startCalls,
    initialize: initializeCalls,
    sendRequest: async <TResult>() => undefined as TResult,
    sendNotification: async () => {},
    sendNotificationStrict: async () => {},
    onNotification: () => {},
    onRequest: () => {},
    stop: async () => {
      initialized = false
    },
  }

  return {
    createClient: (_serverName, crashHandler) => {
      onCrash = crashHandler
      return client
    },
    crash(error = new Error('test crash')) {
      initialized = false
      onCrash?.(error)
    },
    failNextInitialize(error) {
      initializeError = error
    },
    holdNextInitialize() {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      initializeGate = { startedResolve, wait, release }
      return { started, release }
    },
    startCalls,
    initializeCalls,
  }
}

describe('LSP server generations', () => {
  test('advance only after successful initialization and change after restart', async () => {
    const fake = createFakeClientController()
    const unavailableGenerations: number[] = []
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
      onUnavailable: generation => unavailableGenerations.push(generation),
    })

    expect(instance.generation).toBe(0)

    await instance.start()
    expect(instance.generation).toBe(1)
    await instance.start()
    expect(instance.generation).toBe(1)
    expect(fake.initializeCalls).toHaveBeenCalledTimes(1)

    await instance.stop()
    expect(instance.generation).toBe(1)
    expect(unavailableGenerations).toEqual([1])

    await instance.start()
    expect(instance.generation).toBe(2)

    fake.crash()
    expect(instance.state).toBe('error')
    expect(instance.generation).toBe(2)
    expect(unavailableGenerations).toEqual([1, 2])

    await instance.start()
    expect(instance.generation).toBe(3)

    await instance.stop()
    fake.failNextInitialize(new Error('initialize rejected'))
    await expect(instance.start()).rejects.toThrow('initialize rejected')
    expect(instance.generation).toBe(3)
  })

  test('concurrent callers await one in-flight initialization', async () => {
    const fake = createFakeClientController()
    const gate = fake.holdNextInitialize()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })

    const firstStart = instance.start()
    await gate.started
    const secondStart = instance.start()

    expect(fake.startCalls).toHaveBeenCalledTimes(1)
    expect(fake.initializeCalls).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('starting')

    gate.release()
    await Promise.all([firstStart, secondStart])

    expect(instance.state).toBe('running')
    expect(instance.generation).toBe(1)
    expect(fake.startCalls).toHaveBeenCalledTimes(1)
    expect(fake.initializeCalls).toHaveBeenCalledTimes(1)
  })
})
