import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { snapshotEnv } from '../test/envSnapshot.js'
import { isFileMentionsDisabledByEnv } from './attachments.js'
import { getResumeHintCommand } from './gracefulShutdown.js'
import { isUltrathinkDisabledByEnv } from './thinking.js'
import * as forkedAgentNs from './forkedAgent.js'

const realForkedAgent = { ...forkedAgentNs }

const ENV_VARS = [
  'CLAUDE_CODE_DISABLE_ULTRATHINK',
  'CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES',
  'CLAUDE_CODE_DISABLE_FILE_MENTIONS',
  'CLAUDE_CODE_RESUME_HINT_COMMAND',
]

let restoreEnv: () => void

beforeEach(async () => {
  await acquireSharedMutationLock('utils/envParity.test.ts')
  restoreEnv = snapshotEnv(ENV_VARS, { clear: true })
})

afterEach(() => {
  try {
    restoreEnv()
    mock.restore()
    mock.module('./forkedAgent.js', () => realForkedAgent)
  } finally {
    releaseSharedMutationLock()
  }
})

describe('CLAUDE_CODE_DISABLE_ULTRATHINK', () => {
  test('disables ultrathink when truthy and preserves behavior when unset', () => {
    expect(isUltrathinkDisabledByEnv()).toBe(false)
    process.env.CLAUDE_CODE_DISABLE_ULTRATHINK = '1'
    expect(isUltrathinkDisabledByEnv()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_ULTRATHINK = '0'
    expect(isUltrathinkDisabledByEnv()).toBe(false)
  })
})

describe('CLAUDE_CODE_DISABLE_FILE_MENTIONS', () => {
  test('disables file-mention reads when truthy and preserves behavior when unset', () => {
    expect(isFileMentionsDisabledByEnv()).toBe(false)
    process.env.CLAUDE_CODE_DISABLE_FILE_MENTIONS = '1'
    expect(isFileMentionsDisabledByEnv()).toBe(true)
  })
})

describe('CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES', () => {
  test('startAgentSummarization never forks a summary request when set', async () => {
    process.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES = '1'
    const runForkedAgent = mock(() => new Promise(() => {}))
    mock.module('./forkedAgent.js', () => ({
      ...realForkedAgent,
      runForkedAgent,
    }))
    const { startAgentSummarization } = await import(
      `../services/AgentSummary/agentSummary.js?ts=${Date.now()}`
    )
    const { stop } = startAgentSummarization(
      'task-1',
      'agent-1' as never,
      {} as never,
      (() => {}) as never,
    )
    stop()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(runForkedAgent).not.toHaveBeenCalled()
  })
})

describe('CLAUDE_CODE_RESUME_HINT_COMMAND', () => {
  test('defaults to openclaude and honors the override', () => {
    expect(getResumeHintCommand()).toBe('openclaude')
    process.env.CLAUDE_CODE_RESUME_HINT_COMMAND = 'mycmd'
    expect(getResumeHintCommand()).toBe('mycmd')
  })
})
