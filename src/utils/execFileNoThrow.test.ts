import { expect, spyOn, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function importFreshExecFileNoThrowModule() {
  return import(`./execFileNoThrow.ts?ts=${Date.now()}-${Math.random()}`)
}

test('execFileNoThrowWithCwd rejects shell-like executable names', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd('openclaude && whoami', [])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe executable')
})

test('execFileNoThrowWithCwd rejects cwd values with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    cwd: 'C:\\repo\nmalicious',
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe working directory')
})

test('execFileNoThrowWithCwd rejects arguments with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, [
    '--version\nmalicious',
  ])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe argument')
})

test('execFileNoThrowWithCwd rejects environment entries with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    env: {
      ...process.env,
      BAD_ENV: 'line1\nline2',
    },
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe environment')
})

test('execFileNoThrowWithCwd preserves Windows .cmd compatibility', async () => {
  if (process.platform !== 'win32') {
    return
  }
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()

  const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-'))
  try {
    const file = join(dir, 'hello.cmd')
    writeFileSync(file, '@echo off\r\necho hello\r\n')

    const result = await execFileNoThrowWithCwd(file, [])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('hello')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('execFileNoThrowWithCwd keeps the SIGKILL escalation when output overflows during the abort grace', async () => {
  // POSIX-only: on Windows SIGTERM terminates the child instead of
  // running its handler, so the fixture child cannot keep writing
  // after the abort and the wrapper correctly reports an abort, not
  // an overflow (CodeRabbit #2497 review 5966284444). Windows
  // cancellation is covered by the timeout-0 test below, which
  // settles through the kill bound on both platforms.
  if (process.platform === 'win32') {
    return
  }
  // Regression test for CodeRabbit #2497 review 5963778469: a child
  // that traps SIGTERM and keeps writing past maxBuffer during the
  // abort grace must not settle the result while it is still alive —
  // settling would cancel the pending SIGKILL and report the command
  // finished while its process is still running. The result still
  // carries the overflow error, but only once the child has actually
  // exited. The overflow is produced by the SIGTERM handler itself,
  // after readiness is published (CodeRabbit #2497 review 5966284444):
  // a free-running timer could overflow before the abort if the
  // parent is delayed, which would exercise ordinary overflow
  // instead of overflow during the grace.
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-overflow-'))
  const pidFile = join(dir, 'child.pid')
  const controller = new AbortController()
  try {
    // The pid file path reaches the child through the environment, not
    // interpolated into the -e script: no code is constructed from a
    // value, so the CodeQL code-injection alert on this test clears
    // (CodeQL #2497). The path was JSON.stringify-escaped before, so
    // no injection was possible through it — this only removes the
    // flagged pattern.
    const script = `process.on('SIGTERM', () => { process.stdout.write('x'.repeat(1500)); }); require('fs').writeFileSync(process.env.OPENCLAUDE_TEST_CHILD_PID_FILE, String(process.pid)); setTimeout(() => {}, 30000);`
    const pending = execFileNoThrowWithCwd(process.execPath, ['-e', script], {
      timeout: 10000,
      maxBuffer: 1000,
      abortSignal: controller.signal,
      awaitCloseOnAbort: true,
      env: {
        ...process.env,
        OPENCLAUDE_TEST_CHILD_PID_FILE: pidFile,
      },
    })
    // Wait until the child has started, then abort: the buffer
    // overflows after the abort, during the SIGKILL grace.
    const startedAt = performance.now()
    while (!existsSync(pidFile)) {
      if (performance.now() - startedAt > 5000) {
        throw new Error('child did not start')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    const result = await pending
    expect(result.code).toBe(1)
    expect(result.error).toBe('maxBuffer exceeded')
    // The child must already be dead when the result settles: without
    // the fix the overflow settles immediately and the SIGKILL never
    // fires, so the trapped child is still alive here.
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(childPid, 0)).toThrow()
  } finally {
    // The child traps SIGTERM, so only a SIGKILL stops it — the fix
    // under test sends exactly that. Kill it here if the run under
    // test did not.
    try {
      const childPid = Number(readFileSync(pidFile, 'utf8'))
      if (childPid) process.kill(childPid, 'SIGKILL')
    } catch {
      // Already dead or never started.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test.each([
  { timeout: 0, exitBeforeAbort: false },
  { timeout: 10_000, exitBeforeAbort: false },
  { timeout: 0, exitBeforeAbort: true },
])('execFileNoThrowWithCwd closes retained pipes (timeout $timeout, exited before abort $exitBeforeAbort)', async ({ timeout, exitBeforeAbort }) => {
  // Regression test for CodeRabbit #2497 review 5963778469: with
  // timeout 0 there is no timeout callback to start the last-resort
  // settle timer, so an aborted child whose stdio pipe a descendant
  // keeps open would leave the result pending forever. The settle
  // timer must start when the abort escalates to SIGKILL, so the
  // result settles once the child is killed even though its 'close'
  // is delayed by the descendant.
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-timeout0-'))
  const childPidFile = join(dir, 'child.pid')
  const pidFile = join(dir, 'grandchild.pid')
  const controller = new AbortController()
  const scheduled = spyOn(globalThis, 'setTimeout')
  const cleared = spyOn(globalThis, 'clearTimeout')
  const { getInMemoryErrors } = await import('./log.js')
  const errorsBeforeAbort = getInMemoryErrors().slice()
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let pending: ReturnType<typeof execFileNoThrowWithCwd> | undefined
  try {
    // Pass the fixture directory as data. The grandchild waits until the
    // wrapper returns before trying to write to the inherited pipe.
    const script = `process.on('SIGTERM', () => {}); const { spawn } = require('child_process'); const grandchild = spawn(process.execPath, ['-e', 'const fs = require("fs"); const path = require("path"); const dir = process.env.OPENCLAUDE_TEST_PID_DIR; const wait = () => { if (fs.existsSync(path.join(dir, "settled"))) { process.stdout.on("error", () => {}); process.stdout.write("x".repeat(2000), error => { fs.writeFileSync(path.join(dir, "burst.done"), error?.code ?? "written"); }); } else { setTimeout(wait, 25); } }; wait(); setTimeout(() => {}, 15000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); const dir = process.env.OPENCLAUDE_TEST_PID_DIR; require('fs').writeFileSync(require('path').join(dir, 'child.pid'), String(process.pid)); require('fs').writeFileSync(require('path').join(dir, 'grandchild.pid'), String(grandchild.pid)); if (process.env.OPENCLAUDE_TEST_EXIT_FIRST === '1') process.exit(0); setTimeout(() => {}, 15000);`
    const startedAt = performance.now()
    pending = execFileNoThrowWithCwd(process.execPath, ['-e', script], {
      timeout,
      maxBuffer: 1000,
      abortSignal: controller.signal,
      awaitCloseOnAbort: true,
      env: {
        ...process.env,
        OPENCLAUDE_TEST_PID_DIR: dir,
        OPENCLAUDE_TEST_EXIT_FIRST: exitBeforeAbort ? '1' : '0',
      },
    })
    const commandTimer = scheduled.mock.calls.findIndex(([, delay]) => delay === timeout)
    while (!existsSync(pidFile)) {
      if (performance.now() - startedAt > 5000) {
        throw new Error('child did not start')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const childPid = Number(readFileSync(childPidFile, 'utf8'))
    // Code 1 with a short elapsed time would also pass if the wrapper
    // returned immediately on abort without sending SIGKILL, so the
    // settlement itself must be tied to the direct child's exit
    // (CodeRabbit #2497 review 5966284444): the result must stay
    // pending while the direct child is still alive, and settle only
    // once it has exited — while the descendant still holds stdout
    // open, so the close event cannot be what settled it.
    let resultSettled = false
    const resultPromise = pending.then(result => {
      resultSettled = true
      return result
    })
    if (!exitBeforeAbort) controller.abort()
    const exitDeadline = performance.now() + 5000
    for (;;) {
      let alive = true
      try {
        process.kill(childPid, 0)
      } catch {
        alive = false
      }
      if (!alive) break
      if (resultSettled) {
        throw new Error('result settled while the direct child was still alive')
      }
      if (performance.now() > exitDeadline) {
        throw new Error('direct child did not exit')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    if (exitBeforeAbort) {
      expect(resultSettled).toBe(false)
      controller.abort()
    }
    const result = await Promise.race([
      resultPromise,
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('wrapper did not settle after abort')), 3500)
      }),
    ])
    const elapsedMs = performance.now() - startedAt
    expect(result.code).toBe(1)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    expect(getInMemoryErrors()).toEqual(errorsBeforeAbort)
    if (timeout > 0) {
      expect(commandTimer).toBeGreaterThanOrEqual(0)
      expect(cleared).toHaveBeenCalledWith(scheduled.mock.results[commandTimer]!.value)
    }
    // The grandchild holds the pipe for 15 s: settling here proves the
    // kill settle bound fired instead of waiting for its 'close'.
    expect(elapsedMs).toBeLessThan(10000)
    const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()
    // Publish the settlement marker so the grandchild writes its burst
    // now, strictly after the result settled, and wait until the burst
    // has been delivered before asserting anything about it.
    writeFileSync(join(dir, 'settled'), '')
    const burstDeadline = performance.now() + 5000
    while (!existsSync(join(dir, 'burst.done'))) {
      if (performance.now() > burstDeadline) {
        throw new Error('grandchild did not write its post-settle burst')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(readFileSync(join(dir, 'burst.done'), 'utf8')).not.toBe('written')
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()
  } finally {
    clearTimeout(watchdog)
    try {
      const childPid = Number(readFileSync(childPidFile, 'utf8'))
      if (childPid) process.kill(childPid, 'SIGKILL')
    } catch {
      // Already dead or never started.
    }
    try {
      const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
      if (grandchildPid) process.kill(grandchildPid, 'SIGKILL')
    } catch {
      // Already dead or never started.
    }
    await pending
    scheduled.mockRestore()
    cleared.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === 'win32')(
  'execFileNoThrowWithCwd reaps an opted-in inspector after its own timeout',
  async () => {
    const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
    const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-own-timeout-'))
    const pidFile = join(dir, 'child.pid')
    let pid: number | undefined
    try {
      const result = await execFileNoThrowWithCwd(process.execPath, [
        '-e',
        'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.env.OPENCLAUDE_TEST_PID_FILE, String(process.pid)); setTimeout(() => {}, 10000)',
      ], {
        timeout: 1000,
        awaitCloseOnAbort: true,
        env: { ...process.env, OPENCLAUDE_TEST_PID_FILE: pidFile },
      })
      pid = Number(readFileSync(pidFile, 'utf8'))
      expect(result.error).toBe('Command timed out after 1000ms')
      expect(() => process.kill(pid!, 0)).toThrow()
    } finally {
      if (pid !== undefined) {
        try { process.kill(pid, 'SIGKILL') } catch {}
      }
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
