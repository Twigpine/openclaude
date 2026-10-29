import { REAL_PROVIDER_TEST_CHILD_ENV, REAL_PROVIDER_TEST_TIMEOUT_MS, runTestFileWithRealProviders } from '../../test/providerModuleIsolation.js'
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import { getDefaultAppState } from '../../state/AppStateStore.js'
import { clearConversation } from '../../commands/clear/conversation.js'
import { runForkedAgent } from '../../utils/forkedAgent.js'
import { AbortError } from '../../utils/errors.js'
import { spawn } from 'node:child_process'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { TaskOutput } from '../../utils/task/TaskOutput.js'
import { registerForeground } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { AppState } from '../../state/AppState.js'
import type { ToolUseContext } from '../../Tool.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../../test/sharedMutationLock.js'
import { asAgentId, asSessionId } from '../../types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { FileStateCache, createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE } from '../../utils/fileStateCache.js'
import { setClaudeConfigHomeDirForTesting } from '../../utils/envUtils.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getAgentTranscript, readAgentMetadata, writeAgentMetadata, setAgentTranscriptSubdir, getAgentTranscriptPath, getProjectDir, resetSessionFilePointer, recordSidechainTranscript, recordTranscript, setInternalEventWriter, resetProjectForTesting, flushSessionStorage } from '../../utils/sessionStorage.js'
import { withTranscriptFileLock } from '../../utils/transcriptFileLock.js'
import { registerAsyncAgent, registerAgentForeground, backgroundAgentTask, completeAgentTask, killAsyncAgent } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getTaskOutputPath, _clearOutputsForTest } from '../../utils/task/diskOutput.js'
import { clearPendingNotifications, getPendingNotificationsSnapshot } from '../../utils/messageQueueManager.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { runAgent } from './runAgent.js'
import { executeStopHooks } from '../../utils/hooks.js'
import { addSessionHook } from '../../utils/hooks/sessionHooks.js'
import { resumeAgentBackground } from './resumeAgent.js'
import { startBackgroundSession } from '../../tasks/LocalMainSessionTask.js'
import type { AgentDefinition } from './loadAgentsDir.js'

