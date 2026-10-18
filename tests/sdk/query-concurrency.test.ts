import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { query, queryAsync } from '../../src/entrypoints/sdk/index.js'
import { getSessionId, getSessionProjectDir, runWithSdkContext } from '../../src/bootstrap/state.js'
import { init } from '../../src/entrypoints/init.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'
import { randomUUID } from 'crypto'
import type { SessionId } from '../../src/types/ids.js'
import { drainQuery, UUID_REGEX } from './helpers/query-test-doubles.js'
import { MockQueryEngine } from './helpers/mock-engine.js'

// Drain tests trigger init(), which checks auth. Stub it for CI.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

async function drainInterruptedQuery(q: ReturnType<typeof query>): Promise<void> {
  await drainQuery(q)
}

beforeEach(async () => {
  await acquireSharedMutationLock('sdk-query-concurrency')
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-concurrency-stub'
})

afterEach(() => {
  try {
    if (savedApiKey === undefined) delete process.env[AUTH_KEY]
    else process.env[AUTH_KEY] = savedApiKey
  } finally {
    releaseSharedMutationLock()
  }
})

describe('SEC-1: env override isolation', () => {
  test('env overrides are restored after query completes', async () => {
    const key = 'SDK_TEST_SEC1_RESTORE'
    const originalVal = process.env[key]
    process.env[key] = 'original'

    try {
      const q = query({
        prompt: 'env restore test',
        options: {
          cwd: process.cwd(),
          env: { [key]: 'overridden' },
        },
      })
      q.interrupt()
      await drainInterruptedQuery(q)

      expect(process.env[key]).toBe('original')
    } finally {
      if (originalVal === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalVal
      }
    }
  })

  test('concurrent queries with different env overrides do not interfere', async () => {
    const key = 'SDK_TEST_SEC1_CONCURRENT'
    const originalVal = process.env[key]

    try {
      const q1 = query({
        prompt: 'env test 1',
        options: { cwd: process.cwd(), env: { [key]: 'query-1' } },
      })
      const q2 = query({
        prompt: 'env test 2',
        options: { cwd: process.cwd(), env: { [key]: 'query-2' } },
      })

      q1.interrupt()
      q2.interrupt()

      await drainInterruptedQuery(q1)
      await drainInterruptedQuery(q2)

      expect(process.env[key]).toBe(originalVal)
    } finally {
      if (originalVal === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalVal
      }
    }
  })

  test('queries without env overrides are not serialized', async () => {
    const q1 = query({
      prompt: 'no env 1',
      options: { cwd: process.cwd() },
    })
    const q2 = query({
      prompt: 'no env 2',
      options: { cwd: process.cwd() },
    })

    expect(q1.sessionId).toBeDefined()
    expect(q2.sessionId).toBeDefined()

    q1.interrupt()
    q2.interrupt()

    await drainInterruptedQuery(q1)
    await drainInterruptedQuery(q2)
  })
})

