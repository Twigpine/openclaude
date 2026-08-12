import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createLSPServerManager } from './LSPServerManager.js'
import type { LSPServerInstance } from './LSPServerInstance.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

type ProtocolEvent = {
  generation: number
  kind: 'notification' | 'request'
  method: string
  params: unknown
}

type FakeServer = {
  server: LSPServerInstance
  events: ProtocolEvent[]
  crash(): void
}

const CONFIG = {
  command: 'unused-test-lsp',
  extensionToLanguage: { '.ts': 'typescript' },
  scope: 'project',
  source: 'test',
} satisfies ScopedLspServerConfig

let currentServer: FakeServer | undefined
const managers: Array<{ shutdown(): Promise<void> }> = []
const activityPaths: string[] = []

function createFakeServer(
  onUnavailable?: (generation: number) => void,
): FakeServer {
  let state: LspServerState = 'stopped'
  let generation = 0
  const events: ProtocolEvent[] = []

  const server: LSPServerInstance = {
    name: 'typescript',
    config: CONFIG,
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
      return false
    },
    async start() {
      if (state === 'running') return
      generation++
      state = 'running'
    },
    async stop() {
      const stoppedGeneration = generation
      state = 'stopped'
      onUnavailable?.(stoppedGeneration)
    },
    async restart() {
      await server.stop()
      await server.start()
    },
    isHealthy() {
      return state === 'running'
    },
    async sendRequest<TResult>(method: string, params: unknown) {
      events.push({ generation, kind: 'request', method, params })
      return null as TResult
    },
    async sendNotification(method: string, params: unknown) {
      events.push({ generation, kind: 'notification', method, params })
    },
    async sendNotificationStrict(method: string, params: unknown) {
      events.push({ generation, kind: 'notification', method, params })
    },
    onNotification() {},
    onRequest() {},
  }

  return {
    server,
    events,
    crash() {
      const crashedGeneration = generation
      state = 'error'
      onUnavailable?.(crashedGeneration)
    },
  }
}

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.shutdown()))
  currentServer = undefined
})

beforeEach(() => {
  activityPaths.length = 0
})

async function createManager() {
  const manager = createLSPServerManager({
    loadServerConfigs: async () => ({
      servers: { typescript: CONFIG },
    }),
    createServerInstance: (
      _name: string,
      _config: unknown,
      options: { onUnavailable?: (generation: number) => void },
    ) => {
      currentServer = createFakeServer(options.onUnavailable)
      return currentServer.server
    },
    readDocument: filePath => readFile(filePath, 'utf-8'),
    recordFileActivity: filePath => {
      activityPaths.push(filePath)
    },
  })
  managers.push(manager)
  await manager.initialize()
  return { manager, server: currentServer! }
}

test('delivers monotonically increasing versions for one document', async () => {
  const { manager, server } = await createManager()
  const file = String.raw`C:\repo\src\version.ts`
  const uri = 'file:///c:/repo/src/version.ts'

  await manager.openFile(file, 'one')
  await manager.changeFile(file, 'two')
  await manager.changeFile(file, 'three')

  expect(
    server.events
      .filter(event => event.kind === 'notification')
      .map(event => ({
        method: event.method,
        version: (event.params as { textDocument: { version: number } })
          .textDocument.version,
        uri: (event.params as { textDocument: { uri: string } }).textDocument
          .uri,
      })),
  ).toEqual([
    { method: 'textDocument/didOpen', version: 1, uri },
    { method: 'textDocument/didChange', version: 2, uri },
    { method: 'textDocument/didChange', version: 3, uri },
  ])
})

test('resends current contents after restart before making a request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-protocol-'))
  const file = join(directory, 'restart.ts')
  try {
    writeFileSync(file, 'current contents')
    const { manager, server } = await createManager()

    await manager.openFile(file, 'before restart')
    server.crash()
    await manager.sendRequest(file, 'textDocument/hover', {})

    expect(server.events.slice(-2)).toMatchObject([
      {
        generation: 2,
        kind: 'notification',
        method: 'textDocument/didOpen',
        params: {
          textDocument: { text: 'current contents', version: 1 },
        },
      },
      {
        generation: 2,
        kind: 'request',
        method: 'textDocument/hover',
      },
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('records Windows activity with the opened document casing', async () => {
  const { manager } = await createManager()
  const firstSpelling = String.raw`C:\Repo\Source File.ts`
  const secondSpelling = 'c:/repo/source file.ts'
  const openedUri = 'file:///c:/Repo/Source%20File.ts'

  await manager.openFile(firstSpelling, 'one')
  await manager.changeFile(secondSpelling, 'two')

  expect(activityPaths).toEqual([
    fileURLToPath(openedUri),
    fileURLToPath(openedUri),
  ])
})
