// Fixture for PowerShellTool.interruptForeground.test.ts.
//
// Runs the real PowerShellTool.call() in a clean child process with the shell
// execution layer mocked, then prints JSON observations for the parent test to
// assert on. The child-process pattern (see worktree.agentBase.test.ts) keeps
// these module mocks from leaking into sibling suites sharing the test process.
//
// Scenario under test: the user interrupts (submits a new message) while a
// foreground PowerShell command is still running. For REPL inner agents
// (replInnerExecution: true, surfaced here as foregroundOnly) backgrounding is
// unavailable, so the interrupt must fall through to shellCommand.kill()
// instead of calling startBackgrounding().

import { mock } from 'bun:test'

interface ScenarioState {
  execCalls: number
  killCalls: number
  spawnCalls: number
  cleanupCalls: number
}

let state: ScenarioState = { execCalls: 0, killCalls: 0, spawnCalls: 0, cleanupCalls: 0 }

const shellActual = await import('../../utils/Shell.js')
mock.module('../../utils/Shell.js', () => ({
  ...shellActual,
  exec: async () => {
    state.execCalls++
    let resolveResult!: (value: unknown) => void
    const result = new Promise(resolve => {
      resolveResult = resolve
    })
    const cmd: Record<string, unknown> = {
      result,
      status: 'running',
      taskOutput: {
        taskId: 'fake-output-task',
        stdoutToFile: false,
        outputFileRedundant: true,
        path: '/tmp/nonexistent-ps-output',
        outputFileSize: 0,
      },
      kill() {
        state.killCalls++
        cmd.status = 'killed'
        resolveResult({
          stdout: '',
          stderr: '',
          code: 130,
          interrupted: true,
          isAbort: true,
        })
      },
      cleanup() {
        state.cleanupCalls++
      },
    }
    return cmd
  },
}))

const localShellTaskActual = await import('../../tasks/LocalShellTask/LocalShellTask.js')
mock.module('../../tasks/LocalShellTask/LocalShellTask.js', () => ({
  ...localShellTaskActual,
  spawnShellTask: async () => {
    state.spawnCalls++
    return { taskId: 'bg-task-id' }
  },
  registerForeground: () => 'fg-task-id',
  unregisterForeground: () => {},
  backgroundExistingForegroundTask: () => true,
  markTaskNotified: () => {},
}))

const taskOutputActual = await import('../../utils/task/TaskOutput.js')
mock.module('../../utils/task/TaskOutput.js', () => ({
  ...taskOutputActual,
  TaskOutput: class {
    static startPolling() {}
    static stopPolling() {}
  },
}))

const psdActual = await import('../../utils/shell/powershellDetection.js')
mock.module('../../utils/shell/powershellDetection.js', () => ({
  ...psdActual,
  getCachedPowerShellPath: async () => '/fake/pwsh',
}))

const { PowerShellTool } = await import('./PowerShellTool.js')

interface ScenarioResult {
  state: ScenarioState
  backgroundTaskId: unknown
  interrupted: unknown
  error?: string
}

async function runScenario(replInnerExecution: boolean): Promise<ScenarioResult> {
  state = { execCalls: 0, killCalls: 0, spawnCalls: 0, cleanupCalls: 0 }
  const abortController = new AbortController()
  const toolUseContext = {
    abortController,
    setAppState: () => {},
    setAppStateForTasks: () => {},
    setToolJSX: undefined,
    toolUseId: 'toolu_interrupt_test',
    // agentId makes this a non-main-thread call so call() never touches
    // getAppState; replInnerExecution is what foregroundOnly derives from.
    agentId: 'test-agent',
    replInnerExecution,
    getAppState: () => {
      throw new Error('getAppState should not be needed in this scenario')
    },
  }

  const callPromise = PowerShellTool.call(
    { command: 'Write-Output hi' },
    toolUseContext as never,
  )
  // Interrupt shortly after startup; the progress loop notices on its next
  // tick (the initial race window is PROGRESS_THRESHOLD_MS).
  setTimeout(() => abortController.abort('interrupt'), 100)

  try {
    const result = await callPromise
    return {
      state,
      backgroundTaskId: (result.data as Record<string, unknown>).backgroundTaskId,
      interrupted: (result.data as Record<string, unknown>).interrupted,
    }
  } catch (error) {
    return {
      state,
      backgroundTaskId: undefined,
      interrupted: undefined,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const foregroundOnly = await runScenario(true)
const backgroundable = await runScenario(false)

console.log(JSON.stringify({ foregroundOnly, backgroundable }))
process.exit(0)
