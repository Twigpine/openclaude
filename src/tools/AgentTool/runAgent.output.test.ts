import { REAL_PROVIDER_TEST_CHILD_ENV, REAL_PROVIDER_TEST_TIMEOUT_MS, runTestFileWithRealProviders } from '../../test/providerModuleIsolation.js'
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { spawn } from 'node:child_process'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { registerForeground } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { asAgentId } from '../../types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getAgentTranscriptPath, recordSidechainTranscript, recordTranscript, setInternalEventWriter, resetProjectForTesting, flushSessionStorage } from '../../utils/sessionStorage.js'
import { withTranscriptFileLock } from '../../utils/transcriptFileLock.js'
import { registerAsyncAgent, killAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getTaskOutputPath, _clearOutputsForTest } from '../../utils/task/diskOutput.js'
import { clearPendingNotifications, getPendingNotificationsSnapshot } from '../../utils/messageQueueManager.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { runAgent } from './runAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const actualGit = { ...await import('../../utils/git.js') }
const actualQuery = { ...await import('../../query.js') }
let configDir: string
let oldPersistence: string | undefined

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

// Use the existing clean-child harness: other agent tests replace these
// production modules globally, and this test needs real registration/storage.
if (process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1') {
  test('agent output regression cases in a clean process', () =>
    runTestFileWithRealProviders(import.meta.path), REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000)
} else {
beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/runAgent.output.test.ts')
  oldPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  configDir = await mkdtemp(join(tmpdir(), 'agent-output-'))
  setClaudeConfigHomeDirForTesting(configDir)
  resetSettingsCache()
  resetProjectForTesting()
  clearPendingNotifications()
})
afterEach(async () => {
  try {
    mock.module('../../query.js', () => actualQuery)
    mock.module('../../utils/git.js', () => actualGit)
    await flushSessionStorage()
    await _clearOutputsForTest()
    clearPendingNotifications()
    resetProjectForTesting()
    setClaudeConfigHomeDirForTesting(undefined)
    resetSettingsCache()
    if (oldPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = oldPersistence
    await rm(configDir, { recursive: true, force: true })
  } finally { releaseSharedMutationLock() }
})

for (const phase of ['success', 'initial', 'incremental'] as const) {
  const cancel = phase !== 'success'
  test(`agent ${cancel ? `stops during its ${phase}` : 'completes after its'} real transcript append while unrelated persistence is blocked`, async () => {
    const remoteEntered = deferred()
    const remoteRelease = deferred()
    setInternalEventWriter(async () => { remoteEntered.resolve(); await remoteRelease.promise })
    const foreground = recordTranscript([createUserMessage({ content: 'unrelated foreground' })])
    await remoteEntered.promise
    const agentId = asAgentId(`output-${phase}`)
    const transcript = getAgentTranscriptPath(agentId)
    await mkdir(dirname(transcript), { recursive: true })
    const locked = deferred()
    const release = deferred()
    const holdTranscript = () => withTranscriptFileLock(transcript, async () => { locked.resolve(); await release.promise })
    let holder: Promise<void> | undefined
    if (phase !== 'incremental') {
      holder = holdTranscript()
      await locked.promise
    }
    let shell: ShellCommand | undefined
    let childExit: Promise<void> | undefined
    const shellId = `shell-${phase}`
    let queried = false
    mock.module('../../query.js', () => ({
      ...actualQuery,
      query: async function* () {
        queried = true
        if (phase === 'incremental') {
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
          childExit = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
          // A minimal shell adapter isolates this regression from ShellCommand's
          // existing cleanup/exit race; the child and agent cleanup are real.
          shell = {
            status: 'backgrounded',
            taskOutput: new TaskOutput(shellId, null),
            background: () => true,
            kill: () => { child.kill(); shell!.status = 'killed' },
            cleanup: () => {},
            result: childExit.then(() => ({ stdout: '', stderr: '', code: 0, interrupted: true })),
          }
          registerForeground({ command: 'test child', description: 'test child', shellCommand: shell, agentId }, setAppState)
          holder = holdTranscript()
          await locked.promise
        }
        yield createAssistantMessage({ content: 'finished output' })
        return { reason: 'completed' }
      },
    }))
    const selectedAgent = { agentType: 'general-purpose', source: 'built-in', baseDir: 'built-in', whenToUse: 'test', getSystemPrompt: () => 'test' } as AgentDefinition
    let appState = {
      tasks: {}, todos: { [agentId]: [] }, speculation: { status: 'idle' }, mainLoopModel: 'test-model', mainLoopModelForSession: 'test-model',
      toolPermissionContext: { mode: 'default', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {} },
      mcp: { clients: [], tools: [] },
    } as unknown as AppState
    const setAppState = (updater: (prev: AppState) => AppState) => { appState = updater(appState) }
    const task = registerAsyncAgent({ agentId, description: 'test output', prompt: 'initial prompt', selectedAgent, setAppState })
    const context = {
      options: { commands: [], tools: [], mainLoopModel: 'test-model', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] } },
      abortController: task.abortController,
      readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
      messages: [], getAppState: () => appState, setAppState,
      setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
    } as unknown as ToolUseContext
    const lifecycle = runAsyncAgentLifecycle({
      taskId: agentId, abortController: task.abortController!,
      makeStream: () => runAgent({
        agentDefinition: selectedAgent, promptMessages: [createUserMessage({ content: 'initial prompt' }), createUserMessage({ content: 'remaining initial history' })],
        toolUseContext: context, canUseTool: async () => ({ behavior: 'allow' }),
        isAsync: true, querySource: 'agent:builtin:general-purpose', availableTools: [],
        override: { agentId, abortController: task.abortController, userContext: {}, systemContext: {}, systemPrompt: ['test'] as never },
      }),
      metadata: { prompt: 'initial prompt', resolvedAgentModel: 'test-model', isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: true },
      description: 'test output', toolUseContext: context, rootSetAppState: setAppState,
      agentIdForCleanup: agentId, enableSummarization: false, getWorktreeResult: async () => ({}),
    })
    let cancellationDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      await locked.promise
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(appState.tasks[agentId]?.status).toBe('running')
      expect(queried).toBe(phase === 'incremental')
      if (cancel) {
        killAsyncAgent(agentId, setAppState)
        expect(appState.tasks[agentId]?.status).toBe('killed')
        // Keep storage locked until stopped handling and runner cleanup finish.
        await Promise.race([
          lifecycle,
          new Promise<never>((_, reject) => {
            cancellationDeadline = setTimeout(() => reject(new Error('cancellation is still waiting for transcript storage')), 2_000)
          }),
        ])
        expect(appState.todos).not.toHaveProperty(agentId)
        if (phase === 'incremental') {
          expect(appState.tasks[shellId]?.status).toBe('killed')
          expect(shell?.status).toBe('killed')
          await childExit
        }
      } else {
        release.resolve()
        await lifecycle
      }
      expect(appState.tasks[agentId]?.status).toBe(cancel ? 'killed' : 'completed')
      const notifications = getPendingNotificationsSnapshot().map(item => item.value).join('\n')
      expect(notifications).toContain(`<status>${cancel ? 'killed' : 'completed'}</status>`)
      if (cancel) expect(notifications).not.toContain('<status>completed</status>')
      else {
        const output = await readFile(getTaskOutputPath(agentId), 'utf8')
        expect(output).toContain('initial prompt')
        expect(output).toContain('finished output')
        expect(output.indexOf('initial prompt')).toBeLessThan(output.indexOf('finished output'))
      }
    } finally {
      clearTimeout(cancellationDeadline)
      release.resolve()
      remoteRelease.resolve()
      if (shell?.status === 'running' || shell?.status === 'backgrounded') {
        shell.kill()
        shell.cleanup()
      }
      await childExit
      await holder
      await foreground
      await lifecycle
    }
    // Cancellation releases the runner, not the tracked producer or its messages.
    await flushSessionStorage()
    const persisted = await readFile(transcript, 'utf8')
    expect(persisted).toContain('initial prompt')
    expect(persisted).toContain('remaining initial history')
    if (phase === 'incremental') expect(persisted).toContain('finished output')
  })
}


