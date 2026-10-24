import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const REPO_ROOT = join(import.meta.dir, '..')
const BIN_PATH = join(REPO_ROOT, 'bin', 'openclaude')
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).version
const EXPECTED_VERSION_OUTPUT = `${PACKAGE_VERSION} (OpenClaude)\n`

type LauncherResult = {
  status: number | null
  stdout: string
  stderr: string
}

// Simulates distro layouts (e.g. Arch AUR /usr/lib/openclaude) that install
// only the launcher file without its bin/*.mjs siblings (issue #2255). The
// launcher must still boot via its inline fallbacks instead of crashing with
// ERR_MODULE_NOT_FOUND before any code runs.
function assertBuiltCli(): void {
  const builtCli = join(REPO_ROOT, 'dist', 'cli.mjs')
  if (!existsSync(builtCli)) {
    throw new Error(
      `dist/cli.mjs not found at ${builtCli} — run \`bun run build\` before these tests.`,
    )
  }
}

function makeSiblinglessLayout(): string {
  assertBuiltCli()
  const root = mkdtempSync(join(tmpdir(), 'openclaude-siblingless-'))
  const binDir = join(root, 'bin')
  mkdirSync(binDir, { recursive: true })
  copyFileSync(BIN_PATH, join(binDir, 'openclaude'))
  // 'junction' is ignored on POSIX and lets Windows create directory links
  // without elevated privileges.
  symlinkSync(join(REPO_ROOT, 'dist'), join(root, 'dist'), 'junction')
  symlinkSync(
    join(REPO_ROOT, 'node_modules'),
    join(root, 'node_modules'),
    'junction',
  )
  return root
}

