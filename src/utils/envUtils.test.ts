import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearCACertsCache, getCACertificates } from './caCerts.js'
import { hasNodeOption } from './envUtils.js'

// Required-value options accepted by the supported Node 24/26 runtimes.
const testValueOptions = [
  ['--test-isolation', 'none'],
  ['--experimental-test-isolation', 'none'],
  ['--test-global-setup', './setup.js'],
  ['--test-rerun-failures', './failures.json'],
] as const

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
    // Node only treats ASCII spaces as delimiters: a tab with no spaces keeps
    // the input as one token, so neither option is reported (verified on Node
    // 22.23.2 where the tab-joined value is rejected as a bad option).
    { name: 'tab without spaces does not delimit (second flag)', nodeOptions: '--use-system-ca\t--max-old-space-size=4096', flag: '--max-old-space-size', expected: false },
    { name: 'tab without spaces does not delimit (first flag)', nodeOptions: '--use-system-ca\t--max-old-space-size=4096', flag: '--use-system-ca', expected: false },

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
    { name: '--max-old-space-size exact without value fails closed (Node requires an argument)', nodeOptions: '--max-old-space-size', flag: '--max-old-space-size', expected: false },
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

    // Required option value that looks flag-like: Node rejects the whole
    // value (e.g. `--title requires an argument`), so nothing is active.
    { name: '--title with flag-like value fails closed', nodeOptions: '--title --use-system-ca', flag: '--use-system-ca', expected: false },
    { name: '--title with flag-like value fails closed for the option itself', nodeOptions: '--title --use-system-ca', flag: '--title', expected: false },
    { name: '--title with real value still detects later flag', nodeOptions: '--title openclaude --use-system-ca', flag: '--use-system-ca', expected: true },

    // Malformed quoting fails closed (Node rejects the whole value)
    { name: 'unterminated double quote is not a flag', nodeOptions: '"--use-system-ca', flag: '--use-system-ca', expected: false },
    { name: 'unterminated double quote with trailing escape is not a flag', nodeOptions: '"--use-system-ca\\', flag: '--use-system-ca', expected: false },
    { name: 'unterminated double quote is not a flag (--use-openssl-ca)', nodeOptions: '"--use-openssl-ca', flag: '--use-openssl-ca', expected: false },
    { name: 'unterminated double quote with trailing escape is not a flag (--use-openssl-ca)', nodeOptions: '"--use-openssl-ca\\', flag: '--use-openssl-ca', expected: false },
    { name: 'malformed leading flag does not leak later flag', nodeOptions: '"--use-system-ca --use-openssl-ca', flag: '--use-openssl-ca', expected: false },

    // Ordered CA state: later occurrences win (equals-positive forms)
    { name: '--use-system-ca=1 then --no-use-system-ca disables', nodeOptions: '--use-system-ca=1 --no-use-system-ca', flag: '--use-system-ca', expected: false },
    { name: '--no-use-system-ca then --use-system-ca=1 re-enables', nodeOptions: '--no-use-system-ca --use-system-ca=1', flag: '--use-system-ca', expected: true },
    { name: '--use-openssl-ca=1 then --no-use-openssl-ca disables', nodeOptions: '--use-openssl-ca=1 --no-use-openssl-ca', flag: '--use-openssl-ca', expected: false },
    { name: '--no-use-openssl-ca then --use-openssl-ca=1 re-enables', nodeOptions: '--no-use-openssl-ca --use-openssl-ca=1', flag: '--use-openssl-ca', expected: true },
    // Exact-positive ordering baseline (last wins)
    { name: '--use-system-ca then --no-use-system-ca disables (exact)', nodeOptions: '--use-system-ca --no-use-system-ca', flag: '--use-system-ca', expected: false },
    { name: '--no-use-system-ca then --use-system-ca re-enables (exact)', nodeOptions: '--no-use-system-ca --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: '--use-openssl-ca then --no-use-openssl-ca disables (exact)', nodeOptions: '--use-openssl-ca --no-use-openssl-ca', flag: '--use-openssl-ca', expected: false },
    { name: '--no-use-openssl-ca then --use-openssl-ca re-enables (exact)', nodeOptions: '--no-use-openssl-ca --use-openssl-ca', flag: '--use-openssl-ca', expected: true },
    { name: 'negation alone does not enable positive', nodeOptions: '--no-use-system-ca', flag: '--use-system-ca', expected: false },
    { name: 'negation with =value disables equals-positive', nodeOptions: '--use-system-ca=1 --no-use-system-ca=0', flag: '--use-system-ca', expected: false },
    { name: 'negated spelling is queryable', nodeOptions: '--no-use-system-ca', flag: '--no-use-system-ca', expected: true },
    { name: 'negated spelling is not active after a later positive', nodeOptions: '--no-use-system-ca --use-system-ca', flag: '--no-use-system-ca', expected: false },
    { name: 'negated spelling is active after a later negation', nodeOptions: '--use-system-ca --no-use-system-ca', flag: '--no-use-system-ca', expected: true },
    { name: 'negated spelling is absent when the option is not present', nodeOptions: '--max-old-space-size=4096', flag: '--no-use-system-ca', expected: false },
    { name: 'negated spelling is absent for an unrelated stream', nodeOptions: '--title foo', flag: '--no-use-system-ca', expected: false },

    // Required-value failures invalidate the whole stream even when the CA
    // target appears before the error (Node exits, so nothing is active).
    { name: '--use-system-ca=1 then --title at EOF fails closed', nodeOptions: '--use-system-ca=1 --title', flag: '--use-system-ca', expected: false },
    { name: '--use-openssl-ca=1 then --title at EOF fails closed', nodeOptions: '--use-openssl-ca=1 --title', flag: '--use-openssl-ca', expected: false },
    { name: '--use-system-ca=1 then --title= fails closed', nodeOptions: '--use-system-ca=1 --title=', flag: '--use-system-ca', expected: false },
    { name: '--use-openssl-ca=1 then --title= fails closed', nodeOptions: '--use-openssl-ca=1 --title=', flag: '--use-openssl-ca', expected: false },
    { name: '--use-system-ca=1 then --conditions at EOF fails closed', nodeOptions: '--use-system-ca=1 --conditions', flag: '--use-system-ca', expected: false },
    { name: '--use-system-ca=1 then --conditions= fails closed', nodeOptions: '--use-system-ca=1 --conditions=', flag: '--use-system-ca', expected: false },
    { name: '--use-system-ca=1 then --conditions flag-like fails closed', nodeOptions: '--use-system-ca=1 --conditions -x', flag: '--use-system-ca', expected: false },
    { name: '--conditions flag-like then CA fails closed', nodeOptions: '--conditions -x --use-system-ca=1', flag: '--use-system-ca', expected: false },

    // Required-value aliases follow the same rule (error before and after target).
    { name: '--loader flag-like then CA fails closed', nodeOptions: '--loader --use-system-ca=1', flag: '--use-system-ca', expected: false },
    { name: 'CA then --loader at EOF fails closed', nodeOptions: '--use-system-ca=1 --loader', flag: '--use-system-ca', expected: false },
    { name: 'CA then --loader= fails closed', nodeOptions: '--use-system-ca=1 --loader=', flag: '--use-system-ca', expected: false },
    { name: '--loader flag-like then openssl CA fails closed', nodeOptions: '--loader --use-openssl-ca=1', flag: '--use-openssl-ca', expected: false },
    { name: 'openssl CA then --loader at EOF fails closed', nodeOptions: '--use-openssl-ca=1 --loader', flag: '--use-openssl-ca', expected: false },
    { name: '--inspect-port flag-like then CA fails closed', nodeOptions: '--inspect-port --use-system-ca=1', flag: '--use-system-ca', expected: false },
    { name: 'CA then --inspect-port at EOF fails closed', nodeOptions: '--use-system-ca=1 --inspect-port', flag: '--use-system-ca', expected: false },
    { name: 'CA then --inspect-port= fails closed', nodeOptions: '--use-system-ca=1 --inspect-port=', flag: '--use-system-ca', expected: false },
    { name: '--inspect-port flag-like then openssl CA fails closed', nodeOptions: '--inspect-port --use-openssl-ca=1', flag: '--use-openssl-ca', expected: false },
    { name: '--inspect-publish-uid flag-like then CA fails closed', nodeOptions: '--inspect-publish-uid --use-system-ca=1', flag: '--use-system-ca', expected: false },
    { name: 'CA then --inspect-publish-uid at EOF fails closed', nodeOptions: '--use-system-ca=1 --inspect-publish-uid', flag: '--use-system-ca', expected: false },
    { name: '--inspect-publish-uid flag-like then openssl CA fails closed', nodeOptions: '--inspect-publish-uid --use-openssl-ca=1', flag: '--use-openssl-ca', expected: false },
    { name: 'CA then --title flag-like value fails closed (openssl)', nodeOptions: '--use-openssl-ca=1 --title --use-system-ca', flag: '--use-openssl-ca', expected: false },

    // Valid required-value forms preserve later CA detection.
    { name: '--title with real value preserves later CA', nodeOptions: '--title foo --use-system-ca=1', flag: '--use-system-ca', expected: true },
    { name: '--title=foo preserves later CA', nodeOptions: '--title=foo --use-system-ca=1', flag: '--use-system-ca', expected: true },
    { name: '--loader=foo preserves later CA', nodeOptions: '--loader=foo --use-system-ca=1', flag: '--use-system-ca', expected: true },
    { name: '--title=--use-system-ca inline flag-like value is valid (no CA)', nodeOptions: '--title=--use-system-ca', flag: '--use-system-ca', expected: false },

    // --experimental-import-meta-resolve is boolean: following CA stays visible.
    { name: 'boolean import-meta-resolve then CA stays visible', nodeOptions: '--experimental-import-meta-resolve --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: 'boolean import-meta-resolve then openssl CA stays visible', nodeOptions: '--experimental-import-meta-resolve --use-openssl-ca', flag: '--use-openssl-ca', expected: true },
    { name: 'boolean import-meta-resolve then equals CA stays visible', nodeOptions: '--experimental-import-meta-resolve --use-system-ca=1', flag: '--use-system-ca', expected: true },

    // V8-owned heap flags have their own value grammar: the value must be
    // attached with `=`, an empty inline value is tolerated by V8 (Node starts
    // and only warns), and a separate value leaves the bare flag in front of
    // V8, which rejects it.
    { name: 'empty inline max-old-space-size keeps CA enabled', nodeOptions: '--use-system-ca --max-old-space-size=', flag: '--use-system-ca', expected: true },
    { name: 'empty inline max-semi-space-size keeps CA enabled', nodeOptions: '--use-system-ca --max-semi-space-size=', flag: '--use-system-ca', expected: true },
    { name: 'empty inline max-old-space-size keeps openssl CA enabled', nodeOptions: '--use-openssl-ca --max-old-space-size=', flag: '--use-openssl-ca', expected: true },
    { name: 'empty inline max-semi-space-size keeps openssl CA enabled', nodeOptions: '--use-openssl-ca --max-semi-space-size=', flag: '--use-openssl-ca', expected: true },
    { name: 'separated max-old-space-size value fails closed', nodeOptions: '--use-system-ca=1 --max-old-space-size 4096', flag: '--use-system-ca', expected: false },
    { name: 'separated max-semi-space-size value fails closed', nodeOptions: '--use-system-ca=1 --max-semi-space-size 16', flag: '--use-system-ca', expected: false },
    { name: 'separated max-old-space-size value fails closed (openssl)', nodeOptions: '--use-openssl-ca=1 --max-old-space-size 4096', flag: '--use-openssl-ca', expected: false },
    { name: 'separated stack-trace-limit value fails closed', nodeOptions: '--use-system-ca=1 --stack-trace-limit 10', flag: '--use-system-ca', expected: false },
    { name: 'empty inline stack-trace-limit fails closed', nodeOptions: '--use-system-ca=1 --stack-trace-limit=', flag: '--use-system-ca', expected: false },
    { name: 'inline stack-trace-limit value keeps CA enabled', nodeOptions: '--use-system-ca=1 --stack-trace-limit=10', flag: '--use-system-ca', expected: true },
    { name: 'inline stack-trace-limit value keeps openssl CA enabled', nodeOptions: '--use-openssl-ca=1 --stack-trace-limit=10', flag: '--use-openssl-ca', expected: true },
    { name: 'empty inline max-old-space-size-percentage fails closed', nodeOptions: '--use-system-ca=1 --max-old-space-size-percentage=', flag: '--use-system-ca', expected: false },
    { name: 'separated max-old-space-size-percentage value keeps CA enabled', nodeOptions: '--use-system-ca=1 --max-old-space-size-percentage 50', flag: '--use-system-ca', expected: true },
    { name: 'inline max-old-space-size-percentage value keeps CA enabled', nodeOptions: '--use-system-ca=1 --max-old-space-size-percentage=50', flag: '--use-system-ca', expected: true },

    // The inspector family: `--inspect-port` (and its `--debug-port` alias)
    // require a value, while the bare `--inspect`/`--inspect-brk`/
    // `--inspect-wait` forms are booleans. The `=`-forms expand through
    // `--inspect-port`, so an empty inline value is rejected by Node.
    { name: '--inspect-port without value fails closed', nodeOptions: '--use-system-ca=1 --inspect-port', flag: '--use-system-ca', expected: false },
    { name: '--debug-port without value fails closed', nodeOptions: '--use-system-ca=1 --debug-port', flag: '--use-system-ca', expected: false },
    { name: '--inspect= without value fails closed', nodeOptions: '--use-system-ca=1 --inspect=', flag: '--use-system-ca', expected: false },
    { name: '--inspect-brk= without value fails closed', nodeOptions: '--use-system-ca=1 --inspect-brk=', flag: '--use-system-ca', expected: false },
    { name: '--inspect-wait= without value fails closed', nodeOptions: '--use-system-ca=1 --inspect-wait=', flag: '--use-system-ca', expected: false },
    { name: '--inspect-brk-node= without value fails closed', nodeOptions: '--use-system-ca=1 --inspect-brk-node=', flag: '--use-system-ca', expected: false },
    { name: '--inspect-publish-uid without value fails closed', nodeOptions: '--use-system-ca=1 --inspect-publish-uid', flag: '--use-system-ca', expected: false },
    { name: 'bare --inspect keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect', flag: '--use-system-ca', expected: true },
    { name: 'bare --inspect-brk keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect-brk', flag: '--use-system-ca', expected: true },
    { name: 'bare --inspect-wait keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect-wait', flag: '--use-system-ca', expected: true },
    { name: '--inspect= with value keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect=9229', flag: '--use-system-ca', expected: true },
    { name: '--inspect-brk= with value keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect-brk=9229', flag: '--use-system-ca', expected: true },
    { name: '--inspect-wait= with value keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect-wait=9229', flag: '--use-system-ca', expected: true },
    { name: '--inspect-port= with value keeps CA enabled', nodeOptions: '--use-system-ca=1 --inspect-port=9229', flag: '--use-system-ca', expected: true },
    { name: '--debug-port= with value keeps CA enabled', nodeOptions: '--use-system-ca=1 --debug-port=9229', flag: '--use-system-ca', expected: true },
    { name: '--debug-port without value fails closed (openssl)', nodeOptions: '--use-openssl-ca=1 --debug-port', flag: '--use-openssl-ca', expected: false },
    { name: '--inspect= without value fails closed (openssl)', nodeOptions: '--use-openssl-ca=1 --inspect=', flag: '--use-openssl-ca', expected: false },

    // Node stops parsing options at the first argument that is not an option,
    // so the ignored suffix neither enables a CA flag nor creates a
    // required-value error, while the preceding CA state is preserved.
    { name: 'ignored suffix keeps preceding CA state', nodeOptions: '--use-system-ca foo --title', flag: '--use-system-ca', expected: true },
    { name: 'ignored suffix keeps preceding openssl CA state', nodeOptions: '--use-openssl-ca foo --title', flag: '--use-openssl-ca', expected: true },
    { name: 'ignored suffix keeps preceding CA state (equals)', nodeOptions: '--use-system-ca=1 foo', flag: '--use-system-ca', expected: true },
    { name: 'consumed value is not an ignored suffix', nodeOptions: '--title foo --use-system-ca', flag: '--use-system-ca', expected: true },
    { name: 'CA token inside the ignored suffix is not enabled', nodeOptions: 'foo --use-system-ca=1', flag: '--use-system-ca', expected: false },
    { name: 'CA token inside the ignored suffix is not enabled (openssl)', nodeOptions: 'foo --use-openssl-ca=1', flag: '--use-openssl-ca', expected: false },
    { name: 'lone hyphen stops option parsing', nodeOptions: '--use-system-ca -', flag: '--use-system-ca', expected: true },
    { name: 'lone hyphen stops option parsing before the CA flag', nodeOptions: '- --use-system-ca', flag: '--use-system-ca', expected: false },
    { name: '-- is not allowed in NODE_OPTIONS', nodeOptions: '--use-system-ca --', flag: '--use-system-ca', expected: false },
    { name: '-- before the CA flag is not allowed in NODE_OPTIONS', nodeOptions: '-- --use-system-ca', flag: '--use-system-ca', expected: false },
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

  test('supported test options consume their values before later CA flags', () => {
    for (const [option, value] of testValueOptions) {
      for (const flag of ['--use-system-ca', '--use-openssl-ca']) {
        for (const spelling of [`${option} ${value}`, `${option}=${value}`]) {
          process.env.NODE_OPTIONS = `${spelling} ${flag}`
          expect(hasNodeOption(flag)).toBe(true)
          process.env.NODE_OPTIONS = `${flag} ${spelling}`
          expect(hasNodeOption(flag)).toBe(true)
        }
      }
    }
  })

  test('supported test options reject missing, empty, flag-like and negated values', () => {
    for (const [option] of testValueOptions) {
      for (const flag of ['--use-system-ca', '--use-openssl-ca']) {
        for (const nodeOptions of [
          `${flag}=1 ${option}`,
          `${flag}=1 ${option}=`,
          `${option}= ${flag}=1`,
          `${option} ${flag}=1`,
          `${flag}=1 --no-${option.slice(2)}`,
          `--no-${option.slice(2)}=none ${flag}=1`,
        ]) {
          process.env.NODE_OPTIONS = nodeOptions
          expect(hasNodeOption(flag)).toBe(false)
        }
      }
    }
  })

  test('does not leak NODE_OPTIONS between cases (sanity)', () => {
    // This test runs after the table; afterEach should have restored original.
    // Set a distinct value and verify it does not persist to next test via afterEach,
    // but here we just verify the helper reads current env.
    process.env.NODE_OPTIONS = '--use-system-ca'
    expect(hasNodeOption('--use-system-ca')).toBe(true)
    expect(hasNodeOption('--use-openssl-ca')).toBe(false)
  })
})

