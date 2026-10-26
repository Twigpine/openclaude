import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import * as bootstrapStateNs from '../../bootstrap/state.js'
import * as memoryScanNs from '../../memdir/memoryScan.js'
import * as pathsNs from '../../memdir/paths.js'
import * as governanceNs from '../../utils/governancePolicy.js'
import * as debugNs from '../../utils/debug.js'
import * as forkedAgentNs from '../../utils/forkedAgent.js'
import * as growthbookNs from '../analytics/growthbook.js'
import * as analyticsNs from '../analytics/index.js'

const realBootstrapState = { ...bootstrapStateNs }
const realMemoryScan = { ...memoryScanNs }
const realPaths = { ...pathsNs }
const realGovernance = { ...governanceNs }
const realDebug = { ...debugNs }
const realForkedAgent = { ...forkedAgentNs }
const realGrowthbook = { ...growthbookNs }
const realAnalytics = { ...analyticsNs }

type ForkCall = {
  abortController?: AbortController
}

function createContext(messageUuids: string | string[]) {
  const uuids = Array.isArray(messageUuids) ? messageUuids : [messageUuids]
  return {
    messages: uuids.map(messageUuid => ({
      type: 'user',
      uuid: messageUuid,
      timestamp: '2026-07-05T00:00:00.000Z',
      message: { role: 'user', content: 'remember this' },
    })),
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: {},
  } as unknown as Parameters<typeof realForkedAgent.createCacheSafeParams>[0]
}

function registerExtractMemoriesStubs({
  runForkedAgent,
  debugLog,
  events,
}: {
  runForkedAgent: ReturnType<typeof mock>
  debugLog: ReturnType<typeof mock<(message: string) => void>>
  events: string[]
}) {
  mock.module('../../bootstrap/state.js', () => ({
    ...realBootstrapState,
    getIsRemoteMode: () => false,
  }))
  mock.module('../../memdir/memoryScan.js', () => ({
    ...realMemoryScan,
    formatMemoryManifest: () => 'No memories yet.',
    scanMemoryFiles: async () => [],
  }))
  mock.module('../../memdir/paths.js', () => ({
    ...realPaths,
    getAutoMemPath: () => '/tmp/memory-extraction-test',
    isAutoMemoryEnabled: () => true,
    isAutoMemPath: () => false,
  }))
  mock.module('../../utils/governancePolicy.js', () => ({
    ...realGovernance,
    isMemoryWriteApprovalRequired: () => false,
  }))
  mock.module('../../utils/debug.js', () => ({
    ...realDebug,
    logForDebugging: debugLog,
  }))
  mock.module('../../utils/forkedAgent.js', () => ({
    ...realForkedAgent,
    createCacheSafeParams: (context: Parameters<typeof realForkedAgent.createCacheSafeParams>[0]) => ({
      systemPrompt: context.systemPrompt,
      userContext: context.userContext,
      systemContext: context.systemContext,
      toolUseContext: context.toolUseContext,
      forkContextMessages: context.messages,
    }),
    runForkedAgent,
  }))
  mock.module('../analytics/growthbook.js', () => ({
    ...realGrowthbook,
    getFeatureValue_CACHED_MAY_BE_STALE: (
      key: string,
      defaultValue: unknown,
    ) => (key === 'tengu_passport_quail' ? true : defaultValue),
  }))
  mock.module('../analytics/index.js', () => ({
    ...realAnalytics,
    logEvent: (name: string) => {
      events.push(name)
    },
  }))
}

