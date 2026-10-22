import { PassThrough } from 'node:stream'
import { stripVTControlCharacters as stripAnsi } from 'node:util'

import type { UUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import {
  achieveGoal,
  createGoalState,
  pauseGoal,
} from '../../services/goal/state.js'
import { createRoot } from '../../ink.js'
import { getDefaultAppState, type AppState } from '../../state/AppStateStore.js'
import type { LogOption, ReplaySummary } from '../../types/logs.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

const realSessionStorage = {
  ...await import(`../../utils/sessionStorage.js?real=${Date.now()}-${Math.random()}`),
}
const realGoalPersistence = {
  ...await import(`../../services/goal/persistence.js?real=${Date.now()}-${Math.random()}`),
}
const realGetWorktreePaths = {
  ...await import(`../../utils/getWorktreePaths.js?real=${Date.now()}-${Math.random()}`),
}
const realReplayIndex = {
  ...await import(`../../utils/replayIndex.js?real=${Date.now()}-${Math.random()}`),
}

type OnDoneArgs = Parameters<LocalJSXCommandOnDone>

let saveGoalStateMock: ReturnType<typeof mock>
let loadSameRepoMessageLogsMock: ReturnType<typeof mock>
let searchSessionsByCustomTitleMock: ReturnType<typeof mock>
let loadReplayIndexMock: ReturnType<typeof mock>

async function importFreshResumeModule(): Promise<
  typeof import('./resume.js')
> {
  const unique = `${Date.now()}-${Math.random()}`
  return import(`./resume.js?${unique}`) as Promise<
    typeof import('./resume.js')
  >
}

function makeContext(
  opts: {
    goal?: AppState['goal']
    todos?: AppState['todos']
  } = {},
) {
  let state: AppState = {
    ...getDefaultAppState(),
    goal: opts.goal ?? null,
    todos: opts.todos ?? {},
  }

  return {
    context: {
      getAppState: () => state,
      setAppState: (updater: (prev: AppState) => AppState) => {
        state = updater(state)
      },
      agentId: 'agent-test-123',
    } as unknown as LocalJSXCommandContext,
    getState: () => state,
  }
}

function createTestStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  getOutput: () => string
} {
  let output = ''
  const stdout = new PassThrough()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  ;(stdout as unknown as { columns: number }).columns = 80

  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  return { stdout, stdin, getOutput: () => stripAnsi(output) }
}

const replaySummary: ReplaySummary = {
  totalSteps: 3,
  toolBreakdown: { Read: 1 },
  filesModified: ['src/a.ts'],
  durationMs: 1000,
  startTimestamp: '2026-01-01T00:00:00.000Z',
  endTimestamp: '2026-01-01T00:00:01.000Z',
  userRequests: 1,
  retryAttempts: 0,
  repeatedAttempts: 0,
}

const replaySession = {
  sessionId: '00000000-0000-4000-8000-000000000000' as UUID,
  log: {
    date: '2026-01-01',
    messages: [],
    value: 0,
    created: new Date('2026-01-01T00:00:00.000Z'),
    modified: new Date('2026-01-01T00:00:00.000Z'),
    firstPrompt: 'hello',
    messageCount: 1,
    isSidechain: false,
  } as LogOption,
}

async function renderResumeConfirmation() {
  const { stdin, stdout, getOutput } = createTestStreams()
  const root = await createRoot({
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
  })
  const onResume = mock(() => {})
  const onCancel = mock(() => {})
  const { ResumeConfirmation } = await importFreshResumeModule()

  root.render(
    <ResumeConfirmation
      selectedSession={replaySession}
      sessionSummary={replaySummary}
      resuming={false}
      onResume={onResume}
      onCancel={onCancel}
    />,
  )
  await Bun.sleep(10)

  return {
    stdin,
    root,
    getOutput,
    onResume,
    onCancel,
    cleanup: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    },
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for condition')
}

