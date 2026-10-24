import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let buildDir: string
let cliPath: string

function runCli(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAUDE_DISABLE_TELEMETRY: '1' }
  delete env.OPENCLAUDE_DISABLE_CLI_ENTRYPOINT_AUTO_RUN
  return Bun.spawnSync(['node', cliPath, ...args], {
    env,
    timeout: 8_000,
  })
}

describe('built CLI Commander compatibility', () => {
  beforeAll(async () => {
    const repoRoot = resolve(import.meta.dir, '../..')
    buildDir = await mkdtemp(join(tmpdir(), 'openclaude-commander-test-'))
    // The build script writes to cwd/dist. Give it the current source and
    // dependencies in an isolated workspace so every run tests a fresh bundle.
    for (const directory of ['src', 'scripts', 'node_modules']) {
      await symlink(join(repoRoot, directory), join(buildDir, directory), 'junction')
    }
    for (const file of ['package.json', 'tsconfig.json']) {
      await copyFile(join(repoRoot, file), join(buildDir, file))
    }
    const build = Bun.spawn([process.execPath, 'run', 'scripts/build.ts'], {
      cwd: buildDir,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 120_000,
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ])
    if (exitCode !== 0) {
      throw new Error(`CLI build failed (${exitCode}):\n${stdout}\n${stderr}`)
    }
    cliPath = join(buildDir, 'dist/cli.mjs')
  }, 130_000) // Leave time beyond the build deadline for output and cleanup.

  afterAll(async () => {
    if (buildDir) await rm(buildDir, { recursive: true, force: true })
  })

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
