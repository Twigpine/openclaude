import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runner = join(import.meta.dir, 'run-tests.ts')

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
          import { appendFileSync } from 'node:fs'
          test('first', () => {
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
        test('stuck compiler cleanup', () => {
          execFileSync(process.execPath, ['-e', ${JSON.stringify(subprocess)}], { timeout: 500 })
        }, 200)
      `)
      child = Bun.spawn([process.execPath, runner, '--shard-timeout-ms=1500', fixture], {
        stdout: 'pipe', stderr: 'pipe', timeout: 5000, killSignal: 'SIGKILL',
      })
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      for (let attempt = 0; attempt < 100; attempt++) {
        const pid = await readFile(marker, 'utf8').catch(() => '')
        if (pid) { descendant = Number(pid); break }
        await Bun.sleep(10)
      }
      expect(descendant).toBeDefined()
      if (signal) child.kill(signal)
      const exitCode = await child.exited
      const [, stderr] = await output
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
