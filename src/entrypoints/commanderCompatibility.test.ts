import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const cliPath = resolve(import.meta.dir, '../../dist/cli.mjs')

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAUDE_DISABLE_TELEMETRY: '1' }
  delete env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
  return Bun.spawnSync(['node', cliPath, ...args], {
    env,
    timeout: 8_000,
  })
}

describe('built CLI Commander compatibility', () => {
  // Allow time for the eight-second subprocess deadline and assertions.
  test('registers the stderr debug option without breaking help', () => {
    const result = runCli(['--debug-to-stderr', '--help'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('Usage: openclaude')
    expect(result.stdout.toString()).toContain('--yolo, --dangerously-skip-permissions')
    expect(result.stderr.toString()).not.toContain('error:')
  }, 10_000)

  test('rejects excess prompt arguments before starting a session', () => {
    const result = runCli(['first', 'second'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('too many arguments')
    expect(result.stderr.toString()).toContain('Expected 1 argument but got 2')
  }, 10_000)

  test('parses a negative numeric value and reports the option validation error', () => {
    const result = runCli(['--max-turns', '-1'])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("option '--max-turns <turns>' argument '-1' is invalid")
    expect(result.stderr.toString()).not.toContain('unknown option')
  }, 10_000)
})
