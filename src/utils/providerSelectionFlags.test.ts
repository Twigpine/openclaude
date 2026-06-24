import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PROVIDER_SELECTION_FLAGS,
  hasAnyTruthyProviderSelectionFlag,
  hasConflictingProviderFlag,
} from './providerSelectionFlags.js'

/**
 * Feature toggles that share the CLAUDE_CODE_USE_ prefix but do not select
 * an API provider. Add here only if the flag genuinely is not a provider.
 */
const NON_PROVIDER_USE_FLAGS = new Set([
  'CLAUDE_CODE_USE_CCR_V', // versioned CCR flag prefix (CLAUDE_CODE_USE_CCR_V2…)
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'CLAUDE_CODE_USE_NATIVE_FILE_SEARCH',
  'CLAUDE_CODE_USE_POWERSHELL_TOOL',
])

describe('PROVIDER_SELECTION_FLAGS parity', () => {
  // These two tests synchronously walk the whole src/ tree, which is I/O-bound
  // and can exceed Bun's 5000 ms default under parallel test load (~8.5 s cold,
  // ~0.2 s isolated). A generous explicit timeout keeps them from flaking in CI.
  test('every CLAUDE_CODE_USE_* provider flag in src is registered', () => {
    const srcRoot = join(import.meta.dir, '..')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    const found = new Set<string>()

    for (const relPath of glob.scanSync({ cwd: srcRoot })) {
      // Only the runtime code must recognise selection flags. Test fixtures
      // may set arbitrary flags (e.g. a placeholder the code never reads), so
      // they are excluded from the parity scan.
      if (/\.test\.[tj]sx?$/.test(relPath)) continue
      const content = readFileSync(join(srcRoot, relPath), 'utf8')
      for (const match of content.matchAll(/CLAUDE_CODE_USE_[A-Z_]+/g)) {
        found.add(match[0])
      }
    }

    const registered = new Set<string>(PROVIDER_SELECTION_FLAGS)
    const unregistered = [...found].filter(
      flag =>
        !registered.has(flag) &&
        ![...NON_PROVIDER_USE_FLAGS].some(allowed => flag.startsWith(allowed)),
    )

    // A new provider flag must be added to PROVIDER_SELECTION_FLAGS so the
    // startup-selection, env-propagation and cleanup paths all recognise it
    // (this is how gemini-vertex drifted out of the reference lists).
    expect(unregistered).toEqual([])
  }, 30000)

  test('registered flags are actually consumed outside the registry definition', () => {
    const srcRoot = join(import.meta.dir, '..')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    let allContent = ''
    for (const relPath of glob.scanSync({ cwd: srcRoot })) {
      // Exclude the registry itself and every test file so the assertion proves
      // the flag is referenced by real runtime code, not just by its own
      // definition or by a fixture — otherwise the check is tautological.
      if (
        relPath.endsWith('providerSelectionFlags.ts') ||
        /\.test\.[tj]sx?$/.test(relPath)
      ) {
        continue
      }
      allContent += readFileSync(join(srcRoot, relPath), 'utf8')
    }
    for (const flag of PROVIDER_SELECTION_FLAGS) {
      expect(allContent).toContain(flag)
    }
  }, 30000)
})

describe('hasAnyTruthyProviderSelectionFlag', () => {
  test('returns false for an empty env', () => {
    expect(hasAnyTruthyProviderSelectionFlag({})).toBe(false)
  })

  // Every registered flag must be recognised by the shared helper — this is the
  // guard that prevents a flag-agnostic call site (e.g. isUsing3PServices) from
  // silently omitting a provider, as Gemini Vertex was before the registry.
  test.each([...PROVIDER_SELECTION_FLAGS])(
    'recognises %s when truthy',
    flag => {
      expect(hasAnyTruthyProviderSelectionFlag({ [flag]: '1' })).toBe(true)
    },
  )

  test('ignores falsy values', () => {
    expect(
      hasAnyTruthyProviderSelectionFlag({ CLAUDE_CODE_USE_OPENAI: '0' }),
    ).toBe(false)
  })
})

describe('hasConflictingProviderFlag', () => {
  test('returns false for an empty env', () => {
    expect(hasConflictingProviderFlag({})).toBe(false)
  })

  test('treats any present flag (even bare) as a conflict', () => {
    expect(hasConflictingProviderFlag({ CLAUDE_CODE_USE_GEMINI: '' })).toBe(true)
  })

  test('does not flag the excepted active flag', () => {
    expect(
      hasConflictingProviderFlag(
        { CLAUDE_CODE_USE_GEMINI_VERTEX: '1' },
        'CLAUDE_CODE_USE_GEMINI_VERTEX',
      ),
    ).toBe(false)
  })

  test('flags a different provider even when the active flag is set', () => {
    expect(
      hasConflictingProviderFlag(
        {
          CLAUDE_CODE_USE_GEMINI_VERTEX: '1',
          CLAUDE_CODE_USE_OPENAI: '1',
        },
        'CLAUDE_CODE_USE_GEMINI_VERTEX',
      ),
    ).toBe(true)
  })
})
