/**
 * Pure gating decisions for the first-run setup screens, extracted from
 * showSetupScreens (interactiveHelpers.tsx) as an importable seam:
 * interactiveHelpers cannot be imported in tests — its import chain trips
 * Bun's compile-time feature() macro checker before mocks can intercept —
 * so behavioral coverage lives against this module instead (the same pattern
 * as the dev-channels registration seam).
 *
 * Deliberately provider-free: NO input carries which API provider is active.
 * That absence is the fix (#1864) — onboarding (theme + safety notes) is
 * universal, with Onboarding.tsx itself dropping the OAuth/preflight steps
 * when Anthropic auth is off, and workspace trust is exactly as load-bearing
 * over a local model as over Anthropic. Re-introducing a provider parameter
 * here should be treated as a regression signal in review.
 */
export function getRequiredSetupScreens(options: {
  theme: string | undefined
  hasCompletedOnboarding: boolean | undefined
  trustDialogAccepted: boolean
  isClaubbit: boolean
}): { onboarding: boolean; trustDialog: boolean } {
  return {
    // Always show onboarding at least once (theme unset or never completed).
    onboarding: !options.theme || !options.hasCompletedOnboarding,
    // The trust dialog is the workspace trust boundary; only the claubbit
    // harness (which owns its own trust story) skips it.
    trustDialog: !options.isClaubbit && !options.trustDialogAccepted,
  }
}
