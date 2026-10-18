import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { Message } from '../../types/message.js'
import * as realConfig from '../../utils/config.js'

const realContext = await import(
  `../../utils/context.js?real=${Date.now()}-${Math.random()}`
)
const realErrors = await import(
  `../../utils/errors.js?real=${Date.now()}-${Math.random()}`
)
const realTokens = await import(
  `../../utils/tokens.js?real=${Date.now()}-${Math.random()}`
)
const realCompact = await import(
  `./compact.js?real=${Date.now()}-${Math.random()}`
)
const realSessionMemoryCompact = await import(
  `./sessionMemoryCompact.js?real=${Date.now()}-${Math.random()}`
)

const USER_ABORT_MESSAGE = 'API Error: Request was aborted.'
let hasSharedMutationLock = false

type ImportAutoCompactOptions = {
  autoCompactEnabled?: boolean
  compactConversation?: ReturnType<typeof mock>
  trySessionMemoryCompaction?: ReturnType<typeof mock>
}

async function importAutoCompact(options: ImportAutoCompactOptions = {}) {
  // compact.test.ts uses process-global module stubs. Re-register the real
  // dependencies this standalone suite needs before importing autoCompact.
  mock.module('../../utils/context.js', () => ({ ...realContext }))
  mock.module('../../utils/errors.js', () => ({ ...realErrors }))
  mock.module('../../utils/tokens.js', () => ({ ...realTokens }))
  mock.module('../../utils/config.js', () => ({
    ...realConfig,
    getGlobalConfig: () => ({
      autoCompactEnabled: options.autoCompactEnabled ?? true,
    }),
  }))
  if (options.compactConversation) {
    mock.module('./compact.js', () => ({
      ERROR_MESSAGE_USER_ABORT: USER_ABORT_MESSAGE,
      buildPostCompactMessages: mock(() => []),
      compactConversation: options.compactConversation,
    }))
  }
  if (options.trySessionMemoryCompaction) {
    mock.module('./sessionMemoryCompact.js', () => ({
      trySessionMemoryCompaction: options.trySessionMemoryCompaction,
    }))
  }
  const nonce = `${Date.now()}-${Math.random()}`
  return import(`./autoCompact.ts?test=${nonce}`)
}

const SAVED_ENV = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_USE_GEMINI: process.env.CLAUDE_CODE_USE_GEMINI,
  CLAUDE_CODE_USE_MISTRAL: process.env.CLAUDE_CODE_USE_MISTRAL,
  CLAUDE_CODE_USE_GITHUB: process.env.CLAUDE_CODE_USE_GITHUB,
  CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
  CLAUDE_CODE_USE_VERTEX: process.env.CLAUDE_CODE_USE_VERTEX,
  CLAUDE_CODE_USE_FOUNDRY: process.env.CLAUDE_CODE_USE_FOUNDRY,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  USER_TYPE: process.env.USER_TYPE,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS:
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  CLAUDE_CODE_AUTO_COMPACT_WINDOW:
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS:
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE:
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS:
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
  DISABLE_COMPACT: process.env.DISABLE_COMPACT,
  DISABLE_AUTO_COMPACT: process.env.DISABLE_AUTO_COMPACT,
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

beforeEach(async () => {
  await acquireSharedMutationLock('services/compact/autoCompact.test.ts')
  hasSharedMutationLock = true
  try {
    delete process.env.DISABLE_COMPACT
    delete process.env.DISABLE_AUTO_COMPACT
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    delete process.env.USER_TYPE
  } catch (error) {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
    throw error
  }
})

afterEach(async () => {
  if (!hasSharedMutationLock) {
    return
  }
  try {
    mock.restore()
    restoreEnv()
    mock.module('../../utils/context.js', () => ({ ...realContext }))
    mock.module('../../utils/errors.js', () => ({ ...realErrors }))
    mock.module('../../utils/tokens.js', () => ({ ...realTokens }))
    mock.module('../../utils/config.js', () => ({ ...realConfig }))
    mock.module('./compact.js', () => ({ ...realCompact }))
    mock.module('./sessionMemoryCompact.js', () => ({
      ...realSessionMemoryCompact,
    }))
  } finally {
    releaseSharedMutationLock()
    hasSharedMutationLock = false
  }
})

function userMessage(content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: `test-${Math.random()}` as Message['uuid'],
    timestamp: new Date().toISOString(),
  }
}

function overThresholdMessages(): Message[] {
  return [userMessage('x'.repeat(100_000))]
}

