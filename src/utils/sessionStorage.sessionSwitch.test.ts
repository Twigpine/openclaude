import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  setOriginalCwd,
  setSessionPersistenceDisabled,
  resetStateForTests,
  switchSession,
} from '../bootstrap/state.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import type { Message } from '../types/message.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { processResumedConversation } from './sessionRestore.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import {
  flushSessionStorage,
  getTranscriptPathForSession,
  recordAttributionSnapshot,
  recordTranscript,
  resetProjectForTesting,
  cacheSessionTitle,
  clearSessionMetadata,
  getCurrentSessionTitle,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveAgentSetting,
  saveWorktreeState,
} from './sessionStorage.js'

/**
 * A second session in one process must write to its own transcript.
 *
 * `Project.sessionFile` is resolved once and cached for the life of the
 * process. Every CLI path that changes the active session resets it by hand
 * right after switchSession; the v2 SDK switches inside sendMessage, where an
 * embedder has no moment to hook. So a session created after the first one
 * went on appending to the first one's file — records carrying its own
 * sessionId, in someone else's transcript — and resuming it found no file and
 * came back with an empty conversation.
 */
const FIRST = '30000000-0000-4000-8000-000000000001'
const SECOND = '30000000-0000-4000-8000-000000000002'
const TIMESTAMP = '2026-09-30T00:00:00.000Z'

let testRoot = ''
let originalCwd = ''
let originalSessionId = ''
let originalSessionProjectDir: string | null = null
let originalConfigOverride: string | undefined
let originalPersistenceDisabled = false
let originalNodeEnv: string | undefined
let originalTestPersistence: string | undefined
let originalPersistence: string | undefined

function message(uuid: string, content: string): Message {
  return {
    type: 'user',
    uuid: uuid as UUID,
    timestamp: TIMESTAMP,
    message: { role: 'user', content },
    isMeta: false,
  } as Message
}

async function sessionIds(sessionId: string): Promise<string[]> {
  const path = getTranscriptPathForSession(sessionId)
  if (!existsSync(path)) return []
  const text = await readFile(path, 'utf8')
  const ids: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const entry = JSON.parse(line) as { sessionId?: string }
      if (entry.sessionId) ids.push(entry.sessionId)
    } catch {
      // Not every line carries JSON we care about here.
    }
  }
  return ids
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/sessionStorage.sessionSwitch.test.ts')
  testRoot = await mkdtemp(join(tmpdir(), 'openclaude-session-switch-'))
  originalCwd = getOriginalCwd()
  originalSessionId = getSessionId()
  // Restored with the id below: switchSession sets both, and handing back
  // `null` would move the active session's transcript for every later test.
  originalSessionProjectDir = getSessionProjectDir()
  originalConfigOverride = getClaudeConfigHomeDirOverrideForTesting()
  originalPersistenceDisabled = isSessionPersistenceDisabled()
  originalNodeEnv = process.env.NODE_ENV
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  originalPersistence = process.env.ENABLE_SESSION_PERSISTENCE
  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  setSessionPersistenceDisabled(false)

  const configDir = join(testRoot, 'config')
  const workspace = join(testRoot, 'workspace')
  await mkdir(workspace, { recursive: true })
  setClaudeConfigHomeDirForTesting(configDir)
  setOriginalCwd(workspace)
  resetProjectForTesting()
})

afterEach(async () => {
  try {
    await flushSessionStorage()
  } catch {
    // Nothing queued; the restore below is what matters.
  }
  resetProjectForTesting()
  switchSession(originalSessionId as never, originalSessionProjectDir)
  setOriginalCwd(originalCwd)
  setClaudeConfigHomeDirForTesting(originalConfigOverride)
  setSessionPersistenceDisabled(originalPersistenceDisabled)
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
  if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  if (originalPersistence === undefined) delete process.env.ENABLE_SESSION_PERSISTENCE
  else process.env.ENABLE_SESSION_PERSISTENCE = originalPersistence
  await rm(testRoot, { recursive: true, force: true })
  releaseSharedMutationLock()
})

test('a second session in the same process writes to its own transcript', async () => {
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })
  await recordTranscript([message('40000000-0000-4000-8000-000000000001', 'first session')])
  await flushSessionStorage()

  // What the v2 SDK does when the embedder starts a new conversation: same
  // process, same Project singleton, a different session id.
  switchSession(SECOND as never, null)
  await recordTranscript([message('40000000-0000-4000-8000-000000000002', 'second session')])
  await flushSessionStorage()

  const second = await sessionIds(SECOND)
  expect(second.length).toBeGreaterThan(0)
  expect(second.every(id => id === SECOND)).toBe(true)

  // And the first session kept its own records, with nothing of the second
  // leaked in — which is what made the damage invisible: the records were
  // written, just not where anything could find them.
  const firstIds = await sessionIds(FIRST)
  expect(firstIds.length).toBeGreaterThan(0)
  expect(firstIds.every(id => id === FIRST)).toBe(true)
})

