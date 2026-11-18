import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { getProcessCommandAsync } from '../utils/genericProcessUtils.js'
import {
  DEADLINE_EXPIRED,
  parseWaitInvocation,
  raceWithDeadline,
  waitHandler,
} from './bgWait.js'
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
    pid: number = FAKE_PID,
  ): void {
    writeFileSync(
      terminalFactPath(id, kind),
      JSON.stringify({ version: 1, id, pid, ...fact }),
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

  // A faithful stand-in for the real process-command lookup: it honors
  // the abort signal like getProcessCommandAsync does — a lookup cut
  // short by an abort returns null instead of a command the aborted `ps`
  // could never have produced (maintainer review 5948202472 on #2497).
  // Stubs that ignore the signal mask wiring regressions at the timeout
  // boundary, where the real lookup is aborted and must not read as a
  // live process.
  function liveLookup(command: string | null) {
    return async (
      _pid: number,
      options: { signal?: AbortSignal },
    ): Promise<string | null> =>
      options.signal?.aborted ? null : command
  }

  // Runs the delayed-flush scenario for one client signal: the write
  // callback fires 250 ms after the write starts, the signal lands once
  // the write has started, and the flush bound is the production poll
  // interval (500 ms), so the callback must have fired before the waiter
  // returns. A signal recorded during the pending timeout flush
  // reclassifies the outcome to interrupted (130/143): the timeout
  // line was already written, so the rendered output carries both the
  // superseded timeout line and the interrupting line, and the last
  // line is the waiter's outcome (maintainer review 5964758980 on
  // #2497). The signal is sent only after a barrier the write
  // resolves on entry — a fixed 100 ms timer does not establish that
  // _write has started, so under slow registry I/O the signal could
  // land before the timeout result was selected and the handler would
  // correctly return 130/143 instead of 124 (CodeRabbit #2497 review
  // 5957376769). The barrier races the handler's completion so a write
  // that never starts fails the test instead of hanging it, and the
  // held callback is released in a finally so no async work is left
  // pending.
  async function flushesResultOnDelayedWrite(
    signal: 'SIGINT' | 'SIGTERM',
  ): Promise<void> {
    await createTestSession('bg-aaa1')
    let writeStartedResolve!: () => void
    const writeStarted = new Promise<void>(resolve => {
      writeStartedResolve = resolve
    })
    let releaseWrite: (() => void) | undefined
    class DelayedOutput extends Writable {
      chunks: string[] = []
      callbackFired = false
      _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.chunks.push(String(chunk))
        writeStartedResolve()
        // Hold the callback until the test releases it after emitting
        // the signal: the signal must land while the write is pending.
        // Self-clearing so a second release is a no-op.
        releaseWrite = () => {
          releaseWrite = undefined
          setTimeout(() => {
            this.callbackFired = true
            callback(null)
          }, 250)
        }
      }
    }
    const stdout = new DelayedOutput()
    const startedAt = performance.now()
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    try {
      const started = await Promise.race([
        writeStarted.then(() => true),
        waiting.then(() => false),
      ])
      expect(started).toBe(true)
      process.emit(signal)
      releaseWrite?.()
      const { code } = await waiting
      const elapsedMs = performance.now() - startedAt
      expect(code).toBe(signal === 'SIGTERM' ? 143 : 130)
      expect(elapsedMs).toBeLessThan(2000)
      expect(stdout.callbackFired).toBe(true)
      // The timeout line was already written when the signal landed, so
      // the output carries both lines: the superseded timeout outcome
      // first, the interrupting outcome last.
      const lines = stdout.chunks.join('').trim().split('\n')
      expect(lines).toHaveLength(2)
      const superseded = expectWaitJsonShape(JSON.parse(lines[0]!))
      expect(superseded.waitResult).toBe('timeout')
      expect(superseded.error).toBe('timeout')
      const result = expectWaitJsonShape(JSON.parse(lines[1]!))
      expect(result.waitResult).toBe('interrupted')
      expect(result.error).toBe('interrupted')
      expect(result.waitSignal).toBe(signal)
    } finally {
      // Never leave the write callback held if an assertion above
      // fails: the waiter's flush bound returns it regardless, and
      // releasing an already-fired callback is a no-op. Join the
      // waiter as well, so it finishes before teardown and cannot
      // retain its process signal listeners into the next test; the
      // catch keeps a waiter failure from masking the original test
      // failure (CodeRabbit #2497 review 5961433156).
      releaseWrite?.()
      await waiting.catch(() => {})
    }
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
    // Bun ignores `process.exitCode = undefined`, so restoring the saved
    // value directly would leak a test's exit code (e.g. 2) into the test
    // runner's own exit code — all tests pass, but the shard exits 2 and
    // the CI `unit-tests` job fails. `undefined` and 0 both mean success,
    // so restore to 0 instead (same pattern as bgFinalizer.test.ts).
    process.exitCode = savedExitCode ?? 0
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

  it('reports the recorded exit code for an exited session instead of code 0', async () => {
    // An `exited` record may carry a nonzero exit code (isBackgroundSession
    // permits it); the human line must render the recorded code, not 0,
    // or the waiter claims success while exiting 1 (CodeRabbit #2497).
    const session = await createTestSession('bg-aaa1')
    await writeFile(
      metadataPath('bg-aaa1'),
      JSON.stringify({
        ...session,
        status: 'exited',
        exitCode: 7,
        finishedAt: new Date().toISOString(),
      }),
    )
    const { code, stdout, stderr } = await runWait(['bg-aaa1', '--json'])

    expect(code).toBe(1)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('exited')
    expect(result.exitCode).toBe(7)

    const human = await runWait(['bg-aaa1'])
    expect(human.code).toBe(1)
    expect(human.stdout).toBe('Background session bg-aaa1 exited with code 7.\n')
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
        getProcessCommandAsync: liveLookup('sleep 30'),
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

  it('returns 124 with running JSON when the deadline aborts the in-flight lookup', async () => {
    // Regression test for maintainer review 5948202472 (P1) on #2497:
    // the deadline fires while the process lookup is still in flight, so
    // the in-flight lookup is aborted and its null result must not read
    // as an unreadable process (exit 3). The waiter runs one final
    // observation with a fresh, non-aborted lookup signal, which sees
    // the live child and reports the timeout (124). The first lookup is
    // deliberately slow so the deadline branch is forced; the second
    // lookup is fast, so the final observation classifies from a real
    // observation instead of the grace timer.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (child.pid === undefined) throw new Error('spawned child has no pid')
    const childPid = child.pid
    try {
      await createTestSession('bg-aaa1', { pid: childPid })
      let lookups = 0
      let lookupEnteredResolve!: () => void
      const lookupEntered = new Promise<void>(resolve => {
        lookupEnteredResolve = resolve
      })
      const slowThenFastLookup = async (
        _pid: number,
        options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookups += 1
        if (lookups === 1) {
          lookupEnteredResolve()
          // A slow `ps`: waits until the lookup signal aborts it.
          await new Promise<void>(resolve => {
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          return null
        }
        return liveLookup('sleep 30')(_pid, options)
      }
      const startedAt = performance.now()
      const waiting = runWait(['bg-aaa1', '--timeout', '300ms', '--json'], {
        getProcessCommandAsync: slowThenFastLookup,
      })
      // Race the entry barrier against early handler completion: if
      // selector resolution is slow, the handler can return 124 before
      // the lookup starts, and awaiting the barrier alone would hang
      // the test past teardown instead of failing it (CodeRabbit #2497
      // review 5963778469).
      const entered = await Promise.race([
        lookupEntered.then(() => true),
        waiting.then(() => false),
      ])
      expect(entered).toBe(true)
      const { code, stdout, stderr } = await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  'waitHandler did not return within 5s of the deadline',
                ),
              ),
            5000,
          )
        }),
      ])
      const elapsedMs = performance.now() - startedAt
      expect(code).toBe(124)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.id).toBe('bg-aaa1')
      expect(result.status).toBe('running')
      expect(result.waitResult).toBe('timeout')
      expect(result.error).toBe('timeout')
      // The boundary was classified by the fresh final observation, not
      // by the aborted in-flight lookup or the grace timer.
      expect(lookups).toBe(2)
      expect(elapsedMs).toBeLessThan(1500)
    } finally {
      child.kill()
    }
  })

  it('returns stale when the child exits between the pre-deadline lookup and the timeout boundary', async () => {
    // Regression test for CodeRabbit #2497 review 5963778469: a running
    // result settled from a pre-deadline lookup can be stale — the child
    // may have exited in the meantime without publishing a terminal
    // fact — so the boundary re-observes with a fresh lookup instead of
    // reporting 124 from the late result. The first lookup returns
    // before the deadline, but the second metadata read lands after it,
    // so the observation settles during grace as running; the fresh
    // lookup finds the PID gone, so the session is stale (exit 1).
    const session = await createTestSession('bg-aaa1')
    let lookups = 0
    let reads = 0
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      pollIntervalMs: 500,
      getProcessCommandAsync: async () => {
        lookups += 1
        if (lookups === 1) return 'sleep 30'
        return 'sleep 999'
      },
      readPinnedSession: async () => {
        reads += 1
        if (reads === 2) {
          // The second metadata read lands after the deadline, so the
          // first observation settles during grace as running.
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        return session
      },
    })
    const { code, stdout } = await waiting

    expect(code).toBe(1)
    expect(lookups).toBe(2)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.status).toBe('stale')
    expect(result.waitResult).toBe('terminal')
  })

  it('does not return while the inspector child is still alive', async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // after the waiter is interrupted, it must await the inspector
    // child's close before returning — not exit while a slow or
    // signal-ignoring `ps` child remains alive. The stub stands in for
    // the real lookup: it spawns a real child that traps SIGTERM and
    // exits 300 ms later, so a waiter that returns without awaiting the
    // lookup would report 130 while the child is observably alive.
    const sessionChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (sessionChild.pid === undefined) {
      throw new Error('spawned session child has no pid')
    }
    const sessionPid = sessionChild.pid
    let inspector: ReturnType<typeof spawn> | undefined
    try {
      await createTestSession('bg-aaa1', { pid: sessionPid })
      let lookupEnteredResolve!: () => void
      const lookupEntered = new Promise<void>(resolve => {
        lookupEnteredResolve = resolve
      })
      const slowRealLookup = async (
        _pid: number,
        options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookupEnteredResolve()
        inspector = spawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setTimeout(() => {}, 60000)",
          ],
          { stdio: 'ignore', signal: options.signal },
        )
        await new Promise<void>(resolve => {
          // Resolve on child close only, like the real lookup
          // (execFileNoThrow resolves on close): resolving on the
          // abort 'error' event would return while the child is
          // still dying. The 'error' listener only swallows the
          // abort error — without it Node throws synchronously when
          // the abort fires.
          inspector?.once('error', () => {})
          inspector?.once('close', () => resolve())
        })
        return options.signal?.aborted ? null : 'sleep 30'
      }
      const waiting = runWait(['bg-aaa1', '--json'], {
        pollIntervalMs: 500,
        getProcessCommandAsync: slowRealLookup,
      })
      await lookupEntered
      process.emit('SIGINT')
      const { code, stdout } = await waiting
      expect(code).toBe(130)
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.waitResult).toBe('interrupted')
      // The inspector child has closed by the time the waiter returns.
      expect(inspector?.pid).toBeDefined()
      expect(() => process.kill(inspector!.pid!, 0)).toThrow()
    } finally {
      sessionChild.kill()
      try {
        inspector?.kill('SIGKILL')
      } catch {}
    }
  })

  it('does not return while a resolution-time inspector child is still alive', async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // the deadline can also fire during selector resolution, while the
    // exact-name liveness gate's process lookup is still in flight. The
    // waiter must await that inspector child's close before returning
    // the timeout — not exit at the deadline while the child is alive.
    // The stub stands in for the real lookup: only the first call (the
    // resolution-time liveness probe) spawns a real child, which exits
    // on its own after 150 ms; later calls answer at once. A waiter
    // that skips the resolution lookup — or returns at the 60 ms
    // deadline without awaiting it — would report 124 in ~60 ms while
    // the child is observably alive.
    const sessionChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (sessionChild.pid === undefined) {
      throw new Error('spawned session child has no pid')
    }
    const sessionPid = sessionChild.pid
    let inspector: ReturnType<typeof spawn> | undefined
    try {
      await createTestSession('bg-aaa1', {
        name: 'worker',
        pid: sessionPid,
      })
      let lookups = 0
      const slowRealLookup = async (
        _pid: number,
        _options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookups += 1
        // Only the resolution-time probe is slow: the poll loop must
        // never run here, so a fast later call would prove the waiter
        // resolved before the probe.
        if (lookups !== 1) return liveLookup('sleep 30')(_pid, _options)
        inspector = spawn(
          process.execPath,
          ['-e', 'setTimeout(() => process.exit(0), 150)'],
          { stdio: 'ignore' },
        )
        await new Promise<void>(resolve => {
          inspector?.once('error', () => {})
          inspector?.once('close', () => resolve())
        })
        return 'sleep 30'
      }
      const startedAt = performance.now()
      const { code, stdout, stderr } = await runWait(
        ['worker', '--timeout', '60ms', '--json'],
        {
          pollIntervalMs: 500,
          getProcessCommandAsync: slowRealLookup,
        },
      )
      const elapsedMs = performance.now() - startedAt
      expect(code).toBe(124)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.waitResult).toBe('timeout')
      expect(result.error).toBe('timeout')
      // The resolution lookup ran once, and the waiter returned only
      // after it settled (~150 ms), not at the 60 ms deadline.
      expect(lookups).toBe(1)
      expect(elapsedMs).toBeGreaterThanOrEqual(140)
      expect(inspector?.pid).toBeDefined()
      expect(() => process.kill(inspector!.pid!, 0)).toThrow()
    } finally {
      sessionChild.kill()
      try {
        inspector?.kill('SIGKILL')
      } catch {}
    }
  })

  it('waits for a back-pressured stdout drain before returning 124', async () => {
    // Regression test for maintainer review 5948202472 (P2) on #2497:
    // with --json the waiter must not return (and the CLI fast path
    // must not force-exit) while the JSON line is still queued in a
    // back-pressured stdout pipe, or the line is lost. The fake stdout
    // reports every write as back-pressured and drains 20 ms later.
    await createTestSession('bg-aaa1')
    class BackpressuredOutput {
      chunks: string[] = []
      drained = false
      private listeners = new Map<string, Array<() => void>>()
      write(chunk: string): boolean {
        this.chunks.push(chunk)
        setTimeout(() => {
          this.drained = true
          for (const listener of this.listeners.get('drain') ?? []) {
            listener()
          }
        }, 20)
        return false
      }
      once(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      }
      off(event: string, listener: () => void): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(l => l !== listener),
        )
      }
      text(): string {
        return this.chunks.join('')
      }
    }
    const stdout = new BackpressuredOutput()
    const startedAt = performance.now()
    const { code } = await runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(124)
    // The waiter returned only after the drain fired (~20 ms after the
    // write), not at the 60 ms deadline.
    expect(stdout.drained).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(70)
    const result = expectWaitJsonShape(JSON.parse(stdout.text()))
    expect(result.waitResult).toBe('timeout')
    expect(result.error).toBe('timeout')
  })

  it('waits for a back-pressured stdout drain before returning 2 on a parse error', async () => {
    // Regression test for maintainer review 5962625271 (P2) on #2497:
    // the pre-poll parse-error path returns before the poll loop's
    // finally, so with --json and a back-pressured stdout the mandatory
    // v1 JSON line could be lost. The fake stdout reports every write
    // as back-pressured and drains 50 ms later; the waiter must return
    // only after the drain, not at once.
    class BackpressuredOutput {
      chunks: string[] = []
      drained = false
      private listeners = new Map<string, Array<() => void>>()
      write(chunk: string): boolean {
        this.chunks.push(chunk)
        setTimeout(() => {
          this.drained = true
          for (const listener of this.listeners.get('drain') ?? []) {
            listener()
          }
        }, 50)
        return false
      }
      once(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      }
      off(event: string, listener: () => void): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(l => l !== listener),
        )
      }
      text(): string {
        return this.chunks.join('')
      }
    }
    const stdout = new BackpressuredOutput()
    const startedAt = performance.now()
    const { code } = await runWait(
      ['bg-aaa1', '--timeout', 'bogus', '--json'],
      { stdout },
    )
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(2)
    expect(stdout.drained).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(40)
    const result = expectWaitJsonShape(JSON.parse(stdout.text()))
    expect(result.waitResult).toBe('selector_error')
    expect(result.error).toBe('invalid_arguments')
  })

  it('waits for a back-pressured stdout drain before returning 2 when background sessions are unsupported', async () => {
    // Regression test for maintainer review 5962625271 (P2) on #2497:
    // same pre-poll gap as the parse-error path — the
    // featureEnabled === false path returns before the poll loop's
    // finally, so with --json and a back-pressured stdout the mandatory
    // v1 JSON line could be lost. The fake stdout reports every write
    // as back-pressured and drains 50 ms later.
    class BackpressuredOutput {
      chunks: string[] = []
      drained = false
      private listeners = new Map<string, Array<() => void>>()
      write(chunk: string): boolean {
        this.chunks.push(chunk)
        setTimeout(() => {
          this.drained = true
          for (const listener of this.listeners.get('drain') ?? []) {
            listener()
          }
        }, 50)
        return false
      }
      once(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      }
      off(event: string, listener: () => void): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(l => l !== listener),
        )
      }
      text(): string {
        return this.chunks.join('')
      }
    }
    const stdout = new BackpressuredOutput()
    const startedAt = performance.now()
    const { code } = await runWait(['bg-aaa1', '--json'], {
      featureEnabled: false,
      stdout,
    })
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(2)
    expect(stdout.drained).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(40)
    const result = expectWaitJsonShape(JSON.parse(stdout.text()))
    expect(result.waitResult).toBe('selector_error')
    expect(result.error).toBe('unsupported')
  })

  it('returns the terminal outcome when a terminal fact lands while the lookup is still pending past the grace', async () => {
    // Regression test for CodeRabbit #2497 review 5961433156 (Minor):
    // the deadline expired while the in-flight lookup was still
    // pending, and the grace expired before the observation settled, so
    // the waiter returned 124 without re-reading the pinned session —
    // even though a terminal fact was published while the lookup was
    // pending. The stub lookup never settles (it stands in for a
    // lookup whose inspector close is delayed past the grace); the fact
    // is published as soon as the lookup starts, and the waiter must
    // return the terminal outcome instead of 124.
    await createTestSession('bg-aaa1')
    let lookupStartedResolve!: () => void
    const lookupStarted = new Promise<void>(resolve => {
      lookupStartedResolve = resolve
    })
    const hangingLookup = async (
      _pid: number,
      _options: { signal?: AbortSignal },
    ): Promise<string | null> => {
      lookupStartedResolve()
      return new Promise<string | null>(() => {})
    }
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: hangingLookup,
      pollIntervalMs: 500,
    })
    // Race the entry barrier against early handler completion: if
    // selector resolution is slow, the handler can return before the
    // lookup starts, and awaiting the barrier alone would hang the test
    // past teardown instead of failing it (CodeRabbit #2497 review
    // 5963778469).
    const entered = await Promise.race([
      lookupStarted.then(() => true),
      waiting.then(() => false),
    ])
    expect(entered).toBe(true)
    await finishSession('bg-aaa1', { exitCode: 0 })
    const { code, stdout } = await waiting
    expect(code).toBe(0)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('terminal')
    expect(result.exitCode).toBe(0)
  })

  it('returns the terminal outcome when a terminal fact lands during the final timeout observation', async () => {
    // Regression test for CodeRabbit #2497 review 5961433156 (Minor):
    // same grace-expiry re-read, for the final timeout observation:
    // the first observation was aborted by the deadline, and the fresh
    // final lookup never settled within its grace, so the waiter
    // returned 124 without re-reading the pinned session. The stub
    // lookup returns null once its signal aborts (first call, so the
    // observation is 'aborted'), then signals the test and hangs
    // (second call, the final observation); the fact is published as
    // soon as the final lookup starts, and the waiter must return the
    // terminal outcome instead of 124.
    await createTestSession('bg-aaa1')
    let lookupCalls = 0
    let finalLookupStartedResolve!: () => void
    const finalLookupStarted = new Promise<void>(resolve => {
      finalLookupStartedResolve = resolve
    })
    const waitForAbort = (signal?: AbortSignal): Promise<void> =>
      new Promise<void>(resolve => {
        if (signal === undefined || signal.aborted) resolve()
        else {
          signal.addEventListener('abort', () => resolve(), { once: true })
        }
      })
    const stubLookup = async (
      _pid: number,
      options: { signal?: AbortSignal },
    ): Promise<string | null> => {
      lookupCalls++
      if (lookupCalls === 1) {
        await waitForAbort(options.signal)
        return null
      }
      finalLookupStartedResolve()
      await waitForAbort(options.signal)
      return null
    }
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: stubLookup,
      pollIntervalMs: 500,
    })
    // Race the entry barrier against early handler completion: if
    // selector resolution is slow, the handler can return before the
    // final lookup starts, and awaiting the barrier alone would hang
    // the test past teardown instead of failing it (CodeRabbit #2497
    // review 5963778469).
    const entered = await Promise.race([
      finalLookupStarted.then(() => true),
      waiting.then(() => false),
    ])
    expect(entered).toBe(true)
    await finishSession('bg-aaa1', { exitCode: 0 })
    const { code, stdout } = await waiting
    expect(code).toBe(0)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('terminal')
    expect(result.exitCode).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'returns the terminal outcome when a terminal fact lands while the inspector close is delayed past the grace',
    async () => {
      // Regression test for CodeRabbit #2497 review 5961433156 (Minor),
      // on the real production lookup: the deadline expires while the
      // in-flight lookup is still pending, and a terminal fact is
      // published before the observation settles — the waiter must
      // return the terminal outcome instead of 124. The shim traps
      // SIGTERM and closes 600 ms later, past the 500 ms grace; the
      // fact is published as soon as the shim reports the signal, so
      // it lands while the lookup is pending. (The stub tests above
      // cover the two grace-expiry re-read sites deterministically;
      // this one covers the real lookup path.) No `exited` marker is
      // expected: the SIGKILL escalation stops the shim before its
      // delayed exit fires.
      const { shimDir, markerDir } = await createPsShim(600)
      const savedPath = process.env.PATH
      const sessionChild = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60000)'],
        { stdio: 'ignore' },
      )
      if (sessionChild.pid === undefined) {
        throw new Error('spawned session child has no pid')
      }
      let waiting: ReturnType<typeof runWait> | undefined
      let waitingSettled = false
      try {
        process.env.PATH = `${shimDir}${savedPath ? `:${savedPath}` : ''}`
        await createTestSession('bg-aaa1', { pid: sessionChild.pid })
        waiting = runWait(['bg-aaa1', '--timeout', '500ms', '--json'], {
          isProcessAlive: () => true,
          getProcessCommandAsync,
          pollIntervalMs: 500,
        })
        // Track settlement: the finally below must only emit a signal
        // while the waiter is still listening — emitting SIGINT after
        // it returned (and removed its listeners) terminates the test
        // process via the signal-exit handler.
        void waiting.then(
          () => {
            waitingSettled = true
          },
          () => {
            waitingSettled = true
          },
        )
        const startedDeadline = Date.now() + 2000
        while (
          !existsSync(join(markerDir, 'started')) &&
          Date.now() < startedDeadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(existsSync(join(markerDir, 'started'))).toBe(true)
        // Wait for the shim to report the deadline's SIGTERM before
        // publishing: the fact must land while the lookup is pending.
        // Fail explicitly instead of hanging if it never does.
        const signalledDeadline = Date.now() + 5000
        while (
          !existsSync(join(markerDir, 'signalled')) &&
          Date.now() < signalledDeadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(existsSync(join(markerDir, 'signalled'))).toBe(true)
        await finishSession('bg-aaa1', { exitCode: 0 }, sessionChild.pid)
        const { code, stdout } = await waiting
        expect(code).toBe(0)
        const result = expectWaitJsonShape(JSON.parse(stdout))
        expect(result.waitResult).toBe('terminal')
        expect(result.exitCode).toBe(0)
      } finally {
        process.env.PATH = savedPath
        sessionChild.kill()
        // Never leave a shim behind if an assertion above fails: the
        // started marker carries its pid.
        try {
          const shimPid = Number.parseInt(
            await readFile(join(markerDir, 'started'), 'utf8'),
            10,
          )
          if (Number.isInteger(shimPid)) process.kill(shimPid, 'SIGKILL')
        } catch {}
        // Settle the waiter if the test failed before awaiting it, so
        // no signal listener or pending lookup leaks into later tests.
        // Only emit while the waiter is still pending (see above).
        if (waiting !== undefined && !waitingSettled) {
          process.emit('SIGINT')
          await Promise.race([
            waiting.then(
              () => undefined,
              () => undefined,
            ),
            new Promise(resolve => setTimeout(resolve, 2000)),
          ])
        }
        await rm(shimDir, { recursive: true, force: true })
        await rm(markerDir, { recursive: true, force: true })
      }
    },
  )

  it('waits for the write callback even when write() returns true', async () => {
    // Regression test for CodeRabbit #2497 review 5950772048: a real
    // stream's write() can return true while the chunk is still
    // pending — the return value describes buffer capacity, not
    // completion. The waiter must wait for the write callback, not the
    // boolean. The fake reports every write as flushed at once (true)
    // but invokes the callback 150 ms later.
    await createTestSession('bg-aaa1')
    class DelayedWriteOutput {
      chunks: string[] = []
      flushed = false
      private listeners = new Map<string, Array<() => void>>()
      write(chunk: string, callback?: () => void): boolean {
        this.chunks.push(chunk)
        setTimeout(() => {
          this.flushed = true
          callback?.()
        }, 150)
        return true
      }
      once(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      }
      off(event: string, listener: () => void): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(l => l !== listener),
        )
      }
      text(): string {
        return this.chunks.join('')
      }
    }
    const stdout = new DelayedWriteOutput()
    const startedAt = performance.now()
    const { code } = await runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(124)
    // The waiter returned only after the write callback fired (~150 ms
    // after the write at the 60 ms deadline), not on the `true` return.
    expect(stdout.flushed).toBe(true)
    expect(elapsedMs).toBeGreaterThanOrEqual(170)
    const result = expectWaitJsonShape(JSON.parse(stdout.text()))
    expect(result.waitResult).toBe('timeout')
    expect(result.error).toBe('timeout')
  })

  it('returns the complete JSON line when the timeout write drains after the old flush bound', async () => {
    // Regression test for CodeRabbit #2497 review 5957376769: a
    // timed-out wait must not return while its JSON write is still
    // queued (unless the write fails) — the one-object output contract
    // breaks if the CLI fast path exits with 124 before the line
    // reaches the consumer. The fake holds the write callback for
    // 1200 ms, past the old 500 ms flush bound, with no signal, then
    // releases it; the waiter must return only after the callback
    // fires, with the complete line and exit code 124.
    await createTestSession('bg-aaa1')
    class SlowDrainOutput extends Writable {
      chunks: string[] = []
      callbackFired = false
      _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.chunks.push(String(chunk))
        setTimeout(() => {
          this.callbackFired = true
          callback(null)
        }, 1200)
      }
    }
    const stdout = new SlowDrainOutput()
    const startedAt = performance.now()
    const { code } = await runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(124)
    expect(stdout.callbackFired).toBe(true)
    // The waiter returned only after the write callback fired (~1200 ms
    // after the write at the 60 ms deadline), not at the old 500 ms bound.
    expect(elapsedMs).toBeGreaterThanOrEqual(1200)
    expect(elapsedMs).toBeLessThan(10000)
    const result = expectWaitJsonShape(JSON.parse(stdout.chunks.join('')))
    expect(result.waitResult).toBe('timeout')
    expect(result.error).toBe('timeout')
  })

  it('returns 130 when SIGINT lands during a lookup stalled past grace expiry', async () => {
    // Regression test for CodeRabbit #2497 review 5950772048: a SIGINT
    // received while the in-flight lookup is still pending must win
    // over the grace-timeout return (124). The lookup ignores the abort
    // signal and never settles, so the grace timer expires with no
    // observation — the old code returned 124 from that branch.
    await createTestSession('bg-aaa1')
    const neverSettlingLookup = async (
      _pid: number,
      _options: { signal?: AbortSignal },
    ): Promise<string | null> => new Promise<string | null>(() => {})
    const startedAt = performance.now()
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      pollIntervalMs: 50,
      getProcessCommandAsync: neverSettlingLookup,
    })
    // The deadline fires at 60 ms and the grace interval runs to
    // ~110 ms; the signal lands mid-grace. It is sent at 70 ms, not
    // right at the deadline: it only has to be set before the grace
    // return, so earlier is strictly safer under load.
    await new Promise(resolve => setTimeout(resolve, 70))
    process.emit('SIGINT')
    const { code, stdout, stderr } = await waiting
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(130)
    expect(stderr).toBe('')
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
    expect(elapsedMs).toBeLessThan(2000)
  })

  it('returns 130 when SIGINT lands during a final lookup stalled past grace expiry', async () => {
    // Regression test for CodeRabbit #2497 review 5950772048: the
    // final-observation timeout branch has the same precedence bug —
    // a signal received while the fresh lookup never settles must
    // report the interruption (130), not the timeout (124). The first
    // lookup aborts on the deadline signal; the final lookup ignores
    // its signal and never settles.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (child.pid === undefined) throw new Error('spawned child has no pid')
    const childPid = child.pid
    try {
      await createTestSession('bg-aaa1', { pid: childPid })
      let lookups = 0
      let finalEnteredResolve!: () => void
      const finalEntered = new Promise<void>(resolve => {
        finalEnteredResolve = resolve
      })
      const stalledFinalLookup = async (
        _pid: number,
        options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookups += 1
        if (lookups === 1) {
          await new Promise<void>(resolve => {
            options.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            })
          })
          return null
        }
        finalEnteredResolve()
        return new Promise<string | null>(() => {})
      }
      const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
        pollIntervalMs: 50,
        getProcessCommandAsync: stalledFinalLookup,
      })
      // Race the entry barrier against early handler completion: if
      // selector resolution is slow, the handler can return 124 before
      // the final lookup starts, and awaiting the barrier alone would
      // hang the test past teardown instead of failing it (CodeRabbit
      // #2497 review 5952674466).
      const entered = await Promise.race([
        finalEntered.then(() => true),
        waiting.then(() => false),
      ])
      expect(entered).toBe(true)
      process.emit('SIGINT')
      const { code, stdout, stderr } = await waiting
      expect(code).toBe(130)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.waitResult).toBe('interrupted')
      expect(result.waitSignal).toBe('SIGINT')
      expect(lookups).toBe(2)
    } finally {
      child.kill()
    }
  })

  it('returns promptly on SIGINT while the result flush is stalled', async () => {
    // Regression test for CodeRabbit #2497 review 5950772048: when the
    // consumer never drains, the pending-flush wait must stay bounded —
    // otherwise the waiter ignores SIGINT/SIGTERM indefinitely. A client
    // signal recorded during the pending timeout flush reclassifies the
    // outcome to interrupted (130): the flush is still awaited for at
    // most one poll interval, and the signal listeners are removed
    // (maintainer review 5964758980 on #2497). The timeout line was
    // already written when the signal landed, so the output carries
    // both the superseded timeout line and the interrupting line.
    await createTestSession('bg-aaa1')
    class NeverDrainingOutput {
      chunks: string[] = []
      private listeners = new Map<string, Array<() => void>>()
      write(_chunk: string, _callback?: () => void): boolean {
        this.chunks.push(_chunk)
        return false
      }
      once(event: string, listener: () => void): void {
        const list = this.listeners.get(event) ?? []
        list.push(listener)
        this.listeners.set(event, list)
      }
      off(event: string, listener: () => void): void {
        this.listeners.set(
          event,
          (this.listeners.get(event) ?? []).filter(l => l !== listener),
        )
      }
      text(): string {
        return this.chunks.join('')
      }
    }
    const stdout = new NeverDrainingOutput()
    const sigintBefore = getEventListeners(process, 'SIGINT').length
    const sigtermBefore = getEventListeners(process, 'SIGTERM').length
    const startedAt = performance.now()
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    // The flush starts at the ~60 ms deadline and never settles on its
    // own; the signal lands well inside the stalled wait.
    await new Promise(resolve => setTimeout(resolve, 150))
    process.emit('SIGINT')
    const { code } = await waiting
    const elapsedMs = performance.now() - startedAt
    expect(code).toBe(130)
    expect(elapsedMs).toBeLessThan(2000)
    const lines = stdout.text().trim().split('\n')
    expect(lines).toHaveLength(2)
    const superseded = expectWaitJsonShape(JSON.parse(lines[0]!))
    expect(superseded.waitResult).toBe('timeout')
    expect(superseded.error).toBe('timeout')
    const result = expectWaitJsonShape(JSON.parse(lines[1]!))
    expect(result.waitResult).toBe('interrupted')
    expect(result.error).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
    // The handler removed its own signal listeners on the way out.
    expect(getEventListeners(process, 'SIGINT').length).toBe(sigintBefore)
    expect(getEventListeners(process, 'SIGTERM').length).toBe(sigtermBefore)
  })

  it('preserves the selected exit code when the result write fails asynchronously', async () => {
    // Regression test for CodeRabbit #2497 review 5952674466: on Node
    // a failed write invokes its callback before emitting 'error', so
    // completing the write from the callback removes the error listener
    // and the later 'error' event throws instead of preserving the
    // waiter's selected exit code. A real Writable that fails an
    // asynchronous write proves the waiter still returns 124.
    await createTestSession('bg-aaa1')
    class FailingOutput extends Writable {
      chunks: string[] = []
      _write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.chunks.push(String(chunk))
        setTimeout(() => callback(new Error('boom')), 0)
      }
    }
    const stdout = new FailingOutput()
    const { code } = await runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      stdout,
    })
    expect(code).toBe(124)
    const result = expectWaitJsonShape(JSON.parse(stdout.chunks.join('')))
    expect(result.waitResult).toBe('timeout')
    expect(result.error).toBe('timeout')
  })

  it('flushes the rendered result when SIGINT lands during a delayed write', async () => {
    await flushesResultOnDelayedWrite('SIGINT')
  })

  it('flushes the rendered result when SIGTERM lands during a delayed write', async () => {
    await flushesResultOnDelayedWrite('SIGTERM')
  })

  it('does not return while a resolution-time inspector outlasts the cleanup grace', async () => {
    // Regression test for CodeRabbit #2497 review 5950772048: when the
    // deadline fires during selector resolution, the resolution lookup
    // must be aborted instead of running on past the cleanup grace.
    // The stub stands in for the real lookup: the first
    // (resolution-time) probe observes the abort signal and then waits
    // on a test-controlled close barrier, standing in for an inspector
    // child that stays alive after the abort. The waiter must not
    // return while the barrier is held — a waiter that never signals
    // the probe, or returns at the deadline without awaiting it, is
    // already settled by then. No wall-clock minimum is asserted: the
    // old 700 ms bound assumed a POSIX SIGTERM trap, which Windows
    // forceful termination does not honour (CodeRabbit #2497 review
    // 5952674466). Two same-name candidates also prove no further
    // probe starts once the waiter is cancelled.
    const sessionChild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (sessionChild.pid === undefined) {
      throw new Error('spawned session child has no pid')
    }
    const sessionPid = sessionChild.pid
    let lookupStartedResolve!: () => void
    const lookupStarted = new Promise<void>(resolve => {
      lookupStartedResolve = resolve
    })
    let releaseCloseResolve!: () => void
    const releaseClose = new Promise<void>(resolve => {
      releaseCloseResolve = resolve
    })
    let abortSeen = false
    try {
      await createTestSession('bg-aaa1', {
        name: 'worker',
        pid: sessionPid,
      })
      await createTestSession('bg-bbb2', {
        name: 'worker2',
        pid: sessionPid,
      })
      // Two live candidates must share the name for the scan to probe
      // a second one; creation enforces name uniqueness, so rename the
      // second fixture's metadata file directly (test-only fixture edit,
      // as with the terminal-fact fixtures above).
      const secondPath = metadataPath('bg-bbb2')
      const secondRaw = JSON.parse(await readFile(secondPath, 'utf8')) as Record<
        string,
        unknown
      >
      secondRaw.name = 'worker'
      await writeFile(secondPath, JSON.stringify(secondRaw))
      let lookups = 0
      const slowLookup = async (
        _pid: number,
        options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookups += 1
        if (lookups !== 1) return liveLookup('sleep 30')(_pid, options)
        lookupStartedResolve()
        if (options.signal?.aborted) abortSeen = true
        options.signal?.addEventListener(
          'abort',
          () => {
            abortSeen = true
          },
          { once: true },
        )
        // Stay "alive" until the test releases the close barrier.
        await releaseClose
        return 'sleep 30'
      }
      const waiting = runWait(['worker', '--timeout', '500ms', '--json'], {
        pollIntervalMs: 500,
        getProcessCommandAsync: slowLookup,
      })
      // Race the entry barrier against early handler completion: if
      // selector resolution is slow, the handler can return 124 before
      // the first lookup starts, and awaiting the barrier alone would
      // hang the test past teardown instead of failing it — the
      // finally below would never run to stop the fixture child
      // (CodeRabbit #2497 review 5957376769). The pattern matches the
      // final-lookup test above.
      const entered = await Promise.race([
        lookupStarted.then(() => true),
        waiting.then(() => false),
      ])
      expect(entered).toBe(true)
      // The 500 ms deadline must fire and abort the lookup before the
      // waiter can return: wait until the abort is observed, then
      // prove the waiter is still pending while the close barrier is
      // held.
      const abortDeadline = Date.now() + 5000
      while (!abortSeen && Date.now() < abortDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(abortSeen).toBe(true)
      const settledBeforeRelease = await Promise.race([
        waiting.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 150)),
      ])
      expect(settledBeforeRelease).toBe(false)
      releaseCloseResolve()
      const { code, stdout, stderr } = await waiting
      expect(code).toBe(124)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.waitResult).toBe('timeout')
      expect(result.error).toBe('timeout')
      // Only the first candidate was probed: the scan stopped once the
      // deadline cancelled the waiter.
      expect(lookups).toBe(1)
    } finally {
      sessionChild.kill()
      // Never leave the waiter hanging on the barrier if an assertion
      // above fails: releasing an already-settled barrier is a no-op.
      releaseCloseResolve()
    }
  })

  // A stand-in for the `ps` the production lookup spawns: it prints a
  // command line for the inspected pid, records its own pid, then stays
  // alive until SIGTERM. `closeDelayMs` chooses the close behavior: a
  // number delays the exit that long after the signal, null ignores the
  // signal entirely (the inspector never closes). Unix-only: the
  // production lookup uses PowerShell, not `ps`, on Windows
  // (CodeRabbit #2497 review 5957376769).
  async function createPsShim(closeDelayMs: number | null): Promise<{
    shimDir: string
    markerDir: string
  }> {
    const shimDir = await mkdtemp(join(tmpdir(), 'openclaude-ps-shim-'))
    const markerDir = await mkdtemp(join(tmpdir(), 'openclaude-ps-markers-'))
    const shim = join(shimDir, 'ps')
    const startedMarker = join(markerDir, 'started')
    const signalledMarker = join(markerDir, 'signalled')
    const exitedMarker = join(markerDir, 'exited')
    const onTerm =
      closeDelayMs === null
        ? ''
        : `setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitedMarker)}, 'done'); process.exit(0) }, ${closeDelayMs});`
    await writeFile(
      shim,
      [
        '#!/usr/bin/env node',
        `const fs = require('node:fs')`,
        `process.stdout.write('sleep 30\\n')`,
        // Install the SIGTERM handler before publishing readiness:
        // a test that signals the shim as soon as it sees `started`
        // must not land before cancellation handling is ready, or the
        // shim can die before writing `exited` even when the waiter
        // handles child closure correctly (CodeRabbit #2497 review
        // 5961433156). The handler records the signal at once, so a
        // test can publish a terminal fact while the close is still
        // delayed.
        `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(signalledMarker)}, 'signalled'); ${onTerm} })`,
        `fs.writeFileSync(${JSON.stringify(startedMarker)}, String(process.pid))`,
        'setTimeout(() => {}, 60000)',
        '',
      ].join('\n'),
    )
    await chmod(shim, 0o755)
    return { shimDir, markerDir }
  }

  it.skipIf(process.platform === 'win32')(
    'does not return while the production lookup inspector outlasts the abort',
    async () => {
      // Regression test for CodeRabbit #2497 review 5957376769: the
      // stub lookup settles only when its close barrier releases, but
      // the production lookup settled on the abort-triggered `error`
      // event, which can precede the inspector child's `close` — the
      // waiter then returned while the inspector was still alive. The
      // `ps` shim below traps SIGTERM and closes 200 ms later; the
      // waiter must return only after that close, with the
      // interruption (130) and the shim's exit marker present. The
      // poll interval is the production 500 ms so the cleanup bound
      // covers the 200 ms close delay.
      const { shimDir, markerDir } = await createPsShim(200)
      const savedPath = process.env.PATH
      const sessionChild = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60000)'],
        { stdio: 'ignore' },
      )
      if (sessionChild.pid === undefined) {
        throw new Error('spawned session child has no pid')
      }
      let waiting: ReturnType<typeof runWait> | undefined
      let waitingSettled = false
      try {
        process.env.PATH = `${shimDir}${savedPath ? `:${savedPath}` : ''}`
        await createTestSession('bg-aaa1', { pid: sessionChild.pid })
        waiting = runWait(['bg-aaa1', '--json'], {
          isProcessAlive: () => true,
          getProcessCommandAsync,
          pollIntervalMs: 500,
        })
        // Track settlement: the finally below must only emit a signal
        // while the waiter is still listening — emitting SIGINT after
        // it returned (and removed its listeners) terminates the test
        // process via the signal-exit handler.
        void waiting.then(
          () => {
            waitingSettled = true
          },
          () => {
            waitingSettled = true
          },
        )
        // Wait for the shim to start (the lookup is in flight) before
        // interrupting; fail explicitly instead of hanging if it never
        // does.
        const startedDeadline = Date.now() + 2000
        while (
          !existsSync(join(markerDir, 'started')) &&
          Date.now() < startedDeadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(existsSync(join(markerDir, 'started'))).toBe(true)
        process.emit('SIGINT')
        const { code, stdout } = await waiting
        expect(code).toBe(130)
        const result = expectWaitJsonShape(JSON.parse(stdout))
        expect(result.waitResult).toBe('interrupted')
        expect(result.waitSignal).toBe('SIGINT')
        // The inspector closed before the waiter returned.
        expect(existsSync(join(markerDir, 'exited'))).toBe(true)
      } finally {
        process.env.PATH = savedPath
        sessionChild.kill()
        // Never leave a shim behind if an assertion above fails: the
        // started marker carries its pid.
        try {
          const shimPid = Number.parseInt(
            await readFile(join(markerDir, 'started'), 'utf8'),
            10,
          )
          if (Number.isInteger(shimPid)) process.kill(shimPid, 'SIGKILL')
        } catch {}
        // Settle the waiter if the test failed before awaiting it, so
        // no signal listener or pending lookup leaks into later tests.
        // Only emit while the waiter is still pending (see above).
        if (waiting !== undefined && !waitingSettled) {
          process.emit('SIGINT')
          await Promise.race([
            waiting.then(
              () => undefined,
              () => undefined,
            ),
            new Promise(resolve => setTimeout(resolve, 2000)),
          ])
        }
        await rm(shimDir, { recursive: true, force: true })
        await rm(markerDir, { recursive: true, force: true })
      }
    },
  )

  it.skipIf(process.platform === 'win32')(
    'still returns promptly when the production lookup inspector never closes',
    async () => {
      // Companion to the test above: the close wait must stay bounded
      // by the existing cleanup bound (one poll interval) — a shim
      // that ignores SIGTERM must not stall the waiter past it
      // (CodeRabbit #2497 review 5957376769).
      const { shimDir, markerDir } = await createPsShim(null)
      const savedPath = process.env.PATH
      const sessionChild = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60000)'],
        { stdio: 'ignore' },
      )
      if (sessionChild.pid === undefined) {
        throw new Error('spawned session child has no pid')
      }
      let waiting: ReturnType<typeof runWait> | undefined
      let waitingSettled = false
      try {
        process.env.PATH = `${shimDir}${savedPath ? `:${savedPath}` : ''}`
        await createTestSession('bg-aaa1', { pid: sessionChild.pid })
        waiting = runWait(['bg-aaa1', '--json'], {
          isProcessAlive: () => true,
          getProcessCommandAsync,
          pollIntervalMs: 500,
        })
        // Track settlement: the finally below must only emit a signal
        // while the waiter is still listening — emitting SIGINT after
        // it returned (and removed its listeners) terminates the test
        // process via the signal-exit handler.
        void waiting.then(
          () => {
            waitingSettled = true
          },
          () => {
            waitingSettled = true
          },
        )
        const startedDeadline = Date.now() + 2000
        while (
          !existsSync(join(markerDir, 'started')) &&
          Date.now() < startedDeadline
        ) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        expect(existsSync(join(markerDir, 'started'))).toBe(true)
        const startedAt = performance.now()
        process.emit('SIGINT')
        const { code, stdout } = await waiting
        const elapsedMs = performance.now() - startedAt
        expect(code).toBe(130)
        expect(elapsedMs).toBeLessThan(2000)
        const result = expectWaitJsonShape(JSON.parse(stdout))
        expect(result.waitResult).toBe('interrupted')
        expect(result.waitSignal).toBe('SIGINT')
        // The waiter must not return while the inspector is still
        // alive: an inspector that ignores SIGTERM must have been
        // force-stopped before the waiter returned (CodeRabbit #2497
        // review 5961433156, execFileNoThrow escalation).
        const shimPid = Number.parseInt(
          await readFile(join(markerDir, 'started'), 'utf8'),
          10,
        )
        expect(Number.isInteger(shimPid)).toBe(true)
        expect(() => process.kill(shimPid, 0)).toThrow()
      } finally {
        process.env.PATH = savedPath
        sessionChild.kill()
        try {
          const shimPid = Number.parseInt(
            await readFile(join(markerDir, 'started'), 'utf8'),
            10,
          )
          if (Number.isInteger(shimPid)) process.kill(shimPid, 'SIGKILL')
        } catch {}
        if (waiting !== undefined && !waitingSettled) {
          process.emit('SIGINT')
          await Promise.race([
            waiting.then(
              () => undefined,
              () => undefined,
            ),
            new Promise(resolve => setTimeout(resolve, 2000)),
          ])
        }
        await rm(shimDir, { recursive: true, force: true })
        await rm(markerDir, { recursive: true, force: true })
      }
    },
  )

  it('releases deadline reactions when each poll settles', async () => {
    // Regression test for maintainer review 5948202472 (P3) on #2497:
    // racing one long-lived deadline promise per poll retains a
    // reaction per poll for the whole wait. The signal-based race
    // attaches one listener per await and removes it on settle.
    const controller = new AbortController()
    for (let i = 0; i < 50; i++) {
      const result = await raceWithDeadline(
        Promise.resolve(i),
        controller.signal,
      )
      expect(result).toBe(i)
    }
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    expect(await raceWithDeadline(Promise.resolve(1), null)).toBe(1)
    const pending = raceWithDeadline(
      new Promise<number>(() => {}),
      controller.signal,
    )
    controller.abort()
    await expect(pending).resolves.toBe(DEADLINE_EXPIRED)
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  })

  it('returns 130 when SIGINT lands during the final timeout observation', async () => {
    // Regression test for maintainer review 5948202472 (P3) on #2497:
    // the grace timer must be cleared on exceptional completion as well
    // as success — a signal landing during the final observation still
    // reports the interruption promptly instead of waiting out the
    // grace interval.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    })
    if (child.pid === undefined) throw new Error('spawned child has no pid')
    const childPid = child.pid
    try {
      await createTestSession('bg-aaa1', { pid: childPid })
      let lookups = 0
      let finalEnteredResolve!: () => void
      const finalEntered = new Promise<void>(resolve => {
        finalEnteredResolve = resolve
      })
      const slowLookup = async (
        _pid: number,
        options: { signal?: AbortSignal },
      ): Promise<string | null> => {
        lookups += 1
        if (lookups === 2) finalEnteredResolve()
        await new Promise<void>(resolve => {
          options.signal?.addEventListener('abort', () => resolve(), {
            once: true,
          })
        })
        return null
      }
      const startedAt = performance.now()
      const waiting = runWait(['bg-aaa1', '--timeout', '100ms', '--json'], {
        pollIntervalMs: 500,
        getProcessCommandAsync: slowLookup,
      })
      // Race the entry barrier against early handler completion: if
      // selector resolution is slow, the handler can return before the
      // final lookup starts, and awaiting the barrier alone would hang
      // the test past teardown instead of failing it (CodeRabbit #2497
      // review 5963778469).
      const entered = await Promise.race([
        finalEntered.then(() => true),
        waiting.then(() => false),
      ])
      expect(entered).toBe(true)
      process.emit('SIGINT')
      const { code, stdout, stderr } = await waiting
      const elapsedMs = performance.now() - startedAt
      expect(code).toBe(130)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.waitResult).toBe('interrupted')
      expect(result.waitSignal).toBe('SIGINT')
      expect(lookups).toBe(2)
      expect(elapsedMs).toBeLessThan(1000)
    } finally {
      child.kill()
    }
  })

  it('aborts the in-flight lookup at the deadline and lets the published fact win', async () => {
    // Regression test for maintainer review 5942761094 (P2) on #2497:
    // when the deadline fires during an in-flight process lookup, the
    // waiter must abort the lookup (killing its `ps` child) and classify
    // the boundary from the observation that then settles — not discard
    // it and return 124. A real child process is the session's process;
    // a deliberately slow injected lookup stands in for `ps`; a
    // concurrent finalizer publishes the terminal fact mid-lookup.
    // Without the abort the lookup sleeps past the deadline and the
    // grace timer expires first, so the waiter returns 124.
    //
    // Publication is gated on a lookup-entry barrier, not a fixed delay:
    // the handler reads the terminal fact before the lookup, so a
    // timer-fired publish could land before the lookup starts and the
    // handler would return the terminal outcome without ever entering
    // it, failing the cancellation assertions below (CodeRabbit #2497
    // review 5945720742). The child stays alive until cleanup, so its
    // exit cannot prevent lookup entry either. The deadline ordering is
    // therefore causal — lookup entry, then publication, then the
    // 300 ms deadline aborts the lookup — instead of relying on the
    // relative sizes of fixed delays.
    //
    // The child and the watchdog timer are acquired inside the try and
    // torn down in the finally, so a setup failure cannot leak either
    // (maintainer review 5948202472 on #2497).
    let child: ReturnType<typeof spawn> | undefined
    let watchdog: ReturnType<typeof setTimeout> | undefined
    try {
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        stdio: 'ignore',
      })
      if (child.pid === undefined) throw new Error('spawned child has no pid')
      const childPid = child.pid
      await createTestSession('bg-aaa1', { pid: childPid })
    let lookupEnteredResolve!: () => void
    const lookupEntered = new Promise<void>(resolve => {
      lookupEnteredResolve = resolve
    })
    let lookupSignal: AbortSignal | undefined
    let lookupSettled = false
    let publishError: unknown
    const slowLookup = async (
      _pid: number,
      options: { signal?: AbortSignal },
    ): Promise<string | null> => {
      lookupEnteredResolve()
      lookupSignal = options.signal
      try {
        // A slow `ps`: sleeps 2 s unless the lookup signal aborts it.
        await new Promise<null>(resolve => {
          const timer = setTimeout(() => resolve(null), 2000)
          options.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve(null)
            },
            { once: true },
          )
        })
        return null
      } finally {
        lookupSettled = true
      }
    }
    const startedAt = performance.now()
    const waiting = runWait(['bg-aaa1', '--timeout', '300ms', '--json'], {
      getProcessCommandAsync: slowLookup,
    })
    // The concurrent finalizer publishes the terminal fact mid-lookup,
    // after lookup entry: the post-abort re-read must see it.
    const published = lookupEntered.then(() => {
      writeTerminalFactSync(
        'bg-aaa1',
        'natural',
        {
          status: 'exited',
          finishedAt: new Date().toISOString(),
          terminalReason: 'exit_code',
          exitCode: 0,
        },
        childPid,
      )
    })
    published.catch(error => {
      publishError = error
    })
    try {
      const { code, stdout, stderr } = await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(
                new Error(
                  'waitHandler did not return within 5s of the deadline',
                ),
              ),
            5000,
          )
        }),
      ])
      const elapsedMs = performance.now() - startedAt
      // The terminal fact published mid-lookup wins: exit 0, not 124.
      expect(publishError).toBeUndefined()
      expect(code).toBe(0)
      expect(stderr).toBe('')
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.status).toBe('exited')
      // The lookup was aborted at the deadline and settled promptly:
      // the waiter returned well before the 2 s lookup would have.
      expect(lookupSignal?.aborted).toBe(true)
      expect(lookupSettled).toBe(true)
      expect(elapsedMs).toBeLessThan(1500)
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
    }
    } finally {
      child?.kill()
    }
  })

  it('returns 124 promptly when a pinned registry read stalls past the deadline', async () => {
    // Regression test for CodeRabbit #2497: --timeout must bound a
    // pending registry read, not just the polling loop. The deadline
    // check runs only after observePinnedSession settles, so a stalled
    // readFile on the pinned metadata (e.g. a FIFO) blocks the timeout
    // and the waiter never returns 124. The never-settling read below
    // stands in for that stalled read.
    await createTestSession('bg-aaa1')
    const stalledRead = new Promise<BackgroundSession>(() => {})
    const waiting = runWait(['bg-aaa1', '--timeout', '100ms', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: liveLookup('sleep 30'),
      readPinnedSession: () => stalledRead,
    })
    // The watchdog timer is stored and cleared in the finally, so it
    // cannot leak past the test (maintainer review 5948202472 on #2497).
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let waited: { code: number; stdout: string; stderr: string }
    try {
      waited = await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(
                new Error(
                  'waitHandler did not return within 5s of a stalled registry read',
                ),
              ),
            5000,
          )
        }),
      ])
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog)
    }
    const { code, stdout, stderr } = waited

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
        // Deliberately mismatching the stored ['sleep', '30'] command,
        // as the killed-fact test does: the waiter must let the natural
        // fact published during the lookup win over the stale
        // classification, so this test only passes if the re-read
        // before stale classification runs (CodeRabbit #2497 review
        // 5963778469). A matching command would keep the waiter running
        // and let the next poll read the fact, passing either way.
        return 'sleep 999'
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

  it('returns metadata_replaced when the pinned session is replaced during the timeout grace re-read', async () => {
    // Regression test for maintainer review 5964758980 (P2) on #2497:
    // a pinned metadata failure during the timeout grace re-read must
    // report exit 4, like the main poll loop does — not collapse into
    // a timeout (124). The in-flight lookup never settles, so the grace
    // expires with no observation and the waiter runs one final
    // observation, whose pinned re-read reports the replacement.
    const session = await createTestSession('bg-aaa1')
    let reads = 0
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      pollIntervalMs: 500,
      getProcessCommandAsync: () => new Promise<string | null>(() => {}),
      readPinnedSession: () => {
        reads += 1
        if (reads === 1) return Promise.resolve(session)
        return Promise.reject(
          new BackgroundSessionWaitError(
            'metadata_replaced',
            'Background session bg-aaa1 metadata was replaced',
            'bg-aaa1',
          ),
        )
      },
    })
    const { code, stdout } = await waiting

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('metadata_replaced')
    expect(result.id).toBe('bg-aaa1')
  })

  it('returns metadata_missing when pinned metadata disappears during the timeout grace re-read', async () => {
    // Regression test for maintainer review 5964758980 (P2) on #2497:
    // same grace-boundary classification as the replaced case above,
    // for a second metadata code: a missing metadata file during the
    // grace re-read reports exit 4, not a timeout (124).
    const session = await createTestSession('bg-aaa1')
    let reads = 0
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      pollIntervalMs: 500,
      getProcessCommandAsync: () => new Promise<string | null>(() => {}),
      readPinnedSession: () => {
        reads += 1
        if (reads === 1) return Promise.resolve(session)
        return Promise.reject(
          new BackgroundSessionWaitError(
            'metadata_missing',
            'Background session bg-aaa1 metadata is missing',
            'bg-aaa1',
          ),
        )
      },
    })
    const { code, stdout } = await waiting

    expect(code).toBe(4)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('metadata_missing')
    expect(result.id).toBe('bg-aaa1')
  })

  it('returns 3 when the process stays unreadable past the timeout grace', async () => {
    // Regression test for maintainer review 5964758980 (P2) on #2497:
    // when the in-flight observation never settles past grace, the
    // waiter runs one final complete observation instead of reporting
    // a timeout from a metadata-only re-read — an unreadable process
    // state at the boundary reports exit 3 per the deadline table.
    await createTestSession('bg-aaa1')
    let lookups = 0
    const waiting = runWait(['bg-aaa1', '--timeout', '60ms', '--json'], {
      isProcessAlive: () => true,
      pollIntervalMs: 500,
      getProcessCommandAsync: async () => {
        lookups += 1
        if (lookups === 1) return new Promise<string | null>(() => {})
        return null
      },
    })
    const { code, stdout } = await waiting

    expect(code).toBe(3)
    expect(lookups).toBe(2)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.waitResult).toBe('observation_error')
    expect(result.error).toBe('process_unreadable')
    expect(result.status).toBe('unknown')
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
    // Wait for the first read to start so the signal cannot land before
    // pinning on a slow filesystem (CodeRabbit #2497).
    let firstReadStartedResolve!: () => void
    const firstReadStarted = new Promise<void>(resolve => {
      firstReadStartedResolve = resolve
    })
    const waiting = runWait(['bg-aaa1', '--json'], {
      readPinnedSession: () => {
        firstReadStartedResolve()
        return deferred
      },
    })
    await firstReadStarted
    process.emit('SIGINT')
    releaseReader({ ...session, status: 'exited', exitCode: 0 })
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
  })

  it('returns 130 when SIGINT arrives while selector resolution is still pending', async () => {
    // Selector resolution must race the client signal: a SIGINT while it
    // is still pending must interrupt the wait instead of hanging until
    // the read settles (CodeRabbit #2497).
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      resolveSession: () => new Promise<BackgroundSession>(() => {}),
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.emit('SIGINT')
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBeNull()
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
  })

  it('returns 143 when SIGTERM arrives while selector resolution is still pending', async () => {
    await createTestSession('bg-aaa1')
    const waiting = runWait(['bg-aaa1', '--json'], {
      resolveSession: () => new Promise<BackgroundSession>(() => {}),
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    process.emit('SIGTERM')
    const { code, stdout } = await waiting

    expect(code).toBe(143)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBeNull()
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGTERM')
  })

  it('returns 130 when SIGINT arrives while the first metadata read is still pending', async () => {
    // The first pinned read must race the client signal the same way:
    // a SIGINT while it is still pending must interrupt the wait instead
    // of hanging until the read settles (CodeRabbit #2497). Wait for the
    // read to start so the signal cannot land before pinning on a slow
    // filesystem.
    await createTestSession('bg-aaa1')
    let firstReadStartedResolve!: () => void
    const firstReadStarted = new Promise<void>(resolve => {
      firstReadStartedResolve = resolve
    })
    const waiting = runWait(['bg-aaa1', '--json'], {
      readPinnedSession: () => {
        firstReadStartedResolve()
        return new Promise<BackgroundSession>(() => {})
      },
    })
    await firstReadStarted
    process.emit('SIGINT')
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
  })

  it('returns 143 when SIGTERM arrives while the first metadata read is still pending', async () => {
    await createTestSession('bg-aaa1')
    // Wait for the read to start so the signal cannot land before
    // pinning on a slow filesystem (CodeRabbit #2497).
    let firstReadStartedResolve!: () => void
    const firstReadStarted = new Promise<void>(resolve => {
      firstReadStartedResolve = resolve
    })
    const waiting = runWait(['bg-aaa1', '--json'], {
      readPinnedSession: () => {
        firstReadStartedResolve()
        return new Promise<BackgroundSession>(() => {})
      },
    })
    await firstReadStarted
    process.emit('SIGTERM')
    const { code, stdout } = await waiting

    expect(code).toBe(143)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGTERM')
  })

  it('returns 130 when SIGINT arrives while the second metadata read is still pending', async () => {
    // After the identity check the waiter re-reads the pinned session;
    // that read must race the client signal too (CodeRabbit #2497).
    const session = await createTestSession('bg-aaa1')
    let secondReadStartedResolve!: () => void
    const secondReadStarted = new Promise<void>(resolve => {
      secondReadStartedResolve = resolve
    })
    let reads = 0
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
      readPinnedSession: () => {
        reads += 1
        if (reads === 1) return Promise.resolve(session)
        secondReadStartedResolve()
        return new Promise<BackgroundSession>(() => {})
      },
    })
    await secondReadStarted
    process.emit('SIGINT')
    const { code, stdout } = await waiting

    expect(code).toBe(130)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGINT')
  })

  it('returns 143 when SIGTERM arrives while the second metadata read is still pending', async () => {
    const session = await createTestSession('bg-aaa1')
    let secondReadStartedResolve!: () => void
    const secondReadStarted = new Promise<void>(resolve => {
      secondReadStartedResolve = resolve
    })
    let reads = 0
    const waiting = runWait(['bg-aaa1', '--json'], {
      isProcessAlive: () => true,
      getProcessCommandAsync: async () => 'sleep 30',
      readPinnedSession: () => {
        reads += 1
        if (reads === 1) return Promise.resolve(session)
        secondReadStartedResolve()
        return new Promise<BackgroundSession>(() => {})
      },
    })
    await secondReadStarted
    process.emit('SIGTERM')
    const { code, stdout } = await waiting

    expect(code).toBe(143)
    const result = expectWaitJsonShape(JSON.parse(stdout))
    expect(result.id).toBe('bg-aaa1')
    expect(result.waitResult).toBe('interrupted')
    expect(result.waitSignal).toBe('SIGTERM')
  })

  it('does not leak an unhandled rejection when SIGINT arrives during the process lookup and the second metadata read rejects', async () => {
    // A SIGINT during the process lookup aborts the client signal before
    // the second metadata read starts; that read's rejection must still
    // be handled even though the waiter reports the interruption instead
    // of the read result (CodeRabbit #2497).
    const session = await createTestSession('bg-aaa1')
    const unhandled: unknown[] = []
    const onUnhandledRejection = (error: unknown) => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      let releaseLookup!: (command: string) => void
      const lookup = new Promise<string>(resolve => {
        releaseLookup = resolve
      })
      let lookupStartedResolve!: () => void
      const lookupStarted = new Promise<void>(resolve => {
        lookupStartedResolve = resolve
      })
      let reads = 0
      const waiting = runWait(['bg-aaa1', '--json'], {
        isProcessAlive: () => true,
        getProcessCommandAsync: () => {
          lookupStartedResolve()
          return lookup
        },
        readPinnedSession: () => {
          reads += 1
          if (reads === 1) return Promise.resolve(session)
          return Promise.reject(
            new BackgroundSessionWaitError('metadata_missing', 'metadata missing', 'bg-aaa1'),
          )
        },
      })
      await lookupStarted
      process.emit('SIGINT')
      releaseLookup('sleep 30')
      const { code, stdout } = await waiting

      expect(code).toBe(130)
      const result = expectWaitJsonShape(JSON.parse(stdout))
      expect(result.id).toBe('bg-aaa1')
      expect(result.waitResult).toBe('interrupted')
      expect(result.waitSignal).toBe('SIGINT')
      // Let a rejected second read surface before asserting no leak.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
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
