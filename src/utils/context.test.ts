import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'

import { getMaxOutputTokensForModel } from '../services/api/claude.ts'
import { resolveOpenAIShimRuntimeContext } from '../integrations/runtimeMetadata.ts'
import {
  calculateContextPercentages,
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
  clearSessionContextWindowOverride,
} from './context.ts'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS:
    process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS,
  CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS:
    process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  AIMLAPI_API_KEY: process.env.AIMLAPI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  LONGCAT_API_KEY: process.env.LONGCAT_API_KEY,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  USER_TYPE: process.env.USER_TYPE,
  OPENCLAUDE_MAX_TURNS: process.env.OPENCLAUDE_MAX_TURNS,
  CLAUDE_CODE_MAX_TURNS: process.env.CLAUDE_CODE_MAX_TURNS,
}

beforeEach(async () => {
  await acquireSharedMutationLock('context.test.ts')
  clearSessionContextWindowOverride()
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.OPENAI_API_KEY
  delete process.env.AIMLAPI_API_KEY
  delete process.env.OPENAI_MODEL
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.MINIMAX_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.LONGCAT_API_KEY
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.USER_TYPE
  delete process.env.OPENCLAUDE_MAX_TURNS
  delete process.env.CLAUDE_CODE_MAX_TURNS
})

afterEach(() => {
  try {
    if (originalEnv.CLAUDE_CODE_USE_OPENAI === undefined) {
      delete process.env.CLAUDE_CODE_USE_OPENAI
    } else {
      process.env.CLAUDE_CODE_USE_OPENAI = originalEnv.CLAUDE_CODE_USE_OPENAI
    }
    if (originalEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) {
      delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    } else {
      process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS =
        originalEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS
    }
    if (originalEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS === undefined) {
      delete process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS
    } else {
      process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS =
        originalEnv.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS
    }
    if (originalEnv.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS === undefined) {
      delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS
    } else {
      process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS =
        originalEnv.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS
    }
    if (originalEnv.OPENAI_MODEL === undefined) {
      delete process.env.OPENAI_MODEL
    } else {
      process.env.OPENAI_MODEL = originalEnv.OPENAI_MODEL
    }
    if (originalEnv.OPENAI_BASE_URL === undefined) {
      delete process.env.OPENAI_BASE_URL
    } else {
      process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL
    }
    if (originalEnv.OPENAI_API_BASE === undefined) {
      delete process.env.OPENAI_API_BASE
    } else {
      process.env.OPENAI_API_BASE = originalEnv.OPENAI_API_BASE
    }
    if (originalEnv.OPENAI_API_KEY === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY
    }
    if (originalEnv.AIMLAPI_API_KEY === undefined) {
      delete process.env.AIMLAPI_API_KEY
    } else {
      process.env.AIMLAPI_API_KEY = originalEnv.AIMLAPI_API_KEY
    }
    if (originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED =
        originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
    }
    if (originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID === undefined) {
      delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    } else {
      process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID =
        originalEnv.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
    }
    if (originalEnv.MINIMAX_API_KEY === undefined) {
      delete process.env.MINIMAX_API_KEY
    } else {
      process.env.MINIMAX_API_KEY = originalEnv.MINIMAX_API_KEY
    }
    if (originalEnv.XAI_API_KEY === undefined) {
      delete process.env.XAI_API_KEY
    } else {
      process.env.XAI_API_KEY = originalEnv.XAI_API_KEY
    }
    if (originalEnv.LONGCAT_API_KEY === undefined) {
      delete process.env.LONGCAT_API_KEY
    } else {
      process.env.LONGCAT_API_KEY = originalEnv.LONGCAT_API_KEY
    }
    if (originalEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined) {
      delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    } else {
      process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = originalEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS
    }
    if (originalEnv.USER_TYPE === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalEnv.USER_TYPE
    }
    if (originalEnv.OPENCLAUDE_MAX_TURNS === undefined) {
      delete process.env.OPENCLAUDE_MAX_TURNS
    } else {
      process.env.OPENCLAUDE_MAX_TURNS = originalEnv.OPENCLAUDE_MAX_TURNS
    }
    if (originalEnv.CLAUDE_CODE_MAX_TURNS === undefined) {
      delete process.env.CLAUDE_CODE_MAX_TURNS
    } else {
      process.env.CLAUDE_CODE_MAX_TURNS = originalEnv.CLAUDE_CODE_MAX_TURNS
    }
  } finally {
    clearSessionContextWindowOverride()
    releaseSharedMutationLock()
  }
})

