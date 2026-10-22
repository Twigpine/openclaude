import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { expect, test } from 'bun:test'
import { wrapSpawn } from './ShellCommand.js'
import { TaskOutput } from './task/TaskOutput.js'

function createMockChildProcess(): EventEmitter & {
  pid?: number
  stdout: null
  stderr: null
} {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: null
    stderr: null
  }
  child.stdout = null
  child.stderr = null
  child.pid = undefined
  return child
}

test('interrupt kills running shell commands', async () => {
  const child = createMockChildProcess()
  const controller = new AbortController()
  const command = wrapSpawn(
    child as never,
    controller.signal,
    30_000,
    new TaskOutput('shellcommand-test-running', null),
  )

  controller.abort('interrupt')

  const result = await command.result
  expect(command.status).toBe('killed')
  expect(result.interrupted).toBe(true)
  expect(result.code).toBe(137)
})

test('query-timeout abort is reported as an abort cancellation', async () => {
  const child = createMockChildProcess()
  const controller = new AbortController()
  const command = wrapSpawn(
    child as never,
    controller.signal,
    30_000,
    new TaskOutput('shellcommand-test-query-timeout', null),
  )

  controller.abort('query-timeout')

  const result = await command.result
  expect(command.status).toBe('killed')
  expect(result.interrupted).toBe(true)
  expect(result.code).toBe(137)
  expect(result.signalAborted).toBe(true)
  expect(result.isAbort).toBe(true)
  expect(result.abortReason).toBe('query-timeout')
})

test('shell command timeout is not reported as an abort cancellation', async () => {
  const child = createMockChildProcess()
  const controller = new AbortController()
  const command = wrapSpawn(
    child as never,
    controller.signal,
    10,
    new TaskOutput('shellcommand-test-tool-timeout', null),
  )

  const result = await command.result
  expect(command.status).toBe('killed')
  expect(result.code).toBe(143)
  expect(result.interrupted).toBe(false)
  expect(result.signalAborted).toBe(false)
  expect(result.isAbort).toBe(false)
  expect(result.abortReason).toBe('tool-timeout')
})

test('interrupt does not kill backgrounded shell commands', async () => {
  const child = createMockChildProcess()
  const controller = new AbortController()
  const command = wrapSpawn(
    child as never,
    controller.signal,
    30_000,
    new TaskOutput('shellcommand-test-backgrounded', null),
  )

  expect(command.background('bg-task')).toBe(true)
  controller.abort('interrupt')

  await Promise.resolve()
  expect(command.status).toBe('backgrounded')

  child.emit('exit', 0, null)
  const result = await command.result
  expect(result.code).toBe(0)
  expect(result.backgroundTaskId).toBe('bg-task')
  expect(result.isAbort).toBe(false)
})

test('interrupt does not kill keep-alive commands used by asyncRewake hooks', async () => {
  const child = createMockChildProcess()
  const controller = new AbortController()
  const command = wrapSpawn(
    child as never,
    controller.signal,
    30_000,
    new TaskOutput('shellcommand-test-keepalive', null),
    false,
    undefined,
    { keepAliveOnInterrupt: true },
  )

  controller.abort('interrupt')

  await Promise.resolve()
  expect(command.status).toBe('running')

  child.emit('exit', 2, null)
  const result = await command.result
  expect(result.code).toBe(2)
  expect(result.interrupted).toBe(false)
})

test('already-aborted user-cancel kills a real child promptly', async () => {
  const controller = new AbortController()
  controller.abort('user-cancel')

  const startedAt = performance.now()
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const childClosed = new Promise<void>(resolve => {
    child.once('close', () => resolve())
  })
  const command = wrapSpawn(
    child,
    controller.signal,
    1_000,
    new TaskOutput('shellcommand-test-already-aborted', null),
  )

  try {
    expect(child.pid).toBeDefined()

    const result = await command.result
    const elapsedMs = performance.now() - startedAt
    await childClosed

    expect(elapsedMs).toBeLessThan(2_000)
    expect(result.isAbort).toBe(true)
    expect(result.abortReason).toBe('user-abort')
    expect(result.interrupted).toBe(true)
    expect(result.signalAborted).toBe(true)
    expect(command.status).toBe('killed')
  } finally {
    child.kill('SIGKILL')
    await command.result
    await childClosed
    command.cleanup()
  }
})
