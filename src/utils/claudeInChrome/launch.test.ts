import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveCurrentCliEntrypoint } from '../cliEntrypoint.js'
import {
  createWrapperScript,
  renderWrapperScript,
  resolveClaudeInChromeLaunches,
} from './launch.js'

const scratchDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    scratchDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  )
})

describe('resolveClaudeInChromeLaunches', () => {
  test('keeps native executable mode on flag-only child arguments', () => {
    const launches = resolveClaudeInChromeLaunches({
      isNativeBuild: true,
      execPath: '/opt/OpenClaude/openclaude',
    })

    expect(launches.nativeHost).toEqual({
      command: '/opt/OpenClaude/openclaude',
      args: ['--chrome-native-host'],
    })
    expect(launches.mcpServer).toEqual({
      command: '/opt/OpenClaude/openclaude',
      args: ['--claude-in-chrome-mcp'],
    })
  })

  test('shares the resolved CLI entrypoint across both npm-mode launches', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude npm launch '))
    scratchDirs.push(scratch)
    const entrypoint = join(scratch, 'package dir', 'bin', 'openclaude')
    mkdirSync(join(scratch, 'package dir', 'bin'), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')

    const launches = resolveClaudeInChromeLaunches({
      isNativeBuild: false,
      execPath: '/usr/bin/node',
      cliEntrypoint: entrypoint,
    })

    expect(launches.nativeHost).toEqual({
      command: '/usr/bin/node',
      args: [entrypoint, '--chrome-native-host'],
      requiredEntrypoint: entrypoint,
    })
    expect(launches.mcpServer).toEqual({
      command: '/usr/bin/node',
      args: [entrypoint, '--claude-in-chrome-mcp'],
      requiredEntrypoint: entrypoint,
    })
  })
})

describe('resolveCurrentCliEntrypoint', () => {
  test('normalizes relative invocations without resolving symlinks', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude cli entrypoint '))
    scratchDirs.push(scratch)
    const packageDir = join(scratch, 'package dir')
    const launcher = join(packageDir, 'bin', 'openclaude')
    const invokedLink = join(scratch, 'prefix with spaces', 'bin', 'openclaude')
    mkdirSync(join(packageDir, 'bin'), { recursive: true })
    mkdirSync(join(scratch, 'prefix with spaces', 'bin'), { recursive: true })
    writeFileSync(launcher, '#!/usr/bin/env node\n')

    expect(
      resolveCurrentCliEntrypoint({
        argv1: join('package dir', 'bin', 'openclaude'),
        cwd: scratch,
      }),
    ).toBe(launcher)

    if (process.platform === 'win32') return

    symlinkSync(launcher, invokedLink)
    expect(resolveCurrentCliEntrypoint({ argv1: invokedLink })).toBe(invokedLink)
  })

  test('rejects a missing target without leaking its absolute path', () => {
    const missing = join(tmpdir(), 'private user path', 'missing-cli.mjs')
    let caught: Error | undefined
    try {
      resolveCurrentCliEntrypoint({ argv1: missing })
    } catch (error) {
      caught = error as Error
    }

    expect(caught?.message).toContain(
      'Unable to resolve the current OpenClaude CLI entrypoint',
    )
    expect(caught?.message).not.toContain(missing)
    expect(caught?.message).not.toContain(basename(missing))
  })

  test('does not read the current directory for an absolute entrypoint', () => {
    const entrypoint = join(tmpdir(), 'installed openclaude', 'bin', 'openclaude')

    expect(
      resolveCurrentCliEntrypoint({
        argv1: entrypoint,
        getCwd: () => {
          throw new Error('cwd was removed')
        },
        pathExists: path => path === entrypoint,
      }),
    ).toBe(entrypoint)
  })
})

