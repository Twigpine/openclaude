import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