function underThresholdMessages(): Message[] {
  return [userMessage('small conversation')]
}

function toolUseContext() {
  return {
    agentId: undefined,
    options: {
      mainLoopModel: 'claude-sonnet-4',
    },
  } as never
}

function cacheSafeParams(messages: Message[]) {
  const context = toolUseContext()
  return {
    systemPrompt: [],
    userContext: {},
    systemContext: {},
    toolUseContext: context,
    forkContextMessages: messages,
  } as never
}

function compactResult() {
  return {
    summaryMessages: [userMessage('summary')],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: 10_000,
    postCompactTokenCount: 100,
    truePostCompactTokenCount: 100,
  } as never
}

describe('getEffectiveContextWindowSize', () => {
  test('returns positive value for known models with large context windows', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    // claude-sonnet-4 has 200k context
    const effective = getEffectiveContextWindowSize('claude-sonnet-4')
    expect(effective).toBeGreaterThan(0)
  })

  test('never returns negative even for unknown 3P models (issue #635)', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    // Previously, unknown 3P models got 8k context → effective context was
    // 8k minus 20k summary reservation = -12k, causing infinite auto-compact.
    // Now the fallback is 128k and there's a floor, so effective is always
    // at least reservedTokensForSummary + buffer.
    //
    // The exact floor depends on the max-output-tokens slot-reservation cap
    // (tengu_otk_slot_v1 GrowthBook flag). With cap enabled, the model's
    // default output cap drops to CAPPED_DEFAULT_MAX_TOKENS (8k), so the
    // summary reservation is 8k and the floor is 8k + 13k = 21k. With cap
    // disabled it's 20k + 13k = 33k. Assert the worst case so the test is
    // stable regardless of flag state in CI vs local.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const effective = getEffectiveContextWindowSize('some-unknown-3p-model')
      expect(effective).toBeGreaterThan(0)
      // 21k = CAPPED_DEFAULT_MAX_TOKENS (8k) + AUTOCOMPACT_FLOOR_BUFFER_TOKENS (13k).
      // Covers the anti-regression intent of issue #635 without assuming
      // the GrowthBook flag state.
      expect(effective).toBeGreaterThanOrEqual(21_000)
    } finally {
      restoreEnv()
    }
  })

  test('uses MiniMax M2 context and output metadata for compact budget', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    delete process.env.CLAUDE_CODE_USE_GEMINI
    delete process.env.CLAUDE_CODE_USE_MISTRAL
    delete process.env.CLAUDE_CODE_USE_GITHUB
    delete process.env.CLAUDE_CODE_USE_BEDROCK
    delete process.env.CLAUDE_CODE_USE_VERTEX
    delete process.env.CLAUDE_CODE_USE_FOUNDRY
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    delete process.env.XAI_API_KEY
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_BASE
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_BASE_URL
    delete process.env.ANTHROPIC_MODEL
    delete process.env.USER_TYPE
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
    delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_API_KEY = 'ambient-openai-key'
    process.env.MINIMAX_API_KEY = 'minimax-test'
    process.env.OPENAI_MODEL = 'MiniMax-M2.7'

    try {
      // MiniMax's recommended Anthropic-compatible endpoint supports the full
      // M2 window. Compact reserves either the default 20k summary output
      // tokens or 8k when the slot-reservation cap flag is enabled.
      expect([184_800, 196_800]).toContain(
        getEffectiveContextWindowSize('MiniMax-M2.7'),
      )
    } finally {
      restoreEnv()
    }
  })

  test('uses explicit route runtime limits instead of ambient provider state', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_MODEL = 'gpt-4o'

    expect(getEffectiveContextWindowSize('k3-256k', {
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    })).toBe(242_144)
  })

  test('keeps internal context caps above explicit route runtime limits', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '100000'

    expect(getEffectiveContextWindowSize('k3-256k', {
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
    })).toBe(80_000)
  })

  test('keeps session context caps above explicit route runtime limits', async () => {
    const { getEffectiveContextWindowSize } = await importAutoCompact()
    realContext.setSessionContextWindowOverride('k3-256k', 150_000)

    try {
      expect(getEffectiveContextWindowSize('k3-256k', {
        contextWindow: 262_144,
        maxOutputTokens: 32_768,
      })).toBe(130_000)
    } finally {
      realContext.clearSessionContextWindowOverride('k3-256k')
    }
  })
})