test('replacement runs join earlier transcript chains for the same agent only', async () => {
  const entered = deferred()
  const release = deferred()
  const replacementEntered = deferred()
  const replacementRelease = deferred()
  let branchCalls = 0
  mock.module('../../utils/git.js', () => ({
    ...actualGit,
    getBranch: async () => {
      branchCalls++
      if (branchCalls === 1) { entered.resolve(); await release.promise }
      if (branchCalls === 3) { replacementEntered.resolve(); await replacementRelease.promise }
      return 'test'
    },
  }))
  const earlier = recordSidechainTranscript([createUserMessage({ content: 'earlier history' })], 'same-agent')
  await entered.promise
  let replacementFinished = false
  const replacement = recordSidechainTranscript([createAssistantMessage({ content: 'replacement answer' })], 'same-agent')
    .then(() => { replacementFinished = true })
  try {
    await recordSidechainTranscript([createUserMessage({ content: 'other output' })], 'other-agent')
    expect(await readFile(getAgentTranscriptPath(asAgentId('other-agent')), 'utf8')).toContain('other output')
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(replacementFinished).toBe(false)
    let flushed = false
    const flush = flushSessionStorage().then(() => { flushed = true })
    release.resolve()
    await replacementEntered.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushed).toBe(false)
    replacementRelease.resolve()
    await Promise.all([earlier, replacement, flush])
    const output = await readFile(getAgentTranscriptPath(asAgentId('same-agent')), 'utf8')
    expect(output.indexOf('earlier history')).toBeLessThan(output.indexOf('replacement answer'))
  } finally {
    release.resolve()
    replacementRelease.resolve()
    await Promise.all([earlier, replacement])
  }
})

}
