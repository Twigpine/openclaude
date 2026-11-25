import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutoCompactTrackingState } from '../services/compact/autoCompact.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { Message } from '../types/message.js'
import { createCompactBoundaryMessage } from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import type { MaxMessagesCompactionThreshold } from '../utils/config.js'
import type { QueryDeps } from './deps.js'

type AutocompactArgs = Parameters<QueryDeps['autocompact']>

// Some smoke-suite files mock config globally; bun:test does not unregister
// mock.module() registrations on mock.restore(). Pin this suite to the real
// config before importing query so saved settings are visible to the query loop.
const realConfigModule = (await import(
  `../utils/config.js?autoCompactCooldownReal=${Date.now()}-${Math.random()}`
)) as typeof import('../utils/config.js')
mock.module('../utils/config.js', () => ({ ...realConfigModule }))

const { getGlobalConfig, saveGlobalConfig } = realConfigModule
const {
  getAutoCompactThreshold,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} = (await import(
  `../services/compact/autoCompact.js?autoCompactCooldownReal=${Date.now()}-${Math.random()}`
)) as typeof import('../services/compact/autoCompact.js')

const SAVED_ENV = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW:
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT,
  DISABLE_COMPACT: process.env.DISABLE_COMPACT,
  OPENCLAUDE_MAX_ACTIVE_MESSAGES: process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES,
  OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP:
    process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP,
}

let savedGlobalConfig:
  | {
      autoCompactEnabled: boolean
      maxMessagesCompactionThreshold:
        | MaxMessagesCompactionThreshold
        | undefined
    }
  | undefined
let tempDir: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock('query/autoCompactCooldown.test.ts')
  tempDir = mkdtempSync(join(tmpdir(), 'openclaude-autocompact-test-'))
  process.env.CLAUDE_CONFIG_DIR = tempDir
  const globalConfig = getGlobalConfig()
  savedGlobalConfig = {
    autoCompactEnabled: globalConfig.autoCompactEnabled,
    maxMessagesCompactionThreshold:
      globalConfig.maxMessagesCompactionThreshold,
  }
  saveGlobalConfig(current => ({
    ...current,
    autoCompactEnabled: true,
    maxMessagesCompactionThreshold: undefined,
  }))
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '200000'
  process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
  delete process.env.DISABLE_AUTO_COMPACT
  delete process.env.DISABLE_COMPACT
  delete process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES
  delete process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
})

afterEach(() => {
  try {
    if (savedGlobalConfig) {
      const { autoCompactEnabled, maxMessagesCompactionThreshold } =
        savedGlobalConfig
      saveGlobalConfig(current => ({
        ...current,
        autoCompactEnabled,
        maxMessagesCompactionThreshold,
      }))
      savedGlobalConfig = undefined
    }

    for (const [key, value] of Object.entries(SAVED_ENV)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: `test-${Math.random()}` as Message['uuid'],
    timestamp: new Date().toISOString(),
  }
}

function overAutoCompactThresholdMessage(): Message {
  const threshold = getAutoCompactThreshold('claude-sonnet-4')
  return userMessage('x'.repeat((threshold + 1_000) * 4))
}

function manySmallMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => userMessage(`small-${index}`))
}

function virtualUserMessage(content: string): Message {
  return { ...userMessage(content), isVirtual: true }
}

function manySmallMessagesWithVirtualTail(
  nonVirtualCount: number,
  virtualCount: number,
): Message[] {
  return [
    ...manySmallMessages(nonVirtualCount),
    ...Array.from({ length: virtualCount }, (_, index) =>
      virtualUserMessage(`virtual-${index}`),
    ),
  ]
}

function compactedResult() {
  return {
    wasCompacted: true,
    consecutiveFailures: 0,
    compactionResult: {
      boundaryMarker: createCompactBoundaryMessage('auto', 10_000),
      summaryMessages: [userMessage('compacted summary')],
      messagesToKeep: [],
      attachments: [],
      hookResults: [],
      preCompactTokenCount: 10_000,
      postCompactTokenCount: 500,
      truePostCompactTokenCount: 500,
    },
  }
}