describe('getAutoCompactThreshold', () => {
  test('returns positive threshold for known models', async () => {
    const { getAutoCompactThreshold } = await importAutoCompact()
    const threshold = getAutoCompactThreshold('claude-sonnet-4')
    expect(threshold).toBeGreaterThan(0)
  })

  test('never returns negative threshold even for unknown 3P models (issue #635)', async () => {
    const { getAutoCompactThreshold } = await importAutoCompact()
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    try {
      const threshold = getAutoCompactThreshold('some-unknown-3p-model')
      expect(threshold).toBeGreaterThan(0)
    } finally {
      restoreEnv()
    }
  })

  test('keeps the floor buffer for constrained context windows', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '30000'
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
    const { getAutoCompactThreshold } = await importAutoCompact()

    // The effective window is floor-raised to 33k in this configuration.
    // Selecting the 30k buffer here would compact after only 3k tokens.
    expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(20_000)
  })

  test('internal context cap keeps precedence over session override and auto-compact cap', async () => {
    process.env.USER_TYPE = 'ant'
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '200000'
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
    realContext.setSessionContextWindowOverride('claude-sonnet-4', 1_000_000)
    const { getEffectiveContextWindowSize, getAutoCompactThreshold } =
      await importAutoCompact()

    try {
      expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(80_000)
      expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
    } finally {
      realContext.clearSessionContextWindowOverride('claude-sonnet-4')
      delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    }
  })

  test('session context-window override immediately updates auto-compact threshold', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
    process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000'
    delete process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
    const { getAutoCompactThreshold, getEffectiveContextWindowSize } =
      await importAutoCompact()

    expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(50_000)
    realContext.setSessionContextWindowOverride('claude-sonnet-4', 1_000_000)

    try {
      expect(getEffectiveContextWindowSize('claude-sonnet-4')).toBe(980_000)
      expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(950_000)
    } finally {
      realContext.clearSessionContextWindowOverride('claude-sonnet-4')
    }
  })

  test('keeps compaction and warning thresholds usable across mid-sized windows', async () => {
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '64000'
    const { calculateTokenWarningState, getAutoCompactThreshold } =
      await importAutoCompact()

    // The effective window is 44k. Do not consume so much headroom that the
    // 20k warning/error buffer makes a fresh conversation immediately warn.
    expect(getAutoCompactThreshold('claude-sonnet-4')).toBe(30_000)
    expect(
      calculateTokenWarningState(0, 'claude-sonnet-4').isAboveWarningThreshold,
    ).toBe(false)
  })

  test('does not lower the threshold when a configured window grows', async () => {
    const { getAutoCompactThreshold } = await importAutoCompact()

    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '62999'
    const smallerWindowThreshold = getAutoCompactThreshold('claude-sonnet-4')
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '63000'
    const largerWindowThreshold = getAutoCompactThreshold('claude-sonnet-4')

    expect(largerWindowThreshold).toBeGreaterThanOrEqual(smallerWindowThreshold)
  })
})

describe('getAutoCompactFailureCooldownMs', () => {
  test('uses valid positive integer override above the floor', async () => {
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = ' 15000 '
    const { getAutoCompactFailureCooldownMs } = await importAutoCompact()

    expect(getAutoCompactFailureCooldownMs()).toBe(15000)
  })

  test('rejects overrides below the minimum cooldown floor', async () => {
    const {
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
      getAutoCompactFailureCooldownMs,
      MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    } = await importAutoCompact()

    // 5000 is below the 10_000ms floor — must fall back to the default
    // rather than being accepted as a valid test override.
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '5000'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )
    expect(MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS).toBe(10_000)

    // Boundary: exactly the floor value is accepted.
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '10000'
    expect(getAutoCompactFailureCooldownMs()).toBe(10_000)

    // One below the floor is rejected.
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '9999'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )
  })

  test('ignores partial or invalid override values', async () => {
    const {
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
      getAutoCompactFailureCooldownMs,
    } = await importAutoCompact()

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '5000ms'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '-1'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '1.5'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '1e3'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '0x10'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '0b10'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '+5'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )

    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '5.0'
    expect(getAutoCompactFailureCooldownMs()).toBe(
      AUTOCOMPACT_FAILURE_COOLDOWN_MS,
    )
  })
})

