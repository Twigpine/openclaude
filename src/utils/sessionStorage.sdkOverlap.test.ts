import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
  isSessionPersistenceDisabled,
  runWithSdkContext,
  setOriginalCwd,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import type { Message } from '../types/message.js'
import type { SessionId } from '../types/ids.js'
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
  resetSessionFilePointer,
} from './sessionStorage.js'

/**
 * Two overlapping SDK sessions in one process must not share a transcript
 * file pointer (#2267).
 *
 * `Project` is a process-wide singleton, but the session id it appends for
 * is context-scoped (`AsyncLocalStorage` in `bootstrap/state.ts`). Each SDK
 * session runs its turns inside its own `SdkContext`, while `Project`
 * cached the resolved transcript path in a single `sessionFile` field.
 * When session B switches while a turn in session A is still in flight,
 * the switch clears that one pointer and B's next write resolves it to
 * B's file — and A's `isCurrentSession` check still passes, because the
 * id really is A in A's context. A's record then lands in B's file: lost
 * from A's transcript, and resuming A misses it.
 *
 * The sequential case (#2253, #2464) is covered by
 * sessionStorage.sessionSwitch.test.ts; these tests interleave two live SDK
 * contexts instead of switching once and moving on.
 */
const SESSION_A = '31000000-0000-4000-8000-000000000001'
const SESSION_B = '31000000-0000-4000-8000-000000000002'
const TIMESTAMP = '2026-09-30T00:00:00.000Z'

let testRoot = ''
let workspace = ''
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

function sdkContext(sessionId: string, projectDir: string | null = null) {
  return {
    sessionId: sessionId as SessionId,
    sessionProjectDir: projectDir,
    cwd: projectDir ?? workspace,
    originalCwd: projectDir ?? workspace,
  }
}

/**
 * Start of a turn: what v2 `sendMessage` does once per turn — switch (inside
 * the session's own context) so transcript writes resolve to this session —
 * then run `fn`.
 */
function turnStart(
  sessionId: string,
  fn: () => Promise<void>,
  projectDir: string | null = null,
): Promise<void> {
  return runWithSdkContext(sdkContext(sessionId, projectDir), async () => {
    switchSession(sessionId as never, projectDir)
    await fn()
  })
}

/**
 * Continuation of a turn already in flight: the engine loop records
 * transcripts for yielded messages WITHOUT switching again (v2 switches
 * once, at the top of sendMessage). This is the window the bug lives in:
 * another session may have switched — and resolved the shared pointer to
 * its own file — since this turn started.
 */
function turnContinuation(
  sessionId: string,
  fn: () => Promise<void>,
  projectDir: string | null = null,
): Promise<void> {
  return runWithSdkContext(sdkContext(sessionId, projectDir), fn)
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
  await acquireSharedMutationLock('utils/sessionStorage.sdkOverlap.test.ts')
  testRoot = await mkdtemp(join(tmpdir(), 'openclaude-session-sdk-overlap-'))
  originalCwd = getOriginalCwd()
  originalSessionId = getSessionId()
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
  workspace = join(testRoot, 'workspace')
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

test('a record from session A still in flight lands in A after B resolves the pointer', async () => {
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message('41000000-0000-4000-8000-000000000001', 'A first')])
    await flushSessionStorage()
  })

  // B's turn switches (clearing the shared pointer) and resolves it to
  // B's file. A's turn is still in flight: its next record must not follow.
  await turnStart(SESSION_B, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000002', 'B first')])
    await flushSessionStorage()
  })

  await turnContinuation(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000003', 'A second')])
    await flushSessionStorage()
  })

  const aIds = await sessionIds(SESSION_A)
  expect(aIds.length).toBeGreaterThanOrEqual(2)
  expect(aIds.every(id => id === SESSION_A)).toBe(true)
  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('A second')

  const bIds = await sessionIds(SESSION_B)
  expect(bIds.length).toBeGreaterThan(0)
  expect(bIds.every(id => id === SESSION_B)).toBe(true)
  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).not.toContain('A second')
})

test('a session buffers entries while another SDK session materializes its own file', async () => {
  // A records metadata before its first user/assistant message, so the
  // entry waits in the buffer with no file yet.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordAttributionSnapshot({
      type: 'attribution-snapshot',
      messageId: '41000000-0000-4000-8000-000000000004' as UUID,
      surface: 'sdk',
      fileStates: {},
    })
  })
  expect(existsSync(getTranscriptPathForSession(SESSION_A))).toBe(false)

  await turnStart(SESSION_B, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000005', 'B first')])
    await flushSessionStorage()
  })

  // A's first user message materializes A's file; the buffered entry
  // belongs to A and must come out with it — not into B's file, and not
  // dropped.
  await turnContinuation(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000006', 'A first')])
    await flushSessionStorage()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('attribution-snapshot')
  expect(aText).toContain('A first')
  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).not.toContain('attribution-snapshot')
  expect(bText).not.toContain('A first')
})

test('the same session id in another project directory is another file per context', async () => {
  const here = join(testRoot, 'here')
  const there = join(testRoot, 'there')
  await mkdir(here, { recursive: true })
  await mkdir(there, { recursive: true })

  await turnStart(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000007', 'written here')])
    await flushSessionStorage()
  }, here)

  await turnStart(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000008', 'written there')])
    await flushSessionStorage()
  }, there)

  // The first context's turn is still in flight; its next record must not
  // follow the second context's pointer back into `there`.
  await turnContinuation(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000009', 'written here again')])
    await flushSessionStorage()
  }, here)

  const hereText = await readFile(join(here, `${SESSION_A}.jsonl`), 'utf8')
  expect(hereText).toContain('written here again')
  expect(hereText).not.toContain('written there')
  const thereText = await readFile(join(there, `${SESSION_A}.jsonl`), 'utf8')
  expect(thereText).toContain('written there')
  expect(thereText).not.toContain('written here again')
})

test('a pointer reset in one SDK context does not move another context file', async () => {
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message('41000000-0000-4000-8000-00000000000a', 'A first')])
    await flushSessionStorage()
  })

  // What print/CLI paths do after a switch: reset the pointer. Run in B's
  // context, it must not clear A's cached file.
  await turnStart(SESSION_B, async () => {
    await resetSessionFilePointer()
    await recordTranscript([message('41000000-0000-4000-8000-00000000000b', 'B first')])
    await flushSessionStorage()
  })

  await turnContinuation(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A second')])
    await flushSessionStorage()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('A second')
  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).not.toContain('A second')
})

test('switching before every turn with the same id keeps the same file', async () => {
  // v2 switches before EVERY turn with the id it already has; that must
  // keep working — the pointer is re-resolved to the same file, not lost.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message('41000000-0000-4000-8000-00000000000c', 'one')])
    await flushSessionStorage()
  })

  await turnStart(SESSION_A, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-00000000000d', 'two')])
    await flushSessionStorage()
  })

  const ids = await sessionIds(SESSION_A)
  expect(ids.filter(id => id === SESSION_A).length).toBeGreaterThanOrEqual(2)
})