describe('/resume and /continue unified command', () => {
  beforeEach(() => {
    saveGoalStateMock = mock(() => Promise.resolve())
    loadSameRepoMessageLogsMock = mock(() => Promise.resolve([]))
    searchSessionsByCustomTitleMock = mock(() => Promise.resolve([]))
    loadReplayIndexMock = mock(() => Promise.resolve(null))
    mock.module('../../services/goal/persistence.js', () => ({
      saveGoalState: saveGoalStateMock,
    }))
    mock.module('../../utils/getWorktreePaths.js', () => ({
      getWorktreePaths: () => Promise.resolve([]),
    }))
    mock.module('../../utils/sessionStorage.js', () => ({
      getLastSessionLog: () => Promise.resolve(null),
      getSessionIdFromLog: (log: { sessionId?: string }) => log.sessionId,
      getTranscriptPathForSession: (sessionId: string) => `${sessionId}.jsonl`,
      isCustomTitleEnabled: () => true,
      isLiteLog: () => false,
      loadAllProjectsMessageLogs: () => Promise.resolve([]),
      loadFullLog: (log: unknown) => Promise.resolve(log),
      loadSameRepoMessageLogs: loadSameRepoMessageLogsMock,
      searchSessionsByCustomTitle: searchSessionsByCustomTitleMock,
    }))
    mock.module('../../utils/replayIndex.js', () => ({
      // Bun caches the initial mock's export names, including after restoration.
      ...realReplayIndex,
      loadReplayIndex: loadReplayIndexMock,
    }))
  })

  afterEach(() => {
    mock.restore()
    mock.module('../../utils/sessionStorage.js', () => realSessionStorage)
    mock.module('../../services/goal/persistence.js', () => realGoalPersistence)
    mock.module('../../utils/getWorktreePaths.js', () => realGetWorktreePaths)
    mock.module('../../utils/replayIndex.js', () => realReplayIndex)
  })

  test('/continue continues an active goal', async () => {
    const activeGoal = {
      ...createGoalState('finish the feature'),
      turnCount: 7,
      lastEvaluatedMessageUuid: 'assistant-1',
    }
    const { context, getState } = makeContext({
      goal: activeGoal,
    })
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, '')

    expect(element).toBeNull()
    expect(onDoneResult).toBeDefined()
    expect(onDoneResult![0]).toBe('Goal already active; continuing.')
    expect(onDoneResult![1]?.shouldQuery).toBe(true)
    expect(onDoneResult![1]?.metaMessages).toHaveLength(1)
    expect(onDoneResult![1]?.metaMessages![0]).toContain('finish the feature')
    expect(getState().goal?.status).toBe('active')
    expect(getState().goal?.turnCount).toBe(7)
    expect(getState().goal?.lastEvaluatedMessageUuid).toBe('assistant-1')
  })

  test('/continue resumes a paused goal and continues it', async () => {
    const { context, getState } = makeContext({
      goal: pauseGoal(createGoalState('finish the feature')),
    })
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, '')

    expect(element).toBeNull()
    expect(onDoneResult![0]).toBe('Goal resumed.')
    expect(onDoneResult![1]?.shouldQuery).toBe(true)
    expect(onDoneResult![1]?.metaMessages![0]).toContain('finish the feature')
    expect(getState().goal?.status).toBe('active')
  })

  test('/continue still resumes a paused goal when persistence fails', async () => {
    saveGoalStateMock.mockImplementation(() =>
      Promise.reject(new Error('disk full')),
    )
    const { context, getState } = makeContext({
      goal: pauseGoal(createGoalState('finish the feature')),
    })
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, '')

    expect(element).toBeNull()
    expect(onDoneResult![0]).toBe('Goal resumed.')
    expect(onDoneResult![1]?.shouldQuery).toBe(true)
    expect(onDoneResult![1]?.metaMessages![0]).toContain('finish the feature')
    expect(getState().goal?.status).toBe('active')
    expect(saveGoalStateMock).toHaveBeenCalled()
  })

  test('falls back to session picker when goal is achieved', async () => {
    const { context } = makeContext({
      goal: achieveGoal(createGoalState('finish the feature'), {
        evaluatedMessageUuid: 'assistant-1',
        reason: 'completed',
      }),
    })
    const { call } = await importFreshResumeModule()

    const onDone = mock(() => {})
    const element = await call(onDone as unknown as LocalJSXCommandOnDone, context, '')

    expect(element).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('/continue continues current todos when no goal is set', async () => {
    const { context } = makeContext({
      todos: {
        'agent-test-123': [
          { content: 'write tests', status: 'completed', activeForm: 'write tests' },
          { content: 'run ci', status: 'in_progress', activeForm: 'run ci' },
          { content: 'deploy', status: 'pending', activeForm: 'deploy' },
        ],
      },
    })
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, '')

    expect(element).toBeNull()
    expect(onDoneResult![0]).toBe('Continuing current task.')
    expect(onDoneResult![1]?.shouldQuery).toBe(true)
    const metaMessage = onDoneResult![1]?.metaMessages![0]
    expect(metaMessage).toContain('write tests')
    expect(metaMessage).toContain('run ci')
    expect(metaMessage).toContain('deploy')
    expect(metaMessage).toContain('[done] write tests')
    expect(metaMessage).toContain('[in progress] run ci')
    expect(metaMessage).toContain('[pending] deploy')
    expect(metaMessage).toContain('Resume the most recent task')
  })

  test('falls back to session picker when no goal or todos', async () => {
    const { context } = makeContext()
    const { call } = await importFreshResumeModule()

    const onDone = mock(() => {})
    const element = await call(onDone as unknown as LocalJSXCommandOnDone, context, '')

    expect(element).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('/resume still shows picker when current task state exists', async () => {
    const { context } = makeContext({
      goal: createGoalState('finish the feature'),
      todos: {
        'agent-test-123': [
          { content: 'run ci', status: 'in_progress', activeForm: 'run ci' },
        ],
      },
    })
    const { call } = await importFreshResumeModule()

    const onDone = mock(() => {})
    const element = await call(onDone as unknown as LocalJSXCommandOnDone, context, '')

    expect(element).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('/continue continues from transcript when no goal or todos are tracked', async () => {
    const { context } = makeContext()
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, '')

    expect(element).toBeNull()
    expect(onDoneResult![0]).toBe('Continuing current task.')
    expect(onDoneResult![1]?.shouldQuery).toBe(true)
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'The user asked you to continue.',
    )
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'Resume the most recent task based on the conversation transcript.',
    )
  })

  test('/continue includes an optional user continuation hint', async () => {
    const { context } = makeContext()
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, 'pick up at tests')

    expect(element).toBeNull()
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'User continuation hint:\npick up at tests',
    )
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'The user asked you to continue.',
    )
  })

  test('/continue includes an optional hint with current todos', async () => {
    const { context } = makeContext({
      todos: {
        'agent-test-123': [
          { content: 'run ci', status: 'in_progress', activeForm: 'run ci' },
        ],
      },
    })
    const { continueCall } = await importFreshResumeModule()

    let onDoneResult: OnDoneArgs | undefined
    const onDone = (...args: OnDoneArgs) => {
      onDoneResult = args
    }

    const element = await continueCall(onDone, context, 'focus on the failing tests')

    expect(element).toBeNull()
    expect(onDoneResult![1]?.metaMessages![0]).toContain('[in progress] run ci')
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'User continuation hint:\nfocus on the failing tests',
    )
    expect(onDoneResult![1]?.metaMessages![0]).toContain(
      'The user asked you to continue.',
    )
  })

  test('with args bypasses current-task continuation and searches sessions', async () => {
    const { context } = makeContext({
      goal: createGoalState('finish the feature'),
    })
    const { call } = await importFreshResumeModule()

    const onDone = mock(() => {})
    const element = await call(onDone as unknown as LocalJSXCommandOnDone, context, 'feature')

    expect(element).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
  })

  test('direct /resume session id shows replay summary before resuming', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000123' as UUID
    const log = {
      ...replaySession.log,
      sessionId,
      fullPath: '/tmp/session.jsonl',
    } as LogOption
    loadSameRepoMessageLogsMock.mockImplementation(() => Promise.resolve([log]))
    loadReplayIndexMock.mockImplementation(() =>
      Promise.resolve({
        sessionId,
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        summary: replaySummary,
        steps: [],
      }),
    )
    const resumeMock = mock(() => Promise.resolve())
    const { context } = makeContext()
    ;(context as unknown as { resume: typeof resumeMock }).resume = resumeMock
    const { stdin, stdout, getOutput } = createTestStreams()
    const root = await createRoot({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      patchConsole: false,
    })
    const { call } = await importFreshResumeModule()
    const onDone = mock(() => {})

    try {
      const element = await call(
        onDone as unknown as LocalJSXCommandOnDone,
        context,
        sessionId,
      )
      expect(element).toBeTruthy()
      root.render(element as React.ReactElement)
      await waitFor(() => getOutput().includes('Session Summary'))
      expect(resumeMock).not.toHaveBeenCalled()

      stdin.write('\r')
      await waitFor(() => resumeMock.mock.calls.length === 1)
      stdin.write('\r')
      await Bun.sleep(10)
      expect(resumeMock).toHaveBeenCalledWith(
        sessionId,
        log,
        'slash_command_session_id',
      )
      expect(resumeMock).toHaveBeenCalledTimes(1)
    } finally {
      root.unmount()
      stdin.end()
      stdout.end()
      await Bun.sleep(0)
    }
  })

  test('direct /resume exact title resumes immediately without replay data', async () => {
    const sessionId = '00000000-0000-4000-8000-000000000124' as UUID
    const log = {
      ...replaySession.log,
      sessionId,
      customTitle: 'exact title',
    } as LogOption
    loadSameRepoMessageLogsMock.mockImplementation(() => Promise.resolve([log]))
    searchSessionsByCustomTitleMock.mockImplementation(() =>
      Promise.resolve([log]),
    )
    loadReplayIndexMock.mockImplementation(() => Promise.resolve(null))
    const resumeMock = mock(() => Promise.resolve())
    const { context } = makeContext()
    ;(context as unknown as { resume: typeof resumeMock }).resume = resumeMock
    const { call } = await importFreshResumeModule()
    const onDone = mock(() => {})

    const element = await call(
      onDone as unknown as LocalJSXCommandOnDone,
      context,
      'exact title',
    )

    expect(element).toBeNull()
    await waitFor(() => resumeMock.mock.calls.length === 1)
    expect(resumeMock).toHaveBeenCalledWith(sessionId, log, 'slash_command_title')
  })

  test('replay summary confirmation renders without resuming immediately', async () => {
    const rendered = await renderResumeConfirmation()
    try {
      expect(rendered.getOutput()).toContain('Session Summary')
      expect(rendered.getOutput()).toContain('Press Enter to resume')
      expect(rendered.onResume).not.toHaveBeenCalled()
    } finally {
      await rendered.cleanup()
    }
  })

  test('replay summary confirmation resumes on Enter', async () => {
    const rendered = await renderResumeConfirmation()
    try {
      rendered.stdin.write('\r')
      await Bun.sleep(10)

      expect(rendered.onResume).toHaveBeenCalledWith(replaySession)
      expect(rendered.onCancel).not.toHaveBeenCalled()
    } finally {
      await rendered.cleanup()
    }
  })

  test('replay summary confirmation cancels on Escape', async () => {
    const rendered = await renderResumeConfirmation()
    try {
      rendered.stdin.write('\u001B')

      await waitFor(() => rendered.onCancel.mock.calls.length === 1)
      expect(rendered.onCancel).toHaveBeenCalled()
      expect(rendered.onResume).not.toHaveBeenCalled()
    } finally {
      await rendered.cleanup()
    }
  })
})
