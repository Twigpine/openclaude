import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getOriginalCwd,
  getSessionId,
  isSessionPersistenceDisabled,
  setOriginalCwd,
  setSessionPersistenceDisabled,
  switchSession,
} from '../bootstrap/state.js'
import { renameSession } from '../entrypoints/sdk/sessions.js'
import * as sessionIngress from '../services/api/sessionIngress.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { Message } from '../types/message.js'
import {
  resetAtomicReplaceFaultInjectorForTesting,
  setAtomicReplaceFaultInjectorForTesting,
} from './atomicReplace.js'
import {
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from './envUtils.js'
import { isTranscriptFileLockHeldForTesting } from './transcriptFileLock.js'
import {
  buildConversationChain,
  flushSessionStorage,
  getAgentTranscriptPath,
  getProjectDir,
  getTranscriptPathForSession,
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  loadTranscriptFile,
  recordGoalState,
  recordSpeculationAccept,
  recordTranscript,
  removeTranscriptMessage,
  resetTranscriptRewriteHooksForTesting,
  resetProjectForTesting,
  saveCustomTitle,
  setInternalEventReader,
  setSessionFileForTesting,
  setTranscriptRewriteHooksForTesting,
} from './sessionStorage.js'

const SESSION_ID = '10000000-0000-4000-8000-000000000001'
const OTHER_SESSION_ID = '10000000-0000-4000-8000-000000000002'
const TARGET = '20000000-0000-4000-8000-000000000001' as UUID
const KEEP_1 = '20000000-0000-4000-8000-000000000002' as UUID
const KEEP_2 = '20000000-0000-4000-8000-000000000003' as UUID
const TIMESTAMP = '2026-08-05T00:00:00.000Z'

let testRoot = ''
let originalCwd = ''
let originalSessionId = ''
let originalConfigOverride: string | undefined
let originalPersistenceDisabled = false
let originalNodeEnv: string | undefined
let originalTestPersistence: string | undefined
let originalPersistence: string | undefined
let originalDiagnosticsFile: string | undefined

function line(uuid: UUID, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'test', uuid, ...extra })
}

function message(uuid: UUID, content: string): Message {
  return {
    type: 'user',
    uuid,
    timestamp: TIMESTAMP,
    message: { role: 'user', content },
    isMeta: false,
  }
}

async function useTranscript(
  content: string | Uint8Array,
  name = 'session.jsonl',
): Promise<string> {
  const filePath = join(testRoot, name)
  await writeFile(filePath, content)
  switchSession(SESSION_ID as never, testRoot)
  resetProjectForTesting()
  setSessionFileForTesting(filePath)
  return filePath
}

async function prepareHydration(): Promise<string> {
  const configDir = join(testRoot, 'config')
  const workspaceDir = join(testRoot, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  setClaudeConfigHomeDirForTesting(configDir)
  setOriginalCwd(workspaceDir)
  switchSession(SESSION_ID as never)
  resetProjectForTesting()
  const transcriptPath = getTranscriptPathForSession(SESSION_ID)
  await mkdir(dirname(transcriptPath), { recursive: true, mode: 0o700 })
  return transcriptPath
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/sessionStorage.atomicReplace.test.ts')
  testRoot = await mkdtemp(join(tmpdir(), 'openclaude-atomic-session-'))
  originalCwd = getOriginalCwd()
  originalSessionId = getSessionId()
  originalConfigOverride = getClaudeConfigHomeDirOverrideForTesting()
  originalPersistenceDisabled = isSessionPersistenceDisabled()
  originalNodeEnv = process.env.NODE_ENV
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  originalPersistence = process.env.ENABLE_SESSION_PERSISTENCE
  originalDiagnosticsFile = process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
  process.env.NODE_ENV = 'development'
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = 'true'
  process.env.ENABLE_SESSION_PERSISTENCE = 'true'
  setSessionPersistenceDisabled(false)
})

