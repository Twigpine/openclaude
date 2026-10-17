import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runner = join(import.meta.dir, 'run-tests.ts')

test.skipIf(process.platform !== 'linux')('output backpressure does not block the shard deadline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openclaude-runner-output-'))
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const fixture = join(dir, 'output.test.ts')
    await writeFile(fixture, `
      import { test } from 'bun:test'
      import { writeSync } from 'node:fs'
      test('blocked test', () => {
        writeSync(1, 'x'.repeat(1024 * 1024))
        Bun.sleepSync(3000)
      })
    `)
    // A real Node pipe is necessary: Bun.spawn eagerly buffers unread pipes.
    const observer = `
      const { spawn } = require('node:child_process')
      const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(runner)}, '--shard-timeout-ms=500', ${JSON.stringify(fixture)}])
      let diagnostics = '', output = '', resumed = false, deadlineBeforeResume = false
      child.stderr.on('data', chunk => {
        diagnostics += chunk.toString()
        if (!resumed && diagnostics.includes('timed out after 500ms')) deadlineBeforeResume = true
      })
      const timer = setTimeout(() => {
        resumed = true
        child.stdout.on('data', chunk => { output += chunk.toString() })
        child.stdout.resume()
      }, 1800)
      child.on('close', code => {
        clearTimeout(timer)
        console.log(JSON.stringify({ code, deadlineBeforeResume, complete: output.endsWith('x'.repeat(1024 * 1024)), diagnostics }))
      })
    `
    child = Bun.spawn(['node', '-e', observer], {
      stdout: 'pipe', stderr: 'pipe', timeout: 6000, killSignal: 'SIGKILL',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ])
    expect(code, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.deadlineBeforeResume, result.diagnostics).toBe(true)
    expect(result.code).toBe(124)
    expect(result.complete).toBe(true)
  } finally {
    child?.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
}, 8000)

for (const shards of [1, 2]) {
  for (const scenario of ['pass', 'assertion', 'exit'] as const) {
    test(`test runner detects ${scenario} and verifies completion (${shards} shards)`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openclaude-runner-test-'))
      try {
        const first = join(dir, 'first.test.ts')
        const later = join(dir, 'later.test.ts')
        const marker = join(dir, 'completed')
        await writeFile(first, `
          import { test, expect } from 'bun:test'
          import { appendFileSync, fstatSync, writeSync } from 'node:fs'
          test('first', () => {
            writeSync(1, 'fixture stdout\\n')
            writeSync(2, 'fixture stderr\\n')
            if (process.platform === 'linux') {
              expect(fstatSync(1).isFile()).toBe(true)
              expect(fstatSync(2).isFile()).toBe(true)
            }
            appendFileSync(${JSON.stringify(marker)}, 'first\\n')
            ${scenario === 'exit' ? 'process.exit(0)' : `expect(1).toBe(${scenario === 'assertion' ? 2 : 1})`}
          })
        `)
        await writeFile(later, `
          import { test } from 'bun:test'
          import { appendFileSync } from 'node:fs'
          test('later', () => appendFileSync(${JSON.stringify(marker)}, 'later\\n'))
        `)
        const child = Bun.spawn([process.execPath, runner, `--shards=${shards}`, first, later], {
          stdout: 'pipe', stderr: 'pipe',
        })
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(exitCode, stdout + stderr).toBe(scenario === 'pass' ? 0 : 1)
        expect(stdout.match(/fixture stdout/g)).toHaveLength(1)
        expect(stderr.match(/fixture stderr/g)).toHaveLength(1)
        if (scenario === 'exit') {
          expect(stderr).toContain('without a complete JUnit report')
        }
        const executed = (await readFile(marker, 'utf8')).trim().split('\n')
        expect(executed.filter(name => name === 'first')).toHaveLength(1)
        if (scenario !== 'exit' || shards === 2) {
          expect(executed.filter(name => name === 'later')).toHaveLength(1)
        }
        if (shards === 2) {
          expect(stderr).toContain(`Completed ${scenario === 'exit' ? 1 : 2}/2 test shards.`)
        } else if (scenario !== 'exit') {
          expect(stderr).toContain('Ran 2 tests across 2 files.')
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  }
}

for (const signal of [undefined, 'SIGINT', 'SIGTERM'] as const) {
  test.skipIf(process.platform === 'win32')(`test runner kills a stuck shard and its child (${signal ?? 'deadline'})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openclaude-runner-hang-'))
    let child: ReturnType<typeof Bun.spawn> | undefined
    let descendant: number | undefined
    try {
      const marker = join(dir, 'child-pid')
      const fixture = join(dir, 'stuck.test.ts')
      const subprocess = `
        process.on('SIGTERM', () => {})
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid))
        setInterval(() => {}, 1000)
      `
      await writeFile(fixture, `
        import { test } from 'bun:test'
        import { execFileSync } from 'node:child_process'
        import { writeSync } from 'node:fs'
        test('stuck compiler cleanup', () => {
          writeSync(2, 'last diagnostic before hang\\n')
          execFileSync(process.execPath, ['-e', ${JSON.stringify(subprocess)}], { timeout: 500 })
        }, 200)
      `)
      const shardTimeout = signal ? 4000 : 1500
      child = Bun.spawn([process.execPath, runner, `--shard-timeout-ms=${shardTimeout}`, fixture], {
        stdout: 'pipe', stderr: 'pipe', timeout: 6000, killSignal: 'SIGKILL',
      })
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      // The process deadline bounds readiness too; avoid a shorter startup race.
      while (true) {
        const pid = await readFile(marker, 'utf8').catch(() => '')
        if (pid) { descendant = Number(pid); break }
        if (child.exitCode !== null || child.signalCode !== null) break
        await Bun.sleep(10)
      }
      expect(descendant).toBeDefined()
      if (signal) child.kill(signal)
      const exitCode = await child.exited
      const [, stderr] = await output
      expect(stderr).toContain('last diagnostic before hang')
      expect(exitCode, stderr).toBe(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 124)
      if (!signal) expect(stderr).toContain('Test shard 1/1 timed out after 1500ms.')
      // An orphaned compiler must not survive a timeout or cancellation.
      for (let attempt = 0; attempt < 100; attempt++) {
        try { process.kill(descendant!, 0) } catch { break }
        await Bun.sleep(10)
      }
      expect(() => process.kill(descendant!, 0)).toThrow()
    } finally {
      child?.kill('SIGKILL')
      if (descendant) {
        try { process.kill(descendant, 'SIGKILL') } catch {}
      }
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)
}