describe('extractMemories cancellation', () => {
  beforeEach(async () => {
    await acquireSharedMutationLock('extractMemories.abort.test.ts')
  })

  afterEach(() => {
    try {
      mock.restore()
      mock.module('../../bootstrap/state.js', () => realBootstrapState)
      mock.module('../../memdir/memoryScan.js', () => realMemoryScan)
      mock.module('../../memdir/paths.js', () => realPaths)
      mock.module('../../utils/governancePolicy.js', () => realGovernance)
      mock.module('../../utils/debug.js', () => realDebug)
      mock.module('../../utils/forkedAgent.js', () => realForkedAgent)
      mock.module('../analytics/growthbook.js', () => realGrowthbook)
      mock.module('../analytics/index.js', () => realAnalytics)
    } finally {
      releaseSharedMutationLock()
    }
  })

  test('superseding an active extraction aborts the stale fork with an expected reason', async () => {
    const debugLog = mock((_message: string) => {})
    const events: string[] = []
    const forkCalls: ForkCall[] = []
    const runForkedAgent = mock(({ overrides }: Parameters<typeof realForkedAgent.runForkedAgent>[0]) => {
      const abortController = overrides?.abortController as
        | AbortController
        | undefined
      forkCalls.push({ abortController })

      if (forkCalls.length > 1) {
        return Promise.resolve({
          messages: [],
          totalUsage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        })
      }

      return new Promise((_resolve, reject) => {
        abortController?.signal.addEventListener(
          'abort',
          () => reject(new APIUserAbortError()),
          { once: true },
        )
      })
    })

    registerExtractMemoriesStubs({ runForkedAgent, debugLog, events })

    const { executeExtractMemories, initExtractMemories } = await import(
      `./extractMemories.js?ts=${Date.now()}-${Math.random()}`
    )
    initExtractMemories()

    const firstExtraction = executeExtractMemories(createContext('m1'))
    await Promise.resolve()
    await Promise.resolve()

    await executeExtractMemories(createContext('m2'))

    expect(runForkedAgent.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(forkCalls[0]?.abortController).toBeDefined()
    expect(forkCalls[0]!.abortController!.signal.aborted).toBe(true)
    expect(forkCalls[0]!.abortController!.signal.reason).toBe(
      'memory-extraction-superseded',
    )

    await firstExtraction

    expect(events).toContain('tengu_extract_memories_coalesced')
    expect(events).not.toContain('tengu_extract_memories_error')
    expect(
      debugLog.mock.calls.some(([message]) =>
        String(message).includes('[extractMemories] expected cancellation'),
      ),
    ).toBe(true)
  })

  test('superseded extraction still reports non-abort failures', async () => {
    const debugLog = mock((_message: string) => {})
    const events: string[] = []
    const forkCalls: ForkCall[] = []
    const runForkedAgent = mock(({ overrides }: Parameters<typeof realForkedAgent.runForkedAgent>[0]) => {
      const abortController = overrides?.abortController as
        | AbortController
        | undefined
      forkCalls.push({ abortController })

      if (forkCalls.length > 1) {
        return Promise.resolve({
          messages: [],
          totalUsage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        })
      }

      return new Promise((_resolve, reject) => {
        abortController?.signal.addEventListener(
          'abort',
          () => reject(new Error('write failed after abort')),
          { once: true },
        )
      })
    })

    registerExtractMemoriesStubs({ runForkedAgent, debugLog, events })

    const { executeExtractMemories, initExtractMemories } = await import(
      `./extractMemories.js?ts=${Date.now()}-${Math.random()}`
    )
    initExtractMemories()

    const firstExtraction = executeExtractMemories(createContext('m1'))
    await Promise.resolve()
    await Promise.resolve()

    await executeExtractMemories(createContext('m2'))
    await firstExtraction

    expect(forkCalls[0]?.abortController?.signal.reason).toBe(
      'memory-extraction-superseded',
    )
    expect(events).toContain('tengu_extract_memories_error')
    expect(
      debugLog.mock.calls.some(([message]) =>
        String(message).includes('[extractMemories] expected cancellation'),
      ),
    ).toBe(false)
  })

  test('superseded extraction does not advance cursor when stale fork resolves after abort', async () => {
    const debugLog = mock((_message: string) => {})
    const events: string[] = []
    const forkPrompts: string[] = []
    const forkCalls: ForkCall[] = []
    const emptyResult = {
      messages: [],
      totalUsage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    }
    const runForkedAgent = mock(({ overrides, promptMessages }: Parameters<typeof realForkedAgent.runForkedAgent>[0]) => {
      const abortController = overrides?.abortController as
        | AbortController
        | undefined
      forkCalls.push({ abortController })
      forkPrompts.push(String(promptMessages[0]?.message.content ?? ''))

      if (forkCalls.length > 1) {
        return Promise.resolve(emptyResult)
      }

      return new Promise(resolve => {
        abortController?.signal.addEventListener(
          'abort',
          () => resolve(emptyResult),
          { once: true },
        )
      })
    })

    registerExtractMemoriesStubs({ runForkedAgent, debugLog, events })

    const { executeExtractMemories, initExtractMemories } = await import(
      `./extractMemories.js?ts=${Date.now()}-${Math.random()}`
    )
    initExtractMemories()

    const firstExtraction = executeExtractMemories(createContext(['m1', 'm2']))
    await Promise.resolve()
    await Promise.resolve()

    await executeExtractMemories(createContext(['m1', 'm2', 'm3']))
    await firstExtraction

    expect(runForkedAgent).toHaveBeenCalledTimes(2)
    expect(forkCalls[0]?.abortController?.signal.reason).toBe(
      'memory-extraction-superseded',
    )
    expect(forkPrompts[1]).toContain('most recent ~3 messages')
    expect(events).toContain('tengu_extract_memories_coalesced')
    expect(events).not.toContain('tengu_extract_memories_error')
    expect(
      debugLog.mock.calls.some(([message]) =>
        String(message).includes('[extractMemories] expected cancellation'),
      ),
    ).toBe(true)
  })
})