test('switching to the same session id keeps the file it already has', async () => {
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })
  await recordTranscript([message('40000000-0000-4000-8000-000000000003', 'one')])
  await flushSessionStorage()

  // v2 switches before EVERY turn with the id it already has. Resetting the
  // pointer each time would drop buffered entries for nothing.
  switchSession(FIRST as never, null)
  await recordTranscript([message('40000000-0000-4000-8000-000000000004', 'two')])
  await flushSessionStorage()

  const ids = await sessionIds(FIRST)
  expect(ids.filter(id => id === FIRST).length).toBeGreaterThanOrEqual(2)
})

/**
 * AND IT KEEPS WHAT IS STILL IN THE BUFFER.
 *
 * Raised in review, and the test above cannot see it: it flushes before the
 * second switch, so there is nothing buffered left to lose. Entries recorded
 * before the first user or assistant message wait in memory until the file is
 * materialized, and `resetSessionFile()` throws that buffer away. A listener
 * that reset on EVERY switch — including the same-id one v2 makes before each
 * turn — would silently drop them.
 */
test('a same-id switch does not throw away entries still waiting to be written', async () => {
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })

  // Nothing has materialized the file yet, so this waits in the buffer.
  await recordAttributionSnapshot({
    type: 'attribution-snapshot',
    messageId: '40000000-0000-4000-8000-000000000007' as UUID,
    surface: 'sdk',
    fileStates: {},
  })
  expect(existsSync(getTranscriptPathForSession(FIRST))).toBe(false)

  switchSession(FIRST as never, null)

  // The first user message materializes the file; the buffered entry has to
  // come out with it.
  await recordTranscript([message('40000000-0000-4000-8000-000000000008', 'after the switch')])
  await flushSessionStorage()

  const text = await readFile(getTranscriptPathForSession(FIRST), 'utf8')
  expect(text).toContain('attribution-snapshot')
  expect(text).toContain('40000000-0000-4000-8000-000000000008')
})

/**
 * A SECOND SESSION DOES NOT INHERIT THE FIRST SESSION'S LAST PROMPT.
 *
 * Raised in review. The `currentSession*` caches are documented as "current
 * session only", but switching did not clear them: when the second session
 * materialized its file, reAppendSessionMetadata() wrote the FIRST session's
 * lastPrompt into it. The CLI worked around this by hand (clearSessionMetadata
 * before restoreSessionMetadata); the SDK has no restore to put anything back,
 * so resetSessionFile() clears the caches itself.
 */
test('a second session does not inherit the first session previous prompt', async () => {
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })
  await recordTranscript([
    message('40000000-0000-4000-8000-00000000000b', 'the first session prompt'),
  ])
  await flushSessionStorage()

  switchSession(SECOND as never, null)
  await mkdir(dirname(getTranscriptPathForSession(SECOND)), { recursive: true, mode: 0o700 })
  await recordTranscript([
    message('40000000-0000-4000-8000-00000000000c', 'the second session prompt'),
  ])
  await flushSessionStorage()

  const secondText = await readFile(getTranscriptPathForSession(SECOND), 'utf8')
  expect(secondText).toContain('the second session prompt')
  // A stale cache would land here as a last-prompt entry.
  expect(secondText).not.toContain('the first session prompt')
})

/**
 * A DIFFERENT-ID SWITCH KEEPS BUFFERED ENTRIES FOR THEIR OWN SESSION.
 *
 * Raised in review. resetSessionFile() dropped the buffer, so a session that
 * had recorded an attribution snapshot but not yet materialized lost it when
 * another session's turn switched away — and found it empty if it returned.
 * Buffers are keyed by session now, and only the materializing session's is
 * flushed.
 */
test('a different-id switch keeps entries buffered for their own session', async () => {
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })
  await recordAttributionSnapshot({
    type: 'attribution-snapshot',
    messageId: '40000000-0000-4000-8000-00000000000d' as UUID,
    surface: 'sdk',
    fileStates: {},
  })
  expect(existsSync(getTranscriptPathForSession(FIRST))).toBe(false)

  // Another session runs and returns before FIRST ever materializes.
  switchSession(SECOND as never, null)
  switchSession(FIRST as never, null)

  await recordTranscript([
    message('40000000-0000-4000-8000-00000000000e', 'after the round trip'),
  ])
  await flushSessionStorage()

  const text = await readFile(getTranscriptPathForSession(FIRST), 'utf8')
  expect(text).toContain('attribution-snapshot')
  expect(text).toContain('after the round trip')
})

