import { expect, test } from 'bun:test'
import { accumulateUsage, updateUsage } from './claude.js'
import { EMPTY_USAGE } from './emptyUsage.js'
import type { BetaFallbackCreditUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

test('stream usage preserves fallback-credit outcomes across cumulative updates and legacy events', () => {
  const redeemed: BetaFallbackCreditUsage = { status: { type: 'redeemed' } }
  const declined: BetaFallbackCreditUsage = {
    status: { type: 'not_applied', reason: 'expired' },
  }
  const start = updateUsage(EMPTY_USAGE, {
    ...EMPTY_USAGE, output_tokens: 4, fallback_credit: redeemed,
  })
  expect(EMPTY_USAGE.fallback_credit).toBeNull()
  expect(start.fallback_credit).toEqual(redeemed)
  const delta = updateUsage(start, {
    ...EMPTY_USAGE, output_tokens: 7, fallback_credit: null,
  })
  expect(delta.fallback_credit).toEqual(redeemed)
  const { fallback_credit: _credit, ...legacy } = { ...EMPTY_USAGE, output_tokens: 8 }
  expect(updateUsage(delta, legacy as typeof EMPTY_USAGE).fallback_credit).toEqual(redeemed)
  expect(updateUsage(delta, {
    ...EMPTY_USAGE, output_tokens: 9, fallback_credit: declined,
  }).fallback_credit).toEqual(declined)
  expect(delta.output_tokens).toBe(7)
})

test('turn accumulation keeps the latest fallback-credit metadata without changing billed tokens', () => {
  const first = { ...EMPTY_USAGE, output_tokens: 7, fallback_credit: { status: { type: 'redeemed' as const } } }
  const second = { ...EMPTY_USAGE, output_tokens: 4 }
  const total = accumulateUsage(first, second)
  expect(total.fallback_credit).toBeNull()
  expect(total.output_tokens).toBe(11)
  expect(accumulateUsage(second, first).fallback_credit).toEqual(first.fallback_credit)
})

test('stream usage preserves cumulative thinking details through null and legacy updates', () => {
  const start = updateUsage(EMPTY_USAGE, {
    ...EMPTY_USAGE,
    input_tokens: 10,
    output_tokens: 4,
    output_tokens_details: { thinking_tokens: 3 },
  })
  const delta = updateUsage(start, {
    ...EMPTY_USAGE,
    output_tokens: 9,
    output_tokens_details: { thinking_tokens: 6 },
  })
  expect(delta.output_tokens_details).toEqual({ thinking_tokens: 6 })
  expect(delta.output_tokens).toBe(9)
  expect(delta.input_tokens).toBe(10)

  const nullable = { ...EMPTY_USAGE, output_tokens: 10, output_tokens_details: null }
  expect(updateUsage(delta, nullable).output_tokens_details).toEqual({ thinking_tokens: 6 })
  const { output_tokens_details: _details, ...legacy } = nullable
  expect(updateUsage(delta, legacy as typeof nullable).output_tokens_details).toEqual({ thinking_tokens: 6 })
  expect(updateUsage(delta, undefined)).toEqual(delta)
  expect(updateUsage(delta, {
    ...nullable,
    output_tokens_details: { thinking_tokens: 0 },
  }).output_tokens_details).toEqual({ thinking_tokens: 0 })
})

test('turn accumulation sums thinking details without adding them to billed output', () => {
  const first = updateUsage(EMPTY_USAGE, {
    ...EMPTY_USAGE,
    output_tokens: 9,
    output_tokens_details: { thinking_tokens: 6 },
  })
  const second = updateUsage(EMPTY_USAGE, {
    ...EMPTY_USAGE,
    output_tokens: 5,
    output_tokens_details: { thinking_tokens: 2 },
  })
  const total = accumulateUsage(accumulateUsage(EMPTY_USAGE, first), second)
  expect(total.output_tokens_details).toEqual({ thinking_tokens: 8 })
  expect(total.output_tokens).toBe(14)
  expect(EMPTY_USAGE.output_tokens_details).toEqual({ thinking_tokens: 0 })
})
