/**
 * Coverage for the /cost token-bar output added in PR #1610.
 *
 * Reviewer (P2) asked for a small formatter test for the new token
 * bar display so it does not regress silently. formatTotalCost() pulls
 * live state from bootstrap/state.js, so we drive it through the real
 * addToTotalSessionCost path with the shared-mutation lock, then strip
 * ANSI and assert on the structural shape (header, per-bucket rows,
 * alignment, cache-row gating).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  addToTotalLinesChanged,
  resetStateForTests,
} from './bootstrap/state.js'
import { formatTotalCost, resetCostState } from './cost-tracker.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'

// BetaUsage-compatible shape — minimum fields addToTotalSessionCost
// needs to run without throwing.
function anthropicUsage(partial: {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}): Parameters<typeof import('./cost-tracker.js').addToTotalSessionCost>[1] {
  return {
    input_tokens: partial.input ?? 0,
    output_tokens: partial.output ?? 0,
    cache_read_input_tokens: partial.cacheRead ?? 0,
    cache_creation_input_tokens: partial.cacheCreation ?? 0,
  } as Parameters<
    typeof import('./cost-tracker.js').addToTotalSessionCost
  >[1]
}

beforeEach(async () => {
  await acquireSharedMutationLock('cost-tracker.format.test.ts')
  resetStateForTests()
  resetCostState()
})

afterEach(() => {
  try {
    resetStateForTests()
    resetCostState()
  } finally {
    releaseSharedMutationLock()
  }
})

// Strip ANSI escape codes so assertions are stable across terminal
// emulators and CI runners.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

describe('formatTotalCost — token bar output (PR #1610)', () => {
  test('omits the Token usage section when no tokens have been recorded', () => {
    const out = stripAnsi(formatTotalCost())
    expect(out).not.toContain('Token usage:')
  })

  test('renders Input/Output bars and the Token usage header when tokens exist', () => {
    // Seed input + output through the real session-cost path.
    // addToTotalSessionCost is a regular re-export from this module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addToTotalSessionCost } =
      require('./cost-tracker.js') as typeof import('./cost-tracker.js')
    addToTotalSessionCost(
      0,
      anthropicUsage({ input: 1000, output: 200 }),
      'claude-sonnet-4',
    )

    const out = stripAnsi(formatTotalCost())

    expect(out).toContain('Token usage:')
    expect(out).toContain('Input tokens')
    expect(out).toContain('Output tokens')

    // Bar characters: 20-wide, ratio = 1.0 for input (max), 0.2 for output
    expect(out).toContain('█'.repeat(20) + '░'.repeat(0))
    expect(out).toContain('█'.repeat(4) + '░'.repeat(16))
  })

  test('gates cache read / cache write rows on non-zero values', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addToTotalSessionCost } =
      require('./cost-tracker.js') as typeof import('./cost-tracker.js')
    // No cache read or cache write — neither row should appear.
    addToTotalSessionCost(
      0,
      anthropicUsage({ input: 500, output: 100 }),
      'claude-sonnet-4',
    )
    const outNoCache = stripAnsi(formatTotalCost())
    expect(outNoCache).not.toContain('Cache read')
    expect(outNoCache).not.toContain('Cache write')

    // Reset and re-seed with cache fields populated.
    resetStateForTests()
    resetCostState()
    addToTotalSessionCost(
      0,
      anthropicUsage({
        input: 500,
        output: 100,
        cacheRead: 250,
        cacheCreation: 75,
      }),
      'claude-sonnet-4',
    )
    const outWithCache = stripAnsi(formatTotalCost())
    expect(outWithCache).toContain('Cache read')
    expect(outWithCache).toContain('Cache write')
  })

  test('formats token counts using formatNumber (compact notation for ≥1000)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addToTotalSessionCost } =
      require('./cost-tracker.js') as typeof import('./cost-tracker.js')
    // 12,345 input tokens → formatNumber() renders compact as "12.3k".
    // 67 output tokens stay as "67" (below the 1000 compact-notation threshold).
    addToTotalSessionCost(
      0,
      anthropicUsage({ input: 12_345, output: 67 }),
      'claude-sonnet-4',
    )
    const out = stripAnsi(formatTotalCost())
    expect(out).toContain('12.3k')
    // Output row keeps the raw count — not compact-formatted.
    expect(out).toMatch(/Output tokens[^\n]*67/)
  })

  test('keeps the legacy Total cost / Total duration / Total code changes block', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { addToTotalSessionCost } =
      require('./cost-tracker.js') as typeof import('./cost-tracker.js')
    addToTotalSessionCost(
      0,
      anthropicUsage({ input: 100, output: 50 }),
      'claude-sonnet-4',
    )
    addToTotalLinesChanged(7, 3)

    const out = stripAnsi(formatTotalCost())
    expect(out).toMatch(/Total cost:/)
    expect(out).toMatch(/Total duration \(API\):/)
    expect(out).toMatch(/Total duration \(wall\):/)
    expect(out).toMatch(/7 lines added, 3 lines removed/)
  })

  // A custom-provider model id can be an arbitrary string. `formatModelUsage`
  // accumulates into a per-short-name map; on a plain object an id that
  // canonicalizes to `__proto__` / `constructor` reads an inherited
  // Object.prototype member, skips initialization, and mutates it -- for
  // `__proto__` that lands on Object.prototype process-wide -- while dropping the
  // model from the breakdown. Drive the real addToTotalSessionCost -> /cost path.
  test('aggregates prototype-member model ids without polluting Object.prototype', async () => {
    const { addToTotalSessionCost } = await import('./cost-tracker.js')
    // Snapshot any pre-existing descriptors so cleanup restores shared
    // Object.prototype state exactly instead of blindly deleting keys that
    // another module may legitimately own.
    const guardedKeys = [
      'inputTokens',
      'outputTokens',
      'cacheReadInputTokens',
      'cacheCreationInputTokens',
      'webSearchRequests',
      'costUSD',
    ]
    const savedDescriptors = new Map(
      guardedKeys.map(k => [
        k,
        Object.getOwnPropertyDescriptor(Object.prototype, k),
      ]),
    )
    try {
      addToTotalSessionCost(1, anthropicUsage({ input: 1000, output: 500 }), '__proto__')
      addToTotalSessionCost(1, anthropicUsage({ input: 2000, output: 800 }), 'constructor')

      const out = stripAnsi(formatTotalCost())

      // No global prototype pollution from the `__proto__` accumulator write.
      expect(
        (Object.prototype as Record<string, unknown>).inputTokens,
      ).toBeUndefined()
      // Both ids appear in the per-model breakdown instead of being dropped.
      expect(out).toContain('__proto__:')
      expect(out).toContain('constructor:')
    } finally {
      // Belt-and-suspenders: if a regression polluted the prototype, restore the
      // saved descriptor (or delete keys that were originally absent) so this
      // suite cannot corrupt others sharing the process.
      for (const [k, descriptor] of savedDescriptors) {
        if (descriptor) {
          Object.defineProperty(Object.prototype, k, descriptor)
        } else {
          delete (Object.prototype as Record<string, unknown>)[k]
        }
      }
    }
  })
})