function toolUseContext() {
  const abortController = new AbortController()
  return {
    abortController,
    agentId: undefined,
    contentReplacementState: undefined,
    options: {
      agentDefinitions: { activeAgents: [] },
      allowedAgentTypes: undefined,
      appendSystemPrompt: undefined,
      isNonInteractiveSession: false,
      mainLoopModel: 'claude-sonnet-4',
      mcpClients: [],
      providerOverride: undefined,
      thinkingConfig: undefined,
      tools: [],
    },
    readFileState: {},
    getAppState: () => ({
      fastMode: false,
      effortValue: undefined,
      advisorModel: undefined,
      mainLoopModel: 'claude-sonnet-4',
      mainLoopModelForSession: undefined,
      mcp: { tools: [], clients: [] },
      toolPermissionContext: { mode: 'default' },
    }),
    setInProgressToolUseIDs: () => {},
  } as never
}

function assistantToolUseMessage(): Message {
  // Minimal fixture (no model/usage) — cast type-side only.
  return {
    type: 'assistant',
    message: {
      id: 'msg-test-tool-use',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-use-test',
          name: 'MissingTool',
          input: {},
        },
      ],
    },
    uuid: 'assistant-tool-use' as Message['uuid'],
    timestamp: new Date().toISOString(),
  } as unknown as Message
}

async function canUseTool() {
  return { behavior: 'allow' as const }
}

async function drain<T, TReturn>(
  generator: AsyncGenerator<T, TReturn>,
): Promise<{ yielded: T[]; terminal: TReturn }> {
  const yielded: T[] = []
  while (true) {
    const next = await generator.next()
    if (next.done) {
      return { yielded, terminal: next.value }
    }
    yielded.push(next.value)
  }
}

async function loadQuery() {
  return (await import(
    `../query.js?autoCompactCooldown=${Date.now()}-${Math.random()}`
  )) as typeof import('../query.js')
}

function successfulQueryDeps(
  microcompactImpl?: (input: Message[]) => Promise<{ messages: Message[] }>,
) {
  const callModel = mock(async function* (_params: { messages: Message[] }) {
    yield assistantToolUseMessage()
  })
  const microcompact = mock(
    microcompactImpl ?? (async (input: Message[]) => ({ messages: input })),
  )
  const autocompact = mock(async () => ({
    wasCompacted: false,
  }))
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: microcompact as QueryDeps['microcompact'],
    autocompact: autocompact as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }
  return {
    deps,
    callModel,
    microcompact,
    autocompact,
  }
}

async function runSuccessfulQuery(
  deps: QueryDeps,
  querySource: 'repl_main_thread' | 'compact' = 'repl_main_thread',
) {
  const { query } = await loadQuery()
  return await drain(
    query({
      messages: [userMessage('hello')],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource,
      maxTurns: 1,
      deps,
    }),
  )
}

async function runMessageCountHardCapQuery(messages: Message[]) {
  const seenTracking: Array<AutoCompactTrackingState | undefined> = []
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(
      async (
        _messages: AutocompactArgs[0],
        _toolUseContext: AutocompactArgs[1],
        _params: AutocompactArgs[2],
        _querySource: AutocompactArgs[3],
        tracking: AutocompactArgs[4],
      ) => {
        seenTracking.push(tracking)
        return tracking?.forceReason === 'message-count'
          ? compactedResult()
          : { wasCompacted: false }
      },
    ) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const result = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
    }),
  )

  return { ...result, callModel, seenTracking }
}

test('explicit off skips automatic microcompact during query flow', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: 'off',
  }))
  const { deps, callModel, microcompact, autocompact } = successfulQueryDeps(
    async input => ({ messages: input }),
  )

  const { terminal } = await runSuccessfulQuery(deps)

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(autocompact).toHaveBeenCalledTimes(1)
  expect(microcompact).not.toHaveBeenCalled()
})

test('unset message-count threshold keeps automatic microcompact behavior', async () => {
  const { deps, microcompact } = successfulQueryDeps()

  const { terminal } = await runSuccessfulQuery(deps)

  expect(terminal.reason).toBe('max_turns')
  expect(microcompact).toHaveBeenCalledTimes(1)
})