test('calculateContextPercentages preserves tiny nonzero usage', () => {
  expect(
    calculateContextPercentages(
      {
        input_tokens: 1,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      1_000_000,
    ),
  ).toEqual({
    used: 0.01,
    remaining: 99.99,
  })
})

test('deepseek-v4-flash uses the gateway-safe output cap by default', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-flash')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(65_536)
})

test('deepseek-v4-flash uses DeepSeek direct API max output cap on api.deepseek.com', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-flash')).toEqual({
    default: 393_216,
    upperLimit: 393_216,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(393_216)
})

test('deepseek-v4-pro uses the gateway-safe output cap by default', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro')).toBe(65_536)
})

test('Ollama deepseek-v4-pro cloud variant uses DeepSeek V4 Pro runtime limits', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro:cloud')).toBe(65_536)
})

test('Ollama deepseek-v4-pro cloud variant is modeled as route catalog metadata', () => {
  const runtimeContext = resolveOpenAIShimRuntimeContext({
    processEnv: {
      ...process.env,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    },
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-v4-pro:cloud',
  })

  expect(runtimeContext.routeId).toBe('ollama')
  expect(runtimeContext.catalogEntry).toMatchObject({
    apiName: 'deepseek-v4-pro:cloud',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  })
})

test('Ollama deepseek-v4-pro cloud variant clamps oversized output token overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '262144'
  delete process.env.OPENAI_MODEL

  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro:cloud')).toBe(65_536)
})

test('Ollama deepseek-v4-pro cloud variant does not inherit base-model env override prefixes', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'deepseek-v4-pro': 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'deepseek-v4-pro': 262_144,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('Ollama deepseek-v4-pro cloud variant still honors exact env overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'deepseek-v4-pro:cloud': 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'deepseek-v4-pro:cloud': 12_288,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(262_144)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 12_288,
    upperLimit: 12_288,
  })
})

test('OpenAI-compatible env override prefixes still match colon-tagged local models', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    llama3: 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    llama3: 12_288,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('llama3:70b')).toBe(262_144)
  expect(getModelMaxOutputTokens('llama3:70b')).toEqual({
    default: 12_288,
    upperLimit: 12_288,
  })
})

test('Ollama deepseek-v4-pro cloud variant keeps the local max_tokens transport field', () => {
  const runtimeContext = resolveOpenAIShimRuntimeContext({
    processEnv: {
      ...process.env,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    },
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-v4-pro:cloud',
  })

  expect(runtimeContext.routeId).toBe('ollama')
  expect(runtimeContext.openaiShimConfig.maxTokensField).toBe('max_tokens')
})

test('deepseek-v4-pro uses DeepSeek direct API max output cap on api.deepseek.com', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro')).toEqual({
    default: 393_216,
    upperLimit: 393_216,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro')).toBe(393_216)
})

test('deepseek-v4-pro keeps gateway routes on the lower output cap', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getModelMaxOutputTokens('deepseek-v4-pro')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro')).toBe(65_536)
})

test('deepseek legacy aliases keep their documented provider caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-chat')).toBe(128_000)
  expect(getContextWindowForModel('deepseek-reasoner')).toBe(128_000)
  expect(getMaxOutputTokensForModel('deepseek-chat')).toBe(8_192)
  expect(getMaxOutputTokensForModel('deepseek-reasoner')).toBe(65_536)
})

test('deepseek-v4-pro clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '500000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('deepseek-v4-pro')).toBe(65_536)
})

test('deepseek-v4-flash clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/v1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '500000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(393_216)
})

