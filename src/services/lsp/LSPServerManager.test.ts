import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, mock, test } from 'bun:test'
import {
  getLspDocumentIdentity,
  LspDocumentTooLargeError,
  MAX_LSP_FILE_SIZE_BYTES,
  readLspDocumentContents,
} from './documentIdentity.js'
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import type {
  LSPServerInstance,
  LSPServerInstanceOptions,
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
  failNextNotification(method: string, error?: Error): void
  holdNextStart(): { started: Promise<void>; release(): void }
  waitForStartCalls(count: number): Promise<void>
  simulateCrash(notifyManager?: boolean): void
  replaceGeneration(): void
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
        error: Error
        startedResolve: () => void
        wait: Promise<void>
        release: () => void
      }
    | undefined
  let startInvocationCount = 0
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
        throw gate.error
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
  }
}

async function createManager(options?: {
  configs?: Record<string, ScopedLspServerConfig>
  readDocument?: (filePath: string) => Promise<string>
  recordFileActivity?: (filePath: string) => void
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
  })
  await manager.initialize()
  return { manager, controls }
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
})

describe('LSP generation resynchronization', () => {
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
