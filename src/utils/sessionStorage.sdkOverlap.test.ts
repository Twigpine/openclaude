import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { randomUUID, type UUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
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
  finishDeletedSession,
  flushSessionStorage,
  forgetDeletedSession,
  getCurrentSessionTitle,
  getDroppedSessionMetadataSizeForTesting,
  getProjectDir,
  getSessionTranscriptCacheSizeForTesting,
  getTranscriptPathForSession,
  reAppendSessionMetadata,
  recordAttributionSnapshot,
  recordGoalState,
  recordTranscript,
  resetProjectForTesting,
  resetSessionFilePointer,
  restoreSessionMetadata,
  restoreSessionWrites,
  saveAiGeneratedTitle,
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
// Provisional identity session B holds before a --continue/--resume switch
// picks its resumed id: startup selections are cached under this key.
const SESSION_B_STARTUP = '31000000-0000-4000-8000-000000000003'
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

test('deleting one project directory\u2019s transcript keeps the same session id\u2019s cached metadata in another directory', async () => {
  // CodeRabbit on #2489: forgetSessionCaches drops every cache entry with
  // the session id prefix, so deleting one project directory's transcript
  // also clears another directory's cached title for the same id. If that
  // title has fallen outside both 64KB windows, its next re-append cannot
  // restore it to the resume list.
  const dirA = getProjectDir(join(workspace, 'a'))
  const dirB = getProjectDir(join(workspace, 'b'))
  await mkdir(join(workspace, 'a'), { recursive: true })
  await mkdir(join(workspace, 'b'), { recursive: true })

  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A in dir B first')])
    await flushSessionStorage()
    cacheSessionTitle('B Title')
    reAppendSessionMetadata()
    // Push the title out of the 64KB tail window.
    for (let i = 0; i < 20; i++) {
      await recordTranscript([message(randomUUID(), 'x'.repeat(5000))])
    }
    await flushSessionStorage()
  }, dirB)

  // Same session id, other directory, its own title.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A in dir A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  }, dirA)

  // Delete only dir A's transcript.
  await deleteSession(SESSION_A, { dir: join(workspace, 'a') })
  expect(existsSync(join(dirA, `${SESSION_A}.jsonl`))).toBe(false)
  expect(existsSync(join(dirB, `${SESSION_A}.jsonl`))).toBe(true)

  // The surviving directory's cached title must still be there.
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('B Title')
    await recordTranscript([message(randomUUID(), 'A in dir B returns')])
    await flushSessionStorage()
  }, dirB)

  const bText = await readFile(join(dirB, `${SESSION_A}.jsonl`), 'utf8')
  // Once from the first re-append, once from the post-delete write.
  expect(bText.split('B Title').length - 1).toBe(2)
  expect(bText).not.toContain('A Title')
})

test('a failed deletion restores the session\u2019s cached metadata', async () => {
  // CodeRabbit on #2489: if unlink fails and the transcript survives,
  // restoreSessionWrites leaves the metadata cache empty, so a title
  // outside the tail cannot be recovered during the next re-append.
  // Drive the failure through deleteSession itself: an injected unlink
  // failure must make deleteSession reject, and its own recovery must
  // bring the cached title back. Calling restoreSessionWrites directly
  // could not detect a missing recovery call in deleteSession.
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

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  const realUnlink = fsPromises.unlink
  spyOn(fsPromises, 'unlink').mockImplementation(async path => {
    if (path === transcriptPath) {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
    }
    return realUnlink(path)
  })

  await expect(deleteSession(SESSION_A)).rejects.toThrow('resource busy or locked')
  mock.restore()

  // The transcript survived the failed removal: deleteSession's own
  // recovery restores the cached title, and later writes succeed.
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
    await recordTranscript([message(randomUUID(), 'A returns')])
    await flushSessionStorage()
  })

  const aText = await readFile(transcriptPath, 'utf8')
  // Once from the first re-append, once from the post-restore write.
  expect(aText.split('A Title').length - 1).toBe(2)
})

