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
import { deleteSession } from '../entrypoints/sdk/sessions.js'
import type { Message } from '../types/message.js'
import type { SessionId } from '../types/ids.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import {
  adoptResumedSessionFile,
  cacheSessionTitle,
  flushSessionStorage,
  getCurrentSessionTitle,
  getTranscriptPathForSession,
  reAppendSessionMetadata,
  recordAttributionSnapshot,
  recordGoalState,
  recordTranscript,
  resetProjectForTesting,
  resetSessionFilePointer,
  saveTag,
} from './sessionStorage.js'
import { createGoalState } from '../services/goal/state.js'

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

test("B's tag does not leak into A's transcript when A re-appends metadata", async () => {
  // CodeRabbit on #2489: the metadata caches (title/tag/...) stayed
  // process-wide while sessionFile went per-context. B's switch clears
  // A's cached title, B loads a tag, and A's reAppendSessionMetadata —
  // finding no tag in A's transcript tail — writes B's tag into A's file.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message('41000000-0000-4000-8000-00000000000e', 'A first')])
    await flushSessionStorage()
  })

  await turnStart(SESSION_B, async () => {
    await saveTag(SESSION_B as never, 'b-tag')
    await flushSessionStorage()
  })

  // A's compaction/exit re-append, still in flight in A's context.
  await turnContinuation(SESSION_A, async () => {
    reAppendSessionMetadata()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).not.toContain('"tag":"b-tag"')
  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).toContain('"tag":"b-tag"')
})

test("B's switch does not clear A's cached title", async () => {
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message('41000000-0000-4000-8000-00000000000f', 'A first')])
    await flushSessionStorage()
    // Cache-only title: never written to disk yet, so the tail cannot
    // refresh it back — only the in-memory cache can carry it.
    cacheSessionTitle('A Title')
  })

  // B's turn switches, which used to wipe the process-wide title cache.
  await turnStart(SESSION_B, async () => {
    await recordTranscript([message('41000000-0000-4000-8000-000000000010', 'B first')])
    await flushSessionStorage()
  })

  await turnContinuation(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
    reAppendSessionMetadata()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('A Title')
  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).not.toContain('A Title')
})

test('the per-context transcript cache stays bounded across many sessions', async () => {
  // CodeRabbit on #2489: sessionFiles retains one entry per materialized
  // session and nothing ever releases them — a long-running SDK host
  // grows the map with every session it creates and closes.
  const sessionStorage = await import('./sessionStorage.js')
  const getCacheSize = (
    sessionStorage as unknown as {
      getSessionTranscriptCacheSizeForTesting?: () => number
    }
  ).getSessionTranscriptCacheSizeForTesting
  expect(getCacheSize).toBeDefined()

  const ids = Array.from({ length: 105 }, () => randomUUID())
  for (const id of ids) {
    await turnStart(id, async () => {
      // Adopting the (not yet existing) transcript path materializes the
      // session's cache entry without creating a file.
      adoptResumedSessionFile()
    })
  }
  expect(getCacheSize!()).toBeLessThanOrEqual(100)
})

test('a session evicted from the bounded cache still appends to its own file', async () => {
  // Eviction must be safe: the path is re-derived from the context
  // identity, so an evicted session's next record still lands in its own
  // transcript instead of being lost or misdirected.
  const ids = Array.from({ length: 105 }, () => randomUUID())
  const first = ids[0]!
  for (const id of ids) {
    await turnStart(id, async () => {
      adoptResumedSessionFile()
    })
  }

  await turnContinuation(first, async () => {
    await recordTranscript([message(randomUUID(), 'first session still here')])
    await flushSessionStorage()
  })

  const firstText = await readFile(getTranscriptPathForSession(first), 'utf8')
  expect(firstText).toContain('first session still here')
  const firstIds = await sessionIds(first)
  expect(firstIds.every(id => id === first)).toBe(true)
})