describe('resolveAutoCompactCircuitBreakerState', () => {
  test('skips compaction while cooldown is active', async () => {
    const {
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      resolveAutoCompactCircuitBreakerState,
    } = await importAutoCompact()

    expect(
      resolveAutoCompactCircuitBreakerState({
        tracking: {
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          nextRetryAtMs: 10_000,
        },
        nowMs: 9_000,
        cooldownMs: 5_000,
      }),
    ).toEqual({
      action: 'skip',
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      nextRetryAtMs: 10_000,
      circuitBreakerActive: true,
    })
  })

  test('allows exactly one half-open retry after cooldown expires', async () => {
    const {
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      resolveAutoCompactCircuitBreakerState,
    } = await importAutoCompact()

    expect(
      resolveAutoCompactCircuitBreakerState({
        tracking: {
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          nextRetryAtMs: 10_000,
        },
        nowMs: 10_001,
        cooldownMs: 5_000,
      }),
    ).toEqual({
      action: 'allow',
      effectiveConsecutiveFailures:
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
      wasHalfOpen: true,
    })
  })

  test('derives active cooldown from failure time when retry time is absent', async () => {
    const {
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      resolveAutoCompactCircuitBreakerState,
    } = await importAutoCompact()

    expect(
      resolveAutoCompactCircuitBreakerState({
        tracking: {
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          lastFailureAtMs: 5_000,
        },
        nowMs: 11_000,
        cooldownMs: 7_000,
      }),
    ).toEqual({
      action: 'skip',
      consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      nextRetryAtMs: 12_000,
      circuitBreakerActive: true,
    })
  })

  test.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'derives active cooldown from failure time when retry time is %s',
    async (_label, nextRetryAtMs) => {
      const {
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        resolveAutoCompactCircuitBreakerState,
      } = await importAutoCompact()

      expect(
        resolveAutoCompactCircuitBreakerState({
          tracking: {
            consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
            nextRetryAtMs,
            lastFailureAtMs: 5_000,
          },
          nowMs: 11_000,
          cooldownMs: 7_000,
        }),
      ).toEqual({
        action: 'skip',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: 12_000,
        circuitBreakerActive: true,
      })
    },
  )

  test('uses explicit retry time before deriving cooldown from failure time', async () => {
    const {
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      resolveAutoCompactCircuitBreakerState,
    } = await importAutoCompact()

    expect(
      resolveAutoCompactCircuitBreakerState({
        tracking: {
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          nextRetryAtMs: 10_000,
          lastFailureAtMs: 50_000,
        },
        nowMs: 10_001,
        cooldownMs: 7_000,
      }),
    ).toEqual({
      action: 'allow',
      effectiveConsecutiveFailures:
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
      wasHalfOpen: true,
    })
  })

  test('allows half-open retry after derived cooldown expires', async () => {
    const {
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
      resolveAutoCompactCircuitBreakerState,
    } = await importAutoCompact()

    expect(
      resolveAutoCompactCircuitBreakerState({
        tracking: {
          consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
          lastFailureAtMs: 5_000,
        },
        nowMs: 10_001,
        cooldownMs: 5_000,
      }),
    ).toEqual({
      action: 'allow',
      effectiveConsecutiveFailures:
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
      wasHalfOpen: true,
    })
  })
})

