import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resetGrowthBook } from '../services/analytics/growthbook.js'
import { isAttributionHeaderEnabled } from '../constants/system.js'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { getSystemPromptTelemetryBlock } from './api.js'
import {
  applyAnthropicAttributionPolicy,
  getAnthropicAttributionDiagnostic,
  resolveAnthropicAttributionAuth,
  resolveAnthropicAttributionPolicy,
} from './anthropicAttribution.js'
import { asSystemPrompt } from './systemPromptType.js'

const originalAttributionSetting =
  process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
const originalFeatureFlagsFile = process.env.CLAUDE_FEATURE_FLAGS_FILE

beforeEach(async () => {
  await acquireSharedMutationLock('anthropicAttribution.test.ts')
})

afterEach(() => {
  try {
    if (originalAttributionSetting === undefined) {
      delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
    } else {
      process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = originalAttributionSetting
    }
    if (originalFeatureFlagsFile === undefined) {
      delete process.env.CLAUDE_FEATURE_FLAGS_FILE
    } else {
      process.env.CLAUDE_FEATURE_FLAGS_FILE = originalFeatureFlagsFile
    }
    resetGrowthBook()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('resolveAnthropicAttributionPolicy', () => {
  test('forces attribution only for official OAuth subscription requests', () => {
    expect(
      resolveAnthropicAttributionPolicy({
        route: 'official_anthropic',
        auth: 'oauth_subscription',
        attributionEnabled: false,
      }),
    ).toEqual({
      generate: true,
      retain: true,
      reason: 'official_oauth_required',
    })

    for (const route of ['non_official', 'unknown'] as const) {
      expect(
        resolveAnthropicAttributionPolicy({
          route,
          auth: 'oauth_subscription',
          attributionEnabled: true,
        }),
      ).toMatchObject({ generate: false, retain: false })
    }
  })

  test('preserves the global setting for official API-key and ambiguous auth', () => {
    for (const auth of ['api_key', 'unknown'] as const) {
      expect(
        resolveAnthropicAttributionPolicy({
          route: 'official_anthropic',
          auth,
          attributionEnabled: true,
        }),
      ).toMatchObject({ generate: true, retain: true })
      expect(
        resolveAnthropicAttributionPolicy({
          route: 'official_anthropic',
          auth,
          attributionEnabled: false,
        }),
      ).toMatchObject({ generate: false, retain: false })
    }
  })
})

describe('resolveAnthropicAttributionAuth', () => {
  test('gives explicit API credentials precedence over subscription state', () => {
    expect(
      resolveAnthropicAttributionAuth({
        apiKey: 'external',
        authToken: 'oauth',
        isSubscriber: true,
      }),
    ).toBe('api_key')
    expect(
      resolveAnthropicAttributionAuth({
        apiKey: 'none',
        authToken: 'api_key',
        isSubscriber: true,
      }),
    ).toBe('api_key')
    expect(
      resolveAnthropicAttributionAuth({
        apiKey: 'managed',
        authToken: 'none',
        isSubscriber: false,
      }),
    ).toBe('api_key')
  })

  test('requires both an OAuth source and subscriber state', () => {
    expect(
      resolveAnthropicAttributionAuth({
        apiKey: 'none',
        authToken: 'oauth',
        isSubscriber: true,
      }),
    ).toBe('oauth_subscription')
    expect(
      resolveAnthropicAttributionAuth({
        apiKey: 'none',
        authToken: 'oauth',
        isSubscriber: false,
      }),
    ).toBe('unknown')
  })
})

describe('applyAnthropicAttributionPolicy', () => {
  const retainPolicy = resolveAnthropicAttributionPolicy({
    route: 'official_anthropic',
    auth: 'oauth_subscription',
    attributionEnabled: true,
  })
  const stripPolicy = resolveAnthropicAttributionPolicy({
    route: 'non_official',
    auth: 'oauth_subscription',
    attributionEnabled: true,
  })

  test('keeps the first attribution block and preserves later block order and metadata', () => {
    const cachedBlock = {
      type: 'text',
      text: 'stable cached prompt',
      cache_control: { type: 'ephemeral', scope: 'org' },
    }
    const blocks = [
      { type: 'text', text: 'x-anthropic-billing-header: generated' },
      { type: 'text', text: 'prefix' },
      { type: 'text', text: 'x-anthropic-billing-header: stale' },
      cachedBlock,
    ]

    const result = applyAnthropicAttributionPolicy(blocks, retainPolicy)

    expect(result.map(block => block.text)).toEqual([
      'x-anthropic-billing-header: generated',
      'prefix',
      'stable cached prompt',
    ])
    expect(result[2]).toBe(cachedBlock)
  })

  test('removes every attribution block after a route switch', () => {
    expect(
      applyAnthropicAttributionPolicy(
        [
          'x-anthropic-billing-header: previous route',
          'stable prompt',
        ],
        stripPolicy,
      ),
    ).toEqual(['stable prompt'])
  })
})

describe('CLAUDE_CODE_ATTRIBUTION_HEADER parsing', () => {
  for (const [label, value, expected] of [
    ['unset', undefined, true],
    ['enabled', '1', true],
    ['disabled', '0', false],
    ['empty', '', true],
    ['malformed', 'sometimes', true],
  ] as const) {
    test(`${label} preserves the existing setting contract`, () => {
      process.env.CLAUDE_FEATURE_FLAGS_FILE =
        '/nonexistent/openclaude-attribution-feature-flags.json'
      if (value === undefined) {
        delete process.env.CLAUDE_CODE_ATTRIBUTION_HEADER
      } else {
        process.env.CLAUDE_CODE_ATTRIBUTION_HEADER = value
      }
      resetGrowthBook()

      expect(isAttributionHeaderEnabled()).toBe(expected)
    })
  }
})

test('ambiguous diagnostics contain no route, secret, or fingerprint data', () => {
  const diagnostic = getAnthropicAttributionDiagnostic(
    resolveAnthropicAttributionPolicy({
      route: 'unknown',
      auth: 'unknown',
      attributionEnabled: true,
    }),
  )

  expect(diagnostic).toBe(
    '[anthropic-attribution] disabled for an unresolved request route',
  )
  for (const sensitive of [
    'https://proxy.example/secret/path',
    'sk-ant-secret',
    'fingerprint-abc123',
  ]) {
    expect(diagnostic).not.toContain(sensitive)
  }
})

test('prompt telemetry selects the CLI prefix instead of the attribution fingerprint', () => {
  const block = getSystemPromptTelemetryBlock(
    asSystemPrompt([
      'x-anthropic-billing-header: cc_version=0.0.0.fingerprint-abc123',
      'You are OpenClaude, an open-source coding agent and CLI.',
      'stable prompt',
    ]),
  )

  expect(block?.text).toBe(
    'You are OpenClaude, an open-source coding agent and CLI.',
  )
  expect(block?.text).not.toContain('fingerprint-abc123')
})
