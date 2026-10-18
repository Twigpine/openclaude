import { EventEmitter } from 'node:events'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  buildBackgroundSessionLaunch,
  buildBackgroundChildProcessConfig,
  buildBackgroundSessionDisplayCommand,
  confirmBackgroundSessionLaunch,
  followLogFile,
  killBackgroundSession,
  printExistingLog,
  terminateBackgroundSessionProcessTree,
  terminateBackgroundProcessTree,
  LOG_STREAM_CHUNK_SIZE,
  parseBackgroundInvocation,
  parseLogsInvocation,
  resolveBackgroundSessionModel,
  resolveBackgroundSessionProvider,
} from './bg.js'
import {
  BACKGROUND_SESSION_ID_ENV,
  BACKGROUND_SESSION_LAUNCHER_PID_ENV,
} from './bgFinalizer.js'
import {
  BACKGROUND_PROCESS_MARKER_FLAG,
  backgroundProcessMarkerToken,
  generateBackgroundProcessMarker,
} from './bgRouting.js'
import type {
  BackgroundSession,
  BackgroundSessionProcessIdentity,
} from './bgRegistry.js'

const TEST_PROCESS_MARKER = 'a'.repeat(64)
const OTHER_PROCESS_MARKER = 'b'.repeat(64)

class TestOutput extends EventEmitter {
  chunks: Buffer[] = []
  destroyed = false
  writableDestroyed = false
  writeResults: boolean[] = []
  writeError: unknown

  write(chunk: Uint8Array): boolean {
    if (this.writeError) throw this.writeError
    if (this.destroyed || this.writableDestroyed) {
      throw Object.assign(new Error('stdout closed'), { code: 'EPIPE' })
    }
    this.chunks.push(Buffer.from(chunk))
    return this.writeResults.shift() ?? true
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

function createManualScheduler() {
  let intervalCallback: (() => void) | undefined
  let cleared = false

  return {
    setInterval(callback: () => void): ReturnType<typeof setInterval> {
      intervalCallback = callback
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval(): void {
      cleared = true
    },
    tick(): void {
      intervalCallback?.()
    },
    get cleared(): boolean {
      return cleared
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('condition was not met')
}

async function withTempFile<T>(
  name: string,
  run: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-bg-test-'))
  try {
    return await run(join(dir, name))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('background session CLI parsing', () => {
  it('records the final root provider selected by CLI startup', async () => {
    const parsed = parseBackgroundInvocation([
      '--provider',
      'anthropic',
      '--provider=commandcode',
      '--bg',
      'do the work',
    ])
    const launch = await buildBackgroundSessionLaunch(
      parsed.childArgs,
      '00000000-0000-4000-8000-000000000001',
    )

    expect(resolveBackgroundSessionProvider(launch.childArgs)).toBe(
      'commandcode',
    )
  })

  it('does not record provider-looking text consumed by a root option', async () => {
    const parsed = parseBackgroundInvocation([
      '--system-prompt',
      '--provider=commandcode',
      '--bg',
      'do the work',
    ])
    const launch = await buildBackgroundSessionLaunch(
      parsed.childArgs,
      '00000000-0000-4000-8000-000000000001',
    )

    expect(resolveBackgroundSessionProvider(launch.childArgs)).toBeUndefined()
  })

  it('records the root session model when a nested command also has --model', async () => {
    const generatedSessionId = '00000000-0000-4000-8000-000000000001'

    for (const nested of [
      ['aimlapi', 'topup'],
      ['auto-mode', 'critique'],
    ] as const) {
      const parsed = parseBackgroundInvocation([
        '--model',
        'deepseek/deepseek-v4-flash',
        ...nested,
        '--model',
        'anthropic/claude-sonnet-4-6',
        '--bg',
        'do the work',
      ])
      const launch = await buildBackgroundSessionLaunch(
        parsed.childArgs,
        generatedSessionId,
      )

      expect(resolveBackgroundSessionModel(launch.childArgs)).toBe(
        'deepseek/deepseek-v4-flash',
      )
    }
  })

  it('does not record a nested --model as the background session model', async () => {
    const parsed = parseBackgroundInvocation([
      'aimlapi',
      'topup',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--bg',
      'do the work',
    ])
    const launch = await buildBackgroundSessionLaunch(
      parsed.childArgs,
      '00000000-0000-4000-8000-000000000001',
    )

    expect(resolveBackgroundSessionModel(launch.childArgs)).toBeUndefined()
  })

  it('generates a fresh bounded lower-case hex marker from 32 random bytes', () => {
    const first = generateBackgroundProcessMarker(size => {
      expect(size).toBe(32)
      return new Uint8Array(size).fill(0x11)
    })
    const second = generateBackgroundProcessMarker(size =>
      new Uint8Array(size).fill(0x22),
    )

    expect(first).toBe('11'.repeat(32))
    expect(second).toBe('22'.repeat(32))
    expect(second).not.toBe(first)
  })

  it('strips inherited marker options before -- but preserves prompt text after it', () => {
    const inline = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    for (const inherited of [
      [inline],
      [BACKGROUND_PROCESS_MARKER_FLAG, TEST_PROCESS_MARKER],
    ]) {
      const parsed = parseBackgroundInvocation([
        '--bg',
        ...inherited,
        '--print',
        '--',
        inline,
      ])

      expect(parsed.prompt).toBe(inline)
      expect(parsed.childArgs).toEqual(['--print', '--', inline])
    }
  })

  it('preserves marker-looking required-option values', () => {
    const markerLookingValue = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--system-prompt',
      markerLookingValue,
      'actual prompt',
    ])

    expect(parsed.prompt).toBe('actual prompt')
    expect(parsed.childArgs).toEqual([
      '--system-prompt',
      markerLookingValue,
      '--print',
      'actual prompt',
    ])
  })

  it('builds a print-mode child command and preserves provider/model flags', () => {
    const parsed = parseBackgroundInvocation([
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--bg',
      '--name',
      'auth-refactor',
      'refactor auth middleware',
    ])

    expect(parsed.name).toBe('auth-refactor')
    expect(parsed.prompt).toBe('refactor auth middleware')
    expect(parsed.childArgs).toEqual([
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--name',
      'auth-refactor',
      '--print',
      'refactor auth middleware',
    ])
  })

  it('preserves provider env-file values before the prompt', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--provider-env-file',
      '.env',
      'fix failing tests',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--provider-env-file',
      '.env',
      '--print',
      'fix failing tests',
    ])
  })

  it('preserves provider env-file values after the prompt', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      'fix failing tests',
      '--provider-env-file',
      '.env',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--print',
      'fix failing tests',
      '--provider-env-file',
      '.env',
    ])
  })

