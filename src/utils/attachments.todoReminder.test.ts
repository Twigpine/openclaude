import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { getTodoReminderConfig } from './attachments.js'

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

beforeEach(async () => {
  await acquireSharedMutationLock('utils/attachments.todoReminder.test.ts')
  clearTestEnv()
})

afterEach(() => {
  try {
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
})