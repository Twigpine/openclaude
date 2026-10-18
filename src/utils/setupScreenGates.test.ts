import { describe, expect, test } from 'bun:test'

import { getRequiredSetupScreens } from './setupScreenGates.js'

// Behavioral coverage for the first-run screen gating (#1864). The seam is
// deliberately provider-free — there is no input to vary by provider, which
// IS the fix: a third-party (or any) provider gets the same onboarding and
// workspace-trust decisions as the Anthropic account flow.
// showSetupScreens itself cannot be imported under bun test (its import
// chain trips the compile-time feature() macro checker), so the wiring is
// asserted structurally in src/__tests__/bugfixes.test.ts.

describe('getRequiredSetupScreens', () => {
  const completed = {
    theme: 'dark',
    hasCompletedOnboarding: true,
    trustDialogAccepted: true,
    isClaubbit: false,
  }

  test('fresh install shows both screens', () => {
    expect(
      getRequiredSetupScreens({
        theme: undefined,
        hasCompletedOnboarding: undefined,
        trustDialogAccepted: false,
        isClaubbit: false,
      }),
    ).toEqual({ onboarding: true, trustDialog: true })
  })

  test('fully set-up install shows neither', () => {
    expect(getRequiredSetupScreens(completed)).toEqual({
      onboarding: false,
      trustDialog: false,
    })
  })

  test('onboarding re-shows when the theme is missing even if completed once', () => {
    expect(
      getRequiredSetupScreens({ ...completed, theme: undefined }).onboarding,
    ).toBe(true)
  })

  test('onboarding re-shows when never completed even with a theme set', () => {
    expect(
      getRequiredSetupScreens({ ...completed, hasCompletedOnboarding: false })
        .onboarding,
    ).toBe(true)
  })

  test('trust dialog shows whenever unaccepted, independent of onboarding state', () => {
    expect(
      getRequiredSetupScreens({ ...completed, trustDialogAccepted: false })
        .trustDialog,
    ).toBe(true)
  })

  test('claubbit skips the trust dialog but never onboarding', () => {
    const result = getRequiredSetupScreens({
      theme: undefined,
      hasCompletedOnboarding: false,
      trustDialogAccepted: false,
      isClaubbit: true,
    })
    expect(result.trustDialog).toBe(false)
    expect(result.onboarding).toBe(true)
  })
})
