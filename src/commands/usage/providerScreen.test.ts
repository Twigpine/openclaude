import { describe, expect, test } from 'bun:test'

import {
  hasProviderPlanUsage,
  resolveInitialUsageTab,
  resolveProviderUsageScreen,
} from './providerScreen.js'

describe('resolveProviderUsageScreen', () => {
  test('Codex always has its own plan screen', () => {
    expect(
      resolveProviderUsageScreen('codex', { resolvedId: undefined, supported: false }),
    ).toBe('codex')
  })

  test.each(['minimax', 'clinepass', 'anthropic'] as const)(
    '%s has a plan screen when its descriptor supports usage',
    id => {
      expect(
        resolveProviderUsageScreen('openai', { resolvedId: id, supported: true }),
      ).toBe(id)
      expect(
        resolveProviderUsageScreen('openai', { resolvedId: id, supported: false }),
      ).toBeNull()
    },
  )

  test('other routes have no plan screen', () => {
    expect(
      resolveProviderUsageScreen('openai', {
        resolvedId: 'openrouter',
        supported: true,
      }),
    ).toBeNull()
  })
})

describe('hasProviderPlanUsage', () => {
  test('Anthropic plan limits need a Claude.ai subscription', () => {
    expect(hasProviderPlanUsage('anthropic', () => true)).toBe(true)
    expect(hasProviderPlanUsage('anthropic', () => false)).toBe(false)
  })

  test('other plan screens do not depend on the subscription', () => {
    expect(hasProviderPlanUsage('codex', () => false)).toBe(true)
    expect(hasProviderPlanUsage(null, () => true)).toBe(false)
  })
})

describe('resolveInitialUsageTab', () => {
  test('opens Plan when the provider has plan limits', () => {
    expect(resolveInitialUsageTab('', true)).toBe('Plan')
  })

  test('/usage local opens Local', () => {
    expect(resolveInitialUsageTab('local', true)).toBe('Local')
    expect(resolveInitialUsageTab('  LOCAL ', true)).toBe('Local')
  })

  test('opens Local when there are no plan limits, whatever the argument', () => {
    expect(resolveInitialUsageTab('', false)).toBe('Local')
    expect(resolveInitialUsageTab('plan', false)).toBe('Local')
  })

  test('ignores unknown arguments', () => {
    expect(resolveInitialUsageTab('nonsense', true)).toBe('Plan')
  })
})
