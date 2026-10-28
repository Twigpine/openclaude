#!/usr/bin/env bun
/**
 * Parity check for `hasNodeOption()` against the Node runtime.
 *
 * `hasNodeOption()` models scoped NODE_OPTIONS syntax and flag state.
 * This script compares that answer with the Node runtime
 * itself instead of from the implementation's own assumptions: it runs a
 * matrix of NODE_OPTIONS values through `node` and compares the observed
 * CA-store selection with the helper's result.
 *
 * Usage:
 *   bun run scripts/check-node-options-parity.ts [--node <path>]
 *
 * The CA store is observed through `tls.getCACertificates('default')`: with
 * `--use-openssl-ca` the default store is empty, without it the bundled roots
 * are returned. A stream Node rejects leaves no option active, so the helper
 * must fail closed and report the flag as disabled.
 *
 * `tls.getCACertificates()` and `--use-system-ca` both landed in Node
 * v22.15.0, so that is the minimum runtime this script can measure against;
 * it exits with an error on anything older.
 *
 * Known divergence: Node rejects options it does not know ("--bogus is not
 * allowed in NODE_OPTIONS"). This helper models a curated set of options and
 * treats every other option as a boolean, so a stream containing an unknown
 * option is reported as accepted. Validating unknown or disallowed options
 * is out of scope for the helper.
 */
import { spawnSync } from 'child_process'
import { hasNodeOption } from '../src/utils/envUtils.js'

const args = process.argv.slice(2)

/**
 * Read an operand for an option. An absent option returns undefined; a
 * present option without a usable operand is a usage error, so it must not
 * silently fall back to a default.
 */
function argValue(name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('-')) {
    console.error(`${name} requires a value`)
    process.exit(2)
  }
  return value
}

// The Node probe and the matrix both observe `--use-openssl-ca`, so the flag
// is fixed: making it configurable would compare the runtime's answer for one
// flag against the helper's answer for another.
const flag = '--use-openssl-ca'

// The binary is passed as argv[0] with an argument array, never through a
// shell, so the path cannot be interpreted as a command.
const nodePath = argValue('--node') ?? process.env.NODE_BIN ?? 'node'

const nodeVersion = spawnSync(nodePath, ['--version'], { encoding: 'utf8' })
if (nodeVersion.status !== 0) {
  console.error(`Cannot run ${nodePath}. Pass --node <path> to a Node binary.`)
  process.exit(2)
}
const version = (nodeVersion.stdout ?? '').trim()
if (Number(version.match(/^v(\d+)/)?.[1] ?? 0) < 24) {
  console.warn(
    `Warning: ${nodePath} is ${version}; OpenClaude requires Node >= 24.22.1.`,
  )
}

// The observation method needs `tls.getCACertificates()`, which landed in
// Node v22.15.0 together with `--use-system-ca`. Without it every probe
// throws and the run would check nothing while still exiting successfully.
const probeSupport = spawnSync(
  nodePath,
  ['-p', "typeof require('tls').getCACertificates"],
  { encoding: 'utf8' },
)
if ((probeSupport.stdout ?? '').trim() !== 'function') {
  console.error(
    `${nodePath} (${version}) has no tls.getCACertificates(); the parity check needs Node >= 22.15.`,
  )
  process.exit(2)
}

type NodeOutcome =
  | 'rejected'
  | 'enabled'
  | 'disabled'
  | 'timeout'
  | 'runtime-error'

/**
 * Node rejects the NODE_OPTIONS *stream* for these diagnostics. Other
 * failures (a missing --loader module, an invalid enum value) happen after
 * the options were accepted, so they say nothing about the parser contract.
 */
const PARSE_ERROR_PATTERNS = [
  'requires an argument',
  'is not allowed in NODE_OPTIONS',
  'invalid value for NODE_OPTIONS',
  'bad option',
  'illegal value for flag',
  'out of bounds',
  'not allowed',
]

/** Ask Node what the CA flag would be for a given NODE_OPTIONS value. */
function nodeOutcome(nodeOptions: string): NodeOutcome {
  // NODE_EXTRA_CA_CERTS and NODE_USE_SYSTEM_CA add certificates to the
  // 'default' store, which would make the "empty store" signal unusable.
  const env = { ...process.env, NODE_OPTIONS: nodeOptions }
  delete env.NODE_EXTRA_CA_CERTS
  delete env.NODE_USE_SYSTEM_CA

  const result = spawnSync(
    nodePath,
    [
      '-p',
      "require('tls').getCACertificates('default').length === 0 ? 'enabled' : 'disabled'",
    ],
    {
      env,
      timeout: 10_000,
      encoding: 'utf8',
    },
  )
  if (result.error && (result.error as { code?: string }).code === 'ETIMEDOUT')
    return 'timeout'
  if (result.status !== 0) {
    const stderr = result.stderr ?? ''
    return PARSE_ERROR_PATTERNS.some((pattern) => stderr.includes(pattern))
      ? 'rejected'
      : 'runtime-error'
  }
  const stdout = (result.stdout ?? '').trim()
  if (stdout === 'enabled') return 'enabled'
  if (stdout === 'disabled') return 'disabled'
  return 'rejected'
}

/** What the helper reports for the same value. */
function helperOutcome(nodeOptions: string, target: string): NodeOutcome {
  const previous = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = nodeOptions
  try {
    return hasNodeOption(target) ? 'enabled' : 'disabled'
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previous
  }
}

