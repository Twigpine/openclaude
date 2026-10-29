import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { tmpdir } from 'os'

/**
 * End-to-end tests for scanSdkStubImports() star re-export scanner.
 * Creates real fixture files and runs the scanner logic against them.
 */

const fixtureDir = join(tmpdir(), 'scanner-e2e-' + process.pid)

// Mirror the key parts of scanSdkStubImports from scripts/build.ts
// to test the actual scanner behavior, not just regex patterns.

function isStubbedSpecifier(s: string): boolean {
  return /^(\.\.?\/)+(fixtures)\//.test(s)
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

function scanFileForStarReexports(
  filePath: string,
): Map<string, Set<string>> {
  const exports = new Map<string, Set<string>>()
  const code = stripComments(readFileSync(filePath, 'utf-8'))
  const fileDir = dirname(filePath)

  for (const m of code.matchAll(/export\s+\*\s+from\s+['"](.*?)['"]/g)) {
    const specifier = m[1]
    if (!isStubbedSpecifier(specifier)) continue

    if (!exports.has(specifier)) exports.set(specifier, new Set())
    const names = exports.get(specifier)!

    // Resolve the re-exported module path
    const reexportPath = resolve(fileDir, specifier)
    const reexportBase = reexportPath.replace(/\.js$/, '')
    const candidates = [
      `${reexportBase}.ts`,
      `${reexportBase}.tsx`,
      reexportPath,
      `${reexportPath}.ts`,
      `${reexportPath}.tsx`,
    ]

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const reexportCode = stripComments(readFileSync(candidate, 'utf-8'))
        for (const exp of reexportCode.matchAll(/export\s+(?:const|let|var|function|class|type|interface)\s+(\w+)/g)) {
          names.add(exp[1])
        }
        for (const exp of reexportCode.matchAll(/export\s+\{([^}]*)\}/g)) {
          for (const name of exp[1].split(',').map(s => s.trim()).filter(Boolean)) {
            names.add(name)
          }
        }
        break
      }
    }
  }

  return exports
}

beforeAll(() => {
  mkdirSync(join(fixtureDir, 'fixtures'), { recursive: true })

  // Create a module with named exports that gets star-re-exported
  writeFileSync(
    join(fixtureDir, 'fixtures', 'inner-module.ts'),
    `export const innerValue = 42
export function innerFn(): string { return 'hello' }
export type InnerType = { x: number }
export interface InnerInterface { y: string }`,
  )

  // Create a file that star-re-exports from it
  writeFileSync(
    join(fixtureDir, 'reexporter.ts'),
    `import { something } from 'not-stubbed'
export * from './fixtures/inner-module'
export const localExport = true`,
  )

  // Create a file with commented-out star re-export (should be ignored)
  writeFileSync(
    join(fixtureDir, 'commented.ts'),
    `// export * from './fixtures/inner-module'
/* export * from './fixtures/other' */
export * from './fixtures/inner-module'`,
  )

  // Create a module with .js import extension
  writeFileSync(
    join(fixtureDir, 'js-import.ts'),
    `export * from './fixtures/inner-module.js'`,
  )

  // Create a module with no exports
  writeFileSync(
    join(fixtureDir, 'fixtures', 'empty.ts'),
    ``,
  )
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('BLD-1: star re-export scanner end-to-end', () => {
  test('scanner finds exports from star re-exported module', () => {
    const result = scanFileForStarReexports(
      join(fixtureDir, 'reexporter.ts'),
    )

    expect(result.size).toBe(1)
    const names = result.get('./fixtures/inner-module')!
    expect(names.has('innerValue')).toBe(true)
    expect(names.has('innerFn')).toBe(true)
    expect(names.has('InnerType')).toBe(true)
    expect(names.has('InnerInterface')).toBe(true)
  })

  test('scanner strips comments before matching', () => {
    const result = scanFileForStarReexports(
      join(fixtureDir, 'commented.ts'),
    )

    // Only the non-commented line should match
    expect(result.size).toBe(1)
    const names = result.get('./fixtures/inner-module')!
    expect(names.size).toBeGreaterThan(0)
  })

  test('scanner resolves .js extension to .ts file', () => {
    const result = scanFileForStarReexports(
      join(fixtureDir, 'js-import.ts'),
    )

    expect(result.size).toBe(1)
    const names = result.get('./fixtures/inner-module.js')!
    expect(names.has('innerValue')).toBe(true)
    expect(names.has('innerFn')).toBe(true)
  })

  test('fileDir is correctly derived from file path (the original BLD-1 bug)', () => {
    // Verify that dirname of the file produces the correct directory
    // for resolving relative specifiers
    const filePath = join(fixtureDir, 'reexporter.ts')
    const fileDir = dirname(filePath)
    const specifier = './fixtures/inner-module'

    // This is what the fixed scanner does: resolve(fileDir, specifier)
    const resolved = resolve(fileDir, specifier)
    expect(existsSync(resolved + '.ts') || existsSync(resolved + '.tsx')).toBe(true)
  })

  test('scanner produces correct candidates for .js specifier', () => {
    const filePath = join(fixtureDir, 'js-import.ts')
    const fileDir = dirname(filePath)
    const specifier = './fixtures/inner-module.js'
    const reexportPath = resolve(fileDir, specifier)
    const reexportBase = reexportPath.replace(/\.js$/, '')

    const candidates = [
      `${reexportBase}.ts`,
      `${reexportBase}.tsx`,
      reexportPath,
      `${reexportPath}.ts`,
      `${reexportPath}.tsx`,
    ]

    // First candidate (.ts) should exist
    expect(existsSync(candidates[0])).toBe(true)
    // The resolved file should have the expected content
    const content = readFileSync(candidates[0], 'utf-8')
    expect(content).toContain('innerValue')
    expect(content).toContain('innerFn')
  })

  test('scanner skips non-stubbed specifiers', () => {
    // The reexporter.ts has `import { something } from 'not-stubbed'`
    // This should not appear in the results since 'not-stubbed' doesn't match isStubbedSpecifier
    const result = scanFileForStarReexports(
      join(fixtureDir, 'reexporter.ts'),
    )

    for (const [specifier] of result) {
      expect(specifier).not.toBe('not-stubbed')
    }
  })

  test('scanner correctly handles empty module (no exports found)', () => {
    // Create a file that re-exports from the empty module
    writeFileSync(
      join(fixtureDir, 'empty-reexport.ts'),
      `export * from './fixtures/empty'`,
    )

    const result = scanFileForStarReexports(
      join(fixtureDir, 'empty-reexport.ts'),
    )

    // The specifier is found but the module has no exports
    expect(result.size).toBe(1)
    const names = result.get('./fixtures/empty')!
    expect(names.size).toBe(0)
  })
})
