import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getDisplayedEffortLevel, getEffortSuffix } from './effort.js'

// ultracode is a meta-mode (the standing multi-agent permission). The display
// surfaces show it as the current level when it is the EFFECTIVE effort —
// CLAUDE_CODE_EFFORT_LEVEL takes precedence over the session value (matching the
// API and the permission gate), so the display follows that precedence too.
// @see #1551
const MODEL = 'claude-opus-4-8'
const FIRST_PARTY_CONTEXT = { apiProvider: 'firstParty' as const }
const OPENAI_CONTEXT = {
  apiProvider: 'openai' as const,
  supportsCodexReasoningEffort: () => true,
}
const ENV_VARS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED',
  'CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'OPENAI_API_KEY',
  'OPENAI_API_KEYS',
  'GEMINI_API_KEY',
  'MISTRAL_API_KEY',
  'LONGCAT_API_KEY',
  'MINIMAX_API_KEY',
  'NVIDIA_NIM',
  'NVIDIA_API_KEY',
  'XAI_API_KEY',
  'VENICE_API_KEY',
  'MIMO_API_KEY',
  'OPENGATEWAY_API_KEY',
  'OPENCODE_API_KEY',
  'HICAP_API_KEY',
  'NEARAI_API_KEY',
]
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_VARS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = savedEnv[key]
    }
  }
})

describe('ultracode display surfaces', () => {
  test('getDisplayedEffortLevel surfaces ultracode (not its xhigh mapping)', () => {
    expect(getDisplayedEffortLevel(MODEL, 'ultracode', FIRST_PARTY_CONTEXT)).toBe(
      'ultracode',
    )
  })

  test('getEffortSuffix surfaces ultracode while it is active', () => {
    expect(getEffortSuffix(MODEL, 'ultracode', FIRST_PARTY_CONTEXT)).toBe(
      ' with ultracode effort',
    )
  })

  test('a conflicting CLAUDE_CODE_EFFORT_LEVEL override wins over session ultracode', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'high'
    expect(getDisplayedEffortLevel(MODEL, 'ultracode', FIRST_PARTY_CONTEXT)).toBe(
      'high',
    )
    expect(getEffortSuffix(MODEL, 'ultracode', FIRST_PARTY_CONTEXT)).toBe(
      ' with high effort',
    )
  })

  test('CLAUDE_CODE_EFFORT_LEVEL=ultracode surfaces ultracode even if the session differs', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'ultracode'
    expect(getDisplayedEffortLevel(MODEL, 'high', FIRST_PARTY_CONTEXT)).toBe(
      'ultracode',
    )
    expect(getEffortSuffix(MODEL, 'high', FIRST_PARTY_CONTEXT)).toBe(
      ' with ultracode effort',
    )
  })

  test('CLAUDE_CODE_EFFORT_LEVEL=ultracode clamps display on unsupported first-party models', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'ultracode'
    expect(
      getDisplayedEffortLevel(
        'claude-sonnet-4-6',
        'high',
        FIRST_PARTY_CONTEXT,
      ),
    ).toBe('high')
    expect(getEffortSuffix('claude-sonnet-4-6', 'high', FIRST_PARTY_CONTEXT)).toBe(
      ' with high effort',
    )
  })

  test('CLAUDE_CODE_EFFORT_LEVEL=ultracode displays the API effort on OpenAI routes', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'ultracode'
    expect(getDisplayedEffortLevel('gpt-5.4', 'high', OPENAI_CONTEXT)).toBe(
      'xhigh',
    )
    expect(getEffortSuffix('gpt-5.4', 'high', OPENAI_CONTEXT)).toBe(
      ' with xhigh effort',
    )
  })
})
