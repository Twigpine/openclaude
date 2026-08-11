import {
  mkdtempSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { MAX_LSP_FILE_SIZE_BYTES } from './services/lsp/documentIdentity.js'
import type { LSPServerManager } from './services/lsp/LSPServerManager.js'
import { getEmptyToolPermissionContext } from './Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

let lspConnected = false
let lspManager: LSPServerManager | undefined

function createLspManagerDouble(
  overrides: Partial<LSPServerManager> = {},
): LSPServerManager {
  return {
    async initialize() {},
    async shutdown() {},
    getServerForFile: () => undefined,
    ensureServerStarted: async () => undefined,
    async sendRequest<T>() {
      return undefined as T | undefined
    },
    async sendRequestWithGeneration<T>() {
      return undefined as
        | { result: T; serverGeneration: number }
        | undefined
    },
    getAllServers: () => new Map(),
    async openFile() {},
    async changeFile() {},
    async saveFile() {},
    async closeFile() {},
    isFileOpen: () => false,
    ...overrides,
  }
}

function createSendRequestDouble(): {
  sendRequest: LSPServerManager['sendRequest']
  calls: ReturnType<typeof mock>
} {
  const calls = mock(
    async (_filePath: string, _method: string, _params: unknown) => null,
  )
  const sendRequest: LSPServerManager['sendRequest'] = async <T>(
    filePath: string,
    method: string,
    params: unknown,
  ) => (await calls(filePath, method, params)) as T
  return { sendRequest, calls }
}
const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

await acquireSharedMutationLock('tools.lsp.test.ts')

mock.module('./entrypoints/agentSdkTypes.js', () => ({ HOOK_EVENTS }))
mock.module('src/entrypoints/agentSdkTypes.js', () => ({ HOOK_EVENTS }))

mock.module('./services/lsp/manager.js', () => ({
  getInitializationStatus: () => ({ status: 'success' }),
  getLspServerManager: () => lspManager,
  initializeLspServerManager: async () => {},
  isLspConnected: () => lspConnected,
  reinitializeLspServerManager: () => {},
  resetLspServerManagerForTesting: () => {},
  shutdownLspServerManager: async () => {},
  waitForInitialization: async () => {},
}))

const { getAllBaseTools, getTools } = await import('./tools.js')
const { LSPTool } = await import('./tools/LSPTool/LSPTool.js')

afterAll(() => {
  try {
    mock.restore()
  } finally {
    releaseSharedMutationLock()
  }
})

beforeEach(() => {
  lspConnected = false
  lspManager = undefined
})

test('LSPTool is part of the base tool pool', () => {
  expect(getAllBaseTools().map(tool => tool.name)).toContain('LSP')
})

test('LSPTool is filtered from usable tools until a server is connected', () => {
  const permissionContext = getEmptyToolPermissionContext()

  expect(getTools(permissionContext).map(tool => tool.name)).not.toContain('LSP')

  lspConnected = true

  expect(getTools(permissionContext).map(tool => tool.name)).toContain('LSP')
})

test('LSPTool keeps the 10 MB guard ahead of open and request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-tool-size-'))
  const filePath = join(directory, 'large.ts')
  const openFile = mock(async () => {})
  const { sendRequest, calls: sendRequestCalls } = createSendRequestDouble()
  try {
    writeFileSync(filePath, '')
    truncateSync(filePath, MAX_LSP_FILE_SIZE_BYTES + 1)
    lspManager = createLspManagerDouble({
      isFileOpen: () => false,
      openFile,
      sendRequest,
    })

    const result = await LSPTool.call(
      { operation: 'hover', filePath, line: 1, character: 1 },
      {} as never,
    )

    expect(result.data.result).toContain('exceeds 10MB limit')
    expect(openFile).not.toHaveBeenCalled()
    expect(sendRequestCalls).not.toHaveBeenCalled()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LSPTool opens FIFO recovery paths nonblocking before validation', async () => {
  if (process.platform === 'win32') return

  const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-tool-fifo-'))
  const filePath = join(directory, 'stream.ts')
  const openFile = mock(async () => {})
  const { sendRequest, calls: sendRequestCalls } = createSendRequestDouble()
  try {
    execFileSync('mkfifo', [filePath])
    lspManager = createLspManagerDouble({
      isFileOpen: () => false,
      openFile,
      sendRequest,
    })

    const result = await LSPTool.call(
      { operation: 'hover', filePath, line: 1, character: 1 },
      {} as never,
    )

    expect(result.data.result).toContain('not a regular file')
    expect(openFile).not.toHaveBeenCalled()
    expect(sendRequestCalls).not.toHaveBeenCalled()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LSPTool does not redundantly open a current document', async () => {
  const openFile = mock(async () => {})
  const { sendRequest, calls: sendRequestCalls } = createSendRequestDouble()
  lspManager = createLspManagerDouble({
    isFileOpen: () => true,
    openFile,
    sendRequest,
  })

  await LSPTool.call(
    {
      operation: 'hover',
      filePath: '/repo/src/current.ts',
      line: 1,
      character: 1,
    },
    {} as never,
  )

  expect(openFile).not.toHaveBeenCalled()
  expect(sendRequestCalls).toHaveBeenCalledTimes(1)
})

