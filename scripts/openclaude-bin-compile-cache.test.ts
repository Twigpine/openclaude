import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

import { enableNodeCompileCacheIfAvailable } from '../bin/node-compile-cache.mjs'

const REPO_ROOT = join(import.meta.dir, '..')
const BIN_PATH = join(REPO_ROOT, 'bin', 'openclaude')
const INSTRUMENTATION_PATH = join(
  import.meta.dir,
  'fixtures',
  'instrument-node-compile-cache.mjs',
)
const PACKAGE_VERSION = JSON.parse(
  readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
).version
const EXPECTED_VERSION_OUTPUT = `${PACKAGE_VERSION} (OpenClaude)\n`

type LauncherResult = {
  status: number | null
  stdout: string
  stderr: string
}

function launcherEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    CI: '1',
    NO_COLOR: '1',
    ...overrides,
  }
  delete env.OPENCLAUDE_HEAP_RELAUNCHED
  delete env.OPENCLAUDE_DISABLE_HEAP_RELAUNCH
  if (!Object.hasOwn(overrides, 'NODE_OPTIONS')) delete env.NODE_OPTIONS
  if (!Object.hasOwn(overrides, 'NODE_COMPILE_CACHE')) delete env.NODE_COMPILE_CACHE
  if (!Object.hasOwn(overrides, 'NODE_DISABLE_COMPILE_CACHE')) delete env.NODE_DISABLE_COMPILE_CACHE
  return env
}

function runLauncher(
  env: NodeJS.ProcessEnv,
  nodeArgs: string[] = [],
): LauncherResult {
  const result = spawnSync('node', [...nodeArgs, BIN_PATH, '--version'], {
    cwd: REPO_ROOT,
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

function expectNormalVersion(result: LauncherResult): void {
  expect(result.status).toBe(0)
  expect(result.stdout).toBe(EXPECTED_VERSION_OUTPUT)
  expect(result.stderr).toBe('')
}

function nodeSupportsCompileCache(): boolean {
  return spawnSync(
    'node',
    ['-e', "process.exit(typeof require('node:module').enableCompileCache === 'function' ? 0 : 1)"],
  ).status === 0
}

function hasFileContent(path: string): boolean {
  if (!existsSync(path)) return false
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      if (hasFileContent(child)) return true
    } else {
      return true
    }
  }
  return false
}

describe('enableNodeCompileCacheIfAvailable', () => {
  test('leaves startup unchanged when the API is absent', () => {
    expect(() => enableNodeCompileCacheIfAvailable({})).not.toThrow()
  })

  test('invokes an available API exactly once without a directory', () => {
    const calls: unknown[][] = []
    enableNodeCompileCacheIfAvailable({
      enableCompileCache: (...args: unknown[]) => {
        calls.push(args)
        return { status: 1, directory: '/tmp/cache' }
      },
    })

    expect(calls).toEqual([[]])
  })

  test('ignores a failed status result', () => {
    expect(() => enableNodeCompileCacheIfAvailable({
      enableCompileCache: () => ({ status: 0, message: 'not writable' }),
    })).not.toThrow()
  })

  test('swallows unexpected implementation throws', () => {
    expect(() => enableNodeCompileCacheIfAvailable({
      enableCompileCache: () => {
        throw new Error('unexpected')
      },
    })).not.toThrow()
  })
})

describe('openclaude launcher compile cache', () => {
  test('does not inherit ambient NODE_OPTIONS into boundary launches', () => {
    const originalNodeOptions = process.env.NODE_OPTIONS
    try {
      process.env.NODE_OPTIONS = '--max-old-space-size=256 --expose-gc'
      expect(launcherEnv().NODE_OPTIONS).toBeUndefined()
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS
      else process.env.NODE_OPTIONS = originalNodeOptions
    }
  })

  test('the real absent binding remains non-fatal and silent', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude-compile-cache-absent-'))
    try {
      const result = runLauncher(
        launcherEnv({
          OPENCLAUDE_CONFIG_DIR: join(scratch, 'config'),
          OPENCLAUDE_TEST_COMPILE_CACHE_BEHAVIOR: 'absent',
        }),
        ['--import', INSTRUMENTATION_PATH],
      )
      expectNormalVersion(result)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  for (const behavior of ['success', 'failed-status', 'throw'] as const) {
    test(`the final importing process survives ${behavior} setup`, () => {
      if (!nodeSupportsCompileCache()) return
      const scratch = mkdtempSync(join(tmpdir(), `openclaude-compile-cache-${behavior}-`))
      const markerPath = join(scratch, 'calls.jsonl')
      try {
        const result = runLauncher(
          launcherEnv({
            OPENCLAUDE_CONFIG_DIR: join(scratch, 'config'),
            OPENCLAUDE_TEST_COMPILE_CACHE_BEHAVIOR: behavior,
            OPENCLAUDE_TEST_COMPILE_CACHE_MARKER: markerPath,
          }),
          ['--import', INSTRUMENTATION_PATH],
        )
        expectNormalVersion(result)

        const calls = readFileSync(markerPath, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line))
        expect(calls).toHaveLength(1)
        expect(calls[0]).toMatchObject({ heapRelaunched: true })
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    })
  }

  test('NODE_DISABLE_COMPILE_CACHE remains authoritative', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude-compile-cache-disabled-'))
    const cacheDir = join(scratch, 'cache')
    try {
      expectNormalVersion(runLauncher(launcherEnv({
        NODE_COMPILE_CACHE: cacheDir,
        NODE_DISABLE_COMPILE_CACHE: '1',
        OPENCLAUDE_CONFIG_DIR: join(scratch, 'config'),
      })))
      if (nodeSupportsCompileCache()) expect(hasFileContent(cacheDir)).toBe(false)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('a temporary NODE_COMPILE_CACHE gains content without changing output', () => {
    if (!nodeSupportsCompileCache()) return
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude-compile-cache-real-'))
    const cacheDir = join(scratch, 'cache')
    try {
      const env = launcherEnv({
        NODE_COMPILE_CACHE: cacheDir,
        OPENCLAUDE_CONFIG_DIR: join(scratch, 'config'),
      })
      expectNormalVersion(runLauncher(env))
      expectNormalVersion(runLauncher(env))
      expect(hasFileContent(cacheDir)).toBe(true)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})
