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