function runLauncher(
  root: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): LauncherResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    OPENCLAUDE_CONFIG_DIR: join(root, 'config'),
  }
  // Heap-related env must not leak in from the outer environment: the parity
  // cases assert exact resolved values, and an inherited override (or a
  // relaunch toggle) would silently change what the launcher resolves. Each
  // case's env is applied after this cleanup, so explicit overrides still win.
  for (const key of [
    'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB',
    'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE',
    'OPENCLAUDE_MAX_MEMORY_MB',
    'OPENCLAUDE_HEAP_RELAUNCHED',
    'OPENCLAUDE_DISABLE_HEAP_RELAUNCH',
  ]) {
    delete env[key]
  }
  if (!Object.hasOwn(extraEnv, 'NODE_OPTIONS')) delete env.NODE_OPTIONS
  Object.assign(env, extraEnv)
  const result = spawnSync('node', [join(root, 'bin', 'openclaude'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function runSiblingless(
  root: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
): LauncherResult {
  return runLauncher(root, args, extraEnv)
}

function withSiblinglessLayout(fn: (root: string) => void): void {
  const root = makeSiblinglessLayout()
  try {
    fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The inline fallbacks in bin/openclaude duplicate bin/heap-limit.mjs, so the
// same inputs must resolve to the same heap through both paths. The stub
// bundle below reports what the launcher resolved instead of starting the CLI,
// letting a full-sibling layout and a siblingless layout be compared
// observably without changing resolver behavior.
const HEAP_OBSERVER_STUB = `console.log(JSON.stringify({ heapMb: process.env.OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB ?? null, maxMemoryMb: process.env.OPENCLAUDE_MAX_MEMORY_MB ?? null, heapFlag: process.execArgv.find(a => a.startsWith('--max-old-space-size=')) ?? null }))\n`

function makeHeapObserverLayout(withSiblings: boolean): string {
  assertBuiltCli()
  const tag = withSiblings ? 'full' : 'siblingless'
  const root = mkdtempSync(join(tmpdir(), `openclaude-heap-parity-${tag}-`))
  const binDir = join(root, 'bin')
  const distDir = join(root, 'dist')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(distDir, { recursive: true })
  copyFileSync(BIN_PATH, join(binDir, 'openclaude'))
  if (withSiblings) {
    for (const helper of ['heap-limit.mjs', 'node-compile-cache.mjs']) {
      copyFileSync(join(REPO_ROOT, 'bin', helper), join(binDir, helper))
    }
  }
  writeFileSync(join(distDir, 'cli.mjs'), HEAP_OBSERVER_STUB)
  return root
}

type HeapParityCase = {
  name: string
  args: string[]
  env: NodeJS.ProcessEnv
  expectedMb: string | null
  expectedMaxMemoryMb?: string
}

const HEAP_PARITY_CASES: HeapParityCase[] = [
  { name: 'default heap', args: [], env: {}, expectedMb: '8192' },
  {
    name: 'env MB override',
    args: [],
    env: { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '4096' },
    expectedMb: '4096',
  },
  {
    name: '--max-memory wins over percentage',
    args: ['--max-memory=1536'],
    env: { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE: '90' },
    expectedMb: '1536',
    expectedMaxMemoryMb: '1536',
  },
  // Percentage outcomes depend on host RAM, so these cases assert fallback /
  // canonical equality rather than an exact value.
  {
    name: 'argv percentage',
    args: ['--max-old-space-size-percentage=50'],
    env: {},
    expectedMb: null,
  },
  {
    name: 'spaced argv percentage',
    args: ['--max-old-space-size-percentage', '25'],
    env: {},
    expectedMb: null,
  },
  {
    name: 'env percentage',
    args: [],
    env: { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE: '50' },
    expectedMb: null,
  },
  {
    name: 'invalid percentage falls back to env MB',
    args: ['--max-old-space-size-percentage=0'],
    env: { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '4096' },
    expectedMb: '4096',
  },
]

describe('openclaude launcher without bin/*.mjs siblings', () => {
  test('boots --version with silent stderr', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(root, ['--version'])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(result.stderr).toBe('')
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        'ERR_MODULE_NOT_FOUND',
      )
    })
  })

  test('boots --help with silent stderr', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(root, ['--help'])
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/usage/i)
      expect(result.stderr).toBe('')
    })
  })

  test('strips launcher-only percentage flags without siblings', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(root, [
        '--max-old-space-size-percentage=50',
        '--version',
      ])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "unknown option '--max-old-space-size-percentage=50'",
      )
    })
  })

  test('strips launcher-only flags without siblings when relaunch is disabled', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(
        root,
        ['--max-old-space-size-percentage=50', '--version'],
        { OPENCLAUDE_DISABLE_HEAP_RELAUNCH: '1' },
      )
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "unknown option '--max-old-space-size-percentage=50'",
      )
    })
  })

  test('accepts --max-memory without siblings', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(root, ['--max-memory=1024', '--version'])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(result.stderr).toBe('')
    })
  })

  test('honors heap env overrides without siblings', () => {
    withSiblinglessLayout(root => {
      const mbResult = runSiblingless(
        root,
        ['--version'],
        { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '4096' },
      )
      expect(mbResult.status).toBe(0)
      expect(mbResult.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(mbResult.stderr).toBe('')

      const percentageResult = runSiblingless(
        root,
        ['--version'],
        { OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE: '50' },
      )
      expect(percentageResult.status).toBe(0)
      expect(percentageResult.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(percentageResult.stderr).toBe('')
    })
  })

  test('strips spaced launcher-only percentage flags without siblings', () => {
    withSiblinglessLayout(root => {
      const result = runSiblingless(root, [
        '--max-old-space-size-percentage',
        '50',
        '--version',
      ])
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
      expect(`${result.stdout}${result.stderr}`).not.toContain('unknown option')
    })
  })
})

describe('openclaude launcher heap fallback/canonical parity', () => {
  for (const parityCase of HEAP_PARITY_CASES) {
    test(`resolves the same heap with and without siblings: ${parityCase.name}`, () => {
      const full = makeHeapObserverLayout(true)
      const siblingless = makeHeapObserverLayout(false)
      try {
        const canonical = runLauncher(full, parityCase.args, parityCase.env)
        const fallback = runLauncher(
          siblingless,
          parityCase.args,
          parityCase.env,
        )
        expect(canonical.status).toBe(0)
        expect(fallback.status).toBe(0)
        expect(fallback.stdout).toBe(canonical.stdout)
        expect(fallback.stderr).toBe('')
        if (parityCase.expectedMb !== null) {
          const observed = JSON.parse(canonical.stdout)
          expect(observed.heapMb).toBe(parityCase.expectedMb)
          expect(observed.heapFlag).toBe(
            `--max-old-space-size=${parityCase.expectedMb}`,
          )
        }
        if (parityCase.expectedMaxMemoryMb !== undefined) {
          expect(JSON.parse(canonical.stdout).maxMemoryMb).toBe(
            parityCase.expectedMaxMemoryMb,
          )
        }
      } finally {
        rmSync(full, { recursive: true, force: true })
        rmSync(siblingless, { recursive: true, force: true })
      }
    })
  }
})
