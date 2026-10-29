import { createToolFixture } from '../../src/test/toolFixtures.js'
import { z } from 'zod/v4'
import { getDefaultAppState } from '../../src/state/AppStateStore.js'
import { createFileStateCacheWithSizeLimit } from '../../src/utils/fileStateCache.js'
import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test'
import {
  unstable_v2_createSession,
} from '../../src/entrypoints/sdk/index.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'

// sendMessage drains trigger init(), which checks auth. Stub it for CI.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock('tests/sdk/engine-mutators.test.ts')
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-engine-mutators-stub'
})

afterAll(() => {
  try {
    if (savedApiKey === undefined) delete process.env[AUTH_KEY]
    else process.env[AUTH_KEY] = savedApiKey
  } finally {
    releaseSharedMutationLock()
  }
})
import { QueryEngine } from '../../src/QueryEngine.js'
import type { QueryEngineConfig } from '../../src/QueryEngine.js'
import type { Tools } from '../../src/Tool.js'
import { getToolSchemaCache, clearToolSchemaCache } from '../../src/utils/toolSchemaCache.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTool(name: string) {
  return createToolFixture(z.object({}), { name, call: async () => ({ data: '' }), description: async () => `${name} tool` })
}

function makeConfig(overrides: Partial<QueryEngineConfig> = {}): QueryEngineConfig {
  return {
    cwd: process.cwd(),
    tools: [makeTool('toolA'), makeTool('toolB')],
    commands: [],
    mcpClients: [],
    agents: [],
    canUseTool: async () => ({ behavior: 'allow' as const }),
    getAppState: getDefaultAppState,
    setAppState: () => {},
    readFileCache: createFileStateCacheWithSizeLimit(100),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// TEST 1 — COR-1 Regression
// ---------------------------------------------------------------------------

describe('COR-1 regression: typed nullable appStateStore', () => {
  test('SDKSessionImpl late-binds appStateStore — getMessages works', () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    // Session created with null appStateStore, then late-bound internally.
    // getMessages() should work (triggers getter guard).
    expect(Array.isArray(session.getMessages())).toBe(true)
    session.interrupt()
  })

  test('SDKSessionImpl sendMessage returns async iterator after proper init', async () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })
    // sendMessage() must return an async iterable without throwing —
    // this proves the appStateStore getter guard does not fire spuriously
    // after late-binding in createSession.
    const iter = session.sendMessage('test')
    expect(typeof iter[Symbol.asyncIterator]).toBe('function')

    // Drain the iterator. In CI (no API key, MACRO undefined) we expect a
    // ReferenceError or AbortError — but NOT the appStateStore guard error.
    try {
      for await (const _ of iter) {
        break
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      // The appStateStore guard would throw:
      //   "SDKSessionImpl: appStateStore not initialized. Call setAppStateStore() first."
      // That must NEVER happen here — late-binding in createSession wires it.
      expect(msg).not.toContain('appStateStore not initialized')
    }
    session.interrupt()
  }, 10_000)
})

// ---------------------------------------------------------------------------
// TEST 2 — updateTools Transaction Safety
// ---------------------------------------------------------------------------

describe('updateTools transactional safety', () => {
  test('updateTools rolls back on agent validation failure', () => {
    const originalTools: Tools = [makeTool('toolA'), makeTool('toolB')]
    const engine = new QueryEngine(makeConfig({
      tools: [...originalTools],
      agents: [
        { agentType: 'test-agent', tools: ['toolC'] } as QueryEngineConfig['agents'][number],
      ],
    }))

    // updateTools with a set missing toolC → should throw
    expect(() => engine.updateTools([makeTool('toolA')])).toThrow(
      /references tool 'toolC' which is not in the new tool set/,
    )

    // config.tools must remain unchanged — old tool set preserved
    const currentTools = engine['config'].tools as Tools
    expect(currentTools.map(t => t.name)).toEqual(['toolA', 'toolB'])
  })

  test('updateTools commits when all agents are compatible', () => {
    const engine = new QueryEngine(makeConfig({
      tools: [makeTool('toolA'), makeTool('toolB')],
      agents: [
        { agentType: 'test-agent', tools: ['toolA'] } as QueryEngineConfig['agents'][number],
      ],
    }))

    engine.updateTools([makeTool('toolA'), makeTool('toolC')])

    const currentTools = engine['config'].tools as Tools
    expect(currentTools.map(t => t.name)).toEqual(['toolA', 'toolC'])
  })

  test('updateTools accepts wildcard agent without validation', () => {
    const engine = new QueryEngine(makeConfig({
      tools: [makeTool('toolA')],
      agents: [
        { agentType: 'wildcard-agent', tools: ['*'] } as QueryEngineConfig['agents'][number],
      ],
    }))

    // Wildcard '*' means all tools are allowed — should not throw
    expect(() => engine.updateTools([makeTool('toolX')])).not.toThrow()
    expect((engine['config'].tools as Tools).map(t => t.name)).toEqual(['toolX'])
  })

  test('updateTools rejects non-iterable input', () => {
    const engine = new QueryEngine(makeConfig())
    expect(() => engine.updateTools(42 as unknown as Tools)).toThrow(/expected iterable/)
  })

  test('updateTools rejects tool without name', () => {
    const engine = new QueryEngine(makeConfig())
    expect(() => engine.updateTools([{ call: async () => '' }] as unknown as Tools)).toThrow(/name/)
  })

  test('updateTools rejects tool without call', () => {
    const engine = new QueryEngine(makeConfig())
    expect(() => engine.updateTools([{ name: 'bad' }] as unknown as Tools)).toThrow(/call/)
  })
})

// ---------------------------------------------------------------------------
// TEST 3 — Cache Invalidation
// ---------------------------------------------------------------------------

describe('updateTools cache invalidation', () => {
  afterEach(() => {
    clearToolSchemaCache()
  })

  test('toolSchemaCache is cleared after updateTools', () => {
    const cache = getToolSchemaCache()
    cache.set('test_tool', { name: 'test_tool' } as Parameters<typeof cache.set>[1])
    expect(cache.has('test_tool')).toBe(true)

    const engine = new QueryEngine(makeConfig({
      tools: [makeTool('toolA')],
    }))

    engine.updateTools([makeTool('toolB')])

    expect(cache.has('test_tool')).toBe(false)
    expect(cache.size).toBe(0)
  })

  test('toolSchemaCache is NOT cleared when updateTools throws', () => {
    const cache = getToolSchemaCache()
    cache.set('keep_me', { name: 'keep_me' } as Parameters<typeof cache.set>[1])

    const engine = new QueryEngine(makeConfig({
      tools: [makeTool('toolA')],
      agents: [{ agentType: 'a', tools: ['toolA'] } as QueryEngineConfig['agents'][number]],
    }))

    // This should throw — agent references toolA but new set doesn't have it
    expect(() => engine.updateTools([makeTool('toolB')])).toThrow()

    // Cache should NOT have been cleared — rollback scenario
    expect(cache.has('keep_me')).toBe(true)
  })
})