test('automatic microcompact passes compacted messages to the model call', async () => {
  const compactedMessages = [userMessage('compacted hello')]
  const { deps, callModel, microcompact } = successfulQueryDeps(async () => ({
    messages: compactedMessages,
  }))

  const { terminal } = await runSuccessfulQuery(deps)

  expect(terminal.reason).toBe('max_turns')
  expect(microcompact).toHaveBeenCalledTimes(1)
  expect(callModel.mock.calls[0]?.[0].messages).toEqual(compactedMessages)
})

test('numeric message-count threshold keeps automatic microcompact behavior', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: '100',
  }))
  const { deps, microcompact } = successfulQueryDeps()

  const { terminal } = await runSuccessfulQuery(deps)

  expect(terminal.reason).toBe('max_turns')
  expect(microcompact).toHaveBeenCalledTimes(1)
})

test('default active-message hard cap forces compaction', async () => {
  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(1001))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('unset message threshold forces compaction at the 200-message default', async () => {
  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(201))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('invalid legacy message threshold keeps the 200-message default', async () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES = 'not-a-number'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(201))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('disabled auto-compact leaves the default message threshold inactive', async () => {
  process.env.DISABLE_AUTO_COMPACT = '1'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(201))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBeUndefined()
})

test('disabled auto-compact ignores an invalid persisted message threshold', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold:
      'not-a-threshold' as MaxMessagesCompactionThreshold,
  }))
  process.env.DISABLE_AUTO_COMPACT = '1'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(201))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBeUndefined()
})

test('disabled auto-compact preserves an explicit message threshold', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: '100',
  }))
  process.env.DISABLE_AUTO_COMPACT = '1'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(101))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('disabled auto-compact preserves a legacy message threshold', async () => {
  process.env.DISABLE_AUTO_COMPACT = '1'
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES = '100'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(101))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('explicit off preserves a legacy message threshold', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: 'off',
  }))
  process.env.DISABLE_AUTO_COMPACT = '1'
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES = '100'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(101))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('long-session smoke keeps repeated over-cap turns bounded before provider calls', async () => {
  const seenProviderMessageCounts: number[] = []
  const seenTracking: Array<AutoCompactTrackingState | undefined> = []
  const callModel = mock(async function* (params: { messages: Message[] }) {
    seenProviderMessageCounts.push(params.messages.length)
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(
      async (
        _messages: AutocompactArgs[0],
        _toolUseContext: AutocompactArgs[1],
        _params: AutocompactArgs[2],
        _querySource: AutocompactArgs[3],
        tracking: AutocompactArgs[4],
      ) => {
        seenTracking.push(tracking)
        return tracking?.forceReason === 'message-count'
          ? compactedResult()
          : { wasCompacted: false }
      },
    ) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }
  const { query } = await loadQuery()
  let persistedTracking: AutoCompactTrackingState | undefined

  for (let turn = 0; turn < 4; turn++) {
    const result = await drain(
      query({
        messages: manySmallMessages(1001 + turn),
        systemPrompt: asSystemPrompt([]),
        userContext: {},
        systemContext: {},
        canUseTool,
        toolUseContext: toolUseContext(),
        querySource: 'repl_main_thread',
        maxTurns: 1,
        deps,
        autoCompactTracking: persistedTracking,
        onAutoCompactTrackingChange: tracking => {
          persistedTracking = tracking
        },
      }),
    )
    expect(result.terminal.reason).toBe('max_turns')
  }

  expect(callModel).toHaveBeenCalledTimes(4)
  expect(seenTracking).toHaveLength(4)
  expect(
    seenTracking.every(tracking => tracking?.forceReason === 'message-count'),
  ).toBe(true)
  expect(seenProviderMessageCounts.every(count => count <= 1000)).toBe(true)
})

test('invalid active-message hard cap override keeps default safety cap', async () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '100O'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(1001))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBe('message-count')
})