test('gpt-4o uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-4o clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-5.5 uses conservative Codex-route context window (issue #1118)', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  // gpt-5.5 is primarily routed through the Codex transport in this repo
  // (see src/services/api/providerConfig.ts). The 1.05M API descriptor value
  // caused /context to under-report and auto-compact to fire too late,
  // resulting in mid-turn 500s. The descriptor is pinned to the Codex
  // effective limit until provider-aware context windows land.
  expect(getContextWindowForModel('gpt-5.5')).toBe(272_000)
})

test('gpt-5.6 family pins the Codex effective input limit on the Codex route', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://chatgpt.com/backend-api/codex'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  // Same rationale as gpt-5.5 above, but scoped to the Codex transport: the
  // Codex base URL resolves to a catalog-less route, so the gpt.ts
  // descriptor (pinned to the ~272k effective input boundary, issue #1118)
  // is what sizes the context there.
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    expect(getContextWindowForModel(model)).toBe(272_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
  }
})

test('gpt-5.6 family keeps the full window on the direct-OpenAI route', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.OPENAI_BASE_URL
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  // Unlike gpt-5.5 (Codex-only, blanket-capped in the vendor catalog), the
  // gpt-5.6 family is also served directly by api.openai.com /v1/responses
  // at its true 1.05M window; the openai-route catalog entry preserves it.
  for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    expect(getContextWindowForModel(model)).toBe(1_050_000)
  }
})

test('gpt-5.4 family uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
  expect(getModelMaxOutputTokens('gpt-5.4')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-mini')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-nano')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-nano')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test('gpt-5.4 family keeps large max output overrides within provider limits', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '200000'

  expect(getMaxOutputTokensForModel('gpt-5.4')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-mini')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-nano')).toBe(128_000)
})

test('MiniMax-M2.7 uses the shared gateway-safe context cap by default', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.7')).toBe(196_608)
  expect(getModelMaxOutputTokens('MiniMax-M2.7')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getMaxOutputTokensForModel('MiniMax-M2.7')).toBe(131_072)
})

test('MiniMax China uses the M3 context limit before client setup', () => {
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL
  const savedApiKey = process.env.ANTHROPIC_API_KEY
  try {
    process.env.ANTHROPIC_BASE_URL = 'https://api.minimaxi.com/anthropic'
    process.env.ANTHROPIC_API_KEY = 'china-test-key'
    expect(getContextWindowForModel('MiniMax-M3')).toBe(1_048_576)
  } finally {
    if (savedBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
    else process.env.ANTHROPIC_BASE_URL = savedBaseUrl
    if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = savedApiKey
  }
})

test('env-only MiniMax key uses provider-specific context and output caps before client setup', () => {
  process.env.MINIMAX_API_KEY = 'minimax-test-key'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.5')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.7')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getMaxOutputTokensForModel('MiniMax-M2.7')).toBe(131_072)
})

test('env-only xAI key uses provider-specific context and output caps before client setup', () => {
  process.env.XAI_API_KEY = 'xai-test-key'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('grok-4.6')).toBe(500_000)
  expect(getModelMaxOutputTokens('grok-4.6').upperLimit).toBe(500_000)
  expect(getContextWindowForModel('grok-4.5')).toBe(500_000)
  expect(getContextWindowForModel('grok-4.3')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('grok-4.3')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
  expect(getMaxOutputTokensForModel('grok-4.3')).toBe(32_768)
  expect(getContextWindowForModel('grok-4')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('grok-4')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
  expect(getMaxOutputTokensForModel('grok-4')).toBe(32_768)
})

test('unknown openai-compatible models use the 128k fallback window (not 8k, see #635)', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('some-unknown-3p-model')).toBe(128_000)
})

