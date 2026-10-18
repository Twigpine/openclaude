import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'

import {
  adoptResumedSessionFile,
  buildConversationChain,
  getProjectDir,
  isEphemeralToolProgress,
  loadSameRepoMessageLogsProgressive,
  loadTranscriptFile,
  loadTranscriptFromFile,
  recordGoalState,
  recordTranscript,
  flushSessionStorage,
  resetProjectForTesting,
  resetSessionFilePointer,
  setSessionFileForTesting,
  restoreSessionMetadata,
  stripPersistedToolUseResultsFromJSONLBuffer,
} from './sessionStorage.ts'
import { createGoalState } from '../services/goal/state.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
  resetAllReplayIndexBuilders,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import type { GoalState } from '../services/goal/types.js'
import type { SessionBranchEntry } from '../types/logs.js'
import {
  getClaudeConfigHomeDir,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import { resetSettingsCache } from './settings/settingsCache.js'

const tempDirs: string[] = []
const sessionId = '00000000-0000-4000-8000-000000000999'
const ts = '2026-04-02T00:00:00.000Z'

function id(n: number): UUID {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID
}

function base(uuid: UUID, parentUuid: UUID | null) {
  return {
    uuid,
    parentUuid,
    timestamp: ts,
    cwd: '/tmp',
    userType: 'external',
    sessionId,
    version: 'test',
    isSidechain: false,
  }
}

function user(
  uuid: UUID,
  parentUuid: UUID | null,
  content: string | ToolResultBlockParam[],
) {
  return {
    ...base(uuid, parentUuid),
    type: 'user',
    isMeta: false,
    message: {
      role: 'user',
      content,
    },
  }
}

function assistant(uuid: UUID, parentUuid: UUID | null, text: string) {
  return {
    ...base(uuid, parentUuid),
    type: 'assistant',
    message: {
      id: uuid,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      model: 'test-model',
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  }
}

function compactBoundary(
  uuid: UUID,
  parentUuid: UUID | null,
  preservedSegment: {
    headUuid: UUID
    anchorUuid: UUID
    tailUuid: UUID
  },
) {
  return {
    ...base(uuid, parentUuid),
    type: 'system',
    subtype: 'compact_boundary',
    level: 'info',
    isMeta: false,
    content: 'Conversation compacted',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 123,
      preservedSegment,
    },
  }
}

function snipBoundary(
  uuid: UUID,
  parentUuid: UUID | null,
  removedUuids: UUID[],
) {
  return {
    ...base(uuid, parentUuid),
    type: 'system',
    subtype: 'snip_boundary',
    level: 'info',
    isMeta: false,
    content: 'Conversation history snipped',
    snipMetadata: { removedUuids },
  }
}

async function writeJsonl(entries: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'session.jsonl')
  await writeFile(filePath, `${entries.map(e => JSON.stringify(e)).join('\n')}\n`)
  return filePath
}

function getToolResultContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined

  const [block] = content
  if (
    typeof block !== 'object' ||
    block === null ||
    !('type' in block) ||
    block.type !== 'tool_result' ||
    !('content' in block)
  ) {
    return undefined
  }

  return typeof block.content === 'string' ? block.content : undefined
}

function readGoalStateEntries(text: string): Array<{ goal: GoalState | null }> {
  return text
    .split('\n')
    .filter(Boolean)
    .map(
      line =>
        JSON.parse(line) as { type?: string; goal?: GoalState | null },
    )
    .filter(
      (entry): entry is { goal: GoalState | null } =>
        entry.type === 'goal-state',
    )
}

function readSessionBranchEntries(text: string): SessionBranchEntry[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SessionBranchEntry)
    .filter(entry => entry.type === 'session-branch')
}