test('overlapping deletions of the same transcript keep the original metadata snapshot', async () => {
  // CodeRabbit on #2489: if two deletions reach forgetSessionCaches before
  // either removal fails, the second overwrites the first snapshot with an
  // empty one, and both failures leave the surviving session without its
  // cached metadata.
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

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await Promise.all([
    forgetDeletedSession(SESSION_A as never, transcriptPath),
    forgetDeletedSession(SESSION_A as never, transcriptPath),
  ])

  // Neither removal ran, so the transcript survived — but the restore is
  // deferred while the second attempt is still in flight: un-marking (and
  // restoring) on the first failure would let a replacement turn write to
  // the file the second attempt may yet remove. Each failure restores in
  // turn, as the delete callers do; the last one brings the title back.
  restoreSessionWrites(transcriptPath)
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBeUndefined()
  })
  finishDeletedSession(transcriptPath)
  restoreSessionWrites(transcriptPath)
  finishDeletedSession(transcriptPath)
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
  })
})

test('a failed deletion does not unblock writes while another deletion attempt is still running', async () => {
  // CodeRabbit on #2489: with two overlapping deletions, the first
  // attempt's failure path removed the deleted marker while the second
  // unlink was still pending — so a replacement turn could write to the
  // surviving file, the second unlink removed its data, and the path was
  // left unmarked for later metadata appends to recreate.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await Promise.all([
    forgetDeletedSession(SESSION_A as never, transcriptPath),
    forgetDeletedSession(SESSION_A as never, transcriptPath),
  ])

  // The first attempt's removal fails: its restore must wait for the
  // second attempt, not unblock writes while it is still pending.
  restoreSessionWrites(transcriptPath)
  finishDeletedSession(transcriptPath)

  // A late metadata write while the second attempt is still running.
  saveAiGeneratedTitle(SESSION_A as never, 'late ai title')
  await flushSessionStorage()
  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).not.toContain('late ai title')

  // The second attempt settles: the transcript is gone.
  await unlink(transcriptPath)
  finishDeletedSession(transcriptPath)
  expect(existsSync(transcriptPath)).toBe(false)
})

test('a successful deletion discards the dropped metadata snapshot', async () => {
  // CodeRabbit on #2489: droppedSessionMetadata retains a deleted session's
  // cached metadata indefinitely, and the 100-entry cache limit never
  // applies to these snapshots. A successful removal must drop its own.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await deleteSession(SESSION_A)
  expect(existsSync(transcriptPath)).toBe(false)
  expect(getDroppedSessionMetadataSizeForTesting()).toBe(0)
})

test('a failed deletion does not restore metadata past the cache bound', async () => {
  // CodeRabbit on #2489: if other sessions fill the cache while deletion is
  // pending, a failed deletion can restore entries above the 100-entry
  // limit, and they stay until a later cache write enforces it.
  // Seed a started session first: before any session has started,
  // cacheSessionTitle is treated as a deferred startup selection and
  // migrated between contexts instead of accumulating per context.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await forgetDeletedSession(SESSION_A as never, transcriptPath)

  // Fill the cache to the bound while deletion is pending.
  const ids = Array.from({ length: 100 }, () => randomUUID())
  for (const id of ids) {
    await turnStart(id, async () => {
      cacheSessionTitle(`Title ${id}`)
    })
  }
  expect(getSessionTranscriptCacheSizeForTesting()).toBe(100)

  // The transcript survived: the restore must respect the bound, and the
  // restored title is the newest entry, so it survives the eviction.
  restoreSessionWrites(transcriptPath)
  expect(getSessionTranscriptCacheSizeForTesting()).toBeLessThanOrEqual(100)
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
  })
})

test('a failed deletion restores saved fields around a concurrent entry', async () => {
  // CodeRabbit on #2489: a live goal update while deletion is pending
  // creates a new metadata entry, and the old restore skipped keys that
  // already existed — discarding the saved title and tag.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
    await saveTag(SESSION_A as never, 'a-tag')
    reAppendSessionMetadata()
    // Push the title out of the 64KB tail window.
    for (let i = 0; i < 20; i++) {
      await recordTranscript([message(randomUUID(), 'x'.repeat(5000))])
    }
    await flushSessionStorage()
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await forgetDeletedSession(SESSION_A as never, transcriptPath)

  // A live goal update recreates the entry while deletion is pending:
  // same key, only the goal field — no title or tag.
  await turnStart(SESSION_A, async () => {
    await recordGoalState(createGoalState('concurrent goal'), SESSION_A as never)
  })

  // The transcript survived the failed removal: the restore must merge the
  // saved title/tag with the concurrent goal, not drop either side.
  restoreSessionWrites(transcriptPath)
  await turnStart(SESSION_A, async () => {
    expect(getCurrentSessionTitle(SESSION_A as never)).toBe('A Title')
    await recordTranscript([message(randomUUID(), 'A returns')])
    await flushSessionStorage()
  })

  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).toContain('A Title')
  expect(aText).toContain('a-tag')
  expect(aText).toContain('concurrent goal')
})

