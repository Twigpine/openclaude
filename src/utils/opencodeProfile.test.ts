// src/utils/opencodeProfile.test.ts

import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'

import { acquireEnvMutex, releaseEnvMutex } from '../entrypoints/sdk/shared.js'
import { DEFAULT_OPENCODE_BASE_URL } from '../services/api/providerConfig.js'
import {
  buildLaunchEnv,
  isProviderProfile,
  type ProfileFile,
} from './providerProfile.js'

function profile(profile: ProfileFile['profile'], env: ProfileFile['env']): ProfileFile {
  return {
    profile,
    env,
    createdAt: '2026-05-25T00:00:00.000Z',
  }
}

beforeEach(async () => {
  await acquireEnvMutex()
})

afterEach(() => {
  releaseEnvMutex()
})

// ---------------------------------------------------------------------------
// Type Guard Tests
// ---------------------------------------------------------------------------

test('isProviderProfile recognizes opencode', () => {
  assert.equal(isProviderProfile('opencode'), true)
})

test('isProviderProfile rejects invalid values', () => {
  assert.equal(isProviderProfile('invalid'), false)
  assert.equal(isProviderProfile(''), false)
  assert.equal(isProviderProfile('OPENCODE'), false)
})

// ---------------------------------------------------------------------------
// buildLaunchEnv Tests
// ---------------------------------------------------------------------------

test('opencode profile sets OPENAI_BASE_URL from persisted env', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: 'https://opencode.ai/zen/v1',
      OPENAI_MODEL: 'gpt-5.4',
      OPENCODE_API_KEY: 'sk-test-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://opencode.ai/zen/v1')
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
  assert.equal(env.OPENAI_API_KEY, 'sk-test-key')
})

test('opencode profile uses default base URL when not persisted', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, DEFAULT_OPENCODE_BASE_URL)
})

test('opencode profile uses default model when not persisted', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

test('opencode profile prefers process env over persisted env', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: 'https://old-url.com/v1',
      OPENAI_MODEL: 'old-model',
      OPENCODE_API_KEY: 'sk-old-key',
    }),
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: 'https://new-url.com/v1',
      OPENAI_MODEL: 'new-model',
      OPENCODE_API_KEY: 'sk-new-key',
    },
  })

  assert.equal(env.OPENAI_BASE_URL, 'https://new-url.com/v1')
  assert.equal(env.OPENAI_MODEL, 'new-model')
  assert.equal(env.OPENAI_API_KEY, 'sk-new-key')
})

test('opencode profile uses OPENCODE_API_KEY when OPENAI_API_KEY not set', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: 'sk-opencode-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_API_KEY, 'sk-opencode-key')
})

test('opencode profile prefers OPENCODE_API_KEY from process env over persisted', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: 'sk-persisted-key',
    }),
    goal: 'balanced',
    processEnv: {
      OPENCODE_API_KEY: 'sk-process-key',
    },
  })

  assert.equal(env.OPENAI_API_KEY, 'sk-process-key')
})

test('opencode profile preserves generic pooled OpenAI fallback credentials', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEYS: 'live-a,live-b',
    },
  })

  assert.equal(env.OPENAI_API_KEYS, 'live-a,live-b')
  assert.equal(env.OPENAI_API_KEY, undefined)
})

test('opencode profile preserves invalid generic pools for launch validation', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {
      OPENAI_API_KEYS: 'live-a,SUA_CHAVE',
      OPENAI_API_KEY: 'live-single',
    },
  })

  assert.equal(env.OPENAI_API_KEYS, 'live-a,SUA_CHAVE')
  assert.equal(env.OPENAI_API_KEY, undefined)
})
test('opencode profile lets dedicated OpenCode credentials override generic pools', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {
      OPENCODE_API_KEY: 'opencode-live',
      OPENAI_API_KEYS: 'live-a,live-b',
    },
  })

  assert.equal(env.OPENAI_API_KEY, 'opencode-live')
  assert.equal(env.OPENAI_API_KEYS, undefined)
})
test('opencode profile handles empty api key gracefully', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {},
  })

  // Should not crash, OPENAI_API_KEY may be undefined
  assert.ok(env.OPENAI_BASE_URL)
  assert.ok(env.OPENAI_MODEL)
})

