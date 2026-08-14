import { describe, expect, jest, mock, test } from 'bun:test'
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
  failNextStop(error: Error): void
  finishNextInitializeUnhealthy(): void
  holdNextRequest<TResult>(result: TResult): {
    started: Promise<void>
    release(): void
  }
  holdNextStart(): { started: Promise<void>; release(): void }
  holdNextInitialize(): { started: Promise<void>; release(): void }
  holdNextStop(options?: { blockForce?: boolean }): {
    started: Promise<void>
    release(): void
  }
  startCalls: ReturnType<typeof mock>
  initializeCalls: ReturnType<typeof mock>
  stopCalls: ReturnType<typeof mock>
  sendRequestCalls: ReturnType<typeof mock>
}

function createFakeClientController(): FakeClientController {
  let initialized = false
  let onCrash: ((error: Error) => void) | undefined
  let initializeError: Error | undefined
  let initializeUnhealthy = false
  let stopError: Error | undefined
  let requestFailure:
    | { error: Error; calledResolve: () => void }
    | undefined
  let startGate:
    | {
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
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
        blockForce: boolean
      }
    | undefined
  let requestGate:
    | {
        result: unknown
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined

  const startCalls = mock(async () => {
    startGate?.startedResolve()
    if (startGate) {
      await startGate.wait
      startGate = undefined
    }
  })
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
    initialized = !initializeUnhealthy
    initializeUnhealthy = false
    return { capabilities: {} } satisfies InitializeResult
  })

  const stopCalls = mock(async (options?: { force?: boolean }) => {
    const shouldBlock =
      stopGate && (!options?.force || stopGate.blockForce)
    if (shouldBlock) stopGate?.startedResolve()
    if (stopGate && shouldBlock) {
      await stopGate.wait
      stopGate = undefined
    }
    initialized = false
    if (stopError) {
      const error = stopError
      stopError = undefined
      throw error
    }
  })
  const sendRequestCalls = mock(async <TResult>() => {
    if (requestGate) {
      const gate = requestGate
      gate.startedResolve()
      await gate.wait
      requestGate = undefined
      return gate.result as TResult
    }
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
    failNextStop(error) {
      stopError = error
    },
    finishNextInitializeUnhealthy() {
      initializeUnhealthy = true
    },
    holdNextRequest(result) {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      requestGate = { result, startedResolve, wait, release }
      return { started, release }
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
      startGate = { startedResolve, wait, release }
      return { started, release }
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
    holdNextStop(options = {}) {
      let startedResolve!: () => void
      let release!: () => void
      const started = new Promise<void>(resolve => {
        startedResolve = resolve
      })
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      stopGate = {
        startedResolve,
        wait,
        release,
        blockForce: options.blockForce ?? true,
      }
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
    let secondSettled = false
    void secondStart.finally(() => {
      secondSettled = true
    })

    expect(fake.startCalls).toHaveBeenCalledTimes(1)
    expect(fake.initializeCalls).toHaveBeenCalledTimes(1)
    expect(instance.state).toBe('starting')
    await Promise.resolve()
    await Promise.resolve()
    expect(secondSettled).toBe(false)

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

  test('starts after an overlapping stop fails', async () => {
    const fake = createFakeClientController()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })
    await instance.start()
    const stopError = new Error('shutdown rejected')
    fake.failNextStop(stopError)

    const stopOutcome = instance.stop().then(
      () => undefined,
      error => error,
    )
    const restart = instance.start()

    expect(await stopOutcome).toBe(stopError)
    await expect(restart).resolves.toBeUndefined()
    expect(instance.state).toBe('running')
    expect(instance.generation).toBe(2)
  })

  test('a stop during initialization wins over the cancelled start', async () => {
    const fake = createFakeClientController()
    const initializeGate = fake.holdNextInitialize()
    const stopGate = fake.holdNextStop()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })

    const start = instance.start()
    await initializeGate.started
    const stop = instance.stop()
    await stopGate.started

    initializeGate.release()
    await Promise.resolve()
    stopGate.release()

    await expect(start).rejects.toThrow('start was cancelled')
    await expect(stop).resolves.toBeUndefined()
    expect(instance.state).toBe('stopped')
    expect(instance.generation).toBe(0)
  })

  test('startup timeout uses immediate cleanup instead of graceful shutdown', async () => {
    const fake = createFakeClientController()
    const initializeGate = fake.holdNextInitialize()
    const stopGate = fake.holdNextStop({ blockForce: false })
    const instance = createLSPServerInstance(
      'typescript',
      { ...CONFIG, startupTimeout: 5 },
      { createClient: fake.createClient },
    )

    const start = instance.start()
    await initializeGate.started

    try {
      await expect(start).rejects.toThrow('timed out')
      expect(fake.stopCalls).toHaveBeenCalledWith({ force: true })
    } finally {
      initializeGate.release()
      stopGate.release()
      await start.catch(() => {})
    }
  })

  test('startup timeout also bounds the process spawn wait', async () => {
    jest.useFakeTimers()
    const fake = createFakeClientController()
    const startGate = fake.holdNextStart()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
      defaultStartupTimeoutMs: 5,
    })

    const start = instance.start()
    await startGate.started

    try {
      jest.advanceTimersByTime(4)
      expect(instance.state).toBe('starting')
      jest.advanceTimersByTime(1)
      await expect(start).rejects.toThrow(
        'timed out after 5ms during process startup',
      )
      expect(fake.initializeCalls).not.toHaveBeenCalled()
      expect(fake.stopCalls).toHaveBeenCalledWith({ force: true })
    } finally {
      startGate.release()
      jest.runAllTimers()
      jest.useRealTimers()
      await start.catch(() => {})
    }
  })

  test('applies a bounded default when startupTimeout is omitted', async () => {
    jest.useFakeTimers()
    const fake = createFakeClientController()
    const initializeGate = fake.holdNextInitialize()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
      defaultStartupTimeoutMs: 5,
    })

    const start = instance.start()
    await initializeGate.started

    try {
      jest.advanceTimersByTime(4)
      expect(instance.state).toBe('starting')
      jest.advanceTimersByTime(1)
      await expect(start).rejects.toThrow('timed out after 5ms')
      expect(fake.stopCalls).toHaveBeenCalledWith({ force: true })
    } finally {
      initializeGate.release()
      jest.runAllTimers()
      jest.useRealTimers()
      await start.catch(() => {})
    }
  })

  test('does not publish a generation when initialization reports unhealthy', async () => {
    const fake = createFakeClientController()
    fake.finishNextInitializeUnhealthy()
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })

    await expect(instance.start()).rejects.toThrow('did not finish initialization')
    expect(instance.state).toBe('error')
    expect(instance.generation).toBe(0)
  })

  test('caps repeated crash recovery across successful replacement generations', async () => {
    const fake = createFakeClientController()
    const instance = createLSPServerInstance(
      'typescript',
      { ...CONFIG, maxRestarts: 2 },
      { createClient: fake.createClient },
    )

    await instance.start()
    fake.crash()
    await instance.start()
    fake.crash()
    await instance.start()
    fake.crash()

    await expect(instance.start()).rejects.toThrow(
      'exceeded max automatic recovery attempts (2)',
    )
    expect(fake.startCalls).toHaveBeenCalledTimes(3)
    expect(instance.generation).toBe(3)
  })

  test('explicit restart resets an exhausted automatic recovery budget', async () => {
    const fake = createFakeClientController()
    const instance = createLSPServerInstance(
      'typescript',
      { ...CONFIG, maxRestarts: 2 },
      { createClient: fake.createClient },
    )

    await instance.start()
    fake.crash()
    await instance.start()
    fake.crash()
    await instance.start()
    fake.crash()

    expect(instance.isCrashRecoveryExhausted).toBe(true)

    await instance.restart()
    expect(instance.isCrashRecoveryExhausted).toBe(false)

    fake.crash()
    await expect(instance.start()).resolves.toBeUndefined()
    expect(instance.generation).toBe(5)
  })

  test('ordinary stop does not reset or bypass an exhausted automatic recovery budget', async () => {
    const fake = createFakeClientController()
    const instance = createLSPServerInstance(
      'typescript',
      { ...CONFIG, maxRestarts: 0 },
      { createClient: fake.createClient },
    )

    await instance.start()
    fake.crash()

    await instance.stop()
    expect(instance.state).toBe('stopped')
    await expect(instance.start()).rejects.toThrow(
      'exceeded max automatic recovery attempts (0)',
    )
    expect(instance.isCrashRecoveryExhausted).toBe(true)
    expect(fake.startCalls).toHaveBeenCalledTimes(1)
  })

  test('notifies one unavailable transition when a crashed generation is later stopped', async () => {
    const fake = createFakeClientController()
    const unavailableGenerations: number[] = []
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
      onUnavailable: generation => unavailableGenerations.push(generation),
    })

    await instance.start()
    fake.crash()
    expect(unavailableGenerations).toEqual([1])

    await instance.stop()
    expect(unavailableGenerations).toEqual([1])
  })

  test('rejects a successful response from a replaced generation', async () => {
    const fake = createFakeClientController()
    const requestGate = fake.holdNextRequest('stale response')
    const instance = createLSPServerInstance('typescript', CONFIG, {
      createClient: fake.createClient,
    })
    await instance.start()

    const request = instance.sendRequest<string>('textDocument/hover', {})
    await requestGate.started
    fake.crash()
    await instance.start()
    requestGate.release()

    await expect(request).rejects.toThrow('changed generation')
    expect(instance.generation).toBe(2)
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
