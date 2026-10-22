import { expect, test } from 'bun:test'
import { isolateProcessExitCode } from './processExitCode.js'

test('isolates exit codes and restores the original process', () => {
  const originalProcess = globalThis.process
  const originalExitCode = originalProcess.exitCode
  const originalCwd = originalProcess.cwd()
  const restoreProcess = isolateProcessExitCode()

  try {
    expect(process.exitCode).toBe(originalExitCode)
    expect(process.cwd()).toBe(originalCwd)

    process.exitCode = 7
    expect(process.exitCode).toBe(7)
    expect(originalProcess.exitCode).toBe(originalExitCode)

    process.exitCode = 0
    expect(process.exitCode).toBe(0)
    expect(originalProcess.exitCode).toBe(originalExitCode)

    process.exitCode = undefined
    expect(process.exitCode).toBeUndefined()
    expect(originalProcess.exitCode).toBe(originalExitCode)
  } finally {
    restoreProcess()
  }

  expect(globalThis.process).toBe(originalProcess)
  expect(originalProcess.exitCode).toBe(originalExitCode)
})
