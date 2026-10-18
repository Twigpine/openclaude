import { describe, expect, test } from 'bun:test'

import {
  bundledExemptionFor,
  validateBundleExternals,
  validateInstallHygieneFields,
  validateIntentionallyBundled,
  validateOptionalPeers,
  validateOptionalRuntimeExternals,
  validateRuntimeDependencyContract,
  type PkgDeps,
} from './externalsValidation.js'

// Mirrors the real shape: a few packages bundled in both, plus SDK-external peers.
const INTENTIONALLY_BUNDLED = ['chalk', 'zod', 'react', '@anthropic-ai/sdk']
const SDK_ONLY_EXTERNALS = ['react', '@anthropic-ai/sdk']
const COMMON_EXTERNALS = ['sharp', '@vscode/ripgrep']
const SDK_EXTERNALS = [...COMMON_EXTERNALS, ...SDK_ONLY_EXTERNALS]

describe('bundledExemptionFor', () => {
  test('CLI exempts every bundled package; SDK excludes peer-provided ones', () => {
    const cli = bundledExemptionFor(INTENTIONALLY_BUNDLED, new Set())
    expect(cli.has('react')).toBe(true)

    const peers = new Set(['react', '@anthropic-ai/sdk'])
    const sdk = bundledExemptionFor(INTENTIONALLY_BUNDLED, peers)
    expect(sdk.has('chalk')).toBe(true) // bundled in both
    expect(sdk.has('react')).toBe(false) // peer => external in SDK, not exempt
    expect(sdk.has('@anthropic-ai/sdk')).toBe(false)
  })
})

describe('validateBundleExternals', () => {
  const runtimeDeps = new Set(['@vscode/ripgrep', 'react', '@anthropic-ai/sdk'])

  test('passes when every runtime dep is external or bundled-in-this-bundle', () => {
    const sdkExemption = bundledExemptionFor(
      INTENTIONALLY_BUNDLED,
      new Set(['react', '@anthropic-ai/sdk']),
    )
    const r = validateBundleExternals('SDK', runtimeDeps, SDK_EXTERNALS, sdkExemption)
    expect(r.ok).toBe(true)
  })

  test('FAILS when an SDK-external peer is dropped from SDK_EXTERNALS', () => {
    // The regression Jatmn flagged: drop react from externals but keep it a peer.
    const brokenSdkExternals = SDK_EXTERNALS.filter(d => d !== 'react')
    const sdkExemption = bundledExemptionFor(
      INTENTIONALLY_BUNDLED,
      new Set(['react', '@anthropic-ai/sdk']), // peers are independent of externals
    )
    const r = validateBundleExternals('SDK', runtimeDeps, brokenSdkExternals, sdkExemption)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('react')
  })

  test('a CLI-bundled-but-SDK-external package is still exempt in the CLI', () => {
    const cliExemption = bundledExemptionFor(INTENTIONALLY_BUNDLED, new Set())
    // CLI externals do not include react (it is bundled into the CLI).
    const r = validateBundleExternals('CLI', runtimeDeps, COMMON_EXTERNALS, cliExemption)
    expect(r.ok).toBe(true)
  })
})

describe('validateIntentionallyBundled', () => {
  const healthy: PkgDeps = {
    dependencies: { '@vscode/ripgrep': '^1' },
    peerDependencies: { react: '*', '@anthropic-ai/sdk': '*' },
    devDependencies: {
      chalk: '^5',
      zod: '^3',
      react: '^18',
      '@anthropic-ai/sdk': '^0',
    },
  }

  test('passes the real-shaped contract', () => {
    const r = validateIntentionallyBundled(healthy, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS)
    expect(r.ok).toBe(true)
  })

  test('FAILS when a bundled package is shipped as a runtime dependency', () => {
    const pkg: PkgDeps = {
      ...healthy,
      dependencies: { ...healthy.dependencies, chalk: '^5' },
    }
    const r = validateIntentionallyBundled(pkg, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/must not be in dependencies.*chalk/)
  })

  test('FAILS when a bundled-only package is declared as a peerDependency', () => {
    const pkg: PkgDeps = {
      ...healthy,
      peerDependencies: { ...healthy.peerDependencies, zod: '^3' }, // zod is not SDK-external
    }
    const r = validateIntentionallyBundled(pkg, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/peerDependencies.*zod/)
  })

  test('FAILS when a bundled package is missing from devDependencies', () => {
    const pkg: PkgDeps = {
      ...healthy,
      devDependencies: { zod: '^3', react: '^18', '@anthropic-ai/sdk': '^0' }, // chalk missing
    }
    const r = validateIntentionallyBundled(pkg, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/devDependencies.*chalk/)
  })

  test('FAILS when an SDK external drops out of peerDependencies', () => {
    const pkg: PkgDeps = {
      ...healthy,
      peerDependencies: { react: '*' }, // @anthropic-ai/sdk no longer a peer
    }
    const r = validateIntentionallyBundled(pkg, INTENTIONALLY_BUNDLED, SDK_ONLY_EXTERNALS)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/remain peerDependencies.*@anthropic-ai\/sdk/)
  })
})

