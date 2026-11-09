import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { captureSync } from './subprocess.ts'
import {
  _setBackgroundSessionsRootForTesting,
  createBackgroundSession,
  recordBackgroundSessionNaturalTermination,
} from '../src/cli/bgRegistry.js'

const BIN_PATH = join(import.meta.dir, '..', 'bin', 'openclaude')
const DIST_PATH = join(import.meta.dir, '..', 'dist', 'cli.mjs')

function binEnv(configDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env, OPENCLAUDE_CONFIG_DIR: configDir }
  delete env.OPENCLAUDE_HEAP_RELAUNCHED
  delete env.OPENCLAUDE_DISABLE_HEAP_RELAUNCH
  return env
}

function runBin(args: string[], configDir: string, timeout = 15_000) {
  return captureSync(process.execPath, [BIN_PATH, ...args], {
    timeout,
    env: binEnv(configDir),
  })
}

describe('openclaude wait command (bin)', () => {
  let configDir: string
  let registryRoot: string
  let sleepers: Array<ReturnType<typeof Bun.spawn>>

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'openclaude-bin-wait-'))
    registryRoot = join(configDir, 'bg-sessions')
    _setBackgroundSessionsRootForTesting(registryRoot)
    sleepers = []
  })

  afterEach(async () => {
    _setBackgroundSessionsRootForTesting(undefined)
    for (const sleeper of sleepers) {
      try {
        sleeper.kill('SIGKILL')
      } catch {}
      try {
        await sleeper.exited
      } catch {}
    }
    await rm(configDir, { recursive: true, force: true })
  })

  async function createSession(
    id: string,
    options: { pid?: number; command?: string[] } = {},
  ) {
    return await createBackgroundSession({
      id,
      pid: options.pid ?? 424242,
      cwd: configDir,
      command: options.command ?? ['sleep', '30'],
      sessionId: `sess-${id}`,
    })
  }

  async function startSleeper(seconds = 120) {
    const sleeper = Bun.spawn(['sleep', String(seconds)], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    sleepers.push(sleeper)
    // Give the process a moment to appear in `ps`.
    await new Promise(resolve => setTimeout(resolve, 100))
    return sleeper.pid
  }

  test('launcher skips the heap relaunch for wait', () => {
    const source = readFileSync(BIN_PATH, 'utf-8')
    const relaunchIndex = source.indexOf('spawnSync(process.execPath')
    const waitBypassIndex = source.indexOf("'wait'")
    expect(waitBypassIndex).toBeGreaterThanOrEqual(0)
    expect(relaunchIndex).toBeGreaterThanOrEqual(0)
    expect(waitBypassIndex).toBeLessThan(relaunchIndex)
  })

  test('returns exit 2 for an unknown selector instead of starting up', () => {
    expect(existsSync(DIST_PATH)).toBe(true)
    const result = runBin(['wait', 'no-such-session'], configDir)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No background session found')
  })

  test('returns exit 0 with exact JSON for an already-terminal session', async () => {
    expect(existsSync(DIST_PATH)).toBe(true)
    await createSession('bg-bin-1')
    await recordBackgroundSessionNaturalTermination(
      'bg-bin-1',
      { exitCode: 0 },
      { ownerPid: 424242 },
    )

    const result = runBin(['wait', 'bg-bin-1', '--json'], configDir)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout)
    expect(Object.keys(parsed).sort()).toEqual(
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
    expect(parsed).toMatchObject({
      version: 1,
      id: 'bg-bin-1',
      status: 'exited',
      exitCode: 0,
      waitResult: 'terminal',
    })
  })

  test('returns 124 with running JSON on timeout', async () => {
    expect(existsSync(DIST_PATH)).toBe(true)
    const pid = await startSleeper()
    await createSession('bg-bin-2', { pid, command: ['sleep', '120'] })

    const result = runBin(['wait', 'bg-bin-2', '--timeout', '1s', '--json'], configDir)

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(124)
    expect(result.stderr).toBe('')
    const parsed = JSON.parse(result.stdout)
    expect(parsed).toMatchObject({
      id: 'bg-bin-2',
      status: 'running',
      waitResult: 'timeout',
      error: 'timeout',
    })
  })

  // Wait until the waiter has installed its SIGINT listener before
  // signalling it. A fixed sleep races slow startup: a SIGINT delivered
  // before the listener exists kills the process by default instead of
  // producing the interrupted JSON. On Linux the caught-signal mask in
  // /proc/<pid>/status shows the installed handler (SIGINT is signal 2,
  // mask bit 0x2); one poll interval of grace after that lets session
  // resolution finish so the waiter is in its poll loop. Without /proc
  // (non-Linux) fall back to the previous fixed delay.
  async function waitForWaiterReady(
    proc: ReturnType<typeof Bun.spawn>,
  ): Promise<void> {
    const deadline = Date.now() + 15_000
    let procUnavailable = false
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) return
      let status: string
      try {
        status = readFileSync(`/proc/${proc.pid}/status`, 'utf8')
      } catch {
        procUnavailable = true
        break
      }
      const match = /^SigCgt:\s*([0-9a-f]+)$/m.exec(status)
      if (match && (BigInt(`0x${match[1]}`) & 0x2n) !== 0n) {
        await new Promise(resolve => setTimeout(resolve, 600))
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (procUnavailable) {
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }

  test('SIGINT to the launcher PID interrupts the waiter with 130 and leaves no inner waiter', async () => {
    expect(existsSync(DIST_PATH)).toBe(true)
    const pid = await startSleeper()
    await createSession('bg-bin-3', { pid, command: ['sleep', '120'] })

    const proc = Bun.spawn(
      [process.execPath, BIN_PATH, 'wait', 'bg-bin-3', '--json'],
      {
        env: binEnv(configDir),
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      },
    )
    // Wait for the waiter to be ready (listener installed + session
    // resolved) before signalling it; a fixed sleep races slow startup.
    await waitForWaiterReady(proc)
    process.kill(proc.pid, 'SIGINT')
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    expect(exitCode).toBe(130)
    expect(stderr).toBe('')
    const parsed = JSON.parse(stdout)
    expect(parsed).toMatchObject({
      id: 'bg-bin-3',
      status: null,
      waitResult: 'interrupted',
      error: 'interrupted',
      waitSignal: 'SIGINT',
    })

    // No inner waiter may survive the launcher: the heap relaunch must have
    // been bypassed for `wait`, so the signalled process was the waiter.
    const ps = Bun.spawnSync(['ps', '-eo', 'args'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const processes = ps.stdout.toString()
    expect(processes).not.toMatch(/cli\.mjs.*\bwait\b/)
  }, 20_000)
})
