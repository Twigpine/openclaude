import { describe, expect, test } from 'bun:test'
import { CannotRetryError } from './withRetry.js'
import {
  classifyFailoverTrigger,
  DEFAULT_FAILOVER_TTFT_THRESHOLD_MS,
  isUserAbort,
  resolveFailoverDecision,
} from './modelFailover.js'

function apiError(message = 'API error 500'): Error {
  return new CannotRetryError(new Error(message), {
    model: 'model-a',
    thinkingConfig: { type: 'disabled' },
  })
}

describe('isUserAbort', () => {
  test('recognizes AbortError', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(isUserAbort(error)).toBe(true)
  })

  test('recognizes ABORT_ERR code', () => {
    const error = new Error('aborted') as NodeJS.ErrnoException
    error.code = 'ABORT_ERR'
    expect(isUserAbort(error)).toBe(true)
  })

  test('does not match plain errors', () => {
    expect(isUserAbort(apiError())).toBe(false)
  })

  test('does not match non-errors', () => {
    expect(isUserAbort('string error')).toBe(false)
  })
})

describe('classifyFailoverTrigger', () => {
  test('null for user aborts', () => {
    const error = new Error('aborted')
    error.name = 'AbortError'
    expect(classifyFailoverTrigger(error)).toBeNull()
  })

  test('streamIdleAborted marker wins', () => {
    const error = new Error('Stream idle timeout - no chunks received')
    ;(error as unknown as Record<string, unknown>).streamIdleAborted = true
    expect(classifyFailoverTrigger(error)).toBe('stream-idle-timeout')
  })

  test('slow ttft marker', () => {
    const error = new Error('slow')
    ;(error as unknown as Record<string, unknown>).failoverSlowTtftMs = 45_000
    expect(classifyFailoverTrigger(error)).toBe('slow-ttft')
  })

  test('non-finite ttft marker is ignored', () => {
    const error = new Error('bad ttft')
    ;(error as unknown as Record<string, unknown>).failoverSlowTtftMs = Number.NaN
    expect(classifyFailoverTrigger(error)).toBeNull()
  })

  test('CannotRetryError maps to retries-exhausted', () => {
    expect(classifyFailoverTrigger(apiError())).toBe('retries-exhausted')
  })

  test('plain errors are not triggers', () => {
    expect(classifyFailoverTrigger(new Error('unexpected token'))).toBeNull()
  })

  test('non-Error values are not triggers', () => {
    expect(classifyFailoverTrigger(undefined)).toBeNull()
  })
})

function baseContext(overrides?: Partial<Parameters<typeof resolveFailoverDecision>[1]>) {
  return {
    currentModel: 'model-a',
    alreadyTried: [] as string[],
    failoverCount: 0,
    autoModelFailover: true,
    candidates: ['model-b', 'model-c'],
    ...overrides,
  }
}

describe('resolveFailoverDecision', () => {
  test('declines when feature is off', () => {
    const decision = resolveFailoverDecision(apiError(), baseContext({ autoModelFailover: false }))
    expect(decision.shouldFailover).toBe(false)
  })

  test('declines when feature is unset (default off)', () => {
    const decision = resolveFailoverDecision(apiError(), baseContext({ autoModelFailover: undefined }))
    expect(decision.shouldFailover).toBe(false)
  })

  test('declines non-trigger errors even when enabled', () => {
    const decision = resolveFailoverDecision(new Error('parse error'), baseContext())
    expect(decision.shouldFailover).toBe(false)
  })

  test('declines when per-turn limit reached', () => {
    const decision = resolveFailoverDecision(apiError(), baseContext({ failoverCount: 1 }))
    expect(decision.shouldFailover).toBe(false)
    expect(decision.message).toContain('failover limit reached')
  })

  test('honors custom max per turn', () => {
    const error = apiError()
    const first = resolveFailoverDecision(
      error,
      baseContext({ failoverCount: 1, failoverMaxPerTurn: 2 }),
    )
    expect(first.shouldFailover).toBe(true)
    expect(first.nextModel).toBe('model-b')
  })

  test('declines on aborted signal', () => {
    const controller = new AbortController()
    controller.abort()
    const decision = resolveFailoverDecision(
      apiError(),
      baseContext({ signal: controller.signal }),
    )
    expect(decision.shouldFailover).toBe(false)
  })

  test('declines with no candidates', () => {
    const decision = resolveFailoverDecision(apiError(), baseContext({ candidates: [] }))
    expect(decision.shouldFailover).toBe(false)
  })

  test('declines when only candidate is the failing model', () => {
    const decision = resolveFailoverDecision(
      apiError(),
      baseContext({ candidates: ['model-a'] }),
    )
    expect(decision.shouldFailover).toBe(false)
  })

  test('skips already-tried models', () => {
    const decision = resolveFailoverDecision(
      apiError(),
      baseContext({ alreadyTried: ['model-b'] }),
    )
    expect(decision.shouldFailover).toBe(true)
    expect(decision.nextModel).toBe('model-c')
  })

  test('picks first candidate on happy path', () => {
    const decision = resolveFailoverDecision(apiError(), baseContext())
    expect(decision.shouldFailover).toBe(true)
    expect(decision.reason).toBe('retries-exhausted')
    expect(decision.nextModel).toBe('model-b')
  })

  test('reports ttft in the message for slow-ttft', () => {
    const error = new Error('slow')
    ;(error as unknown as Record<string, unknown>).failoverSlowTtftMs = 45_000
    const decision = resolveFailoverDecision(error, baseContext())
    expect(decision.shouldFailover).toBe(true)
    expect(decision.reason).toBe('slow-ttft')
    expect(decision.message).toContain('45s')
  })

  test('reports stream idle reason', () => {
    const error = new Error('Stream idle timeout')
    ;(error as unknown as Record<string, unknown>).streamIdleAborted = true
    const decision = resolveFailoverDecision(error, baseContext())
    expect(decision.shouldFailover).toBe(true)
    expect(decision.reason).toBe('stream-idle-timeout')
  })

  test('default ttft threshold is 30 seconds', () => {
    expect(DEFAULT_FAILOVER_TTFT_THRESHOLD_MS).toBe(30_000)
  })
})
