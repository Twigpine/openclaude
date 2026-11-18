import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { extractDraggedFilePaths } from './dragDropPaths.js'

function escapeFinderDraggedPath(filePath: string): string {
  return filePath.replace(/([\\ ])/g, '\\$1')
}

describe('extractDraggedFilePaths', () => {
  // Paths that exist on any system.
  const thisFile = import.meta.path
  // Resolve package.json relative to this test file so it works
  // regardless of process.cwd() changes from other tests (e.g. xaiAuth).
  const packageJson = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')

  // Fixtures created synchronously at describe-load time (not in
  // `beforeAll`) so their paths are available to `test.each` tables,
  // which are built before any hook runs.
  const tmpDir = mkdtempSync(join(tmpdir(), 'dragdrop-test-'))
  const spacedFile = join(tmpDir, 'my file.txt')
  writeFileSync(spacedFile, 'test')
  const scopedDir = join(tmpDir, '@types')
  mkdirSync(scopedDir)
  const atSignFile = join(scopedDir, 'index.d.ts')
  writeFileSync(atSignFile, 'test')

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe('returns an empty array', () => {
    const emptyCases: Array<[string, string]> = [
      ['a non-absolute path', 'relative/path/file.ts'],
      ['a plain image path', '/Users/foo/image.png'],
      ['an uppercase image extension', '/Users/foo/SHOT.PNG'],
      ['a double-quoted image path', '"/Users/foo/shot.png"'],
      ['a single-quoted image path', "'/Users/foo/shot.jpg'"],
      ['regular prose text', 'hello world this is text'],
      ['a nonexistent absolute path', '/definitely/nonexistent/file.ts'],
      ['a single-quoted nonexistent path', "'/definitely/nonexistent.ts'"],
      ['an empty string', ''],
      ['whitespace only', '   \n  '],
      // Mixed-segment cases: all-or-nothing policy means a single bad
      // entry disqualifies the whole paste.
      ['a mix where one path does not exist', `${thisFile}\n/nonexistent/file.ts`],
      ['a mix where one segment is an image', `${thisFile}\n/Users/foo/shot.png`],
    ]
    test.each(emptyCases)('for %s', (_label, input) => {
      expect(extractDraggedFilePaths(input)).toEqual([])
    })
  })

  describe('resolves a single path', () => {
    const singleCases: Array<[string, string, string]> = [
      ['a plain absolute path', thisFile, thisFile],
      ['a double-quoted path', `"${thisFile}"`, thisFile],
      ['a single-quoted path', `'${thisFile}'`, thisFile],
      ['a path with leading/trailing whitespace', `  ${thisFile}  `, thisFile],
      // Realistic: dragging something under `node_modules/@types/...`.
      // `@` inside the path must not collide with the mention prefix
      // that the caller prepends downstream.
      ['a path containing an `@` segment', atSignFile, atSignFile],
    ]
    test.each(singleCases)('from %s', (_label, input, expected) => {
      expect(extractDraggedFilePaths(input)).toEqual([expected])
    })
  })

  describe('resolves multiple paths', () => {
    const multiCases: Array<[string, string, string[]]> = [
      [
        'newline-separated',
        `${thisFile}\n${packageJson}`,
        [thisFile, packageJson],
      ],
      [
        'space-separated (Finder drag)',
        `${thisFile} ${packageJson}`,
        [thisFile, packageJson],
      ],
      [
        'double-quoted and space-separated',
        `"${spacedFile}" "${packageJson}"`,
        [spacedFile, packageJson],
      ],
      [
        'single-quoted and space-separated',
        `'${spacedFile}' '${packageJson}'`,
        [spacedFile, packageJson],
      ],
      [
        'mixed quoted and unquoted',
        `${thisFile} "${spacedFile}"`,
        [thisFile, spacedFile],
      ],
    ]
    test.each(multiCases)('when input is %s', (_label, input, expected) => {
      expect(extractDraggedFilePaths(input)).toEqual(expected)
    })
  })

  test('escapeFinderDraggedPath escapes spaces and backslashes', () => {
    expect(escapeFinderDraggedPath('/tmp/my\\notes file.txt')).toBe(
      '/tmp/my\\\\notes\\ file.txt',
    )
  })

  // Backslash-escaped paths are a Finder/macOS + Linux convention — on
  // Windows the shell-escape step is skipped, so these cases do not apply.
  if (process.platform !== 'win32') {
    describe('handles backslash-escaped paths', () => {
      test('returns empty for an escaped image path', () => {
        // The image check must apply after escape stripping so Finder
        // image drags still route to the image paste handler.
        expect(extractDraggedFilePaths('/Users/foo/my\\ shot.png')).toEqual([])
      })

      test('resolves an escaped real file with a space in its name', () => {
        // Raw form matches what a terminal delivers on Finder drag.
        const escaped = escapeFinderDraggedPath(spacedFile)
        expect(extractDraggedFilePaths(escaped)).toEqual([spacedFile])
      })
    })
  }
})
