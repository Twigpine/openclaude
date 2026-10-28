import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import baseline from '../test/fixtures/markdownRendering.baseline.json'

let directory: string
let actual: Record<string, unknown>

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'openclaude-markdown-'))
  const child = Bun.spawnSync([
    process.execPath, 'run',
    join(import.meta.dir, '../test/fixtures/markdownRendering.fixture.tsx'),
    directory,
  ], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(directory, 'config'),
      OPENCLAUDE_CONFIG_DIR: join(directory, 'config'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 15_000,
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  expect(child.stderr.toString()).not.toContain('[Ink:uncaught]')
  actual = JSON.parse(child.stdout.toString())
  // The child has a 15-second deadline; allow another five seconds for setup
  // and assertions when the test suite is sharing a busy runner.
}, 20_000)

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true })
})

// Captured through the same production paths using marked 15.0.12 before the
// dependency change. Assert rendered output, not the lexer's internal shape.
describe('markdown output compatibility', () => {
  for (const [name, expected] of Object.entries(baseline)) {
    test(name, () => {
      expect(actual[name]).toEqual(expected)
    })
  }
})
