import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  setOriginalCwd,
  setProjectRoot,
  getProjectRoot,
  setSessionPersistenceDisabled,
  switchSession,
} from '../../bootstrap/state.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as analyticsNs from '../../services/analytics/index.js'
import type {
  LocalJSXCommandContext,
  ResumeEntrypoint,
} from '../../types/command.js'
import type {
  LogOption,
  SessionBranchEntry,
  TranscriptMessage,
} from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import {
  getClaudeConfigHomeDir,
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import {
  getProjectDir,
  getTranscriptPath,
  loadTranscriptFromFile,
  loadTranscriptFile,
  recordTranscript,
  resetProjectForTesting,
} from '../../utils/sessionStorage.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'

const tempDirs: string[] = []
const ts = '2026-06-28T09:00:00.000Z'
const sourceSessionId = '00000000-0000-4000-8000-000000000111' as UUID
const parentSessionId = '00000000-0000-4000-8000-000000000222' as UUID
const rootSessionId = '00000000-0000-4000-8000-000000000333' as UUID
const realAnalytics = { ...analyticsNs }

let originalNodeEnv: string | undefined
let originalTestPersistence: string | undefined
let originalPersistence: string | undefined
let originalCwd: string
let originalProjectRoot: string
let originalSessionId: string
let originalSessionProjectDir: string | null
let originalPersistenceDisabled: boolean
let originalClaudeConfigHomeDirOverride: string | undefined
let analyticsEvents: Array<{
  name: string
  metadata: Record<string, unknown>
}> = []

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function userMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  content: string,
  timestamp = ts,
) {
  return {
    uuid,
    parentUuid,
    timestamp,
    type: 'user',
    isMeta: false,
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp/project',
    sessionId: sourceSessionId,
    version: 'test',
    message: {
      role: 'user',
      content,
    },
  } as unknown as TranscriptMessage
}

function assistantMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  content: string,
  timestamp = ts,
) {
  return {
    uuid,
    parentUuid,
    timestamp,
    type: 'assistant',
    isSidechain: false,
    userType: 'external',
    cwd: '/tmp/project',
    sessionId: sourceSessionId,
    version: 'test',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as TranscriptMessage
}

function userToolResultMessage(
  uuid: UUID,
  parentUuid: UUID | null,
  toolUseId: string,
  timestamp = ts,
) {
  return {
    ...userMessage(uuid, parentUuid, '', timestamp),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'large retained output',
          is_error: false,
        },
      ],
    },
  } as unknown as TranscriptMessage
}

function systemMessage(uuid: UUID, parentUuid: UUID | null, content: string) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    type: 'system',
    content,
    isMeta: false,
    isSidechain: false,
    cwd: '/tmp/project',
    sessionId: sourceSessionId,
    version: 'test',
  } as unknown as TranscriptMessage
}

function contextMessageFrom(entry: TranscriptMessage): Message {
  if (entry.type === 'user') {
    const message = createUserMessage({
      content: entry.message.content,
      uuid: entry.uuid,
      timestamp: entry.timestamp,
      isMeta: entry.isMeta,
    })
    return {
      ...message,
      isSidechain: entry.isSidechain,
    }
  }

  if (entry.type === 'assistant') {
    const message = createAssistantMessage({
      content: entry.message.content,
      usage: entry.message.usage,
    })
    return {
      ...message,
      uuid: entry.uuid,
      timestamp: entry.timestamp,
      isSidechain: entry.isSidechain,
      message: {
        ...message.message,
        ...entry.message,
      },
    }
  }

  throw new Error(`Unsupported context fixture message type: ${entry.type}`)
}

function sessionBranchEntry(
  overrides: Partial<SessionBranchEntry> = {},
): SessionBranchEntry {
  return {
    type: 'session-branch',
    sessionId: sourceSessionId,
    parentSessionId,
    rootSessionId,
    branchedFromSessionId: parentSessionId,
    branchName: 'first branch',
    branchedAt: ts,
    branchedAtMessageId: id(2),
    ...overrides,
  }
}

