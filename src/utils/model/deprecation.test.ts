import { afterEach, beforeEach, expect, test } from 'bun:test'

import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import { getModelDeprecationWarning } from './deprecation.js'

// Provider selection is driven entirely by env flags read live by
// getAPIProvider(); snapshot the ones this suite mutates so it stays hermetic.
const TOUCHED_ENV = [
  'CLAUDE_CODE_USE_GEMINI_VERTEX',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GITHUB',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MISTRAL',
] as const

const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  await acquireSharedMutationLock('model/deprecation.test.ts')
  for (const key of TOUCHED_ENV) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  try {
    for (const key of TOUCHED_ENV) {
      const value = originalEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  } finally {
    releaseSharedMutationLock()
  }
})

// claude-3-opus is deprecated under first-party / Anthropic-wire providers.
const DEPRECATED_FIRST_PARTY_MODEL = 'claude-3-opus-20240229'

test('first-party provider still surfaces the deprecation warning', () => {
  // Sanity anchor: the bypass below is only meaningful if this model is
  // otherwise reported as deprecated.
  const warning = getModelDeprecationWarning(DEPRECATED_FIRST_PARTY_MODEL)
  expect(warning).toContain('Claude 3 Opus')
})

test('Gemini Vertex provider bypasses model deprecation warnings', () => {
  process.env.CLAUDE_CODE_USE_GEMINI_VERTEX = '1'
  // Gemini Vertex serves its own model catalog, so Anthropic retirement dates
  // must never leak into its deprecation banner.
  expect(getModelDeprecationWarning(DEPRECATED_FIRST_PARTY_MODEL)).toBeNull()
})