async function withSessionPersistence<T>(fn: () => Promise<T>): Promise<T> {
  const originalPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  const originalSessionPersistence = process.env.ENABLE_SESSION_PERSISTENCE
  const originalSkipPromptHistory = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  const originalNodeEnv = process.env.NODE_ENV
  const originalSessionId = getSessionId()
  const originalSessionPersistenceDisabled = isSessionPersistenceDisabled()
  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  setSessionPersistenceDisabled(false)
  try {
    resetProjectForTesting()
    return await fn()
  } finally {
    if (originalPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalPersistence
    }
    if (originalSessionPersistence === undefined) {
      delete process.env.ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.ENABLE_SESSION_PERSISTENCE = originalSessionPersistence
    }
    if (originalSkipPromptHistory === undefined) {
      delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    } else {
      process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = originalSkipPromptHistory
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
    setSessionPersistenceDisabled(originalSessionPersistenceDisabled)
    switchSession(originalSessionId)
    resetProjectForTesting()
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/sessionStorage.test.ts')
})

afterEach(async () => {
  try {
    resetAllReplayIndexBuilders()
    await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
  } finally {
    releaseSharedMutationLock()
  }
})

test('recordTranscript respects prompt-history opt-out for replay state', async () => {
  await withSessionPersistence(async () => {
    const configDir = await mkdtemp(
      join(tmpdir(), 'openclaude-session-storage-config-'),
    )
    tempDirs.push(configDir)
    setClaudeConfigHomeDirForTesting(configDir)
    await writeFile(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 30 }),
      'utf-8',
    )
    resetSettingsCache()
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'false'
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = 'true'
    resetProjectForTesting()
    resetAllReplayIndexBuilders()

    try {
      await recordTranscript([
        {
          uuid: id(900),
          type: 'user',
          message: {
            role: 'user',
            content: 'do not retain this in replay state',
          },
          timestamp: ts,
          isMeta: false,
        } as never,
      ])

      expect(resetAllReplayIndexBuilders()).toEqual([])
    } finally {
      setClaudeConfigHomeDirForTesting(undefined)
      resetSettingsCache()
    }
  })
})

test('loadTranscriptFile replays a persisted snip boundary, pruning and relinking', async () => {
  // The headless snip path appends the boundary (carrying snipMetadata.removedUuids)
  // to the append-only transcript while the pre-snip messages stay on disk. On
  // resume, applySnipRemovals must drop the removed UUIDs and relink survivors,
  // so the restored session reflects the context reduction rather than the
  // un-snipped history.
  const keep1 = user(id(41), null, 'keep 1')
  const removeA = assistant(id(42), id(41), 'remove a')
  const removeB = user(id(43), id(42), 'remove b')
  const keep2 = assistant(id(44), id(43), 'keep 2') // parentUuid points into the removed gap
  const boundary = snipBoundary(id(45), id(44), [id(42), id(43)])
  const keep3 = assistant(id(46), id(45), 'keep 3')

  const filePath = await writeJsonl([
    keep1,
    removeA,
    removeB,
    keep2,
    boundary,
    keep3,
  ])

  const { messages } = await loadTranscriptFile(filePath)
  expect(messages.has(id(42))).toBe(false)
  expect(messages.has(id(43))).toBe(false)
  expect(messages.has(id(41))).toBe(true)
  expect(messages.has(id(44))).toBe(true)
  expect(messages.has(id(45))).toBe(true)
  expect(messages.has(id(46))).toBe(true)
  // keep2's dangling parentUuid (id(43), removed) relinks to the first
  // surviving ancestor (id(41)).
  expect(messages.get(id(44))?.parentUuid).toBe(id(41))

  const chain = buildConversationChain(messages, messages.get(id(46))!)
  expect(chain.map(message => message.uuid)).toEqual([
    id(41),
    id(44),
    id(45),
    id(46),
  ])
})

test('loadTranscriptFile fails closed when preserved-segment tail is missing', async () => {
  const oldUser = user(id(1), null, 'old user')
  const oldAssistant = assistant(id(2), id(1), 'old assistant')
  const preservedHead = assistant(id(3), id(2), 'preserved head')
  const boundary = compactBoundary(id(4), id(2), {
    headUuid: id(3),
    anchorUuid: id(5),
    tailUuid: id(30),
  })
  const summary = user(id(5), id(4), 'summary')

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    boundary,
    summary,
  ])

  const { messages } = await loadTranscriptFile(filePath)
  expect(messages.has(id(1))).toBe(false)
  expect(messages.has(id(2))).toBe(false)
  expect(messages.has(id(3))).toBe(false)
  expect(messages.has(id(4))).toBe(true)
  expect(messages.has(id(5))).toBe(true)

  const chain = buildConversationChain(messages, messages.get(id(5))!)
  expect(chain.map(message => message.uuid)).toEqual([id(4), id(5)])
})