async function readEntries(path: string): Promise<Record<string, unknown>[]> {
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

async function loadSessionStorageFromRealModule(): Promise<
  typeof import('../../utils/sessionStorage.js')
> {
  const unique = `${Date.now()}-${Math.random()}`
  return import(`../../utils/sessionStorage.ts?${unique}`) as Promise<
    typeof import('../../utils/sessionStorage.js')
  >
}

async function loadFullLogFromRealModule(log: LogOption): Promise<LogOption> {
  const { loadFullLog } = await loadSessionStorageFromRealModule()
  return loadFullLog(log)
}

async function loadAllLogsFromSessionFileFromRealModule(
  path: string,
): Promise<LogOption[]> {
  const { loadAllLogsFromSessionFile } = await loadSessionStorageFromRealModule()
  return loadAllLogsFromSessionFile(path)
}

async function setupSourceTranscript(
  entries: Record<string, unknown>[],
  options: { separateSessionProjectDir?: boolean } = {},
): Promise<string> {
  const projectCwd = await mkdtemp(join(tmpdir(), 'openclaude-branch-cwd-'))
  const configDir = await mkdtemp(join(tmpdir(), 'openclaude-branch-config-'))
  const sessionProjectDir = options.separateSessionProjectDir
    ? await mkdtemp(join(tmpdir(), 'openclaude-branch-session-dir-'))
    : null
  tempDirs.push(projectCwd, configDir)
  if (sessionProjectDir) tempDirs.push(sessionProjectDir)

  setClaudeConfigHomeDirForTesting(configDir)
  getClaudeConfigHomeDir.cache?.clear?.()
  getProjectDir.cache?.clear?.()
  setOriginalCwd(projectCwd)
  setProjectRoot(projectCwd)
  switchSession(sourceSessionId as never, sessionProjectDir)
  resetProjectForTesting()

  const sourcePath = getTranscriptPath()
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(
    sourcePath,
    `${entries.map(entry => JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  )
  return sourcePath
}

async function runBranch(
  args: string,
  messages: Message[] = [],
  contextOverrides: Partial<LocalJSXCommandContext> & {
    omitResume?: boolean
  } = {},
) {
  const { call } = await import('./branch.js')
  const onDone = mock(() => {})
  const {
    omitResume,
    resume: resumeOverride,
    ...remainingContextOverrides
  } = contextOverrides
  const resume = omitResume
    ? undefined
    : mock(
        async (
          sessionId: UUID,
          log: LogOption,
          entrypoint: ResumeEntrypoint,
        ) => {
          await resumeOverride?.(sessionId, log, entrypoint)
        },
      )

  const result = await call(
    onDone,
    {
      setMessages: () => {},
      options: { tools: [] },
      messages,
      ...remainingContextOverrides,
      ...(resume ? { resume } : {}),
    } as unknown as LocalJSXCommandContext,
    args,
  )

  return { result, onDone, resume: resume as NonNullable<typeof resume> }
}

beforeEach(async () => {
  await acquireSharedMutationLock('commands/branch/branch.test.ts')

  originalNodeEnv = process.env.NODE_ENV
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  originalPersistence = process.env.ENABLE_SESSION_PERSISTENCE
  originalCwd = getOriginalCwd()

  originalProjectRoot = getProjectRoot()
  originalSessionId = getSessionId()
  originalSessionProjectDir = getSessionProjectDir()
  originalPersistenceDisabled = isSessionPersistenceDisabled()
  originalClaudeConfigHomeDirOverride =
    getClaudeConfigHomeDirOverrideForTesting()

  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  setSessionPersistenceDisabled(false)
  analyticsEvents = []
  mock.module('../../services/analytics/index.js', () => ({
    ...realAnalytics,
    logEvent: (name: string, metadata?: Record<string, unknown>) => {
      analyticsEvents.push({ name, metadata: metadata ?? {} })
    },
  }))
})

afterEach(async () => {
  try {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv

    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }

    if (originalPersistence === undefined) {
      delete process.env.ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.ENABLE_SESSION_PERSISTENCE = originalPersistence
    }

    setSessionPersistenceDisabled(originalPersistenceDisabled)
    setClaudeConfigHomeDirForTesting(originalClaudeConfigHomeDirOverride)
    getClaudeConfigHomeDir.cache?.clear?.()
    getProjectDir.cache?.clear?.()
    setOriginalCwd(originalCwd)
    setProjectRoot(originalProjectRoot)
    switchSession(originalSessionId as never, originalSessionProjectDir)
    resetProjectForTesting()
    mock.module('../../services/analytics/index.js', () => realAnalytics)
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    releaseSharedMutationLock()
  }
})

test('/branch creates a new session, copies messages, keeps the source transcript unchanged, and confirms the switch', async () => {
  const keptReplacement: ContentReplacementRecord = {
    kind: 'tool-result',
    toolUseId: 'tool-use-1',
    replacement: '[retained preview]',
  }
  const droppedReplacement: ContentReplacementRecord = {
    kind: 'tool-result',
    toolUseId: 'tool-use-2',
    replacement: '[dropped preview]',
  }
  const sourceGoal = {
    id: 'goal-1',
    condition: 'finish the safe approach',
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    turnCount: 1,
    maxTurns: 3,
    evaluatorFailures: 0,
  } as const
  const firstSourceMessage = {
    ...userMessage(id(1), null, 'try the safe approach'),
    forkedFrom: {
      sessionId: sourceSessionId,
      messageUuid: id(99),
    },
  }
  const sourcePath = await setupSourceTranscript([
    firstSourceMessage,
    assistantMessage(id(2), id(1), 'safe response'),
    userToolResultMessage(id(3), id(2), 'tool-use-1'),
    {
      type: 'content-replacement',
      sessionId: sourceSessionId,
      replacements: [keptReplacement, droppedReplacement],
    },
    { type: 'tag', sessionId: sourceSessionId, tag: 'research' },
    { type: 'agent-name', sessionId: sourceSessionId, agentName: 'Ada' },
    { type: 'agent-color', sessionId: sourceSessionId, agentColor: 'cyan' },
    {
      type: 'agent-setting',
      sessionId: sourceSessionId,
      agentSetting: 'planner',
    },
    { type: 'mode', sessionId: sourceSessionId, mode: 'coordinator' },
    { type: 'goal-state', sessionId: sourceSessionId, goal: sourceGoal },
  ])
  const originalTranscript = await readFile(sourcePath, 'utf8')

  const { result, onDone, resume } = await runBranch('experiment')

  expect(result).toBeNull()
  expect(resume).toHaveBeenCalledTimes(1)
  const [newSessionId, forkLog, entrypoint] = resume.mock.calls[0] as unknown as [
    UUID,
    LogOption,
    string,
  ]
  expect(newSessionId).not.toBe(sourceSessionId)
  expect(entrypoint).toBe('fork')
  expect(forkLog.sessionId).toBe(newSessionId)
  const branchedAt = forkLog.sessionBranch?.branchedAt
  expect(typeof branchedAt).toBe('string')
  expect(branchedAt).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  )
  expect(forkLog.sessionBranch).toMatchObject({
    sessionId: newSessionId,
    parentSessionId: sourceSessionId,
    rootSessionId: sourceSessionId,
    branchedFromSessionId: sourceSessionId,
    branchName: 'experiment',
    branchedAt,
    branchedAtMessageId: id(3),
  })
  expect(forkLog.messages.map(message => message.sessionId)).toEqual([
    newSessionId,
    newSessionId,
    newSessionId,
  ])
  expect(JSON.stringify(forkLog.messages)).not.toContain('forkedFrom')
  expect(forkLog.messages[0]?.type).toBe('user')
  expect(
    forkLog.messages[0]?.type === 'user'
      ? forkLog.messages[0].message.content
      : undefined,
  ).toBe('try the safe approach')

  expect(await readFile(sourcePath, 'utf8')).toBe(originalTranscript)

  const forkPath = forkLog.fullPath
  expect(forkPath).toBeString()
  expect((await stat(forkPath!)).mode & 0o777).toBe(0o600)
  const entries = await readEntries(forkPath!)
  expect(entries[0]).toMatchObject({
    type: 'session-branch',
    sessionId: newSessionId,
  })
  const persistedMessages = entries.filter(
    entry => entry.type === 'user' || entry.type === 'assistant',
  )
  expect(persistedMessages.map(entry => entry.sessionId)).toEqual([
    newSessionId,
    newSessionId,
    newSessionId,
  ])
  expect(JSON.stringify(persistedMessages)).not.toContain('forkedFrom')
  expect(forkLog.contentReplacements).toEqual([keptReplacement])
  expect(forkLog).toMatchObject({
    tag: 'research',
    agentName: 'Ada',
    agentColor: 'cyan',
    agentSetting: 'planner',
    mode: 'coordinator',
    goal: sourceGoal,
  })
  const replacementEntry = entries.find(
    entry => entry.type === 'content-replacement',
  ) as
    | { sessionId?: UUID; replacements?: ContentReplacementRecord[] }
    | undefined
  expect(replacementEntry).toMatchObject({
    sessionId: newSessionId,
    replacements: [keptReplacement],
  })
  expect(JSON.stringify(entries)).not.toContain('tool-use-2')
  expect(
    entries.find(entry => entry.type === 'custom-title')?.customTitle,
  ).toBe('experiment')
  expect(entries.find(entry => entry.type === 'tag')?.tag).toBe('research')
  expect(entries.find(entry => entry.type === 'agent-name')?.agentName).toBe(
    'Ada',
  )
  expect(entries.find(entry => entry.type === 'agent-color')?.agentColor).toBe(
    'cyan',
  )
  expect(
    entries.find(entry => entry.type === 'agent-setting')?.agentSetting,
  ).toBe('planner')
  expect(entries.find(entry => entry.type === 'mode')?.mode).toBe(
    'coordinator',
  )
  expect(entries.find(entry => entry.type === 'goal-state')?.goal).toEqual(
    sourceGoal,
  )

  const branchEntry = entries.find(
    entry => entry.type === 'session-branch',
  ) as SessionBranchEntry | undefined
  expect(branchEntry).toMatchObject({
    sessionId: newSessionId,
    parentSessionId: sourceSessionId,
    rootSessionId: sourceSessionId,
    branchedFromSessionId: sourceSessionId,
    branchName: 'experiment',
    branchedAt,
    branchedAtMessageId: id(3),
  })

  const loaded = (await loadTranscriptFile(forkPath!)) as {
    messages?: Map<UUID, TranscriptMessage>
    sessionBranches?: Map<UUID, SessionBranchEntry>
  }
  expect(JSON.stringify(Array.from(loaded.messages?.values() ?? []))).not.toContain(
    'forkedFrom',
  )
  expect(loaded.sessionBranches?.get(newSessionId)).toMatchObject({
    branchName: 'experiment',
    rootSessionId: sourceSessionId,
    branchedAt,
  })
  const loadedLog = await loadTranscriptFromFile(forkPath!)
  expect(JSON.stringify(loadedLog.messages)).not.toContain('forkedFrom')
  expect(loadedLog.sessionBranch).toMatchObject({
    branchName: 'experiment',
    rootSessionId: sourceSessionId,
    branchedAt,
  })
  const fullLog = await loadFullLogFromRealModule({
    ...forkLog,
    messages: [],
    sessionBranch: undefined,
  })
  expect(fullLog.sessionBranch).toMatchObject({
    branchName: 'experiment',
    rootSessionId: sourceSessionId,
    branchedAt,
  })
  const allForkLogs = await loadAllLogsFromSessionFileFromRealModule(forkPath!)
  expect(allForkLogs).toHaveLength(1)
  expect(JSON.stringify(allForkLogs[0]?.messages)).not.toContain('forkedFrom')
  expect(allForkLogs[0]?.sessionBranch).toMatchObject({
    branchName: 'experiment',
    rootSessionId: sourceSessionId,
    branchedAt,
  })
  const forkEvent = analyticsEvents.findLast(
    event => event.name === 'tengu_conversation_forked',
  )
  expect(forkEvent?.metadata).toMatchObject({
    message_count: 3,
    has_custom_title: true,
  })

  expect(onDone).toHaveBeenCalledTimes(1)
  const [message, options] = onDone.mock.calls[0] as unknown as [
    string,
    { display: string },
  ]
  expect(options).toEqual({ display: 'system' })
  expect(message).toContain(sourceSessionId)
  expect(message).toContain(newSessionId)
  expect(message).toContain('experiment')
  expect(message).toContain('same working tree')
  expect(message).toContain('not filesystem isolation')
  expect(message).toContain(`To resume the original: claude -r ${sourceSessionId}`)
})

test('/branch without a name auto-titles the fork and reports non-custom title metadata', async () => {
  await setupSourceTranscript([
    userMessage(id(1), null, 'explore another approach'),
    assistantMessage(id(2), id(1), 'another response'),
  ])

  const { onDone, resume } = await runBranch('')

  expect(resume).toHaveBeenCalledTimes(1)
  const [newSessionId, forkLog] = resume.mock.calls[0] as unknown as [
    UUID,
    LogOption,
  ]
  expect(forkLog.customTitle).toBe('explore another approach (Branch)')
  expect(forkLog.sessionBranch).toMatchObject({
    sessionId: newSessionId,
    branchName: 'explore another approach (Branch)',
    branchedAtMessageId: id(2),
  })

  const entries = await readEntries(forkLog.fullPath!)
  expect(
    entries.find(entry => entry.type === 'custom-title')?.customTitle,
  ).toBe('explore another approach (Branch)')
  expect(
    entries.find(entry => entry.type === 'session-branch')?.branchName,
  ).toBe('explore another approach (Branch)')

  const forkEvent = analyticsEvents.findLast(
    event => event.name === 'tengu_conversation_forked',
  )
  expect(forkEvent?.metadata).toMatchObject({
    message_count: 2,
    has_custom_title: false,
  })

  const [message] = onDone.mock.calls[0] as unknown as [string]
  expect(message).toContain('explore another approach (Branch)')
})

test('/branch reports a clear no-op for an empty session', async () => {
  await setupSourceTranscript([])

  const { result, onDone, resume } = await runBranch('')

  expect(result).toBeNull()
  expect(resume).not.toHaveBeenCalled()
  expect(onDone).toHaveBeenCalledTimes(1)
  const [message] = onDone.mock.calls[0] as unknown as [string]
  expect(message).toContain('No conversation messages to branch yet')
  expect(message).not.toContain('Failed')
})

test('/branch reports a clear no-op when a transcript has no conversation turns', async () => {
  await setupSourceTranscript([systemMessage(id(1), null, 'session notice')])

  const { result, onDone, resume } = await runBranch('')

  expect(result).toBeNull()
  expect(resume).not.toHaveBeenCalled()
  expect(onDone).toHaveBeenCalledTimes(1)
  const [message] = onDone.mock.calls[0] as unknown as [string]
  expect(message).toContain('No conversation messages to branch yet')
  expect(message).not.toContain('Failed')
})

test('/branch flushes live messages before copying the fork transcript', async () => {
  const sourceUser = userMessage(id(1), null, 'prompt already on disk')
  const liveAssistant = assistantMessage(
    id(2),
    id(1),
    'latest live answer',
    '2026-06-28T09:01:00.000Z',
  )
  await setupSourceTranscript([sourceUser])
  await recordTranscript([
    contextMessageFrom(sourceUser),
    contextMessageFrom(liveAssistant),
  ])

  const { resume } = await runBranch('live branch', [
    contextMessageFrom(sourceUser),
    contextMessageFrom(liveAssistant),
  ])

  expect(resume).toHaveBeenCalledTimes(1)
  const [, forkLog] = resume.mock.calls[0] as unknown as [UUID, LogOption]
  expect(forkLog.messages.map(message => message.uuid)).toEqual([id(1), id(2)])
  expect(JSON.stringify(forkLog.messages)).toContain('latest live answer')
  expect(forkLog.sessionBranch).toMatchObject({
    branchedAtMessageId: id(2),
  })

  const entries = await readEntries(forkLog.fullPath!)
  expect(JSON.stringify(entries)).toContain('latest live answer')
})

test('/branch keeps a created branch recoverable if switching into it fails', async () => {
  await setupSourceTranscript([
    userMessage(id(1), null, 'prompt before failed switch'),
    assistantMessage(id(2), id(1), 'response before failed switch'),
  ])
  const resume = mock(async () => {
    throw new Error('resume rejected')
  })

  const { result, onDone } = await runBranch('failed switch', [], { resume })

  expect(result).toBeNull()
  expect(resume).toHaveBeenCalledTimes(1)
  expect(onDone).toHaveBeenCalledTimes(1)
  const [newSessionId, forkLog] = resume.mock.calls[0] as unknown as [
    UUID,
    LogOption,
  ]
  expect(await readEntries(forkLog.fullPath!)).toContainEqual(
    expect.objectContaining({
      type: 'session-branch',
      sessionId: newSessionId,
      branchName: 'failed switch',
    }),
  )
  const [message, options] = onDone.mock.calls[0] as unknown as [
    string,
    { display: string },
  ]
  expect(options).toEqual({ display: 'system' })
  expect(message).toContain(
    `Branched conversation "failed switch" from ${sourceSessionId} to ${newSessionId}.`,
  )
  expect(message).toContain(
    'Created the branch file, but failed to switch sessions: resume rejected',
  )
  expect(message).toContain(`Resume this branch with: /resume ${newSessionId}`)
  expect(message).toContain('same working tree')
  expect(
    analyticsEvents.find(event => event.name === 'tengu_conversation_forked'),
  ).toBeUndefined()
  expect(
    analyticsEvents.find(
      event => event.name === 'tengu_conversation_fork_switch_failed',
    )?.metadata,
  ).toMatchObject({
    message_count: 2,
    has_custom_title: true,
  })
})

test('/branch shows a manual resume hint when automatic switching is unavailable', async () => {
  await setupSourceTranscript([
    userMessage(id(1), null, 'prompt before manual switch'),
    assistantMessage(id(2), id(1), 'response before manual switch'),
  ])

  const { result, onDone } = await runBranch('manual switch', [], {
    omitResume: true,
  })

  expect(result).toBeNull()
  expect(onDone).toHaveBeenCalledTimes(1)
  const [message] = onDone.mock.calls[0] as unknown as [string]
  expect(message).toContain('manual switch')
  expect(message).toContain(sourceSessionId)
  expect(message).toContain('Automatic session switching is unavailable')
  expect(message).toContain('Resume this branch with: /resume ')
  expect(message).toContain('same working tree')
  expect(message).toContain('not filesystem isolation')
  expect(message).toContain(`To resume the original: claude -r ${sourceSessionId}`)
  expect(message).not.toContain('You are now in the branch')
})

test('/branch from a branch records immediate parent and original root metadata', async () => {
  await setupSourceTranscript([
    userMessage(id(1), null, 'first branch prompt'),
    assistantMessage(id(2), id(1), 'first branch response'),
    sessionBranchEntry(),
  ])

  const { resume } = await runBranch('second branch')

  expect(resume).toHaveBeenCalledTimes(1)
  const [newSessionId, forkLog] = resume.mock.calls[0] as unknown as [
    UUID,
    LogOption,
  ]
  const entries = await readEntries(forkLog.fullPath!)
  const branchEntry = entries.find(
    entry => entry.type === 'session-branch',
  ) as SessionBranchEntry | undefined

  expect(branchEntry).toMatchObject({
    sessionId: newSessionId,
    parentSessionId: sourceSessionId,
    rootSessionId,
    branchedFromSessionId: sourceSessionId,
    branchName: 'second branch',
    branchedAtMessageId: id(2),
  })
})

test('/branch migrates legacy per-message fork lineage and strips it from copied messages', async () => {
  await setupSourceTranscript([
    {
      ...userMessage(id(1), null, 'legacy branch prompt'),
      forkedFrom: {
        sessionId: rootSessionId,
        messageUuid: id(101),
      },
    },
    {
      ...assistantMessage(id(2), id(1), 'legacy branch response'),
      forkedFrom: {
        sessionId: rootSessionId,
        messageUuid: id(102),
      },
    },
  ])

  const { resume } = await runBranch('legacy child')

  expect(resume).toHaveBeenCalledTimes(1)
  const [newSessionId, forkLog] = resume.mock.calls[0] as unknown as [
    UUID,
    LogOption,
  ]
  const entries = await readEntries(forkLog.fullPath!)
  const persistedMessages = entries.filter(
    entry => entry.type === 'user' || entry.type === 'assistant',
  )

  expect(JSON.stringify(persistedMessages)).not.toContain('forkedFrom')
  expect(
    entries.find(entry => entry.type === 'session-branch'),
  ).toMatchObject({
    sessionId: newSessionId,
    parentSessionId: sourceSessionId,
    rootSessionId,
    branchedFromSessionId: sourceSessionId,
    branchName: 'legacy child',
  })
})

test('/branch writes the fork next to the active resumed transcript', async () => {
  const sourcePath = await setupSourceTranscript(
    [
      userMessage(id(1), null, 'resumed session prompt'),
      assistantMessage(id(2), id(1), 'resumed response'),
    ],
    { separateSessionProjectDir: true },
  )

  const { resume } = await runBranch('resumed branch')

  expect(resume).toHaveBeenCalledTimes(1)
  const [, forkLog] = resume.mock.calls[0] as unknown as [UUID, LogOption]
  expect(dirname(forkLog.fullPath!)).toBe(dirname(sourcePath))
})

test('/branch copies only the active conversation chain', async () => {
  const activeRoot = userMessage(
    id(1),
    null,
    'root prompt',
    '2026-06-28T09:00:00.000Z',
  )
  const activeBase = assistantMessage(
    id(2),
    id(1),
    'root response',
    '2026-06-28T09:01:00.000Z',
  )
  const activeUser = userMessage(
    id(3),
    id(2),
    'active branch prompt',
    '2026-06-28T09:02:00.000Z',
  )
  const activeAssistant = assistantMessage(
    id(4),
    id(3),
    `active branch response ${'x'.repeat(6 * 1024 * 1024)}`,
    '2026-06-28T09:03:00.000Z',
  )
  const sidechainAssistant = {
    ...assistantMessage(
      id(7),
      id(4),
      'sidechain-only response',
      '2026-06-28T09:06:00.000Z',
    ),
    isSidechain: true,
  } as TranscriptMessage
  await setupSourceTranscript([
    activeRoot,
    activeBase,
    activeUser,
    activeAssistant,
    userMessage(
      id(5),
      id(2),
      'stale alternate prompt',
      '2026-06-28T09:04:00.000Z',
    ),
    assistantMessage(
      id(6),
      id(5),
      'stale alternate response',
      '2026-06-28T09:05:00.000Z',
    ),
    sidechainAssistant,
  ])

  const { resume } = await runBranch('active chain', [
    contextMessageFrom(activeRoot),
    contextMessageFrom(activeBase),
    contextMessageFrom(activeUser),
    contextMessageFrom(activeAssistant),
    contextMessageFrom(sidechainAssistant),
  ])

  expect(resume).toHaveBeenCalledTimes(1)
  const [, forkLog] = resume.mock.calls[0] as unknown as [UUID, LogOption]
  const entries = await readEntries(forkLog.fullPath!)
  const persistedMessages = entries.filter(
    entry => entry.type === 'user' || entry.type === 'assistant',
  )
  const branchEntry = entries.find(
    entry => entry.type === 'session-branch',
  ) as SessionBranchEntry | undefined

  expect(
    persistedMessages.map(entry =>
      JSON.stringify(entry.message ?? entry.content ?? ''),
    ),
  ).toEqual([
    expect.stringContaining('root prompt'),
    expect.stringContaining('root response'),
    expect.stringContaining('active branch prompt'),
    expect.stringContaining('active branch response'),
  ])
  expect(branchEntry).toMatchObject({
    branchedAtMessageId: id(4),
  })
  expect(JSON.stringify(persistedMessages)).not.toContain(
    'stale alternate prompt',
  )
  expect(JSON.stringify(persistedMessages)).not.toContain(
    'stale alternate response',
  )
  expect(JSON.stringify(persistedMessages)).not.toContain(
    'sidechain-only response',
  )
})

test('/branch fallback leaf selection stays scoped to the active session id', async () => {
  const otherSessionId =
    '00000000-0000-4000-8000-000000000999' as UUID
  await setupSourceTranscript([
    userMessage(
      id(1),
      null,
      'active session prompt',
      '2026-06-28T09:00:00.000Z',
    ),
    assistantMessage(
      id(2),
      id(1),
      'active session response',
      '2026-06-28T09:01:00.000Z',
    ),
    {
      ...userMessage(
        id(3),
        null,
        'other session prompt',
        '2026-06-28T09:02:00.000Z',
      ),
      sessionId: otherSessionId,
    },
    {
      ...assistantMessage(
        id(4),
        id(3),
        'other session response',
        '2026-06-28T09:03:00.000Z',
      ),
      sessionId: otherSessionId,
    },
  ])

  const { resume } = await runBranch('active only')

  expect(resume).toHaveBeenCalledTimes(1)
  const [, forkLog] = resume.mock.calls[0] as unknown as [UUID, LogOption]
  expect(JSON.stringify(forkLog.messages)).toContain('active session response')
  expect(JSON.stringify(forkLog.messages)).not.toContain(
    'other session response',
  )
  expect(forkLog.sessionBranch).toMatchObject({
    branchedAtMessageId: id(2),
  })
})
