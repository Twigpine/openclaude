import {
  afterEach,
  beforeAll,
  expect,
  mock,
  test,
} from 'bun:test'
import { EventEmitter } from 'node:events'
import * as path from 'node:path'

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (signal?: NodeJS.Signals | number) => boolean
}

type LoadModuleOptions = {
  spawnScenario?: (child: FakeChildProcess, signal?: AbortSignal) => void
  ripGrepStreamImpl?: (
    args: string[],
    target: string,
    abortSignal: AbortSignal,
    onLines: (lines: string[]) => void,
  ) => Promise<void>
}

let actualCrossSpawnModule:
  | typeof import('cross-spawn')
  | undefined
let actualRipgrepModule: typeof import('../utils/ripgrep.js') | undefined

// The `cross-spawn` mock is installed via `mock.module`, which bun does NOT
// undo on `mock.restore()` — it persists process-wide. To keep it from
// hijacking real `git` spawns in later test files (which run sequentially),
// the interception is gated on this module-level scenario, set only while one
// of this suite's spawn-scenario tests is active and cleared in afterEach. Once
// cleared, the persisted mock falls through to the real spawn.
let activeSpawnScenario: LoadModuleOptions['spawnScenario'] | undefined
let actualFileIndexModule:
  | typeof import('../native-ts/file-index/index.js')
  | undefined
let actualMarkdownConfigLoaderModule:
  | typeof import('../utils/markdownConfigLoader.js')
  | undefined
let defaultFileSuggestionsModule:
  | Awaited<ReturnType<typeof loadFileSuggestionsModule>>
  | undefined

afterEach(() => {
  // Clear the spawn scenario so the persisted cross-spawn mock falls through to
  // the real spawn for any later test file's git commands.
  activeSpawnScenario = undefined
  mock.restore()
  restoreFileSuggestionsDependencyMocks()
})

beforeAll(
  async () => {
    defaultFileSuggestionsModule = await loadFileSuggestionsModule()
  },
  { timeout: 15_000 },
)

function createAbortError(message = 'aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function createFakeChildProcess(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  // A real ChildProcess exposes kill(); callers (e.g. execFileNoThrow's
  // timeout path) call it. Provide it so a foreign caller that ever reaches
  // this fake child terminates cleanly instead of throwing
  // "child.kill is not a function". Emit close so the caller stops waiting.
  child.kill = (() => {
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'))
    return true
  }) as FakeChildProcess['kill']
  return child
}

function restoreFileSuggestionsDependencyMocks(): void {
  if (actualCrossSpawnModule) {
    mock.module('cross-spawn', () => actualCrossSpawnModule!)
  }
  if (actualRipgrepModule) {
    mock.module('../utils/ripgrep.js', () => actualRipgrepModule!)
  }
  if (actualFileIndexModule) {
    mock.module('../native-ts/file-index/index.js', () => actualFileIndexModule!)
  }
}

function createIgnoreModuleMock() {
  return {
    default: () => {
      const patterns: string[] = []
      const api = {
        add(input: string) {
          patterns.push(
            ...input
              .split(/\r?\n/)
              .map(line => line.trim())
              .filter(line => line.length > 0 && !line.startsWith('#')),
          )
          return api
        },
        ignores(filePath: string) {
          const normalized = filePath.replaceAll('\\', '/')
          if (normalized.split('/').includes('..')) {
            throw new Error('path should be a `path.relative()`d string')
          }
          return patterns.some(pattern => {
            const normalizedPattern = pattern.replaceAll('\\', '/')
            if (normalizedPattern.endsWith('/')) {
              return normalized.startsWith(normalizedPattern)
            }
            return normalized === normalizedPattern
          })
        },
      }
      return api
    },
  }
}

function isGitCommand(command: string): boolean {
  const basename = path.basename(command).toLowerCase()
  return basename === 'git.exe' || basename === 'git'
}

