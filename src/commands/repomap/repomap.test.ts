import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { invalidateCache } from '../../context/repoMap/index.js'
import { getCwdState, setCwdState } from '../../bootstrap/state.js'
import { call, parseArgs, runRepoMapCommand } from './repomap.js'
import type { CacheStats, RepoMapResult } from '../../context/repoMap/index.js'

const SAMPLE_RESULT: RepoMapResult = {
  map: 'main.ts:\n  export function main(): string',
  cacheHit: false,
  buildTimeMs: 12,
  fileCount: 1,
  totalFileCount: 1,
  tokenCount: 42,
}

function fakeDeps(overrides: Partial<{
  buildRepoMap: (options: {
    root: string
    maxTokens: number
    focusFiles?: string[]
    focusSymbols?: string[]
  }) => Promise<RepoMapResult>
  invalidateCache: () => void
  getCacheStats: () => CacheStats
}> = {}) {
  return Promise.resolve({
    buildRepoMap: async () => SAMPLE_RESULT,
    invalidateCache: () => {},
    getCacheStats: () => ({
      cacheDir: '/tmp/cache',
      cacheFile: null,
      entryCount: 0,
      exists: false,
    }),
    ...overrides,
  })
}

async function runTextCommand(args: string, root: string): Promise<string> {
  const result = await runRepoMapCommand(args, root)
  return textValue(result)
}

function textValue(result: Awaited<ReturnType<typeof runRepoMapCommand>>): string {
  if (result.type !== 'text') {
    throw new Error(`/repomap must return type:'text', got ${result.type}`)
  }
  return result.value
}

