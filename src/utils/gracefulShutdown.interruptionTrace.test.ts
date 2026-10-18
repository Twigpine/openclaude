import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const testLinuxTraceFile = process.platform === 'linux' ? test : test.skip

function runFixture(extraEnv: NodeJS.ProcessEnv = {}): {
  aborted: boolean
  exitCalled: boolean
  writeSettled: boolean
  exitObservedSettledWrite: boolean
} {
  const fixture = resolve(
    import.meta.dirname,
    '../test/fixtures/gracefulShutdownTrace.fixture.ts',
  )
  const result = spawnSync(process.execPath, [fixture], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `fixture exited with ${result.status}\nstderr:\n${result.stderr}`,
    )
  }
  const resultLine = result.stdout
    .split('\n')
    .find(line => line.startsWith('TRACE_SHUTDOWN_RESULT '))
  expect(resultLine).toBeDefined()
  return JSON.parse(resultLine!.slice('TRACE_SHUTDOWN_RESULT '.length))
}

testLinuxTraceFile('graceful shutdown drains the interruption trace before process exit', () => {
  expect(runFixture()).toEqual({
    aborted: true,
    exitCalled: true,
    writeSettled: true,
    exitObservedSettledWrite: true,
  })
}, 20_000)

testLinuxTraceFile('graceful shutdown queues otherwise-pending trace records', () => {
  expect(runFixture({ TRACE_SHUTDOWN_PENDING_ONLY: '1' })).toEqual({
    aborted: true,
    exitCalled: true,
    writeSettled: true,
    exitObservedSettledWrite: true,
  })
}, 20_000)

testLinuxTraceFile('graceful shutdown bounds a blocked interruption trace drain', () => {
  expect(runFixture({ TRACE_SHUTDOWN_BLOCK_WRITE: '1' })).toEqual({
    aborted: true,
    exitCalled: true,
    writeSettled: false,
    exitObservedSettledWrite: false,
  })
}, 20_000)
