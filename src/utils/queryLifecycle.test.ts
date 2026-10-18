import { describe, expect, test } from 'vitest'
import {
  formatQueryLifecycleAbortSignalReason,
  formatQueryLifecycleLogMessage,
  getQueryTerminalOutcome,
  getQueryTerminalReason,
  type QueryLifecycleContext,
} from './queryLifecycle.js'

describe('query lifecycle log formatting', () => {
  test('keeps timeout context abort reason distinct from abort signal reason', () => {
    const context: QueryLifecycleContext = {
      queryId: 'query-1',
      queryGeneration: 1,
      querySource: 'repl_main_thread',
      startedAt: 1,
      terminalReason: 'query-timeout',
      abortReason: 'idle',
    }

    const line = formatQueryLifecycleLogMessage(
      'abort_requested',
      context,
      formatQueryLifecycleAbortSignalReason('query-timeout'),
    )

    expect(line).toContain('abortReason=idle')
    expect(line).toContain('abortSignalReason=query-timeout')
    expect(line).not.toContain('abortReason=query-timeout')
    expect(line.match(/\babortReason=/g)).toHaveLength(1)
  })

  test('keeps exact expected side-task abort reason on grouped lifecycle end log', () => {
    const context: QueryLifecycleContext = {
      queryId: 'query-1',
      queryGeneration: 1,
      querySource: 'forked_agent',
      startedAt: 1,
      terminalReason: 'parent-ended',
      abortReason: 'memory-extraction-superseded',
    }

    const line = formatQueryLifecycleLogMessage('end', context)

    expect(line).toContain('terminalReason=parent-ended')
    expect(line).toContain('abortReason=memory-extraction-superseded')
  })
})

describe('query terminal reason classification', () => {
  test('classifies coarse terminal outcomes with abort precedence', () => {
    expect(getQueryTerminalOutcome({ aborted: false }, false)).toBe('completed')
    expect(getQueryTerminalOutcome({ aborted: false }, true)).toBe('failed')
    expect(getQueryTerminalOutcome({ aborted: true }, false)).toBe('aborted')
    expect(getQueryTerminalOutcome({ aborted: true }, true)).toBe('aborted')
  })

  test('classifies non-aborted completion from throw state', () => {
    expect(
      getQueryTerminalReason({ aborted: false, reason: undefined }, false),
    ).toBe('ok')
    expect(
      getQueryTerminalReason({ aborted: false, reason: undefined }, true),
    ).toBe('unknown')
  })

  test('passes timeout aborts through as terminal reasons', () => {
    expect(
      getQueryTerminalReason({ aborted: true, reason: 'query-timeout' }, false),
    ).toBe('query-timeout')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: 'hard-max-query-timeout' },
        false,
      ),
    ).toBe('hard-max-query-timeout')
    expect(
      getQueryTerminalReason({ aborted: true, reason: 'hard_max' }, false),
    ).toBe('hard-max-query-timeout')
  })

  test('groups user-style aborts as user aborts', () => {
    const defaultAbort = new AbortController()
    defaultAbort.abort()

    expect(
      getQueryTerminalReason({ aborted: true, reason: 'user-cancel' }, false),
    ).toBe('user-abort')
    expect(
      getQueryTerminalReason({ aborted: true, reason: 'interrupt' }, false),
    ).toBe('user-abort')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: defaultAbort.signal.reason },
        false,
      ),
    ).toBe('user-abort')
  })

  test('groups background and side-task aborts under parent-ended', () => {
    expect(
      getQueryTerminalReason({ aborted: true, reason: 'background' }, false),
    ).toBe('parent-ended')
    expect(
      getQueryTerminalReason({ aborted: true, reason: 'parent-ended' }, false),
    ).toBe('parent-ended')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: 'side-task-cancelled' },
        false,
      ),
    ).toBe('parent-ended')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: 'streaming_fallback' },
        false,
      ),
    ).toBe('parent-ended')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: 'agent-summary-superseded' },
        false,
      ),
    ).toBe('parent-ended')
    expect(
      getQueryTerminalReason(
        { aborted: true, reason: 'memory-extraction-superseded' },
        false,
      ),
    ).toBe('parent-ended')
  })
})
