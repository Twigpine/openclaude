import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { join } from 'path'

// Regression for the foreground-only interrupt path: when a REPL inner agent
// (replInnerExecution) interrupts a running foreground PowerShell command,
// backgrounding is not available, so the interrupt branch must fall through
// to shellCommand.kill() rather than startBackgrounding(). Previously the
// guard only checked isBackgroundTasksDisabled, so a foreground-only
// interrupt spawned a background task the REPL agent can never surface.
//
// The harness runs the real PowerShellTool.call() in a clean child process
// with the shell layer mocked (see the fixture for rationale). The control
// scenario proves the harness still detects backgrounding when it is allowed.

const FIXTURE = join(import.meta.dir, 'PowerShellTool.interruptForeground.fixture.ts')

interface ScenarioResult {
  state: {
    execCalls: number
    killCalls: number
    spawnCalls: number
    cleanupCalls: number
  }
  backgroundTaskId: unknown
  interrupted: unknown
  error?: string
}

function runFixture(): {
  foregroundOnly: ScenarioResult
  backgroundable: ScenarioResult
} {
  const stdout = execFileSync(process.execPath, ['run', FIXTURE], {
    encoding: 'utf8',
    timeout: 60_000,
  })
  return JSON.parse(stdout.trim().split('\n').pop()!)
}

describe('PowerShellTool interrupt backgrounding guard', () => {
  test('foreground-only interrupts kill the shell instead of backgrounding', () => {
    const { foregroundOnly } = runFixture()
    expect(foregroundOnly.error).toBeUndefined()
    // The interrupt must not spawn a background task...
    expect(foregroundOnly.state.spawnCalls).toBe(0)
    expect(foregroundOnly.backgroundTaskId).toBeUndefined()
    // ...it must fall through to shellCommand.kill().
    expect(foregroundOnly.state.killCalls).toBeGreaterThanOrEqual(1)
    expect(foregroundOnly.interrupted).toBe(true)
  }, 90_000)

  test('control: ordinary interrupts still background the command', () => {
    const { backgroundable } = runFixture()
    expect(backgroundable.error).toBeUndefined()
    expect(backgroundable.state.spawnCalls).toBe(1)
    expect(backgroundable.backgroundTaskId).toBe('bg-task-id')
    expect(backgroundable.state.killCalls).toBe(0)
  }, 90_000)
})