describe('autoCompactIfNeeded circuit breaker', () => {
  beforeEach(() => {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '1'
    process.env.OPENCLAUDE_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '15000'
  })

  test('trips after three non-user failures and records a retry time', async () => {
    const compactConversation = mock(async () => {
      throw new Error('provider down')
    })
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    let tracking: {
      compacted: boolean
      turnCounter: number
      turnId: string
      consecutiveFailures?: number
    } = {
      compacted: false,
      turnCounter: 0,
      turnId: 'turn',
    }
    let result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      tracking,
    )
    expect(result.consecutiveFailures).toBe(1)
    expect(result.nextRetryAtMs).toBeUndefined()

    tracking = { ...tracking, consecutiveFailures: result.consecutiveFailures }
    result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      tracking,
    )
    expect(result.consecutiveFailures).toBe(2)
    expect(result.nextRetryAtMs).toBeUndefined()

    tracking = { ...tracking, consecutiveFailures: result.consecutiveFailures }
    result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      tracking,
    )

    expect(compactConversation).toHaveBeenCalledTimes(3)
    expect(result.consecutiveFailures).toBe(
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    )
    expect(result.nextRetryAtMs).toBeGreaterThan(Date.now())
    expect(result.circuitBreakerTripped).toBe(true)
  })

  test('active cooldown skips compaction attempts', async () => {
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() + 60_000,
      },
    )

    expect(compactConversation).not.toHaveBeenCalled()
    expect(result.wasCompacted).toBe(false)
    expect(result.circuitBreakerActive).toBe(true)
    expect(result.nextRetryAtMs).toBeGreaterThan(Date.now())
  })

  test('forced compaction bypasses user-disable gates', async () => {
    process.env.DISABLE_COMPACT = '1'
    process.env.DISABLE_AUTO_COMPACT = '1'
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const { autoCompactIfNeeded } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = underThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        forceReason: 'message-count',
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveFailures).toBe(0)
  })

  test('memory-pressure signals honor disabled auto-compact', async () => {
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const { autoCompactIfNeeded } = await importAutoCompact({
      autoCompactEnabled: false,
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = underThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        forceReason: 'memory-pressure',
      },
    )

    expect(compactConversation).not.toHaveBeenCalled()
    expect(result.wasCompacted).toBe(false)
  })

  test('provider context-overflow recovery bypasses disabled auto-compact', async () => {
    process.env.DISABLE_COMPACT = '1'
    process.env.DISABLE_AUTO_COMPACT = '1'
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const { autoCompactIfNeeded } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = underThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        forceReason: 'context-overflow',
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.wasCompacted).toBe(true)
  })

  test('expired cooldown allows a half-open compaction attempt', async () => {
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() - 1,
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveFailures).toBe(0)
    expect(result.nextRetryAtMs).toBeUndefined()
  })

  test('half-open failure immediately re-trips instead of growing unbounded', async () => {
    const compactConversation = mock(async () => {
      throw new Error('still broken')
    })
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() - 1,
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.consecutiveFailures).toBe(
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    )
    expect(result.nextRetryAtMs).toBeGreaterThan(Date.now())
    expect(result.circuitBreakerTripped).toBe(true)
  })

  test('failed compaction cooldown starts at failure time, not attempt start', async () => {
    let nowMs = 100_000
    const originalDateNow = Date.now
    Date.now = mock(() => nowMs) as never
    try {
      const compactConversation = mock(async () => {
        nowMs = 106_000
        throw new Error('slow provider failure')
      })
      const trySessionMemoryCompaction = mock(async () => null)
      const { autoCompactIfNeeded } = await importAutoCompact({
        compactConversation,
        trySessionMemoryCompaction,
      })

      const messages = overThresholdMessages()
      const result = await autoCompactIfNeeded(
        messages,
        toolUseContext(),
        cacheSafeParams(messages),
        'repl_main_thread',
        {
          compacted: false,
          turnCounter: 0,
          turnId: 'turn',
          consecutiveFailures: 2,
        },
      )

      expect(result.lastFailureAtMs).toBe(106_000)
      expect(result.nextRetryAtMs).toBe(121_000)
    } finally {
      Date.now = originalDateNow
    }
  })

  test('user abort does not increment failures or trip cooldown', async () => {
    const compactConversation = mock(async () => {
      throw new Error(USER_ABORT_MESSAGE)
    })
    const trySessionMemoryCompaction = mock(async () => null)
    const { autoCompactIfNeeded } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: 2,
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.consecutiveFailures).toBe(2)
    expect(result.nextRetryAtMs).toBeUndefined()
    expect(result.circuitBreakerTripped).toBe(false)
  })

  test('user abort during half-open retry clears expired cooldown without retripping', async () => {
    const compactConversation = mock(async () => {
      throw new Error(USER_ABORT_MESSAGE)
    })
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = overThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() - 1,
      },
    )

    expect(compactConversation).toHaveBeenCalledTimes(1)
    expect(result.consecutiveFailures).toBe(
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
    )
    expect(result.nextRetryAtMs).toBeUndefined()
    expect(result.circuitBreakerActive).toBe(false)
    expect(result.circuitBreakerTripped).toBe(false)
  })

  test('below-threshold conversations clear stale breaker state', async () => {
    const compactConversation = mock(async () => compactResult())
    const trySessionMemoryCompaction = mock(async () => null)
    const {
      autoCompactIfNeeded,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    } = await importAutoCompact({
      compactConversation,
      trySessionMemoryCompaction,
    })

    const messages = underThresholdMessages()
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext(),
      cacheSafeParams(messages),
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn',
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() + 60_000,
      },
    )

    expect(compactConversation).not.toHaveBeenCalled()
    expect(result.wasCompacted).toBe(false)
    expect(result.circuitBreakerActive).toBe(false)
    expect(result.consecutiveFailures).toBe(0)
    expect(result.nextRetryAtMs).toBeUndefined()
  })
})
