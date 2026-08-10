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
  failNextRequest(error: Error): { called: Promise<void> }
  holdNextInitialize(): { started: Promise<void>; release(): void }
  holdNextStop(): { started: Promise<void>; release(): void }
  startCalls: ReturnType<typeof mock>
  initializeCalls: ReturnType<typeof mock>
  stopCalls: ReturnType<typeof mock>
  sendRequestCalls: ReturnType<typeof mock>
}

function createFakeClientController(): FakeClientController {
  let initialized = false
  let onCrash: ((error: Error) => void) | undefined
  let initializeError: Error | undefined
  let requestFailure:
    | { error: Error; calledResolve: () => void }
    | undefined
  let initializeGate:
    | {
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined
  let stopGate:
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

  const stopCalls = mock(async () => {
    stopGate?.startedResolve()
    if (stopGate) {
      await stopGate.wait
      stopGate = undefined
    }
    initialized = false
  })
  const sendRequestCalls = mock(async <TResult>() => {
    if (requestFailure) {
      const failure = requestFailure
      requestFailure = undefined
      failure.calledResolve()
      throw failure.error
    }
    return undefined as TResult
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
    sendRequest: sendRequestCalls as LSPClient['sendRequest'],
    sendNotification: async () => {},
    sendNotificationStrict: async () => {},
    onNotification: () => {},
    onRequest: () => {},
    stop: stopCalls,
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
    failNextRequest(error) {
      let calledResolve!: () => void
      const called = new Promise<void>(resolve => {
        calledResolve = resolve
      })
      requestFailure = { error, calledResolve }
      return { called }
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
    holdNextStop() {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      stopGate = { startedResolve, wait, release }
      return { started, release }
    },
    startCalls,
    initializeCalls,
    stopCalls,
    sendRequestCalls,
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

  test('concurrent callers share one rejection and a later start retries', async () => {
    const fake = createFakeClientController()
    const gate = fake.holdNextInitialize()
    const initializeError = new Error('initialize rejected')
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })

    fake.failNextInitialize(initializeError)
    const firstStart = instance.start()
    await gate.started
    const secondStart = instance.start()

    gate.release()
    const [firstResult, secondResult] = await Promise.allSettled([
      firstStart,
      secondStart,
    ])

    expect(firstResult.status).toBe('rejected')
    expect(secondResult.status).toBe('rejected')
    if (firstResult.status === 'rejected') {
      expect(firstResult.reason).toBe(initializeError)
    }
    if (secondResult.status === 'rejected') {
      expect(secondResult.reason).toBe(initializeError)
    }
    expect(fake.initializeCalls).toHaveBeenCalledTimes(1)
    expect(instance.generation).toBe(0)

    await instance.start()
    expect(fake.initializeCalls).toHaveBeenCalledTimes(2)
    expect(instance.generation).toBe(1)
  })

  test('waits for failed-start cleanup before allowing a retry', async () => {
    const fake = createFakeClientController()
    const initializeError = new Error('initialize rejected')
    const stopGate = fake.holdNextStop()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })
    fake.failNextInitialize(initializeError)

    let firstSettled = false
    const firstOutcome = instance.start().then(
      () => undefined,
      error => error,
    )
    void firstOutcome.then(() => {
      firstSettled = true
    })

    await stopGate.started
    await Promise.resolve()
    const secondOutcome = instance.start().then(
      () => undefined,
      error => error,
    )

    try {
      expect(firstSettled).toBe(false)
      expect(fake.startCalls).toHaveBeenCalledTimes(1)
    } finally {
      stopGate.release()
    }

    expect(await firstOutcome).toBe(initializeError)
    expect(await secondOutcome).toBe(initializeError)

    await instance.start()
    expect(fake.startCalls).toHaveBeenCalledTimes(2)
    expect(instance.generation).toBe(1)
  })

  test('does not retry ContentModified on a replacement generation', async () => {
    const fake = createFakeClientController()
    const contentModified = Object.assign(new Error('content modified'), {
      code: -32801,
    })
    const failure = fake.failNextRequest(contentModified)
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })
    await instance.start()

    const request = instance.sendRequest('textDocument/hover', {})
    await failure.called
    fake.crash()
    await instance.start()

    await expect(request).rejects.toThrow('changed generation')
    expect(fake.sendRequestCalls).toHaveBeenCalledTimes(1)
    expect(instance.generation).toBe(2)
  })
})