describe('hasNodeOption CA selection via cache rebuild', () => {
  const originalNodeOptions = process.env.NODE_OPTIONS
  const originalExtraCerts = process.env.NODE_EXTRA_CA_CERTS

  afterEach(() => {
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions
    }
    if (originalExtraCerts === undefined) {
      delete process.env.NODE_EXTRA_CA_CERTS
    } else {
      process.env.NODE_EXTRA_CA_CERTS = originalExtraCerts
    }
    clearCACertsCache()
  })

  beforeEach(() => {
    delete process.env.NODE_OPTIONS
    delete process.env.NODE_EXTRA_CA_CERTS
    clearCACertsCache()
  })

  function getEffectiveCACerts(nodeOptions: string): string[] | undefined {
    // Simulates the settings-reload path: applyConfigEnvironmentVariables()
    // replaces process.env.NODE_OPTIONS, then clears CA/proxy/mTLS caches and
    // rebuilds global agents. getCACertificates() must reflect the effective
    // ordered CA state after the rebuild.
    process.env.NODE_OPTIONS = nodeOptions
    clearCACertsCache()
    return getCACertificates()
  }

  test('malformed unterminated quote selects bundled roots (undefined)', () => {
    expect(getEffectiveCACerts('"--use-system-ca')).toBeUndefined()
  })

  test('malformed trailing escape selects bundled roots (undefined)', () => {
    expect(getEffectiveCACerts('"--use-system-ca\\')).toBeUndefined()
  })

  test('equals-positive then negation selects bundled roots (undefined)', () => {
    expect(
      getEffectiveCACerts('--use-system-ca=1 --no-use-system-ca'),
    ).toBeUndefined()
    expect(
      getEffectiveCACerts('--use-openssl-ca=1 --no-use-openssl-ca'),
    ).toBeUndefined()
  })

  test('required value with flag-like text selects bundled roots (undefined)', () => {
    expect(getEffectiveCACerts('--title --use-system-ca')).toBeUndefined()
  })

  test('negation then equals-positive selects system roots (defined)', () => {
    expect(
      getEffectiveCACerts('--no-use-system-ca --use-system-ca=1'),
    ).toBeDefined()
    expect(
      getEffectiveCACerts('--no-use-openssl-ca --use-openssl-ca=1'),
    ).toBeDefined()
  })

  test('target-before-error selects bundled roots (undefined)', () => {
    expect(getEffectiveCACerts('--use-system-ca=1 --title')).toBeUndefined()
    expect(getEffectiveCACerts('--use-openssl-ca=1 --title')).toBeUndefined()
    expect(getEffectiveCACerts('--use-system-ca=1 --title=')).toBeUndefined()
    expect(getEffectiveCACerts('--use-system-ca=1 --loader')).toBeUndefined()
    expect(
      getEffectiveCACerts('--use-system-ca=1 --inspect-port'),
    ).toBeUndefined()
    expect(
      getEffectiveCACerts('--use-system-ca=1 --inspect-publish-uid'),
    ).toBeUndefined()
  })

  test('alias error-before-target selects bundled roots (undefined)', () => {
    expect(getEffectiveCACerts('--loader --use-system-ca=1')).toBeUndefined()
    expect(
      getEffectiveCACerts('--inspect-port --use-system-ca=1'),
    ).toBeUndefined()
    expect(
      getEffectiveCACerts('--inspect-publish-uid --use-openssl-ca=1'),
    ).toBeUndefined()
  })

  test('boolean import-meta-resolve preserves system roots (defined)', () => {
    expect(
      getEffectiveCACerts('--experimental-import-meta-resolve --use-system-ca'),
    ).toBeDefined()
    expect(
      getEffectiveCACerts(
        '--experimental-import-meta-resolve --use-openssl-ca',
      ),
    ).toBeDefined()
  })
})

