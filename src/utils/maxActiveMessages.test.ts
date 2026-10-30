import { afterEach, expect, test } from 'bun:test'

import {
  getMaxActiveMessagesHardCap,
  getMessageCountCompactionTrigger,
  isAboveMaxActiveMessagesLimit,
  resolveMaxActiveMessagesLimit,
  resolveMessageCountCompactionLimit,
  shouldCompactActiveMessageHistory,
} from './maxActiveMessages.js'

const SAVED_ENV = {
  OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP:
    process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP,
}

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

test('invalid hard cap override falls back to the default safety cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '100O'

  expect(getMaxActiveMessagesHardCap()).toBe(1000)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(true)
})

test('explicit zero hard cap disables only the hard cap', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'

  expect(getMaxActiveMessagesHardCap()).toBe(0)
  expect(isAboveMaxActiveMessagesLimit(1001)).toBe(false)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(resolveMaxActiveMessagesLimit('off', '5')).toBe(5)
  expect(resolveMaxActiveMessagesLimit(undefined, '5')).toBe(5)
})

test('configured and hard cap combine by choosing the tighter positive limit', () => {
  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '500'

  expect(resolveMaxActiveMessagesLimit('1000', undefined)).toBe(500)
  expect(resolveMaxActiveMessagesLimit('100', undefined)).toBe(100)
  expect(isAboveMaxActiveMessagesLimit(501)).toBe(true)
  expect(isAboveMaxActiveMessagesLimit(500)).toBe(false)
})

test('teammate transcript compaction triggers on message count before token pressure', () => {
  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1001,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(true)

  expect(
    shouldCompactActiveMessageHistory({
      messageCount: 1000,
      tokenCount: 10,
      tokenThreshold: 100_000,
      activeMessageLimit: 1000,
    }),
  ).toBe(false)
})

test('message-count compaction trigger follows the query-loop setting semantics', () => {
  delete process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP
  const trigger = (
    setting: string | undefined,
    legacyEnv: string | undefined,
    autoCompactEnabled: boolean,
  ) =>
    getMessageCountCompactionTrigger(
      resolveMessageCountCompactionLimit(setting, legacyEnv),
      autoCompactEnabled,
    )

  // Unset setting uses the 200-message default; the legacy env var wins.
  expect(trigger(undefined, undefined, true)).toBe(200)
  expect(trigger(undefined, '50', true)).toBe(50)
  // An explicit setting beats the legacy env var and survives auto-compact off.
  expect(trigger('500', '50', true)).toBe(500)
  expect(trigger('100', undefined, false)).toBe(100)
  // Without an explicit limit, auto-compact off leaves only the hard cap.
  expect(trigger(undefined, undefined, false)).toBe(1000)
  expect(trigger('off', undefined, true)).toBe(1000)
  expect(trigger('off', '50', false)).toBe(50)
  // Invalid persisted values normalize to the default without counting as explicit.
  expect(trigger('7', undefined, true)).toBe(200)
  expect(trigger('7', undefined, false)).toBe(1000)

  process.env.OPENCLAUDE_MAX_ACTIVE_MESSAGES_HARD_CAP = '0'
  expect(trigger(undefined, undefined, false)).toBe(0)
  expect(trigger('off', undefined, true)).toBe(0)
  expect(trigger('100', undefined, false)).toBe(100)
})