/**
 * THE SAME ID IS NOT THE SAME FILE.
 *
 * Raised in review. `switchSession(id, projectDir)` sets both and emits only
 * the id, so an id-only guard lets a directory change past and leaves the
 * pointer aimed at the old directory's transcript. Both SDK paths do exactly
 * this: v2 switches with the session's own project dir before every turn, and
 * query() with the resolved transcript dir.
 */
test('a same-id switch to another project directory moves the pointer', async () => {
  const here = join(testRoot, 'here')
  const there = join(testRoot, 'there')
  await mkdir(here, { recursive: true })
  await mkdir(there, { recursive: true })

  switchSession(FIRST as never, here)
  await recordTranscript([message('40000000-0000-4000-8000-000000000009', 'written here')])
  await flushSessionStorage()
  const first = getTranscriptPathForSession(FIRST)

  // Same session, somewhere else. Nothing about the id changed.
  switchSession(FIRST as never, there)
  await recordTranscript([message('40000000-0000-4000-8000-00000000000a', 'written there')])
  await flushSessionStorage()
  const second = getTranscriptPathForSession(FIRST)

  expect(second).not.toBe(first)
  expect(await readFile(second, 'utf8')).toContain('written there')
  // The point: the second record did NOT land in the first directory's file.
  expect(await readFile(first, 'utf8')).not.toContain('written there')
})

test('buffered entries stay with their directory across a same-id round trip', async () => {
  const here = join(testRoot, 'here')
  const there = join(testRoot, 'there')
  await mkdir(here, { recursive: true })
  await mkdir(there, { recursive: true })
  switchSession(FIRST as never, here)
  const snapshotId = randomUUID()
  await recordAttributionSnapshot({
    type: 'attribution-snapshot',
    messageId: snapshotId,
    surface: 'sdk',
    fileStates: {},
  })
  const first = getTranscriptPathForSession(FIRST)
  expect(existsSync(first)).toBe(false)

  switchSession(FIRST as never, there)
  await recordTranscript([message(randomUUID(), 'written there')])
  await flushSessionStorage()
  const second = getTranscriptPathForSession(FIRST)
  expect(await readFile(second, 'utf8')).not.toContain(snapshotId)

  switchSession(FIRST as never, here)
  await recordTranscript([message(randomUUID(), 'written here')])
  await flushSessionStorage()
  expect(await readFile(first, 'utf8')).toContain(snapshotId)
})

/**
 * Pointer-following must survive another test file wiping the signal.
 *
 * Raised in review. `resetStateForTests()` calls `sessionSwitched.clear()`,
 * dropping every listener. Test files share one bun process, so a module that
 * only remembered "I am subscribed" would believe it was still following
 * switches while its listener was gone — and would then stop following them
 * for every test that ran afterwards, failing in a full-suite run and nowhere
 * else. This reproduces that order deliberately.
 */
test('the switch listener is re-registered after the signal is cleared', async () => {
  // Create the Project, so the listener exists to be lost.
  switchSession(FIRST as never, null)
  await mkdir(dirname(getTranscriptPathForSession(FIRST)), { recursive: true, mode: 0o700 })
  await recordTranscript([message('40000000-0000-4000-8000-000000000004', 'before the wipe')])
  await flushSessionStorage()

  // What another test file does, and it takes every listener with it. That
  // file runs under NODE_ENV=test, which this one deliberately does not — the
  // guard in resetStateForTests is about who may call it, not about the bug.
  const persistenceEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  try {
    resetStateForTests()
  } finally {
    process.env.NODE_ENV = persistenceEnv
  }

  // Then this file's own setup runs again, as it would in a full-suite pass.
  setSessionPersistenceDisabled(false)
  setOriginalCwd(join(testRoot, 'workspace'))
  resetProjectForTesting()

  switchSession(FIRST as never, null)
  await recordTranscript([message('40000000-0000-4000-8000-000000000005', 'first again')])
  await flushSessionStorage()

  switchSession(SECOND as never, null)
  await recordTranscript([message('40000000-0000-4000-8000-000000000006', 'second after the wipe')])
  await flushSessionStorage()

  // Without a fresh subscription the pointer never moves and this lands in
  // FIRST's file, which is the original bug wearing a different hat.
  const second = await sessionIds(SECOND)
  expect(second.length).toBeGreaterThan(0)
  expect(second.every(id => id === SECOND)).toBe(true)
})