describe('hasNodeOption CA source selection', () => {
  const originalNodeOptions = process.env.NODE_OPTIONS
  const originalExtraCerts = process.env.NODE_EXTRA_CA_CERTS
  const nodeRequire = createRequire(import.meta.url)
  const tls = nodeRequire('tls') as typeof import('tls')
  const originalGetCACertificates = tls.getCACertificates

  // The bundled and system stores can hold the same certificates, so
  // "defined" alone cannot prove which root source the selector picked.
  // Stubbing the system store makes the choice observable.
  const SYSTEM_SENTINEL = 'SYSTEM-CA-SENTINEL'
  const EXTRA_CA_SENTINEL = 'EXTRA-CA-SENTINEL'
  let extraCertsDir: string | undefined

  beforeEach(() => {
    delete process.env.NODE_OPTIONS
    delete process.env.NODE_EXTRA_CA_CERTS
    tls.getCACertificates = (type) =>
      type === 'system' ? [SYSTEM_SENTINEL] : []
    extraCertsDir = mkdtempSync(join(tmpdir(), 'openclaude-ca-'))
    writeFileSync(join(extraCertsDir, 'extra.pem'), EXTRA_CA_SENTINEL)
    clearCACertsCache()
  })

  afterEach(() => {
    tls.getCACertificates = originalGetCACertificates
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions
    }
    if (originalExtraCerts === undefined) {
      delete process.env.NODE_EXTRA_CA_CERTS
    } else {
      process.env.NODE_EXTRA_CA_CERTS = originalExtraCerts
    }
    if (extraCertsDir) {
      rmSync(extraCertsDir, { recursive: true, force: true })
      extraCertsDir = undefined
    }
    clearCACertsCache()
  })

  function getEffectiveCACerts(nodeOptions: string): string[] | undefined {
    // Simulates the settings-reload path: applyConfigEnvironmentVariables()
    // replaces process.env.NODE_OPTIONS, then clears CA/proxy/mTLS caches and
    // rebuilds global agents.
    process.env.NODE_OPTIONS = nodeOptions
    clearCACertsCache()
    return getCACertificates()
  }

  test('active CA flag selects the system root store', () => {
    expect(getEffectiveCACerts('--use-system-ca')).toEqual([SYSTEM_SENTINEL])
    expect(getEffectiveCACerts('--use-openssl-ca')).toEqual([SYSTEM_SENTINEL])
    expect(getEffectiveCACerts('--use-system-ca=1')).toEqual([SYSTEM_SENTINEL])
  })

  test('inactive CA flag keeps the runtime default (undefined)', () => {
    expect(getEffectiveCACerts('--no-use-system-ca')).toBeUndefined()
    expect(
      getEffectiveCACerts('--use-system-ca=1 --no-use-system-ca'),
    ).toBeUndefined()
  })

  test('invalid streams keep the runtime default (undefined)', () => {
    // Missing required value, flag-like value, malformed quoting, an invalid
    // V8 value form and `--` all make Node reject the whole value.
    expect(getEffectiveCACerts('--use-system-ca=1 --title')).toBeUndefined()
    expect(getEffectiveCACerts('--title --use-system-ca')).toBeUndefined()
    expect(getEffectiveCACerts('"--use-system-ca')).toBeUndefined()
    expect(
      getEffectiveCACerts('--use-system-ca=1 --max-old-space-size 4096'),
    ).toBeUndefined()
    expect(getEffectiveCACerts('--use-system-ca=1 --inspect=')).toBeUndefined()
    expect(getEffectiveCACerts('--use-system-ca --')).toBeUndefined()
  })

  test('accepted empty inline heap value keeps the system store', () => {
    // V8 tolerates an empty inline value for its own heap flags, so Node
    // starts with the CA flag enabled.
    expect(
      getEffectiveCACerts('--use-system-ca --max-old-space-size='),
    ).toEqual([SYSTEM_SENTINEL])
    expect(
      getEffectiveCACerts('--use-system-ca --max-semi-space-size='),
    ).toEqual([SYSTEM_SENTINEL])
  })

  test('valid inspector forms keep the system store', () => {
    // Bare inspector booleans and populated inline endpoints are accepted by
    // Node, so the CA flag stays enabled.
    expect(getEffectiveCACerts('--use-system-ca=1 --inspect')).toEqual([
      SYSTEM_SENTINEL,
    ])
    expect(getEffectiveCACerts('--use-system-ca=1 --inspect=9229')).toEqual([
      SYSTEM_SENTINEL,
    ])
    expect(getEffectiveCACerts('--use-system-ca=1 --inspect-port=9229')).toEqual([
      SYSTEM_SENTINEL,
    ])
  })

  test('active CA flag selects the system store plus the extra certificate', () => {
    process.env.NODE_EXTRA_CA_CERTS = join(extraCertsDir!, 'extra.pem')
    expect(getEffectiveCACerts('--use-system-ca')).toEqual([
      SYSTEM_SENTINEL,
      EXTRA_CA_SENTINEL,
    ])
    expect(getEffectiveCACerts('--use-openssl-ca')).toEqual([
      SYSTEM_SENTINEL,
      EXTRA_CA_SENTINEL,
    ])
  })

  test('supported test option values preserve the explicit CA source with extra certificates', () => {
    process.env.NODE_EXTRA_CA_CERTS = join(extraCertsDir!, 'extra.pem')
    for (const [option, value] of testValueOptions) {
      for (const flag of ['--use-system-ca', '--use-openssl-ca']) {
        for (const spelling of [`${option} ${value}`, `${option}=${value}`]) {
          for (const nodeOptions of [`${spelling} ${flag}`, `${flag} ${spelling}`]) {
            expect(getEffectiveCACerts(nodeOptions)).toEqual([
              SYSTEM_SENTINEL,
              EXTRA_CA_SENTINEL,
            ])
          }
        }
        expect(getEffectiveCACerts(`${flag}=1 ${option}=`)).toEqual([
          ...tls.rootCertificates,
          EXTRA_CA_SENTINEL,
        ])
      }
    }
  })

  test('inactive CA flag selects the bundled roots plus the extra certificate', () => {
    process.env.NODE_EXTRA_CA_CERTS = join(extraCertsDir!, 'extra.pem')
    const bundled = tls.rootCertificates
    const certs = getEffectiveCACerts('--use-system-ca --no-use-system-ca')
    expect(certs).toBeDefined()
    expect(certs![0]).toBe(bundled[0])
    expect(certs!.length).toBe(bundled.length + 1)
    expect(certs![certs!.length - 1]).toBe(EXTRA_CA_SENTINEL)
  })

  test('ignored suffix preserves the preceding CA state', () => {
    // Node stops parsing options at `foo`, so the trailing `--title` never
    // becomes a required-value error and the CA flag stays enabled.
    expect(getEffectiveCACerts('--use-system-ca foo --title')).toEqual([
      SYSTEM_SENTINEL,
    ])
  })
})