describe('/repomap argument parsing', () => {
  test('defaults to 2048 tokens with no flags', () => {
    const result = parseArgs('')
    expect(result.tokens).toBe(2048)
    expect(result.focus).toEqual([])
    expect(result.invalidate).toBe(false)
    expect(result.stats).toBe(false)
    expect(result.error).toBeNull()
  })

  test('parses --tokens flag', () => {
    const result = parseArgs('--tokens 4096')
    expect(result.tokens).toBe(4096)
  })

  test('rejects --tokens below 256', () => {
    const result = parseArgs('--tokens 100')
    expect(result.tokens).toBe(2048) // stays at the default
    expect(result.error).toBe(
      '--tokens expects a whole number between 256 and 16384 (got "100")',
    )
  })

  test('rejects --tokens above 16384', () => {
    const result = parseArgs('--tokens 20000')
    expect(result.tokens).toBe(2048) // stays at the default
    expect(result.error).toBe(
      '--tokens expects a whole number between 256 and 16384 (got "20000")',
    )
  })

  test('rejects a non-numeric --tokens value instead of silently ignoring it', () => {
    // parseInt('4096abc', 10) used to return 4096, and 'abc' used to leave the
    // default in place with no feedback.
    for (const value of ['4096abc', 'abc', '40.96', '-4096']) {
      const result = parseArgs(`--tokens ${value}`)
      expect(result.tokens).toBe(2048)
      expect(result.error).toContain('--tokens expects a whole number')
    }
  })

  test('reports a --tokens flag with no value', () => {
    const result = parseArgs('--tokens')
    expect(result.tokens).toBe(2048)
    expect(result.error).toBe('--tokens expects a value')
  })

  test('parses the --flag=value form', () => {
    const result = parseArgs(
      '--tokens=4096 --focus=src/tools/ --focus-symbols=buildTool',
    )
    expect(result.tokens).toBe(4096)
    expect(result.focus).toEqual(['src/tools/'])
    expect(result.focusSymbols).toEqual(['buildTool'])
    expect(result.error).toBeNull()
  })

  test('rejects an empty inline value', () => {
    expect(parseArgs('--tokens=').error).toBe('--tokens expects a value')
    expect(parseArgs('--focus=').error).toBe('--focus expects a value')
  })

  test('rejects an unknown flag instead of ignoring it', () => {
    const result = parseArgs('--tokens 4096 --tokenss 512')
    // The valid argument is still parsed; the unknown one is reported.
    expect(result.tokens).toBe(4096)
    expect(result.error).toBe('Unknown argument "--tokenss"')
  })

  test('rejects a bare argument instead of ignoring it', () => {
    const result = parseArgs('--stats extra')
    expect(result.stats).toBe(true)
    expect(result.error).toBe('Unknown argument "extra"')
  })

  test('rejects a value on a flag that takes none', () => {
    expect(parseArgs('--stats=yes').error).toBe('--stats takes no value (got "yes")')
    expect(parseArgs('--invalidate=1').error).toBe(
      '--invalidate takes no value (got "1")',
    )
  })

  test('parses --focus flag', () => {
    const result = parseArgs('--focus src/tools/')
    expect(result.focus).toEqual(['src/tools/'])
  })

  test('parses quoted --focus paths with spaces', () => {
    const result = parseArgs('--focus "src/my dir" --tokens 4096')
    expect(result.tokens).toBe(4096)
    expect(result.focus).toEqual(['src/my dir'])
  })

  test('parses unquoted --focus glob values without shifting flags', () => {
    const result = parseArgs('--focus src/*.ts --tokens 4096')
    expect(result.tokens).toBe(4096)
    expect(result.focus).toEqual(['src/*.ts'])
  })

  test('does not treat shell operators as flag values', () => {
    const result = parseArgs('--focus && --tokens 4096')
    expect(result.tokens).toBe(4096)
    expect(result.focus).toEqual([])
    // `&&` is not a path, so --focus is reported as missing its value rather
    // than silently dropping the flag.
    expect(result.error).toBe('--focus expects a value')
  })

  test('parses multiple --focus flags', () => {
    const result = parseArgs('--focus src/tools/ --focus src/context.ts')
    expect(result.focus).toEqual(['src/tools/', 'src/context.ts'])
  })

  test('parses --focus-symbols flag', () => {
    const result = parseArgs('--focus-symbols buildTool')
    expect(result.focusSymbols).toEqual(['buildTool'])
  })

  test('parses multiple --focus-symbols flags', () => {
    const result = parseArgs('--focus-symbols buildTool --focus-symbols ToolUseContext')
    expect(result.focusSymbols).toEqual(['buildTool', 'ToolUseContext'])
  })

  test('parses combined --focus and --focus-symbols flags', () => {
    const result = parseArgs('--focus src/tools/ --focus-symbols buildTool --tokens 4096')
    expect(result.tokens).toBe(4096)
    expect(result.focus).toEqual(['src/tools/'])
    expect(result.focusSymbols).toEqual(['buildTool'])
  })

  test('parses --invalidate flag', () => {
    const result = parseArgs('--invalidate')
    expect(result.invalidate).toBe(true)
    expect(result.stats).toBe(false)
  })

  test('parses --stats flag', () => {
    const result = parseArgs('--stats')
    expect(result.stats).toBe(true)
    expect(result.invalidate).toBe(false)
  })

  test('parses combined flags', () => {
    const result = parseArgs('--tokens 2048 --focus src/tools/ --invalidate')
    expect(result.tokens).toBe(2048)
    expect(result.focus).toEqual(['src/tools/'])
    expect(result.invalidate).toBe(true)
  })
})

