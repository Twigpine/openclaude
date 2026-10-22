import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mcpContentNeedsTruncation, truncateMcpContent } from './mcpValidation.js'

const nonce = `${Date.now()}-${Math.random()}`
const realGrowthbook = {
  ...await import(`../services/analytics/growthbook.js?real=${nonce}`),
} as typeof import('../services/analytics/growthbook.js')
const realTokenEstimation = {
  ...await import(`../services/tokenEstimation.js?real=${nonce}`),
} as typeof import('../services/tokenEstimation.js')
const realImageResizer = {
  ...await import(`./imageResizer.js?real=${nonce}`),
} as typeof import('./imageResizer.js')
const realLog = {
  ...await import(`./log.js?real=${nonce}`),
} as typeof import('./log.js')

// 60_000-char inputs: real roughTokenCountEstimation returns 15_000, which exceeds
// DEFAULT_MAX_MCP_OUTPUT_TOKENS * MCP_TOKEN_COUNT_THRESHOLD_FACTOR (25_000 * 0.5 = 12_500),
// so the threshold-check is bypassed and countMessagesTokensWithAPI is exercised —
// without mocking roughTokenCountEstimation. This prevents leakage into autoCompact
// tests that rely on the real rough-count to determine the compaction threshold.
const tokenState = {
  apiReturn: null as number | null,
}

function applyMocks() {
  mock.module('../services/analytics/growthbook.js', () => ({
    // Only intercept the mcpValidation flag (tengu_satin_quoll); return defaultValue
    // for all other flags so this mock does not affect unrelated test files.
    getFeatureValue_CACHED_MAY_BE_STALE: (flag: string, defaultValue: unknown) =>
      flag === 'tengu_satin_quoll' ? null : defaultValue,
  }))
  mock.module('../services/tokenEstimation.js', () => ({
    // Spread the real module so roughTokenCountEstimation is never replaced.
    // Only countMessagesTokensWithAPI is controlled per-test via tokenState.
    ...realTokenEstimation,
    countMessagesTokensWithAPI: async () => tokenState.apiReturn,
  }))
  mock.module('./imageResizer.js', () => ({
    compressImageBlock: async (block: unknown) => block,
  }))
  mock.module('./log.js', () => ({ logError: () => {} }))
}

function restoreMocks() {
  mock.restore()
  mock.module('../services/analytics/growthbook.js', () => realGrowthbook)
  mock.module('../services/tokenEstimation.js', () => realTokenEstimation)
  mock.module('./imageResizer.js', () => realImageResizer)
  mock.module('./log.js', () => realLog)
}

// ---------- SEC-04: fail-closed on null ----------

describe('mcpContentNeedsTruncation — SEC-04 fail-closed on null', () => {
  beforeEach(() => {
    applyMocks()
    tokenState.apiReturn = null
    process.env.MAX_MCP_OUTPUT_TOKENS = ''
  })

  afterEach(() => {
    restoreMocks()
    tokenState.apiReturn = null
    process.env.MAX_MCP_OUTPUT_TOKENS = ''
  })

  test('null token count returns true (fail-closed)', async () => {
    tokenState.apiReturn = null
    expect(await mcpContentNeedsTruncation('x'.repeat(60_000))).toBe(true)
  })

  test('token count below limit returns false', async () => {
    tokenState.apiReturn = 1000
    expect(await mcpContentNeedsTruncation('x'.repeat(60_000))).toBe(false)
  })

  test('token count above limit returns true', async () => {
    tokenState.apiReturn = 26000
    expect(await mcpContentNeedsTruncation('x'.repeat(60_000))).toBe(true)
  })

  test('token count exactly at limit returns false', async () => {
    tokenState.apiReturn = 25000
    expect(await mcpContentNeedsTruncation('x'.repeat(60_000))).toBe(false)
  })
})

// ---------- SEC-05: output stays within budget ----------

describe('truncateMcpContent — SEC-05 budget invariant', () => {
  beforeEach(() => {
    applyMocks()
    process.env.MAX_MCP_OUTPUT_TOKENS = ''
  })

  afterEach(() => {
    restoreMocks()
    process.env.MAX_MCP_OUTPUT_TOKENS = ''
  })

  test('string result does not exceed maxChars when notice exceeds budget', async () => {
    // MAX_MCP_OUTPUT_TOKENS=1 → maxChars=4; notice is ~200 chars → exceeds budget.
    // Before the fix: budget=0, result = '' + notice (overflow). After: sliced to maxChars.
    process.env.MAX_MCP_OUTPUT_TOKENS = '1'
    const result = await truncateMcpContent('x'.repeat(60_000))
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeLessThanOrEqual(4)
  })

  test('block result total chars do not exceed maxChars when notice exceeds budget', async () => {
    process.env.MAX_MCP_OUTPUT_TOKENS = '1'
    const result = await truncateMcpContent([
      { type: 'text', text: 'x'.repeat(60_000) },
    ] as Parameters<typeof truncateMcpContent>[0])
    expect(Array.isArray(result)).toBe(true)
    const totalChars = (result as Array<{ type: string; text?: string }>).reduce(
      (sum, b) => sum + (b.text?.length ?? 0),
      0,
    )
    expect(totalChars).toBeLessThanOrEqual(4)
  })

  test('string result within standard budget includes notice', async () => {
    // Default MAX_MCP_OUTPUT_TOKENS=25000 → maxChars=100000.
    // 60000-char content + notice << 100000 → content is preserved intact.
    const result = await truncateMcpContent('x'.repeat(60_000))
    expect(typeof result).toBe('string')
    expect((result as string).length).toBeLessThanOrEqual(25000 * 4)
    expect(result as string).toContain('[OUTPUT TRUNCATED')
  })
})
