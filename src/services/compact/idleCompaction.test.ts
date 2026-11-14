import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { saveGlobalConfig } from '../../utils/config.js'
import {
  getIdleCompactionMinTokens,
  isIdleCompactionEnabled,
  shouldArmIdleCompaction,
} from './idleCompaction.js'

describe('idle compaction gating', () => {
  afterEach(() => {
    saveGlobalConfig(current => ({ ...current, idleCompaction: true }))
    delete process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS
    delete process.env.DISABLE_COMPACT
  })

  test('min tokens defaults to 200k and honors a valid env override', () => {
    expect(getIdleCompactionMinTokens()).toBe(200_000)
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '50000'
    expect(getIdleCompactionMinTokens()).toBe(50_000)
  })

  test('invalid, zero, and negative env values fall back to the default', () => {
    for (const bad of ['abc', '0', '-5', '']) {
      process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = bad
      expect(getIdleCompactionMinTokens()).toBe(200_000)
    }
  })

  test('enabled by default; disabled by config or DISABLE_COMPACT', () => {
    expect(isIdleCompactionEnabled()).toBe(true)
    saveGlobalConfig(current => ({ ...current, idleCompaction: false }))
    expect(isIdleCompactionEnabled()).toBe(false)
    saveGlobalConfig(current => ({ ...current, idleCompaction: true }))
    process.env.DISABLE_COMPACT = '1'
    expect(isIdleCompactionEnabled()).toBe(false)
  })

  test('does not arm below the token minimum', () => {
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 199_999,
        compactedAtTokenEstimate: null,
      }),
    ).toBe(false)
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 200_000,
        compactedAtTokenEstimate: null,
      }),
    ).toBe(true)
  })

  test('does not arm when disabled', () => {
    saveGlobalConfig(current => ({ ...current, idleCompaction: false }))
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 500_000,
        compactedAtTokenEstimate: null,
      }),
    ).toBe(false)
  })

  test('env override changes the arm threshold', () => {
    process.env.CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS = '1000'
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 1_500,
        compactedAtTokenEstimate: null,
      }),
    ).toBe(true)
  })

  test('a session already compacted at its current size does not re-arm', () => {
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 250_000,
        compactedAtTokenEstimate: 250_000,
      }),
    ).toBe(false)
    expect(
      shouldArmIdleCompaction({
        tokenEstimate: 260_000,
        compactedAtTokenEstimate: 250_000,
      }),
    ).toBe(true)
  })
})

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}

const testContext = {
  abortController: new AbortController(),
} as unknown as ToolUseContext

type IdleCompactionMocks = {
  compactConversation: ReturnType<typeof mock>
  buildPostCompactMessages: ReturnType<typeof mock>
  getCacheSafeParams: ReturnType<typeof mock>
  suppressCompactWarning: ReturnType<typeof mock>
  setLastSummarizedMessageId: ReturnType<typeof mock>
  runPostCompactCleanup: ReturnType<typeof mock>
  cacheClear: ReturnType<typeof mock>
}

async function importIdleCompaction(): Promise<{
  module: typeof import('./idleCompaction.js')
  mocks: IdleCompactionMocks
}> {
  const mocks: IdleCompactionMocks = {
    compactConversation: mock(async () => ({})),
    buildPostCompactMessages: mock((result: unknown) => [
      result,
    ] as unknown as Message[]),
    getCacheSafeParams: mock(async () => ({})),
    suppressCompactWarning: mock(() => {}),
    setLastSummarizedMessageId: mock(() => {}),
    runPostCompactCleanup: mock(() => {}),
    cacheClear: mock(() => {}),
  }
  mock.module('./compact.js', () => ({
    compactConversation: mocks.compactConversation,
    buildPostCompactMessages: mocks.buildPostCompactMessages,
  }))
  mock.module('./getCacheSafeParams.js', () => ({
    getCacheSafeParams: mocks.getCacheSafeParams,
  }))
  mock.module('./compactWarningState.js', () => ({
    suppressCompactWarning: mocks.suppressCompactWarning,
  }))
  mock.module('./postCompactCleanup.js', () => ({
    runPostCompactCleanup: mocks.runPostCompactCleanup,
  }))
  mock.module('../SessionMemory/sessionMemoryUtils.js', () => ({
    setLastSummarizedMessageId: mocks.setLastSummarizedMessageId,
  }))
  const getUserContext = Object.assign(() => ({}), {
    cache: { clear: mocks.cacheClear },
  })
  mock.module('../../context.js', () => ({ getUserContext }))
  const nonce = `${Date.now()}-${Math.random()}`
  const module = await import(`./idleCompaction.ts?test=${nonce}`)
  return { module, mocks }
}

describe('runIdleCompaction', () => {
  afterEach(() => {
    saveGlobalConfig(current => ({ ...current, idleCompaction: true }))
    delete process.env.DISABLE_COMPACT
  })

  test('returns null without compacting when disabled', async () => {
    saveGlobalConfig(current => ({ ...current, idleCompaction: false }))
    const { module, mocks } = await importIdleCompaction()
    const result = await module.runIdleCompaction(
      [userMessage('hello')],
      testContext,
    )
    expect(result).toBeNull()
    expect(mocks.compactConversation).not.toHaveBeenCalled()
  })

  test('returns null without compacting for an empty conversation', async () => {
    const { module, mocks } = await importIdleCompaction()
    const result = await module.runIdleCompaction([], testContext)
    expect(result).toBeNull()
    expect(mocks.compactConversation).not.toHaveBeenCalled()
  })

  test('compacts and runs post-compact side effects on success', async () => {
    const { module, mocks } = await importIdleCompaction()
    const messages = [userMessage('a long conversation')]
    const result = await module.runIdleCompaction(messages, testContext)
    expect(result).toHaveLength(1)
    expect(mocks.compactConversation).toHaveBeenCalledTimes(1)
    expect(mocks.compactConversation).toHaveBeenCalledWith(
      messages,
      testContext,
      {},
      false,
      undefined,
      true,
    )
    expect(mocks.getCacheSafeParams).toHaveBeenCalledWith(
      testContext,
      messages,
    )
    expect(mocks.setLastSummarizedMessageId).toHaveBeenCalledWith(undefined)
    expect(mocks.suppressCompactWarning).toHaveBeenCalled()
    expect(mocks.cacheClear).toHaveBeenCalled()
    expect(mocks.runPostCompactCleanup).toHaveBeenCalled()
  })
})