test('loadTranscriptFile preserves and relinks a valid preserved segment', async () => {
  const oldUser = user(id(11), null, 'old user')
  const oldAssistant = assistant(id(12), id(11), 'old assistant')
  const preservedHead = assistant(id(13), id(12), 'preserved head')
  const preservedTail = assistant(id(14), id(13), 'preserved tail')
  const boundary = compactBoundary(id(15), id(12), {
    headUuid: id(13),
    anchorUuid: id(16),
    tailUuid: id(14),
  })
  const summary = user(id(16), id(15), 'summary')

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    preservedTail,
    boundary,
    summary,
  ])

  const { messages } = await loadTranscriptFile(filePath)
  expect(messages.has(id(11))).toBe(false)
  expect(messages.has(id(12))).toBe(false)
  expect(messages.has(id(13))).toBe(true)
  expect(messages.has(id(14))).toBe(true)
  expect(messages.get(id(13))?.parentUuid).toBe(id(16))
  expect(messages.get(id(14))?.parentUuid).toBe(id(13))

  const chain = buildConversationChain(messages, messages.get(id(14))!)
  expect(chain.map(message => message.uuid)).toEqual([
    id(15),
    id(16),
    id(13),
    id(14),
  ])
})

test('loadTranscriptFile fails closed when preserved-segment anchor is missing', async () => {
  // Models the case where the compact boundary was written but the post-boundary
  // summary/anchor message never made it to disk.
  const oldUser = user(id(21), null, 'old user')
  const oldAssistant = assistant(id(22), id(21), 'old assistant')
  const preservedHead = assistant(id(23), id(22), 'preserved head')
  const preservedTail = assistant(id(24), id(23), 'preserved tail')
  const boundary = compactBoundary(id(25), id(22), {
    headUuid: id(23),
    anchorUuid: id(26),
    tailUuid: id(24),
  })

  const filePath = await writeJsonl([
    oldUser,
    oldAssistant,
    preservedHead,
    preservedTail,
    boundary,
  ])

  const { messages } = await loadTranscriptFile(filePath)
  expect(messages.has(id(21))).toBe(false)
  expect(messages.has(id(22))).toBe(false)
  expect(messages.has(id(23))).toBe(false)
  expect(messages.has(id(24))).toBe(false)
  expect(messages.has(id(25))).toBe(true)

  const chain = buildConversationChain(messages, messages.get(id(25))!)
  expect(chain.map(message => message.uuid)).toEqual([id(25)])
})

test('stripPersistedToolUseResultsFromJSONLBuffer drops raw toolUseResult while preserving persisted preview content', () => {
  const persisted = user(id(31), null, [
    {
      type: 'tool_result',
      tool_use_id: 'tool-31',
      is_error: false,
      content: '<persisted-output>\nPreview text\n</persisted-output>',
    },
  ])
  ;(persisted as typeof persisted & { toolUseResult?: unknown }).toolUseResult = {
    stdout: 'x'.repeat(200_000),
    stderr: '',
  }

  const raw = Buffer.from(`${JSON.stringify(persisted)}\n`)
  const sanitized = stripPersistedToolUseResultsFromJSONLBuffer(raw)
  const [parsed] = JSON.parse(`[${sanitized.toString('utf8').trim()}]`) as Array<
    typeof persisted & { toolUseResult?: unknown }
  >

  expect(parsed?.toolUseResult).toBeUndefined()
  expect(getToolResultContent(parsed?.message.content)).toContain('Preview text')
})

test('loadTranscriptFile omits raw toolUseResult for persisted-output transcript entries', async () => {
  const persisted = user(id(41), null, [
    {
      type: 'tool_result',
      tool_use_id: 'tool-41',
      is_error: false,
      content: '<persisted-output>\nPreview text\n</persisted-output>',
    },
  ])
  ;(persisted as typeof persisted & { toolUseResult?: unknown }).toolUseResult = {
    stdout: 'y'.repeat(200_000),
    stderr: '',
  }

  const filePath = await writeJsonl([persisted])
  const { messages } = await loadTranscriptFile(filePath)
  const loaded = messages.get(id(41)) as (typeof persisted & {
    toolUseResult?: unknown
  }) | undefined

  expect(loaded).toBeDefined()
  expect(loaded?.toolUseResult).toBeUndefined()
  expect(getToolResultContent(loaded?.message.content)).toContain('Preview text')
})

