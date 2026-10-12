import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import * as fsPromises from 'fs/promises'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { createElement } from 'react'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import * as realEnv from './env.js'
import * as realEnvUtils from './envUtils.js'
import * as realExecFileNoThrow from './execFileNoThrow.js'
import * as realDownload from './nativeInstaller/download.js'

const originalEnv = { ...process.env }
const originalMacro = (globalThis as Record<string, unknown>).MACRO

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

// Snapshot the real execFileNoThrow module BEFORE installing the mock below.
// bun live-updates the `realExecFileNoThrow` namespace to point at the mock once
// mock.module runs, so delegating through the namespace inside the override
// would call the override itself and recurse infinitely. A plain-object copy
// taken now captures the genuine implementations.
const realExecFileNoThrowModule = { ...realExecFileNoThrow }

// The `cleanupNpmInstallations` test needs execFileNoThrowWithCwd to simulate a
// failed `npm uninstall` (E404). bun's mock.module is process-wide and
// re-mocking the module back to the real implementation in afterEach does NOT
// reliably undo it, so a naive `mock.module(...)` set inside the test can leak
// into later test files that shell out for real (e.g. `git worktree add`),
// making them fail with a bogus "npm ERR! code E404". Install the override once
// at module load and gate it on this flag so the persisted mock transparently
// falls through to the real implementation whenever the flag is off.
let simulateNpmUninstallFailure = false
let simulateNpmUninstallEnotempty = false
let fakeNpmPrefix: string | undefined
const npmUninstallPackages: string[] = []

// Same persisted-mock pattern for the GCS download module: the native-gate
// tests must never hit the real binary distribution, so while
// `recordedDownloadCalls` is set the stubs record and short-circuit; otherwise
// they fall through to the real implementations.
const realDownloadModule = { ...realDownload }
let recordedDownloadCalls: string[] | null = null

mock.module('./nativeInstaller/download.js', () => ({
  ...realDownloadModule,
  getLatestVersion: (
    ...args: Parameters<typeof realDownload.getLatestVersion>
  ) => {
    if (recordedDownloadCalls) {
      recordedDownloadCalls.push('getLatestVersion')
      return Promise.resolve('9.9.9')
    }
    return realDownloadModule.getLatestVersion(...args)
  },
  downloadVersion: (
    ...args: Parameters<typeof realDownload.downloadVersion>
  ) => {
    if (recordedDownloadCalls) {
      recordedDownloadCalls.push('downloadVersion')
      return Promise.resolve()
    }
    return realDownloadModule.downloadVersion(...args)
  },
}))

mock.module('./execFileNoThrow.js', () => ({
  ...realExecFileNoThrowModule,
  execFileNoThrowWithCwd: (
    ...args: Parameters<typeof realExecFileNoThrow.execFileNoThrowWithCwd>
  ) => {
    const [command, commandArgs] = args
    if (command === 'npm' && Array.isArray(commandArgs)) {
      if (
        fakeNpmPrefix &&
        commandArgs[0] === 'config' &&
        commandArgs[1] === 'get' &&
        commandArgs[2] === 'prefix'
      ) {
        return Promise.resolve({ stdout: fakeNpmPrefix, stderr: '', code: 0 })
      }

      if (simulateNpmUninstallEnotempty && commandArgs[0] === 'uninstall') {
        npmUninstallPackages.push(String(commandArgs.at(-1)))
        return Promise.resolve({
          stdout: '',
          stderr: 'npm error code ENOTEMPTY',
          code: 1,
        })
      }

      if (simulateNpmUninstallFailure && commandArgs[0] === 'uninstall') {
        npmUninstallPackages.push(String(commandArgs.at(-1)))
        return Promise.resolve({
          stdout: '',
          stderr: 'npm ERR! code E404',
          code: 1,
        })
      }
    }

    return realExecFileNoThrowModule.execFileNoThrowWithCwd(...args)
  },
}))

beforeEach(async () => {
  await acquireSharedMutationLock('utils/openclaudeInstallSurfaces.test.ts')
})

