import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  REAL_PROVIDER_TEST_CHILD_ENV,
  REAL_PROVIDER_TEST_TIMEOUT_MS,
} from './providerModuleIsolation.js'

async function withFixture(
  scenario: string,
  run: (entry: string, env: NodeJS.ProcessEnv) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'provider-isolation-'))
  const entry = join(root, 'isolation.test.ts')
  const fixture = join(import.meta.dir, 'fixtures/providerModuleIsolation.fixture.ts')
  writeFileSync(entry, `await import(${JSON.stringify(fixture)})\n`)
  try {
    await run(entry, {
      ...process.env,
      [REAL_PROVIDER_TEST_CHILD_ENV]: undefined,
      ISOLATION_FIXTURE_SCENARIO: scenario,
      CLAUDE_CONFIG_DIR: root,
      OPENCLAUDE_CONFIG_DIR: root,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The fixture may itself run a child with a 30-second deadline. Give the outer
// process and test additional time for diagnostics and cleanup.
const fixtureTimeout = REAL_PROVIDER_TEST_TIMEOUT_MS + 10_000
const testTimeout = fixtureTimeout + 5_000

for (const scenario of [
  'clean',
  'auth',
  'betas',
  'routing',
  'metadata',
  'client',
  'missing',
  'unsupported',
  'native-function',
  'import-failure',
  'child-marker',
  'suite-sideQuery',
  'suite-authRouting',
]) {
  test(`isolates attribution modules: ${scenario}`, async () => {
    await withFixture(scenario, async (entry, env) => {
      const child = Bun.spawn({
        cmd: [process.execPath, 'test', entry],
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: fixtureTimeout,
        killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = `${stdout}\n${stderr}`
      expect(output).not.toContain('parent setup sentinel')
      expect(output).not.toContain('parent cleanup sentinel')
      expect(output).toMatch(/^\s*1 pass$/m)
      expect(output).toMatch(/^\s*0 fail$/m)
      expect(output).not.toMatch(/\d+ skip/)
      expect(exitCode).toBe(0)
    })
  }, { timeout: testTimeout })
}

for (const scenario of ['assertion-failure', 'early-exit', 'complete']) {
  test(`verifies isolated child completion: ${scenario}`, async () => {
    await withFixture(scenario, async (entry, env) => {
      // Run the real launcher in a disposable process so coordinator env and mocks
      // remain untouched even when other suites share this process.
      const runner = join(entry, '..', 'launcher.test.ts')
      writeFileSync(runner, `
        import { test } from 'bun:test'
        import { runTestFileWithRealProviders } from ${JSON.stringify(
          join(import.meta.dir, 'providerModuleIsolation.ts'),
        )}
        test('nested launcher', () => runTestFileWithRealProviders(${JSON.stringify(entry)}), ${REAL_PROVIDER_TEST_TIMEOUT_MS + 5_000})
      `)
      const child = Bun.spawn({
        cmd: [process.execPath, join(import.meta.dir, '../../scripts/run-tests.ts'), runner],
        env: { ...env, TMPDIR: join(entry, '..'), TMP: join(entry, '..'), TEMP: join(entry, '..') },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: fixtureTimeout,
        killSignal: process.platform === 'win32' ? undefined : 'SIGKILL',
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = `${stdout}\n${stderr}`
      expect(exitCode, output).toBe(scenario === 'complete' ? 0 : 1)
      if (scenario !== 'complete') {
        expect(output).toContain('provider-isolated test process failed')
        expect(output).toMatch(/^\s*1 fail$/m)
        expect(output).toContain(scenario === 'early-exit'
          ? 'without a complete JUnit report'
          : 'expected child value')
        if (scenario === 'assertion-failure') expect(output).toContain('child assertion failure sentinel')
      } else {
        expect(output).toMatch(/^\s*1 pass$/m)
      }
      expect(readdirSync(join(entry, '..')).filter(name =>
        name.startsWith('openclaude-test-report-'),
      )).toEqual([])
    })
  }, { timeout: testTimeout })
}