const CA_FORMS = [
  '--use-openssl-ca',
  '--use-openssl-ca=1',
  '--use-openssl-ca=0',
  '--no-use-openssl-ca',
  '--use-openssl-ca --no-use-openssl-ca',
  '--no-use-openssl-ca --use-openssl-ca',
  '--use-openssl-ca=1 --no-use-openssl-ca=1',
  '--no-use-openssl-ca=1 --use-openssl-ca=1',
]

const CONSTRUCTS = [
  '--title',
  '--title=',
  '--title=foo',
  '--title --use-openssl-ca',
  '--title=--use-openssl-ca',
  '--conditions',
  '--conditions=',
  '--conditions=foo',
  '--conditions foo',
  '--conditions -x',
  '--test-isolation none',
  '--test-isolation=',
  '--test-isolation',
  '--test-global-setup ./setup.js',
  '--test-global-setup=',
  '--test-global-setup',
  '--test-rerun-failures ./failures.json',
  '--test-rerun-failures=',
  '--test-rerun-failures',
  '-C foo',
  '-C',
  '--loader',
  '--loader=',
  '--loader=foo',
  '--inspect-port',
  '--inspect-port=',
  '--inspect-port=9229',
  '--debug-port',
  '--debug-port=',
  '--debug-port=9229',
  '--inspect=',
  '--inspect=9229',
  '--inspect-brk=',
  '--inspect-brk=9229',
  '--inspect-wait=',
  '--inspect-wait=9229',
  '--inspect-brk-node=',
  '--inspect-publish-uid',
  '--inspect-publish-uid=stderr',
  '--max-old-space-size',
  '--max-old-space-size=',
  '--max-old-space-size=4096',
  '--max-old-space-size 4096',
  '--max-semi-space-size',
  '--max-semi-space-size=',
  '--max-semi-space-size=16',
  '--max-semi-space-size 16',
  '--max-old-space-size-percentage',
  '--max-old-space-size-percentage=',
  '--max-old-space-size-percentage=50',
  '--max-old-space-size-percentage 50',
  '--stack-trace-limit',
  '--stack-trace-limit=',
  '--stack-trace-limit=10',
  '--stack-trace-limit 10',
  '--experimental-import-meta-resolve',
  'foo',
  '-',
  '--',
  '"foo --use-openssl-ca bar"',
  '"--use-openssl-ca"',
  "'--use-openssl-ca'",
  '--use-openssl-ca\t',
  '\t--use-openssl-ca',
  '--title="foo --use-openssl-ca bar"',
  '--conditions="foo --use-openssl-ca bar"',
  '--conditions "foo \\" --use-openssl-ca bar"',
  '--conditions=--use-openssl-ca',
  '--title openclaude',
  '--experimental-vm-modules',
  '--enable-source-maps',
  '--enable-source-maps=',
  '--expose-gc',
  '--no-expose-gc',
  '--throw-deprecation',
  '--trace-warnings',
  '--no-warnings',
  '--max-http-header-size=16384',
  '--dns-result-order=verbatim',
  '--dns-result-order=bogus',
  '--unhandled-rejections=strict',
  '--unhandled-rejections=bogus',
  '--report-directory=out',
]

const matrix = new Set<string>(CA_FORMS)
for (const construct of CONSTRUCTS) {
  matrix.add(`${construct} --use-openssl-ca`)
  matrix.add(`--use-openssl-ca ${construct}`)
  matrix.add(`--use-openssl-ca=1 ${construct}`)
  matrix.add(`${construct} --use-openssl-ca=1`)
}

let failures = 0
let checked = 0
let runtimeErrors = 0
let timeouts = 0
for (const nodeOptions of matrix) {
  const expected = nodeOutcome(nodeOptions)
  if (expected === 'timeout') {
    // Node started and is waiting for a debugger (`--inspect-brk`,
    // `--inspect-wait`), so the option stream was accepted but the CA state
    // cannot be observed.
    timeouts++
    continue
  }
  if (expected === 'runtime-error') {
    runtimeErrors++
    continue
  }
  checked++
  // A stream Node rejects leaves no option active, so the helper must fail
  // closed and report the flag as disabled.
  const expectedState = expected === 'rejected' ? 'disabled' : expected
  const actual = helperOutcome(nodeOptions, flag)
  if (expectedState !== actual) {
    failures++
    console.log(
      `MISMATCH node=${expected.padEnd(9)} helper=${actual.padEnd(9)} ${JSON.stringify(nodeOptions)}`,
    )
  }

  // The sibling CA flag shares the parser, so a rejected stream must make it
  // fail closed as well.
  if (expected === 'rejected') {
    const sibling = '--use-system-ca'
    if (helperOutcome(nodeOptions, sibling) !== 'disabled') {
      failures++
      console.log(
        `MISMATCH sibling ${sibling} did not fail closed for ${JSON.stringify(nodeOptions)}`,
      )
    }
  }
}

console.log(
  `\nchecked=${checked} mismatches=${failures} runtime-errors=${runtimeErrors} timeouts=${timeouts} (node=${version}, flag=${flag})`,
)

// A run that checked nothing must not report success.
if (checked === 0) {
  console.error('No case was checked; the parity result is meaningless.')
  process.exit(1)
}
process.exit(failures === 0 ? 0 : 1)
