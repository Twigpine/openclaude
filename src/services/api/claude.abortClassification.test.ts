import { describe, expect, test } from 'bun:test'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { shouldCreateUserInterruptionMessage } from '../../utils/abortReasons.js'
import {
  getClaudeExpectedSideTaskApiAbortLogMessage,
  getClaudeStreamingAbortLogMessage,
} from './claude.js'
import { CannotRetryError } from './withRetry.js'

describe('Claude stream abort classification wiring', () => {
  test('formats timeout abort logs as timeout aborts, not user aborts', () => {
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'query-timeout' },
        new Error('Request was aborted.'),
      ),
    ).toBe('Streaming aborted by query timeout: Request was aborted.')
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'hard_max' },
        new Error('Request was aborted.'),
      ),
    ).toBe('Streaming aborted by query hard timeout: Request was aborted.')
    expect(shouldCreateUserInterruptionMessage('query-timeout')).toBe(false)
    expect(shouldCreateUserInterruptionMessage('hard_max')).toBe(false)
  })

  test('formats non-timeout abort logs by their normalized stream reason', () => {
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'background' },
        new Error('Request was aborted.'),
      ),
    ).toBe('Streaming aborted for backgrounding: Request was aborted.')
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'streaming_fallback' },
        new Error('Request was aborted.'),
      ),
    ).toBe(
      'Streaming aborted because side task was cancelled: Request was aborted.',
    )
    expect(shouldCreateUserInterruptionMessage('background')).toBe(false)
    expect(shouldCreateUserInterruptionMessage('streaming_fallback')).toBe(
      false,
    )
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'agent-summary-superseded' },
        new Error('Request was aborted.'),
      ),
    ).toBe(
      'Streaming aborted because agent summary was superseded: Request was aborted.',
    )
    expect(
      getClaudeStreamingAbortLogMessage(
        { reason: 'memory-extraction-superseded' },
        new Error('Request was aborted.'),
      ),
    ).toBe(
      'Streaming aborted because memory extraction was superseded: Request was aborted.',
    )
    expect(shouldCreateUserInterruptionMessage('agent-summary-superseded')).toBe(
      false,
    )
    expect(
      shouldCreateUserInterruptionMessage('memory-extraction-superseded'),
    ).toBe(false)
  })

  test('keeps actual user aborts user-facing for stream logs and advisor gating', () => {
    const defaultAbort = new AbortController()
    defaultAbort.abort()

    expect(
      getClaudeStreamingAbortLogMessage(
        defaultAbort.signal,
        new Error('Request was aborted.'),
      ),
    ).toBe('Streaming aborted by user: Request was aborted.')
    expect(shouldCreateUserInterruptionMessage(defaultAbort.signal.reason)).toBe(
      true,
    )
  })

  test('does not infer user intent from an external AbortError while root is active', () => {
    const activeRoot = new AbortController()
    const externalAbort = new APIUserAbortError()

    expect(activeRoot.signal.aborted).toBe(false)
    expect(shouldCreateUserInterruptionMessage(activeRoot.signal.reason)).toBe(
      false,
    )
    expect(
      getClaudeStreamingAbortLogMessage(activeRoot.signal, externalAbort),
    ).toBe('Streaming aborted by parent signal: Request was aborted.')
  })

  test('labels expected side-task retry aborts without reclassifying user aborts', () => {
    const expectedAbort = new AbortController()
    expectedAbort.abort('agent-summary-superseded')
    const retryAbort = new CannotRetryError(new APIUserAbortError(), {
      model: 'test-model',
      thinkingConfig: { type: 'disabled' },
    })

    expect(
      getClaudeExpectedSideTaskApiAbortLogMessage(
        expectedAbort.signal,
        retryAbort,
      ),
    ).toBe(
      'Expected side-task API abort (agent-summary-superseded): Request was aborted.',
    )

    const userAbort = new AbortController()
    userAbort.abort()
    expect(
      getClaudeExpectedSideTaskApiAbortLogMessage(
        userAbort.signal,
        new APIUserAbortError(),
      ),
    ).toBeNull()
    expect(
      getClaudeExpectedSideTaskApiAbortLogMessage(
        expectedAbort.signal,
        new Error('boom'),
      ),
    ).toBeNull()
  })
})