test('the metadata cache stays bounded across many title-only contexts', async () => {
  // CodeRabbit on #2489: the path-bound test above adopts paths but never
  // creates metadata entries, so it would pass without the metadata
  // eviction loop. Title-only contexts exercise that loop alone.
  const sessionStorage = await import('./sessionStorage.js')
  const getCacheSize = (
    sessionStorage as unknown as {
      getSessionTranscriptCacheSizeForTesting?: () => number
    }
  ).getSessionTranscriptCacheSizeForTesting
  expect(getCacheSize).toBeDefined()

  // Seed a started session first: before any session has started,
  // cacheSessionTitle is treated as a deferred startup selection and
  // migrated between contexts instead of accumulating per context.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
  })

  const ids = Array.from({ length: 105 }, () => randomUUID())
  for (const id of ids) {
    await turnStart(id, async () => {
      cacheSessionTitle(`Title ${id}`)
    })
  }
  // 105 distinct title-only contexts, no paths adopted: without the
  // metadata eviction loop this would be 106 (105 titles plus the seed
  // turn's cached last-prompt).
  expect(getCacheSize!()).toBe(100)
})

test("an evicted session's goal-state write still reaches its existing transcript", async () => {
  // CodeRabbit on #2489: if 100 other contexts evict a live session's
  // pointer, its next non-conversation entry is buffered even though its
  // transcript already exists — and flush() never writes that buffer, so a
  // turn that ends after recording a goal state loses it.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
  })

  const ids = Array.from({ length: 105 }, () => randomUUID())
  for (const id of ids) {
    await turnStart(id, async () => {
      adoptResumedSessionFile()
    })
  }

  // No further user/assistant message: the turn ends after the goal record.
  await turnContinuation(SESSION_A, async () => {
    await recordGoalState(createGoalState('evicted session goal'), SESSION_A as never)
    await flushSessionStorage()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('"type":"goal-state"')
  expect(aText).toContain('evicted session goal')
})

test("a returning session keeps its cached title when the title is outside the transcript tail", async () => {
  // CodeRabbit on #2489: when SDK sessions alternate turns, the returning
  // switch clears the incoming session's own cached metadata. If its title
  // has fallen outside the 64KB tail readLiteMetadata scans, the next write
  // cannot re-append it.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
    reAppendSessionMetadata()
    // Push the title out of the 64KB tail window.
    for (let i = 0; i < 20; i++) {
      await recordTranscript([message(randomUUID(), 'x'.repeat(5000))])
    }
    await flushSessionStorage()
  })

  await turnStart(SESSION_B, async () => {
    await recordTranscript([message(randomUUID(), 'B first')])
    await flushSessionStorage()
  })

  // Return switch to A, then A's next write.
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
    await recordTranscript([message(randomUUID(), 'A returns')])
    await flushSessionStorage()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  // Once from the first re-append, once from the returning turn's write.
  expect(aText.split('A Title').length - 1).toBe(2)
})

test('a deleted session id reused for a fresh session does not inherit its title or tag', async () => {
  // CodeRabbit on #2489: if an SDK session is deleted and a later query
  // reuses its ID and cwd, the new transcript can inherit the deleted
  // session's cached title or tag. The metadata cache is keyed by the
  // (session id, project dir, cwd) triple, so the reused triple hits the
  // same entry — and neither delete path clears it: SDK deleteSession only
  // unlinks the file, and forgetDeletedSession only drops the path/pending
  // caches. The fresh file's tail holds no title/tag, so the exit
  // re-append below would write the stale cache straight into it.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
    await saveTag(SESSION_A as never, 'a-tag')
    await flushSessionStorage()
  })

  await deleteSession(SESSION_A)
  expect(existsSync(getTranscriptPathForSession(SESSION_A))).toBe(false)

  // A later query reuses the id and cwd for a fresh session.
  await turnStart(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A fresh')])
    await flushSessionStorage()
    // Exit-time re-append: where the stale cache would land.
    reAppendSessionMetadata()
  })
  await flushSessionStorage()

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  expect(aText).toContain('A fresh')
  expect(aText).not.toContain('A Title')
  expect(aText).not.toContain('a-tag')
})