test('unknown openai-compatible model fallback logs one debug warning and no console errors', async () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  const actualDebugModule = await import('./debug.js')
  const logForDebugging = spyOn(
    actualDebugModule,
    'logForDebugging',
  ).mockImplementation((_message, _options) => {})

  const originalConsoleError = console.error
  const consoleError = mock(() => {})
  console.error = consoleError
  try {
    const contextModule = await import(
      `./context.ts?contextDedupe=${Date.now()}-${Math.random()}`
    )

    expect(
      contextModule.getContextWindowForModel('another-unknown-3p-model'),
    ).toBe(128_000)
    expect(
      contextModule.getContextWindowForModel('another-unknown-3p-model'),
    ).toBe(128_000)
    expect(consoleError).not.toHaveBeenCalled()
    const contextWarnings = logForDebugging.mock.calls.filter(
      ([message, options]) =>
        typeof message === 'string' &&
        message.startsWith('[context] Warning:') &&
        options?.level === 'warn',
    )
    expect(contextWarnings).toHaveLength(1)
  } finally {
    console.error = originalConsoleError
    mock.restore()
  }
})

test('prefixed OpenGateway Gemini Flash Lite uses integration metadata', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('google/gemini-3.1-flash-lite')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('google/gemini-3.1-flash-lite')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('google/gemini-3.1-flash-lite')).toBe(65_536)
})
test('prefixed Gemini 3.1 Pro router model uses integration metadata', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

  expect(getContextWindowForModel('google/gemini-3.1-pro')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('google/gemini-3.1-pro')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('google/gemini-3.1-pro')).toBe(65_536)
})

test('NVIDIA NIM DeepSeek V4 Pro uses NIM route catalog metadata', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://integrate.api.nvidia.com/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID

  expect(getContextWindowForModel('deepseek-ai/deepseek-v4-pro')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-ai/deepseek-v4-pro')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-ai/deepseek-v4-pro')).toBe(65_536)
})

test('OpenAI-compatible custom model limits honor documented env overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'custom-model': 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'custom-model': 12_288,
  })

  expect(getContextWindowForModel('custom-model')).toBe(262_144)
  expect(getModelMaxOutputTokens('custom-model')).toEqual({
    default: 12_288,
    upperLimit: 12_288,
  })
})

test('OpenAI-compatible env overrides take precedence over integration metadata', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'gpt-4o': 64_000,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'gpt-4o': 4_096,
  })

  expect(getContextWindowForModel('gpt-4o')).toBe(64_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 4_096,
    upperLimit: 4_096,
  })
})

test('OpenAI-compatible host-qualified env overrides beat generic overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.foo.com/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'gpt-4o': 128_000,
    'api.foo.com:gpt-4o': 64_000,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'gpt-4o': 16_384,
    'api.foo.com:gpt-4o': 4_096,
  })

  expect(getContextWindowForModel('gpt-4o')).toBe(64_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 4_096,
    upperLimit: 4_096,
  })
})

test('OpenAI-compatible host-qualified env overrides honor OPENAI_API_BASE', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_API_BASE = 'https://legacy.foo.com/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'gpt-4o': 128_000,
    'legacy.foo.com:gpt-4o': 96_000,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'gpt-4o': 16_384,
    'legacy.foo.com:gpt-4o': 8_192,
  })

  expect(getContextWindowForModel('gpt-4o')).toBe(96_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 8_192,
    upperLimit: 8_192,
  })
})

test('OpenAI-compatible exact env overrides beat host-qualified prefixes', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.foo.com/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'api.foo.com:gpt-4': 8_192,
    'gpt-4o': 128_000,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'api.foo.com:gpt-4': 1_024,
    'gpt-4o': 16_384,
  })

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('OpenAI-compatible legacy aliases keep their migrated limits', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen2.5-coder:32b')).toBe(32_768)
  expect(getModelMaxOutputTokens('qwen2.5-coder:32b')).toEqual({
    default: 8_192,
    upperLimit: 8_192,
  })
  expect(getContextWindowForModel('deepseek-r1:14b')).toBe(65_536)
  expect(getModelMaxOutputTokens('deepseek-r1:14b')).toEqual({
    default: 8_192,
    upperLimit: 8_192,
  })
  expect(getContextWindowForModel('github:copilot')).toBe(128_000)
  expect(getModelMaxOutputTokens('github:copilot')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('MiniMax-M2.5 and M2.1 use shared gateway-safe context caps by default', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.5')).toBe(196_608)
  expect(getContextWindowForModel('MiniMax-M2.5-highspeed')).toBe(196_608)
  expect(getContextWindowForModel('MiniMax-M2.1')).toBe(196_608)
  expect(getContextWindowForModel('MiniMax-M2.1-highspeed')).toBe(196_608)
  expect(getModelMaxOutputTokens('MiniMax-M2.5')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
})

test('DashScope qwen3.6-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.6-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.6-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
})

test('DashScope qwen3.5-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.5-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.5-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
})