test('a failed deletion does not restore a goal that was explicitly cleared', async () => {
  // CodeRabbit on #2489: after deletion saved an active goal,
  // recordGoalState(null) deleted the goal field from the cache instead
  // of recording the clear — so a failed deletion's restore brought the
  // saved active goal back, and the next re-append wrote it again.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    await recordGoalState(createGoalState('active goal'), SESSION_A as never)
    await flushSessionStorage()
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await forgetDeletedSession(SESSION_A as never, transcriptPath)

  // A concurrent clear while deletion is pending: the goal is gone, and
  // the cache must remember that it was cleared on purpose.
  await turnStart(SESSION_A, async () => {
    await recordGoalState(null, SESSION_A as never)
  })

  // The transcript survived the failed removal: the restore must keep the
  // explicit clear, not bring the saved active goal back.
  restoreSessionWrites(transcriptPath)
  await turnStart(SESSION_A, async () => {
    reAppendSessionMetadata()
    await flushSessionStorage()
  })

  const aText = await readFile(transcriptPath, 'utf8')
  const goalEntries = aText
    .split('\n')
    .filter(line => line.includes('"type":"goal-state"'))
  // Only the original record: the clear must not be followed by a
  // resurrected re-append of the active goal.
  expect(goalEntries).toHaveLength(1)
  expect(goalEntries[0]).toContain('active goal')
})

test("an evicted session's metadata is re-stamped by reAppendSessionMetadata alone", async () => {
  // jatmn on #2489 (P2): after LRU eviction drops a materialized session's
  // pointer, reAppendSessionMetadata returns early on the null pointer, so
  // exit cleanup / compaction never re-stamp title/tag into the 64KB tail
  // even though the metadata cache still holds them.
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

  // Eviction drops the pointer AND the metadata entry, so a rename/tag
  // after eviction is what repopulates the metadata cache — cache-only
  // writes (saveTag would write straight to the file). The pointer is
  // the only thing that must be re-derived from the existing transcript.
  await turnContinuation(SESSION_A, async () => {
    cacheSessionTitle('A Evicted Title')
    restoreSessionMetadata({ tag: 'a-evicted-tag' })
    // Only the re-append — no recordTranscript / materialize.
    reAppendSessionMetadata()
    await flushSessionStorage()
  })

  const aText = await readFile(getTranscriptPathForSession(SESSION_A), 'utf8')
  // No new file was created: the transcript still holds the first message.
  expect(aText).toContain('A first')
  // Title/tag land at EOF, so the tail read finds them.
  const lines = aText.split('\n').filter(line => line.trim() !== '')
  expect(lines.length).toBeGreaterThanOrEqual(3)
  expect(lines.at(-2)).toContain('"type":"custom-title"')
  expect(lines.at(-2)).toContain('A Evicted Title')
  expect(lines.at(-1)).toContain('"type":"tag"')
  expect(lines.at(-1)).toContain('a-evicted-tag')
})

test('a deferred startup title survives a resume switch after another session materialized', async () => {
  // jatmn on #2489 (P2): one overlapping SDK session materializing set
  // the process-wide hasStartedSession flag, so migrateStartupMetadata
  // became a no-op and a second context's deferred startup title was
  // dropped on its resume switch instead of carried to the resumed key.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
  })

  // Session B caches its startup title under its provisional identity,
  // then the resume switch picks B's resumed id — in the same context,
  // as the real --continue/--resume flow does (a fresh store per turn
  // would already hold the resumed id, so the switch must happen here).
  await runWithSdkContext(sdkContext(SESSION_B_STARTUP), async () => {
    cacheSessionTitle('B Startup Title')
    switchSession(SESSION_B as never, null)
    expect(getCurrentSessionTitle(SESSION_B as never)).toBe('B Startup Title')
    await recordTranscript([message(randomUUID(), 'B first')])
    await flushSessionStorage()
  })

  const bText = await readFile(getTranscriptPathForSession(SESSION_B), 'utf8')
  expect(bText).toContain('B Startup Title')
  expect(bText).toContain('"type":"custom-title"')
})