afterEach(() => {
  try {
    process.env = { ...originalEnv }
    if (originalMacro === undefined) {
      delete (globalThis as Record<string, unknown>).MACRO
    } else {
      ;(globalThis as Record<string, unknown>).MACRO = originalMacro
    }
    simulateNpmUninstallFailure = false
    simulateNpmUninstallEnotempty = false
    fakeNpmPrefix = undefined
    npmUninstallPackages.length = 0
    recordedDownloadCalls = null
    mock.restore()
    mock.module('../utils/env.js', () => realEnv)
    mock.module('./envUtils.js', () => realEnvUtils)
  } finally {
    releaseSharedMutationLock()
  }
})

async function importFreshInstallCommand() {
  return import(`../commands/install.tsx?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshInstaller() {
  return import(`./nativeInstaller/installer.ts?ts=${Date.now()}-${Math.random()}`)
}

async function importFreshProtocolRegistration() {
  return import(`./deepLink/registerProtocol.ts?ts=${Date.now()}-${Math.random()}`)
}
async function mockEnvPlatform(platform: 'darwin' | 'win32') {
  const actualEnvModule = await import(`./env.js?ts=${Date.now()}-${Math.random()}`)
  mock.module('../utils/env.js', () => ({
    ...actualEnvModule,
    env: {
      ...actualEnvModule.env,
      platform,
    },
  }))
}

test('install command displays ~/.local/bin/openclaude on non-Windows', async () => {
  await mockEnvPlatform('darwin')

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe('~/.local/bin/openclaude')
})

test('install command displays openclaude.exe path on Windows', async () => {
  await mockEnvPlatform('win32')

  const { getInstallationPath } = await importFreshInstallCommand()

  expect(getInstallationPath()).toBe(
    join(homedir(), '.local', 'bin', 'openclaude.exe').replace(/\//g, '\\'),
  )
})

test('native installer uses openclaude launcher for OpenClaude package', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
  }

  const { getBinaryName, getExecutableName } = await importFreshInstaller()

  expect(getBinaryName('linux-x64')).toBe('claude')
  expect(getExecutableName('linux-x64')).toBe('openclaude')
  expect(getExecutableName('win32-x64')).toBe('openclaude.exe')
})

test('native installer preserves claude launcher for Anthropic package', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@anthropic-ai/claude-code',
  }

  const { getExecutableName } = await importFreshInstaller()

  expect(getExecutableName('linux-x64')).toBe('claude')
  expect(getExecutableName('win32-x64')).toBe('claude.exe')
})

test('deep-link protocol resolver uses openclaude launcher for OpenClaude package', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
  }

  const { getProtocolBinaryName } = await importFreshProtocolRegistration()

  expect(getProtocolBinaryName('linux')).toBe('openclaude')
  expect(getProtocolBinaryName('win32')).toBe('openclaude.exe')
})

test('install command repairs launcher after npm cleanup before final check', async () => {
  // A native distribution must be configured for the native install flow to
  // run at all; without it the command short-circuits to the npm-only path.
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: '@twigpine/openclaude-native',
    DISPLAY_VERSION: '0.0.0-test',
  }

  const calls: string[] = []
  let repairCompleted = false

  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  mock.module('../utils/nativeInstaller/index.js', () => ({
    installLatest: async () => {
      calls.push('installLatest')
      return { latestVersion: '1.2.3', wasUpdated: true, lockFailed: false }
    },
    cleanupNpmInstallations: async () => {
      calls.push('cleanupNpmInstallations')
      return { removed: 1, errors: [], warnings: [] }
    },
    repairNativeLauncher: async (version: string) => {
      calls.push('repairNativeLauncher:' + version)
      await Bun.sleep(1)
      repairCompleted = true
    },
    checkInstall: async (setup: boolean) => {
      calls.push('checkInstall:' + setup + ':' + repairCompleted)
      return []
    },
    cleanupShellAliases: async () => {
      calls.push('cleanupShellAliases')
      return []
    },
  }))

  const [{ Install }, { render }] = await Promise.all([
    importFreshInstallCommand(),
    import(`../ink.js?ts=${Date.now()}-${Math.random()}`),
  ])
  const done = new Promise<void>((resolve, reject) => {
    void render(
      createElement(Install, {
        target: '1.2.3',
        onDone: (result: string) => {
          try {
            expect(result).toBe('OpenClaude installation completed successfully')
            resolve()
          } catch (error) {
            reject(error)
          }
        },
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      },
    ).catch(reject)
  })

  try {
    await done
  } finally {
    stdin.end()
    stdout.end()
  }
  expect(calls).toEqual([
    'installLatest',
    'cleanupNpmInstallations',
    'repairNativeLauncher:1.2.3',
    'checkInstall:true:true',
    'cleanupShellAliases',
  ])
})

test('cleanupNpmInstallations removes only openclaude local install dir', async () => {
  const testHome = await fsPromises.mkdtemp(join(tmpdir(), 'openclaude-cleanup-'))
  const openClaudeLocalDir = join(testHome, '.openclaude', 'local')
  const claudeLocalDir = join(testHome, '.claude', 'local')
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: '@twigpine/openclaude-native',
  }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.env.OPENCLAUDE_CONFIG_DIR = join(testHome, '.openclaude')
  delete process.env.CLAUDE_CONFIG_DIR
  await fsPromises.mkdir(openClaudeLocalDir, { recursive: true })
  await fsPromises.mkdir(claudeLocalDir, { recursive: true })

  simulateNpmUninstallFailure = true

  try {
    const { cleanupNpmInstallations } = await importFreshInstaller()
    await cleanupNpmInstallations()

    await expect(fsPromises.stat(openClaudeLocalDir)).rejects.toThrow()
    await expect(fsPromises.stat(claudeLocalDir)).resolves.toBeTruthy()
    expect(npmUninstallPackages).toContain('@twigpine/openclaude')
    expect(npmUninstallPackages).not.toContain('@anthropic-ai/claude-code')
  } finally {
    await fsPromises.rm(testHome, { recursive: true, force: true })
  }
})

test('cleanupNpmInstallations manual fallback removes openclaude npm shim', async () => {
  await mockEnvPlatform('darwin')

  const testHome = join(process.cwd(), 'work', 'openclaude-install-home-test')
  const npmPrefix = join(testHome, '.npm-global')
  const shimPath = join(npmPrefix, 'bin', 'openclaude')
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: '@twigpine/openclaude-native',
  }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.env.OPENCLAUDE_CONFIG_DIR = join(testHome, '.openclaude')
  delete process.env.CLAUDE_CONFIG_DIR
  fakeNpmPrefix = npmPrefix
  simulateNpmUninstallEnotempty = true

  await fsPromises.mkdir(join(npmPrefix, 'bin'), { recursive: true })
  await fsPromises.writeFile(shimPath, 'stale npm shim')

  try {
    const { cleanupNpmInstallations } = await importFreshInstaller()
    await cleanupNpmInstallations()

    await expect(fsPromises.stat(shimPath)).rejects.toThrow()
  } finally {
    await fsPromises.rm(testHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// npm-only builds (NATIVE_PACKAGE_URL unset): every native-installer surface
// must stay inert. Without these gates, `openclaude install` downloads the
// first-party Claude Code binary from the GCS bucket, symlinks
// ~/.local/bin/openclaude to it, and uninstalls the npm package the user is
// actually running.
// ---------------------------------------------------------------------------

test('installLatest is inert without a native distribution', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }
  recordedDownloadCalls = []

  const { installLatest } = await importFreshInstaller()
  const result = await installLatest('latest', true)

  expect(result).toEqual({
    latestVersion: null,
    wasUpdated: false,
    lockFailed: false,
  })
  expect(recordedDownloadCalls).toEqual([])
})

test('repairNativeLauncher is inert without a native distribution', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }

  const { repairNativeLauncher } = await importFreshInstaller()

  // Would otherwise throw: the version is not installed, and repairing would
  // recreate the ~/.local/bin symlink.
  await expect(repairNativeLauncher('0.0.0-gate-test')).resolves.toBeUndefined()
})

test('cleanupNpmInstallations keeps the npm install without a native distribution', async () => {
  const testHome = await fsPromises.mkdtemp(join(tmpdir(), 'openclaude-npm-only-'))
  const openClaudeLocalDir = join(testHome, '.openclaude', 'local')
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }
  process.env.HOME = testHome
  process.env.USERPROFILE = testHome
  process.env.OPENCLAUDE_CONFIG_DIR = join(testHome, '.openclaude')
  await fsPromises.mkdir(openClaudeLocalDir, { recursive: true })
  // If the gate regressed, uninstalls would run and surface as errors here
  // instead of hitting the machine's real npm prefix.
  simulateNpmUninstallFailure = true

  try {
    const { cleanupNpmInstallations } = await importFreshInstaller()
    const result = await cleanupNpmInstallations()

    expect(result).toEqual({ removed: 0, errors: [], warnings: [] })
    await expect(fsPromises.stat(openClaudeLocalDir)).resolves.toBeTruthy()
  } finally {
    await fsPromises.rm(testHome, { recursive: true, force: true })
  }
})

test('checkInstall reports nothing without a native distribution', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }
  delete process.env.DISABLE_INSTALLATION_CHECKS

  const { checkInstall } = await importFreshInstaller()

  expect(await checkInstall(true)).toEqual([])
})

test('cleanupOldVersions leaves the shared versions directory alone without a native distribution', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
  }

  // The versions store under XDG data home is shared with the first-party
  // native Claude Code install. Redirect all XDG roots to a temp dir and
  // plant more unprotected version binaries than VERSION_RETENTION_COUNT:
  // an ungated cleanup would delete all but the newest two.
  const xdgRoot = await fsPromises.mkdtemp(join(tmpdir(), 'openclaude-xdg-'))
  const versionsDir = join(xdgRoot, 'data', 'claude', 'versions')
  await fsPromises.mkdir(versionsDir, { recursive: true })
  const versions = ['1.0.0', '1.0.1', '1.0.2', '1.0.3']
  for (const version of versions) {
    await fsPromises.writeFile(join(versionsDir, version), '#!/bin/sh\n', {
      mode: 0o755,
    })
  }
  const previousXdgDataHome = process.env.XDG_DATA_HOME
  const previousXdgCacheHome = process.env.XDG_CACHE_HOME
  const previousXdgStateHome = process.env.XDG_STATE_HOME
  process.env.XDG_DATA_HOME = join(xdgRoot, 'data')
  process.env.XDG_CACHE_HOME = join(xdgRoot, 'cache')
  process.env.XDG_STATE_HOME = join(xdgRoot, 'state')

  try {
    const { cleanupOldVersions } = await importFreshInstaller()
    await cleanupOldVersions()

    expect((await fsPromises.readdir(versionsDir)).sort()).toEqual(versions)
  } finally {
    await fsPromises.rm(xdgRoot, { recursive: true, force: true })
    restoreEnvVar('XDG_DATA_HOME', previousXdgDataHome)
    restoreEnvVar('XDG_CACHE_HOME', previousXdgCacheHome)
    restoreEnvVar('XDG_STATE_HOME', previousXdgStateHome)
  }
})

test('install command skips the native installer without a native distribution', async () => {
  ;(globalThis as Record<string, unknown>).MACRO = {
    PACKAGE_URL: '@twigpine/openclaude',
    NATIVE_PACKAGE_URL: undefined,
    DISPLAY_VERSION: '0.0.0-test',
  }

  const calls: string[] = []

  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}

  mock.module('../utils/nativeInstaller/index.js', () => ({
    installLatest: async () => {
      calls.push('installLatest')
      return { latestVersion: '1.2.3', wasUpdated: true, lockFailed: false }
    },
    cleanupNpmInstallations: async () => {
      calls.push('cleanupNpmInstallations')
      return { removed: 1, errors: [], warnings: [] }
    },
    repairNativeLauncher: async (version: string) => {
      calls.push('repairNativeLauncher:' + version)
    },
    checkInstall: async (setup: boolean) => {
      calls.push('checkInstall:' + setup)
      return []
    },
    cleanupShellAliases: async () => {
      calls.push('cleanupShellAliases')
      return []
    },
  }))

  const [{ Install }, { render }] = await Promise.all([
    importFreshInstallCommand(),
    import(`../ink.js?ts=${Date.now()}-${Math.random()}`),
  ])
  const done = new Promise<void>((resolve, reject) => {
    void render(
      createElement(Install, {
        onDone: (result: string) => {
          try {
            expect(result).toBe('OpenClaude installation completed successfully')
            resolve()
          } catch (error) {
            reject(error)
          }
        },
      }),
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        patchConsole: false,
      },
    ).catch(reject)
  })

  try {
    await done
  } finally {
    stdin.end()
    stdout.end()
  }

  expect(calls).toEqual([])
})