describe('validateOptionalPeers', () => {
  test('passes when every peer is marked optional', () => {
    const pkg: PkgDeps = {
      peerDependencies: { react: '*', '@anthropic-ai/sdk': '*' },
      peerDependenciesMeta: {
        react: { optional: true },
        '@anthropic-ai/sdk': { optional: true },
      },
    }
    expect(validateOptionalPeers(pkg).ok).toBe(true)
  })

  test('FAILS when a peer loses its optional flag (warning-free install regresses)', () => {
    const pkg: PkgDeps = {
      peerDependencies: { react: '*', '@anthropic-ai/sdk': '*' },
      peerDependenciesMeta: { react: { optional: true } }, // @anthropic-ai/sdk no longer optional
    }
    const r = validateOptionalPeers(pkg)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('@anthropic-ai/sdk')
  })

  test('FAILS when peerDependenciesMeta is missing entirely', () => {
    const pkg: PkgDeps = { peerDependencies: { react: '*' } }
    expect(validateOptionalPeers(pkg).ok).toBe(false)
  })
})

describe('validateOptionalRuntimeExternals', () => {
  const OPTIONAL = ['sharp', 'google-auth-library', '@anthropic-ai/bedrock-sdk']
  const INDIRECTION_ONLY = ['@anthropic-ai/bedrock-sdk']
  const cli = ['sharp', 'google-auth-library']
  const sdk = ['sharp', 'google-auth-library']
  // All non-transitive optionals present as devDeps, so these cases isolate the
  // externals-placement behavior from the source-install (devDeps) check.
  const healthyDev: PkgDeps = {
    devDependencies: {
      sharp: '*',
      'google-auth-library': '*',
      '@anthropic-ai/bedrock-sdk': '*',
    },
  }

  test('passes when esbuild-visible optionals are external and indirection-only is not', () => {
    const r = validateOptionalRuntimeExternals(OPTIONAL, cli, sdk, INDIRECTION_ONLY, healthyDev)
    expect(r.ok).toBe(true)
  })

  test('FAILS when an optional external is dropped from the externals lists', () => {
    // The regression: sharp removed from CLI/SDK externals would get bundled.
    const r = validateOptionalRuntimeExternals(
      OPTIONAL,
      ['google-auth-library'], // sharp dropped from CLI
      sdk,
      INDIRECTION_ONLY,
      healthyDev,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/sharp.*CLI_EXTERNALS/)
  })

  test('FAILS when the indirection-only package leaks into the externals lists', () => {
    // @anthropic-ai/bedrock-sdk as external would re-expose its static @aws-sdk import.
    const r = validateOptionalRuntimeExternals(
      OPTIONAL,
      [...cli, '@anthropic-ai/bedrock-sdk'],
      sdk,
      INDIRECTION_ONLY,
      healthyDev,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/bedrock-sdk.*must NOT/)
  })

  test('FAILS on a stray indirection-only entry not in the optional set', () => {
    const r = validateOptionalRuntimeExternals(OPTIONAL, cli, sdk, ['not-optional-pkg'], healthyDev)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('not-optional-pkg')
  })

  test('FAILS when an optional external is shipped in dependencies', () => {
    const pkg: PkgDeps = { dependencies: { sharp: '^0.33' } }
    const r = validateOptionalRuntimeExternals(OPTIONAL, cli, sdk, INDIRECTION_ONLY, pkg)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/must not be shipped.*sharp/)
  })

  test('FAILS when an optional external is shipped as a peerDependency', () => {
    const pkg: PkgDeps = { peerDependencies: { 'google-auth-library': '*' } }
    const r = validateOptionalRuntimeExternals(OPTIONAL, cli, sdk, INDIRECTION_ONLY, pkg)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/must not be shipped.*google-auth-library/)
  })

  test('FAILS when a non-transitive optional external drops out of devDependencies', () => {
    // sharp is directly imported, so it must be a devDependency for source builds.
    const pkg: PkgDeps = {
      devDependencies: { 'google-auth-library': '*', '@anthropic-ai/bedrock-sdk': '*' }, // sharp missing
    }
    const r = validateOptionalRuntimeExternals(
      OPTIONAL,
      cli,
      sdk,
      INDIRECTION_ONLY,
      pkg,
      ['@example/transitive-optional'], // unrelated transitive exemption
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/missing from devDependencies.*sharp/)
  })

  test('exempts transitive optional externals from the devDependencies check', () => {
    const pkg: PkgDeps = {
      devDependencies: {
        sharp: '*',
        'google-auth-library': '*',
        '@anthropic-ai/bedrock-sdk': '*',
      },
    }
    // Synthetic transitive optionals are exempt when another optional package
    // guarantees them in source installs.
    const r = validateOptionalRuntimeExternals(
      [...OPTIONAL, '@example/transitive-optional'],
      [...cli, '@example/transitive-optional'],
      [...sdk, '@example/transitive-optional'],
      INDIRECTION_ONLY,
      pkg,
      ['@example/transitive-optional'],
    )
    expect(r.ok).toBe(true)
  })
})