test.each([undefined, 'saved title'])(
  'interactive startup name survives resume and adoption (saved title: %s)',
  async customTitle => {
    process.env.NODE_ENV = 'test'
    const path = getTranscriptPathForSession(FIRST)
    await mkdir(dirname(path), { recursive: true })
    const previous = message(randomUUID(), 'previous turn')
    await writeFile(path, JSON.stringify({ ...previous, sessionId: FIRST }) + '\n')
    cacheSessionTitle('requested title')

    await processResumedConversation(
      { messages: [previous], sessionId: FIRST as UUID, customTitle },
      { forkSession: false, transcriptPath: path },
      {
        modeApi: null,
        mainThreadAgentDefinition: undefined,
        agentDefinitions: { activeAgents: [], allAgents: [] },
        currentCwd: getOriginalCwd(),
        cliAgents: [],
        initialState: getDefaultAppState(),
      },
    )
    await flushSessionStorage()

    expect(getCurrentSessionTitle(getSessionId())).toBe('requested title')
    const entries = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.filter(entry => entry.type === 'custom-title').at(-1)?.customTitle)
      .toBe('requested title')
    // Adoption must persist the name even when no new message is sent.
    expect(entries.filter(entry => entry.type === 'user')).toHaveLength(1)
  },
)

test.each(['custom-title', 'agent-setting', 'worktree-state'])(
  'print resume persists deferred startup %s after both pointer resets',
  async type => {
    const worktree = {
      originalCwd: getOriginalCwd(),
      worktreePath: join(testRoot, 'worktree'),
      worktreeName: 'startup-worktree',
      sessionId: FIRST,
    }
    const path = getTranscriptPathForSession(FIRST)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({
      ...message(randomUUID(), 'previous turn'), sessionId: FIRST,
    }) + '\n')
    cacheSessionTitle('startup title')
    saveAgentSetting('startup-agent')
    saveWorktreeState(worktree)

    // Storage order used by print's continue/resume initialization. There is
    // no saved metadata to replace the explicit startup selections.
    switchSession(FIRST as never, null)
    await resetSessionFilePointer()
    restoreSessionMetadata({})
    await recordTranscript([message(randomUUID(), 'next turn')])
    await flushSessionStorage()

    const entries = (await readFile(getTranscriptPathForSession(FIRST), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    const entry = entries.filter(entry => entry.type === type).at(-1)
    expect(entry).toBeDefined()
    expect(entry.sessionId).toBe(FIRST)
    if (type === 'custom-title') expect(entry.customTitle).toBe('startup title')
    if (type === 'agent-setting') expect(entry.agentSetting).toBe('startup-agent')
    if (type === 'worktree-state') expect(entry.worktreeSession).toEqual(worktree)
  },
)

test.each(['explicit clear', 'session switch'])(
  '%s does not carry startup metadata into another conversation',
  async reset => {
    switchSession(FIRST as never, null)
    cacheSessionTitle('private title')
    saveAgentSetting('private-agent')
    saveWorktreeState({
      originalCwd: getOriginalCwd(),
      worktreePath: join(testRoot, 'private-worktree'),
      worktreeName: 'private-worktree',
      sessionId: FIRST,
    })
    if (reset === 'explicit clear') {
      clearSessionMetadata()
    } else {
      await recordTranscript([message(randomUUID(), 'first')])
      await flushSessionStorage()
    }
    switchSession(SECOND as never, null)
    await resetSessionFilePointer()
    await recordTranscript([message(randomUUID(), 'second')])
    await flushSessionStorage()
    expect(await readFile(getTranscriptPathForSession(SECOND), 'utf8')).not.toContain('private')
  },
)

test('a nonpersisted session does not pass runtime worktree metadata to the next session', async () => {
  const skipHistory = process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  const testPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  try {
    // query(options.env) can disable persistence for one SDK session while
    // its EnterWorktree tool still caches worktree state.
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'false'
    process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
    switchSession(FIRST as never, null)
    await recordTranscript([message(randomUUID(), 'nonpersisted turn')])
    saveWorktreeState({
      originalCwd: getOriginalCwd(),
      worktreePath: join(testRoot, 'private-worktree'),
      worktreeName: 'private-worktree',
      sessionId: FIRST,
    })
    expect(existsSync(getTranscriptPathForSession(FIRST))).toBe(false)
  } finally {
    if (skipHistory === undefined) delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
    else process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = skipHistory
    if (testPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    else process.env.TEST_ENABLE_SESSION_PERSISTENCE = testPersistence
  }

  switchSession(SECOND as never, null)
  await recordTranscript([message(randomUUID(), 'persisted turn')])
  await flushSessionStorage()
  expect(await readFile(getTranscriptPathForSession(SECOND), 'utf8')).not.toContain('private-worktree')
})
