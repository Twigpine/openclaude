import { afterEach, describe, expect, test } from 'bun:test'
import {
  capHistory,
  createDuoState,
  DUO_MAX_ROUNDS,
  MAX_HISTORY_MESSAGES,
} from './types.js'

const ENV_KEYS = ['DUO_BACKEND', 'DUO_ROUNDS', 'DUO_PROTOCOL', 'DUO_APPROVE', 'DUO_AUTO_SKILL', 'DUO_MODEL_A', 'DUO_MODEL_B'] as const

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

describe('capHistory', () => {
  test('keeps the newest messages within the bound', () => {
    const many = Array.from({ length: 20 }, (_, i) => `m${i}`)
    const capped = capHistory(many, ['new1', 'new2'])
    expect(capped.length).toBe(MAX_HISTORY_MESSAGES)
    expect(capped[capped.length - 1]).toBe('new2')
    expect(capped).toContain('m10') // 22 merged − 12 kept = oldest 10 dropped
    expect(capped).not.toContain('m9')
  })

  test('appends without a copy when under the bound', () => {
    expect(capHistory(['a'], ['b'])).toEqual(['a', 'b'])
    expect(capHistory([], ['a'])).toEqual(['a'])
  })
})

describe('createDuoState', () => {
  test('safe defaults (conversation only)', () => {
    const st = createDuoState()
    expect(st.backend).toBe('builtin')
    expect(st.rounds).toBe(1)
    expect(st.protocol).toBe(false)
    expect(st.approve).toBe(false)
    expect(st.autoSkill).toBe(true)
    expect(st.ocSession).toBeNull()
    expect(st.clTranscript).toEqual([])
  })

  test('auto skill routing can be disabled from the env', () => {
    process.env.DUO_AUTO_SKILL = 'off'
    expect(createDuoState().autoSkill).toBe(false)
    process.env.DUO_AUTO_SKILL = '0'
    expect(createDuoState().autoSkill).toBe(false)
  })

  test('env overrides the backend and flags', () => {
    process.env.DUO_BACKEND = 'cli'
    process.env.DUO_PROTOCOL = '1'
    process.env.DUO_APPROVE = 'on'
    const st = createDuoState()
    expect(st.backend).toBe('cli')
    expect(st.protocol).toBe(true)
    expect(st.approve).toBe(true)
  })

  test('rounds env is clamped to the allowed range', () => {
    process.env.DUO_ROUNDS = '3'
    expect(createDuoState().rounds).toBe(3)
    process.env.DUO_ROUNDS = String(DUO_MAX_ROUNDS + 5)
    expect(createDuoState().rounds).toBe(1) // invalid → fallback
    process.env.DUO_ROUNDS = 'not-a-number'
    expect(createDuoState().rounds).toBe(1)
  })

  test('models can be pinned from the env (headless runs)', () => {
    process.env.DUO_MODEL_A = 'opencode/space-bunny-free'
    process.env.DUO_MODEL_B = 'cline-free/muse-spark-1.3-contributor'
    const st = createDuoState()
    expect(st.modelA).toBe('opencode/space-bunny-free')
    expect(st.modelB).toBe('cline-free/muse-spark-1.3-contributor')
  })

  test('invalid backend falls back to builtin', () => {
    process.env.DUO_BACKEND = 'nonsense'
    expect(createDuoState().backend).toBe('builtin')
  })
})