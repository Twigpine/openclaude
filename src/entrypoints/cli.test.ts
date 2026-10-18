/**
 * Regression tests for issue #402 — NODE_OPTIONS heap cap
 * Closes: Twigpine/openclaude#402 — JavaScript heap OOM during large tasks
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from '@commander-js/extra-typings'
import { applyChildProcessHeapOptions } from './applyChildProcessHeapOptions.js'
import {
  BACKGROUND_SESSION_CLEANUP_WORKER_ENV,
  BACKGROUND_SESSION_ID_ENV,
  BACKGROUND_SESSION_LAUNCHER_PID_ENV,
} from '../cli/bgRouting.js'
import type { ProviderOverride } from '../services/api/agentRouting.js'
import {
  applyLoadedEnvFileValues,
  loadEnvFile,
} from '../utils/envFile.js'
import {
  applyModelFlagFromArgs,
  applyProviderFlagFromArgs,
  clearRememberedProviderFlagForTests,
  parseModelFlag,
  parseProviderFlag,
  reapplyRememberedProviderFlag,
} from '../utils/providerFlag.js'
import { applyProfileEnvToProcessEnv } from '../utils/providerProfile.js'

type CliMain = typeof import('./cli.js')['main']

let runCliEntrypoint: CliMain

const mockProfileCheckpoint = mock((_checkpoint: string) => {})
const mockPsHandler = mock(async (_args: string[]) => {})
const mockLogsHandler = mock(async (_args: string[]) => {})
const mockAttachHandler = mock(async (_args: string[]) => {})
const mockKillHandler = mock(
  async (
    _args: string[],
    _options?: { retentionSettingsReady?: boolean },
  ) => {},
)
const mockHandleBgFlag = mock(async (_args: string[]) => {})
const mockPrepareBackgroundSessionFinalizer = mock(async () => 'installed')
const mockRunBackgroundSessionCleanupWorker = mock(async () => {})
const mockLoadEnvFile = mock((_filePath: string) => ({}))
const mockParseProviderEnvFileArgs = mock((_args: string[]) => ({ paths: [] }))
const mockReapplyRememberedEnvFileValues = mock(() => {})
const mockRememberLoadedEnvFileValues = mock(
  (_values: Record<string, string>) => {},
)
const mockEnableConfigs = mock(() => {})
const mockApplySafeConfigEnvironmentVariables = mock(() => {})
const mockApplyStartupEnvFromProfile = mock(
  async (_input: {
    processEnv: NodeJS.ProcessEnv
    modelOverride?: string
    onValidationError: (message: string) => void
  }): Promise<string | null> => null,
)
const mockGetProviderValidationError = mock(
  async (_env: NodeJS.ProcessEnv) => undefined,
)
const mockEagerLoadSettingsFromArgs = mock((_args: string[]) => ({ ok: true }))
const mockResetSettingsCache = mock(() => {})
const mockResolveOutOfProcessTeammateProviderFromCliArgs = mock(
  (_args: string[], _settings: unknown): ProviderOverride | undefined =>
    undefined,
)
const mockApplyAgentProviderOverrideToEnv = mock((_override: unknown) => {})
const mockGetInitialSettings = mock(() => ({}))
const mockRefreshGithubModelsTokenIfNeeded = mock(async () => {})
const mockHydrateGithubModelsTokenFromSecureStorage = mock(() => {})
const mockValidateProviderEnvForStartupOrExit = mock(async () => {})
const mockApplyModelFlagFromArgs = mock(
  (_args: string[]): ReturnType<typeof applyModelFlagFromArgs> => undefined,
)
const mockPrintStartupScreen = mock((_model: string | undefined) => {})
const mockStartCapturingEarlyInput = mock(() => {})
const mockCliMain = mock(async () => {})

const runtimeMocks = [
  mockProfileCheckpoint,
  mockPsHandler,
  mockLogsHandler,
  mockAttachHandler,
  mockKillHandler,
  mockHandleBgFlag,
  mockPrepareBackgroundSessionFinalizer,
  mockRunBackgroundSessionCleanupWorker,
  mockLoadEnvFile,
  mockParseProviderEnvFileArgs,
  mockReapplyRememberedEnvFileValues,
  mockRememberLoadedEnvFileValues,
  mockEnableConfigs,
  mockApplySafeConfigEnvironmentVariables,
  mockApplyStartupEnvFromProfile,
  mockGetProviderValidationError,
  mockEagerLoadSettingsFromArgs,
  mockResetSettingsCache,
  mockResolveOutOfProcessTeammateProviderFromCliArgs,
  mockApplyAgentProviderOverrideToEnv,
  mockGetInitialSettings,
  mockRefreshGithubModelsTokenIfNeeded,
  mockHydrateGithubModelsTokenFromSecureStorage,
  mockValidateProviderEnvForStartupOrExit,
  mockApplyModelFlagFromArgs,
  mockPrintStartupScreen,
  mockStartCapturingEarlyInput,
  mockCliMain,
]

function clearRuntimeMocks() {
  for (const fn of runtimeMocks) {
    fn.mockClear()
  }
}

describe('cli.tsx — NODE_OPTIONS --max-old-space-size (issue #402)', () => {
  const cliSource = readFileSync(new URL('./cli.tsx', import.meta.url), 'utf8')

  it('wires the child-process heap helper from the CLI entrypoint', () => {
    expect(cliSource).toContain(
      "import { applyChildProcessHeapOptions } from './applyChildProcessHeapOptions.js'",
    )
    expect(cliSource).toContain('applyChildProcessHeapOptions(process.env, process.execArgv)')
  })

  it('propagates a numeric process.execArgv heap cap to NODE_OPTIONS for subprocesses', () => {
    const env: NodeJS.ProcessEnv = {}
    applyChildProcessHeapOptions(env, ['--max-old-space-size=4096', '--expose-gc'])
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096')
  })

  it('does not append 8192 when process.execArgv already has a percentage heap flag', () => {
    const env: NodeJS.ProcessEnv = {}
    applyChildProcessHeapOptions(env, ['--max-old-space-size-percentage=50'])
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('sets --max-old-space-size=8192 when NODE_OPTIONS is not set', () => {
    const env: NodeJS.ProcessEnv = {}
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=8192')
  })

  it('does not override existing --max-old-space-size=4096', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--max-old-space-size=4096 --experimental-vm-modules',
    }
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe(
      '--max-old-space-size=4096 --experimental-vm-modules',
    )
  })

  it('does not override existing --max-old-space-size=8192', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--max-old-space-size=8192',
    }
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=8192')
  })

  it('appends --max-old-space-size when NODE_OPTIONS has other flags', () => {
    const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '--inspect=9229' }
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe('--inspect=9229 --max-old-space-size=8192')
  })

  it('does not override existing --max-old-space-size-percentage=50', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--max-old-space-size-percentage=50',
    }
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size-percentage=50')
    expect(env.NODE_OPTIONS).not.toMatch(/--max-old-space-size=\d+/)
  })

  it('uses OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB when appending a heap cap', () => {
    const env: NodeJS.ProcessEnv = {
      NODE_OPTIONS: '--inspect=9229',
      OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '2048',
    }
    applyChildProcessHeapOptions(env)
    expect(env.NODE_OPTIONS).toBe('--inspect=9229 --max-old-space-size=2048')
  })
})

describe('cli.tsx — --provider startup ordering', () => {
  const providerEnvKeys = [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_MODEL',
    'GEMINI_MODEL',
  ]
  const originalEnv = new Map<string, string | undefined>()
  let tempDir: string

  beforeEach(() => {
    clearRememberedProviderFlagForTests()
    tempDir = mkdtempSync(join(tmpdir(), 'openclaude-cli-env-file-test-'))
    for (const key of providerEnvKeys) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    for (const key of providerEnvKeys) {
      const originalValue = originalEnv.get(key)
      if (originalValue === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = originalValue
      }
    }
    originalEnv.clear()
    clearRememberedProviderFlagForTests()
  })

  function writeProviderEnvFile(content: string): string {
    const filePath = join(tempDir, '.env')
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  it('remembers --provider so settings.env reloads cannot clobber it', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()

    const earlyProviderApplyIndex = src.indexOf('applyProviderFlagFromArgs(args')
    const rememberOptionIndex = src.indexOf(
      'rememberForSettingsEnv: true',
      earlyProviderApplyIndex,
    )
    const settingsEnvApplyIndex = src.indexOf(
      'applySafeConfigEnvironmentVariables()',
    )

    expect(earlyProviderApplyIndex).toBeGreaterThanOrEqual(0)
    expect(rememberOptionIndex).toBeGreaterThan(earlyProviderApplyIndex)
    expect(settingsEnvApplyIndex).toBeGreaterThan(earlyProviderApplyIndex)
  })

  it('reapplies remembered --provider after every managed settings env merge', async () => {
    const src = await Bun.file(`${import.meta.dir}/../utils/managedEnv.ts`).text()
    const safeApplyIndex = src.indexOf('export function applySafeConfigEnvironmentVariables')
    const configApplyIndex = src.indexOf('export function applyConfigEnvironmentVariables')
    const safeReapplyIndex = src.indexOf(
      'reapplyRememberedProviderFlag()',
      safeApplyIndex,
    )
    const configReapplyIndex = src.indexOf(
      'reapplyRememberedProviderFlag()',
      configApplyIndex,
    )

    expect(safeReapplyIndex).toBeGreaterThan(safeApplyIndex)
    expect(safeReapplyIndex).toBeLessThan(configApplyIndex)
    expect(configReapplyIndex).toBeGreaterThan(configApplyIndex)
  })

  it('uses the effective early model for system-prompt dumps', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()
    const dumpPathIndex = src.indexOf("feature('DUMP_SYSTEM_PROMPT')")
    const promptCallIndex = src.indexOf('getSystemPrompt([], model)', dumpPathIndex)
    const dumpPath = src.slice(dumpPathIndex, promptCallIndex)

    expect(dumpPathIndex).toBeGreaterThanOrEqual(0)
    expect(promptCallIndex).toBeGreaterThan(dumpPathIndex)
    expect(dumpPath).toContain('earlyModelFlag ?? getMainLoopModel()')
    expect(dumpPath).not.toContain("args.indexOf('--model')")
  })

  it('remembers provider env-file values so later managed settings env merges can restore them', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()
    const envFileImportIndex = src.indexOf('rememberLoadedEnvFileValues')
    const rememberLoadedFileIndex = src.indexOf(
      'rememberLoadedEnvFileValues(loadEnvFile(filePath))',
    )

    expect(envFileImportIndex).toBeGreaterThanOrEqual(0)
    expect(rememberLoadedFileIndex).toBeGreaterThan(envFileImportIndex)
  })

  it('preserves explicit --provider-env-file values through settings and startup profile env merges', () => {
    const filePath = writeProviderEnvFile([
      'CLAUDE_CODE_USE_OPENAI=1',
      'OPENAI_API_KEY=file-key',
      'OPENAI_BASE_URL=https://file.example/v1',
      'OPENAI_MODEL=file-model',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)

    Object.assign(process.env, {
      OPENAI_API_KEY: 'settings-key',
      OPENAI_BASE_URL: 'https://settings.example/v1',
      OPENAI_MODEL: 'settings-model',
    })
    applyLoadedEnvFileValues(loaded)

    applyProfileEnvToProcessEnv(process.env, {
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_API_KEY: 'profile-key',
      OPENAI_BASE_URL: 'https://profile.example/v1',
      OPENAI_MODEL: 'profile-model',
    })
    applyLoadedEnvFileValues(loaded)

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBe('1')
    expect(process.env.OPENAI_API_KEY).toBe('file-key')
    expect(process.env.OPENAI_BASE_URL).toBe('https://file.example/v1')
    expect(process.env.OPENAI_MODEL).toBe('file-model')
  })

  it('keeps explicit --provider values ahead of provider env-file reapply checkpoints', () => {
    const filePath = writeProviderEnvFile([
      'CLAUDE_CODE_USE_OPENAI=1',
      'OPENAI_API_KEY=file-key',
      'OPENAI_BASE_URL=https://file.example/v1',
      'OPENAI_MODEL=file-model',
    ].join('\n'))

    const loaded = loadEnvFile(filePath)
    const result = applyProviderFlagFromArgs(
      ['--provider', 'gemini', '--model', 'gemini-2.0-flash'],
      { rememberForSettingsEnv: true },
    )
    expect(result?.error).toBeUndefined()

    applyLoadedEnvFileValues(loaded)
    reapplyRememberedProviderFlag()
    applyLoadedEnvFileValues(loaded)
    reapplyRememberedProviderFlag()

    expect(process.env.CLAUDE_CODE_USE_OPENAI).toBeUndefined()
    expect(process.env.CLAUDE_CODE_USE_GEMINI).toBe('1')
    expect(process.env.GEMINI_MODEL).toBe('gemini-2.0-flash')
  })

  it('dispatches background session management before provider validation', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()
    const bgManagementIndex = src.indexOf("args[0] === 'ps'")
    const providerValidationIndex = src.indexOf(
      'await validateProviderEnvForStartupOrExit()',
    )

    expect(bgManagementIndex).toBeGreaterThanOrEqual(0)
    expect(providerValidationIndex).toBeGreaterThanOrEqual(0)
    expect(bgManagementIndex).toBeLessThan(providerValidationIndex)
  })

  it('keeps background spawn after profile routing but before provider validation', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()
    const profileApplyIndex = src.indexOf('await applyStartupEnvFromProfile')
    const bgFlagIndex = src.indexOf("optionArgs.includes('--bg')")
    const providerValidationIndex = src.indexOf(
      'await validateProviderEnvForStartupOrExit()',
    )

    expect(profileApplyIndex).toBeGreaterThanOrEqual(0)
    expect(bgFlagIndex).toBeGreaterThanOrEqual(0)
    expect(providerValidationIndex).toBeGreaterThanOrEqual(0)
    expect(bgFlagIndex).toBeGreaterThan(profileApplyIndex)
    expect(bgFlagIndex).toBeLessThan(providerValidationIndex)
  })

})

const mockImporters = {
  startupProfiler: async () => ({
    profileCheckpoint: mockProfileCheckpoint,
  }),
  bg: async () => ({
    psHandler: mockPsHandler,
    logsHandler: mockLogsHandler,
    attachHandler: mockAttachHandler,
    killHandler: mockKillHandler,
    handleBgFlag: mockHandleBgFlag,
  }),
  bgFinalizer: async () => ({
    prepareBackgroundSessionFinalizer: mockPrepareBackgroundSessionFinalizer,
    runBackgroundSessionCleanupWorker: mockRunBackgroundSessionCleanupWorker,
  }),
  envFile: async () => ({
    loadEnvFile: mockLoadEnvFile,
    parseProviderEnvFileArgs: mockParseProviderEnvFileArgs,
    reapplyRememberedEnvFileValues: mockReapplyRememberedEnvFileValues,
    rememberLoadedEnvFileValues: mockRememberLoadedEnvFileValues,
  }),
  config: async () => ({
    enableConfigs: mockEnableConfigs,
  }),
  managedEnv: async () => ({
    applySafeConfigEnvironmentVariables:
      mockApplySafeConfigEnvironmentVariables,
  }),
  providerProfile: async () => ({
    applyStartupEnvFromProfile: mockApplyStartupEnvFromProfile,
  }),
  providerValidation: async () => ({
    getProviderValidationError: mockGetProviderValidationError,
    validateProviderEnvForStartupOrExit:
      mockValidateProviderEnvForStartupOrExit,
  }),
  providerFlag: async () => ({
    applyModelFlagFromArgs: mockApplyModelFlagFromArgs,
    applyProviderFlagFromArgs,
    parseModelFlag,
    parseProviderFlag,
    reapplyRememberedProviderFlag,
  }),
  flagSettings: async () => ({
    eagerLoadSettingsFromArgs: mockEagerLoadSettingsFromArgs,
  }),
  settingsCache: async () => ({
    resetSettingsCache: mockResetSettingsCache,
  }),
  agentRouting: async () => ({
    applyAgentProviderOverrideToEnv: mockApplyAgentProviderOverrideToEnv,
    resolveOutOfProcessTeammateProviderFromCliArgs:
      mockResolveOutOfProcessTeammateProviderFromCliArgs,
  }),
  settings: async () => ({
    getInitialSettings: mockGetInitialSettings,
  }),
  githubModelsCredentials: async () => ({
    hydrateGithubModelsTokenFromSecureStorage:
      mockHydrateGithubModelsTokenFromSecureStorage,
    refreshGithubModelsTokenIfNeeded: mockRefreshGithubModelsTokenIfNeeded,
  }),
  startupScreen: async () => ({
    printStartupScreen: mockPrintStartupScreen,
  }),
  earlyInput: async () => ({
    startCapturingEarlyInput: mockStartCapturingEarlyInput,
  }),
  main: async () => ({
    main: mockCliMain,
  }),
}

describe('cli.tsx — background routing behavior', () => {
  const bgOptions = {
    bgSessionsEnabled: true,
    importers: mockImporters,
  } as unknown as Parameters<CliMain>[1]
  const originalAutoRunGuard =
    process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
  const savedArgv = [...process.argv]

  beforeAll(async () => {
    process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN = '1'

    const entrypoint = await import('./cli.js')
    runCliEntrypoint = entrypoint.main
  })

  afterAll(() => {
    if (originalAutoRunGuard === undefined) {
      delete process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    } else {
      process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN =
        originalAutoRunGuard
    }
  })

  beforeEach(() => {
    clearRuntimeMocks()
  })

  afterEach(() => {
    process.argv = [...savedArgv]
  })

  it('dispatches background management commands before startup work', async () => {
    const cases: Array<[string, typeof mockPsHandler, string[]]> = [
      ['ps', mockPsHandler, ['--json']],
      ['logs', mockLogsHandler, ['session-1', '-f']],
      ['attach', mockAttachHandler, ['session-1']],
      ['kill', mockKillHandler, ['session-1']],
    ]

    for (const [command, handler, tail] of cases) {
      clearRuntimeMocks()

      await runCliEntrypoint([command, ...tail], bgOptions)

      if (command === 'kill') {
        expect(mockKillHandler.mock.calls).toEqual([
          [tail, { retentionSettingsReady: true }],
        ])
      } else {
        expect(handler.mock.calls).toEqual([[tail]])
      }
      expect(mockParseProviderEnvFileArgs).not.toHaveBeenCalled()
      expect(mockHandleBgFlag).not.toHaveBeenCalled()
      expect(mockEnableConfigs).toHaveBeenCalledTimes(
        command === 'kill' ? 1 : 0,
      )
      expect(mockEagerLoadSettingsFromArgs).toHaveBeenCalledTimes(
        command === 'kill' ? 1 : 0,
      )
      expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
      expect(mockCliMain).not.toHaveBeenCalled()
    }
  })

  it('keeps kill reachable when retention settings cannot be loaded', async () => {
    mockEagerLoadSettingsFromArgs.mockImplementationOnce(() => ({
      ok: false,
      message: 'missing retention settings',
    }))

    await runCliEntrypoint(
      ['kill', 'session-1', '--settings', 'missing.json'],
      bgOptions,
    )

    expect(mockKillHandler).toHaveBeenCalledWith(
      ['session-1', '--settings', 'missing.json'],
      { retentionSettingsReady: false },
    )
    expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
  })

  it('establishes background finalizer ownership before any command path', async () => {
    process.env[BACKGROUND_SESSION_ID_ENV] = 'bg-entrypoint'
    mockPrepareBackgroundSessionFinalizer.mockImplementationOnce(async () => {
      throw new Error('finalizer ownership not ready')
    })
    try {
      await expect(runCliEntrypoint(['ps'], bgOptions)).rejects.toThrow(
        'finalizer ownership not ready',
      )
    } finally {
      delete process.env[BACKGROUND_SESSION_ID_ENV]
    }

    expect(mockPrepareBackgroundSessionFinalizer).toHaveBeenCalledTimes(1)
    expect(mockPsHandler).not.toHaveBeenCalled()
    expect(mockEnableConfigs).not.toHaveBeenCalled()
  })

  it('runs an internal cleanup worker before any command path', async () => {
    process.env[BACKGROUND_SESSION_CLEANUP_WORKER_ENV] = '1'
    try {
      await runCliEntrypoint(['ps'], bgOptions)
    } finally {
      delete process.env[BACKGROUND_SESSION_CLEANUP_WORKER_ENV]
    }

    expect(mockRunBackgroundSessionCleanupWorker).toHaveBeenCalledTimes(1)
    expect(mockPrepareBackgroundSessionFinalizer).not.toHaveBeenCalled()
    expect(mockPsHandler).not.toHaveBeenCalled()
    expect(mockEnableConfigs).toHaveBeenCalledTimes(1)
    expect(mockResetSettingsCache).toHaveBeenCalledTimes(1)
    expect(mockEagerLoadSettingsFromArgs.mock.calls).toEqual([[['ps']]])
    expect(mockRunBackgroundSessionCleanupWorker).toHaveBeenCalledWith({
      reloadSettings: expect.any(Function),
    })
    const workerOptions = (
      mockRunBackgroundSessionCleanupWorker.mock.calls as unknown as Array<
        [{ reloadSettings?: () => boolean }]
      >
    )[0]?.[0]
    expect(workerOptions?.reloadSettings?.()).toBe(true)
    expect(mockResetSettingsCache).toHaveBeenCalledTimes(2)
    expect(mockEagerLoadSettingsFromArgs.mock.calls).toEqual([
      [['ps']],
      [['ps']],
    ])
  })

  it('routes partial background metadata through the finalizer before dispatch', async () => {
    process.env[BACKGROUND_SESSION_LAUNCHER_PID_ENV] = '123'
    try {
      await runCliEntrypoint(['ps'], bgOptions)
    } finally {
      delete process.env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]
    }

    expect(mockPrepareBackgroundSessionFinalizer).toHaveBeenCalledTimes(1)
    expect(mockPsHandler).toHaveBeenCalledTimes(1)
  })

  it('keeps management commands on the management path even with --bg arguments', async () => {
    const cases: Array<[string, typeof mockPsHandler]> = [
      ['ps', mockPsHandler],
      ['logs', mockLogsHandler],
      ['attach', mockAttachHandler],
      ['kill', mockKillHandler],
    ]

    for (const [command, handler] of cases) {
      clearRuntimeMocks()

      await runCliEntrypoint([command, '--bg', 'session-1'], bgOptions)

      const tail = ['--bg', 'session-1']
      if (command === 'kill') {
        expect(mockKillHandler.mock.calls).toEqual([
          [tail, { retentionSettingsReady: true }],
        ])
      } else {
        expect(handler.mock.calls).toEqual([[tail]])
      }
      expect(mockParseProviderEnvFileArgs).not.toHaveBeenCalled()
      expect(mockHandleBgFlag).not.toHaveBeenCalled()
      expect(mockEnableConfigs).toHaveBeenCalledTimes(
        command === 'kill' ? 1 : 0,
      )
      expect(mockEagerLoadSettingsFromArgs).toHaveBeenCalledTimes(
        command === 'kill' ? 1 : 0,
      )
      expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
      expect(mockCliMain).not.toHaveBeenCalled()
    }
  })

  it('routes real background flags after profile routing without provider validation', async () => {
    const args = ['--background', '--', '--print']

    await runCliEntrypoint(args, bgOptions)

    expect(mockEnableConfigs).toHaveBeenCalledTimes(1)
    expect(mockParseProviderEnvFileArgs.mock.calls).toEqual([[args]])
    expect(mockReapplyRememberedEnvFileValues).toHaveBeenCalledTimes(2)
    expect(mockApplySafeConfigEnvironmentVariables).toHaveBeenCalledTimes(1)
    expect(mockApplyStartupEnvFromProfile).toHaveBeenCalledTimes(1)
    expect(mockEagerLoadSettingsFromArgs.mock.calls).toEqual([[args]])
    expect(mockHandleBgFlag.mock.calls).toEqual([[args]])
    expect(mockRefreshGithubModelsTokenIfNeeded).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
    expect(mockCliMain).not.toHaveBeenCalled()
  })

  it('treats --bg after -- as positional text, not a background flag', async () => {
    const args = ['--', '--bg']

    await runCliEntrypoint(args, bgOptions)

    expect(mockHandleBgFlag).not.toHaveBeenCalled()
    expect(mockRefreshGithubModelsTokenIfNeeded).toHaveBeenCalledTimes(1)
    expect(mockHydrateGithubModelsTokenFromSecureStorage).toHaveBeenCalledTimes(
      1,
    )
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledTimes(1)
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it('applies a standalone model override before provider validation', async () => {
    const order: string[] = []
    mockApplyModelFlagFromArgs.mockImplementationOnce(args => {
      order.push('model')
      expect(args).toEqual(['--model', 'deepseek/deepseek-v4-flash'])
      return undefined
    })
    mockValidateProviderEnvForStartupOrExit.mockImplementationOnce(async () => {
      order.push('validation')
    })

    await runCliEntrypoint(
      ['--model', 'deepseek/deepseek-v4-flash'],
      bgOptions,
    )

    expect(order).toEqual(['model', 'validation'])
  })

  it('applies an equals-separated model override before provider validation', async () => {
    const order: string[] = []
    mockApplyModelFlagFromArgs.mockImplementationOnce(args => {
      order.push('model')
      expect(args).toEqual(['--model=deepseek/deepseek-v4-flash'])
      return undefined
    })
    mockValidateProviderEnvForStartupOrExit.mockImplementationOnce(async () => {
      order.push('validation')
    })

    await runCliEntrypoint(
      ['--model=deepseek/deepseek-v4-flash'],
      bgOptions,
    )

    expect(order).toEqual(['model', 'validation'])
  })

  it.each([
    {
      args: ['aimlapi', 'topup', '--model', 'anthropic/claude-sonnet-4-6'],
    },
    {
      args: ['auto-mode', 'critique', '--model=anthropic/claude-sonnet-4-6'],
    },
    {
      args: [
        '--debug=api',
        'aimlapi',
        'topup',
        '--model',
        'anthropic/claude-sonnet-4-6',
      ],
    },
  ])('leaves nested command model options to their owning command', async ({ args }) => {
    await runCliEntrypoint([...args], bgOptions)

    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(undefined)
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it('does not restore or validate a saved profile after an explicit Anthropic selection', async () => {
    const originalExit = process.exit
    const originalConsoleError = console.error
    const originalEnv = { ...process.env }
    const exitMock = mock((_code?: number | string | null) => undefined as never)
    const consoleErrorMock = mock((_message?: unknown) => {})
    process.exit = exitMock as typeof process.exit
    console.error = consoleErrorMock
    try {
      await runCliEntrypoint(
        ['--provider', 'anthropic', '--model', 'sonnet'],
        bgOptions,
      )
    } finally {
      process.exit = originalExit
      console.error = originalConsoleError
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
      }
      Object.assign(process.env, originalEnv)
    }

    expect(mockApplyStartupEnvFromProfile).not.toHaveBeenCalled()
    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith([
      '--provider',
      'anthropic',
      '--model',
      'sonnet',
    ])
    expect(consoleErrorMock).not.toHaveBeenCalled()
    expect(exitMock).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it('honors an inline explicit Anthropic selection before saved-profile restoration', async () => {
    const originalExit = process.exit
    const originalConsoleError = console.error
    const originalEnv = { ...process.env }
    const exitMock = mock((_code?: number | string | null) => undefined as never)
    const consoleErrorMock = mock((_message?: unknown) => {})
    process.exit = exitMock as typeof process.exit
    console.error = consoleErrorMock
    try {
      await runCliEntrypoint(
        ['--provider=anthropic', '--model=sonnet'],
        bgOptions,
      )
    } finally {
      process.exit = originalExit
      console.error = originalConsoleError
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
      }
      Object.assign(process.env, originalEnv)
    }

    expect(mockApplyStartupEnvFromProfile).not.toHaveBeenCalled()
    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith([
      '--provider=anthropic',
      '--model=sonnet',
    ])
    expect(consoleErrorMock).not.toHaveBeenCalled()
    expect(exitMock).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['--', '--provider=anthropic'],
    ['--system-prompt', '--provider=anthropic'],
  ])(
    'does not treat provider-looking prompt data as an explicit selection: %j',
    async (firstArg, secondArg) => {
      await runCliEntrypoint([firstArg, secondArg], bgOptions)

      expect(mockApplyStartupEnvFromProfile).toHaveBeenCalledTimes(1)
      expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
      expect(mockCliMain).toHaveBeenCalledTimes(1)
    },
  )

  it('does not treat a nested command --model as the Command Code session model', async () => {
    const originalExit = process.exit
    const originalConsoleError = console.error
    const originalModel = process.env.OPENAI_MODEL
    const originalBaseUrl = process.env.OPENAI_BASE_URL
    const originalUseOpenAI = process.env.CLAUDE_CODE_USE_OPENAI
    const originalApiKey = process.env.OPENAI_API_KEY
    const exitMock = mock((_code?: number | string | null) => undefined as never)
    const consoleErrorMock = mock((_message?: unknown) => {})
    process.exit = exitMock as typeof process.exit
    console.error = consoleErrorMock

    try {
      await runCliEntrypoint(
        [
          '--provider',
          'commandcode',
          '--model',
          'deepseek/deepseek-v4-flash',
          'aimlapi',
          'topup',
          '--model',
          'anthropic/claude-sonnet-4-6',
        ],
        bgOptions,
      )
    } finally {
      process.exit = originalExit
      console.error = originalConsoleError
      if (originalModel === undefined) {
        delete process.env.OPENAI_MODEL
      } else {
        process.env.OPENAI_MODEL = originalModel
      }
      if (originalBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL
      } else {
        process.env.OPENAI_BASE_URL = originalBaseUrl
      }
      if (originalUseOpenAI === undefined) {
        delete process.env.CLAUDE_CODE_USE_OPENAI
      } else {
        process.env.CLAUDE_CODE_USE_OPENAI = originalUseOpenAI
      }
      if (originalApiKey === undefined) {
        delete process.env.OPENAI_API_KEY
      } else {
        process.env.OPENAI_API_KEY = originalApiKey
      }
    }

    expect(consoleErrorMock).not.toHaveBeenCalled()
    expect(exitMock).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
    )
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it('still applies a root model option before a nested model command', async () => {
    const args = [
      '--model=deepseek/deepseek-v4-flash',
      'aimlapi',
      'topup',
      '--model',
      'anthropic/claude-sonnet-4-6',
    ]

    await runCliEntrypoint(args, bgOptions)

    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith([
      '--model=deepseek/deepseek-v4-flash',
    ])
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
    )
  })

  it('does not treat a spaced root model value as a nested command path', async () => {
    const args = ['--model', 'aimlapi', 'topup']

    await runCliEntrypoint(args, bgOptions)

    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith(args)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith('aimlapi')
  })

  it('does not treat a required root option value as a nested command path', async () => {
    const args = [
      '--name',
      'aimlapi',
      'topup',
      '--model',
      'deepseek/deepseek-v4-flash',
    ]

    await runCliEntrypoint(args, bgOptions)

    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith(args)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
    )
  })

  it('still applies a root model after a required option consumes the -- delimiter', async () => {
    const args = [
      '--system-prompt',
      '--',
      '--model',
      'deepseek/deepseek-v4-flash',
    ]

    await runCliEntrypoint(args, bgOptions)

    expect(mockApplyStartupEnvFromProfile.mock.calls[0]?.[0]).toMatchObject({
      modelOverride: 'deepseek/deepseek-v4-flash',
    })
    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith(args)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
    )
  })

  it('does not treat --model after a real end-of-options marker as a root model', async () => {
    const args = [
      '--system-prompt',
      'hello',
      '--',
      '--model',
      'deepseek/deepseek-v4-flash',
    ]

    await runCliEntrypoint(args, bgOptions)

    expect(
      mockApplyStartupEnvFromProfile.mock.calls[0]?.[0].modelOverride,
    ).toBeUndefined()
    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
  })

  it('preserves a teammate provider override resolved from an inline model alias', async () => {
    const providerOverride = {
      model: 'actual-provider-model',
      baseURL: 'https://provider.example/v1',
      apiKey: 'provider-key',
    }
    mockResolveOutOfProcessTeammateProviderFromCliArgs.mockReturnValueOnce(
      providerOverride,
    )

    await runCliEntrypoint(
      ['--agent-name=worker-a', '--team-name=review', '--model=route-alias'],
      bgOptions,
    )

    expect(mockApplyAgentProviderOverrideToEnv).toHaveBeenCalledWith(
      providerOverride,
    )
    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'actual-provider-model',
    )
  })

  it('stops before provider validation when a model override is rejected', async () => {
    const originalExit = process.exit
    const originalConsoleError = console.error
    const exitMock = mock((_code?: number | string | null) => undefined as never)
    const consoleErrorMock = mock((_message?: unknown) => {})
    process.exit = exitMock as typeof process.exit
    console.error = consoleErrorMock
    mockApplyModelFlagFromArgs.mockReturnValueOnce({
      error: 'model is incompatible with the selected provider',
    })

    try {
      await runCliEntrypoint(
        ['--model=anthropic/claude-sonnet-4-6'],
        bgOptions,
      )
    } finally {
      process.exit = originalExit
      console.error = originalConsoleError
    }

    expect(consoleErrorMock).toHaveBeenCalledWith(
      'Error: model is incompatible with the selected provider',
    )
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
    expect(mockPrintStartupScreen).not.toHaveBeenCalled()
    expect(mockCliMain).not.toHaveBeenCalled()
  })

  it('does not fall back after a saved Command Code profile rejects the root model', async () => {
    const modelError =
      'OpenAI Chat Completions does not support the selected Command Code model; it requires the Anthropic Messages protocol. Choose an OpenAI-compatible model.'
    const originalExit = process.exit
    const originalConsoleError = console.error
    const exitMock = mock((_code?: number | string | null) => undefined as never)
    const consoleErrorMock = mock((_message?: unknown) => {})
    process.exit = exitMock as typeof process.exit
    console.error = consoleErrorMock
    mockApplyStartupEnvFromProfile.mockImplementationOnce(async input => {
      input.onValidationError(`Warning: ignoring saved provider profile. ${modelError}`)
      return modelError
    })

    try {
      await runCliEntrypoint(
        ['--model', 'anthropic/claude-sonnet-4-6'],
        bgOptions,
      )
    } finally {
      process.exit = originalExit
      console.error = originalConsoleError
    }

    expect(consoleErrorMock).toHaveBeenCalledTimes(1)
    expect(consoleErrorMock).toHaveBeenCalledWith(`Error: ${modelError}`)
    expect(exitMock).toHaveBeenCalledWith(1)
    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).not.toHaveBeenCalled()
    expect(mockCliMain).not.toHaveBeenCalled()
  })

  it('lets a configured teammate override replace a rejected saved Command Code model', async () => {
    const modelError =
      'OpenAI Chat Completions does not support the selected Command Code model; it requires the Anthropic Messages protocol. Choose an OpenAI-compatible model.'
    const providerOverride = {
      model: 'actual-provider-model',
      baseURL: 'https://provider.example/v1',
      apiKey: 'provider-key',
    }
    const originalConsoleError = console.error
    const consoleErrorMock = mock((_message?: unknown) => {})
    console.error = consoleErrorMock
    mockApplyStartupEnvFromProfile.mockImplementationOnce(async input => {
      input.onValidationError(`Warning: ignoring saved provider profile. ${modelError}`)
      return modelError
    })
    mockResolveOutOfProcessTeammateProviderFromCliArgs.mockReturnValueOnce(
      providerOverride,
    )

    try {
      await runCliEntrypoint(
        [
          '--agent-name=worker-a',
          '--team-name=review',
          '--model=anthropic/claude-sonnet-4-6',
        ],
        bgOptions,
      )
    } finally {
      console.error = originalConsoleError
    }

    expect(consoleErrorMock).not.toHaveBeenCalled()
    expect(mockApplyAgentProviderOverrideToEnv).toHaveBeenCalledWith(
      providerOverride,
    )
    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'actual-provider-model',
    )
    expect(mockCliMain).toHaveBeenCalledTimes(1)
  })

  it('keeps model-looking text after -- out of early model routing', async () => {
    await runCliEntrypoint(
      ['--', '--model', 'anthropic/claude-sonnet-4-6'],
      bgOptions,
    )

    expect(mockApplyModelFlagFromArgs).not.toHaveBeenCalled()
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(undefined)
  })

  it('passes repeated model options through for final-occurrence parsing', async () => {
    const args = [
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--model',
      'deepseek/deepseek-v4-flash',
    ]

    await runCliEntrypoint(args, bgOptions)

    expect(mockApplyModelFlagFromArgs).toHaveBeenCalledWith(args)
    expect(mockValidateProviderEnvForStartupOrExit).toHaveBeenCalledTimes(1)
    expect(mockPrintStartupScreen).toHaveBeenCalledWith(
      'deepseek/deepseek-v4-flash',
    )
  })
})

describe('Node 24 premature exit regression (issue #1678)', () => {
  it('built CLI stays alive during initialization in interactive mode without premature exit', async () => {
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const url = await import('node:url')

    const scriptPath = path.join(os.tmpdir(), `test-cli-startup-${Date.now()}.mjs`)
    const cliUrl = url.pathToFileURL(path.resolve(import.meta.dir, '../../dist/cli.mjs')).href
    let proc

    try {
      await Bun.write(scriptPath, `
        // Mock TTY so the CLI thinks it's interactive and starts the TUI
        process.stdout.isTTY = true;
        process.stdin.isTTY = true;
        process.stdin.setRawMode = () => {};
        process.env.OPENCLAUDE_DISABLE_TELEMETRY = '1';
        process.env.OPENGATEWAY_API_KEY = 'dummy';

        // Ensure the CLI auto-runs even if the test runner disabled it globally
        delete process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN;

        // Use absolute import to work from os.tmpdir()
        // If the entrypoint uses void main(), this promise resolves immediately.
        // If it correctly uses await main(), it stays pending while the CLI runs.
        import('${cliUrl}').then(() => {
          console.log('---PREMATURE_EVAL_END---');
          process.exit(0);
        });
      `)

      proc = Bun.spawn(['node', scriptPath], { stdout: 'pipe' })
      const reader = proc.stdout.getReader()

      let gotOutput = false
      let evaluationEndedPrematurely = false

      async function readStdout() {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = new TextDecoder().decode(value)
          if (text.includes('---PREMATURE_EVAL_END---')) {
            evaluationEndedPrematurely = true
          } else if (text.trim().length > 0) {
            gotOutput = true
          }
        }
      }

      // Start reading without awaiting it yet
      const readPromise = readStdout()

      // Wait until we get startup output or detect premature evaluation end
      const start = Date.now()
      while (!gotOutput && !evaluationEndedPrematurely && Date.now() - start < 5000) {
        await new Promise(r => setTimeout(r, 10))
      }

      expect(gotOutput).toBe(true)

      // The critical regression window: wait 500ms *after* output.
      // With void main(), Node 24 will exit during the subsequent async imports because the event loop empties,
      // which allows the import() promise above to resolve and emit the signal.
      await new Promise(r => setTimeout(r, 500))

      expect(evaluationEndedPrematurely).toBe(false)
      expect(proc.exitCode).toBe(null)
      expect(proc.killed).toBe(false)
    } finally {
      if (proc && proc.exitCode === null && !proc.killed) {
        proc.kill()
      }
      await fs.unlink(scriptPath).catch(() => {})
    }
  })

  it('cli.tsx uses top-level await for main() to prevent premature exit', async () => {
    const src = await Bun.file(`${import.meta.dir}/cli.tsx`).text()
    expect(src).toMatch(/await main\(\)/)
    expect(src).not.toMatch(/^\s*void main\(\)/m)
  })
})

describe('cli.tsx — --yolo alias (PR #1939)', () => {
  const options = {
    importers: mockImporters,
  } as unknown as Parameters<CliMain>[1]
  const originalAutoRunGuard =
    process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
  const savedArgv = [...process.argv]

  beforeAll(async () => {
    process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN = '1'
    const entrypoint = await import('./cli.js')
    runCliEntrypoint = entrypoint.main
  })

  afterAll(() => {
    if (originalAutoRunGuard === undefined) {
      delete process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    } else {
      process.env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN =
        originalAutoRunGuard
    }
  })

  beforeEach(() => {
    clearRuntimeMocks()
  })

  afterEach(() => {
    process.argv = [...savedArgv]
  })

  // Mirrors the registration in main.tsx. commander derives the option's
  // attribute from the LAST long flag, so both spellings set the same
  // dangerouslySkipPermissions key — the whole reason a native alias works.
  const buildProgram = () =>
    new Command()
      .option(
        '--yolo, --dangerously-skip-permissions',
        'bypass',
        () => true,
      )
      .allowExcessArguments()
      .exitOverride()

  it('commander resolves --yolo to dangerouslySkipPermissions', () => {
    expect(
      buildProgram().parse(['node', 'x', '--yolo']).opts()
        .dangerouslySkipPermissions,
    ).toBe(true)
    expect(
      buildProgram().parse(['node', 'x', '--dangerously-skip-permissions']).opts()
        .dangerouslySkipPermissions,
    ).toBe(true)
    expect(
      buildProgram().parse(['node', 'x']).opts().dangerouslySkipPermissions,
    ).toBeUndefined()
  })

  it('passes args through to cliMain verbatim — no per-token --yolo rewrite', async () => {
    // Regression guard for the six correctness bugs the old pre-parse argv
    // rewrite caused: --yolo must reach commander untouched, whatever position
    // it sits in (after a value flag, after `--`, or on a subcommand), so
    // commander — not a hand-rolled scanner — resolves it.
    const cases = [
      ['--yolo', '-p', 'hi'],
      ['--system-prompt', '--yolo'],
      ['-p', '--', '--yolo'],
      ['mcp', 'add', '--yolo', 'srv', 'cmd'],
    ]
    for (const argv of cases) {
      clearRuntimeMocks()
      process.argv = ['node', 'openclaude', ...argv]
      let argvSeenByCliMain: string[] | undefined
      mockCliMain.mockImplementationOnce(async () => {
        argvSeenByCliMain = [...process.argv]
      })

      await runCliEntrypoint(argv, options)

      expect(argvSeenByCliMain).toEqual(['node', 'openclaude', ...argv])
    }
  })

  it('does not mutate the host process.argv (no leak of a caller args array)', async () => {
    // main() must not push an explicit args array into the process-global argv:
    // cliMain reads the real process.argv, and leaking a caller's args (e.g. a
    // bypass flag) into it would corrupt an overlapping call or the host.
    const hostArgv = ['node', 'openclaude', 'host-arg']
    process.argv = [...hostArgv]
    await runCliEntrypoint(['--yolo', '-p', 'hi'], options)
    expect(process.argv).toEqual(hostArgv)
  })

  it('the built CLI lists --yolo on the main, ssh, and open command help (live registration)', async () => {
    // Behavioral proof the alias is registered on the real commands — not dead
    // code or the wrong command: commander only prints an option in --help if it
    // is actually registered. --help short-circuits before any startup.
    const fs = await import('node:fs')
    const path = await import('node:path')
    const cliPath = path.resolve(import.meta.dir, '../../dist/cli.mjs')
    if (!fs.existsSync(cliPath)) return // needs `bun run build`; always present in CI
    // The describe's beforeAll sets OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN=1
    // to keep main() from auto-running in-process; the child must NOT inherit it
    // or the entrypoint never runs and prints nothing.
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      OPENCLAUDE_DISABLE_TELEMETRY: '1',
    }
    delete childEnv.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
    for (const argv of [
      ['--yolo', '--help'],
      ['ssh', '--yolo', '--help'],
      ['open', '--yolo', '--help'],
    ]) {
      const out = Bun.spawnSync(['node', cliPath, ...argv], { env: childEnv })
      const text = `${out.stdout.toString()}${out.stderr.toString()}`
      expect(out.exitCode).toBe(0)
      expect(text).not.toContain('unknown option')
      expect(text).toContain('--yolo, --dangerously-skip-permissions')
    }
  }, { timeout: 20000 })

  it('has no production startup gates using naive includes print checks', async () => {
    // All pre-Commander print-mode decisions must go through the shared
    // arity-aware predicate. A naive .includes('-p') / .includes('--print')
    // disagrees with Commander on value-consumed tokens such as
    // `--system-prompt --print` or `--model -p`.
    const files = [
      'src/utils/interactivity.ts',
      'src/utils/earlyInput.ts',
      'src/utils/gracefulShutdown.ts',
      'src/utils/providerValidation.ts',
      'src/services/api/logging.ts',
      'src/cli/bg.ts',
      'src/main.tsx',
    ]
    for (const file of files) {
      const src = await Bun.file(`${import.meta.dir}/../../${file}`).text()
      expect(src).not.toMatch(/\.includes\(['"]-p['"]\)/)
      expect(src).not.toMatch(/\.includes\(['"]--print['"]\)/)
    }
  })
})