const actualStorage = { ...await import('../../utils/sessionStorage.js') }
const actualDiskOutput = { ...await import('../../utils/task/diskOutput.js') }
const actualUuid = { ...await import('../../utils/uuid.js') }
let originalSession: ReturnType<typeof getSessionId>
let originalProjectDir: ReturnType<typeof getSessionProjectDir>
let oldSimple: string | undefined
const actualGit = { ...await import('../../utils/git.js') }
const actualQuery = { ...await import('../../query.js') }
let configDir: string
let oldPersistence: string | undefined

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(res => { resolve = res })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for agent lifecycle checkpoint')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// Use the existing clean-child harness: other agent tests replace these
// production modules globally, and this test needs real registration/storage.
if (process.env[REAL_PROVIDER_TEST_CHILD_ENV] !== '1') {
  test('agent output regression cases in a clean process', () =>
    runTestFileWithRealProviders(import.meta.path), REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000)
} else {
beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/runAgent.output.test.ts')
  originalSession = getSessionId()
  originalProjectDir = getSessionProjectDir()
  switchSession(originalSession, undefined)
  oldSimple = process.env.CLAUDE_CODE_SIMPLE
  process.env.CLAUDE_CODE_SIMPLE = '1'
  oldPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  configDir = await mkdtemp(join(tmpdir(), 'agent-output-'))
  setClaudeConfigHomeDirForTesting(configDir)
  resetSettingsCache()
  resetProjectForTesting()
  getProjectDir.cache.clear?.()
  clearPendingNotifications()
  expect(getAgentTranscriptPath(asAgentId('fixture-check')).startsWith(configDir + sep)).toBe(true)
})
afterEach(async () => {
  try {
    mock.module('../../utils/sessionStorage.js', () => actualStorage)
    mock.module('../../query.js', () => actualQuery)
    mock.module('../../utils/git.js', () => actualGit)
    mock.module('../../utils/uuid.js', () => actualUuid)
    mock.module('../../utils/task/diskOutput.js', () => actualDiskOutput)
    await flushSessionStorage()
    await _clearOutputsForTest()
    clearPendingNotifications()
    resetProjectForTesting()
    switchSession(originalSession, originalProjectDir)
    getProjectDir.cache.clear?.()
    setClaudeConfigHomeDirForTesting(undefined)
    if (oldSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
    else process.env.CLAUDE_CODE_SIMPLE = oldSimple
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
    const submitted = deferred()
    let branchCalls = 0
    mock.module('../../utils/git.js', () => ({ ...actualGit, getBranch: async () => {
      // This checkpoint is inside the submitted storage chain, after metadata
      // persistence. The held file lock still prevents its physical append.
      if (++branchCalls === (phase === 'incremental' ? 2 : 1)) submitted.resolve()
      return 'test'
    } }))
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
      await submitted.promise
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

// Retain the standalone physical-readiness oracle in this real-module process.
test('sidechain write resolves only after its file is readable, without a session flush', async () => {
  const agentId = asAgentId('durable-agent')
  const path = getAgentTranscriptPath(agentId)
  const release = deferred()
  const locked = deferred()
  let holder: Promise<void> | undefined
  let writing: Promise<void> | undefined
  try {
    await mkdir(dirname(path), { recursive: true })
    holder = withTranscriptFileLock(path, async () => { locked.resolve(); await release.promise })
    await locked.promise
    let settled = false
    writing = recordSidechainTranscript([createUserMessage({ content: 'durable output' })], agentId)
      .then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(settled).toBe(false)
    release.resolve()
    await writing
    expect(await readFile(path, 'utf8')).toContain('durable output')
  } finally {
    release.resolve()
    await holder
    await writing
  }
})

test('live-destination sidechain chains preserve submission order', async () => {
  const agentId = asAgentId('live-chain-order')
  const entered = deferred()
  const release = deferred()
  let calls = 0
  mock.module('../../utils/git.js', () => ({ ...actualGit, getBranch: async () => {
    if (++calls === 1) { entered.resolve(); await release.promise }
    return 'test'
  } }))
  const first = createUserMessage({ content: 'first live chain' })
  const second = createAssistantMessage({ content: 'second live chain' })
  const writing = recordSidechainTranscript([first], agentId, null, { captureDestination: false })
  await entered.promise
  const queued = recordSidechainTranscript([second], agentId, first.uuid, { captureDestination: false })
  try {
    release.resolve()
    await Promise.all([writing, queued])
    const entries = (await readFile(getAgentTranscriptPath(agentId), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.map(entry => entry.uuid)).toEqual([first.uuid, second.uuid])
  } finally {
    release.resolve()
    await Promise.all([writing, queued])
  }
})

test('queued sidechain chains keep their destination and session across clear pointer reset', async () => {
  const agentId = asAgentId('session-boundary')
  const sessionA = getSessionId()
  const pathA = getAgentTranscriptPath(agentId)
  const first = createUserMessage({ content: 'A initial' })
  const tail = createAssistantMessage({ content: 'A tail' })
  const answer = createAssistantMessage({ content: 'A queued answer' })
  const release = deferred()
  const locked = deferred()
  let holder: Promise<void> | undefined
  let initial: Promise<void> | undefined
  let queued: Promise<void> | undefined
  try {
    await mkdir(dirname(pathA), { recursive: true })
    holder = withTranscriptFileLock(pathA, async () => { locked.resolve(); await release.promise })
    await locked.promise
    initial = recordSidechainTranscript([first, tail], agentId)
    queued = recordSidechainTranscript([answer], agentId, tail.uuid)
    await new Promise(resolve => setTimeout(resolve, 150))
    switchSession(asSessionId(randomUUID()))
    await resetSessionFilePointer()
    const sessionB = getSessionId()
    const pathB = getAgentTranscriptPath(agentId)
    await recordSidechainTranscript([createUserMessage({ content: 'B new output' })], agentId)
    expect(await readFile(pathB, 'utf8')).toContain('B new output')
    release.resolve()
    await Promise.all([initial, queued])
    const a = (await readFile(pathA, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const b = (await readFile(pathB, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(a.map(entry => entry.uuid)).toEqual([first.uuid, tail.uuid, answer.uuid])
    expect(a.map(entry => entry.sessionId)).toEqual([sessionA, sessionA, sessionA])
    expect(a.map(entry => entry.parentUuid)).toEqual([null, first.uuid, tail.uuid])
    expect(b).toHaveLength(1)
    expect(b[0].sessionId).toBe(sessionB)
  } finally {
    release.resolve()
    await Promise.all([holder, initial, queued])
  }
})

for (const foreground of [false, true]) {
  test(`clear preserves finished ${foreground ? 'foreground' : 'async'} output while initialization is pending`, async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (prev: AppState) => AppState) => { state = update(state) }
    const agentId = asAgentId(`finished-${foreground}`)
    const activeId = asAgentId(`active-${foreground}`)
    const release = deferred()
    const links: Promise<string>[] = []
    const liveLinks: Promise<string>[] = []
    const releaseRetarget = deferred()
    const releaseInitial = deferred()
    mock.module('../../utils/task/diskOutput.js', () => ({
      ...actualDiskOutput,
      initTaskOutputAsSymlink: (id: string, path: string) => {
        const ready = id === agentId ? (links[0] ?? release.promise) : liveLinks.length ? releaseRetarget.promise : foreground ? releaseInitial.promise : Promise.resolve()
        const link = ready.then(() => actualDiskOutput.initTaskOutputAsSymlink(id, path))
        if (id === agentId) links.push(link)
        else liveLinks.push(link)
        return link
      },
    }))
    const selectedAgent = { agentType: 'test' } as AgentDefinition
    const register = foreground ? registerAgentForeground : registerAsyncAgent
    register({ agentId, description: 'finished', prompt: 'test', selectedAgent, setAppState })
    if (foreground) backgroundAgentTask(agentId, () => state, setAppState)
    const active = registerAsyncAgent({ agentId: activeId, description: 'active', prompt: 'test', selectedAgent, setAppState })
    if (!foreground) await active.outputReady
    await recordSidechainTranscript([createUserMessage({ content: 'finished readable output' })], agentId)
    const finish = () => completeAgentTask({ agentId, content: [] } as never, setAppState)
    let completion = foreground ? undefined : finish()
    let activeCompletion: Promise<boolean> | undefined
    try {
      expect(state.tasks[agentId]?.status).toBe('running')
      await clearConversation({ setMessages: () => { completion ??= finish() }, readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE), getAppState: () => state, setAppState })
      release.resolve()
      await completion
      await Promise.all(links)
      expect(state.tasks[agentId]?.status).toBe('completed')
      expect(await readFile(getTaskOutputPath(agentId), 'utf8')).toContain('finished readable output')
      expect(links).toHaveLength(1)
      // A genuine live producer must still migrate and expose new-session output.
      await recordSidechainTranscript([createUserMessage({ content: 'new active output' })], activeId)
      activeCompletion = completeAgentTask({ agentId: activeId, content: [] } as never, setAppState)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(state.tasks[activeId]?.status).toBe('running')
      releaseRetarget.resolve()
      if (foreground) {
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(state.tasks[activeId]?.status).toBe('running')
      }
      releaseInitial.resolve()
      await activeCompletion
      expect(state.tasks[activeId]?.status).toBe('completed')
      expect(liveLinks).toHaveLength(2)
      expect(await readFile(getTaskOutputPath(activeId), 'utf8')).toContain('new active output')
    } finally {
      release.resolve()
      await completion
      await Promise.all(links)
      releaseRetarget.resolve()
      releaseInitial.resolve()
      await activeCompletion
      await Promise.all(liveLinks)
      killAsyncAgent(activeId, setAppState)
    }
  })
}

for (const foreground of [false, true]) {
  for (const continuesInB of [false, true]) {
    test(`final ${foreground ? 'foreground' : 'async'} write spanning clear stays readable, continued=${continuesInB}`, async () => {
      const agentId = asAgentId(`final-clear-${foreground}-${continuesInB}`)
      let state = getDefaultAppState()
      const setAppState = (update: (prev: AppState) => AppState) => { state = update(state) }
      const entered = deferred()
      const release = deferred()
      let holdNextBranch = false
      mock.module('../../utils/git.js', () => ({ ...actualGit, getBranch: async () => {
        if (holdNextBranch) { holdNextBranch = false; entered.resolve(); await release.promise }
        return 'test'
      } }))
      let hookPath: string | undefined
      let verifierPath: string | undefined
      let verifierRules: readonly string[] | undefined
      mock.module('../../query.js', () => ({ ...actualQuery, query: async function* (params: Parameters<typeof actualQuery.query>[0]) {
        if (params.querySource === 'hook_agent') {
          const text = JSON.stringify(params.messages)
          const inputText = params.messages[0]
          if (inputText?.type !== 'user' || typeof inputText.message.content !== 'string') throw new Error(`unexpected hook input ${text}`)
          hookPath = JSON.parse(inputText.message.content).agent_transcript_path
          verifierPath = params.systemPrompt.join('\n').match(/available at: ([^\n]+)/)?.[1]
          verifierRules = params.toolUseContext.getAppState().toolPermissionContext.alwaysAllowRules.session
          yield { type: 'attachment', attachment: { type: 'structured_output', data: { ok: true } }, uuid: randomUUID(), timestamp: new Date().toISOString() } as never
          return { reason: 'completed' }
        }
        holdNextBranch = true
        yield createAssistantMessage({ content: 'final A answer' })
        if (continuesInB) yield createAssistantMessage({ content: 'continued B answer' })
        addSessionHook(setAppState, agentId, 'SubagentStop', '', { type: 'agent', prompt: '$ARGUMENTS', model: 'test-model' })
        const simple = process.env.CLAUDE_CODE_SIMPLE
        delete process.env.CLAUDE_CODE_SIMPLE
        try {
          for await (const _result of executeStopHooks(undefined, params.toolUseContext.abortController.signal, 1000, false, agentId, params.toolUseContext, params.messages)) { /* consume actual hook dispatch */ }
        } finally { process.env.CLAUDE_CODE_SIMPLE = simple }
        return { reason: 'completed' }
      } }))
      const selectedAgent = { agentType: continuesInB ? 'general-purpose' : 'retained-agent', source: continuesInB ? 'built-in' : 'userSettings', baseDir: 'built-in', whenToUse: 'test', getSystemPrompt: () => 'test' } as AgentDefinition
      const transcriptSubdir = foreground && !continuesInB ? join('workflows', 'retained') : undefined
      if (transcriptSubdir) {
        switchSession(getSessionId(), getProjectDir(join(configDir, 'resumed-project')))
        setAgentTranscriptSubdir(agentId, transcriptSubdir)
      }
      const register = foreground ? registerAgentForeground : registerAsyncAgent
      register({ agentId, description: 'clear output', prompt: 'initial prompt', selectedAgent, setAppState })
      const task = state.tasks[agentId]
      if (task?.type !== 'local_agent') throw new Error('expected registered local agent')
      if (foreground) backgroundAgentTask(agentId, () => state, setAppState)
      const pathA = getAgentTranscriptPath(agentId)
      const context = {
        options: { commands: [], tools: [], mainLoopModel: 'test-model', thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {}, agentDefinitions: { activeAgents: [], allAgents: [] } },
        abortController: task.abortController, readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE),
        messages: [], getAppState: () => state, setAppState,
        setInProgressToolUseIDs: () => {}, setResponseLength: () => {}, updateFileHistoryState: () => {}, updateAttributionState: () => {},
      } as unknown as ToolUseContext
      const lifecycle = runAsyncAgentLifecycle({
        taskId: agentId, abortController: task.abortController!,
        makeStream: () => runAgent({
          agentDefinition: selectedAgent, promptMessages: [createUserMessage({ content: 'initial prompt' })],
          toolUseContext: context, canUseTool: async () => ({ behavior: 'allow' }), isAsync: true,
          querySource: 'agent:builtin:general-purpose', availableTools: [], transcriptSubdir,
          override: { agentId, abortController: task.abortController, userContext: {}, systemContext: {}, systemPrompt: ['test'] as never },
        }),
        metadata: { prompt: 'initial prompt', resolvedAgentModel: 'test-model', isBuiltInAgent: true, startTime: Date.now(), agentType: 'general-purpose', isAsync: true },
        description: 'clear output', toolUseContext: context, rootSetAppState: setAppState,
        agentIdForCleanup: agentId, enableSummarization: false, getWorktreeResult: async () => ({}),
      })
      try {
        await entered.promise
        await clearConversation({ setMessages: () => {}, readFileState: context.readFileState, getAppState: () => state, setAppState })
        await recordTranscript([createUserMessage({ content: 'new main B conversation' })])
        const pathB = getAgentTranscriptPath(agentId)
        expect(pathB).not.toBe(pathA)
        release.resolve()
        await lifecycle
        expect(state.tasks[agentId]?.status).toBe('completed')
        expect(await readFile(pathA, 'utf8')).toContain('final A answer')
        const output = await readFile(getTaskOutputPath(agentId), 'utf8')
        expect(output).toContain(continuesInB ? 'continued B answer' : 'final A answer')
        expect(hookPath).toBe(continuesInB ? pathB : pathA)
        expect(verifierPath).toBe(hookPath)
        expect(verifierRules).toContain(`Read(/${hookPath})`)
        expect(await readFile(verifierPath!, 'utf8')).toContain(continuesInB ? 'continued B answer' : 'final A answer')
        expect(getPendingNotificationsSnapshot().map(item => item.value).join('\n')).toContain('<status>completed</status>')
        const transcript = await getAgentTranscript(agentId)
        expect(JSON.stringify(transcript?.messages)).toContain(continuesInB ? 'continued B answer' : 'final A answer')
        if (!continuesInB) {
          expect(await readAgentMetadata(agentId)).toMatchObject({ agentType: selectedAgent.agentType, source: selectedAgent.source })
          context.options.agentDefinitions.activeAgents = []
          const resume = () => resumeAgentBackground({ agentId, prompt: 'continue after clear', toolUseContext: context, canUseTool: async () => ({ behavior: 'allow' }) })
          await expect(resume()).rejects.toThrow('unavailable or disabled')
          context.options.agentDefinitions.activeAgents = [{ ...selectedAgent, source: 'projectSettings' } as AgentDefinition]
          await expect(resume()).rejects.toThrow('identity mismatch')
        }
        context.options.agentDefinitions.activeAgents = [selectedAgent]
        const resumed = deferred()
        let resumedMessages: unknown
        mock.module('../../query.js', () => ({ ...actualQuery, query: async function* ({ messages }: { messages: unknown }) {
          resumedMessages = structuredClone(messages)
          yield createAssistantMessage({ content: 'resumed answer' })
        } }))
        // Observe actual lifecycle completion, not only resume's admission result.
        context.setAppState = update => {
          setAppState(update)
          if (state.tasks[agentId]?.status !== 'running') resumed.resolve()
        }
        const result = await resumeAgentBackground({ agentId, prompt: 'continue after clear', toolUseContext: context, canUseTool: async () => ({ behavior: 'allow' }) })
        await resumed.promise
        expect(state.tasks[agentId]?.status).toBe('completed')
        expect(JSON.stringify(resumedMessages)).toContain(continuesInB ? 'continued B answer' : 'final A answer')
        expect(JSON.stringify(resumedMessages)).toContain('continue after clear')
        expect(await readFile(result.outputFile, 'utf8')).toContain('resumed answer')
        if (!foreground && !continuesInB) {
          // Two real SendMessage resumes may both pass stopped-task admission
          // before their disk reads finish. The older completion cannot own B.
          const { SendMessageTool } = await import('../SendMessageTool/SendMessageTool.js')
          const { TaskStopTool } = await import('../TaskStopTool/TaskStopTool.js')
          const firstRead = deferred()
          const secondRead = deferred()
          const oldLink = deferred()
          const secondQueryDone = deferred()
          let reads = 0
          let links = 0
          let queries = 0
          mock.module('../../utils/sessionStorage.js', () => ({ ...actualStorage, readAgentMetadata: async (id: typeof agentId) => {
            const read = ++reads
            const meta = await actualStorage.readAgentMetadata(id)
            await (read === 1 ? firstRead : secondRead).promise
            return meta
          } }))
          mock.module('../../utils/task/diskOutput.js', () => ({ ...actualDiskOutput, initTaskOutputAsSymlink: (id: string, path: string) =>
            (++links === 1 ? oldLink.promise : Promise.resolve()).then(() => actualDiskOutput.initTaskOutputAsSymlink(id, path)),
          }))
          mock.module('../../query.js', () => ({ ...actualQuery, query: async function* (params: Parameters<typeof actualQuery.query>[0]) {
            if (++queries === 1) { yield createAssistantMessage({ content: 'older resume answer' }); return { reason: 'completed' } }
            try {
              await new Promise<void>(resolve => params.toolUseContext.abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
            } finally { secondQueryDone.resolve() }
            return { reason: 'completed' }
          } }))
          state.agentNameRegistry.set('overlap-target', agentId)
          const send = () => SendMessageTool.call({ to: 'overlap-target', message: 'resume overlap' }, context, async () => ({ behavior: 'allow' }), {} as never)
          const firstResume = send()
          await waitFor(() => reads === 1)
          const secondResume = send()
          try {
            await waitFor(() => reads === 2)
            firstRead.resolve()
            expect((await firstResume).data.success).toBe(true)
            await waitFor(() => state.tasks[agentId]?.type === 'local_agent' && state.tasks[agentId].producerFinished === true)
            const first = state.tasks[agentId]
            if (first?.type !== 'local_agent') throw new Error('missing first resume')
            secondRead.resolve()
            expect((await secondResume).data.success).toBe(true)
            await waitFor(() => queries === 2)
            const successor = state.tasks[agentId]
            if (successor?.type !== 'local_agent') throw new Error('missing successor')
            oldLink.resolve()
            await first.outputReady
            await actualDiskOutput._clearOutputsForTest()
            await new Promise(resolve => setTimeout(resolve, 0))
            expect(state.tasks[agentId]?.status).toBe('running')
            expect(await TaskStopTool.validateInput({ task_id: agentId }, context)).toEqual({ result: true })
            await TaskStopTool.call({ task_id: agentId }, context)
            expect(successor.abortController!.signal.aborted).toBe(true)
            await secondQueryDone.promise
            await waitFor(() => getPendingNotificationsSnapshot().some(item => typeof item.value === 'string' && item.value.includes('<status>killed</status>')))
          } finally {
            firstRead.resolve()
            secondRead.resolve()
            oldLink.resolve()
            await Promise.all([firstResume, secondResume])
            killAsyncAgent(agentId, setAppState)
            if (queries === 2) await secondQueryDone.promise
          }
        }
      } finally {
        release.resolve()
        await lifecycle
      }
    })
  }
}

for (const foreground of [false, true]) {
  test(`cancelled reconciliation stays before ${foreground ? 'foreground' : 'async'} successor links after eviction`, async () => {
    const agentId = asAgentId(`cancelled-link-${foreground}`)
    let state = getDefaultAppState()
    const setAppState = (update: (prev: AppState) => AppState) => { state = update(state) }
    const params = { agentId, description: 'old', prompt: 'old', selectedAgent: { agentType: 'test' } as AgentDefinition, setAppState }
    const old = registerAsyncAgent(params)
    await old.outputReady
    const pathA = getAgentTranscriptPath(agentId)
    await recordSidechainTranscript([createUserMessage({ content: 'old A output' })], agentId)
    state.tasks[agentId] = { ...old, outputDestination: pathA }
    const entered = deferred()
    const release = deferred()
    const links: Promise<string>[] = []
    mock.module('../../utils/task/diskOutput.js', () => ({ ...actualDiskOutput, initTaskOutputAsSymlink: (id: string, path: string) => {
      const wait = path === pathA ? release.promise : Promise.resolve()
      if (path === pathA) entered.resolve()
      const link = wait.then(() => actualDiskOutput.initTaskOutputAsSymlink(id, path))
      links.push(link)
      return link
    } }))
    const completionA = completeAgentTask({ agentId, content: [] } as never, setAppState).catch(error => error)
    let completionB: Promise<boolean> | undefined
    try {
      await entered.promise
      killAsyncAgent(agentId, setAppState)
      expect(await completionA).toBeInstanceOf(AbortError)
      // Terminal records can be evicted before abandoned filesystem work settles.
      setAppState(prev => { const { [agentId]: removed, ...tasks } = prev.tasks; return { ...prev, tasks } })
      await clearConversation({ setMessages: () => {}, readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE), getAppState: () => state, setAppState })
      const register = foreground ? registerAgentForeground : registerAsyncAgent
      register({ ...params, description: 'successor' })
      await recordSidechainTranscript([createUserMessage({ content: 'new B output' })], agentId)
      completionB = completeAgentTask({ agentId, content: [] } as never, setAppState)
      await new Promise(resolve => setTimeout(resolve, 20))
      const statusWhileAWasPending = state.tasks[agentId]?.status
      release.resolve()
      await completionB
      await Promise.all(links)
      expect(await readFile(getTaskOutputPath(agentId), 'utf8')).toContain('new B output')
      expect(statusWhileAWasPending).toBe('running')
    } finally {
      release.resolve()
      await completionA
      await completionB
      await Promise.all(links)
      killAsyncAgent(agentId, setAppState)
    }
  })
}

for (const captureDestination of [true, false]) {
  for (const swappedTarget of ['agent', 'project']) {
    test(`retained transcript lookup rejects another ${swappedTarget}'s output link, captured=${captureDestination}`, async () => {
      const agentId = asAgentId('retained-producer')
      const pathA = getAgentTranscriptPath(agentId)
      const metadata = { agentType: 'retained-agent', source: 'userSettings' }
      await writeAgentMetadata(agentId, metadata)
      await recordSidechainTranscript([createUserMessage({ content: 'recorded producer history' })], agentId, undefined, { captureDestination })
      let target: string
      if (swappedTarget === 'agent') {
        const otherId = asAgentId('other-producer')
        target = getAgentTranscriptPath(otherId)
        await writeAgentMetadata(otherId, metadata)
        await recordSidechainTranscript([createUserMessage({ content: 'other producer history' })], otherId, undefined, { captureDestination })
      } else {
        target = join(getProjectDir(join(configDir, 'other-project')), getSessionId(), 'subagents', `agent-${agentId}.jsonl`)
        await mkdir(dirname(target), { recursive: true })
        // Matching agent content and filename cannot establish producer ownership.
        await writeFile(target, await readFile(pathA, 'utf8'))
        await writeFile(target.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(metadata))
      }
      switchSession(asSessionId(randomUUID()))
      await resetSessionFilePointer()
      await actualDiskOutput.initTaskOutputAsSymlink(agentId, pathA)
      expect(JSON.stringify((await getAgentTranscript(agentId))?.messages)).toContain('recorded producer history')
      expect(await readAgentMetadata(agentId)).toEqual(metadata)
      await actualDiskOutput.initTaskOutputAsSymlink(agentId, target)
      expect(await getAgentTranscript(agentId)).toBeNull()
      expect(await readAgentMetadata(agentId)).toBeNull()
    })
  }
}

test('retained transcript lookup rejects output links outside generated agent storage', async () => {
  const agentId = asAgentId('retained-path-guard')
  const pathA = getAgentTranscriptPath(agentId)
  await writeAgentMetadata(agentId, { agentType: 'retained-agent', source: 'userSettings' })
  await recordSidechainTranscript([createUserMessage({ content: 'retained history' })], agentId)
  const transcript = await readFile(pathA, 'utf8')
  switchSession(asSessionId(randomUUID()))
  for (const target of [
    join(configDir, `agent-${agentId}.jsonl`),
    join(dirname(pathA), 'agent-other.jsonl'),
    join(getProjectDir(configDir), 'invalid-session', 'subagents', `agent-${agentId}.jsonl`),
  ]) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, transcript)
    await writeFile(target.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'retained-agent', source: 'userSettings' }))
    await actualDiskOutput.initTaskOutputAsSymlink(agentId, target)
    expect(await getAgentTranscript(agentId)).toBeNull()
    expect(await readAgentMetadata(agentId)).toBeNull()
  }
})

for (const continuesInB of [false, true]) {
  test(`Ctrl+B final write spanning clear stays advertised, continued=${continuesInB}`, async () => {
    let state = getDefaultAppState()
    const setAppState = (update: (prev: AppState) => AppState) => { state = update(state) }
    const entered = deferred()
    const release = deferred()
    const finish = deferred()
    const settled = deferred()
    let holdNextBranch = false
    mock.module('../../utils/git.js', () => ({ ...actualGit, getBranch: async () => {
      if (holdNextBranch) { holdNextBranch = false; entered.resolve(); await release.promise }
      return 'test'
    } }))
    const handle = startBackgroundSession({
      description: 'main session clear output', setAppState,
      prepare: async () => ({ messages: [createUserMessage({ content: 'main session initial' })], queryParams: {} as never }),
      queryImpl: async function* () {
        await flushSessionStorage()
        holdNextBranch = true
        yield createAssistantMessage({ content: 'main session final A answer' })
        await finish.promise
        if (continuesInB) {
          yield createAssistantMessage({ content: 'main session continued B answer' })
          await flushSessionStorage()
        }
        return { reason: 'completed' }
      },
      onSettled: () => settled.resolve(),
    })
    try {
      await entered.promise
      await clearConversation({ setMessages: () => {}, readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE), getAppState: () => state, setAppState })
      await recordTranscript([createUserMessage({ content: 'new foreground B' })])
      release.resolve()
      await flushSessionStorage()
      finish.resolve()
      await settled.promise
      await actualDiskOutput._clearOutputsForTest()
      expect(state.tasks[handle.taskId]?.status).toBe('completed')
      expect(getPendingNotificationsSnapshot().map(item => item.value).join('\n')).toContain(getTaskOutputPath(handle.taskId))
      expect(await readFile(getTaskOutputPath(handle.taskId), 'utf8')).toContain(continuesInB ? 'main session continued B answer' : 'main session final A answer')
    } finally {
      release.resolve()
      finish.resolve()
      await settled.promise
    }
  })
}