test('a second context switching to the same id still migrates its startup selections', async () => {
  // CodeRabbit on #2489: the switch guard compared the incoming identity
  // with the last switch from ANY context, so when a second context
  // switched to the same id (from its own provisional identity), the
  // guard returned early and its deferred startup title never migrated.
  const workspaceA = join(testRoot, 'workspace-a')
  const workspaceC = join(testRoot, 'workspace-c')
  await mkdir(workspaceA, { recursive: true })
  await mkdir(workspaceC, { recursive: true })

  // One context switches to B with a null project directory first.
  await runWithSdkContext(
    {
      sessionId: SESSION_B as SessionId,
      sessionProjectDir: null,
      cwd: workspaceA,
      originalCwd: workspaceA,
    },
    async () => {
      switchSession(SESSION_B as never, null)
      await recordTranscript([message(randomUUID(), 'B in workspace A')])
      await flushSessionStorage()
    },
  )

  // Another context, with a different originalCwd, caches startup
  // selections under its provisional identity and switches to the same B.
  await runWithSdkContext(
    {
      sessionId: SESSION_B_STARTUP as SessionId,
      sessionProjectDir: null,
      cwd: workspaceC,
      originalCwd: workspaceC,
    },
    async () => {
      cacheSessionTitle('C Startup Title')
      switchSession(SESSION_B as never, null)
      expect(getCurrentSessionTitle(SESSION_B as never)).toBe('C Startup Title')
      await recordTranscript([message(randomUUID(), 'B in workspace C')])
      await flushSessionStorage()
    },
  )

  const bText = await readFile(
    join(getProjectDir(workspaceC), `${SESSION_B}.jsonl`),
    'utf8',
  )
  expect(bText).toContain('C Startup Title')
  expect(bText).toContain('B in workspace C')
  expect(bText).not.toContain('B in workspace A')
})

test('a new turn reusing a deleted id waits for the deletion instead of dropping its writes', async () => {
  // jatmn on #2489 (P3): a host may start a turn with a deleted id while
  // deleteSession is between forgetDeletedSession and unlink. The path
  // stays marked and the file still exists, so materializeSessionFile
  // skips the restore and the new turn's writes are dropped. The turn
  // must wait for the removal to settle, then start clean at the
  // recycled path. Driven step-by-step (forget → unlink → finish) to
  // hold deleteSession's window open deterministically.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await forgetDeletedSession(SESSION_A as never, transcriptPath)

  // The replacement turn starts while the deletion is still in flight.
  const turnPromise = turnContinuation(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A returns after delete')])
    await flushSessionStorage()
  })
  // Let the turn reach materialize and park on the in-flight deletion.
  await new Promise(resolve => setTimeout(resolve, 20))
  // deleteSession's remaining steps: remove the file, then settle.
  await unlink(transcriptPath)
  finishDeletedSession(transcriptPath)
  await turnPromise

  expect(existsSync(transcriptPath)).toBe(true)
  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).toContain('A returns after delete')
  // The new turn starts clean: the deleted title is not resurrected.
  expect(aText).not.toContain('A Title')
})

test('a turn parked on an in-flight deletion does not deadlock it, and its first message survives', async () => {
  // CodeRabbit on #2489 (two findings, one interleaving):
  // insertMessageChain calls materializeSessionFile inside trackWrite, so
  // the turn holds its pending-write count while it waits for the deletion
  // to settle — and forgetDeletedSession awaited flush() for that same
  // count, so neither side could proceed. And the pointer materialize
  // published before the wait was dropped by the deletion's cache cleanup
  // while the turn was parked, so the resumed turn had no file to write
  // to. Drive it step-by-step: a queued write makes forget's drain yield,
  // opening the window for the replacement turn to park while forget is
  // still settling; forget must return on its own (it only drains, it
  // does not wait for the parked turn), and the turn's message must land
  // in the fresh file.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  // A queued (undrained) write: forget's drain has work to do before its
  // pending-write check, so the replacement turn below can park while
  // forget is still settling instead of racing a synchronous return.
  // Queued while the pointer is still set — a write after the reset below
  // would restore it (the file exists) instead of queueing.
  await turnContinuation(SESSION_A, async () => {
    void recordAttributionSnapshot({
      type: 'attribution-snapshot',
      messageId: randomUUID(),
      surface: 'sdk',
      fileStates: {},
    })
  })
  // Drop the pointer (as LRU eviction or a switch would): the replacement
  // turn must enter materializeSessionFile and park on the deletion. With
  // the pointer still set it would skip materialize, queue its message,
  // and have it dropped by the drain's deleted-path check instead.
  await turnContinuation(SESSION_A, async () => {
    await resetSessionFilePointer()
  })

  const forgetPromise = forgetDeletedSession(SESSION_A as never, transcriptPath)
  // The replacement turn starts while the deletion is still in flight.
  const turnPromise = turnContinuation(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A returns after delete')])
    await flushSessionStorage()
  })
  // Let the turn reach materialize and park on the in-flight deletion.
  await new Promise(resolve => setTimeout(resolve, 50))
  // forgetDeletedSession must return on its own: on the old code it waits
  // behind the parked turn's held write count and never returns. Record
  // the outcome instead of throwing here, so the deletion below still
  // settles and the parked turn is not left behind to hang the suite.
  const forgetSettledInTime = await Promise.race([
    forgetPromise.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 2000)),
  ])
  // deleteSession's remaining steps: remove the file, then settle.
  await unlink(transcriptPath)
  finishDeletedSession(transcriptPath)
  await turnPromise
  expect(forgetSettledInTime).toBe(true)

  expect(existsSync(transcriptPath)).toBe(true)
  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).toContain('A returns after delete')
  // The new turn starts clean: the deleted title is not resurrected.
  expect(aText).not.toContain('A Title')
})

