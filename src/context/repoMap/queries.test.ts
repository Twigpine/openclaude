import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { getBundledQuery } from './queries.js'
import type { SupportedLanguage } from './types.js'

const __dirname = join(fileURLToPath(import.meta.url), '..')

describe('bundled query drift guard', () => {
  test.each<SupportedLanguage>([
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'c',
    'cpp',
  ])(
    '%s: bundled query matches the .scm source file byte-for-byte',
    (language) => {
      // Normalize CRLF → LF so Windows checkouts (where Git may convert line
      // endings) still pass the byte-for-byte drift guard against the
      // LF-only TypeScript string constants in queries.ts.
      const fromFile = readFileSync(
        join(__dirname, 'queries', `${language}-tags.scm`),
        'utf-8',
      ).replace(/\r\n/g, '\n')
      const bundled = getBundledQuery(language)
      expect(bundled).not.toBeNull()
      expect(bundled).toBe(fromFile)
    },
  )

  test('tsx reuses the TypeScript query with the TSX grammar', () => {
    expect(getBundledQuery('tsx')).toBe(getBundledQuery('typescript'))
  })

  test('returns null for unknown language', () => {
    expect(getBundledQuery('unknown' as SupportedLanguage)).toBeNull()
  })
})
