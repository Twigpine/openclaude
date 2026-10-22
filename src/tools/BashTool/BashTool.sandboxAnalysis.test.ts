import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { ExecResult, ShellCommand } from '../../utils/ShellCommand.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'

const nonce = `${Date.now()}-${Math.random()}`
const REAL_SHELL = {
  ...await import(`../../utils/Shell.js?real=${nonce}`),
}
const REAL_GROWTHBOOK = {
  ...await import(`../../services/analytics/growthbook.js?real=${nonce}`),
}

afterAll(() => {
  mock.restore()
  mock.module('../../utils/Shell.js', () => REAL_SHELL)
  mock.module('src/utils/Shell.js', () => REAL_SHELL)
  mock.module('../../services/analytics/growthbook.js', () => REAL_GROWTHBOOK)
  mock.module('src/services/analytics/growthbook.js', () => REAL_GROWTHBOOK)
})

const originalSandboxMethods = {
  isSandboxingEnabled: SandboxManager.isSandboxingEnabled,
  areUnsandboxedCommandsAllowed: SandboxManager.areUnsandboxedCommandsAllowed,
}
const originalInjectionFlag =
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
const originalSandboxIndicatorFlag =
  process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR

let importCounter = 0
let capturedExecOptions: { shouldUseSandbox?: boolean } | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('tools/BashTool/BashTool.sandboxAnalysis.test.ts')
  capturedExecOptions = undefined
})

afterEach(() => {
  try {
    mock.restore()
    SandboxManager.isSandboxingEnabled =
      originalSandboxMethods.isSandboxingEnabled
    SandboxManager.areUnsandboxedCommandsAllowed =
      originalSandboxMethods.areUnsandboxedCommandsAllowed
    if (originalInjectionFlag === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK
    } else {
      process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK =
        originalInjectionFlag
    }
    if (originalSandboxIndicatorFlag === undefined) {
      delete process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR
    } else {
      process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR =
        originalSandboxIndicatorFlag
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function makeToolUseContext() {
  const toolPermissionContext = getEmptyToolPermissionContext()
  return {
    abortController: new AbortController(),
    options: { isNonInteractiveSession: false },
    getAppState: () => ({ toolPermissionContext }) as never,
    setAppState: () => undefined,
    setToolJSX: undefined,
    toolUseId: 'test-bash-sandbox-analysis',
  } as never
}

function makeCompletedShellCommand(result: ExecResult): ShellCommand {
  return {
    background: () => false,
    result: Promise.resolve(result),
    kill: () => undefined,
    status: 'completed',
    cleanup: () => undefined,
    taskOutput: {
      taskId: 'test-task',
      stdoutToFile: false,
      outputFileRedundant: true,
      path: '',
      outputFileSize: 0,
    } as never,
  }
}

async function importBashToolWithExecutionMocks() {
  const execMock = mock(
    async (
      _command: string,
      _signal: AbortSignal,
      _shellType: string,
      options?: { shouldUseSandbox?: boolean },
    ) => {
      capturedExecOptions = options
      return makeCompletedShellCommand({
        stdout: '',
        stderr: '',
        code: 0,
        interrupted: false,
      })
    },
  )

  const getFeatureValue_CACHED_MAY_BE_STALE = mock(
    <T,>(key: string, fallback: T): T => {
      if (key === 'tengu_sandbox_disabled_commands') {
        return { commands: [], substrings: ['echo'] } as T
      }
      return fallback
    },
  )

  mock.module('../../utils/Shell.js', () => ({
    ...REAL_SHELL,
    exec: execMock,
  }))
  mock.module('src/utils/Shell.js', () => ({
    ...REAL_SHELL,
    exec: execMock,
  }))
  mock.module('../../services/analytics/growthbook.js', () => ({
    ...REAL_GROWTHBOOK,
    getFeatureValue_CACHED_MAY_BE_STALE,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...REAL_GROWTHBOOK,
    getFeatureValue_CACHED_MAY_BE_STALE,
  }))

  return import(`./BashTool.js?sandboxAnalysisTest=${importCounter++}`)
}

async function importSandboxPresentationWithMocks() {
  const getFeatureValue_CACHED_MAY_BE_STALE = mock(
    <T,>(key: string, fallback: T): T => {
      if (key === 'tengu_sandbox_disabled_commands') {
        return { commands: [], substrings: ['echo'] } as T
      }
      return fallback
    },
  )

  mock.module('../../services/analytics/growthbook.js', () => ({
    ...REAL_GROWTHBOOK,
    getFeatureValue_CACHED_MAY_BE_STALE,
  }))
  mock.module('src/services/analytics/growthbook.js', () => ({
    ...REAL_GROWTHBOOK,
    getFeatureValue_CACHED_MAY_BE_STALE,
  }))

  return import(`./shouldUseSandbox.js?presentationTest=${importCounter++}`)
}

test('execution sandbox decision uses parser analysis for parser-limited commands', async () => {
  process.env.CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK = '1'
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true

  const { BashTool } = await importBashToolWithExecutionMocks()

  await BashTool.call(
    { command: 'echo ${value + 1}', description: 'r' } as never,
    makeToolUseContext(),
  )

  expect(capturedExecOptions?.shouldUseSandbox).toBe(true)
})

test('presentation sandbox decision fails closed for parser-limited excluded commands', async () => {
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true

  const { shouldUseSandboxForPresentation } =
    await importSandboxPresentationWithMocks()

  expect(shouldUseSandboxForPresentation({ command: 'echo hello' })).toBe(false)
  expect(
    shouldUseSandboxForPresentation({ command: 'echo ${value + 1}' }),
  ).toBe(true)
})

test('sandbox indicator label matches parser-limited execution decision', async () => {
  process.env.CLAUDE_CODE_BASH_SANDBOX_SHOW_INDICATOR = '1'
  SandboxManager.isSandboxingEnabled = () => true
  SandboxManager.areUnsandboxedCommandsAllowed = () => true

  const { BashTool } = await importBashToolWithExecutionMocks()

  expect(BashTool.userFacingName({ command: 'echo hello' })).toBe('Bash')
  expect(BashTool.userFacingName({ command: 'echo ${value + 1}' })).toBe(
    'SandboxedBash',
  )
})