test('DashScope qwen3-coder-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3-coder-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('DashScope qwen3-coder-next uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('Ollama qwen3-coder-next cloud variant uses gateway-specific output cap', () => {
  // The shared qwen3-coder-next descriptor stays at 65536; the Ollama Cloud
  // `:cloud` variant is capped to 32768 via the gateway catalog override
  // because Ollama Cloud rejects requests above that. Context window is
  // inherited from the descriptor (262144).
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next:cloud')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next:cloud')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope qwen3-max uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope qwen3-max dated variant resolves to base entry via prefix match', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max-2026-01-23')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max-2026-01-23')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope kimi-k2.5 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-k2.5')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-k2.5')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code kimi-for-coding uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-for-coding')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-for-coding')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code K3 1M choice uses the Allegretto cap', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('k3')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('k3')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code K3 256K catalog choice uses the Moderato cap', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('k3-256k')).toBe(262_144)
})

test('DashScope glm-5 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-5')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-5')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('DashScope glm-4.7 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-4.7')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-4.7')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('Z.AI GLM models use Coding Plan output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://api.z.ai/api/coding/paas/v4'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  for (const model of [
    'glm-5.3-flash',
    'glm-5.3-flash?reasoning=low',
    'glm-5.3-flash?reasoning=high',
    'glm-5.3-flash?reasoning=xhigh',
    'glm-5.3-flash?thinking=disabled',
  ]) {
    expect(getContextWindowForModel(model)).toBe(1_000_000)
    expect(getModelMaxOutputTokens(model)).toEqual({
      default: 131_072,
      upperLimit: 131_072,
    })
  }

  expect(getContextWindowForModel('glm-5.3')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('glm-5.3')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getContextWindowForModel('glm-5.2')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('glm-5.2')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getContextWindowForModel('GLM-5.1')).toBe(202_752)
  expect(getModelMaxOutputTokens('GLM-5.1')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-5-Turbo')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-4.5-Air')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('GLM-5.3-Flash direct limits do not leak to OpenRouter', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-5.3-flash')).toBe(128_000)
  expect(getModelMaxOutputTokens('glm-5.3-flash')).toEqual({
    default: 32_000,
    upperLimit: 128_000,
  })
})

test('lowercase GLM aliases keep conservative output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getModelMaxOutputTokens('glm-5.1')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getModelMaxOutputTokens('glm-5-turbo')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getModelMaxOutputTokens('glm-4.5-air')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('DashScope models clamp oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '100000'

  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-coder-next')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-max')).toBe(32_768)
  expect(getMaxOutputTokensForModel('kimi-k2.5')).toBe(32_768)
  expect(getMaxOutputTokensForModel('glm-5')).toBe(16_384)
  expect(getMaxOutputTokensForModel('glm-5.1')).toBe(16_384)
})

test('Ollama model with no runtime metadata uses permissive upper limit (#1604)', () => {
  // gemma4:e4b is not in the Ollama catalog — no runtime maxOutputTokens
  // available. Previously the fallback Anthropic 64k upper limit silently
  // capped the user's CLAUDE_CODE_MAX_OUTPUT_TOKENS override.
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'gemma4:e4b'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS

  expect(getModelMaxOutputTokens('gemma4:e4b')).toEqual({
    default: 32_000,
    upperLimit: 128_000,
  })
  expect(getMaxOutputTokensForModel('gemma4:e4b')).toBe(32_000)
})