test('a late write from a deleted session does not enter a fresh transcript reusing its id', async () => {
  // CodeRabbit on #2489: after deletion, a late recordAttributionSnapshot
  // from the old context still entered pendingEntries — appendEntry
  // buffered entries for marked paths — and materialization flushed that
  // buffer into the replacement transcript when the id was reused.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  await forgetDeletedSession(SESSION_A as never, transcriptPath)

  // A late write from the deleted session's context, after the delete.
  const staleSnapshotId = randomUUID()
  await turnContinuation(SESSION_A, async () => {
    await recordAttributionSnapshot({
      type: 'attribution-snapshot',
      messageId: staleSnapshotId,
      surface: 'sdk',
      fileStates: {},
    })
  })

  // The deletion settles and the id is reused by a fresh session.
  await unlink(transcriptPath)
  finishDeletedSession(transcriptPath)
  await turnStart(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A fresh')])
    await flushSessionStorage()
  })

  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).toContain('A fresh')
  expect(aText).not.toContain(staleSnapshotId)
})

test('a new turn with a cached pointer waits for an in-flight deletion, and its message survives a failed unlink', async () => {
  // jatmn on #2489 (P2): the deletion wait lives in materializeSessionFile,
  // which a turn with an already-cached pointer skips — so its message is
  // drained into the marked path and discarded. If the removal then fails
  // with EBUSY the transcript survives but the new turn's message is absent.
  // Unlike the parked-turn test above, the pointer is deliberately RETAINED
  // here: that is the gap. Drive it step-by-step (forget → failed unlink →
  // finish) to hold deleteSession's window open deterministically.
  await turnStart(SESSION_A, async () => {
    await mkdir(dirname(getTranscriptPathForSession(SESSION_A)), { recursive: true, mode: 0o700 })
    await recordTranscript([message(randomUUID(), 'A first')])
    await flushSessionStorage()
    cacheSessionTitle('A Title')
  })

  const transcriptPath = getTranscriptPathForSession(SESSION_A)
  // A queued (undrained) write: forget's drain has work to do before its
  // pending-write check, so the replacement turn below can park while forget
  // is still settling instead of racing a synchronous return.
  await turnContinuation(SESSION_A, async () => {
    void recordAttributionSnapshot({
      type: 'attribution-snapshot',
      messageId: randomUUID(),
      surface: 'sdk',
      fileStates: {},
    })
  })

  const forgetPromise = forgetDeletedSession(SESSION_A as never, transcriptPath)
  // The replacement turn starts while the deletion is still in flight, with
  // its transcript pointer still cached — no reset, no eviction.
  const turnPromise = turnContinuation(SESSION_A, async () => {
    await recordTranscript([message(randomUUID(), 'A returns after failed delete')])
    await flushSessionStorage()
  })
  // Let the turn reach the deletion barrier and park on it.
  await new Promise(resolve => setTimeout(resolve, 50))
  // deleteSession's EBUSY failure path: the removal failed, so writes are
  // restored and the deletion settles. The transcript survives.
  restoreSessionWrites(transcriptPath)
  finishDeletedSession(transcriptPath)
  await turnPromise
  await forgetPromise

  expect(existsSync(transcriptPath)).toBe(true)
  const aText = await readFile(transcriptPath, 'utf8')
  expect(aText).toContain('A first')
  expect(aText).toContain('A returns after failed delete')
})