for (const phase of ['initial', 'incremental'] as const) {
  test(`fork cancellation escapes a blocked ${phase} transcript and cleans its context`, async () => {
    const agentId = asAgentId(`fork-${phase}`)
    mock.module('../../utils/uuid.js', () => ({ ...actualUuid, createAgentId: () => agentId }))
    const path = getAgentTranscriptPath(agentId)
    const release = deferred()
    const locked = deferred()
    let holder: Promise<void> | undefined
    const hold = () => withTranscriptFileLock(path, async () => { locked.resolve(); await release.promise })
    await mkdir(dirname(path), { recursive: true })
    if (phase === 'initial') { holder = hold(); await locked.promise }
    mock.module('../../query.js', () => ({ ...actualQuery, query: async function* ({ toolUseContext }: { toolUseContext: ToolUseContext }) {
      if (toolUseContext.abortController.signal.aborted) throw new AbortError()
      holder = hold()
      await locked.promise
      yield createAssistantMessage({ content: 'fork answer' })
    } }))
    const controller = new AbortController()
    const context = { abortController: controller, readFileState: createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE), getAppState: getDefaultAppState, options: { mainLoopModel: 'test-model' }, messages: [] } as unknown as ToolUseContext
    const clear = spyOn(FileStateCache.prototype, 'clear')
    const fork = runForkedAgent({ promptMessages: [createUserMessage({ content: 'fork initial' })], cacheSafeParams: { toolUseContext: context, forkContextMessages: [], systemPrompt: [] as never, userContext: {}, systemContext: {} }, canUseTool: async () => ({ behavior: 'allow' }), querySource: 'compact', forkLabel: 'compact' })
    const outcome = fork.then(() => 'finished', error => error)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await locked.promise
      await new Promise(resolve => setTimeout(resolve, 150))
      controller.abort()
      const result = await Promise.race([outcome, new Promise(resolve => { deadline = setTimeout(() => resolve('still blocked'), 2_000) })])
      expect(result).toBeInstanceOf(AbortError)
      expect(clear).toHaveBeenCalled()
    } finally {
      clearTimeout(deadline)
      release.resolve()
      await holder
      await outcome
      clear.mockRestore()
    }
    await flushSessionStorage()
    const output = await readFile(path, 'utf8')
    expect(output).toContain('fork initial')
    if (phase === 'incremental') expect(output).toContain('fork answer')
  })
}

}