function installFileSuggestionsDependencyMocks(options: LoadModuleOptions = {}): void {
  const realSpawn =
    actualCrossSpawnModule!.spawn ??
    (actualCrossSpawnModule!.default as typeof actualCrossSpawnModule.spawn)
  mock.module('cross-spawn', () => ({
    ...actualCrossSpawnModule!,
    default: (
      command: string,
      args: string[],
      spawnOptions: { signal?: AbortSignal },
    ) => {
      if (!activeSpawnScenario || !isGitCommand(command)) {
        return realSpawn(command, args, spawnOptions)
      }
      const child = createFakeChildProcess()
      activeSpawnScenario(child, spawnOptions.signal)
      return child
    },
    spawn: (
      command: string,
      args: string[],
      spawnOptions: { signal?: AbortSignal },
    ) => {
      if (!activeSpawnScenario || !isGitCommand(command)) {
        return realSpawn(command, args, spawnOptions)
      }
      const child = createFakeChildProcess()
      activeSpawnScenario(child, spawnOptions.signal)
      return child
    },
  }))
  mock.module('../native-ts/file-index/index.js', () => ({
    CHUNK_MS: 4,
    FileIndex: class FileIndex {
      loadFromFileListAsync(): { done: Promise<void> } {
        return { done: Promise.resolve() }
      }

      search(): Array<{ path: string; score: number }> {
        return []
      }
    },
    yieldToEventLoop: async () => {},
  }))
  mock.module('../utils/ripgrep.js', () => ({
    ...actualRipgrepModule!,
    ripGrepStream:
      options.ripGrepStreamImpl ??
      (async () => {
        return undefined
      }),
  }))
}

async function loadFileSuggestionsModule(options: LoadModuleOptions = {}) {
  activeSpawnScenario = options.spawnScenario
  const nonce = `${Date.now()}-${Math.random()}`
  actualCrossSpawnModule ??= {
    ...await import(`${import.meta.resolve('cross-spawn')}?real=${nonce}`),
  }
  actualRipgrepModule ??= {
    ...await import(`../utils/ripgrep.js?real=${nonce}`),
  }
  actualFileIndexModule ??= {
    ...await import(`../native-ts/file-index/index.js?real=${nonce}`),
  }
  actualMarkdownConfigLoaderModule ??= await import(
    '../utils/markdownConfigLoader.js'
  )
  installFileSuggestionsDependencyMocks(options)
  const module = await import(`./fileSuggestions.ts?ts=${nonce}`)
  // Restore in afterEach so live imports stay mocked while the test runs.
  return module
}

async function getDefaultFileSuggestionsModule() {
  return defaultFileSuggestionsModule ?? loadFileSuggestionsModule()
}

test('normalizeFileSuggestionPath strips leading current-directory prefixes', async () => {
  const fileSuggestions = await getDefaultFileSuggestionsModule()

  expect(fileSuggestions.normalizeFileSuggestionPath('./src/index.ts')).toBe(
    'src/index.ts',
  )
  expect(fileSuggestions.normalizeFileSuggestionPath('.\\src\\index.ts')).toBe(
    'src\\index.ts',
  )
  expect(fileSuggestions.normalizeFileSuggestionPath('src/index.ts')).toBe(
    'src/index.ts',
  )
})

test('shouldExcludeFileSuggestionPath excludes common generated directories', async () => {
  const fileSuggestions = await getDefaultFileSuggestionsModule()

  expect(
    fileSuggestions.shouldExcludeFileSuggestionPath(
      'node_modules/react/index.js',
    ),
  ).toBe(true)
  expect(
    fileSuggestions.shouldExcludeFileSuggestionPath('wandb/run-1/output.log'),
  ).toBe(true)
  expect(
    fileSuggestions.shouldExcludeFileSuggestionPath(
      'src/node_modules-helper.ts',
    ),
  ).toBe(false)
  expect(
    fileSuggestions.shouldExcludeFileSuggestionPath('src/components/'),
  ).toBe(false)
})

test('filterCandidatePathsForSuggestions filters generated directories and caps file count', async () => {
  const fileSuggestions = await getDefaultFileSuggestionsModule()

  const result = fileSuggestions.filterCandidatePathsForSuggestions(
    [
      './src/index.ts',
      'node_modules/pkg/index.js',
      'wandb/latest-run.log',
      'src/app.ts',
      'src/extra.ts',
    ],
    2,
  )

  expect(result.files).toEqual(['src/index.ts', 'src/app.ts'])
  expect(result.truncated).toBe(true)
})

