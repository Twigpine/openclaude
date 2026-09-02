import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { hasNodeOption } from './envUtils.js'

describe('hasNodeOption', () => {
  const originalNodeOptions = process.env.NODE_OPTIONS

  afterEach(() => {
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  beforeEach(() => {
    delete process.env.NODE_OPTIONS
  })

  // Table-driven regression coverage requested in PR #2188 review:
  // - exact and equals positives for both CA flags
  // - double-quoted positives
  // - literal single-quoted negatives (Node keeps single quotes literal)
  // - repeated whitespace / empty tokens
  // - --inspect vs --inspect-brk boundary
  // Each row restores NODE_OPTIONS after the case via afterEach.
  const cases: Array<{
    name: string
    nodeOptions: string | undefined
    flag: string
    expected: boolean
  }> = [
    // Undefined / empty
    { name: 'undefined NODE_OPTIONS returns false', nodeOptions: undefined, flag: '--use-system-ca', expected: false },
    { name: 'empty string returns false', nodeOptions: '', flag: '--use-system-ca', expected: false },
    { name: 'whitespace only returns false', nodeOptions: '   \t  ', flag: '--use-system-ca', expected: false },

    // --use-system-ca exact / equals
    { name: '--use-system-ca exact match', nodeOptions: '--use-system-ca', flag: '--use-system-ca', expected: true },
    { name: '--use-system-ca with =value', nodeOptions: '--use-system-ca=1', flag: '--use-system-ca', expected: true },
    { name: '--use-system-ca double-quoted exact', nodeOptions: '"--use-system-ca"', flag: '--use-system-ca', expected: true },
    { name: '--use-system-ca double-quoted with =value', nodeOptions: '"--use-system-ca=1"', flag: '--use-system-ca', expected: true },
    { name: "--use-system-ca single-quoted is literal (negative)", nodeOptions: "'--use-system-ca'", flag: '--use-system-ca', expected: false },
    { name: "--use-system-ca single-quoted with =value is literal (negative)", nodeOptions: "'--use-system-ca=1'", flag: '--use-system-ca', expected: false },

    // --use-openssl-ca exact / equals
    { name: '--use-openssl-ca exact match', nodeOptions: '--use-openssl-ca', flag: '--use-openssl-ca', expected: true },
    { name: '--use-openssl-ca with =value', nodeOptions: '--use-openssl-ca=1', flag: '--use-openssl-ca', expected: true },
    { name: '--use-openssl-ca double-quoted exact', nodeOptions: '"--use-openssl-ca"', flag: '--use-openssl-ca', expected: true },
    { name: "--use-openssl-ca single-quoted is literal (negative)", nodeOptions: "'--use-openssl-ca'", flag: '--use-openssl-ca', expected: false },

    // Repeated whitespace / multiple tokens
    { name: 'repeated whitespace between flags', nodeOptions: '  --use-system-ca   --use-openssl-ca  ', flag: '--use-system-ca', expected: true },
    { name: 'repeated whitespace second flag', nodeOptions: '  --use-system-ca   --use-openssl-ca  ', flag: '--use-openssl-ca', expected: true },
    { name: 'multiple spaces and tabs', nodeOptions: '--use-system-ca\t  --max-old-space-size=4096', flag: '--max-old-space-size', expected: true },
    { name: 'flag not present with repeated whitespace', nodeOptions: '  --use-system-ca   ', flag: '--use-openssl-ca', expected: false },

    // --inspect vs --inspect-brk boundary
    { name: '--inspect exact', nodeOptions: '--inspect', flag: '--inspect', expected: true },
    { name: '--inspect with =value', nodeOptions: '--inspect=0.0.0.0:9229', flag: '--inspect', expected: true },
    { name: '--inspect double-quoted with =value', nodeOptions: '"--inspect=0.0.0.0:9229"', flag: '--inspect', expected: true },
    { name: '--inspect-brk does not match --inspect (prefix without =)', nodeOptions: '--inspect-brk=9229', flag: '--inspect', expected: false },
    { name: '--inspect-brk exact matches itself', nodeOptions: '--inspect-brk=9229', flag: '--inspect-brk', expected: true },
    { name: '--inspect-brk exact', nodeOptions: '--inspect-brk', flag: '--inspect-brk', expected: true },
    { name: '--inspect does not match --inspect-brk', nodeOptions: '--inspect', flag: '--inspect-brk', expected: false },
    { name: '--inspect single-quoted is literal (negative)', nodeOptions: "'--inspect'", flag: '--inspect', expected: false },
    { name: '--inspect-brk single-quoted is literal (negative for --inspect)', nodeOptions: "'--inspect-brk=9229'", flag: '--inspect', expected: false },

    // --max-old-space-size (original PR motivation)
    { name: '--max-old-space-size with =value', nodeOptions: '--max-old-space-size=4096', flag: '--max-old-space-size', expected: true },
    { name: '--max-old-space-size double-quoted with =value', nodeOptions: '"--max-old-space-size=4096"', flag: '--max-old-space-size', expected: true },
    { name: "--max-old-space-size single-quoted is literal (negative)", nodeOptions: "'--max-old-space-size=4096'", flag: '--max-old-space-size', expected: false },
    { name: '--max-old-space-size exact without value', nodeOptions: '--max-old-space-size', flag: '--max-old-space-size', expected: true },
    { name: '--max-old-space-size not confused with prefix', nodeOptions: '--max-old-space-size-extra', flag: '--max-old-space-size', expected: false },

    // Mixed flags
    { name: 'mixed flags contains target', nodeOptions: '--experimental-vm-modules --max-old-space-size=4096 --inspect=9229', flag: '--max-old-space-size', expected: true },
    { name: 'mixed flags does not contain absent', nodeOptions: '--experimental-vm-modules --max-old-space-size=4096', flag: '--use-system-ca', expected: false },

    // Quoted option values must not create spurious flag tokens (Node quote grammar)
    { name: 'quoted value with option-like text is not a flag', nodeOptions: '--conditions "foo --use-system-ca bar"', flag: '--use-system-ca', expected: false },
    { name: 'quoted value with option-like text — explicit flag still matches', nodeOptions: '--conditions "foo --use-system-ca bar" --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: 'equals-quoted value with option-like text is not a flag', nodeOptions: '--title="foo --use-system-ca bar"', flag: '--use-system-ca', expected: false },
    { name: 'quoted value preserves other flag detection', nodeOptions: '--title="foo bar" --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: 'quoted value with --expose-gc inner text is not a flag', nodeOptions: '--conditions "foo --expose-gc bar"', flag: '--expose-gc', expected: false },
    { name: '--conditions value exactly --use-system-ca is not a flag', nodeOptions: '--conditions "--use-system-ca"', flag: '--use-system-ca', expected: false },
    { name: '--conditions escaped quote does not expose inner flag', nodeOptions: '--conditions "foo \\" --use-system-ca bar"', flag: '--use-system-ca', expected: false },
    { name: '--conditions escaped value still allows explicit flag after', nodeOptions: '--conditions "foo \\" --use-system-ca bar" --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: '--conditions with equals value is not a flag', nodeOptions: '--conditions=--use-system-ca', flag: '--use-system-ca', expected: false },
  ]

  for (const { name, nodeOptions, flag, expected } of cases) {
    test(name, () => {
      if (nodeOptions === undefined) {
        delete process.env.NODE_OPTIONS
      } else {
        process.env.NODE_OPTIONS = nodeOptions
      }
      expect(hasNodeOption(flag)).toBe(expected)
    })
  }

  test('does not leak NODE_OPTIONS between cases (sanity)', () => {
    // This test runs after the table; afterEach should have restored original.
    // Set a distinct value and verify it does not persist to next test via afterEach,
    // but here we just verify the helper reads current env.
    process.env.NODE_OPTIONS = '--use-system-ca'
    expect(hasNodeOption('--use-system-ca')).toBe(true)
    expect(hasNodeOption('--use-openssl-ca')).toBe(false)
  })
})