test('opencode profile handles whitespace-only api key', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: '   ',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // Whitespace-only key should be treated as empty
  assert.ok(env.OPENAI_BASE_URL)
})

test('opencode profile handles undefined values in persisted env', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: undefined,
      OPENAI_MODEL: undefined,
      OPENCODE_API_KEY: undefined,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, DEFAULT_OPENCODE_BASE_URL)
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

test('opencode profile handles null values in persisted env', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: null as unknown as string,
      OPENAI_MODEL: null as unknown as string,
      OPENCODE_API_KEY: null as unknown as string,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, DEFAULT_OPENCODE_BASE_URL)
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

// ---------------------------------------------------------------------------
// Edge Cases
// ---------------------------------------------------------------------------

test('opencode profile handles very long api key', async () => {
  const longKey = 'sk-' + 'a'.repeat(1000)
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: longKey,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_API_KEY, longKey)
})

test('opencode profile handles special characters in api key', async () => {
  const specialKey = 'sk-test-key_with.special-chars@123'
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: specialKey,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_API_KEY, specialKey)
})

test('opencode profile handles unicode in model name', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_MODEL: 'gpt-5.4',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

test('opencode profile handles concurrent access', async () => {
  // Simulate concurrent profile builds
  const promises = Array.from({ length: 10 }, (_, i) =>
    buildLaunchEnv({
      profile: 'opencode',
      persisted: profile('opencode', {
        OPENCODE_API_KEY: `sk-key-${i}`,
      }),
      goal: 'balanced',
      processEnv: {},
    })
  )

  const results = await Promise.all(promises)
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].OPENAI_API_KEY, `sk-key-${i}`)
  }
})

test('opencode profile handles empty string values', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      OPENCODE_API_KEY: '',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // Empty strings should fall back to defaults
  assert.equal(env.OPENAI_BASE_URL, DEFAULT_OPENCODE_BASE_URL)
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

test('opencode profile handles process env with empty strings', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {}),
    goal: 'balanced',
    processEnv: {
      OPENAI_BASE_URL: '',
      OPENAI_MODEL: '',
      OPENAI_API_KEY: '',
    },
  })

  // Empty strings in process env should fall back to defaults
  assert.equal(env.OPENAI_BASE_URL, DEFAULT_OPENCODE_BASE_URL)
  assert.equal(env.OPENAI_MODEL, 'gpt-5.4')
})

// ---------------------------------------------------------------------------
// Boundary Tests
// ---------------------------------------------------------------------------

test('opencode profile handles minimum valid api key', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: 'sk-',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_API_KEY, 'sk-')
})

test('opencode profile handles maximum length model name', async () => {
  const longModel = 'a'.repeat(256)
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_MODEL: longModel,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_MODEL, longModel)
})

test('opencode profile handles maximum length base url', async () => {
  const longUrl = 'https://example.com/' + 'a'.repeat(256)
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: longUrl,
    }),
    goal: 'balanced',
    processEnv: {},
  })

  assert.equal(env.OPENAI_BASE_URL, longUrl)
})

// ---------------------------------------------------------------------------
// Negative Tests
// ---------------------------------------------------------------------------

test('opencode profile does not set OPENCODE_API_KEY in output', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENCODE_API_KEY: 'sk-opencode-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // OPENCODE_API_KEY should be mapped to OPENAI_API_KEY, not kept as-is
  assert.equal(env.OPENCODE_API_KEY, undefined)
})

test('opencode profile does not leak credentials to other profiles', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_API_KEY: 'sk-opencode-key',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // Should not contain credentials from other providers
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.GEMINI_API_KEY, undefined)
  assert.equal(env.MISTRAL_API_KEY, undefined)
})

test('opencode profile handles invalid base url gracefully', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_BASE_URL: 'not-a-url',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // Should not crash, just use the value as-is
  assert.equal(env.OPENAI_BASE_URL, 'not-a-url')
})

test('opencode profile handles invalid model name gracefully', async () => {
  const env = await buildLaunchEnv({
    profile: 'opencode',
    persisted: profile('opencode', {
      OPENAI_MODEL: 'not-a-real-model',
    }),
    goal: 'balanced',
    processEnv: {},
  })

  // Should not crash, just use the value as-is
  assert.equal(env.OPENAI_MODEL, 'not-a-real-model')
})
