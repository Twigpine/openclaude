import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
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
  switchSession(originalSessionId as never, null)
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
