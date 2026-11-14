import { afterEach, describe, expect, test } from 'bun:test'
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
