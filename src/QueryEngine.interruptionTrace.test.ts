import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from './test/sharedMutationLock.js'
import { QueryEngine } from './QueryEngine.js'
import {
  __getInterruptionTraceSnapshotForTests,
  __resetInterruptionTraceForTests,
  __waitForInterruptionTraceFlushForTests,
  registerInterruptionController,
} from './utils/interruptionTrace.js'

const originalTrace = process.env.OPENCLAUDE_INTERRUPT_TRACE

beforeEach(async () => {
  await acquireSharedMutationLock('QueryEngine.interruptionTrace.test.ts')
})

afterEach(async () => {
  try {
    await __waitForInterruptionTraceFlushForTests()
    __resetInterruptionTraceForTests()
    if (originalTrace === undefined) delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    else process.env.OPENCLAUDE_INTERRUPT_TRACE = originalTrace
  } finally {
    releaseSharedMutationLock()
  }
})

describe('QueryEngine interruption tracing', () => {
  test('does not record lifecycle entries while tracing is disabled', async () => {
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    const engine = Object.create(QueryEngine.prototype) as QueryEngine
    const controller = new AbortController()
    ;(engine as unknown as { abortController: AbortController }).abortController =
      controller
    ;(engine as unknown as {
      submitMessageImpl(): AsyncGenerator<never, void, unknown>
    }).submitMessageImpl = async function* () {}

    for await (const _message of engine.submitMessage('hello')) {
      // The stub deliberately yields nothing.
    }

    expect(__getInterruptionTraceSnapshotForTests()).toEqual([])
  })

  test('records a programmatic query-root interruption before aborting', () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const controller = new AbortController()
    const engine = Object.create(QueryEngine.prototype) as QueryEngine
    ;(engine as unknown as {
      abortController: AbortController
    }).abortController = controller

    engine.interrupt('sdk_interrupt')

    const requested = __getInterruptionTraceSnapshotForTests().find(
      entry => entry.event === 'abort.requested',
    )
    expect(controller.signal.aborted).toBe(true)
    expect(requested).toMatchObject({
      source: 'sdk_interrupt',
      subsystem: 'query_engine',
      controllerRole: 'query-root',
    })
  })

  test('records start and terminal lifecycle for successful SDK turns', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    const engine = Object.create(QueryEngine.prototype) as QueryEngine
    const controller = new AbortController()
    ;(engine as unknown as { abortController: AbortController }).abortController =
      controller
    ;(engine as unknown as {
      submitMessageImpl(): AsyncGenerator<never, void, unknown>
    }).submitMessageImpl = async function* () {}

    for await (const _message of engine.submitMessage('hello')) {
      // The stub deliberately yields nothing.
    }

    const trace = __getInterruptionTraceSnapshotForTests()
    const started = trace.find(entry => entry.event === 'query.started')
    const terminal = trace.find(entry => entry.event === 'query.terminal')
    expect(started).toMatchObject({
      subsystem: 'query_engine',
      querySource: 'sdk',
      controllerRole: 'query-root',
    })
    expect(terminal).toMatchObject({
      subsystem: 'query_engine',
      queryId: started?.queryId,
      outcome: 'completed',
    })
    expect(typeof started?.eventId).toBe('string')
    expect(typeof terminal?.causalEventId).toBe('string')
    expect(terminal!.causalEventId).toBe(started!.eventId)
  })

  test('records aborted and failed SDK turn terminals', async () => {
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'

    for (const scenario of ['aborted', 'failed'] as const) {
      __resetInterruptionTraceForTests()
      const engine = Object.create(QueryEngine.prototype) as QueryEngine
      const controller = new AbortController()
      ;(engine as unknown as { abortController: AbortController }).abortController =
        controller
      ;(engine as unknown as {
        submitMessageImpl(): AsyncGenerator<never, void, unknown>
      }).submitMessageImpl = async function* () {
        if (scenario === 'aborted') {
          controller.abort('interrupt')
          return
        }
        throw new Error('turn failed')
      }

      const drain = async () => {
        for await (const _message of engine.submitMessage('hello')) {
          // The stub deliberately yields nothing.
        }
      }
      if (scenario === 'failed') await expect(drain()).rejects.toThrow('turn failed')
      else await drain()

      const trace = __getInterruptionTraceSnapshotForTests()
      const started = trace.find(entry => entry.event === 'query.started')
      const terminal = trace.find(entry => entry.event === 'query.terminal')
      expect(terminal?.outcome).toBe(scenario)
      expect(typeof started?.eventId).toBe('string')
      expect(typeof terminal?.eventId).toBe('string')
      if (scenario === 'aborted') {
        const observed = trace.find(
          entry => entry.event === 'signal.observed',
        )
        expect(typeof observed?.eventId).toBe('string')
        expect(terminal?.causalEventId).toBe(observed!.eventId)
      } else {
        expect(terminal?.causalEventId).toBe(started!.eventId)
      }
    }
  })

  test('registers the query root when tracing is enabled at the turn boundary', async () => {
    delete process.env.OPENCLAUDE_INTERRUPT_TRACE
    const engine = Object.create(QueryEngine.prototype) as QueryEngine
    const controller = new AbortController()
    ;(engine as unknown as { abortController: AbortController }).abortController =
      controller
    registerInterruptionController(controller, {
      subsystem: 'query_engine',
      controllerRole: 'query-root',
    })
    process.env.OPENCLAUDE_INTERRUPT_TRACE = '1'
    ;(engine as unknown as {
      submitMessageImpl(): AsyncGenerator<never, void, unknown>
    }).submitMessageImpl = async function* () {
      controller.abort()
    }

    for await (const _message of engine.submitMessage('hello')) {
      // The stub deliberately yields nothing.
    }

    const trace = __getInterruptionTraceSnapshotForTests()
    const registered = trace.find(
      entry =>
        entry.event === 'controller.registered' &&
        entry.controllerRole === 'query-root',
    )
    const observed = trace.find(entry => entry.event === 'signal.observed')
    const terminal = trace.find(entry => entry.event === 'query.terminal')
    expect(registered).toBeDefined()
    expect(typeof observed?.eventId).toBe('string')
    expect(terminal).toMatchObject({
      outcome: 'aborted',
      causalEventId: observed!.eventId,
    })
  })
})