test('Ollama model with no runtime metadata honors CLAUDE_CODE_MAX_OUTPUT_TOKENS above 64k (#1604)', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'gemma4:e4b'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '128000'
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS

  // Previously this returned 64000 because the unknown-model fallback used
  // MAX_OUTPUT_TOKENS_UPPER_LIMIT (64k) as the upper limit, silently capping
  // the user's 128000 override.
  expect(getMaxOutputTokensForModel('gemma4:e4b')).toBe(128_000)
})

test('Ollama model with no runtime metadata caps absurd overrides at the context window (#1604)', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'gemma4:e4b'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'gemma4:e4b': 32_000,
  })
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '999999999'
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS

  expect(getMaxOutputTokensForModel('gemma4:e4b')).toBe(32_000)
})

test('Ollama model with no runtime metadata caps at fallback context window when context window is also unknown (#1604)', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.OPENAI_MODEL = 'gemma4:e4b'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '999999999'
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS
  delete process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS

  expect(getMaxOutputTokensForModel('gemma4:e4b')).toBe(128_000)
})

test('Anthropic model with high CLAUDE_CODE_MAX_OUTPUT_TOKENS still caps at model upper limit (#1604)', () => {
  // Regression guard: the fix for #1604 must not relax the cap for Anthropic
  // models where the API itself rejects values above the model's real limit.
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.OPENAI_BASE_URL
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '128000'

  expect(getMaxOutputTokensForModel('sonnet-4-6')).toBe(128_000)
  expect(getMaxOutputTokensForModel('opus-4-1')).toBe(32_000)
  expect(getMaxOutputTokensForModel('claude-3-opus')).toBe(4_096)
})

test('recent Opus models (4.8/4.7/4.6) get the elevated output-token limits (#1769)', () => {
  // Regression: 4.8/4.7 used to fall through to the generic opus-4 branch and
  // cap at 32k, while the default Opus is now 4.8.
  const elevated = { default: 64_000, upperLimit: 128_000 }
  expect(getModelMaxOutputTokens('claude-opus-4-8')).toEqual(elevated)
  expect(getModelMaxOutputTokens('claude-opus-4-7')).toEqual(elevated)
  expect(getModelMaxOutputTokens('claude-opus-4-6')).toEqual(elevated)
  // Older Opus still capped lower.
  expect(getModelMaxOutputTokens('claude-opus-4-1')).toEqual({
    default: 32_000,
    upperLimit: 32_000,
  })
})

test('modelSupports1M recognizes the current default Opus (4.8) as 1M-capable', () => {
  const original = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  try {
    // Regression: the firstParty default session model is claude-opus-4-8[1m]
    // (getDefaultMainLoopModelSetting), so dropping 4.8 here downgrades a 1M
    // session to 200K and trips a spurious "Context limit reached" — exactly
    // what resolveSkillModelOverride relies on this predicate to prevent.
    expect(modelSupports1M('claude-opus-4-8')).toBe(true)
    expect(modelSupports1M('claude-opus-4-8[1m]')).toBe(true)
    expect(modelSupports1M('claude-opus-4-7')).toBe(true)
    expect(modelSupports1M('claude-opus-4-7[1m]')).toBe(true)
    // Existing 1M models must keep working.
    expect(modelSupports1M('claude-opus-4-6')).toBe(true)
    expect(modelSupports1M('claude-sonnet-4-6')).toBe(true)
    expect(modelSupports1M('claude-sonnet-4-5')).toBe(true)
    // Models without a 1M variant must stay false.
    expect(modelSupports1M('claude-opus-4-1')).toBe(false)
    expect(modelSupports1M('claude-opus-4-0')).toBe(false)
    expect(modelSupports1M('claude-3-5-haiku')).toBe(false)
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    } else {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = original
    }
  }
})

test('modelSupports1M honors the 1M disable switch even for Opus 4.7', () => {
  const original = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
  process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = '1'
  try {
    expect(modelSupports1M('claude-opus-4-7')).toBe(false)
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
    } else {
      process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = original
    }
  }
})

// --- Session-scoped context window overrides ---

import {
  setSessionContextWindowOverride,
  getSessionContextWindowOverride,
  getSessionContextWindowOverrides,
} from './context.ts'