afterEach(async () => {
  try {
    resetAtomicReplaceFaultInjectorForTesting()
    resetTranscriptRewriteHooksForTesting()
    mock.restore()
    resetProjectForTesting()
    switchSession(originalSessionId as never)
    setOriginalCwd(originalCwd)
    setClaudeConfigHomeDirForTesting(originalConfigOverride)
    setSessionPersistenceDisabled(originalPersistenceDisabled)
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
    if (originalDiagnosticsFile === undefined) {
      delete process.env.CLAUDE_CODE_DIAGNOSTICS_FILE
    } else {
      process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = originalDiagnosticsFile
    }
    await rm(testRoot, { recursive: true, force: true })
  } finally {
    releaseSharedMutationLock()
  }
})

test('final-line tombstones preserve LF, CRLF, and no-final-newline conventions', async () => {
  for (const [separator, finalNewline] of [
    ['\n', true],
    ['\n', false],
    ['\r\n', true],
    ['\r\n', false],
  ] as const) {
    const prefix = line(KEEP_1)
    const original = `${prefix}${separator}${line(TARGET)}${finalNewline ? separator : ''}`
    const filePath = await useTranscript(original, `final-${separator.length}-${finalNewline}.jsonl`)

    await removeTranscriptMessage(TARGET)
    await flushSessionStorage()

    expect(await readFile(filePath, 'utf8')).toBe(
      finalNewline ? `${prefix}${separator}` : prefix,
    )
  }
})

test('middle-line tombstone preserves surrounding bytes and malformed lines', async () => {
  const malformed = '{not valid json but must survive}\r\n'
  const prefix = `${line(KEEP_1, { spacing: 'kept' })}\r\n${malformed}`
  const suffix = `${line(KEEP_2, { nested: { uuid: TARGET } })}\r\n`
  const filePath = await useTranscript(`${prefix}${line(TARGET)}\r\n${suffix}`)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(prefix + suffix)
})

test('tail search ignores a nested uuid in a later entry', async () => {
  const original = `${line(TARGET)}\n${line(KEEP_1, { nested: { uuid: TARGET } })}\n`
  const filePath = await useTranscript(original)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(
    `${line(KEEP_1, { nested: { uuid: TARGET } })}\n`,
  )
})

