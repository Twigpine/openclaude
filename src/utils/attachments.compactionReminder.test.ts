import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { feature } from 'bun:bundle'
import type { ToolUseContext, Tools } from '../Tool.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import type { Message } from '../types/message.js'
import { asAgentId } from '../types/ids.js'
import { createAttachmentMessage } from './attachments.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { createUserMessage } from './messages.js'
import { createCompactBoundaryMessage } from './messages/systemFactories.js'

const ENV_KEYS = [
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_DISABLE_ATTACHMENTS',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'USER_TYPE',
] as const

const SAVED_ENV = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = SAVED_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function clearTestEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key]
  }
}

// Cache-busted import of the real config module so the partial mock below can
// spread it (pattern from attachments.todoReminder.test.ts).
const realConfig = { ...(await import(`./config.js?real=${Date.now()}`)) }
mock.module('./config.js', () => ({
  ...realConfig,
  getGlobalConfig: () => ({
    ...realConfig.getGlobalConfig(),
    autoCompactEnabled: true,
  }),
}))

const { getAttachments, getCompactionReminderAttachment } = await import(
  './attachments.js'
)

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.compactionReminder.test.ts')
  clearTestEnv()
})

afterEach(() => {
  try {
    restoreEnv()
    // mock.module registrations are process-global and mock.restore() does not
    // undo them, so re-register the genuine module to keep the forced
    // autoCompactEnabled from leaking into other files in this process.
    mock.restore()
    mock.module('./config.js', () => realConfig)
  } finally {
    releaseSharedMutationLock()
  }
})

const ONE_MILLION_MODEL = 'claude-sonnet-4[1m]'

function userMessage(estimatedTokens: number): Message {
  return createUserMessage({ content: 'x'.repeat(estimatedTokens * 4) })
}

function testContext(messages: Message[]): ToolUseContext {
  let appState = getDefaultAppState()
  return {
    agentId: asAgentId('compaction-reminder-test'),
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(1),
    getAppState: () => appState,
    setAppState: updater => {
      appState = updater(appState)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages,
    options: {
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      tools: [] as Tools,
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents: [],
        allAgents: [],
        allowedAgentTypes: undefined,
      },
      mainLoopModel: ONE_MILLION_MODEL,
    },
    nestedMemoryAttachmentTriggers: new Set<string>(),
    dynamicSkillDirTriggers: new Set<string>(),
  }
}

describe('getCompactionReminderAttachment', () => {
  test('reminds once usage passes a quarter of the effective window on a 1M model', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'

    expect(
      getCompactionReminderAttachment([userMessage(10_000)], ONE_MILLION_MODEL),
    ).toEqual([{ type: 'compaction_reminder' }])
  })

  test('stays quiet below the quarter mark', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'

    expect(
      getCompactionReminderAttachment([userMessage(1_000)], ONE_MILLION_MODEL),
    ).toEqual([])
  })

  test('stays quiet on models without a 1M context window', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'

    expect(
      getCompactionReminderAttachment([userMessage(10_000)], 'gpt-4o'),
    ).toEqual([])
  })

  test('respects DISABLE_AUTO_COMPACT', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'
    process.env.DISABLE_AUTO_COMPACT = '1'

    expect(
      getCompactionReminderAttachment([userMessage(10_000)], ONE_MILLION_MODEL),
    ).toEqual([])
  })
})

describe('compaction reminder pacing across tool-loop passes', () => {
  // The tool loop calls getAttachments on every round with the growing message
  // list, so the helper itself has to notice a reminder it already injected.
  test('stays quiet once a reminder is already in the transcript', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'
    const first: Message[] = [userMessage(10_000)]
    const reminders = getCompactionReminderAttachment(first, ONE_MILLION_MODEL)
    expect(reminders).toEqual([{ type: 'compaction_reminder' }])

    const second: Message[] = [
      ...first,
      createAttachmentMessage(reminders[0]!),
      userMessage(500),
    ]
    expect(getCompactionReminderAttachment(second, ONE_MILLION_MODEL)).toEqual([])
  })

  test('stays quiet across several further tool rounds', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'
    let messages: Message[] = [userMessage(10_000)]
    let emitted = 0
    for (let round = 0; round < 5; round++) {
      const out = getCompactionReminderAttachment(messages, ONE_MILLION_MODEL)
      emitted += out.length
      messages = [...messages, ...out.map(createAttachmentMessage), userMessage(500)]
    }
    expect(emitted).toBe(1)
  })

  test('reminds again after a compact boundary resets the transcript', () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'
    const messages: Message[] = [
      userMessage(10_000),
      createAttachmentMessage({ type: 'compaction_reminder' }),
      createCompactBoundaryMessage('auto', 10_000),
      userMessage(10_000),
    ]
    expect(getCompactionReminderAttachment(messages, ONE_MILLION_MODEL)).toEqual([
      { type: 'compaction_reminder' },
    ])
  })
})

describe('COMPACTION_REMINDERS gate', () => {
  test('getAttachments includes the reminder only when the build flag is on', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '40000'
    const messages = [userMessage(10_000)]

    const attachments = await getAttachments(
      null,
      testContext(messages),
      null,
      [],
      messages,
      'compact',
      { skipSkillDiscovery: true },
    )
    const reminders = attachments.filter(
      attachment => attachment.type === 'compaction_reminder',
    )

    if (feature('COMPACTION_REMINDERS')) {
      expect(reminders).toEqual([{ type: 'compaction_reminder' }])
    } else {
      expect(reminders).toEqual([])
    }
  })
})
