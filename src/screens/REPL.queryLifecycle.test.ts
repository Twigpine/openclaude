import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { InterruptionCorrectionTracker } from '../utils/interruptionCorrection.js'
import { QueryGuard } from '../utils/QueryGuard.js'
import { tryStartQueryWithConfiguredIdleTimeout } from '../utils/queryGuardConfig.js'

const source = readFileSync(join(import.meta.dirname, 'REPL.tsx'), 'utf8')

function getAbortTimedOutQueryBody(): string {
  const start = source.indexOf('const abortTimedOutQuery = useCallback')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('}, [mrOnTurnComplete, resetLoadingState])', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function getQueryFinallyBody(): string {
  const queryStart = source.indexOf('await onQueryImpl(')
  expect(queryStart).toBeGreaterThan(-1)
  const finallyStart = source.indexOf('} finally {', queryStart)
  expect(finallyStart).toBeGreaterThan(queryStart)
  const finallyEnd = source.indexOf('// Auto-restore:', finallyStart)
  expect(finallyEnd).toBeGreaterThan(finallyStart)
  return source.slice(finallyStart, finallyEnd)
}

function getOnQueryImplBody(): string {
  const start = source.indexOf('const onQueryImpl = useCallback')
  expect(start).toBeGreaterThan(-1)
  const end = source.indexOf('const onQuery = useCallback', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('REPL query lifecycle timeout logging', () => {
  test('wires the executable timeout boundary into the production query start', () => {
    expect(source).toContain('new QueryGuard(getQueryGuardOptionsFromEnv())')
    expect(source).toContain(
      'const startResult = tryStartQueryWithConfiguredIdleTimeout(queryGuard, {',
    )
  })

  test('applies the resolved timeout before starting the query', () => {
    const calls: string[] = []
    const guard = {
      setIdleTimeoutMs(timeoutMs: number) {
        calls.push(`set:${timeoutMs}`)
        return true
      },
      tryStart(metadata: { queryId: string; querySource: string }) {
        calls.push(`start:${metadata.queryId}`)
        return {
          generation: 1,
          context: {
            ...metadata,
            queryGeneration: 1,
            startedAt: 1,
          },
        }
      },
    }

    const result = tryStartQueryWithConfiguredIdleTimeout(
      guard,
      { queryId: 'query-1', querySource: 'repl_main_thread', startedAt: 1 },
      {},
      15 * 60 * 1000,
    )

    expect(result?.generation).toBe(1)
    expect(calls).toEqual(['set:900000', 'start:query-1'])
  })

  test('reapplies a runtime environment timeout before starting the query', () => {
    const calls: string[] = []
    const guard = {
      setIdleTimeoutMs(timeoutMs: number) {
        calls.push(`set:${timeoutMs}`)
        return true
      },
      tryStart() {
        calls.push('start')
        return null
      },
    }

    tryStartQueryWithConfiguredIdleTimeout(
      guard,
      { queryId: 'query-2', querySource: 'repl_main_thread' },
      { OPENCLAUDE_QUERY_IDLE_TIMEOUT_MS: '600000' },
      15 * 60 * 1000,
    )
    expect(calls).toEqual(['set:600000', 'start'])
  })

  test('clears interruption-correction state before resuming another session', () => {
    const switchSessionIndex = source.indexOf('switchSession(asSessionId(sessionId)')
    const sessionChangeIndex = source.indexOf(
      'interruptionCorrectionTracker.handleSessionChange()',
    )
    expect(switchSessionIndex).toBeGreaterThan(-1)
    expect(sessionChangeIndex).toBeGreaterThan(-1)
    expect(sessionChangeIndex).toBeLessThan(switchSessionIndex)
  })

  test('does not emit terminal timeout end from timeout handler', () => {
    const body = getAbortTimedOutQueryBody()
    const queueMicrotaskIndex = body.indexOf('queueMicrotask(() => {')
    expect(queueMicrotaskIndex).toBeGreaterThan(-1)

    const abortAcknowledgedIndex = body.indexOf(
      "logQueryLifecycle('abort_acknowledged'",
      queueMicrotaskIndex,
    )

    expect(abortAcknowledgedIndex).toBeGreaterThan(queueMicrotaskIndex)
    expect(body).not.toContain("logQueryLifecycle('end'")
  })

  test('emits timeout end from the query finally cleanup path', () => {
    const body = getQueryFinallyBody()

    expect(body).toContain('const guardCompletedContext = queryGuard.lastContext')
    expect(body).toContain("guardCompletedContext?.terminalReason === 'query-timeout'")
    expect(body).toContain("guardCompletedContext?.terminalReason === 'hard-max-query-timeout'")
    expect(body).toContain('guardCompletedContext.queryGeneration === thisGeneration')
    expect(body).toContain('logCompletedLifecycle(guardCompletedContext)')
  })

  test('keeps correction ownership through post-response tool work', () => {
    const impl = getOnQueryImplBody()
    const finallyBody = getQueryFinallyBody()

    expect(impl).not.toContain('onModelRequestEnd: interruptionCorrectionQueryId')
    expect(finallyBody).toContain(
      'interruptionCorrectionTracker.finishModelTurn(queryContext.queryId)',
    )
  })

  test('executes correction arming and consumption through QueryGuard', () => {
    const queryGuard = new QueryGuard()
    let sessionId = 'session-a'
    const tracker = new InterruptionCorrectionTracker(
      queryGuard,
      () => sessionId,
    )

    const localCommand = queryGuard.tryStart({
      queryId: 'local-command',
      querySource: 'repl_main_thread',
      startedAt: 1,
    })!
    tracker.bindModelTurn({
      shouldQuery: false,
      isInterruptionCorrectionEligible: true,
      queryId: localCommand.context.queryId,
    })
    tracker.handleCancellation({
      isUserInitiated: true,
      isRemoteMode: false,
    })
    queryGuard.forceEnd('user-abort', 'user-cancel')
    expect(tracker.takeReminder()).toBeNull()

    const modelTurn = queryGuard.tryStart({
      queryId: 'model-turn',
      querySource: 'repl_main_thread',
      startedAt: 2,
    })!
    tracker.bindModelTurn({
      shouldQuery: true,
      isInterruptionCorrectionEligible: true,
      queryId: modelTurn.context.queryId,
    })
    tracker.handleCancellation({
      isUserInitiated: true,
      isRemoteMode: false,
    })
    queryGuard.forceEnd('user-abort', 'user-cancel')

    expect(tracker.takeReminder()).toMatchObject({
      type: 'user',
      isMeta: true,
    })
    expect(tracker.takeReminder()).toBeNull()

    const sessionScopedTurn = queryGuard.tryStart({
      queryId: 'session-scoped-turn',
      querySource: 'repl_main_thread',
      startedAt: 3,
    })!
    tracker.bindModelTurn({
      shouldQuery: true,
      isInterruptionCorrectionEligible: true,
      queryId: sessionScopedTurn.context.queryId,
    })
    tracker.handleCancellation({
      isUserInitiated: true,
      isRemoteMode: false,
    })
    queryGuard.forceEnd('user-abort', 'user-cancel')

    sessionId = 'session-b'
    expect(tracker.takeReminder()).toBeNull()
  })

  test('does not arm when the model turn is marked ineligible', async () => {
    const queryGuard = new QueryGuard()
    const tracker = new InterruptionCorrectionTracker(
      queryGuard,
      () => 'session-a',
    )
    const modelTurn = queryGuard.tryStart({
      queryId: 'remote-origin-turn',
      querySource: 'repl_main_thread',
      startedAt: 1,
    })!

    await tracker.runModelTurn({
      shouldQuery: true,
      isInterruptionCorrectionEligible: false,
      queryId: modelTurn.context.queryId,
      run: async () => {
        tracker.handleCancellation({
          isUserInitiated: true,
          isRemoteMode: false,
        })
        queryGuard.forceEnd('user-abort', 'user-cancel')
      },
    })

    expect(tracker.takeReminder()).toBeNull()
  })

})