describe('CON-1: CWD and session isolation between concurrent queries', () => {
  test('queryAsync keeps eager process-global initialization detached', async () => {
    const globalId = getSessionId()
    const sdkSession = '00000000-0000-4000-8000-0000000000aa' as SessionId
    const memoizedInit = init as typeof init & {
      cache: { has(key: unknown): boolean; get(key: unknown): Promise<void> }
    }
    const originalCache = memoizedInit.cache
    let observedDuringInit: SessionId | undefined
    const probeCache = {
      has: () => true,
      get: () => {
        observedDuringInit = getSessionId()
        return Promise.resolve()
      },
      set() {
        return this
      },
      delete() {
        return true
      },
      clear() {},
    }
    memoizedInit.cache = probeCache as typeof originalCache

    let created: ReturnType<typeof query> | undefined
    try {
      await runWithSdkContext(
        {
          sessionId: sdkSession,
          sessionProjectDir: null,
          cwd: process.cwd(),
          originalCwd: process.cwd(),
        },
        async () => {
          created = await queryAsync({
            prompt: 'init-scope',
            options: { cwd: process.cwd() },
          })
        },
      )

      expect(observedDuringInit).toBe(globalId)
      expect(observedDuringInit).not.toBe(sdkSession)
      expect(getSessionId()).toBe(globalId)
    } finally {
      created?.close()
      memoizedInit.cache = originalCache
    }
  })

  test('lazy query iteration keeps each query session scoped to its engine work', async () => {
    const globalId = getSessionId()
    let arrivals = 0
    let release!: () => void
    const bothStarted = new Promise<void>(resolve => { release = resolve })

    class ContextCapturingEngine extends MockQueryEngine {
      observedSessionId: SessionId | undefined

      override async *submitMessage(): AsyncGenerator<never, void, unknown> {
        arrivals += 1
        if (arrivals === 2) release()
        await bothStarted
        this.observedSessionId = getSessionId()
      }
    }

    const q1 = query({ prompt: 'context-a', options: { cwd: process.cwd() } })
    const q2 = query({ prompt: 'context-b', options: { cwd: process.cwd() } })
    const engine1 = new ContextCapturingEngine()
    const engine2 = new ContextCapturingEngine()
    ;(q1 as unknown as { setEngine(engine: MockQueryEngine): void }).setEngine(engine1)
    ;(q2 as unknown as { setEngine(engine: MockQueryEngine): void }).setEngine(engine2)

    await Promise.all([drainQuery(q1), drainQuery(q2)])

    expect(engine1.observedSessionId).toBe(q1.sessionId)
    expect(engine2.observedSessionId).toBe(q2.sessionId)
    expect(engine1.observedSessionId).not.toBe(engine2.observedSessionId)
    expect(getSessionId()).toBe(globalId)
  })

  test('AsyncLocalStorage context returns query-specific sessionId, not global', () => {
    // Simulate what the SDK query does: set up a context and verify reads
    const globalId = getSessionId()
    const contextId = randomUUID() as SessionId

    const result = runWithSdkContext(
      { sessionId: contextId, sessionProjectDir: '/test/dir', cwd: '/test/dir', originalCwd: '/test/dir' },
      () => getSessionId(),
    )

    expect(result).toBe(contextId)
    expect(result).not.toBe(globalId)
    // Global should be unchanged
    expect(getSessionId()).toBe(globalId)
  })

  test('AsyncLocalStorage context returns query-specific sessionProjectDir', () => {
    const contextDir = '/my/project/specific/dir'
    const result = runWithSdkContext(
      { sessionId: randomUUID() as SessionId, sessionProjectDir: contextDir, cwd: contextDir, originalCwd: contextDir },
      () => getSessionProjectDir(),
    )
    expect(result).toBe(contextDir)
  })

  test('nested contexts maintain correct isolation', () => {
    const id1 = randomUUID() as SessionId
    const id2 = randomUUID() as SessionId

    const result = runWithSdkContext(
      { sessionId: id1, sessionProjectDir: '/dir1', cwd: '/dir1', originalCwd: '/dir1' },
      () => {
        expect(getSessionId()).toBe(id1)
        // Inner context overrides
        const innerResult = runWithSdkContext(
          { sessionId: id2, sessionProjectDir: '/dir2', cwd: '/dir2', originalCwd: '/dir2' },
          () => getSessionId(),
        )
        expect(innerResult).toBe(id2)
        // Outer context should still be id1 after inner returns
        expect(getSessionId()).toBe(id1)
        return true
      },
    )
    expect(result).toBe(true)
  })

  test('two concurrent queries with different CWDs get different session project dirs', () => {
    const cwd1 = '/project-a'
    const cwd2 = '/project-b'

    // Simulate the AsyncLocalStorage context setup that query() does
    const ctx1 = { sessionId: randomUUID() as SessionId, sessionProjectDir: cwd1, cwd: cwd1, originalCwd: cwd1 }
    const ctx2 = { sessionId: randomUUID() as SessionId, sessionProjectDir: cwd2, cwd: cwd2, originalCwd: cwd2 }

    // Verify each context sees its own project dir
    const dir1 = runWithSdkContext(ctx1, () => getSessionProjectDir())
    const dir2 = runWithSdkContext(ctx2, () => getSessionProjectDir())

    expect(dir1).toBe(cwd1)
    expect(dir2).toBe(cwd2)
    expect(dir1).not.toBe(dir2)
  })
})

describe('CON-2: lifecycle-aware concurrency', () => {
  test('concurrent queries produce unique session IDs', () => {
    const queries = Array.from({ length: 5 }, (_, i) =>
      query({ prompt: `concurrent-${i}`, options: { cwd: process.cwd() } })
    )

    const sessionIds = queries.map(q => q.sessionId)
    const uniqueIds = new Set(sessionIds)

    expect(uniqueIds.size).toBe(5)

    for (const id of sessionIds) {
      expect(UUID_REGEX.test(id)).toBe(true)
    }

    for (const q of queries) {
      q.interrupt()
    }
  })

  test('concurrent query drain completes without deadlock', async () => {
    const q1 = query({
      prompt: 'concurrent drain 1',
      options: { cwd: process.cwd() },
    })
    const q2 = query({
      prompt: 'concurrent drain 2',
      options: { cwd: process.cwd() },
    })

    q1.interrupt()
    q2.interrupt()

    const [msgs1, msgs2] = await Promise.all([
      drainQuery(q1),
      drainQuery(q2),
    ])

    expect(Array.isArray(msgs1)).toBe(true)
    expect(Array.isArray(msgs2)).toBe(true)
  }, 15_000)

  test('concurrent queries with different env overrides maintain isolation', async () => {
    const key = 'SDK_TEST_CON2_ISOLATION'
    const originalVal = process.env[key]

    try {
      const q1 = query({
        prompt: 'env-a',
        options: { cwd: process.cwd(), env: { [key]: 'value-a' } },
      })
      const q2 = query({
        prompt: 'env-b',
        options: { cwd: process.cwd(), env: { [key]: 'value-b' } },
      })

      q1.interrupt()
      q2.interrupt()

      await Promise.all([drainQuery(q1), drainQuery(q2)])

      expect(process.env[key]).toBe(originalVal)
    } finally {
      if (originalVal === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalVal
      }
    }
  })
})
