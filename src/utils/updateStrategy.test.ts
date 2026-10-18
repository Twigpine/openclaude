import { describe, expect, test } from 'bun:test'
import type { DiagnosticInfo, InstallationType } from './doctorDiagnostic.js'
import type { PackageManager } from './nativeInstaller/packageManagers.js'
import type { LegacyAPIProvider } from './model/providers.js'
import {
  isThirdPartyBuildBlockedFor,
  planUpdate,
  resolveUpdateStrategy,
  type UpdateStrategyDeps,
} from './updateStrategy.js'

describe('isThirdPartyBuildBlockedFor', () => {
  const UPSTREAM = '@anthropic-ai/claude-code'
  const OPENCLAUDE = '@twigpine/openclaude'

  test('blocks a third-party provider running the upstream build', () => {
    for (const provider of [
      'bedrock',
      'vertex',
      'openai',
      'gemini',
    ] as LegacyAPIProvider[]) {
      expect(isThirdPartyBuildBlockedFor(provider, UPSTREAM)).toBe(true)
    }
  })

  test('allows the first-party provider on the upstream build', () => {
    expect(isThirdPartyBuildBlockedFor('firstParty', UPSTREAM)).toBe(false)
  })

  test('allows a custom-PACKAGE_URL build (OpenClaude) on any provider', () => {
    expect(isThirdPartyBuildBlockedFor('bedrock', OPENCLAUDE)).toBe(false)
    expect(isThirdPartyBuildBlockedFor('firstParty', OPENCLAUDE)).toBe(false)
  })
})

describe('planUpdate', () => {
  const base = {
    thirdPartyBlocked: false,
    packageManager: 'unknown' as PackageManager,
    localInstallExists: false,
    nativeDistributionAvailable: true,
  }

  test('third-party build is blocked regardless of installation type', () => {
    for (const installationType of [
      'npm-global',
      'native',
      'npm-local',
    ] as InstallationType[]) {
      expect(
        planUpdate({ ...base, thirdPartyBlocked: true, installationType }),
      ).toEqual({ action: 'blocked', reason: 'third-party-build' })
    }
  })

  test('development build is blocked', () => {
    expect(
      planUpdate({ ...base, installationType: 'development' }),
    ).toEqual({ action: 'blocked', reason: 'development' })
  })

  test('package-manager install routes to manual update with the manager', () => {
    expect(
      planUpdate({
        ...base,
        installationType: 'package-manager',
        packageManager: 'homebrew',
      }),
    ).toEqual({ action: 'package-manager', manager: 'homebrew' })
  })

  test('native install routes to the native updater', () => {
    expect(planUpdate({ ...base, installationType: 'native' })).toEqual({
      action: 'native',
    })
  })

  test('native install routes to npm when the build has no native distribution', () => {
    expect(
      planUpdate({
        ...base,
        installationType: 'native',
        nativeDistributionAvailable: false,
      }),
    ).toEqual({ action: 'npm', method: 'global' })
  })

  test('npm-local and npm-global route to their npm method', () => {
    expect(planUpdate({ ...base, installationType: 'npm-local' })).toEqual({
      action: 'npm',
      method: 'local',
    })
    expect(planUpdate({ ...base, installationType: 'npm-global' })).toEqual({
      action: 'npm',
      method: 'global',
    })
  })

  test('unknown install falls back to file detection (local)', () => {
    expect(
      planUpdate({
        ...base,
        installationType: 'unknown',
        localInstallExists: true,
      }),
    ).toEqual({ action: 'npm', method: 'local' })
  })

  test('unknown install falls back to file detection (global)', () => {
    expect(
      planUpdate({
        ...base,
        installationType: 'unknown',
        localInstallExists: false,
      }),
    ).toEqual({ action: 'npm', method: 'global' })
  })
})

describe('resolveUpdateStrategy', () => {
  function makeDeps(
    overrides: Partial<UpdateStrategyDeps> & {
      installationType?: InstallationType
    } = {},
  ): { deps: UpdateStrategyDeps; calls: Record<string, number> } {
    const calls = { diagnostic: 0, packageManager: 0, localInstall: 0 }
    const deps: UpdateStrategyDeps = {
      isThirdPartyBlocked: overrides.isThirdPartyBlocked ?? (() => false),
      getDiagnostic:
        overrides.getDiagnostic ??
        (async () => {
          calls.diagnostic++
          return {
            installationType: overrides.installationType ?? 'npm-global',
          } as DiagnosticInfo
        }),
      getPackageManager:
        overrides.getPackageManager ??
        (async () => {
          calls.packageManager++
          return 'homebrew' as PackageManager
        }),
      localInstallationExists:
        overrides.localInstallationExists ??
        (async () => {
          calls.localInstall++
          return true
        }),
      hasNativeDistribution: overrides.hasNativeDistribution ?? (() => true),
    }
    return { deps, calls }
  }

  test('short-circuits on third-party block without probing the diagnostic', async () => {
    const { deps, calls } = makeDeps({ isThirdPartyBlocked: () => true })
    expect(await resolveUpdateStrategy(deps)).toEqual({
      action: 'blocked',
      reason: 'third-party-build',
    })
    expect(calls.diagnostic).toBe(0)
  })

  test('only probes the package manager for package-manager installs', async () => {
    const { deps, calls } = makeDeps({ installationType: 'package-manager' })
    expect(await resolveUpdateStrategy(deps)).toEqual({
      action: 'package-manager',
      manager: 'homebrew',
    })
    expect(calls.packageManager).toBe(1)
    expect(calls.localInstall).toBe(0)
  })

  test('only probes local-install existence for unknown installs', async () => {
    const { deps, calls } = makeDeps({ installationType: 'unknown' })
    expect(await resolveUpdateStrategy(deps)).toEqual({
      action: 'npm',
      method: 'local',
    })
    expect(calls.localInstall).toBe(1)
    expect(calls.packageManager).toBe(0)
  })

  test('routes a native install to npm when the build has no native distribution', async () => {
    const { deps } = makeDeps({
      installationType: 'native',
      hasNativeDistribution: () => false,
    })
    expect(await resolveUpdateStrategy(deps)).toEqual({
      action: 'npm',
      method: 'global',
    })
  })

  test('routes a global npm install without extra probes', async () => {
    const { deps, calls } = makeDeps({ installationType: 'npm-global' })
    expect(await resolveUpdateStrategy(deps)).toEqual({
      action: 'npm',
      method: 'global',
    })
    expect(calls.packageManager).toBe(0)
    expect(calls.localInstall).toBe(0)
  })
})
