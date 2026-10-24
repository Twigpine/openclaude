import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'

test.each([
  ['enabled', 1, true],
  ['default-budget', 1, true],
  ['failsafe', 1, true],
  ['sync-rejection', 1, true],
  ['dsn-unset', 0, false],
  ['telemetry-disabled', 0, false],
  ['nonessential-disabled', 0, false],
  ['blocked', 1, false],
  ['throws', 1, false],
  ['rejects', 1, false],
] as const)('graceful shutdown handles Sentry flush: %s', async (mode, flushCalls, flushedBeforeExit) => {
  // Isolate SDK state, process.exit, and fake timers from the shared test runner.
  // The test deadline leaves time to collect output after the child deadline.
  const child = Bun.spawn([
    process.execPath,
    fileURLToPath(new URL('../test/fixtures/sentryShutdown.fixture.ts', import.meta.url)),
    mode,
  ], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 10_000,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  expect(JSON.parse(stdout)).toEqual({
    flushCalls,
    ...(flushCalls ? { flushTimeout: 2000 } : {}),
    exitCode: 7,
    flushedBeforeExit,
  })
}, 15_000)