test('loadTranscriptFile restores last goal-state metadata entry', async () => {
  const activeGoal = {
    id: 'goal-1',
    condition: 'finish implementation',
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    turnCount: 2,
    maxTurns: 50,
    lastDecision: 'incomplete',
    lastReason: 'tests not run',
    evaluatorFailures: 0,
  }
  const filePath = await writeJsonl([
    {
      type: 'goal-state',
      sessionId,
      goal: activeGoal,
    },
    {
      type: 'goal-state',
      sessionId,
      goal: {
        ...activeGoal,
        condition: 'finish build validation',
      },
    },
  ])

  const { goalStates } = await loadTranscriptFile(filePath)

  expect(goalStates.get(sessionId as never)?.condition).toBe(
    'finish build validation',
  )
})

test('loadTranscriptFile treats null goal-state as cleared', async () => {
  const activeGoal = {
    id: 'goal-1',
    condition: 'finish implementation',
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    turnCount: 0,
    maxTurns: 50,
    evaluatorFailures: 0,
  }
  const filePath = await writeJsonl([
    {
      type: 'goal-state',
      sessionId,
      goal: activeGoal,
    },
    {
      type: 'goal-state',
      sessionId,
      goal: null,
    },
  ])

  const { goalStates } = await loadTranscriptFile(filePath)

  expect(goalStates.get(sessionId as never)).toBeNull()
})

test('restoreSessionMetadata clears cached goal when resumed transcript has no goal metadata', async () => {
  await withSessionPersistence(async () => {
    restoreSessionMetadata({
      goal: createGoalState('stale previous session goal', ts),
    })

    const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
    tempDirs.push(dir)
    const filePath = join(dir, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify(user(id(51), null, 'resume me'))}\n`,
    )

    switchSession(sessionId as never, dir)
    await resetSessionFilePointer()
    restoreSessionMetadata({})
    adoptResumedSessionFile()

    const text = await readFile(filePath, 'utf8')
    expect(readGoalStateEntries(text)).toEqual([])
  })
})

test('restoreSessionMetadata clears cached goal when resumed transcript has explicit null goal metadata', async () => {
  await withSessionPersistence(async () => {
    restoreSessionMetadata({
      goal: createGoalState('stale previous session goal', ts),
    })

    const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
    tempDirs.push(dir)
    const filePath = join(dir, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify(user(id(52), null, 'resume cleared goal'))}\n`,
    )

    switchSession(sessionId as never, dir)
    await resetSessionFilePointer()
    restoreSessionMetadata({ goal: null })
    adoptResumedSessionFile()

    const text = await readFile(filePath, 'utf8')
    expect(readGoalStateEntries(text)).toEqual([])
  })
})

