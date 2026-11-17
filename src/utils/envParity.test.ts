import { afterEach, beforeEach, describe, expect, mock, test, vi } from 'bun:test'
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { snapshotEnv } from '../test/envSnapshot.js'
import { isFileMentionsDisabledByEnv } from './attachments.js'
import { getResumeHintCommand } from './gracefulShutdown.js'
import { isUltrathinkDisabledByEnv, isUltrathinkEnabled, isUltrathinkKeywordArmed } from './thinking.js'
import * as forkedAgentNs from './forkedAgent.js'
import * as sessionStorageNs from './sessionStorage.js'
import * as runAgentNs from '../tools/AgentTool/runAgent.js'
import * as localAgentTaskNs from '../tasks/LocalAgentTask/LocalAgentTask.js'

const realForkedAgent = { ...forkedAgentNs }
const realSessionStorage = { ...sessionStorageNs }
const realRunAgent = { ...runAgentNs }
const realLocalAgentTask = { ...localAgentTaskNs }

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
    mock.module('./sessionStorage.js', () => realSessionStorage)
    mock.module('../tools/AgentTool/runAgent.js', () => realRunAgent)
    mock.module('../tasks/LocalAgentTask/LocalAgentTask.js', () => realLocalAgentTask)
    vi.useRealTimers()
  } finally {
    releaseSharedMutationLock()
  }
})

describe('CLAUDE_CODE_DISABLE_ULTRATHINK', () => {
  test('disables the keyword trigger without touching the shared gate', () => {
    const gate = isUltrathinkEnabled()
    expect(isUltrathinkDisabledByEnv()).toBe(false)
    process.env.CLAUDE_CODE_DISABLE_ULTRATHINK = '1'
    expect(isUltrathinkDisabledByEnv()).toBe(true)
    expect(isUltrathinkKeywordArmed()).toBe(false)
    expect(isUltrathinkEnabled()).toBe(gate)
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
  test('skips the scheduled summary fork when set and reaches it when unset', async () => {
    vi.useFakeTimers()
    try {
      const runForkedAgent = mock(async () => ({ messages: [] }))
      mock.module('./forkedAgent.js', () => ({
        ...realForkedAgent,
        runForkedAgent,
      }))
      mock.module('./sessionStorage.js', () => ({
        ...realSessionStorage,
        getAgentTranscript: mock(async () => ({
          messages: [{ type: 'user' }, { type: 'assistant' }, { type: 'user' }],
        })),
      }))
      mock.module('../tools/AgentTool/runAgent.js', () => ({
        filterIncompleteToolCalls: <T>(messages: T) => messages,
        runAgent: async function* () {},
      }))
      mock.module('../tasks/LocalAgentTask/LocalAgentTask.js', () => ({
        updateAgentSummary: mock(() => {}),
      }))
      const { startAgentSummarization } = await import(
        `../services/AgentSummary/agentSummary.js?ts=${Date.now()}-${Math.random()}`
      )

      process.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES = '1'
      const disabled = startAgentSummarization(
        'task-off',
        'agent-1' as never,
        {} as never,
        (() => {}) as never,
      )
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
      await Promise.resolve()
      expect(runForkedAgent).not.toHaveBeenCalled()
      disabled.stop()

      delete process.env.CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES
      const enabled = startAgentSummarization(
        'task-on',
        'agent-1' as never,
        {} as never,
        (() => {}) as never,
      )
      vi.advanceTimersByTime(30_000)
      await Promise.resolve()
      await Promise.resolve()
      expect(runForkedAgent).toHaveBeenCalledTimes(1)
      enabled.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('CLAUDE_CODE_RESUME_HINT_COMMAND', () => {
  test('defaults to openclaude and honors the override', () => {
    expect(getResumeHintCommand()).toBe('openclaude')
    process.env.CLAUDE_CODE_RESUME_HINT_COMMAND = 'mycmd'
    expect(getResumeHintCommand()).toBe('mycmd')
  })
})
