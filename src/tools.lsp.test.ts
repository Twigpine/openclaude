import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from './Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

let lspConnected = false
let lspManager: Record<string, unknown> | undefined
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
  const sendRequest = mock(async () => null)
  try {
    writeFileSync(filePath, '')
    truncateSync(filePath, 10_000_001)
    lspManager = {
      isFileOpen: () => false,
      openFile,
      sendRequest,
    }

    const result = await LSPTool.call(
      { operation: 'hover', filePath, line: 1, character: 1 },
      {} as never,
    )

    expect(result.data.result).toContain('exceeds 10MB limit')
    expect(openFile).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LSPTool rejects non-regular documents without reading their stream', async () => {
  if (process.platform === 'win32') return

  const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-tool-fifo-'))
  const filePath = join(directory, 'stream.ts')
  const openFile = mock(async () => {})
  const sendRequest = mock(async () => null)
  let keeper: number | undefined
  try {
    execFileSync('mkfifo', [filePath])
    keeper = openSync(
      filePath,
      constants.O_RDONLY | constants.O_NONBLOCK,
    )
    const writer = spawn(
      'dd',
      ['if=/dev/zero', `of=${filePath}`, 'bs=10000001', 'count=1', 'status=none'],
      { stdio: 'ignore' },
    )
    const writerDone = new Promise<void>((resolve, reject) => {
      writer.once('error', reject)
      writer.once('exit', () => resolve())
    })
    lspManager = {
      isFileOpen: () => false,
      openFile,
      sendRequest,
    }

    const result = await LSPTool.call(
      { operation: 'hover', filePath, line: 1, character: 1 },
      {} as never,
    )
    closeSync(keeper)
    keeper = undefined
    await writerDone

    expect(result.data.result).toContain('not a regular file')
    expect(openFile).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
  } finally {
    if (keeper !== undefined) closeSync(keeper)
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LSPTool opens FIFO recovery paths nonblocking before validation', async () => {
  if (process.platform === 'win32') return

  const directory = mkdtempSync(join(tmpdir(), 'openclaude-lsp-tool-fifo-'))
  const filePath = join(directory, 'stream.ts')
  const openFile = mock(async () => {})
  const sendRequest = mock(async () => null)
  try {
    execFileSync('mkfifo', [filePath])
    lspManager = {
      isFileOpen: () => false,
      openFile,
      sendRequest,
    }

    const result = await LSPTool.call(
      { operation: 'hover', filePath, line: 1, character: 1 },
      {} as never,
    )

    expect(result.data.result).toContain('not a regular file')
    expect(openFile).not.toHaveBeenCalled()
    expect(sendRequest).not.toHaveBeenCalled()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('LSPTool does not redundantly open a current document', async () => {
  const openFile = mock(async () => {})
  const sendRequest = mock(async () => null)
  lspManager = {
    isFileOpen: () => true,
    openFile,
    sendRequest,
  }

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
  expect(sendRequest).toHaveBeenCalledTimes(1)
})

test('LSPTool request params use the shared canonical document URI', async () => {
  const sendRequest = mock(async () => null)
  lspManager = {
    isFileOpen: () => true,
    openFile: mock(async () => {}),
    sendRequest,
  }

  await LSPTool.call(
    {
      operation: 'hover',
      filePath: '/repo/Source File.ts',
      line: 1,
      character: 1,
    },
    {} as never,
  )

  expect(sendRequest).toHaveBeenCalledWith(
    '/repo/Source File.ts',
    'textDocument/hover',
    {
      textDocument: { uri: 'file:///repo/Source%20File.ts' },
      position: { line: 0, character: 0 },
    },
  )
})
