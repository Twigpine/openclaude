import { describe, expect, test } from 'bun:test'

import { toSDKGoalStatusMessage } from './services/goal/sdk.js'
import { isGoalStatusSystemMessage } from './services/goal/status.js'
import { createSystemMessage } from './utils/messages.js'

describe('QueryEngine goal status visibility', () => {
  test('recognizes only goal status informational messages for SDK visibility', () => {
    expect(
      isGoalStatusSystemMessage({
        type: 'system',
        subtype: 'informational',
        content: 'Goal achieved: tests pass',
      }),
    ).toBe(true)

    expect(
      isGoalStatusSystemMessage({
        type: 'system',
        subtype: 'informational',
        content: 'Goal not complete: tests missing',
      }),
    ).toBe(true)

    expect(
      isGoalStatusSystemMessage({
        type: 'system',
        subtype: 'informational',
        content: 'Goal paused: evaluator failed',
      }),
    ).toBe(true)

    expect(
      isGoalStatusSystemMessage({
        type: 'system',
        subtype: 'informational',
        content: 'Stop hook failed: bad hook',
      }),
    ).toBe(false)
  })

  test('maps goal status system messages to SDK assistant output', () => {
    const systemMessage = createSystemMessage(
      'Goal achieved: tests pass',
      'info',
    )
    const goalStatusMessage = toSDKGoalStatusMessage(systemMessage)

    expect(goalStatusMessage).toBeTruthy()
    expect(goalStatusMessage?.type).toBe('assistant')
    expect(goalStatusMessage?.message.content[0]).toEqual({
      type: 'text',
      text: 'Goal achieved: tests pass',
    })
    expect(goalStatusMessage?.parent_tool_use_id).toBeNull()
    expect(goalStatusMessage?.uuid).toBe(systemMessage.uuid)
  })

  test('QueryEngine.submitMessage forwards goal status as SDK assistant output', async () => {
    const proc = Bun.spawn(
      [process.execPath, 'src/test/fixtures/queryEngineGoalStatus.fixture.ts'],
      {
        cwd: process.cwd(),
        stderr: 'pipe',
        stdout: 'pipe',
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(
      { exitCode, stderr, stdout },
      `fixture failed\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    ).toEqual({
      exitCode: 0,
      stderr: '',
      stdout: '',
    })
  })
})
