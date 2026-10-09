import { afterEach, beforeEach, expect, test } from 'bun:test'

import { getWebFetchUserAgent } from './http.js'

const ROUTING_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_MISTRAL',
]

const originalEnv = new Map(
  ROUTING_ENV_KEYS.map(key => [key, process.env[key]]),
)
const originalMacro = (globalThis as Record<string, unknown>).MACRO

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'test-version' }
})

afterEach(() => {
  for (const key of ROUTING_ENV_KEYS) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  ;(globalThis as Record<string, unknown>).MACRO = originalMacro
})

test('WebFetch identifies a custom Anthropic endpoint as third-party', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example/v1'

  expect(getWebFetchUserAgent()).toContain(
    '+https://github.com/Twigpine/openclaude',
  )
})

test('WebFetch preserves the Anthropic support URL for first-party endpoints', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

  expect(getWebFetchUserAgent()).toContain('+https://support.anthropic.com/')
})