test('explicit zero active-message hard cap override disables safety cap', async () => {
  // Isolate the hard-cap override: with the 200-message-count default active,
  // a 1001-message history would otherwise force message-count compaction, so
  // disable message-count compaction explicitly to test only the hard cap.
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: 'off',
  }))
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'

  const { terminal, callModel, seenTracking } =
    await runMessageCountHardCapQuery(manySmallMessages(1001))

  expect(terminal.reason).toBe('max_turns')
  expect(callModel).toHaveBeenCalledTimes(1)
  expect(seenTracking[0]?.forceReason).toBeUndefined()
})

test('active-message hard cap blocks when forced compaction fails', async () => {
  const messages = manySmallMessages(1001)
  const callModel = mock(() => {
    throw new Error('model should not be called while over the hard cap')
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      deps,
    }),
  )

  expect(callModel).not.toHaveBeenCalled()
  expect(terminal.reason).toBe('blocking_limit')
  const apiError = yielded.find(
    (message): message is Message =>
      (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
  )
  expect(apiError).toBeDefined()
  const text = apiError!.message.content[0].text
  expect(text).toContain('active-message safety limit')
  expect(text).toContain('stopped before sending another oversized request')
})

test('auto-compact failure emits a visible warning before retrying later', async () => {
  const messages = [overAutoCompactThresholdMessage()]
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
      consecutiveFailures: 1,
      lastFailureAtMs: Date.now(),
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
    }),
  )

  expect(callModel).toHaveBeenCalledTimes(1)
  expect(terminal.reason).toBe('max_turns')
  const warning = yielded.find(
    message =>
      message.type === 'system' &&
      message.subtype === 'informational' &&
      message.level === 'warning',
  )
  expect(warning?.content).toContain('Automatic compaction failed (1/3)')
  expect(warning?.content).toContain('retry compaction')
})

test('explicit compact query source still runs microcompact when threshold is off', async () => {
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: 'off',
  }))
  const { deps, microcompact } = successfulQueryDeps()

  const { terminal } = await runSuccessfulQuery(deps, 'compact')

  expect(terminal.reason).toBe('max_turns')
  expect(microcompact).toHaveBeenCalledTimes(1)
})

test('active auto-compact cooldown blocks before model call with cooldown guidance', async () => {
  const messages = [overAutoCompactThresholdMessage()]
  const nextRetryAtMs = Date.now() + 60_000
  const callModel = mock(() => {
    throw new Error('model should not be called while autocompact cools down')
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(
      async (): Promise<{
        wasCompacted: boolean
        consecutiveFailures: number
        nextRetryAtMs: number
        circuitBreakerActive: boolean
        circuitBreakerTripped: boolean
      }> => ({
        wasCompacted: false,
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs,
        circuitBreakerActive: true,
        circuitBreakerTripped: false,
      }),
    ) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      deps,
    }),
  )

  expect(callModel).not.toHaveBeenCalled()
  expect(terminal.reason).toBe('blocking_limit')

  const apiError = yielded.find(
    (message): message is Message =>
      (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
  )
  expect(apiError).toBeDefined()
  const text = apiError!.message.content[0].text
  expect(text).toContain('automatic compaction is cooling down')
  expect(text).toContain('Retry after')
  const warning = yielded.find(
    message =>
      message.type === 'system' &&
      message.subtype === 'informational' &&
      message.level === 'warning',
  )
  expect(warning?.content).toContain('Automatic compaction is paused')
  expect(warning?.content).toContain('retry after')
})

test('active auto-compact cooldown blocks message-count overflow before model call', async () => {
  const messages = manySmallMessages(1001)
  const nextRetryAtMs = Date.now() + 60_000
  const callModel = mock(() => {
    throw new Error('model should not be called while autocompact cools down')
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      nextRetryAtMs,
      circuitBreakerActive: true,
      circuitBreakerTripped: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      deps,
    }),
  )

  expect(callModel).not.toHaveBeenCalled()
  expect(terminal.reason).toBe('blocking_limit')
  const apiError = yielded.find(
    (message): message is Message =>
      (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
  )
  expect(apiError).toBeDefined()
  const text = apiError!.message.content[0].text
  expect(text).toContain('auto-compact safety threshold')
  expect(text).toContain('Retry after')
})