  it('preserves repeated provider env-file values while finding the prompt', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--provider-env-file',
      '.env.local',
      'fix failing tests',
      '--provider-env-file',
      '.env.ci',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--provider-env-file',
      '.env.local',
      '--print',
      'fix failing tests',
      '--provider-env-file',
      '.env.ci',
    ])
  })

  it('preserves inline provider env-file values', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      'fix failing tests',
      '--provider-env-file=.env',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--print',
      'fix failing tests',
      '--provider-env-file=.env',
    ])
  })

  it('preserves provider env-file paths containing spaces', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      'fix failing tests',
      '--provider-env-file',
      'config files/provider.env',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--print',
      'fix failing tests',
      '--provider-env-file',
      'config files/provider.env',
    ])
  })

  it('keeps provider env-file-looking prompts after -- positional', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--',
      '--provider-env-file=.env',
    ])

    expect(parsed.prompt).toBe('--provider-env-file=.env')
    expect(parsed.childArgs).toEqual([
      '--print',
      '--',
      '--provider-env-file=.env',
    ])
  })

  it('does not duplicate --print when the user already passed it', () => {
    const parsed = parseBackgroundInvocation([
      '--background',
      '--print',
      '--max-turns',
      '2',
      'fix failing tests',
    ])

    expect(parsed.childArgs).toEqual([
      '--print',
      '--max-turns',
      '2',
      'fix failing tests',
    ])
  })

  it('preserves the prompt when --debug has no inline filter', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--debug',
      'fix failing tests',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual(['--debug', '--print', 'fix failing tests'])
  })

  it('preserves inline --debug filters while finding the prompt', () => {
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--debug=api,hooks',
      'fix failing tests',
    ])

    expect(parsed.prompt).toBe('fix failing tests')
    expect(parsed.childArgs).toEqual([
      '--debug=api,hooks',
      '--print',
      'fix failing tests',
    ])
  })

  it('preserves space-separated resume and PR option values', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const resumeParsed = parseBackgroundInvocation([
      '--bg',
      '--resume',
      sessionId,
    ])
    const fromPrParsed = parseBackgroundInvocation([
      '--bg',
      '--from-pr',
      '1642',
    ])
    const shortResumeParsed = parseBackgroundInvocation([
      '--bg',
      '-r',
      sessionId,
    ])
    const inlineResumeParsed = parseBackgroundInvocation([
      '--bg',
      '--resume=auth',
    ])

    expect(resumeParsed.prompt).toBeUndefined()
    expect(resumeParsed.childArgs).toEqual([
      '--resume',
      sessionId,
      '--print',
    ])
    expect(fromPrParsed.prompt).toBeUndefined()
    expect(fromPrParsed.childArgs).toEqual([
      '--from-pr',
      '1642',
      '--print',
    ])
    expect(shortResumeParsed.prompt).toBeUndefined()
    expect(shortResumeParsed.childArgs).toEqual(['-r', sessionId, '--print'])
    expect(inlineResumeParsed.prompt).toBeUndefined()
    expect(inlineResumeParsed.childArgs).toEqual(['--resume=auth', '--print'])
  })

  it('finds the prompt after a space-separated resume option value', () => {
    const sessionId = '550e8400-e29b-41d4-a716-446655440000'
    const parsed = parseBackgroundInvocation([
      '--bg',
      '--resume',
      sessionId,
      'continue the fix',
    ])

    expect(parsed.prompt).toBe('continue the fix')
    expect(parsed.childArgs).toEqual([
      '--resume',
      sessionId,
      '--print',
      'continue the fix',
    ])
  })

  it('does not inject a generated session id when resuming without forking', async () => {
    const resumeSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const generatedSessionId = '00000000-0000-4000-8000-000000000001'

    const launch = await buildBackgroundSessionLaunch(
      ['--resume', resumeSessionId, '--print'],
      generatedSessionId,
    )

    expect(launch.sessionId).toBe(resumeSessionId)
    expect(launch.childArgs).toEqual(['--resume', resumeSessionId, '--print'])
  })

  it('preserves an explicit session id without injecting a generated one', async () => {
    const explicitSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const generatedSessionId = '00000000-0000-4000-8000-000000000001'

    const launch = await buildBackgroundSessionLaunch(
      ['--session-id', explicitSessionId, '--print', 'fix failing tests'],
      generatedSessionId,
    )

    expect(launch.sessionId).toBe(explicitSessionId)
    expect(launch.childArgs).toEqual([
      '--session-id',
      explicitSessionId,
      '--print',
      'fix failing tests',
    ])
  })

  it('uses a generated session id for forked background resumes', async () => {
    const resumeSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const generatedSessionId = '00000000-0000-4000-8000-000000000001'

    const launch = await buildBackgroundSessionLaunch(
      ['--resume', resumeSessionId, '--fork-session', '--print'],
      generatedSessionId,
    )

    expect(launch.sessionId).toBe(generatedSessionId)
    expect(launch.childArgs).toEqual([
      '--resume',
      resumeSessionId,
      '--fork-session',
      '--print',
      '--session-id',
      generatedSessionId,
    ])
  })

  it('registers non-forked PR resumes under the selected transcript id', async () => {
    const generatedSessionId = '00000000-0000-4000-8000-000000000001'
    const prSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const seenSelectors: unknown[] = []

    const launch = await buildBackgroundSessionLaunch(
      ['--from-pr', '1642', '--print'],
      generatedSessionId,
      {
        resolvePrResumeSessionId: async selector => {
          seenSelectors.push(selector)
          return prSessionId
        },
      },
    )

    expect(seenSelectors).toEqual(['1642'])
    expect(launch.sessionId).toBe(prSessionId)
    expect(launch.childArgs).toEqual(['--from-pr', '1642', '--print'])
  })

  it('fails when a non-forked PR resume selector cannot be resolved', async () => {
    await expect(
      buildBackgroundSessionLaunch(
        ['--from-pr', '1642', '--print'],
        '00000000-0000-4000-8000-000000000001',
        {
          resolvePrResumeSessionId: async () => null,
        },
      ),
    ).rejects.toThrow('No conversation found linked to PR selector: 1642')
  })

  it('inserts generated flags before -- so dash-prefixed prompts stay positional', () => {
    const parsed = parseBackgroundInvocation(['--bg', '--', '--fix-tests'])

    expect(parsed.prompt).toBe('--fix-tests')
    expect(parsed.childArgs).toEqual(['--print', '--', '--fix-tests'])
  })

  it('injects print mode when the prompt after -- looks like a print flag', () => {
    const longFlagParsed = parseBackgroundInvocation(['--bg', '--', '--print'])
    const shortFlagParsed = parseBackgroundInvocation(['--bg', '--', '-p'])

    expect(longFlagParsed.prompt).toBe('--print')
    expect(longFlagParsed.childArgs).toEqual(['--print', '--', '--print'])
    expect(shortFlagParsed.prompt).toBe('-p')
    expect(shortFlagParsed.childArgs).toEqual(['--print', '--', '-p'])
  })

  it('does not strip --bg when it appears after -- as the prompt', () => {
    const parsed = parseBackgroundInvocation(['--bg', '--', '--bg'])

    expect(parsed.prompt).toBe('--bg')
    expect(parsed.childArgs).toEqual(['--print', '--', '--bg'])
  })

  it('parses log follow mode', () => {
    expect(parseLogsInvocation(['auth-refactor', '-f'])).toEqual({
      target: 'auth-refactor',
      follow: true,
      stream: 'stdout',
    })
    expect(parseLogsInvocation(['auth-refactor', '--stderr'])).toEqual({
      target: 'auth-refactor',
      follow: false,
      stream: 'stderr',
    })
    expect(parseLogsInvocation(['auth-refactor', '--stdout', '-f'])).toEqual({
      target: 'auth-refactor',
      follow: true,
      stream: 'stdout',
    })
    expect(parseLogsInvocation(['auth-refactor', '-f', '--stderr'])).toEqual({
      target: 'auth-refactor',
      follow: true,
      stream: 'stderr',
    })
  })

  it('preserves Node exec flags while keeping the registered child PID stable', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: ['--max-old-space-size=8192', '--expose-gc'],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'fix failing tests'],
      processEnv: {
        OPENCLAUDE_HEAP_RELAUNCHED: '1',
        OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '8192',
      },
      sessionName: 'tests',
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-tests',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 700,
    })

    expect(config.command).toBe('/usr/bin/node')
    expect(config.args).toEqual([
      '--max-old-space-size=8192',
      '--expose-gc',
      '/repo/bin/openclaude',
      backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
      '--print',
      'fix failing tests',
    ])
    expect(config.env.OPENCLAUDE_HEAP_RELAUNCHED).toBe('1')
    expect(config.env.OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB).toBe('8192')
    expect(config.env.CLAUDE_CODE_SESSION_KIND).toBe('bg')
    expect(config.env.CLAUDE_CODE_SESSION_LOG).toBe('/tmp/bg.out.log')
    expect(config.env.CLAUDE_CODE_SESSION_NAME).toBe('tests')
    expect(config.env[BACKGROUND_SESSION_ID_ENV]).toBe('bg-tests')
    expect(config.env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBe('700')
  })

  it('does not add a fixed heap cap when NODE_OPTIONS already has a percentage limit', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: [],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'fix failing tests'],
      processEnv: {
        NODE_OPTIONS: '--max-old-space-size-percentage=50',
      },
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-percentage-node-options',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 705,
    })

    expect(config.args.filter(arg => arg.startsWith('--max-old-space-size='))).toEqual(
      [],
    )
    expect(config.args[0]).toBe('--expose-gc')
  })

  it('preserves an execArgv percentage heap flag instead of appending 8192', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: ['--max-old-space-size-percentage=75'],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'fix failing tests'],
      processEnv: {},
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-percentage-execargv',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 706,
    })

    expect(config.args.slice(0, 2)).toEqual([
      '--max-old-space-size-percentage=75',
      '--expose-gc',
    ])
  })

  it('preserves a spaced execArgv percentage value so Node still receives the argument', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: ['--max-old-space-size-percentage', '75'],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'fix failing tests'],
      processEnv: {},
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-percentage-spaced-execargv',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 707,
    })

    expect(config.args.slice(0, 3)).toEqual([
      '--max-old-space-size-percentage',
      '75',
      '--expose-gc',
    ])
  })

  it('supplies launcher heap flags instead of relaunching to a different PID', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: [],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'fix failing tests'],
      processEnv: {
        OPENCLAUDE_HEAP_RELAUNCHED: '1',
        OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB: '4096',
      },
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-no-wrapper',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 701,
    })

    expect(config.args.slice(0, 2)).toEqual([
      '--max-old-space-size=4096',
      '--expose-gc',
    ])
    expect(config.env.OPENCLAUDE_HEAP_RELAUNCHED).toBe('1')
  })

  it('prevents the installed launcher from replacing a non-Node registered PID', () => {
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/local/bin/bun',
      execArgv: [],
      entrypoint: '/repo/bin/openclaude',
      childArgs: ['--print', 'work'],
      processEnv: {},
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-bun-owner',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 702,
    })

    expect(config.command).toBe('/usr/local/bin/bun')
    expect(config.env.OPENCLAUDE_HEAP_RELAUNCHED).toBe('1')
    expect(config.env[BACKGROUND_SESSION_ID_ENV]).toBe('bg-bun-owner')
    expect(config.env[BACKGROUND_SESSION_LAUNCHER_PID_ENV]).toBe('702')
  })

  it('injects one fresh marker immediately after a spaced entrypoint', () => {
    const inherited = backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)
    const promptMarker = backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)
    const config = buildBackgroundChildProcessConfig({
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      execArgv: ['--expose-gc'],
      entrypoint: 'C:\\repo path\\dist\\cli.mjs',
      childArgs: [
        inherited,
        '--provider',
        'openai',
        '--model',
        'gpt-5',
        '--session-id',
        '550e8400-e29b-41d4-a716-446655440000',
        '--from-pr',
        '1642',
        '--print',
        '--',
        promptMarker,
      ],
      processEnv: {},
      stdoutLogPath: 'C:\\logs path\\bg.out.log',
      backgroundSessionId: 'bg-spaced-paths',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 703,
    })
    const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    const entrypointIndex = config.args.indexOf('C:\\repo path\\dist\\cli.mjs')

    expect(config.args[entrypointIndex + 1]).toBe(markerToken)
    expect(config.args.filter(arg => arg === markerToken)).toHaveLength(1)
    expect(config.args.slice(0, config.args.indexOf('--'))).not.toContain(
      inherited,
    )
    expect(config.args.slice(config.args.indexOf('--'))).toEqual([
      '--',
      promptMarker,
    ])
  })

  it('keeps marker-looking required-option values during defensive injection', () => {
    const markerLookingValue = backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)
    const config = buildBackgroundChildProcessConfig({
      execPath: '/usr/bin/node',
      execArgv: [],
      entrypoint: '/repo/bin/openclaude',
      childArgs: [
        '--system-prompt',
        markerLookingValue,
        '--print',
        'work',
      ],
      processEnv: {},
      stdoutLogPath: '/tmp/bg.out.log',
      backgroundSessionId: 'bg-marker-looking-value',
      processMarker: TEST_PROCESS_MARKER,
      launcherPid: 704,
    })

    expect(config.args).toEqual([
      '--max-old-space-size=8192',
      '--expose-gc',
      '/repo/bin/openclaude',
      backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
      '--system-prompt',
      markerLookingValue,
      '--print',
      'work',
    ])
  })

  it('omits only the internal marker from the displayed launch command', () => {
    const markerToken = backgroundProcessMarkerToken(TEST_PROCESS_MARKER)
    const promptMarker = backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)

    expect(
      buildBackgroundSessionDisplayCommand(
        [
          'node',
          '/repo path/dist/cli.mjs',
          markerToken,
          '--provider',
          'openai',
          '--print',
          '--',
          promptMarker,
        ],
        TEST_PROCESS_MARKER,
      ),
    ).toEqual([
      'node',
      '/repo path/dist/cli.mjs',
      '--provider',
      'openai',
      '--print',
      '--',
      promptMarker,
    ])
  })

  it('escalates process-tree termination and waits for exit before returning', async () => {
    const signals: Array<string | number | undefined> = []
    let aliveChecks = 0

    await terminateBackgroundProcessTree(123, {
      isProcessAlive: () => {
        aliveChecks++
        return aliveChecks < 4
      },
      killTree: async (_pid, signal) => {
        signals.push(signal)
      },
      sleep: async () => {},
      termGraceMs: 1,
      killGraceMs: 1,
      pollIntervalMs: 1,
    })

    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('fails a detached launch that becomes stale before finalizer installation', async () => {
    const session: BackgroundSession = {
      id: 'bg-finalizer-not-installed',
      pid: 4243,
      cwd: '/repo',
      status: 'running',
      startedAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:00:00.000Z',
      sessionId: 'conversation-finalizer-not-installed',
      command: ['node', 'openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/bg-finalizer-not-installed.out.log',
      stderrLogPath: '/tmp/bg-finalizer-not-installed.err.log',
    }
    const calls: string[] = []

    await expect(
      confirmBackgroundSessionLaunch(session, {
        isProcessAlive: () => false,
        refreshStatuses: async () => {
          calls.push('refresh')
          return []
        },
        resolveSession: async id => {
          calls.push(`resolve:${id}`)
          return { ...session, status: 'stale' }
        },
      }),
    ).rejects.toThrow(
      'Background session bg-finalizer-not-installed exited before finalization was installed. ' +
        'Logs were retained at /tmp/bg-finalizer-not-installed.out.log and /tmp/bg-finalizer-not-installed.err.log.',
    )
    expect(calls).toEqual([
      'refresh',
      'resolve:bg-finalizer-not-installed',
    ])
  })

  it('returns a live launch without consulting the registry', async () => {
    const session: BackgroundSession = {
      id: 'bg-live-confirmation',
      pid: 4244,
      cwd: '/repo',
      status: 'running',
      startedAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:00:00.000Z',
      sessionId: 'conversation-live-confirmation',
      command: ['node', 'openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/bg-live-confirmation.out.log',
      stderrLogPath: '/tmp/bg-live-confirmation.err.log',
    }
    const calls: string[] = []

    const confirmed = await confirmBackgroundSessionLaunch(session, {
      isProcessAlive: () => true,
      refreshStatuses: async () => {
        calls.push('refresh')
        return []
      },
      resolveSession: async id => {
        calls.push(`resolve:${id}`)
        return session
      },
    })

    expect(confirmed).toBe(session)
    expect(calls).toEqual([])
  })

  it('returns an authoritative terminal launch after refreshing a dead PID', async () => {
    const session: BackgroundSession = {
      id: 'bg-terminal-confirmation',
      pid: 4245,
      cwd: '/repo',
      status: 'running',
      startedAt: '2026-07-10T08:00:00.000Z',
      updatedAt: '2026-07-10T08:00:00.000Z',
      sessionId: 'conversation-terminal-confirmation',
      command: ['node', 'openclaude', '--print', 'work'],
      stdoutLogPath: '/tmp/bg-terminal-confirmation.out.log',
      stderrLogPath: '/tmp/bg-terminal-confirmation.err.log',
    }
    const terminal: BackgroundSession = {
      ...session,
      status: 'failed',
      updatedAt: '2026-07-10T08:00:01.000Z',
      finishedAt: '2026-07-10T08:00:01.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    }
    const calls: string[] = []

    const confirmed = await confirmBackgroundSessionLaunch(session, {
      isProcessAlive: () => false,
      refreshStatuses: async () => {
        calls.push('refresh')
        return [terminal]
      },
      resolveSession: async id => {
        calls.push(`resolve:${id}`)
        return terminal
      },
    })

    expect(confirmed).toMatchObject({
      status: 'failed',
      finishedAt: '2026-07-10T08:00:01.000Z',
      exitCode: 23,
      terminalReason: 'exit_code',
    })
    expect(calls).toEqual(['refresh', 'resolve:bg-terminal-confirmation'])
  })
})

describe('background session process termination safety', () => {
  const session: BackgroundSession = {
    id: 'bg-safety',
    name: 'safety',
    pid: 4242,
    cwd: '/repo',
    status: 'running',
    startedAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
    sessionId: 'conversation-safety',
    command: ['node', 'openclaude', '--session-id', 'conversation-safety'],
    stdoutLogPath: '/tmp/stdout.log',
    stderrLogPath: '/tmp/stderr.log',
  }
  const markedSession: BackgroundSession = {
    ...session,
    processMarker: TEST_PROCESS_MARKER,
    command: [
      'node',
      'openclaude',
      backgroundProcessMarkerToken(TEST_PROCESS_MARKER),
      '--session-id',
      'conversation-safety',
    ],
  }

  function identity(
    state: BackgroundSessionProcessIdentity['state'],
    overrides: Partial<BackgroundSessionProcessIdentity> = {},
  ): BackgroundSessionProcessIdentity {
    return {
      state,
      backgroundSessionId: session.id,
      pid: session.pid,
      ...overrides,
    }
  }

  it('verifies the selected session immediately before SIGTERM', async () => {
    const calls: string[] = []
    let aliveChecks = 0

    await terminateBackgroundSessionProcessTree(session, {
      isProcessAlive: () => ++aliveChecks <= 2,
      getProcessCommand: pid => {
        calls.push(`verify:${pid}`)
        return 'node openclaude --session-id conversation-safety'
      },
      killTree: async (pid, signal) => {
        calls.push(`signal:${pid}:${signal}`)
      },
      sleep: async () => {},
      termGraceMs: 1,
      pollIntervalMs: 1,
    })

    expect(calls).toEqual([
      'verify:4242',
      'signal:4242:SIGTERM',
    ])
  })

  it('signals a marked session only after its exact token is freshly verified', async () => {
    const calls: string[] = []
    let aliveChecks = 0

    await terminateBackgroundSessionProcessTree(markedSession, {
      isProcessAlive: () => ++aliveChecks <= 2,
      getProcessCommand: pid => {
        calls.push(`verify:${pid}`)
        return `node openclaude ${backgroundProcessMarkerToken(TEST_PROCESS_MARKER)} --session-id conversation-safety`
      },
      killTree: async (pid, signal) => {
        calls.push(`signal:${pid}:${signal}`)
      },
      sleep: async () => {},
      termGraceMs: 1,
      pollIntervalMs: 1,
    })

    expect(calls).toEqual([
      'verify:4242',
      'signal:4242:SIGTERM',
    ])
  })

  it('refuses a mismatched identity before SIGTERM and does not mark killed', async () => {
    const calls: string[] = []

    let refusal: unknown
    try {
      await killBackgroundSession(
        {
          ...session,
          status: 'running',
          command: [...session.command, 'private prompt value'],
        },
        {
          isProcessAlive: () => true,
          verifySessionIdentity: () => identity('mismatch'),
          killTree: async (_pid, signal) => {
            calls.push(`signal:${signal}`)
          },
          markKilled: async selected => {
            calls.push(`mark:${selected.id}`)
            return { ...selected, status: 'killed' }
          },
        },
      )
    } catch (error) {
      refusal = error
    }

    expect(String(refusal)).toContain('refused to signal an unverified process')
    expect(String(refusal)).toContain(
      'This older background session could not be verified safely',
    )
    expect(String(refusal)).toContain('terminate PID 4242 manually')
    expect(String(refusal)).not.toContain('private prompt value')
    expect(calls).toEqual([])
  })

  it('does not signal or mark a marked session whose token mismatches', async () => {
    const calls: string[] = []

    await expect(
      killBackgroundSession(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () =>
          `node openclaude ${backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)} --session-id conversation-safety`,
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual([])
  })

  it('does not verify or signal authoritative terminal records when a reused PID would match', async () => {
    for (const status of ['killed', 'exited', 'failed'] as const) {
      const calls: string[] = []

      const killed = await killBackgroundSession(
        { ...session, status },
        {
          verifySessionIdentity: () => {
            calls.push('verify')
            return identity('matches')
          },
          killTree: async (_pid, signal) => {
            calls.push(`signal:${signal}`)
          },
          markKilled: async selected => {
            calls.push(`mark:${selected.id}`)
            return { ...selected, status: 'killed' }
          },
        },
      )

      expect(killed.status).toBe('killed')
      expect(calls).toEqual(['mark:bg-safety'])
    }
  })

  it('fails closed instead of marking a stale session whose identity mismatches', async () => {
    const calls: string[] = []

    await expect(
      killBackgroundSession(
        { ...markedSession, status: 'stale' },
        {
          isProcessAlive: () => true,
          getProcessCommand: () =>
            `node openclaude ${backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)} --session-id conversation-safety`,
          killTree: async (_pid, signal) => {
            calls.push(`signal:${signal}`)
          },
          markKilled: async selected => {
            calls.push(`mark:${selected.id}`)
            return { ...selected, status: 'killed' }
          },
        },
      ),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual([])
  })

  it('refuses a matching legacy identity after the session was already stale', async () => {
    const calls: string[] = []

    await expect(
      killBackgroundSession(
        { ...session, status: 'stale' },
        {
          isProcessAlive: () => true,
          getProcessCommand: () =>
            'node openclaude --resume conversation-safety',
          killTree: async (_pid, signal) => {
            calls.push(`signal:${signal}`)
          },
          markKilled: async selected => {
            calls.push(`mark:${selected.id}`)
            return { ...selected, status: 'killed' }
          },
        },
      ),
    ).rejects.toThrow('PID ownership cannot be re-established safely')

    expect(calls).toEqual([])
  })

  it('allows an exact marked identity to authorize a previously stale session', async () => {
    const calls: string[] = []
    const states: BackgroundSessionProcessIdentity['state'][] = [
      'matches',
      'matches',
    ]

    const killed = await killBackgroundSession(
      { ...markedSession, status: 'stale' },
      {
        isProcessAlive: () => false,
        verifySessionIdentity: () => {
          const state = states.shift()!
          calls.push(`verify:${state}`)
          return identity(state)
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      },
    )

    expect(killed.status).toBe('killed')
    expect(calls).toEqual([
      'verify:matches',
      'verify:matches',
      'signal:SIGTERM',
      'mark:bg-safety',
    ])
  })

  it('marks a stale session killed without signalling when its PID is gone', async () => {
    const calls: string[] = []

    const killed = await killBackgroundSession(
      { ...session, status: 'stale' },
      {
        isProcessAlive: () => false,
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      },
    )

    expect(killed.status).toBe('killed')
    expect(calls).toEqual(['mark:bg-safety'])
  })

  it('freshly verifies an unknown session that becomes readable before killing', async () => {
    const calls: string[] = []
    const states: BackgroundSessionProcessIdentity['state'][] = [
      'matches',
      'matches',
    ]

    const killed = await killBackgroundSession(
      { ...session, status: 'unknown' },
      {
        isProcessAlive: () => false,
        verifySessionIdentity: () => {
          const state = states.shift()!
          calls.push(`verify:${state}`)
          return identity(state)
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      },
    )

    expect(killed.status).toBe('killed')
    expect(calls).toEqual([
      'verify:matches',
      'verify:matches',
      'signal:SIGTERM',
      'mark:bg-safety',
    ])
  })

  it('treats an unknown session that exits during fresh verification as terminated', async () => {
    const calls: string[] = []
    let aliveChecks = 0

    const killed = await killBackgroundSession(
      { ...session, status: 'unknown' },
      {
        isProcessAlive: () => ++aliveChecks === 1,
        getProcessCommand: () => null,
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      },
    )

    expect(killed.status).toBe('killed')
    expect(calls).toEqual(['mark:bg-safety'])
  })

  it('does not escalate when identity changes during the SIGTERM grace period', async () => {
    const calls: string[] = []
    const states: BackgroundSessionProcessIdentity['state'][] = [
      'matches',
      'mismatch',
    ]

    await expect(
      terminateBackgroundSessionProcessTree(session, {
        isProcessAlive: () => true,
        verifySessionIdentity: () => {
          const state = states.shift()!
          calls.push(`verify:${state}`)
          return identity(state)
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        sleep: async () => {
          calls.push('sleep')
        },
        termGraceMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual([
      'verify:matches',
      'signal:SIGTERM',
      'sleep',
      'verify:mismatch',
    ])
  })

  it('does not send SIGKILL when a marked token changes after SIGTERM', async () => {
    const calls: string[] = []
    const commands = [
      `node openclaude ${backgroundProcessMarkerToken(TEST_PROCESS_MARKER)} --session-id conversation-safety`,
      `node openclaude ${backgroundProcessMarkerToken(OTHER_PROCESS_MARKER)} --session-id conversation-safety`,
    ]

    await expect(
      terminateBackgroundSessionProcessTree(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () => {
          calls.push('verify')
          return commands.shift()!
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        sleep: async () => {
          calls.push('sleep')
        },
        termGraceMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual([
      'verify',
      'signal:SIGTERM',
      'sleep',
      'verify',
    ])
  })

  it('fails closed when the live process identity is unreadable', async () => {
    const signals: Array<string | number> = []

    await expect(
      terminateBackgroundSessionProcessTree(session, {
        isProcessAlive: () => true,
        getProcessCommand: () => null,
        killTree: async (_pid, signal) => {
          signals.push(signal)
        },
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(signals).toEqual([])
  })

  it('does not mark a marked session killed when identity is unreadable', async () => {
    const calls: string[] = []

    await expect(
      killBackgroundSession(markedSession, {
        isProcessAlive: () => true,
        getProcessCommand: () => null,
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual([])
  })

  it('refuses signalling when liveness becomes unreadable during command lookup', async () => {
    const calls: string[] = []
    let probes = 0

    await expect(
      terminateBackgroundSessionProcessTree(session, {
        signalProcess: () => {
          probes++
          calls.push(`probe:${probes}`)
          if (probes > 1) {
            throw Object.assign(new Error('access denied'), { code: 'EPERM' })
          }
        },
        getProcessCommand: () => {
          calls.push('command')
          return 'node openclaude --session-id conversation-safety'
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        sleep: async () => {},
        termGraceMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow('refused to signal an unverified process')

    expect(calls).toEqual(['probe:1', 'command', 'probe:2'])
  })

  it('succeeds without signalling when the process exits before verification', async () => {
    const calls: string[] = []

    const killed = await killBackgroundSession(session, {
      isProcessAlive: () => false,
      getProcessCommand: () => {
        calls.push('command')
        return null
      },
      killTree: async (_pid, signal) => {
        calls.push(`signal:${signal}`)
      },
      markKilled: async selected => {
        calls.push(`mark:${selected.id}`)
        return { ...selected, status: 'killed' }
      },
    })

    expect(killed.status).toBe('killed')
    expect(calls).toEqual(['mark:bg-safety'])
  })

  it('accepts a natural exit after verification without a misleading error', async () => {
    const calls: string[] = []

    await terminateBackgroundSessionProcessTree(session, {
      isProcessAlive: () => false,
      verifySessionIdentity: () => {
        calls.push('verify')
        return identity('matches')
      },
      killTree: async (_pid, signal) => {
        calls.push(`signal:${signal}`)
      },
      sleep: async () => {
        calls.push('sleep')
      },
      termGraceMs: 1,
      pollIntervalMs: 1,
    })

    expect(calls).toEqual(['verify', 'signal:SIGTERM'])
  })

  it('revalidates a stable identity immediately before SIGKILL', async () => {
    const calls: string[] = []
    let aliveChecks = 0

    await terminateBackgroundSessionProcessTree(session, {
      isProcessAlive: () => ++aliveChecks < 4,
      verifySessionIdentity: () => {
        calls.push('verify')
        return identity('matches')
      },
      killTree: async (_pid, signal) => {
        calls.push(`signal:${signal}`)
      },
      sleep: async () => {
        calls.push('sleep')
      },
      termGraceMs: 1,
      killGraceMs: 1,
      pollIntervalMs: 1,
    })

    expect(calls).toEqual([
      'verify',
      'signal:SIGTERM',
      'sleep',
      'verify',
      'signal:SIGKILL',
      'sleep',
    ])
  })

  it('rejects stale verifier results for another session or PID', async () => {
    for (const staleIdentity of [
      identity('matches', { backgroundSessionId: 'bg-unrelated' }),
      identity('matches', { pid: 9001 }),
    ]) {
      const signals: Array<string | number> = []

      await expect(
        terminateBackgroundSessionProcessTree(session, {
          isProcessAlive: () => true,
          verifySessionIdentity: () => staleIdentity,
          killTree: async (_pid, signal) => {
            signals.push(signal)
          },
        }),
      ).rejects.toThrow('refused to signal an unverified process')

      expect(signals).toEqual([])
    }
  })

  it('sanitizes throwing injected identity verifiers without signalling or marking', async () => {
    const calls: string[] = []
    let refusal: unknown

    try {
      await killBackgroundSession(session, {
        verifySessionIdentity: () => {
          throw new Error('private verifier details')
        },
        killTree: async (_pid, signal) => {
          calls.push(`signal:${signal}`)
        },
        markKilled: async selected => {
          calls.push(`mark:${selected.id}`)
          return { ...selected, status: 'killed' }
        },
      })
    } catch (error) {
      refusal = error
    }

    expect(String(refusal)).toContain('refused to signal an unverified process')
    expect(String(refusal)).not.toContain('private verifier details')
    expect(calls).toEqual([])
  })
})

describe('background session log streaming', () => {
  it('emits a multi-megabyte existing log exactly with bounded allocations', async () => {
    await withTempFile('stdout.log', async path => {
      const chunkSize = LOG_STREAM_CHUNK_SIZE
      const contents = Buffer.alloc(chunkSize * 32 + 123)
      for (let i = 0; i < contents.length; i++) contents[i] = i % 251
      await writeFile(path, contents)

      const allocations: number[] = []
      const output = new TestOutput()
      const offset = await printExistingLog(path, {
        output,
        chunkSize,
        createBuffer: size => {
          allocations.push(size)
          return Buffer.alloc(size)
        },
      })

      expect(offset).toBe(contents.length)
      expect(output.bytes()).toEqual(contents)
      expect(Math.max(...allocations)).toBeLessThanOrEqual(chunkSize)
      expect(allocations.length).toBeGreaterThan(1)
    })
  })

  it('follow mode emits existing and appended content exactly once in order', async () => {
    await withTempFile('stdout.log', async path => {
      const output = new TestOutput()
      await writeFile(path, Buffer.from('existing-'))

      const offset = await printExistingLog(path, { output, chunkSize: 4 })
      const scheduler = createManualScheduler()
      const abort = new AbortController()
      const following = followLogFile(path, offset, {
        output,
        chunkSize: 4,
        signal: abort.signal,
        setInterval: scheduler.setInterval,
        clearInterval: scheduler.clearInterval,
      })

      await writeFile(path, Buffer.from('existing-appended'))
      scheduler.tick()
      await waitFor(() => output.bytes().toString() === 'existing-appended')
      abort.abort()
      await following

      expect(output.bytes().toString()).toBe('existing-appended')
    })
  })

  it('splits a large appended range into bounded chunks', async () => {
    await withTempFile('stdout.log', async path => {
      const chunkSize = 16
      await writeFile(path, Buffer.from('seed'))
      const appended = Buffer.alloc(chunkSize * 2 + 5, 7)
      await writeFile(path, Buffer.concat([Buffer.from('seed'), appended]))

      const output = new TestOutput()
      const scheduler = createManualScheduler()
      const abort = new AbortController()
      const following = followLogFile(path, 4, {
        output,
        chunkSize,
        signal: abort.signal,
        setInterval: scheduler.setInterval,
        clearInterval: scheduler.clearInterval,
      })

      scheduler.tick()
      await waitFor(() => output.bytes().length === appended.length)
      abort.abort()
      await following

      expect(output.bytes()).toEqual(appended)
      expect(output.chunks.map(chunk => chunk.length)).toEqual([16, 16, 5])
    })
  })

  it('waits for drain before reading or writing more when stdout applies backpressure', async () => {
    await withTempFile('stdout.log', async path => {
      await writeFile(path, Buffer.from('abcdef'))
      const output = new TestOutput()
      output.writeResults.push(false)

      let settled = false
      const printing = printExistingLog(path, { output, chunkSize: 3 }).then(
        offset => {
          settled = true
          return offset
        },
      )

      await waitFor(() => output.chunks.length === 1)
      expect(output.bytes().toString()).toBe('abc')
      expect(settled).toBe(false)

      output.emit('drain')
      await expect(printing).resolves.toBe(6)
      expect(output.bytes().toString()).toBe('abcdef')
      expect(output.chunks.map(chunk => chunk.length)).toEqual([3, 3])
    })
  })

  it('resets the follow read position when the log is truncated', async () => {
    await withTempFile('stdout.log', async path => {
      await writeFile(path, Buffer.from('abcdef'))
      const output = new TestOutput()
      const scheduler = createManualScheduler()
      const abort = new AbortController()
      const following = followLogFile(path, 6, {
        output,
        chunkSize: 8,
        signal: abort.signal,
        setInterval: scheduler.setInterval,
        clearInterval: scheduler.clearInterval,
      })

      await writeFile(path, Buffer.from('xy'))
      scheduler.tick()
      await waitFor(() => output.bytes().toString() === 'xy')
      abort.abort()
      await following

      expect(output.bytes().toString()).toBe('xy')
    })
  })

  it('tolerates temporary file disappearance while following', async () => {
    await withTempFile('stdout.log', async path => {
      await writeFile(path, Buffer.from('seed'))
      const output = new TestOutput()
      const scheduler = createManualScheduler()
      const abort = new AbortController()
      const following = followLogFile(path, 4, {
        output,
        chunkSize: 8,
        signal: abort.signal,
        setInterval: scheduler.setInterval,
        clearInterval: scheduler.clearInterval,
      })

      await unlink(path)
      scheduler.tick()
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(output.bytes().length).toBe(0)

      await writeFile(path, Buffer.from('new'))
      scheduler.tick()
      await waitFor(() => output.bytes().toString() === 'new')
      abort.abort()
      await following

      expect(output.bytes().toString()).toBe('new')
    })
  })

  it('prevents writes after signal cleanup during an in-flight poll', async () => {
    const output = new TestOutput()
    const scheduler = createManualScheduler()
    const abort = new AbortController()
    const readStarted = deferred()
    const releaseRead = deferred()
    let closed = false

    const handle = {
      stat: async () => ({ size: 4 }),
      read: async (buffer: Buffer) => {
        readStarted.resolve()
        await releaseRead.promise
        buffer.write('late')
        return { bytesRead: 4, buffer }
      },
      close: async () => {
        closed = true
      },
    }

    let resolved = false
    const following = followLogFile('/tmp/stdout.log', 0, {
      output,
      chunkSize: 4,
      signal: abort.signal,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
      openFile: async () => handle,
    }).then(() => {
      resolved = true
    })

    scheduler.tick()
    await readStarted.promise
    abort.abort()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolved).toBe(false)
    releaseRead.resolve()
    await following
    scheduler.tick()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(scheduler.cleared).toBe(true)
    expect(closed).toBe(true)
    expect(output.bytes().length).toBe(0)
  })

  it('preserves streamed progress when a later close failure occurs', async () => {
    const output = new TestOutput()
    const scheduler = createManualScheduler()
    const abort = new AbortController()
    let openCount = 0

    const following = followLogFile('/tmp/stdout.log', 0, {
      output,
      chunkSize: 4,
      signal: abort.signal,
      setInterval: scheduler.setInterval,
      clearInterval: scheduler.clearInterval,
      openFile: async () => {
        openCount++
        return {
          stat: async () => ({ size: 4 }),
          read: async (buffer: Buffer) => {
            buffer.write('once')
            return { bytesRead: 4 }
          },
          close: async () => {
            if (openCount === 1) throw new Error('close failed')
          },
        }
      },
    })

    scheduler.tick()
    await waitFor(() => output.bytes().toString() === 'once')
    scheduler.tick()
    await waitFor(() => openCount === 2)
    await new Promise(resolve => setTimeout(resolve, 0))
    abort.abort()
    await following

    expect(output.bytes().toString()).toBe('once')
  })

  it('surfaces non-follow file read failures', async () => {
    let closed = false
    const readError = Object.assign(new Error('read failed'), {
      code: 'EIO',
    })

    await expect(
      printExistingLog('/tmp/stdout.log', {
        chunkSize: 4,
        openFile: async () => ({
          stat: async () => ({ size: 4 }),
          read: async () => {
            throw readError
          },
          close: async () => {
            closed = true
          },
        }),
      }),
    ).rejects.toThrow('read failed')
    expect(closed).toBe(true)
  })

  it('handles EPIPE and destroyed stdout without throwing', async () => {
    await withTempFile('stdout.log', async path => {
      await writeFile(path, Buffer.from('closed-pipe'))

      const epipeOutput = new TestOutput()
      epipeOutput.writeError = Object.assign(new Error('broken pipe'), {
        code: 'EPIPE',
      })
      await expect(
        printExistingLog(path, { output: epipeOutput, chunkSize: 4 }),
      ).resolves.toBe(0)

      const destroyedOutput = new TestOutput()
      destroyedOutput.destroyed = true
      await expect(
        printExistingLog(path, { output: destroyedOutput, chunkSize: 4 }),
      ).resolves.toBe(0)
      expect(destroyedOutput.bytes().length).toBe(0)
    })
  })
})
