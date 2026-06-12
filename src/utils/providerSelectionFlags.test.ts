import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVIDER_SELECTION_FLAGS } from './providerSelectionFlags.js'

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
  test('every CLAUDE_CODE_USE_* provider flag in src is registered', () => {
    const srcRoot = join(import.meta.dir, '..')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    const found = new Set<string>()

    for (const relPath of glob.scanSync({ cwd: srcRoot })) {
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
  })

  test('registered flags actually appear in src', () => {
    const srcRoot = join(import.meta.dir, '..')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    let allContent = ''
    for (const relPath of glob.scanSync({ cwd: srcRoot })) {
      allContent += readFileSync(join(srcRoot, relPath), 'utf8')
    }
    for (const flag of PROVIDER_SELECTION_FLAGS) {
      expect(allContent).toContain(flag)
    }
  })
})
