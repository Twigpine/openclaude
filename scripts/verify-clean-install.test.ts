import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  checkInstalledChromeEntrypoint,
  getInstalledChromeSetupProblems,
  getTarballPayloadProblems,
  parseInstalledChromeSetupLaunches,
  resolvePreviousPublishedVersion,
  runCommand,
} from './verify-clean-install.js'

const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

// The retry/skip/infra branches decide whether the upgrade-install scenario
// runs, is skipped, or aborts as an infra failure — regression-covered here
// with injected npm results (the real script wires runView to `npm view` and
// onInfraFailure to process.exit(2)).

const ok = (version: string) => ({ status: 0, stdout: `${version}\n`, stderr: '' })
const infraFail = { status: 1, stdout: '', stderr: 'npm error network ECONNRESET while fetching' }
const notPublished = { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' }

class InfraExit extends Error {
  constructor(readonly combined: string) {
    super('infra exit')
  }
}

function run(results: Array<{ status: number; stdout: string; stderr: string }>, retries = 3) {
  let calls = 0
  const retryAttempts: number[] = []
  const value = resolvePreviousPublishedVersion({
    runView: () => {
      const result = results[calls]
      calls++
      if (!result) throw new Error(`runView called ${calls} times, only ${results.length} results provided`)
      return result
    },
    onRetry: attempt => retryAttempts.push(attempt),
    onInfraFailure: combined => {
      throw new InfraExit(combined)
    },
    retries,
  })
  return { value, calls, retryAttempts }
}

describe('resolvePreviousPublishedVersion', () => {
  test('returns the version on first success without retrying', () => {
    const { value, calls, retryAttempts } = run([ok('0.24.0')])
    expect(value).toBe('0.24.0')
    expect(calls).toBe(1)
    expect(retryAttempts).toEqual([])
  })

  test('transient infra failure retries and then succeeds', () => {
    const { value, calls, retryAttempts } = run([infraFail, infraFail, ok('0.24.0')])
    expect(value).toBe('0.24.0')
    expect(calls).toBe(3)
    expect(retryAttempts).toEqual([1, 2])
  })

  test('clean unavailability (E404) returns null immediately — skip, not infra', () => {
    const { value, calls, retryAttempts } = run([notPublished])
    expect(value).toBeNull()
    expect(calls).toBe(1)
    expect(retryAttempts).toEqual([])
  })

  test('persistent infra failure invokes onInfraFailure after exhausting retries', () => {
    let caught: InfraExit | null = null
    try {
      run([infraFail, infraFail, infraFail])
    } catch (error) {
      caught = error as InfraExit
    }
    expect(caught).toBeInstanceOf(InfraExit)
    expect(caught!.combined).toContain('ECONNRESET')
  })

  test('unparseable success output returns null rather than a bogus version', () => {
    const { value } = run([ok('not-a-version')])
    expect(value).toBeNull()
  })
})

describe('clean-install verifier seams', () => {
  test('keeps Windows command and space-containing arguments as separate argv values', () => {
    const calls: Array<{ command: string; args: string[]; options: object }> = []
    const command = 'C:\\install prefix\\openclaude.cmd'
    const args = [
      'install',
      '--prefix=C:\\install prefix',
      '--cache=C:\\npm cache',
    ]

    const result = runCommand(
      command,
      args,
      { env: {}, timeout: 1_000 },
      (receivedCommand, receivedArgs, options) => {
        calls.push({
          command: receivedCommand,
          args: receivedArgs,
          options,
        })
        return { exitCode: 0, stdout: 'ok\n', stderr: '' }
      },
    )

    expect(calls).toEqual([
      {
        command,
        args,
        options: {
          env: {},
          timeout: 1_000,
          reject: false,
          stripFinalNewline: false,
        },
      },
    ])
    expect(result).toEqual({ status: 0, stdout: 'ok\n', stderr: '' })
  })

  test('reports missing required and present forbidden tar entries independently', () => {
    expect(getTarballPayloadProblems(new Set(['package/dist/cli.js']))).toEqual([
      expect.stringContaining('tarball is missing declared payload'),
      'tarball contains obsolete CLI payload: package/dist/cli.js',
    ])
  })

  test('requires the packaged heap-limit launcher helper', () => {
    const required = [
      'package/package.json',
      'package/bin/openclaude',
      'package/bin/node-compile-cache.mjs',
      'package/bin/heap-limit.mjs',
      'package/dist/cli.mjs',
      'package/dist/sdk.mjs',
      'package/src/entrypoints/sdk.d.ts',
    ]
    const withoutHelper = required.filter(entry => entry !== 'package/bin/heap-limit.mjs')

    expect(getTarballPayloadProblems(new Set(required))).toEqual([])
    expect(getTarballPayloadProblems(new Set(withoutHelper))).toEqual([
      'tarball is missing declared payload: package/bin/heap-limit.mjs',
    ])
  })

  test('continues past a malformed setup receipt to a later valid receipt', () => {
    const launches = {
      nativeHost: {
        command: process.execPath,
        args: ['/installed/openclaude', '--chrome-native-host'],
      },
      mcpServer: {
        command: process.execPath,
        args: ['/installed/openclaude', '--claude-in-chrome-mcp'],
      },
    }
    const output = [
      '[DEBUG] [Claude in Chrome] Setup launch configuration: {truncated',
      `[DEBUG] [Claude in Chrome] Setup launch configuration: ${JSON.stringify(launches)}`,
    ].join('\n')

    expect(parseInstalledChromeSetupLaunches(output)).toEqual(launches)
    expect(
      parseInstalledChromeSetupLaunches(
        '[DEBUG] [Claude in Chrome] Setup launch configuration: {truncated',
      ),
    ).toBeNull()
  })

  test('records missing installed Chrome artifacts without throwing', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude verifier artifacts '))
    scratchDirs.push(scratch)
    const packageRoot = join(
      scratch,
      ...(process.platform === 'win32'
        ? ['node_modules']
        : ['lib', 'node_modules']),
      '@twigpine',
      'openclaude',
    )
    const manifestPath = join(packageRoot, 'package.json')
    const launcherPath = join(packageRoot, 'bin', 'openclaude')
    const globalLauncherPath =
      process.platform === 'win32'
        ? join(scratch, 'openclaude.cmd')
        : join(scratch, 'bin', 'openclaude')
    const home = join(scratch, 'home')
    const failures: string[] = []
    const passes: string[] = []
    const reporter = {
      fail: (problem: string) => failures.push(problem),
      pass: (what: string) => passes.push(what),
    }

    checkInstalledChromeEntrypoint('test', scratch, home, reporter)
    expect(failures.splice(0)).toEqual([
      `installed manifest missing at ${manifestPath}`,
    ])

    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(
      manifestPath,
      JSON.stringify({ bin: { openclaude: 'bin/openclaude' } }),
    )
    checkInstalledChromeEntrypoint('test', scratch, home, reporter)
    expect(failures.splice(0)).toEqual([
      `installed OpenClaude launcher missing at ${launcherPath}`,
    ])

    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    writeFileSync(launcherPath, '#!/usr/bin/env node\n')
    checkInstalledChromeEntrypoint('test', scratch, home, reporter)
    expect(failures.splice(0)).toEqual([
      `installed OpenClaude global launcher missing at ${globalLauncherPath}`,
    ])

    mkdirSync(join(scratch, 'bin'), { recursive: true })
    writeFileSync(globalLauncherPath, '#!/usr/bin/env node\n')
    checkInstalledChromeEntrypoint('test', scratch, home, reporter)
    expect(failures.splice(0)).toEqual([
      `installed CLI bundle missing at ${join(packageRoot, 'dist', 'cli.mjs')}`,
    ])
    expect(passes).toEqual([])
  })

  test('checks the installed setup receipt and wrapper through the full verifier path', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude verifier setup '))
    scratchDirs.push(scratch)
    const packageRoot = join(
      scratch,
      ...(process.platform === 'win32'
        ? ['node_modules']
        : ['lib', 'node_modules']),
      '@twigpine',
      'openclaude',
    )
    const packageLauncher = join(packageRoot, 'bin', 'openclaude')
    const globalLauncher =
      process.platform === 'win32'
        ? join(scratch, 'openclaude.cmd')
        : join(scratch, 'bin', 'openclaude')
    const home = join(scratch, 'home')
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    mkdirSync(join(packageRoot, 'dist'), { recursive: true })
    mkdirSync(join(scratch, 'bin'), { recursive: true })
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ bin: { openclaude: 'bin/openclaude' } }),
    )
    writeFileSync(packageLauncher, '#!/usr/bin/env node\n')
    writeFileSync(globalLauncher, '#!/usr/bin/env node\n')
    writeFileSync(join(packageRoot, 'dist', 'cli.mjs'), '// fixture bundle\n')

    const verifyTarget = (target: string) => {
      const failures: string[] = []
      const passes: string[] = []
      checkInstalledChromeEntrypoint(
        'test',
        scratch,
        home,
        {
          fail: problem => failures.push(problem),
          pass: what => passes.push(what),
        },
        (command, args, options) => {
          expect(command).toBe(globalLauncher)
          expect(args).toEqual([
            '--chrome',
            '--init-only',
            '--debug-to-stderr',
          ])
          expect(options.env.APPDATA).toBe(join(home, 'AppData', 'Roaming'))
          expect(options.env.LOCALAPPDATA).toBe(join(home, 'AppData', 'Local'))
          expect(options.env.CLAUDE_CODE_DEBUG_LOG_LEVEL).toBe('debug')
          expect(
            options.env.OPENCLAUDE_SKIP_CHROME_NATIVE_HOST_REGISTRATION,
          ).toBe('1')

          const configDir = options.env.OPENCLAUDE_CONFIG_DIR!
          const wrapperName =
            process.platform === 'win32'
              ? 'chrome-native-host.bat'
              : 'chrome-native-host'
          const wrapperPath = join(configDir, 'chrome', wrapperName)
          mkdirSync(join(configDir, 'chrome'), { recursive: true })
          writeFileSync(
            wrapperPath,
            process.platform === 'win32'
              ? `@echo off
setlocal DisableDelayedExpansion
REM Chrome native host wrapper script
REM Generated by Claude Code - do not edit manually
"${process.execPath.replaceAll('%', '%%')}" "${target.replaceAll('%', '%%')}" "--chrome-native-host"
`
              : `#!/bin/sh
# Chrome native host wrapper script
# Generated by Claude Code - do not edit manually
exec '${process.execPath.replaceAll("'", `'"'"'`)}' '${target.replaceAll("'", `'"'"'`)}' '--chrome-native-host'
`,
          )
          return {
            status: 0,
            stdout: '',
            stderr: `[DEBUG] [Claude in Chrome] Setup launch configuration: ${JSON.stringify(
              {
                nativeHost: {
                  command: process.execPath,
                  args: [target, '--chrome-native-host'],
                  requiredEntrypoint: target,
                },
                mcpServer: {
                  command: process.execPath,
                  args: [target, '--claude-in-chrome-mcp'],
                  requiredEntrypoint: target,
                },
              },
            )}`,
          }
        },
      )
      return { failures, passes }
    }

    expect(verifyTarget(globalLauncher)).toEqual({
      failures: [],
      passes: [
        'installed bundle setup generates Chrome targets for the global launcher',
      ],
    })

    const obsoleteTarget = join(packageRoot, 'dist', 'cli.js')
    const obsolete = verifyTarget(obsoleteTarget)
    expect(obsolete.failures).toContain(
      `Chrome native-host setup target does not exist: ${obsoleteTarget}`,
    )
    expect(obsolete.failures).toContain(
      `Chrome MCP setup target does not exist: ${obsoleteTarget}`,
    )
    expect(obsolete.passes).toEqual([])
  })

  test('accepts an artifact-local setup receipt for the installed launcher', () => {
    const installedLauncher = join("/install O'Brien", 'bin', 'openclaude')
    const launches = parseInstalledChromeSetupLaunches(
      `2026-08-22T00:00:00.000Z [DEBUG] [Claude in Chrome] Setup launch configuration: ${JSON.stringify(
        {
          nativeHost: {
            command: process.execPath,
            args: [installedLauncher, '--chrome-native-host'],
            requiredEntrypoint: installedLauncher,
          },
          mcpServer: {
            command: process.execPath,
            args: [installedLauncher, '--claude-in-chrome-mcp'],
            requiredEntrypoint: installedLauncher,
          },
        },
      )}`,
    )

    expect(launches).not.toBeNull()
    expect(
      getInstalledChromeSetupProblems({
        installedLaunchers: [installedLauncher],
        launches: launches!,
        wrapperContent: `#!/bin/sh
# Chrome native host wrapper script
# Generated by Claude Code - do not edit manually
exec '${process.execPath}' '${installedLauncher.replaceAll("'", `'"'"'`)}' '--chrome-native-host'
`,
        pathExists: path => path === installedLauncher,
        platform: 'posix',
      }),
    ).toEqual([])
  })

  test('rejects a wrapper target that only prefixes the installed launcher', () => {
    const installedLauncher = '/install prefix/bin/openclaude'
    const launches = {
      nativeHost: {
        command: '/usr/bin/node',
        args: [installedLauncher, '--chrome-native-host'],
        requiredEntrypoint: installedLauncher,
      },
      mcpServer: {
        command: '/usr/bin/node',
        args: [installedLauncher, '--claude-in-chrome-mcp'],
        requiredEntrypoint: installedLauncher,
      },
    }

    expect(
      getInstalledChromeSetupProblems({
        installedLaunchers: [installedLauncher],
        launches,
        wrapperContent: `exec '/usr/bin/node' '${installedLauncher}-old' '--chrome-native-host'`,
        pathExists: path => path === installedLauncher,
        platform: 'posix',
      }),
    ).toContain(
      'persisted Chrome native-host wrapper does not target the installed package launcher',
    )
  })

  test('normalizes Windows shim targets and percent escaping', () => {
    const packageLauncher =
      'C:\\100% prefix\\lib\\node_modules\\@twigpine\\openclaude\\bin\\openclaude'
    const shimTarget =
      'C:\\100% prefix\\bin\\..\\lib\\node_modules\\@twigpine\\openclaude\\bin\\openclaude'
    const command = 'C:\\Program Files\\nodejs\\node.exe'
    const launches = {
      nativeHost: {
        command,
        args: [shimTarget, '--chrome-native-host'],
        requiredEntrypoint: shimTarget,
      },
      mcpServer: {
        command,
        args: [packageLauncher, '--claude-in-chrome-mcp'],
        requiredEntrypoint: packageLauncher,
      },
    }

    expect(
      getInstalledChromeSetupProblems({
        installedLaunchers: [packageLauncher],
        launches,
        wrapperContent: `@echo off
setlocal DisableDelayedExpansion
REM Chrome native host wrapper script
REM Generated by Claude Code - do not edit manually
"${command}" "${shimTarget.replaceAll('%', '%%')}" "--chrome-native-host"
`,
        pathExists: () => true,
        platform: 'windows',
      }),
    ).toEqual([])
  })

  test('reports invalid Windows wrapper arguments without throwing', () => {
    const installedLauncher = 'C:\\install prefix\\bin\\openclaude'
    const launches = {
      nativeHost: {
        command: 'C:\\invalid"runtime\\node.exe',
        args: [installedLauncher, '--chrome-native-host'],
        requiredEntrypoint: installedLauncher,
      },
      mcpServer: {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [installedLauncher, '--claude-in-chrome-mcp'],
        requiredEntrypoint: installedLauncher,
      },
    }

    expect(
      getInstalledChromeSetupProblems({
        installedLaunchers: [installedLauncher],
        launches,
        wrapperContent: '',
        pathExists: () => true,
        platform: 'windows',
      }),
    ).toContain(
      'persisted Chrome native-host wrapper does not target the installed package launcher',
    )
  })

  test('rejects the released dist/cli.js setup targets', () => {
    const packageRoot = join(
      '/install prefix',
      'lib',
      'node_modules',
      '@twigpine',
      'openclaude',
    )
    const installedLauncher = join('/install prefix', 'bin', 'openclaude')
    const obsoleteTarget = join(packageRoot, 'dist', 'cli.js')
    const problems = getInstalledChromeSetupProblems({
      installedLaunchers: [installedLauncher],
      launches: {
        nativeHost: {
          command: process.execPath,
          args: [obsoleteTarget, '--chrome-native-host'],
          requiredEntrypoint: obsoleteTarget,
        },
        mcpServer: {
          command: process.execPath,
          args: [obsoleteTarget, '--claude-in-chrome-mcp'],
          requiredEntrypoint: obsoleteTarget,
        },
      },
      wrapperContent: `"${obsoleteTarget}" "--chrome-native-host"`,
      pathExists: path => path === installedLauncher,
    })

    expect(problems).toContain(
      'Chrome native-host setup target does not exist: ' + obsoleteTarget,
    )
    expect(problems).toContain(
      'Chrome MCP setup target does not exist: ' + obsoleteTarget,
    )
    expect(problems).toContain(
      'persisted Chrome native-host wrapper does not target the installed package launcher',
    )
  })

  test('rejects wrapper content that differs from the canonical renderer', () => {
    const installedLauncher = '/install prefix/bin/openclaude'
    const launches = {
      nativeHost: {
        command: '/usr/bin/node',
        args: [installedLauncher, '--chrome-native-host'],
        requiredEntrypoint: installedLauncher,
      },
      mcpServer: {
        command: '/usr/bin/node',
        args: [installedLauncher, '--claude-in-chrome-mcp'],
        requiredEntrypoint: installedLauncher,
      },
    }
    const wrapperContent = `#!/bin/sh
# Chrome native host wrapper script
# stale generated header
exec '/usr/bin/node' '${installedLauncher}' '--chrome-native-host'
`

    expect(
      getInstalledChromeSetupProblems({
        installedLaunchers: [installedLauncher],
        launches,
        wrapperContent,
        pathExists: path => path === installedLauncher,
        platform: 'posix',
      }),
    ).toContain(
      'persisted Chrome native-host wrapper does not target the installed package launcher',
    )
  })
})