test('auto-compact cooldown tracking is carried into the next query call', async () => {
  const messages = [overAutoCompactThresholdMessage()]
  const nextRetryAtMs = Date.now() + 60_000
  const seenTracking: Array<AutoCompactTrackingState | undefined> = []
  const callModel = mock(() => {
    throw new Error('model should not be called while autocompact cools down')
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(
      async (
        _messages: AutocompactArgs[0],
        _toolUseContext: AutocompactArgs[1],
        _params: AutocompactArgs[2],
        _querySource: AutocompactArgs[3],
        tracking: AutocompactArgs[4],
      ) => {
        seenTracking.push(tracking)
        return {
          wasCompacted: false,
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          nextRetryAtMs,
          circuitBreakerActive: true,
          circuitBreakerTripped: false,
        }
      },
    ) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  let persistedTracking: AutoCompactTrackingState | undefined
  const queryParams = () => ({
    messages,
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool,
    toolUseContext: toolUseContext(),
    querySource: 'repl_main_thread' as const,
    deps,
    autoCompactTracking: persistedTracking,
    onAutoCompactTrackingChange: (
      tracking: AutoCompactTrackingState | undefined,
    ) => {
      persistedTracking = tracking
    },
  })

  const { query } = await loadQuery()
  const first = await drain(query(queryParams()))
  expect(first.terminal.reason).toBe('blocking_limit')
  expect(persistedTracking?.nextRetryAtMs).toBe(nextRetryAtMs)

  const second = await drain(query(queryParams()))
  expect(second.terminal.reason).toBe('blocking_limit')
  expect(callModel).not.toHaveBeenCalled()
  expect(seenTracking).toHaveLength(2)
  expect(seenTracking[0]).toBeUndefined()
  expect(seenTracking[1]?.nextRetryAtMs).toBe(nextRetryAtMs)
  expect(seenTracking[1]?.consecutiveFailures).toBe(
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  )
})

test('post-compact turn tracking callback publishes a fresh object', async () => {
  const initialTracking: AutoCompactTrackingState = {
    compacted: true,
    turnId: 'compact-turn',
    turnCounter: 0,
    consecutiveFailures: 0,
  }
  const trackingUpdates: AutoCompactTrackingState[] = []
  const deps: QueryDeps = {
    callModel: mock(async function* () {
      yield assistantToolUseMessage()
    }) as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { terminal } = await drain(
    query({
      messages: [userMessage('hello')],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
      autoCompactTracking: initialTracking,
      onAutoCompactTrackingChange: tracking => {
        if (tracking) {
          trackingUpdates.push(tracking)
        }
      },
    }),
  )

  expect(terminal.reason).toBe('max_turns')
  expect(trackingUpdates).toHaveLength(1)
  expect(trackingUpdates[0]).not.toBe(initialTracking)
  expect(trackingUpdates[0]?.turnCounter).toBe(1)
  expect(initialTracking.turnCounter).toBe(0)
})

test('persisted breaker state does not block when auto-compact is disabled', async () => {
  process.env.DISABLE_AUTO_COMPACT = '1'
  const initialTracking: AutoCompactTrackingState = {
    compacted: false,
    turnId: 'turn',
    turnCounter: 0,
    consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    nextRetryAtMs: Date.now() + 60_000,
  }
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages: [overAutoCompactThresholdMessage()],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
      autoCompactTracking: initialTracking,
    }),
  )

  expect(callModel).toHaveBeenCalledTimes(1)
  expect(terminal.reason).toBe('max_turns')
  expect(
    yielded.some(
      message =>
        (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ),
  ).toBe(false)
})

test('breaker metadata tracking callback publishes a fresh object', async () => {
  const initialTracking: AutoCompactTrackingState = {
    compacted: false,
    turnId: 'turn',
    turnCounter: 0,
    consecutiveFailures: 2,
    nextRetryAtMs: 10_000,
    lastFailureAtMs: 5_000,
  }
  const trackingUpdates: AutoCompactTrackingState[] = []
  const deps: QueryDeps = {
    callModel: mock(() => {
      throw new Error('model should not be called while autocompact cools down')
    }) as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      nextRetryAtMs: 20_000,
      lastFailureAtMs: 15_000,
      circuitBreakerActive: true,
      circuitBreakerTripped: true,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { terminal } = await drain(
    query({
      messages: [overAutoCompactThresholdMessage()],
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      deps,
      autoCompactTracking: initialTracking,
      onAutoCompactTrackingChange: tracking => {
        if (tracking) {
          trackingUpdates.push(tracking)
        }
      },
    }),
  )

  expect(terminal.reason).toBe('blocking_limit')
  expect(trackingUpdates).toHaveLength(1)
  expect(trackingUpdates[0]).not.toBe(initialTracking)
  expect(trackingUpdates[0]?.consecutiveFailures).toBe(
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  )
  expect(trackingUpdates[0]?.nextRetryAtMs).toBe(20_000)
  expect(trackingUpdates[0]?.lastFailureAtMs).toBe(15_000)
  expect(initialTracking.consecutiveFailures).toBe(2)
  expect(initialTracking.nextRetryAtMs).toBe(10_000)
  expect(initialTracking.lastFailureAtMs).toBe(5_000)
})
test('virtual messages do not count toward the active-message hard cap', async () => {
  // With auto-compact disabled and no message-count override, the hard cap is
  // the only enforcement path. 1000 nonvirtual rows sit exactly at the default
  // cap; virtual padding must not push the count over it.
  process.env.DISABLE_AUTO_COMPACT = '1'
  const messages = manySmallMessagesWithVirtualTail(1000, 5)
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
    }),
  )

  expect(callModel).toHaveBeenCalledTimes(1)
  expect(terminal.reason).toBe('max_turns')
  expect(
    yielded.some(
      message =>
        (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ),
  ).toBe(false)
})