test('slow tombstone removes a target outside the tail window', async () => {
  const suffix = `${line(KEEP_1, { payload: 'x'.repeat(70 * 1024) })}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(`${line(TARGET)}\n${suffix}`)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(suffix)
})

test('slow tombstone handles a target line longer than the tail window', async () => {
  const targetLine = line(TARGET, { payload: 'x'.repeat(70 * 1024) })
  const suffix = `${line(KEEP_1)}\n`
  const filePath = await useTranscript(`${targetLine}\n${suffix}`)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(suffix)
})

test('large slow rewrite streams bounded chunks instead of building a second copy', async () => {
  const suffix = `${line(KEEP_1, { payload: 'x'.repeat(8 * 1024 * 1024) })}\n`
  const filePath = await useTranscript(`${line(TARGET)}\n${suffix}`)
  let writeCount = 0
  setAtomicReplaceFaultInjectorForTesting((stage, context) => {
    if (stage === 'stream-write' && context.requestedPath === filePath) {
      writeCount++
    }
  })

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect((await stat(filePath)).size).toBe(Buffer.byteLength(suffix))
  // Prove bounded streaming without coupling the test to the current chunk size.
  expect(writeCount).toBeGreaterThan(10)
  expect(await readFile(filePath, 'utf8')).toBe(suffix)
})

test('empty file and missing target remain byte-for-byte unchanged', async () => {
  const emptyPath = await useTranscript('', 'empty.jsonl')
  await removeTranscriptMessage(TARGET)
  expect(await readFile(emptyPath)).toEqual(Buffer.alloc(0))

  const original = `${line(KEEP_1)}\n${line(KEEP_2)}\n`
  const missingPath = await useTranscript(original, 'missing.jsonl')
  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()
  expect(await readFile(missingPath, 'utf8')).toBe(original)
})

test('maximum rewrite guard leaves an oversized transcript unchanged', async () => {
  const filePath = await useTranscript(`${line(TARGET)}\n`, 'guard.jsonl')
  const handle = await open(filePath, 'r+')
  await handle.truncate(50 * 1024 * 1024 + 1)
  await handle.close()
  const before = await stat(filePath)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect((await stat(filePath)).size).toBe(before.size)
  const head = Buffer.alloc(Buffer.byteLength(line(TARGET)))
  const readHandle = await open(filePath, 'r')
  await readHandle.read(head, 0, head.length, 0)
  await readHandle.close()
  expect(head.toString()).toBe(line(TARGET))
})

test.each(['stream-write', 'data-flush', 'rename'] as const)(
  '%s failure preserves the old transcript and cleans its temp file',
  async stage => {
    const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
    const filePath = await useTranscript(original)
    setAtomicReplaceFaultInjectorForTesting((actualStage, context) => {
      if (actualStage === stage && context.requestedPath === filePath) {
        throw new Error(`injected ${stage}`)
      }
    })

    await removeTranscriptMessage(TARGET)
    await flushSessionStorage()

    expect(await readFile(filePath, 'utf8')).toBe(original)
    expect(
      (await Array.fromAsync(new Bun.Glob('.*.tmp-*').scan(testRoot))).length,
    ).toBe(0)
  },
)

test('an external append after validation waits for the tombstone commit', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  const appended = `${JSON.stringify({
    type: 'custom-title',
    customTitle: 'external SDK append',
    sessionId: SESSION_ID,
  })}\n`
  const filePath = await prepareHydration()
  await writeFile(filePath, original)
  setSessionFileForTesting(filePath)
  let injected = false
  let appendPromise: Promise<void> | undefined
  setAtomicReplaceFaultInjectorForTesting(async (stage, context) => {
    if (!injected && stage === 'rename' && context.requestedPath === filePath) {
      injected = true
      expect(await isTranscriptFileLockHeldForTesting(filePath)).toBe(true)
      appendPromise = renameSession(SESSION_ID, 'external SDK append', {
        dir: getOriginalCwd(),
      })
    }
  })

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()
  expect(appendPromise).toBeDefined()
  await appendPromise

  expect(await readFile(filePath, 'utf8')).toBe(
    `${line(KEEP_1)}\n${line(KEEP_2)}\n${appended}`,
  )
  expect(
    (await Array.fromAsync(new Bun.Glob('.*.tmp-*').scan(testRoot))).length,
  ).toBe(0)
  await expect(lstat(`${filePath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('a synchronous append through a resolved symlink target waits for the rewrite lock', async () => {
  if (process.platform === 'win32') return

  const realPath = join(testRoot, 'sync-real.jsonl')
  const linkPath = join(testRoot, 'sync-linked.jsonl')
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  await writeFile(realPath, original)
  await symlink('sync-real.jsonl', linkPath)
  switchSession(SESSION_ID as never, testRoot)
  resetProjectForTesting()
  setSessionFileForTesting(linkPath)
  let injected = false
  setAtomicReplaceFaultInjectorForTesting(async (stage, context) => {
    if (!injected && stage === 'rename' && context.requestedPath === linkPath) {
      injected = true
      expect(await isTranscriptFileLockHeldForTesting(linkPath)).toBe(true)
      await saveCustomTitle(
        SESSION_ID as UUID,
        'synchronous symlink append',
        realPath,
      )
    }
  })

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  const result = await readFile(realPath, 'utf8')
  expect(result).toBe(
    `${line(KEEP_1)}\n${line(KEEP_2)}\n${JSON.stringify({
      type: 'custom-title',
      customTitle: 'synchronous symlink append',
      sessionId: SESSION_ID,
    })}\n`,
  )
})

test.each(['stream-write', 'data-flush', 'rename'] as const)(
  'slow-path %s failure preserves the old transcript and cleans its temp file',
  async stage => {
    const suffix = `${line(KEEP_1, { payload: 'x'.repeat(70 * 1024) })}\n`
    const original = `${line(TARGET)}\n${suffix}`
    const filePath = await useTranscript(original)
    setAtomicReplaceFaultInjectorForTesting((actualStage, context) => {
      if (actualStage === stage && context.requestedPath === filePath) {
        throw new Error(`injected slow ${stage}`)
      }
    })

    await removeTranscriptMessage(TARGET)
    await flushSessionStorage()

    expect(await readFile(filePath, 'utf8')).toBe(original)
    expect(
      (await Array.fromAsync(new Bun.Glob('.*.tmp-*').scan(testRoot))).length,
    ).toBe(0)
  },
)

test('middle tombstone preserves restrictive mode and follows the live symlink target', async () => {
  if (process.platform === 'win32') return

  const realPath = join(testRoot, 'real.jsonl')
  const linkPath = join(testRoot, 'linked.jsonl')
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  await writeFile(realPath, original)
  await chmod(realPath, 0o640)
  await symlink('real.jsonl', linkPath)
  switchSession(SESSION_ID as never, testRoot)
  resetProjectForTesting()
  setSessionFileForTesting(linkPath)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
  expect(await readFile(realPath, 'utf8')).toBe(`${line(KEEP_1)}\n${line(KEEP_2)}\n`)
  expect((await stat(realPath)).mode & 0o777).toBe(0o640)
})

test('serialized appends before and during a paused rewrite survive in order', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(original)
  let release!: () => void
  let paused!: () => void
  const pausedPromise = new Promise<void>(resolve => {
    paused = resolve
  })
  const releasePromise = new Promise<void>(resolve => {
    release = resolve
  })
  let blocked = false
  setAtomicReplaceFaultInjectorForTesting(async (stage, context) => {
    if (!blocked && stage === 'stream-write' && context.requestedPath === filePath) {
      blocked = true
      paused()
      await releasePromise
    }
  })

  await recordTranscript([
    message('20000000-0000-4000-8000-000000000004' as UUID, 'before rewrite'),
  ])
  const priorGoalWrite = recordGoalState(
    {
      id: 'goal-before-rewrite',
      condition: 'serialize before replacement',
      status: 'active',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      turnCount: 0,
      maxTurns: 10,
      evaluatorFailures: 0,
    },
    SESSION_ID as UUID,
  )
  const removal = removeTranscriptMessage(TARGET)
  await pausedPromise
  await saveCustomTitle(SESSION_ID as UUID, 'during rewrite', filePath)
  const goalWrite = recordGoalState(
    {
      id: 'goal-during-rewrite',
      condition: 'preserve queued data',
      status: 'active',
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      startedAt: TIMESTAMP,
      turnCount: 0,
      maxTurns: 10,
      evaluatorFailures: 0,
    },
    SESSION_ID as UUID,
  )
  release()
  await Promise.all([priorGoalWrite, removal, goalWrite])
  await flushSessionStorage()

  const result = await readFile(filePath, 'utf8')
  expect(result).not.toContain(TARGET)
  expect(result).toContain('before rewrite')
  expect(result).toContain('goal-before-rewrite')
  expect(result).toContain('during rewrite')
  expect(result).toContain('goal-during-rewrite')
  expect(result.indexOf('during rewrite')).toBeLessThan(
    result.indexOf('goal-during-rewrite'),
  )
  expect(result.indexOf('goal-before-rewrite')).toBeLessThan(
    result.indexOf('during rewrite'),
  )
})

test('a rewrite barrier is active as soon as hydration is enqueued', async () => {
  const transcriptPath = await prepareHydration()
  const remote = [message(KEEP_1, 'remote foreground')]
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue(remote as never)
  setTranscriptRewriteHooksForTesting({
    enqueued(filePath) {
      if (filePath === transcriptPath) {
        void saveCustomTitle(
          SESSION_ID as UUID,
          'queued after hydration barrier',
          transcriptPath,
        )
      }
    },
  })

  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(
    true,
  )
  await flushSessionStorage()

  const result = await readFile(transcriptPath, 'utf8')
  expect(result).toContain('remote foreground')
  expect(result).toContain('queued after hydration barrier')
  expect(result.indexOf('remote foreground')).toBeLessThan(
    result.indexOf('queued after hydration barrier'),
  )
})

test('speculation acceptance is queued behind an active transcript rewrite', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(original)
  let release!: () => void
  let paused!: () => void
  const pausedPromise = new Promise<void>(resolve => {
    paused = resolve
  })
  const releasePromise = new Promise<void>(resolve => {
    release = resolve
  })
  let blocked = false
  setAtomicReplaceFaultInjectorForTesting(async (stage, context) => {
    if (!blocked && stage === 'stream-write' && context.requestedPath === filePath) {
      blocked = true
      paused()
      await releasePromise
    }
  })

  const removal = removeTranscriptMessage(TARGET)
  await pausedPromise
  await recordSpeculationAccept({
    type: 'speculation-accept',
    timestamp: TIMESTAMP,
    timeSavedMs: 123,
  })
  release()
  await removal
  await flushSessionStorage()

  const result = await readFile(filePath, 'utf8')
  expect(result).not.toContain(TARGET)
  expect(result).toContain('"type":"speculation-accept"')
  expect(result).toContain('"timeSavedMs":123')
})

test('a failed queued append settles a following tombstone and releases its barrier', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(original)
  setTranscriptRewriteHooksForTesting({
    beforeFileAppend(appendPath) {
      if (appendPath === filePath) throw new Error('injected append failure')
    },
  })

  await recordTranscript([
    message('20000000-0000-4000-8000-000000000006' as UUID, 'queued first'),
  ])
  const removal = removeTranscriptMessage(TARGET)
  await expect(flushSessionStorage()).rejects.toThrow('injected append failure')

  await removal

  resetTranscriptRewriteHooksForTesting()
  await saveCustomTitle(SESSION_ID as UUID, 'barrier released', filePath)
  expect(await readFile(filePath, 'utf8')).toContain('barrier released')
})