test('filterCandidatePathsForSuggestions keeps parent-relative paths when matcher throws on ..', async () => {
  const fileSuggestions = await getDefaultFileSuggestionsModule()

  const result = fileSuggestions.filterCandidatePathsForSuggestions(
    ['../bar.ts'],
    10,
    {
      ignores(filePath: string) {
        if (filePath.includes('..')) {
          throw new Error('path should be a `path.relative()`d string')
        }
        return filePath.startsWith('foo/')
      },
    },
  )

  expect(result.files).toEqual(['../bar.ts'])
  expect(result.truncated).toBe(false)
})

test('createFileSuggestionIgnoreMatcher scopes ignore patterns to their roots for subdirectory cwd', async () => {
  const fileSuggestions = await getDefaultFileSuggestionsModule()
  const repoRoot = path.resolve('virtual-repo')
  const cwd = path.join(repoRoot, 'packages', 'app')
  const matcher = fileSuggestions.createFileSuggestionIgnoreMatcher(cwd, [
    {
      root: repoRoot,
      patterns: ['top-level.ts', 'shared-ignore/'].join('\n'),
    },
    {
      root: cwd,
      patterns: ['local-ignore.ts', 'local-generated/'].join('\n'),
    },
  ])

  const result = fileSuggestions.filterCandidatePathsForSuggestions(
    [
      '../sibling.ts',
      '../../top-level.ts',
      '../../shared-ignore/file.ts',
      'local-ignore.ts',
      'local-generated/file.ts',
      'keep.ts',
    ],
    10,
    matcher,
  )

  expect(result.files).toEqual(['../sibling.ts', 'keep.ts'])
  expect(result.truncated).toBe(false)
})

test('collectGitPaths reports external abort before output as non-success', async () => {
  const fileSuggestions = await loadFileSuggestionsModule({
    spawnScenario: (child, signal) => {
      signal?.addEventListener(
        'abort',
        () => {
          queueMicrotask(() => {
            child.emit('error', createAbortError())
            child.emit('close', 1)
          })
        },
        { once: true },
      )
    },
  })

  const controller = new AbortController()
  const promise = fileSuggestions.collectGitPathsForTesting(['ls-files'], {
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    abortSignal: controller.signal,
    maxFiles: 10,
  })
  controller.abort()

  await expect(promise).resolves.toMatchObject({
    files: [],
    truncated: false,
    code: 1,
  })
})

test('collectGitPaths reports external abort after partial output as non-success', async () => {
  const fileSuggestions = await loadFileSuggestionsModule({
    spawnScenario: (child, signal) => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('tracked/a.ts\n'))
      })
      signal?.addEventListener(
        'abort',
        () => {
          queueMicrotask(() => {
            child.emit('error', createAbortError())
            child.emit('close', 1)
          })
        },
        { once: true },
      )
    },
  })

  const controller = new AbortController()
  const promise = fileSuggestions.collectGitPathsForTesting(['ls-files'], {
    repoRoot: process.cwd(),
    cwd: process.cwd(),
    abortSignal: controller.signal,
    maxFiles: 10,
  })
  await Promise.resolve()
  controller.abort()

  await expect(promise).resolves.toMatchObject({
    truncated: false,
    code: 1,
  })
})

test('collectRipgrepPaths rejects external abort before output', async () => {
  const fileSuggestions = await loadFileSuggestionsModule({
    ripGrepStreamImpl: async (_args, _target, abortSignal) => {
      await new Promise((_, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => reject(createAbortError()),
          { once: true },
        )
      })
    },
  })

  const controller = new AbortController()
  const promise = fileSuggestions.collectRipgrepPathsForTesting(
    ['--files'],
    '.',
    controller.signal,
    10,
  )
  controller.abort()

  await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
})

test('collectRipgrepPaths rejects external abort after partial output', async () => {
  const fileSuggestions = await loadFileSuggestionsModule({
    ripGrepStreamImpl: async (_args, _target, abortSignal, onLines) => {
      onLines(['partial.ts'])
      await new Promise((_, reject) => {
        abortSignal.addEventListener(
          'abort',
          () => reject(createAbortError()),
          { once: true },
        )
      })
    },
  })

  const controller = new AbortController()
  const promise = fileSuggestions.collectRipgrepPathsForTesting(
    ['--files'],
    '.',
    controller.signal,
    10,
  )
  await Promise.resolve()
  controller.abort()

  await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
})