test('restoreSessionMetadata re-appends the resumed active goal instead of stale cached goal', async () => {
  await withSessionPersistence(async () => {
    restoreSessionMetadata({
      goal: createGoalState('stale previous session goal', ts),
    })
    const resumedGoal = createGoalState('resumed current goal', ts)

    const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
    tempDirs.push(dir)
    const filePath = join(dir, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify(user(id(53), null, 'resume active goal'))}\n`,
    )

    switchSession(sessionId as never, dir)
    await resetSessionFilePointer()
    restoreSessionMetadata({ goal: resumedGoal })
    adoptResumedSessionFile()

    const text = await readFile(filePath, 'utf8')
    expect(
      readGoalStateEntries(text).map(entry => entry.goal?.condition),
    ).toEqual(['resumed current goal'])
  })
})

test('restoreSessionMetadata clears cached branch when resumed transcript has no branch metadata', async () => {
  await withSessionPersistence(async () => {
    const staleBranch: SessionBranchEntry = {
      type: 'session-branch',
      sessionId: sessionId as UUID,
      parentSessionId: id(54),
      rootSessionId: id(54),
      branchedFromSessionId: id(54),
      branchName: 'stale branch',
      branchedAt: ts,
    }
    restoreSessionMetadata({ sessionBranch: staleBranch })

    const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
    tempDirs.push(dir)
    const filePath = join(dir, `${sessionId}.jsonl`)
    await writeFile(
      filePath,
      `${JSON.stringify(user(id(55), null, 'resume non-branch'))}\n`,
    )

    switchSession(sessionId as never, dir)
    await resetSessionFilePointer()
    restoreSessionMetadata({})
    adoptResumedSessionFile()

    const text = await readFile(filePath, 'utf8')
    expect(readSessionBranchEntries(text)).toEqual([])
  })
})

test('recordGoalState writes goal metadata durably before resolving', async () => {
  await withSessionPersistence(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
    tempDirs.push(dir)
    const filePath = join(dir, `${sessionId}.jsonl`)
    switchSession(sessionId as never, dir)
    setSessionFileForTesting(filePath)

    await recordGoalState(
      {
        id: 'goal-durable',
        condition: 'durable goal',
        status: 'active',
        createdAt: ts,
        updatedAt: ts,
        startedAt: ts,
        turnCount: 0,
        maxTurns: 50,
        evaluatorFailures: 0,
      },
      sessionId as never,
    )
    await flushSessionStorage()

    const text = await readFile(filePath, 'utf8')
    expect(text).toContain('"type":"goal-state"')
    expect(text).toContain('durable goal')
  })
})

test('loadSameRepoMessageLogsProgressive preserves branch metadata across worktrees', async () => {
  const configDir = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-config-'),
  )
  tempDirs.push(configDir)
  const worktreesRoot = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-worktrees-'),
  )
  tempDirs.push(worktreesRoot)
  const rootProject = join(worktreesRoot, 'main')
  const branchProject = join(worktreesRoot, 'worktree-feature')
  const rootId = id(61)
  const branchId = id(62)

  try {
    setClaudeConfigHomeDirForTesting(configDir)
    getClaudeConfigHomeDir.cache?.clear?.()
    const rootProjectDir = getProjectDir(rootProject)
    const branchProjectDir = getProjectDir(branchProject)
    await mkdir(rootProjectDir, { recursive: true })
    await mkdir(branchProjectDir, { recursive: true })
    await writeFile(
      join(rootProjectDir, `${rootId}.jsonl`),
      `${JSON.stringify({
        ...user(id(63), null, 'root prompt'),
        sessionId: rootId,
        cwd: rootProject,
      })}\n`,
    )
    await writeFile(
      join(branchProjectDir, `${branchId}.jsonl`),
      `${JSON.stringify({
        ...user(id(64), null, 'branch prompt'),
        sessionId: branchId,
        cwd: branchProject,
      })}\n${JSON.stringify({
        type: 'session-branch',
        sessionId: branchId,
        parentSessionId: rootId,
        rootSessionId: rootId,
        branchedFromSessionId: rootId,
        branchName: 'Worktree branch',
        branchedAt: ts,
      })}\n`,
    )
    const result = await loadSameRepoMessageLogsProgressive(
      [rootProject, branchProject],
      undefined,
      10,
    )

    const branchLog = result.logs.find(log => log.sessionId === branchId)
    expect(new Set(result.logs.map(log => log.projectPath))).toEqual(
      new Set([branchProject, rootProject]),
    )
    expect(branchLog?.sessionBranch?.branchName).toBe('Worktree branch')
    expect(branchLog?.sessionBranch?.rootSessionId).toBe(rootId)
  } finally {
    setClaudeConfigHomeDirForTesting(undefined)
    getClaudeConfigHomeDir.cache?.clear?.()
  }
})

test('loadSameRepoMessageLogsProgressive preserves branch metadata from the lite head window', async () => {
  const configDir = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-config-'),
  )
  tempDirs.push(configDir)
  const worktreesRoot = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-worktrees-'),
  )
  tempDirs.push(worktreesRoot)
  const rootProject = join(worktreesRoot, 'main')
  const branchProject = join(worktreesRoot, 'worktree-feature')
  const rootId = id(71)
  const branchId = id(72)
  const branchMetadata: SessionBranchEntry = {
    type: 'session-branch',
    sessionId: branchId,
    parentSessionId: rootId,
    rootSessionId: rootId,
    branchedFromSessionId: rootId,
    branchName: 'Long-lived branch',
    branchedAt: ts,
  }

  try {
    setClaudeConfigHomeDirForTesting(configDir)
    getClaudeConfigHomeDir.cache?.clear?.()
    const rootProjectDir = getProjectDir(rootProject)
    const branchProjectDir = getProjectDir(branchProject)
    await mkdir(rootProjectDir, { recursive: true })
    await mkdir(branchProjectDir, { recursive: true })
    await writeFile(
      join(rootProjectDir, `${rootId}.jsonl`),
      `${JSON.stringify({
        ...user(id(73), null, 'root prompt'),
        sessionId: rootId,
        cwd: rootProject,
      })}\n`,
    )
    const largeText = 'x'.repeat(70 * 1024)
    await writeFile(
      join(branchProjectDir, `${branchId}.jsonl`),
      `${JSON.stringify(branchMetadata)}\n${JSON.stringify({
        ...user(id(74), null, 'branch prompt'),
        sessionId: branchId,
        cwd: branchProject,
      })}\n${JSON.stringify({
        ...user(id(75), id(74), largeText),
        sessionId: branchId,
        cwd: branchProject,
      })}\n${JSON.stringify({
        ...assistant(id(76), id(75), largeText),
        sessionId: branchId,
        cwd: branchProject,
      })}\n`,
    )
    const result = await loadSameRepoMessageLogsProgressive(
      [rootProject, branchProject],
      undefined,
      10,
    )

    const branchLog = result.logs.find(log => log.sessionId === branchId)
    expect(branchLog?.sessionBranch?.branchName).toBe('Long-lived branch')
    expect(branchLog?.sessionBranch?.rootSessionId).toBe(rootId)
  } finally {
    setClaudeConfigHomeDirForTesting(undefined)
    getClaudeConfigHomeDir.cache?.clear?.()
  }
})

test('loadSameRepoMessageLogsProgressive ignores branch metadata outside lite read windows', async () => {
  const configDir = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-config-'),
  )
  tempDirs.push(configDir)
  const worktreesRoot = await mkdtemp(
    join(tmpdir(), 'openclaude-session-storage-worktrees-'),
  )
  tempDirs.push(worktreesRoot)
  const rootProject = join(worktreesRoot, 'main')
  const branchProject = join(worktreesRoot, 'worktree-feature')
  const rootId = id(81)
  const branchId = id(82)
  const branchMetadata: SessionBranchEntry = {
    type: 'session-branch',
    sessionId: branchId,
    parentSessionId: rootId,
    rootSessionId: rootId,
    branchedFromSessionId: rootId,
    branchName: 'Hidden branch metadata',
    branchedAt: ts,
  }

  try {
    setClaudeConfigHomeDirForTesting(configDir)
    getClaudeConfigHomeDir.cache?.clear?.()
    const rootProjectDir = getProjectDir(rootProject)
    const branchProjectDir = getProjectDir(branchProject)
    await mkdir(rootProjectDir, { recursive: true })
    await mkdir(branchProjectDir, { recursive: true })
    await writeFile(
      join(rootProjectDir, `${rootId}.jsonl`),
      `${JSON.stringify({
        ...user(id(83), null, 'root prompt'),
        sessionId: rootId,
        cwd: rootProject,
      })}\n`,
    )
    const largeText = 'x'.repeat(70 * 1024)
    await writeFile(
      join(branchProjectDir, `${branchId}.jsonl`),
      `${JSON.stringify({
        ...user(id(84), null, 'branch prompt'),
        sessionId: branchId,
        cwd: branchProject,
      })}\n${JSON.stringify({
        ...user(id(85), id(84), largeText),
        sessionId: branchId,
        cwd: branchProject,
      })}\n${JSON.stringify(branchMetadata)}\n${JSON.stringify({
        ...assistant(id(86), id(85), largeText),
        sessionId: branchId,
        cwd: branchProject,
      })}\n`,
    )
    const result = await loadSameRepoMessageLogsProgressive(
      [rootProject, branchProject],
      undefined,
      10,
    )

    const branchLog = result.logs.find(log => log.sessionId === branchId)
    expect(branchLog).toBeDefined()
    expect(branchLog?.sessionBranch).toBeUndefined()
  } finally {
    setClaudeConfigHomeDirForTesting(undefined)
    getClaudeConfigHomeDir.cache?.clear?.()
  }
})

test('convertToLogOption throws for empty transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-session-storage-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'session.json')
  await writeFile(filePath, '[]')

  await expect(loadTranscriptFromFile(filePath)).rejects.toThrow(
    'convertToLogOption: cannot convert empty transcript',
  )
})

test('recurring heartbeat progress types are ephemeral', () => {
  expect(isEphemeralToolProgress('bash_progress')).toBe(true)
  expect(isEphemeralToolProgress('powershell_progress')).toBe(true)
  expect(isEphemeralToolProgress('mcp_progress')).toBe(true)
  expect(isEphemeralToolProgress('waiting_for_task')).toBe(true)
  expect(isEphemeralToolProgress('agent_progress')).toBe(false)
  expect(isEphemeralToolProgress(undefined)).toBe(false)
})