test('a long rewrite keeps drains single-flight across late appends, tombstones, and flush', async () => {
  const secondTarget = OTHER_SESSION_ID as UUID
  const lateUuid = '20000000-0000-4000-8000-000000000005' as UUID
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(secondTarget)}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(original)
  let release!: () => void
  let paused!: () => void
  const pausedPromise = new Promise<void>(resolve => {
    paused = resolve
  })
  const releasePromise = new Promise<void>(resolve => {
    release = resolve
  })
  let blocked = false
  setAtomicReplaceFaultInjectorForTesting(async (stage, context) => {
    if (!blocked && stage === 'stream-write' && context.requestedPath === filePath) {
      blocked = true
      paused()
      await releasePromise
    }
  })

  const firstRemoval = removeTranscriptMessage(TARGET)
  await pausedPromise
  await recordTranscript([message(lateUuid, 'late queued append')])
  const secondRemoval = removeTranscriptMessage(secondTarget)
  release()
  await Promise.all([firstRemoval, secondRemoval])
  await flushSessionStorage()

  const result = await readFile(filePath, 'utf8')
  expect(result).not.toContain(TARGET)
  expect(result).not.toContain(secondTarget)
  expect(result).toContain(lateUuid)
  expect(result).toContain('late queued append')
})

test('a microtask append at rewrite completion is not stranded behind the barrier', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n`
  const filePath = await useTranscript(original)
  let queuedLateAppend!: () => void
  const lateAppendQueued = new Promise<void>(resolve => {
    queuedLateAppend = resolve
  })
  setTranscriptRewriteHooksForTesting({
    beforeBarrierRelease(rewritePath) {
      if (rewritePath !== filePath) return
      queueMicrotask(() => {
        void saveCustomTitle(
          SESSION_ID as UUID,
          'microtask at barrier release',
          filePath,
        )
        queuedLateAppend()
      })
    },
  })

  await removeTranscriptMessage(TARGET)
  await lateAppendQueued
  await flushSessionStorage()

  const result = await readFile(filePath, 'utf8')
  expect(result).not.toContain(TARGET)
  expect(result).toContain('microtask at barrier release')
})

test('two concurrent tombstones serialize without resurrecting either entry', async () => {
  const original = `${line(KEEP_1)}\n${line(TARGET)}\n${line(KEEP_2)}\n${line(OTHER_SESSION_ID as UUID)}\n`
  const filePath = await useTranscript(original)

  await Promise.all([
    removeTranscriptMessage(TARGET),
    removeTranscriptMessage(OTHER_SESSION_ID as UUID),
  ])
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(`${line(KEEP_1)}\n${line(KEEP_2)}\n`)
})

test('slow duplicate removal preserves a missing final newline', async () => {
  const longFinalTarget = line(TARGET, { payload: 'x'.repeat(70 * 1024) })
  const original = `${line(TARGET)}\n${line(KEEP_1)}\n${longFinalTarget}`
  const filePath = await useTranscript(original)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()

  expect(await readFile(filePath, 'utf8')).toBe(line(KEEP_1))
})

test('resume loader reads the byte-preserved tombstone result', async () => {
  const first = { ...message(KEEP_1, 'keep one'), parentUuid: null }
  const removed = { ...message(TARGET, 'remove me'), parentUuid: KEEP_1 }
  const last = { ...message(KEEP_2, 'keep two'), parentUuid: KEEP_1 }
  const original = `${JSON.stringify(first)}\n{malformed but preserved}\n${JSON.stringify(removed)}\n${JSON.stringify(last)}\n`
  const filePath = await useTranscript(original)

  await removeTranscriptMessage(TARGET)
  await flushSessionStorage()
  const loaded = await loadTranscriptFile(filePath, { keepAllLeaves: true })

  expect(loaded.messages.has(KEEP_1)).toBe(true)
  expect(loaded.messages.has(TARGET)).toBe(false)
  expect(loaded.messages.has(KEEP_2)).toBe(true)
  expect(loaded.messages.get(KEEP_2)?.parentUuid).toBe(KEEP_1)
  expect(
    buildConversationChain(loaded.messages, loaded.messages.get(KEEP_2)!).map(
      entry => entry.uuid,
    ),
  ).toEqual([KEEP_1, KEEP_2])
  expect(await readFile(filePath, 'utf8')).toContain('{malformed but preserved}\n')
})

test('v1 foreground hydration commits complete content and mode atomically', async () => {
  const transcriptPath = await prepareHydration()
  const remote = [message(KEEP_1, 'remote one'), message(KEEP_2, 'remote two')]
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue(remote as never)

  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(true)

  expect(await readFile(transcriptPath, 'utf8')).toBe(
    `${remote.map(entry => JSON.stringify(entry)).join('\n')}\n`,
  )
  expect((await stat(transcriptPath)).mode & 0o777).toBe(0o600)
})

test('v1 null fetch, serialization failure, and rename failure preserve old content', async () => {
  const transcriptPath = await prepareHydration()
  const original = `${line(KEEP_1)}\n`
  await writeFile(transcriptPath, original)
  const getLogs = spyOn(sessionIngress, 'getSessionLogs')

  getLogs.mockResolvedValueOnce(null)
  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)

  const circular: Record<string, unknown> = { uuid: TARGET }
  circular.self = circular
  getLogs.mockResolvedValueOnce([circular] as never)
  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)

  getLogs.mockResolvedValueOnce([message(KEEP_2, 'replacement')] as never)
  setAtomicReplaceFaultInjectorForTesting((stage, context) => {
    if (stage === 'rename' && context.requestedPath === transcriptPath) {
      throw new Error('injected rename')
    }
  })
  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)
})

test('empty foreground hydration preserves an existing transcript', async () => {
  const transcriptPath = await prepareHydration()
  const original = `${line(KEEP_1)}\n`
  await writeFile(transcriptPath, original)
  spyOn(sessionIngress, 'getSessionLogs').mockResolvedValue([] as never)

  expect(await hydrateRemoteSession(SESSION_ID, 'https://ingress.test')).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)

  resetProjectForTesting()
  setInternalEventReader(async () => [], async () => [])

  expect(await hydrateFromCCRv2InternalEvents(SESSION_ID)).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toBe(original)
})

test('CCR subagent transcripts commit independently and suppress full-success diagnostics', async () => {
  const transcriptPath = await prepareHydration()
  const diagnosticsPath = join(testRoot, 'diagnostics.jsonl')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagnosticsPath
  const agentA = 'agent-a'
  const agentB = 'agent-b'
  setInternalEventReader(
    async () => [{ payload: message(KEEP_1, 'foreground') as never }],
    async () => [
      { agent_id: agentA, payload: { type: 'test', uuid: KEEP_1 } },
      { agent_id: agentB, payload: { type: 'test', uuid: KEEP_2 } },
    ],
  )
  const agentAPath = getAgentTranscriptPath(agentA as never)
  const agentBPath = getAgentTranscriptPath(agentB as never)
  await mkdir(dirname(agentAPath), { recursive: true, mode: 0o700 })
  await writeFile(agentAPath, 'old-a\n')
  await writeFile(agentBPath, 'old-b\n')
  setAtomicReplaceFaultInjectorForTesting((stage, context) => {
    if (stage === 'rename' && context.requestedPath === agentBPath) {
      throw new Error('agent-b rename failed')
    }
  })

  expect(await hydrateFromCCRv2InternalEvents(SESSION_ID)).toBe(false)

  expect(await readFile(transcriptPath, 'utf8')).toContain('foreground')
  expect(await readFile(agentAPath, 'utf8')).toContain(KEEP_1)
  expect(await readFile(agentBPath, 'utf8')).toBe('old-b\n')
  const diagnostics = await readFile(diagnosticsPath, 'utf8')
  expect(diagnostics).not.toContain('hydrate_ccr_v2_completed')
  expect(diagnostics).toContain('hydrate_ccr_v2_subagent_write_fail')
})

test('CCR distinguishes failed subagent fetch from a successful empty fetch', async () => {
  const transcriptPath = await prepareHydration()
  const diagnosticsPath = join(testRoot, 'subagent-read-diagnostics.jsonl')
  process.env.CLAUDE_CODE_DIAGNOSTICS_FILE = diagnosticsPath
  setInternalEventReader(
    async () => [{ payload: message(KEEP_1, 'foreground') as never }],
    async () => null,
  )
  expect(await hydrateFromCCRv2InternalEvents(SESSION_ID)).toBe(false)
  expect(await readFile(transcriptPath, 'utf8')).toContain('foreground')
  const failedDiagnostics = await readFile(diagnosticsPath, 'utf8')
  expect(failedDiagnostics).toContain('hydrate_ccr_v2_subagent_read_fail')
  expect(failedDiagnostics).not.toContain('hydrate_ccr_v2_completed')

  resetProjectForTesting()
  await writeFile(diagnosticsPath, '')
  setInternalEventReader(
    async () => [{ payload: message(KEEP_2, 'foreground') as never }],
    async () => [],
  )
  expect(await hydrateFromCCRv2InternalEvents(SESSION_ID)).toBe(true)
  expect(await readFile(diagnosticsPath, 'utf8')).toContain(
    'hydrate_ccr_v2_completed',
  )
})
