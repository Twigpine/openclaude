import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { type UUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { createGoalState } from '../services/goal/state.js'
import { setClaudeConfigHomeDirForTesting } from './envUtils.js'
import { deleteSessionFiles } from './sessionDeletion.js'
import * as sessionStorage from './sessionStorage.js'
import {
  flushSessionStorage,
  getTranscriptPathForSession,
  recordGoalState,
  resetProjectForTesting,
  resetSessionFilePointer,
  saveAiGeneratedTitle,
  saveCustomTitle,
  saveTaskSummary,
} from './sessionStorage.js'

const DELETED = '00000000-0000-4000-8000-00000000d001' as UUID
const ACTIVE = '00000000-0000-4000-8000-00000000d002' as UUID
const tempDirs: string[] = []
const savedEnv = {
  NODE_ENV: process.env.NODE_ENV,
  TEST_ENABLE_SESSION_PERSISTENCE: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
  ENABLE_SESSION_PERSISTENCE: process.env.ENABLE_SESSION_PERSISTENCE,
}
let originalSessionId: string
let originalPersistenceDisabled: boolean

beforeEach(async () => {
  await acquireSharedMutationLock('utils/sessionStorage.deletedSession.test.ts')
  originalSessionId = getSessionId()
  originalPersistenceDisabled = isSessionPersistenceDisabled()
  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  setSessionPersistenceDisabled(false)
  const configDir = await mkdtemp(join(tmpdir(), 'openclaude-deleted-session-'))
  tempDirs.push(configDir)
  setClaudeConfigHomeDirForTesting(configDir)
  resetProjectForTesting()
})

afterEach(async () => {
  try {
    mock.restore()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    setSessionPersistenceDisabled(originalPersistenceDisabled)
    switchSession(originalSessionId as never)
    resetProjectForTesting()
    await Promise.all(
      tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
    )
  } finally {
    releaseSharedMutationLock()
  }
})

/** A saved conversation that this process has already written to. */
async function writtenOtherSession(): Promise<string> {
  const transcript = getTranscriptPathForSession(DELETED)
  await mkdir(dirname(transcript), { recursive: true })
  await writeFile(
    transcript,
    `${JSON.stringify({ type: 'user', sessionId: DELETED, message: { role: 'user', content: 'hi' } })}\n`,
  )
  switchSession(ACTIVE as never)
  await resetSessionFilePointer()
  // Warms the "file exists" cache used for queued writes to other sessions.
  await recordGoalState(createGoalState('before delete'), DELETED)
  await flushSessionStorage()
  return transcript
}

test('late metadata writes do not resurrect a deleted session transcript', async () => {
  const transcript = await writtenOtherSession()

  const result = await deleteSessionFiles({
    sessionId: DELETED,
    transcriptPath: transcript,
    currentSessionId: ACTIVE,
  })
  expect(result.ok).toBe(true)

  // Writers that finish after the delete: async AI title, periodic task
  // summary, and a title write through the cached file path.
  saveAiGeneratedTitle(DELETED, 'late ai title')
  saveTaskSummary(DELETED, 'late summary')
  await saveCustomTitle(DELETED, 'late title', transcript)
  await recordGoalState(createGoalState('late goal'), DELETED)
  await flushSessionStorage()

  expect(existsSync(transcript)).toBe(false)
})

test('writes queued before the delete are dropped, not flushed after it', async () => {
  const transcript = await writtenOtherSession()

  // Queued but not yet drained when the user confirms the delete.
  void recordGoalState(createGoalState('queued goal'), DELETED)
  const result = await deleteSessionFiles({
    sessionId: DELETED,
    transcriptPath: transcript,
    currentSessionId: ACTIVE,
  })
  expect(result.ok).toBe(true)
  await flushSessionStorage()

  expect(existsSync(transcript)).toBe(false)
})

test('a transcript that could not be removed keeps receiving writes', async () => {
  const transcript = await writtenOtherSession()
  const realRm = fsPromises.rm
  spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (path === transcript) {
      throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
    }
    return realRm(path, options)
  })

  await expect(
    deleteSessionFiles({
      sessionId: DELETED,
      transcriptPath: transcript,
      currentSessionId: ACTIVE,
    }),
  ).rejects.toThrow('resource busy or locked')
  mock.restore()

  await recordGoalState(createGoalState('after failed delete'), DELETED)
  await flushSessionStorage()

  expect(await readFile(transcript, 'utf8')).toContain('after failed delete')
})

test('a sidecar failing first does not restore writes while the transcript is removed', async () => {
  const transcript = await writtenOtherSession()
  const realRm = fsPromises.rm
  spyOn(fsPromises, 'rm').mockImplementation(async (path, options) => {
    if (path === transcript) {
      // Still removing when the sidecar below has already failed.
      await new Promise(resolve => setTimeout(resolve, 20))
    } else if (String(path).endsWith('.cast')) {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    }
    return realRm(path, options)
  })

  const result = await deleteSessionFiles({
    sessionId: DELETED,
    transcriptPath: transcript,
    currentSessionId: ACTIVE,
  })
  mock.restore()
  expect(result.ok).toBe(true)

  await recordGoalState(createGoalState('late goal'), DELETED)
  await flushSessionStorage()

  expect(existsSync(transcript)).toBe(false)
})

test('a failed deletion barrier keeps the transcript writable', async () => {
  const transcript = await writtenOtherSession()
  const realForget = sessionStorage.forgetDeletedSession
  // Marks the path, then fails like a flush whose pending write errored.
  spyOn(sessionStorage, 'forgetDeletedSession').mockImplementation(
    async (sessionId, path) => {
      await realForget(sessionId, path)
      throw new Error('pending write failed')
    },
  )

  await expect(
    deleteSessionFiles({
      sessionId: DELETED,
      transcriptPath: transcript,
      currentSessionId: ACTIVE,
    }),
  ).rejects.toThrow('pending write failed')
  mock.restore()

  await recordGoalState(createGoalState('after failed barrier'), DELETED)
  await flushSessionStorage()

  expect(await readFile(transcript, 'utf8')).toContain('after failed barrier')
})