describe('/repomap command', () => {
  test('builds a repository map using the default token budget', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-command-'))
    try {
      writeFileSync(
        join(tempDir, 'main.ts'),
        'export function main(): string { return "hello" }\n',
      )

      const value = await runTextCommand('', tempDir)

      expect(value).toContain('Repository map:')
      expect(value).toContain('main.ts:')
      expect(value).toContain('Tokens:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('call wrapper uses the current cwd state', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-command-call-'))
    const previousCwd = getCwdState()
    try {
      writeFileSync(
        join(tempDir, 'wrapper.ts'),
        'export function commandWrapperRoot(): string { return "ok" }\n',
      )
      setCwdState(tempDir)

      const result = await call('', {} as Parameters<typeof call>[1])

      expect(textValue(result)).toContain('wrapper.ts:')
      expect(textValue(result)).toContain('commandWrapperRoot')
    } finally {
      setCwdState(previousCwd)
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('reports cache stats without building a map', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-command-'))
    try {
      const value = await runTextCommand('--stats', tempDir)

      expect(value).toContain('Repository map cache stats:')
      expect(value).toContain('Cached entries:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('invalidates and rebuilds the cache', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-command-'))
    try {
      writeFileSync(
        join(tempDir, 'main.ts'),
        'export function value(): number { return 1 }\n',
      )

      const value = await runTextCommand('--invalidate --tokens 512', tempDir)

      expect(value).toContain('Cache invalidated and rebuilt.')
      expect(value).toContain('main.ts:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('forwards focus-symbols to buildRepoMap', async () => {
    const captured: { focusSymbols?: string[] } = {}
    const result = await runRepoMapCommand(
      '--focus-symbols buildTool --focus-symbols ToolUseContext',
      '/tmp/repo',
      fakeDeps({
        buildRepoMap: async (options) => {
          captured.focusSymbols = options.focusSymbols
          return SAMPLE_RESULT
        },
      }),
    )

    expect(textValue(result)).toContain('Repository map:')
    expect(captured.focusSymbols).toEqual(['buildTool', 'ToolUseContext'])
  })

  test('reports invalid arguments with the usage line and builds nothing', async () => {
    let buildCalls = 0
    const result = await runRepoMapCommand(
      '--tokens nope',
      '/tmp/repo',
      fakeDeps({
        buildRepoMap: async () => {
          buildCalls++
          return SAMPLE_RESULT
        },
      }),
    )

    const value = textValue(result)
    expect(value).toContain('--tokens expects a whole number')
    expect(value).toContain('Usage: /repomap')
    // A mistyped flag must not spend a build on a silently wrong budget.
    expect(buildCalls).toBe(0)
  })

  test('reports an unknown flag without building a map', async () => {
    const result = await runRepoMapCommand(
      '--stat',
      '/tmp/repo',
      fakeDeps({
        buildRepoMap: async () => {
          throw new Error('should not build')
        },
      }),
    )

    const value = textValue(result)
    expect(value).toContain('Unknown argument "--stat"')
    expect(value).toContain('Usage: /repomap')
    expect(value).not.toContain('should not build')
  })

  test('validates arguments before loading the default dependencies', async () => {
    // No injected dependencies here: the usage error must come back without
    // waiting for, or reporting a failure from, the repo-map module import.
    const value = await runTextCommand('--tokens nope', '/tmp/repo')

    expect(value).toContain('--tokens expects a whole number')
    expect(value).toContain('Usage: /repomap')
    expect(value).not.toContain('Failed to load repo map module')
  })

  test('reports build failures without throwing', async () => {
    const result = await runRepoMapCommand(
      '',
      '/tmp/repo',
      fakeDeps({
        buildRepoMap: async () => {
          throw new Error('parser unavailable')
        },
      }),
    )

    expect(textValue(result)).toContain('Failed to build repository map: parser unavailable')
  })

  test('distinguishes invalidate failures from rebuild failures', async () => {
    const invalidateResult = await runRepoMapCommand(
      '--invalidate',
      '/tmp/repo',
      fakeDeps({
        invalidateCache: () => {
          throw new Error('cache denied')
        },
      }),
    )
    expect(textValue(invalidateResult)).toContain(
      'Failed to invalidate repository map cache: cache denied',
    )

    const rebuildResult = await runRepoMapCommand(
      '--invalidate',
      '/tmp/repo',
      fakeDeps({
        buildRepoMap: async () => {
          throw new Error('wasm missing')
        },
      }),
    )
    expect(textValue(rebuildResult)).toContain(
      'Cache invalidated, but rebuilding the repository map failed: wasm missing',
    )
  })

  test('reports stats failures without throwing', async () => {
    const result = await runRepoMapCommand(
      '--stats',
      '/tmp/repo',
      fakeDeps({
        getCacheStats: () => {
          throw new Error('stats denied')
        },
      }),
    )

    expect(textValue(result)).toContain(
      'Failed to read repository map cache stats: stats denied',
    )
  })

  test('reports lazy import failures without throwing', async () => {
    const result = await runRepoMapCommand(
      '',
      '/tmp/repo',
      Promise.reject(new Error('module missing')),
    )

    expect(textValue(result)).toContain('Failed to load repo map module: module missing')
  })
})