test('LSPTool request params use the shared canonical document URI', async () => {
  const { sendRequest, calls: sendRequestCalls } = createSendRequestDouble()
  lspManager = createLspManagerDouble({
    isFileOpen: () => true,
    openFile: mock(async () => {}),
    sendRequest,
  })

  await LSPTool.call(
    {
      operation: 'hover',
      filePath: '/repo/Source File.ts',
      line: 1,
      character: 1,
    },
    {} as never,
  )

  expect(sendRequestCalls).toHaveBeenCalledWith(
    '/repo/Source File.ts',
    'textDocument/hover',
    {
      textDocument: { uri: 'file:///repo/Source%20File.ts' },
      position: { line: 0, character: 0 },
    },
  )
})

test('LSPTool retries both call-hierarchy requests on one replacement generation', async () => {
  const requests: Array<{
    method: string
    expectedGeneration: number | undefined
    itemGeneration: number | undefined
  }> = []
  let prepareGeneration = 0
  const sendRequestWithGeneration: LSPServerManager['sendRequestWithGeneration'] =
    async <T>(
      _filePath: string,
      method: string,
      params: unknown,
      options?: { expectedGeneration?: number },
    ) => {
      const itemGeneration = (
        params as { item?: { data?: { generation?: number } } }
      ).item?.data?.generation
      requests.push({
        method,
        expectedGeneration: options?.expectedGeneration,
        itemGeneration,
      })

      if (method === 'textDocument/prepareCallHierarchy') {
        prepareGeneration++
        return {
          result: [
            {
              name: 'target',
              kind: 12,
              uri: 'file:///repo/src/current.ts',
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 6 },
              },
              selectionRange: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 6 },
              },
              data: { generation: prepareGeneration },
            },
          ] as T,
          serverGeneration: prepareGeneration,
        }
      }

      if (options?.expectedGeneration === 1) {
        throw Object.assign(new Error('server generation changed'), {
          code: 'LSP_SERVER_GENERATION_CHANGED',
        })
      }

      return {
        result: [] as T,
        serverGeneration: options?.expectedGeneration ?? 0,
      }
    }

  lspManager = createLspManagerDouble({
    isFileOpen: () => true,
    sendRequestWithGeneration,
  })

  await LSPTool.call(
    {
      operation: 'incomingCalls',
      filePath: '/repo/src/current.ts',
      line: 1,
      character: 1,
    },
    {} as never,
  )

  expect(requests).toEqual([
    {
      method: 'textDocument/prepareCallHierarchy',
      expectedGeneration: undefined,
      itemGeneration: undefined,
    },
    {
      method: 'callHierarchy/incomingCalls',
      expectedGeneration: 1,
      itemGeneration: 1,
    },
    {
      method: 'textDocument/prepareCallHierarchy',
      expectedGeneration: undefined,
      itemGeneration: undefined,
    },
    {
      method: 'callHierarchy/incomingCalls',
      expectedGeneration: 2,
      itemGeneration: 2,
    },
  ])
})
