import { expect, test } from 'bun:test'
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
  // Regression test for CodeRabbit #2497 review 5963778469: a child
  // that traps SIGTERM and keeps writing past maxBuffer during the
  // abort grace must not settle the result while it is still alive —
  // settling would cancel the pending SIGKILL and report the command
  // finished while its process is still running. The result still
  // carries the overflow error, but only once the child has actually
  // exited.
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-overflow-'))
  const pidFile = join(dir, 'child.pid')
  const controller = new AbortController()
  try {
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); const timer = setInterval(() => { process.stdout.write('x'.repeat(100)); }, 25); setTimeout(() => { clearInterval(timer); }, 30000); setTimeout(() => {}, 30000);`
    const pending = execFileNoThrowWithCwd(process.execPath, ['-e', script], {
      timeout: 10000,
      maxBuffer: 1000,
      abortSignal: controller.signal,
      awaitCloseOnAbort: true,
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

test('execFileNoThrowWithCwd settles an aborted child even when timeout is 0', async () => {
  // Regression test for CodeRabbit #2497 review 5963778469: with
  // timeout 0 there is no timeout callback to start the last-resort
  // settle timer, so an aborted child whose stdio pipe a descendant
  // keeps open would leave the result pending forever. The settle
  // timer must start when the abort escalates to SIGKILL, so the
  // result settles once the child is killed even though its 'close'
  // is delayed by the descendant.
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const dir = mkdtempSync(join(tmpdir(), 'openclaude-execfile-timeout0-'))
  const pidFile = join(dir, 'grandchild.pid')
  const controller = new AbortController()
  try {
    const script = `process.on('SIGTERM', () => {}); const { spawn } = require('child_process'); const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid)); setTimeout(() => {}, 15000);`
    const startedAt = performance.now()
    const pending = execFileNoThrowWithCwd(process.execPath, ['-e', script], {
      timeout: 0,
      abortSignal: controller.signal,
      awaitCloseOnAbort: true,
    })
    while (!existsSync(pidFile)) {
      if (performance.now() - startedAt > 5000) {
        throw new Error('child did not start')
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    controller.abort()
    const result = await pending
    const elapsedMs = performance.now() - startedAt
    expect(result.code).toBe(1)
    // The grandchild holds the pipe for 15 s: settling here proves the
    // kill settle bound fired instead of waiting for its 'close'.
    expect(elapsedMs).toBeLessThan(10000)
  } finally {
    try {
      const grandchildPid = Number(readFileSync(pidFile, 'utf8'))
      if (grandchildPid) process.kill(grandchildPid, 'SIGKILL')
    } catch {
      // Already dead or never started.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})
