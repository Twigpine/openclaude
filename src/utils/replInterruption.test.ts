import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
} from './interruptionTrace.js'
import {
  requestBackgroundHandoffAbort,
  requestBridgeInterrupt,
  requestPriorityNowAbort,
} from './replInterruption.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
})

afterEach(async () => {
  await __waitForInterruptionTraceFlushForTests()
  __resetInterruptionTraceForTests()
  if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
  else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
})

describe('REPL interruption source wiring', () => {
  test('bridge interruption reads the current controller and links its input event', () => {
    const stale = new AbortController()
    const current = new AbortController()
    const ref = { current: stale }
    ref.current = current

    requestBridgeInterrupt(ref)

    expect(stale.signal.aborted).toBe(false)
    expect(current.signal.aborted).toBe(true)
    const trace = __getInterruptionTraceSnapshotForTests()
    const input = trace.find(entry => entry.event === 'input.bridge_interrupt')
    const abort = trace.find(entry => entry.event === 'abort.requested')
    expect(abort?.source).toBe('bridge_interrupt')
    expect(input).toBeDefined()
    expect(abort).toBeDefined()
    expect(typeof input!.eventId).toBe('string')
    expect(typeof abort!.causalEventId).toBe('string')
    expect(abort!.causalEventId).toBe(input!.eventId)
  })

  test('background handoff aborts the foreground query with its source', () => {
    const controller = new AbortController()

    requestBackgroundHandoffAbort(controller)

    expect(controller.signal.reason).toBe('background')
    expect(
      __getInterruptionTraceSnapshotForTests().find(
        entry => entry.event === 'abort.requested',
      )?.source,
    ).toBe('background_handoff')
  })

  test('priority-now reads and aborts the current query controller', () => {
    const stale = new AbortController()
    const current = new AbortController()
    const ref = { current: stale }
    ref.current = current

    requestPriorityNowAbort(ref)

    expect(stale.signal.aborted).toBe(false)
    expect(current.signal.reason).toBe('interrupt')
    expect(
      __getInterruptionTraceSnapshotForTests().find(
        entry => entry.event === 'abort.requested',
      )?.source,
    ).toBe('priority_now')
  })
})