test('virtual messages do not count toward the breaker safety message limit', async () => {
  // Explicit 100-message threshold with the hard cap moved out of the way.
  // 100 nonvirtual rows sit exactly at the threshold; virtual padding must not
  // trip the circuit-breaker safety limit.
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: '100',
  }))
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '5000'
  const messages = manySmallMessagesWithVirtualTail(100, 5)
  const nextRetryAtMs = Date.now() + 60_000
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      nextRetryAtMs,
      circuitBreakerActive: true,
      circuitBreakerTripped: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
    }),
  )

  expect(callModel).toHaveBeenCalledTimes(1)
  expect(terminal.reason).toBe('max_turns')
  expect(
    yielded.some(
      message =>
        (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ),
  ).toBe(false)
})

test('virtual messages do not count toward the final active-message blocking limit', async () => {
  // Same 100-message threshold without breaker failures, so only the final
  // blocking check can stop the query. 100 nonvirtual rows sit exactly at the
  // threshold; virtual padding must not trigger the blocking limit.
  saveGlobalConfig(current => ({
    ...current,
    maxMessagesCompactionThreshold: '100',
  }))
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '5000'
  const messages = manySmallMessagesWithVirtualTail(100, 5)
  const callModel = mock(async function* () {
    yield assistantToolUseMessage()
  })
  const deps: QueryDeps = {
    callModel: callModel as QueryDeps['callModel'],
    microcompact: mock(async (input: Message[]) => ({
      messages: input,
    })) as QueryDeps['microcompact'],
    autocompact: mock(async () => ({
      wasCompacted: false,
    })) as QueryDeps['autocompact'],
    uuid: () => 'test-uuid',
  }

  const { query } = await loadQuery()
  const { yielded, terminal } = await drain(
    query({
      messages,
      systemPrompt: asSystemPrompt([]),
      userContext: {},
      systemContext: {},
      canUseTool,
      toolUseContext: toolUseContext(),
      querySource: 'repl_main_thread',
      maxTurns: 1,
      deps,
    }),
  )

  expect(callModel).toHaveBeenCalledTimes(1)
  expect(terminal.reason).toBe('max_turns')
  expect(
    yielded.some(
      message =>
        (message as { isApiErrorMessage?: boolean }).isApiErrorMessage === true,
    ),
  ).toBe(false)
})
