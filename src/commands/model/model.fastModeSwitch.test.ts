import { afterEach, expect, mock, test } from 'bun:test'

const nonce = `${Date.now()}-${Math.random()}`
const actualFastMode = {
  ...await import(`../../utils/fastMode.js?real=${nonce}`),
} as typeof import('../../utils/fastMode.js')

// Regression for #1119 / jatmn review on PR #1164 — the cross-profile
// `/model` branch must run the same fast-mode reconciliation as the regular
// switch path. The pure helper `reconcileFastModeForSwitch` encodes the rule
// both branches call.

afterEach(() => {
  mock.restore()
  mock.module('../../utils/fastMode.js', () => actualFastMode)
})

function mockFastMode(
  overrides: Partial<typeof actualFastMode> = {},
): void {
  // Keep full surface to avoid cross-file mock.module leaks (lessons learned
  // 2026-04-30). Override only the symbols this test needs.
  mock.module('../../utils/fastMode.js', () => ({
    ...actualFastMode,
    ...overrides,
  }))
}

async function importFreshModule(
  suffix: string,
): Promise<typeof import('./model.js')> {
  return import(`./model.js?${suffix}`) as Promise<typeof import('./model.js')>
}

test('returns "unchanged" when fast mode is disabled at the process level', async () => {
  mockFastMode({
    isFastModeEnabled: () => false,
    isFastModeSupportedByModel: () => true,
    isFastModeAvailable: () => true,
  })
  const mod = await importFreshModule('fast-disabled')
  expect(mod.reconcileFastModeForSwitch('claude-opus-4-7', true)).toBe(
    'unchanged',
  )
})

test('returns "off" when target model does not support fast mode and fastMode latched', async () => {
  const clearFastModeCooldown = mock(() => undefined)
  mockFastMode({
    isFastModeEnabled: () => true,
    isFastModeSupportedByModel: (m: string | null) =>
      m?.startsWith('claude-opus') ?? false,
    isFastModeAvailable: () => true,
    clearFastModeCooldown,
  })
  const mod = await importFreshModule('fast-off')
  expect(mod.reconcileFastModeForSwitch('gpt-5-mini', true)).toBe('off')
  expect(clearFastModeCooldown).toHaveBeenCalledTimes(1)
})

test('returns "on" when target supports fast mode and it is available and latched', async () => {
  mockFastMode({
    isFastModeEnabled: () => true,
    isFastModeSupportedByModel: () => true,
    isFastModeAvailable: () => true,
    clearFastModeCooldown: () => undefined,
  })
  const mod = await importFreshModule('fast-on')
  expect(mod.reconcileFastModeForSwitch('claude-opus-4-7', true)).toBe('on')
})

test('returns "unchanged" when fastMode is not currently latched', async () => {
  mockFastMode({
    isFastModeEnabled: () => true,
    isFastModeSupportedByModel: () => true,
    isFastModeAvailable: () => true,
    clearFastModeCooldown: () => undefined,
  })
  const mod = await importFreshModule('fast-unlatched')
  expect(mod.reconcileFastModeForSwitch('claude-opus-4-7', false)).toBe(
    'unchanged',
  )
})

test('returns "off" for the cross-profile switch target when fastMode is latched on Anthropic and the new profile model is unsupported (#1119)', async () => {
  mockFastMode({
    isFastModeEnabled: () => true,
    isFastModeSupportedByModel: (m: string | null) =>
      m === 'claude-opus-4-7',
    isFastModeAvailable: () => true,
    clearFastModeCooldown: () => undefined,
  })
  const mod = await importFreshModule('fast-cross-profile')
  // User had fast mode on while running Anthropic Opus, then picks an OpenAI
  // profile from the picker — the new profile's model can't run fast mode, so
  // the reconciler must drop it.
  expect(mod.reconcileFastModeForSwitch('gpt-5-mini', true)).toBe('off')
})
