import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ScopedLspServerConfig } from './types.js'

type ProtocolEvent = {
  generation: number
  kind: 'notification' | 'request'
  method: string
  params: unknown
}

type FakeServer = {
  server: Record<string, unknown>
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
let installedBaselineMocks = false
const managers: Array<{ shutdown(): Promise<void> }> = []
const activityPaths: string[] = []

function createFakeServer(
  onUnavailable?: (generation: number) => void,
): FakeServer {
  let state = 'stopped'
  let generation = 0
  const events: ProtocolEvent[] = []

  const server = {
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
    async sendRequest(method: string, params: unknown) {
      events.push({ generation, kind: 'request', method, params })
      return null
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

try {
  await import('./documentIdentity.js')
} catch {
  // The prior head has no dependency-injection seam. These mocks are installed
  // only for that compatibility path so the same behavioral checks can execute
  // without launching a real server.
  installedBaselineMocks = true
  mock.module('./config.js', () => ({
    getAllLspServers: async () => ({ servers: { typescript: CONFIG } }),
  }))
  mock.module('./LSPDiagnosticRegistry.js', () => ({
    recordLSPDiagnosticFileActivity: (filePath: string) => {
      activityPaths.push(filePath)
    },
  }))
  mock.module('./LSPServerInstance.js', () => ({
    createLSPServerInstance: (
      _name: string,
      _config: unknown,
      options?: { onUnavailable?: (generation: number) => void },
    ) => {
      currentServer = createFakeServer(options?.onUnavailable)
      return currentServer.server
    },
  }))
}

const { createLSPServerManager } = await import('./LSPServerManager.js')

afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map(manager => manager.shutdown()))
  currentServer = undefined
})

beforeEach(() => {
  activityPaths.length = 0
})

afterAll(() => {
  if (installedBaselineMocks) mock.restore()
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
      return currentServer.server as never
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
  const file = '/repo/src/version.ts'
  const uri = pathToFileURL(file).href

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

test('records Windows activity with the same canonical path as diagnostics', async () => {
  const { manager } = await createManager()
  const firstSpelling = String.raw`C:\Repo\Source File.ts`
  const secondSpelling = 'c:/repo/source file.ts'
  const canonicalUri = 'file:///c:/repo/source%20file.ts'

  await manager.openFile(firstSpelling, 'one')
  await manager.changeFile(secondSpelling, 'two')

  expect(activityPaths).toEqual([
    fileURLToPath(canonicalUri),
    fileURLToPath(canonicalUri),
  ])
})
