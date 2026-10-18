import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from '../utils/interruptionTrace.js'
import {
  abortPrintModeControlRequest,
  type PrintModeControlAbortSource,
} from './printInterruption.js'

const originalInterruptionTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE
let hasSharedMutationLock = false

beforeEach(async () => {
  await acquireSharedMutationLock('cli/print.interruptionTrace.test.ts')
  hasSharedMutationLock = true
})

afterEach(async () => {
  try {
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    if (originalInterruptionTrace === undefined) {
      delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    } else {
      process.env.OPENCLAUDE_INTERRUPT_TRACE = originalInterruptionTrace
    }
  } finally {
    if (hasSharedMutationLock) {
      releaseSharedMutationLock()
      hasSharedMutationLock = false
    }
  }
})

describe('print-mode interruption tracing', () => {
  test.each([
    ['sdk_control_interrupt', 'interrupt'],
    ['sdk_end_session', undefined],
  ] as const)(
    'links %s input to the query and speculation aborts',
    (source: PrintModeControlAbortSource, queryReason: unknown) => {
      process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
      __resetInterruptionTraceForTests()
      const queryController = new AbortController()
      const suggestionController = new AbortController()

      const causalEventId = abortPrintModeControlRequest(
        queryController,
        suggestionController,
        source,
        queryReason,
      )

      expect(queryController.signal.aborted).toBe(true)
      expect(suggestionController.signal.aborted).toBe(true)
      const trace = __getInterruptionTraceSnapshotForTests()
      expect(trace.find(entry => entry.eventId === causalEventId)).toMatchObject({
        event: `input.${source}`,
        source,
        subsystem: 'print_mode',
      })
      expect(
        trace.find(
          entry =>
            entry.event === 'abort.requested' &&
            entry.controllerRole === 'query-root',
        ),
      ).toMatchObject({ source, causalEventId, subsystem: 'print_mode' })
      expect(
        trace.find(
          entry =>
            entry.event === 'abort.requested' &&
            entry.controllerRole === 'speculation',
        ),
      ).toMatchObject({
        source,
        causalEventId,
        subsystem: 'prompt_suggestion',
      })
    },
  )

  test('preserves native abort behavior when tracing is disabled', () => {
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    __resetInterruptionTraceForTests()
    const queryController = new AbortController()
    const suggestionController = new AbortController()

    const causalEventId = abortPrintModeControlRequest(
      queryController,
      suggestionController,
      'sdk_control_interrupt',
      'interrupt',
    )

    expect(causalEventId).toBeUndefined()
    expect(queryController.signal.reason).toBe('interrupt')
    expect(suggestionController.signal.reason).toBeInstanceOf(DOMException)
    expect(suggestionController.signal.reason.name).toBe('AbortError')
    expect(__getInterruptionTraceSnapshotForTests()).toEqual([])
  })
})
