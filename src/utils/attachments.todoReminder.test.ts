import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getIsInteractive, setIsInteractive } from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { snapshotEnv } from '../test/envSnapshot.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import type { ToolUseContext, Tools } from '../Tool.js'
import { asAgentId } from '../types/ids.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'
import { createAssistantMessage } from './messages.js'
import { SettingsSchema } from './settings/types.js'

const ENV_KEYS = [
  'OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE',
  'OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS',
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

// Snapshot the real settings module with a cache-busted import before any
// mock.module runs, so the cleanup below can restore the genuine
// implementation even when a previous serialized Bun test mocked the same
// module (pattern from attribution.test.ts / modelOptions.crossProfile.test.ts).
const realSettings = { ...await import(`./settings/settings.js?real=${Date.now()}`) }

// Settings stubs passed to mockMergedSettings must already be schema-valid:
// SettingsSchema degrades invalid todoReminder values to undefined upstream
// (see the schema tests below), so the consumer never observes them.
function mockMergedSettings(settings: Record<string, unknown>): void {
  mock.module('./settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => settings,
    getSettings_DEPRECATED: () => settings,
    getSettingsForSource: () => settings,
  }))
}

let settingsAwareAttachments: Promise<typeof import('./attachments.js')> | undefined
let getTodoReminderConfig: typeof import('./attachments.js')['getTodoReminderConfig']
async function getSettingsAwareAttachments(): Promise<typeof import('./attachments.js')> {
  // Fresh nonced import so the consumer observes this file's settings mock
  // even when earlier serialized tests mocked the same modules.
  settingsAwareAttachments ??= import(
    `./attachments.ts?todoreminderSettings=${Date.now()}-${Math.random()}`
  )
  return settingsAwareAttachments
}

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.todoReminder.test.ts')
  clearTestEnv()
  mockMergedSettings({})
  ;({ getTodoReminderConfig } = await getSettingsAwareAttachments())
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('./settings/settings.js', () => realSettings)
    restoreEnv()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('getTodoReminderConfig', () => {
  test('returns defaults when nothing is configured', () => {
    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(10)
    expect(config.turnsBetweenReminders).toBe(10)
  })

  test('reads from environment variables', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '15'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '20'

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(15)
    expect(config.turnsBetweenReminders).toBe(20)
  })

  test('handles invalid environment variable values', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = 'invalid'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '0'

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(10)
    expect(config.turnsBetweenReminders).toBe(10)
  })

  test('handles negative environment variable values', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '-5'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '-10'

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(10)
    expect(config.turnsBetweenReminders).toBe(10)
  })

  test('handles partial environment variable configuration', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '15'

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(15)
    expect(config.turnsBetweenReminders).toBe(10)
  })

  test('rejects suffixed, fractional, and scientific-notation values', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '15turns'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '2.5'

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(10)
    expect(config.turnsBetweenReminders).toBe(10)

    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '1e2'
    expect(getTodoReminderConfig().turnsSinceWrite).toBe(10)
  })

  test('rejects oversized values instead of truncating them', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '9'.repeat(400)

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(10)
  })

  test('accepts whitespace-padded valid values', () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = ' 12 '

    const config = getTodoReminderConfig()
    expect(config.turnsSinceWrite).toBe(12)
  })
})

describe('getTodoReminderConfig settings precedence', () => {
  test('both settings fields override environment variables', async () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '99'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '99'
    mockMergedSettings({ todoReminder: { turnsSinceWrite: 15, turnsBetweenReminders: 20 } })

    const { getTodoReminderConfig: resolve } = await getSettingsAwareAttachments()
    const config = resolve()
    expect(config.turnsSinceWrite).toBe(15)
    expect(config.turnsBetweenReminders).toBe(20)
  })

  test('partial settings keep the configured field and fall back per field', async () => {
    mockMergedSettings({ todoReminder: { turnsSinceWrite: 15 } })

    const { getTodoReminderConfig: resolve } = await getSettingsAwareAttachments()
    const config = resolve()
    expect(config.turnsSinceWrite).toBe(15)
    expect(config.turnsBetweenReminders).toBe(10)
  })

  test('partial settings combine with environment fallbacks per field', async () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '7'
    mockMergedSettings({ todoReminder: { turnsBetweenReminders: 20 } })

    const { getTodoReminderConfig: resolve } = await getSettingsAwareAttachments()
    const config = resolve()
    expect(config.turnsSinceWrite).toBe(7)
    expect(config.turnsBetweenReminders).toBe(20)
  })

  test('settings without todoReminder fall back to environment variables', async () => {
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_SINCE_WRITE = '15'
    process.env.OPENCLAUDE_TODO_REMINDER_TURNS_BETWEEN_REMINDERS = '20'
    mockMergedSettings({})

    const { getTodoReminderConfig: resolve } = await getSettingsAwareAttachments()
    const config = resolve()
    expect(config.turnsSinceWrite).toBe(15)
    expect(config.turnsBetweenReminders).toBe(20)
  })
})