describe('Claude-in-Chrome native host wrapper', () => {
  test('quotes POSIX executable and script paths containing spaces', () => {
    const script = renderWrapperScript(
      {
        command: '/runtime path/node',
        args: ['/package path/dist/cli.mjs', '--chrome-native-host'],
      },
      'linux',
    )

    expect(script).toContain(
      "exec '/runtime path/node' '/package path/dist/cli.mjs' '--chrome-native-host'",
    )
    if (process.platform !== 'win32') {
      expect(spawnSync('sh', ['-n'], { input: script }).status).toBe(0)
    }
  })

  test('renders a valid Windows batch command', () => {
    const script = renderWrapperScript(
      {
        command: 'C:\\Program Files\\nodejs\\node.exe',
        args: [
          'C:\\Open Claude\\dist\\cli.mjs',
          '--chrome-native-host',
        ],
      },
      'windows',
    )

    expect(script).toBe(`@echo off
setlocal DisableDelayedExpansion
REM Chrome native host wrapper script
REM Generated by Claude Code - do not edit manually
"C:\\Program Files\\nodejs\\node.exe" "C:\\Open Claude\\dist\\cli.mjs" "--chrome-native-host"
`)
  })

  test('rewrites a stale cli.js wrapper', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude stale wrapper '))
    scratchDirs.push(scratch)
    const chromeDir = join(scratch, 'chrome')
    const wrapperPath = join(chromeDir, 'chrome-native-host')
    const entrypoint = join(scratch, 'package', 'bin', 'openclaude')
    mkdirSync(chromeDir, { recursive: true })
    mkdirSync(join(scratch, 'package', 'bin'), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    writeFileSync(
      wrapperPath,
      '#!/bin/sh\nexec "/usr/bin/node" "/package/dist/cli.js" --chrome-native-host\n',
    )

    await createWrapperScript(
      {
        command: '/usr/bin/node',
        args: [entrypoint, '--chrome-native-host'],
        requiredEntrypoint: entrypoint,
      },
      { platform: 'linux', chromeDir },
    )

    const rewritten = readFileSync(wrapperPath, 'utf8')
    expect(rewritten).not.toContain('cli.js')
    expect(rewritten).toContain(`'${entrypoint}'`)
    if (process.platform !== 'win32') {
      expect(statSync(wrapperPath).mode & 0o777).toBe(0o755)
    }
  })

  test('does not rewrite an already-correct wrapper', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'openclaude correct wrapper '))
    scratchDirs.push(scratch)
    const chromeDir = join(scratch, 'chrome')
    const entrypoint = join(scratch, 'package', 'bin', 'openclaude')
    mkdirSync(join(scratch, 'package', 'bin'), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    const launch = {
      command: '/usr/bin/node',
      args: [entrypoint, '--chrome-native-host'],
      requiredEntrypoint: entrypoint,
    }

    const wrapperPath = await createWrapperScript(launch, {
      platform: 'linux',
      chromeDir,
    })
    const oldTime = new Date('2020-01-02T03:04:05.000Z')
    utimesSync(wrapperPath, oldTime, oldTime)

    await createWrapperScript(launch, { platform: 'linux', chromeDir })

    expect(statSync(wrapperPath).mtime.getTime()).toBe(oldTime.getTime())
  })

  test('restores executable mode without rewriting matching POSIX content', async () => {
    if (process.platform === 'win32') return

    const scratch = mkdtempSync(join(tmpdir(), 'openclaude wrapper mode '))
    scratchDirs.push(scratch)
    const chromeDir = join(scratch, 'chrome')
    const entrypoint = join(scratch, 'package', 'bin', 'openclaude')
    mkdirSync(join(scratch, 'package', 'bin'), { recursive: true })
    writeFileSync(entrypoint, '#!/usr/bin/env node\n')
    const launch = {
      command: '/usr/bin/node',
      args: [entrypoint, '--chrome-native-host'],
      requiredEntrypoint: entrypoint,
    }

    const wrapperPath = await createWrapperScript(launch, {
      platform: 'linux',
      chromeDir,
    })
    const oldTime = new Date('2020-01-02T03:04:05.000Z')
    chmodSync(wrapperPath, 0o644)
    utimesSync(wrapperPath, oldTime, oldTime)
    const content = readFileSync(wrapperPath, 'utf8')

    await createWrapperScript(launch, { platform: 'linux', chromeDir })

    expect(readFileSync(wrapperPath, 'utf8')).toBe(content)
    expect(statSync(wrapperPath).mtime.getTime()).toBe(oldTime.getTime())
    expect(statSync(wrapperPath).mode & 0o777).toBe(0o755)
  })
})
