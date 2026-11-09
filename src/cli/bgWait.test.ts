import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { parseWaitInvocation, waitHandler } from './bgWait.js'
import {
  _setBackgroundSessionsRootForTesting,
  BackgroundSessionWaitError,
  createBackgroundSession,
  markBackgroundSessionKilled,
  recordBackgroundSessionNaturalTermination,
  type BackgroundSession,
} from './bgRegistry.js'

const POLL_MS = 10
const FAKE_PID = 424242

class CaptureOutput {
  chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  text(): string {
    return this.chunks.join('')
  }
}

function parseErrorCode(args: string[]): string | undefined {
  try {
    parseWaitInvocation(args)
    return undefined
  } catch (error) {
    if (error instanceof BackgroundSessionWaitError) return error.code
    throw error
  }
}

describe('wait command argument parsing', () => {
  it('parses a bare selector', () => {
    expect(parseWaitInvocation(['bg-1234'])).toEqual({
      selector: 'bg-1234',
      timeoutMs: undefined,
      json: false,
      help: false,
    })
  })

  it('accepts flags before or after the selector', () => {
    expect(parseWaitInvocation(['--json', 'bg-1', '--timeout', '30s'])).toEqual({
      selector: 'bg-1',
      timeoutMs: 30_000,
      json: true,
      help: false,
    })
    expect(parseWaitInvocation(['bg-1', '--timeout=30s', '--json'])).toEqual({
      selector: 'bg-1',
      timeoutMs: 30_000,
      json: true,
      help: false,
    })
  })

  it('accepts ms, s, m, and h duration suffixes', () => {
    expect(parseWaitInvocation(['bg-1', '--timeout', '500ms']).timeoutMs).toBe(500)
    expect(parseWaitInvocation(['bg-1', '--timeout', '90s']).timeoutMs).toBe(90_000)
    expect(parseWaitInvocation(['bg-1', '--timeout', '2m']).timeoutMs).toBe(120_000)
    expect(parseWaitInvocation(['bg-1', '--timeout', '1h']).timeoutMs).toBe(3_600_000)
    expect(parseWaitInvocation(['bg-1', '--timeout', '2147483647ms']).timeoutMs).toBe(2_147_483_647)
  })

  it('accepts -- before a dash-leading selector', () => {
    expect(parseWaitInvocation(['--', '-foo']).selector).toBe('-foo')
    expect(parseWaitInvocation(['--json', '--', '-foo']).selector).toBe('-foo')
  })

  it('prints help for -h or --help', () => {
    expect(parseWaitInvocation(['--help']).help).toBe(true)
    expect(parseWaitInvocation(['-h']).help).toBe(true)
    // Help wins over other arguments.
    expect(parseWaitInvocation(['--timeout', 'bogus', '--help']).help).toBe(true)
  })

  it('rejects a missing selector', () => {
    expect(parseErrorCode([])).toBe('invalid_arguments')
    expect(parseErrorCode(['--json'])).toBe('invalid_arguments')
    expect(parseErrorCode(['--timeout', '30s'])).toBe('invalid_arguments')
  })

  it('rejects an empty selector with and without --', () => {
    // An empty variable passed as the selector must not resolve: an empty
    // string is a prefix of every session id, so with one session present
    // it would pin that unrelated session (CodeRabbit #2497).
    expect(parseErrorCode([''])).toBe('invalid_arguments')
    expect(parseErrorCode(['--', ''])).toBe('invalid_arguments')
    expect(parseErrorCode(['--json', ''])).toBe('invalid_arguments')
  })

  it('rejects extra arguments', () => {
    expect(parseErrorCode(['bg-1', 'bg-2'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--', 'bg-2'])).toBe('invalid_arguments')
    expect(parseErrorCode(['--', 'bg-1', 'bg-2'])).toBe('invalid_arguments')
  })

  it('rejects zero, negative, fractional, and suffix-less durations', () => {
    expect(parseErrorCode(['bg-1', '--timeout', '0s'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '0ms'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '-5s'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '1.5s'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '30'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '30sec'])).toBe('invalid_arguments')
  })

  it('rejects overflowed durations above the 2,147,483,647 ms timer bound', () => {
    expect(parseErrorCode(['bg-1', '--timeout', '2147483648ms'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '99999999999999999999h'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout', '60000m'])).toBe('invalid_arguments')
  })

  it('rejects duplicate flags', () => {
    expect(parseErrorCode(['bg-1', '--timeout', '30s', '--timeout', '10s'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout=30s', '--timeout=10s'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--json', '--json'])).toBe('invalid_arguments')
  })

  it('rejects unknown flags including --follow', () => {
    expect(parseErrorCode(['bg-1', '--follow'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--unknown'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '-x'])).toBe('invalid_arguments')
  })

  it('rejects a missing or empty --timeout value', () => {
    expect(parseErrorCode(['bg-1', '--timeout'])).toBe('invalid_arguments')
    expect(parseErrorCode(['bg-1', '--timeout='])).toBe('invalid_arguments')
  })
})

describe('wait command handler', () => {
  let configDir: string
  let registryRoot: string
  let stdout: CaptureOutput
  let stderr: CaptureOutput
  let savedExitCode: typeof process.exitCode

  function metadataPath(id: string): string {
    return join(registryRoot, 'sessions', `${id}.json`)
  }

  function terminalFactPath(id: string, kind: 'natural' | 'killed'): string {
    return join(registryRoot, 'terminal', `${id}.${kind}.json`)
  }

  async function createTestSession(
    id: string,
    options: { name?: string; pid?: number; command?: string[] } = {},
  ): Promise<BackgroundSession> {
    return await createBackgroundSession({
      id,
      ...(options.name ? { name: options.name } : {}),
      pid: options.pid ?? FAKE_PID,
      cwd: configDir,
      command: options.command ?? ['sleep', '30'],
      sessionId: `sess-${id}`,
    })
  }

  async function finishSession(
    id: string,
    termination: { exitCode: number } | { signal: string },
    pid: number = FAKE_PID,
  ): Promise<void> {
    await recordBackgroundSessionNaturalTermination(
      id,
      termination as { exitCode: number; signal?: never },
      { ownerPid: pid },
    )
  }

  function writeTerminalFactSync(
    id: string,
    kind: 'natural' | 'killed',
    fact: Record<string, unknown>,
  ): void {
    writeFileSync(
      terminalFactPath(id, kind),
      JSON.stringify({ version: 1, id, pid: FAKE_PID, ...fact }),
    )
  }

  async function snapshotRegistry(): Promise<Map<string, string>> {
    const snapshot = new Map<string, string>()
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const path = join(dir, entry)
        const rel = prefix ? `${prefix}/${entry}` : entry
        try {
          const content = await readFile(path, 'utf8')
          snapshot.set(rel, content)
        } catch {
          await walk(path, rel)
        }
      }
    }
    await walk(registryRoot, '')
    return snapshot
  }

  async function runWait(
    args: string[],
    options: Parameters<typeof waitHandler>[1] = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    stdout = new CaptureOutput()
    stderr = new CaptureOutput()
    const code = await waitHandler(args, {
      pollIntervalMs: POLL_MS,
      stdout,
      stderr,
      ...options,
    })
    return { code, stdout: stdout.text(), stderr: stderr.text() }
  }

  function expectWaitJsonShape(value: unknown): Record<string, unknown> {
    const result = value as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(
      [
        'error',
        'exitCode',
        'finishedAt',
        'id',
        'signal',
        'status',
        'terminalReason',
        'version',
        'waitResult',
        'waitSignal',
      ].sort(),
    )
    expect(result.version).toBe(1)
    return result
  }

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-wait-test-'))
    registryRoot = join(configDir, 'bg-sessions')
    _setBackgroundSessionsRootForTesting(registryRoot)
    savedExitCode = process.exitCode
  })

  afterEach(async () => {
    _setBackgroundSessionsRootForTesting(undefined)
    process.exitCode = savedExitCode
    await rm(configDir, { recursive: true, force: true })
  })

  it('returns exit 2 with a selector_error JSON object for an unknown selector', async () => {
    const { code, stdout, stderr } = await runWait(['no-such-session', '--json'])

    expect(code).toBe(2)
    expect(process.exitCode).toBe(2)
    expect(stderr).toBe('')
    expect(stdout.trim().split('\n')).toHaveLength(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result).toEqual({
      version: 1,
      id: null,
      status: null,
      exitCode: null,
      signal: null,
      terminalReason: null,
      finishedAt: null,
      waitResult: 'selector_error',
      error: 'not_found',
      waitSignal: null,
    })
  })

  it('returns exit 2 with an internal_error JSON object when selector resolution throws unexpectedly', async () => {
    // An unexpected failure (e.g. a home-directory lookup failing during
    // selector resolution) must not look like a child failure (exit 1) and
    // must still emit parseable JSON (CodeRabbit #2497).
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'], {
      resolveSession: async () => {
        throw new Error('home directory lookup failed')
      },
    })

    expect(code).toBe(2)
    expect(process.exitCode).toBe(2)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result).toEqual({
      version: 1,
      id: null,
      status: null,
      exitCode: null,
      signal: null,
      terminalReason: null,
      finishedAt: null,
      waitResult: 'internal_error',
      error: 'internal_error',
      waitSignal: null,
    })
  })

  it('returns exit 2 with the raw error on stderr in human mode when selector resolution throws unexpectedly', async () => {
    const { code, stdout, stderr } = await runWait(['bg-aaa1'], {
      resolveSession: async () => {
        throw new Error('home directory lookup failed')
      },
    })

    expect(code).toBe(2)
    expect(process.exitCode).toBe(2)
    expect(stdout).toBe('')
    expect(stderr).toBe('Error: home directory lookup failed\n')
  })

  it('returns exit 2 with invalid_arguments for a missing selector', async () => {
    const { code, stdout, stderr } = await runWait(['--json'])

    expect(code).toBe(2)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('selector_error')
    expect(result.error).toBe('invalid_arguments')
  })

  it('prints a one-line usage error on stderr in human mode', async () => {
    const { code, stdout, stderr } = await runWait(['no-such-session'])

    expect(code).toBe(2)
    expect(stdout).toBe('')
    expect(stderr.trim().split('\n')).toHaveLength(1)
    expect(stderr).toContain('No background session found for "no-such-session"')
  })

  it('returns 0 with the exact human line for an already-terminal exit-zero session without sleeping', async () => {
    await createTestSession('bg-aaa1')
    await finishSession('bg-aaa1', { exitCode: 0 })
    let sleepCalls = 0
    const { code, stdout, stderr } = await runWait(['bg-aaa1'], {
      sleep: async () => {
        sleepCalls += 1
      },
    })

    expect(code).toBe(0)
    expect(stdout).toBe('Background session bg-aaa1 exited with code 0.\n')
    expect(stderr).toBe('')
    expect(sleepCalls).toBe(0)
  })

  it('returns 0 with exact JSON for an already-terminal exit-zero session', async () => {
    await createTestSession('bg-aaa1')
    await finishSession('bg-aaa1', { exitCode: 0 })
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.status).toBe('exited')
    expect(result.exitCode).toBe(0)
    expect(result.signal).toBeNull()
    expect(result.terminalReason).toBe('exit_code')
    expect(typeof result.finishedAt).toBe('string')
    expect(result.waitResult).toBe('terminal')
    expect(result.error).toBeNull()
    expect(result.waitSignal).toBeNull()
  })

  it('reports the exact child exit code above 255 in JSON and returns shell 1', async () => {
    await createTestSession('bg-aaa1')
    await finishSession('bg-aaa1', { exitCode: 300 })
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(300)
    expect(result.terminalReason).toBe('exit_code')

    const human = await runWait(['bg-aaa1'])
    expect(human.code).toBe(1)
    expect(human.stdout).toBe('Background session bg-aaa1 failed with exit code 300.\n')
  })

  it('preserves a recorded exit code for a failed session without terminalReason', async () => {
    // A valid failed record can carry exitCode without terminalReason
    // (terminalReason is optional on BackgroundSession); the JSON must keep
    // the recorded code instead of dropping it, and human output must not
    // invent exit code 1 (CodeRabbit #2497).
    const session = await createTestSession('bg-aaa1')
    await writeFile(
      metadataPath('bg-aaa1'),
      JSON.stringify({
        ...session,
        status: 'failed',
        exitCode: 300,
        finishedAt: new Date().toISOString(),
      }),
    )
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(300)
    expect(result.terminalReason).toBeNull()

    const human = await runWait(['bg-aaa1'])
    expect(human.code).toBe(1)
    expect(human.stdout).toBe('Background session bg-aaa1 failed with exit code 300.\n')
  })

  it('reports an unknown outcome without inventing an exit code for a failed session without terminalReason or exitCode', async () => {
    const session = await createTestSession('bg-aaa1')
    await writeFile(
      metadataPath('bg-aaa1'),
      JSON.stringify({
        ...session,
        status: 'failed',
        finishedAt: new Date().toISOString(),
      }),
    )
    const { code, stdout } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.terminalReason).toBeNull()

    const human = await runWait(['bg-aaa1'])
    expect(human.code).toBe(1)
    expect(human.stdout).toBe(
      'Background session bg-aaa1 failed with an unknown outcome.\n',
    )
  })

  it('reports a child signal with shell 1', async () => {
    await createTestSession('bg-aaa1')
    await finishSession('bg-aaa1', { signal: 'SIGTERM' })
    const { code, stdout } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBe('SIGTERM')
    expect(result.terminalReason).toBe('signal')

    const human = await runWait(['bg-aaa1'])
    expect(human.stdout).toBe('Background session bg-aaa1 failed after SIGTERM.\n')
  })

  it('reports an explicit kill with shell 1', async () => {
    await createTestSession('bg-aaa1')
    await markBackgroundSessionKilled('bg-aaa1')
    const { code, stdout } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('killed')
    expect(result.exitCode).toBeNull()
    expect(result.signal).toBeNull()
    expect(result.terminalReason).toBe('explicit_kill')
    expect(typeof result.finishedAt).toBe('string')

    const human = await runWait(['bg-aaa1'])
    expect(human.stdout).toBe('Background session bg-aaa1 was killed.\n')
  })

  it('reports stale with shell 1 when the process is gone without a terminal fact', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout } = await runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => false,
    })

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('stale')
    expect(result.exitCode).toBeNull()
    expect(result.terminalReason).toBeNull()
    expect(result.finishedAt).toBeNull()

    const human = await runWait(['bg-aaa1'], { isProcessAlive: () => false })
    expect(human.stdout).toBe(
      'Background session bg-aaa1 became stale without an observable child outcome.\n',
    )
  })

  it('returns 124 with running JSON on timeout', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout, stderr } = await runWait(
      ['bg-aaa1', '--timeout', '60ms', '--json'],
      {
        isProcessAlive: () => true,
        getProcessCommandAsync: async () => 'sleep 30',
      },
    )

    expect(code).toBe(124)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.status).toBe('running')
    expect(result.waitResult).toBe('timeout')
    expect(result.error).toBe('timeout')
    expect(result.finishedAt).toBeNull()
  })

  it('returns 3 with unknown JSON when the process stays unreadable past the deadline', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout, stderr } = await runWait(
      ['bg-aaa1', '--timeout', '60ms', '--json'],
      {
        isProcessAlive: () => true,
        getProcessCommandAsync: async () => null,
      },
    )

    expect(code).toBe(3)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('unknown')
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('process_unreadable')
  })

  it('recovers from one transient unknown observation and reports the terminal outcome', async () => {
    await createTestSession('bg-aaa1')
    let lookups = 0
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => {
        lookups += 1
        return lookups === 1 ? null : 'sleep 30'
      },
    })
    // Publish the terminal fact while the waiter is polling.
    await new Promise(resolve => setTimeout(resolve, 50))
    await finishSession('bg-aaa1', { exitCode: 0 })
    const { code, stdout } = await waiting

    expect(code).toBe(0)
    expect(lookups).toBeGreaterThanOrEqual(2)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('exited')
  })

  it('lets a natural fact published during liveness lookup win over stale', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout } = await runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => {
        writeTerminalFactSync('bg-aaa1', 'natural', {
          status: 'exited',
          finishedAt: new Date().toISOString(),
          terminalReason: 'exit_code',
          exitCode: 0,
        })
        return 'sleep 30'
      },
    })

    expect(code).toBe(0)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('exited')
  })

  it('lets a killed fact published during liveness lookup win over running', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout } = await runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => {
        writeTerminalFactSync('bg-aaa1', 'killed', {
          status: 'killed',
          finishedAt: new Date().toISOString(),
          terminalReason: 'explicit_kill',
        })
        // Deliberately mismatching the stored ['sleep', '30'] command: the
        // waiter must let the killed fact published during the lookup win
        // over the stale classification, so this test only passes if the
        // re-read before stale classification runs (CodeRabbit #2497).
        return 'sleep 999'
      },
    })

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('killed')
  })

  it('lets a terminal fact published before the final deadline read win over timeout', async () => {
    await createTestSession('bg-aaa1')
    let lookups = 0
    const { code, stdout } = await runWait(
      ['bg-aaa1', '--timeout', '200ms', '--json'],
      {
        isProcessAlive: () => true,
        getProcessCommandAsync: async () => {
          lookups += 1
          if (lookups === 2) {
            writeTerminalFactSync('bg-aaa1', 'natural', {
              status: 'exited',
              finishedAt: new Date().toISOString(),
              terminalReason: 'exit_code',
              exitCode: 0,
            })
          }
          return 'sleep 30'
        },
      },
    )

    expect(code).toBe(0)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('exited')
  })

  it('resolves by exact ID, live name, ID prefix, and terminal name', async () => {
    await createTestSession('bg-aaa1', { name: 'nightly' })
    await finishSession('bg-aaa1', { exitCode: 0 })
    await createTestSession('bg-bbb2', { name: 'worker' })

    const byId = await runWait(['bg-aaa1', '--json'], { isProcessAlive: () => true, getProcessCommandAsync: async () => 'sleep 30' })
    expect(byId.code).toBe(0)
    expect(JSON.parse(byId.stdout).id).toBe('bg-aaa1')

    const byLiveName = await runWait(['worker', '--timeout', '50ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    expect(byLiveName.code).toBe(124)
    expect(JSON.parse(byLiveName.stdout).id).toBe('bg-bbb2')

    const byPrefix = await runWait(['bg-bbb', '--timeout', '50ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    expect(byPrefix.code).toBe(124)
    expect(JSON.parse(byPrefix.stdout).id).toBe('bg-bbb2')

    // Terminal name resolves when no live session has the name.
    const byTerminalName = await runWait(['nightly', '--json'])
    expect(byTerminalName.code).toBe(0)
    expect(JSON.parse(byTerminalName.stdout).id).toBe('bg-aaa1')
  })

  it('pins the selected session when its name is reused by a new session', async () => {
    const pid1 = 111001
    const pid2 = 111002
    await createTestSession('bg-aaa1', { name: 'foo', pid: pid1 })
    const waiting = runWait(['foo', '--json'], {
      isProcessAlive: pid => pid === pid1 || pid === pid2,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    // While waiting: kill bg-aaa1 and start a new live session named foo.
    await new Promise(resolve => setTimeout(resolve, 40))
    await markBackgroundSessionKilled('bg-aaa1')
    await createTestSession('bg-aaa2', { name: 'foo', pid: pid2 })
    const { code, stdout } = await waiting

    expect(code).toBe(1)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.status).toBe('killed')
  })

  it('returns ambiguous for a later ID-prefix collision', async () => {
    await createTestSession('bg-aaaa1111')
    await createTestSession('bg-aaaa2222')
    const { code, stdout, stderr } = await runWait(['bg-aaaa', '--json'])

    expect(code).toBe(2)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('selector_error')
    expect(result.error).toBe('ambiguous')
    expect(result.id).toBeNull()
  })

  it('returns ambiguous when two terminal sessions share a name', async () => {
    await createTestSession('bg-aaa1', { name: 'dup' })
    await finishSession('bg-aaa1', { exitCode: 0 })
    await createTestSession('bg-aaa2', { name: 'dup' })
    await finishSession('bg-aaa2', { exitCode: 0 })
    const { code, stdout } = await runWait(['dup', '--json'])

    expect(code).toBe(2)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.error).toBe('ambiguous')
  })

  it('returns metadata_malformed for a malformed exact-ID metadata file', async () => {
    await createTestSession('bg-aaa1')
    await writeFile(metadataPath('bg-aaa1'), '{not json')
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(4)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('metadata_malformed')
    expect(result.id).toBeNull()
  })

  it('returns metadata_malformed for a malformed terminal fact', async () => {
    await createTestSession('bg-aaa1')
    await mkdir(join(registryRoot, 'terminal'), { recursive: true })
    await writeFile(terminalFactPath('bg-aaa1', 'natural'), '{not json')
    const { code, stdout } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.error).toBe('metadata_malformed')
  })

  it('returns metadata_malformed for an exited record without an exit code', async () => {
    // A valid `exited` record that records no exit code must not be
    // reported as a success: the authoritative natural terminal fact
    // requires exitCode 0 for `exited`, so nothing corroborates the
    // claim, and defaulting to 0 would invent a child success
    // (ChatGPT post-build review on #2497).
    const session = await createTestSession('bg-aaa1')
    await writeFile(
      metadataPath('bg-aaa1'),
      JSON.stringify({
        ...session,
        status: 'exited',
        finishedAt: new Date().toISOString(),
        terminalReason: 'exit_code',
      }),
    )
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(4)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('metadata_malformed')
    expect(result.id).toBe('bg-aaa1')
  })

  it('returns metadata_unreadable when a name-resolution entry cannot be read', async () => {
    await createTestSession('bg-aaa1', { name: 'target' })
    // Replace an unrelated session's metadata file with a directory: the
    // entry can no longer be read, and it could have been the named session.
    await createTestSession('bg-bbb2')
    await rm(metadataPath('bg-bbb2'))
    await mkdir(metadataPath('bg-bbb2'))
    const { code, stdout } = await runWait(['target', '--json'])

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.error).toBe('metadata_unreadable')
    expect(result.id).toBeNull()
  })

  it('does not scan unrelated entries when the exact ID matches', async () => {
    await createTestSession('bg-aaa1')
    await finishSession('bg-aaa1', { exitCode: 0 })
    await createTestSession('bg-bbb2')
    await rm(metadataPath('bg-bbb2'))
    await mkdir(metadataPath('bg-bbb2'))
    const { code, stdout } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(0)
    expect(JSON.parse(stdout).id).toBe('bg-aaa1')
  })

  it('returns metadata_missing when pinned metadata disappears mid-wait', async () => {
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    await rm(metadataPath('bg-aaa1'))
    const { code, stdout } = await waiting

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.error).toBe('metadata_missing')
    expect(result.id).toBe('bg-aaa1')
  })

  it('returns metadata_replaced when the pinned PID changes mid-wait', async () => {
    const session = await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    await writeFile(
      metadataPath('bg-aaa1'),
      JSON.stringify({ ...session, pid: FAKE_PID + 1 }),
    )
    const { code, stdout } = await waiting

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.error).toBe('metadata_replaced')
    expect(result.id).toBe('bg-aaa1')
  })

  it('returns 130 with interrupted JSON on SIGINT during sleep', async () => {
    const before = process.listenerCount('SIGINT')
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    process.emit('SIGINT')
    const { code, stdout, stderr } = await waiting

    expect(code).toBe(130)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.status).toBeNull()
    expect(result.waitResult).toBe('interrupted')
    expect(result.error).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
    expect(process.listenerCount('SIGINT')).toBe(before)
  })

  it('returns 143 with interrupted JSON on SIGTERM during sleep', async () => {
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    process.emit('SIGTERM')
    const { code, stdout } = await waiting

    expect(code).toBe(143)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGTERM')
  })

  it('lets SIGINT during the process lookup win over the observation', async () => {
    let releaseLookup!: (command: string) => void
    const lookup = new Promise<string>(resolve => {
      releaseLookup = resolve
    })
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: () => lookup,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.emit('SIGINT')
    releaseLookup('sleep 30')
    const { code, stdout, stderr } = await waiting

    expect(code).toBe(130)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
  })

  it('lets SIGINT before pinning win over a selector result that completes afterward', async () => {
    let releaseResolver!: (session: BackgroundSession) => void
    const deferred = new Promise<BackgroundSession>(resolve => {
      releaseResolver = resolve
    })
    await createTestSession('bg-aaa1')
    const session = await createTestSession('bg-aaa2')
    const waiting = runWait(['bg-aaa2', '--json'], {
      resolveSession: () => deferred,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.emit('SIGINT')
    releaseResolver(session)
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBeNull()
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
  })

  it('lets SIGINT during the first metadata read win over the observation', async () => {
    let releaseReader!: (session: BackgroundSession) => void
    const deferred = new Promise<BackgroundSession>(resolve => {
      releaseReader = resolve
    })
    const session = await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      readPinnedSession: () => deferred,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.emit('SIGINT')
    releaseReader({ ...session, status: 'exited', exitCode: 0 })
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
  })

  it('does not write to the registry while waiting', async () => {
    await createTestSession('bg-aaa1')
    const before = await snapshotRegistry()
    await runWait(['bg-aaa1', '--timeout', '50ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    const after = await snapshotRegistry()

    expect([...after.entries()]).toEqual([...before.entries()])
  })

  it('does not inspect unrelated sessions on later polls', async () => {
    await createTestSession('bg-aaa1')
    await createTestSession('bg-bbb2')
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
    })
    await new Promise(resolve => setTimeout(resolve, 40))
    // Corrupt the unrelated session after pinning, then finish the target.
    await writeFile(metadataPath('bg-bbb2'), '{not json')
    await finishSession('bg-aaa1', { exitCode: 0 })
    const { code, stdout } = await waiting

    expect(code).toBe(0)
    expect(JSON.parse(stdout).id).toBe('bg-aaa1')
  })

  it('prints wait help to stdout and returns 0', async () => {
    const { code, stdout, stderr } = await runWait(['--help'])

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Usage: openclaude wait <id-or-name>')
    expect(stdout).toContain('--timeout')
    expect(stdout).toContain('--json')
  })

  it('returns unsupported when background sessions are disabled in the build', async () => {
    await createTestSession('bg-aaa1')
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'], {
      featureEnabled: false,
    })

    expect(code).toBe(2)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('selector_error')
    expect(result.error).toBe('unsupported')
    expect(result.id).toBeNull()

    const human = await runWait(['bg-aaa1'], { featureEnabled: false })
    expect(human.code).toBe(2)
    expect(human.stdout).toBe('')
    expect(human.stderr.trim().split('\n')).toHaveLength(1)
  })
})