describe('reminder attachment thresholds', () => {
  let configDir: string
  let wasInteractive: boolean
  let restoreConsumerEnv: () => void

  beforeEach(() => {
    wasInteractive = getIsInteractive()
    restoreConsumerEnv = snapshotEnv([
      'OPENCLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_TASK_LIST_ID',
      'CLAUDE_CODE_ENABLE_TASKS',
      'CLAUDE_CODE_DISABLE_ATTACHMENTS',
      'CLAUDE_CODE_SIMPLE',
      'USER_TYPE',
    ], { clear: true })
    configDir = mkdtempSync(join(tmpdir(), 'todo-reminder-test-'))
    process.env.OPENCLAUDE_CONFIG_DIR = configDir
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'todo-reminder-test'
  })

  afterEach(() => {
    setIsInteractive(wasInteractive)
    restoreConsumerEnv()
    rmSync(configDir, { recursive: true, force: true })
  })

  for (const [type, toolName] of [
    ['todo_reminder', 'TodoWrite'],
    ['task_reminder', 'TaskUpdate'],
  ] as const) {
    test.each([
      { field: 'turnsSinceWrite', turnsSinceWrite: 3, turnsBetweenReminders: 1, threshold: 3 },
      { field: 'turnsBetweenReminders', turnsSinceWrite: 1, turnsBetweenReminders: 4, threshold: 4 },
    ])(`${type} applies $field at its configured boundary`, async ({
      turnsSinceWrite, turnsBetweenReminders, threshold,
    }) => {
      setIsInteractive(type === 'task_reminder')
      mockMergedSettings({ todoReminder: { turnsSinceWrite, turnsBetweenReminders } })
      const { getAttachments } = await getSettingsAwareAttachments()
      let appState = getDefaultAppState()
      const messages = Array.from({ length: threshold - 1 }, () =>
        createAssistantMessage({ content: 'Working on the task' }),
      )
      const context: ToolUseContext = {
        agentId: asAgentId('todo-reminder-test'),
        abortController: new AbortController(),
        readFileState: createFileStateCacheWithSizeLimit(1),
        getAppState: () => appState,
        setAppState: updater => { appState = updater(appState) },
        setInProgressToolUseIDs: () => {},
        setResponseLength: () => {},
        updateFileHistoryState: () => {},
        updateAttributionState: () => {},
        messages,
        options: {
          commands: [],
          debug: false,
          thinkingConfig: { type: 'disabled' },
          tools: [{ name: toolName } as Tools[number]],
          verbose: false,
          mcpClients: [],
          mcpResources: {},
          isNonInteractiveSession: type === 'todo_reminder',
          agentDefinitions: { activeAgents: [], allAgents: [], allowedAgentTypes: undefined },
          mainLoopModel: 'gpt-4o',
        },
        nestedMemoryAttachmentTriggers: new Set<string>(),
        dynamicSkillDirTriggers: new Set<string>(),
      }
      const collect = async () => (await getAttachments(
        null, context, null, [], messages, 'compact', { skipSkillDiscovery: true },
      )).filter(attachment => attachment.type === type)

      expect(await collect()).toEqual([])
      messages.push(createAssistantMessage({ content: 'Continuing the task' }))
      expect(await collect()).toEqual([{ type, content: [], itemCount: 0 }])
    })
  }
})

describe('todoReminder settings schema', () => {
  const parseSettings = (settings: unknown) => SettingsSchema().safeParse(settings)

  test('degrades an invalid threshold to undefined while keeping the source valid', () => {
    const result = parseSettings({
      includeCoAuthoredBy: true,
      todoReminder: { turnsSinceWrite: 0, turnsBetweenReminders: 5 },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.includeCoAuthoredBy).toBe(true)
    expect(result.data.todoReminder?.turnsSinceWrite).toBeUndefined()
    expect(result.data.todoReminder?.turnsBetweenReminders).toBe(5)
  })

  test('degrades negative and non-integer thresholds to undefined', () => {
    for (const turnsSinceWrite of [-3, 2.5, '15']) {
      const result = parseSettings({ todoReminder: { turnsSinceWrite } })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.todoReminder?.turnsSinceWrite).toBeUndefined()
    }
  })

  test('degrades a malformed todoReminder object to undefined instead of invalidating the source', () => {
    const result = parseSettings({ includeCoAuthoredBy: true, todoReminder: 'yes' })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.includeCoAuthoredBy).toBe(true)
    expect(result.data.todoReminder).toBeUndefined()
  })

  test('preserves valid thresholds', () => {
    const result = parseSettings({
      todoReminder: { turnsSinceWrite: 15, turnsBetweenReminders: 20 },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.todoReminder).toEqual({ turnsSinceWrite: 15, turnsBetweenReminders: 20 })
  })
})
