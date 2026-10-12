import type { DiagnosticInfo, InstallationType } from './doctorDiagnostic.js'
import { getDoctorDiagnostic } from './doctorDiagnostic.js'
import { localInstallationExists } from './localInstaller.js'
import { type LegacyAPIProvider, getAPIProvider } from './model/providers.js'
import { hasNativeDistribution } from './nativeDistribution.js'
import type { PackageManager } from './nativeInstaller/packageManagers.js'
import { getPackageManager } from './nativeInstaller/packageManagers.js'

/**
 * How the *currently running* OpenClaude installation should be updated.
 *
 *  - `blocked`         — must not self-update (third-party upstream build, or a
 *                        development build); the caller should show guidance.
 *  - `package-manager` — owned by a system package manager (homebrew/winget/…);
 *                        the user must update through that manager.
 *  - `native`          — update via the native installer.
 *  - `npm`             — update the npm install (`local` or `global`).
 */
export type UpdateStrategy =
  | { action: 'blocked'; reason: 'third-party-build' | 'development' }
  | { action: 'package-manager'; manager: PackageManager }
  | { action: 'native' }
  | { action: 'npm'; method: 'local' | 'global' }

/**
 * True when this build must NOT self-update: a third-party provider session
 * running on the upstream `@anthropic-ai/claude-code` package. Self-updating
 * there pulls from the first-party distribution and would silently replace the
 * build the user is running. Custom-PACKAGE_URL builds (OpenClaude's
 * `@twigpine/openclaude`) are safe to self-update.
 *
 * Shared by the `openclaude update` CLI and the `/update` slash command so both
 * honour the same guard.
 */
export function isThirdPartyBuildBlocked(): boolean {
  return isThirdPartyBuildBlockedFor(getAPIProvider(), MACRO.PACKAGE_URL)
}

/**
 * Pure form of {@link isThirdPartyBuildBlocked}, taking the provider and build
 * package URL as inputs so the guard logic can be regression-tested without
 * `getAPIProvider()` / the build-time `MACRO` global.
 */
export function isThirdPartyBuildBlockedFor(
  apiProvider: LegacyAPIProvider,
  packageUrl: string,
): boolean {
  return apiProvider !== 'firstParty' && packageUrl === '@anthropic-ai/claude-code'
}

/**
 * Injectable dependencies — lets callers (and tests) substitute the
 * environment probes without module mocking.
 */
export type UpdateStrategyDeps = {
  isThirdPartyBlocked: () => boolean
  getDiagnostic: () => Promise<DiagnosticInfo>
  getPackageManager: () => Promise<PackageManager>
  localInstallationExists: () => Promise<boolean>
  hasNativeDistribution: () => boolean
}

const defaultDeps: UpdateStrategyDeps = {
  isThirdPartyBlocked: isThirdPartyBuildBlocked,
  getDiagnostic: getDoctorDiagnostic,
  getPackageManager,
  localInstallationExists,
  hasNativeDistribution,
}

/**
 * Pure routing decision from a known installation type. Kept separate so the
 * branch logic can be unit-tested without spawning the diagnostic probes.
 * `packageManager`/`localInstallExists` are only consulted by the branches that
 * need them.
 */
export function planUpdate(input: {
  thirdPartyBlocked: boolean
  installationType: InstallationType
  packageManager: PackageManager
  localInstallExists: boolean
  nativeDistributionAvailable: boolean
}): UpdateStrategy {
  if (input.thirdPartyBlocked) {
    return { action: 'blocked', reason: 'third-party-build' }
  }
  switch (input.installationType) {
    case 'development':
      return { action: 'blocked', reason: 'development' }
    case 'package-manager':
      return { action: 'package-manager', manager: input.packageManager }
    case 'native':
      // npm-only builds must never route to the native installer — it would
      // download the first-party binary this build does not ship.
      return input.nativeDistributionAvailable
        ? { action: 'native' }
        : { action: 'npm', method: 'global' }
    case 'npm-local':
      return { action: 'npm', method: 'local' }
    case 'npm-global':
      return { action: 'npm', method: 'global' }
    case 'unknown':
      // Fall back to file detection, matching cli/update.ts's unknown branch.
      return { action: 'npm', method: input.localInstallExists ? 'local' : 'global' }
  }
}

/**
 * Decide how to update the currently running installation. Mirrors the routing
 * in `src/cli/update.ts` so the CLI and the `/update` slash command update the
 * installation the user is actually running, instead of blindly installing a
 * global npm package.
 *
 * Short-circuits the third-party guard before any probing, and only runs the
 * package-manager / local-detection probes for the branches that need them.
 */
export async function resolveUpdateStrategy(
  deps: UpdateStrategyDeps = defaultDeps,
): Promise<UpdateStrategy> {
  if (deps.isThirdPartyBlocked()) {
    return { action: 'blocked', reason: 'third-party-build' }
  }

  const { installationType } = await deps.getDiagnostic()
  return planUpdate({
    thirdPartyBlocked: false,
    installationType,
    nativeDistributionAvailable: deps.hasNativeDistribution(),
    packageManager:
      installationType === 'package-manager'
        ? await deps.getPackageManager()
        : 'unknown',
    localInstallExists:
      installationType === 'unknown'
        ? await deps.localInstallationExists()
        : false,
  })
}