describe('validateRuntimeDependencyContract', () => {
  const CONTRACT = { '@example/a': '1.2.3', '@example/b': '4.5.6' } as const

  test('passes when dependencies exactly match the contract', () => {
    const r = validateRuntimeDependencyContract(
      { dependencies: { '@example/a': '1.2.3', '@example/b': '4.5.6' } },
      CONTRACT,
    )
    expect(r.ok).toBe(true)
  })

  test('FAILS on a new runtime dependency not in the contract', () => {
    const r = validateRuntimeDependencyContract(
      {
        dependencies: {
          '@example/a': '1.2.3',
          '@example/b': '4.5.6',
          'left-pad': '1.0.0',
        },
      },
      CONTRACT,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/not in RUNTIME_DEPENDENCY_CONTRACT.*left-pad/)
  })

  test('FAILS when a contract entry is missing from dependencies', () => {
    const r = validateRuntimeDependencyContract(
      { dependencies: { '@example/a': '1.2.3' } },
      CONTRACT,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/missing from dependencies.*@example\/b/)
  })

  test('FAILS when a caret range sneaks back in', () => {
    const r = validateRuntimeDependencyContract(
      { dependencies: { '@example/a': '^1.2.3', '@example/b': '4.5.6' } },
      CONTRACT,
    )
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@example\/a/)
  })

  test('the real package.json satisfies the real contract', async () => {
    const pkg = (await import('../package.json')) as PkgDeps
    expect(validateRuntimeDependencyContract(pkg).ok).toBe(true)
  })
})

describe('validateInstallHygieneFields', () => {
  const CLEAN = { engines: { node: '>=22.0.0' } }

  test('passes for a clean manifest', () => {
    expect(validateInstallHygieneFields(CLEAN).ok).toBe(true)
  })

  test('FAILS on consumer-run install hooks but allows publisher hooks', () => {
    const withPublisherHooks = validateInstallHygieneFields({
      ...CLEAN,
      scripts: { prepack: 'npm run build', prepare: 'true' },
    })
    expect(withPublisherHooks.ok).toBe(true)

    const withPostinstall = validateInstallHygieneFields({
      ...CLEAN,
      scripts: { postinstall: 'node download.js' },
    })
    expect(withPostinstall.ok).toBe(false)
    expect(withPostinstall.errors.join(' ')).toMatch(/postinstall/)
  })

  test('FAILS on a funding field', () => {
    const r = validateInstallHygieneFields({ ...CLEAN, funding: 'https://x' })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/funding/)
  })

  test('FAILS when engines.node drifts from the contract', () => {
    const r = validateInstallHygieneFields({ engines: { node: '>=24.0.0' } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/EBADENGINE/)
  })

  test('the real package.json passes install hygiene', async () => {
    const pkg = await import('../package.json')
    expect(validateInstallHygieneFields(pkg as never).ok).toBe(true)
  })
})