test('setSessionContextWindowOverride sets and gets override', () => {
  const result = setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.normalizedModel).toBe('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
})

test('setSessionContextWindowOverride normalizes case and provider prefix', () => {
  setSessionContextWindowOverride('OpenAI/GPT-4o', 200_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('OpenAI/GPT-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(200_000)
})

test('provider-qualified and unqualified model names map to the same canonical key', () => {
  setSessionContextWindowOverride('zai-org/glm-5.2', 256_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(256_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(256_000)

  setSessionContextWindowOverride('glm-5.2', 128_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(128_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(128_000)
})

test('mixed-order setting and clearing qualified/unqualified aliases', () => {
  // Path 1: Set qualified, then set unqualified, then clear unqualified
  setSessionContextWindowOverride('openai/gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)

  setSessionContextWindowOverride('gpt-4o', 128_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(128_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(128_000)

  clearSessionContextWindowOverride('gpt-4o')
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()

  // Path 2: Set unqualified, then set qualified, then clear qualified
  setSessionContextWindowOverride('gpt-4o', 200_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(200_000)

  setSessionContextWindowOverride('openai/gpt-4o', 300_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(300_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(300_000)

  clearSessionContextWindowOverride('openai/gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
})

test('writing openai/gpt-4o is readable via gpt-4o', () => {
  setSessionContextWindowOverride('openai/gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
})

test('setSessionContextWindowOverride rejects below minimum', () => {
  const result = setSessionContextWindowOverride('gpt-4o', 10_000)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('at least')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
})

test('setSessionContextWindowOverride rejects non-integer values', () => {
  expect(setSessionContextWindowOverride('gpt-4o', NaN).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', Infinity).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', -1).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', 64_000.5).ok).toBe(false)
})

test('clearSessionContextWindowOverride clears specific model', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  setSessionContextWindowOverride('claude-sonnet-4', 200_000)
  clearSessionContextWindowOverride('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('claude-sonnet-4')).toBe(200_000)
})

test('clearSessionContextWindowOverride clears stripped fallback when clearing qualified name', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
  clearSessionContextWindowOverride('openai/gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
})

test('clearSessionContextWindowOverride clears all when no model specified', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  setSessionContextWindowOverride('claude-sonnet-4', 200_000)
  clearSessionContextWindowOverride()
  expect(getSessionContextWindowOverrides().size).toBe(0)
})

test('getSessionContextWindowOverrides returns a copy', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  const copy = getSessionContextWindowOverrides()
  copy.delete('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
})

test('session override takes precedence over env override for OpenAI-compatible model', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({ 'custom-model': 64_000 })
  expect(getContextWindowForModel('custom-model')).toBe(64_000)
  setSessionContextWindowOverride('custom-model', 256_000)
  expect(getContextWindowForModel('custom-model')).toBe(256_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('custom-model')).toBe(64_000)
})

test('session override takes precedence over unknown model fallback', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  setSessionContextWindowOverride('unknown-model', 200_000)
  expect(getContextWindowForModel('unknown-model')).toBe(200_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('unknown-model')).toBe(128_000)
})

test('session override takes precedence over known model catalog metadata', () => {
  const defaultWindow = getContextWindowForModel('gpt-4o')
  setSessionContextWindowOverride('gpt-4o', 500_000)
  expect(getContextWindowForModel('gpt-4o')).toBe(500_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('gpt-4o')).toBe(defaultWindow)
})

test('CLAUDE_CODE_MAX_CONTEXT_TOKENS takes precedence over session override', () => {
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '50000'
  setSessionContextWindowOverride('gpt-4o', 200_000)
  expect(getContextWindowForModel('gpt-4o')).toBe(50_000)
})

test('provider-qualified override maps to canonical key', () => {
  setSessionContextWindowOverride('zai-org/glm-5.2', 256_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(256_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(256_000)
})

test('clearSessionContextWindowOverride resets state for session isolation', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
  clearSessionContextWindowOverride()
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getContextWindowForModel('gpt-4o')).not.toBe(256_000)
})
