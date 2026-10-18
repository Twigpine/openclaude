import { afterEach, describe, test, expect, vi } from 'vitest'
import { DEFAULT_QUERY_HARD_MAX_MS, QueryGuard } from './QueryGuard.js'
import { QueryLifecycleOperationTracker } from './queryLifecycle.js'

describe('QueryGuard', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('starts idle', () => {
    const guard = new QueryGuard()
    expect(guard.isActive).toBe(false)
    expect(guard.generation).toBe(0)
  })

  test('tryStart transitions to running', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()
    expect(gen).toBe(1)
    expect(guard.isActive).toBe(true)
  })

  test('end returns to idle', () => {
    const guard = new QueryGuard()
    const gen = guard.tryStart()!
    expect(guard.end(gen)).toBe(true)
    expect(guard.isActive).toBe(false)
  })

  test('end rejects stale generation', () => {
    const guard = new QueryGuard()
    const gen1 = guard.tryStart()!
    guard.forceEnd()
    const gen2 = guard.tryStart()!
    expect(guard.end(gen1)).toBe(false)
    expect(guard.isActive).toBe(true)
    expect(guard.end(gen2)).toBe(true)
  })

  test('forceEnd always works', () => {
    const guard = new QueryGuard()
    guard.tryStart()
    guard.forceEnd()
    expect(guard.isActive).toBe(false)
  })

  test('idle timeout auto force-ends after 5 minutes without activity', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    guard.tryStart()
    expect(guard.isActive).toBe(true)

    vi.advanceTimersByTime(5 * 60 * 1000 - 1)
    expect(guard.isActive).toBe(true)

    vi.advanceTimersByTime(1)
    expect(guard.isActive).toBe(false)
  })

  test('updates the next query idle timeout without mutating an active query', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({ idleTimeoutMs: 100 })

    expect(guard.setIdleTimeoutMs(500)).toBe(true)
    const firstGeneration = guard.tryStart()!
    expect(guard.setIdleTimeoutMs(1_000)).toBe(false)
    vi.advanceTimersByTime(499)
    expect(guard.isActive).toBe(true)
    vi.advanceTimersByTime(1)
    expect(guard.isActive).toBe(false)

    expect(guard.setIdleTimeoutMs(1_000)).toBe(true)
    const secondGeneration = guard.tryStart()!
    expect(secondGeneration).toBeGreaterThan(firstGeneration)
    vi.advanceTimersByTime(999)
    expect(guard.isActive).toBe(true)
    vi.advanceTimersByTime(1)
    expect(guard.isActive).toBe(false)
  })

  test('timeout notifies owner with lifecycle context and timeout reason', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)

    const gen = guard.tryStart()!
    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen,
        reason: 'idle',
        timeoutMs: 5 * 60 * 1000,
        context: expect.objectContaining({
          queryGeneration: gen,
          terminalReason: 'query-timeout',
          abortReason: 'idle',
        }),
      }),
    )
    expect(guard.isActive).toBe(false)
  })

  test('tryStart accepts explicit query identity and returns lifecycle context', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({
      queryId: 'query-1',
      querySource: 'repl_main_thread',
      parentQueryId: 'parent-query',
      subagentId: 'agent-1',
      startedAt: 1234,
    })

    expect(start).toEqual({
      generation: 1,
      context: {
        queryId: 'query-1',
        queryGeneration: 1,
        querySource: 'repl_main_thread',
        parentQueryId: 'parent-query',
        subagentId: 'agent-1',
        startedAt: 1234,
      },
    })
    expect(guard.activeContext).toEqual(start!.context)
  })

  test('timeout callback receives explicit query identity and active operation snapshot', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const tracker = new QueryLifecycleOperationTracker()
    tracker.startApiCall({
      clientRequestId: 'client-request-1',
      requestId: 'server-request-1',
      model: 'model-name',
      querySource: 'repl_main_thread',
      startedAt: 10,
    })
    tracker.startToolUse({
      toolUseId: 'tool-use-1',
      toolName: 'Bash',
      startedAt: 20,
      isBash: true,
      timeoutMs: 120_000,
    })

    const guard = new QueryGuard()
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const start = guard.tryStart({
      queryId: 'query-1',
      querySource: 'repl_main_thread',
      startedAt: 1,
      getActiveOperations: () => tracker.snapshot(),
    })!

    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(onTimeout).toHaveBeenCalledWith({
      generation: start.generation,
      reason: 'idle',
      timeoutMs: 5 * 60 * 1000,
      elapsedMs: expect.any(Number),
      context: {
        ...start.context,
        terminalReason: 'query-timeout',
        abortReason: 'idle',
      },
      activeOperations: {
        apiCalls: [
          {
            clientRequestId: 'client-request-1',
            requestId: 'server-request-1',
            model: 'model-name',
            querySource: 'repl_main_thread',
            startedAt: 10,
          },
        ],
        toolUses: [
          {
            toolUseId: 'tool-use-1',
            toolName: 'Bash',
            startedAt: 20,
            isBash: true,
            timeoutMs: 120_000,
          },
        ],
      },
    })
    expect(guard.lastContext?.terminalReason).toBe('query-timeout')
    expect(guard.lastContext?.abortReason).toBe('idle')
  })

  test('timeout handler cleanup prevents stale notification', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard()
    const onTimeout = vi.fn()
    const cleanup = guard.setTimeoutHandler(onTimeout)
    cleanup()

    guard.tryStart()
    vi.advanceTimersByTime(5 * 60 * 1000)

    expect(onTimeout).not.toHaveBeenCalled()
    expect(guard.isActive).toBe(false)
  })

  test('timeout handler errors do not escape the watchdog callback', () => {
    vi.useFakeTimers()
    const guard = new QueryGuard()
    const handlerError = new Error('handler failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    guard.setTimeoutHandler(() => {
      throw handlerError
    })

    guard.tryStart()

    expect(() => vi.advanceTimersByTime(5 * 60 * 1000)).not.toThrow()
    expect(guard.isActive).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[QueryGuard] Timeout handler failed',
      handlerError,
    )
  })

  test('API stream activity extends the idle deadline only while progress continues', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    const gen = guard.tryStart()!

    vi.advanceTimersByTime(90)
    guard.registerActivity('api_stream', gen)
    vi.advanceTimersByTime(99)
    expect(guard.isActive).toBe(true)

    vi.advanceTimersByTime(1)
    expect(guard.isActive).toBe(false)
  })

  test('query aborts when idle timeout is reached with no activity', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    guard.tryStart()

    vi.advanceTimersByTime(100)

    expect(guard.isActive).toBe(false)
  })

  test('forward wall-clock jumps do not trigger an immediate timeout', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const baseline = new Date('2026-08-10T00:00:00.000Z').getTime()
    let nowMs = baseline
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const generation = guard.tryStart()!

    nowMs = baseline + 60 * 60 * 1_000
    guard.registerActivity('clock-jump-probe', generation)
    vi.advanceTimersByTime(99)

    expect(onTimeout).not.toHaveBeenCalled()
    expect(guard.isActive).toBe(true)

    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idle', elapsedMs: 100 }),
    )
  })

  test('backward wall-clock jumps do not delay the scheduled timeout', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const baseline = new Date('2026-08-10T00:00:00.000Z').getTime()
    let nowMs = baseline
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    guard.tryStart()

    nowMs = baseline - 60 * 60 * 1_000
    vi.advanceTimersByTime(100)

    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idle', elapsedMs: 100 }),
    )
    expect(guard.isActive).toBe(false)
  })

  test('active bounded lease is not aborted merely because idle timeout elapses', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const gen = guard.tryStart()!
    const lease = guard.acquireLease(
      {
        owner: 'bash',
        id: 'toolu_1',
        timeoutMs: 500,
      },
      gen,
    )

    vi.advanceTimersByTime(500)

    expect(guard.isActive).toBe(true)
    lease.release()
    expect(guard.end(gen)).toBe(true)
  })

  test('lease deadline aborts bounded work that exceeds its own timeout', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!
    guard.acquireLease(
      {
        owner: 'bash',
        id: 'toolu_1',
        timeoutMs: 500,
      },
      gen,
    )

    vi.advanceTimersByTime(509)
    expect(guard.isActive).toBe(true)
    vi.advanceTimersByTime(1)

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen,
        reason: 'lease_expired',
        timeoutMs: 510,
        context: expect.objectContaining({
          terminalReason: 'query-timeout',
          abortReason: 'lease_expired',
        }),
      }),
    )
  })

  test('hard maximum aborts even with active leases and activity', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!
    guard.acquireLease(
      {
        owner: 'bash',
        id: 'toolu_1',
        timeoutMs: 5_000,
      },
      gen,
    )

    for (let elapsed = 0; elapsed < 900; elapsed += 90) {
      vi.advanceTimersByTime(90)
      guard.registerActivity('api_stream', gen)
      expect(guard.isActive).toBe(true)
    }

    vi.advanceTimersByTime(100)

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen,
        reason: 'hard_max',
        timeoutMs: 1_000,
        context: expect.objectContaining({
          terminalReason: 'hard-max-query-timeout',
          abortReason: 'hard_max',
        }),
      }),
    )
  })

  test('larger hard maximum does not abort at the default hard max boundary', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const configuredHardMaxMs = DEFAULT_QUERY_HARD_MAX_MS + 1_000
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: configuredHardMaxMs,
      toolLeaseGraceMs: 0,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!
    guard.acquireLease(
      {
        owner: 'api',
        id: 'stream',
        timeoutMs: configuredHardMaxMs,
      },
      gen,
    )

    vi.advanceTimersByTime(DEFAULT_QUERY_HARD_MAX_MS)

    expect(guard.isActive).toBe(true)
    expect(onTimeout).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen,
        reason: 'hard_max',
        timeoutMs: configuredHardMaxMs,
        context: expect.objectContaining({
          terminalReason: 'hard-max-query-timeout',
          abortReason: 'hard_max',
        }),
      }),
    )
  })

  test('lease hard cap is relative to acquisition and capped by query remaining budget', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 500,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)
    const gen = guard.tryStart()!

    vi.advanceTimersByTime(400)
    guard.acquireLease(
      {
        owner: 'tool',
        id: 'toolu_late',
        timeoutMs: 500,
        hardCapMs: 300,
      },
      gen,
    )

    vi.advanceTimersByTime(299)
    expect(guard.isActive).toBe(true)
    vi.advanceTimersByTime(1)

    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen,
        reason: 'lease_expired',
        timeoutMs: 300,
      }),
    )
  })

  test('stale generations cannot extend or release a newer query', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = new QueryGuard({
      idleTimeoutMs: 100,
      hardMaxQueryMs: 1_000,
      toolLeaseGraceMs: 10,
    })
    const onTimeout = vi.fn()
    guard.setTimeoutHandler(onTimeout)

    const gen1 = guard.tryStart()!
    const staleLease = guard.acquireLease(
      {
        owner: 'bash',
        id: 'toolu_stale',
        timeoutMs: 500,
      },
      gen1,
    )
    guard.forceEnd()

    const gen2 = guard.tryStart()!
    const liveLease = guard.acquireLease(
      {
        owner: 'bash',
        id: 'toolu_live',
        timeoutMs: 500,
      },
      gen2,
    )

    staleLease.release()
    vi.advanceTimersByTime(100)
    expect(guard.isActive).toBe(true)

    liveLease.release()
    guard.registerActivity('stale_api_stream', gen1)
    vi.advanceTimersByTime(100)
    expect(guard.isActive).toBe(false)
    expect(onTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: gen2,
        reason: 'idle',
      }),
    )
  })

  test('end stamps terminal reason on the completed lifecycle context', () => {
    const guard = new QueryGuard()
    const start = guard.tryStart({
      queryId: 'query-1',
      querySource: 'repl_main_thread',
    })!

    expect(guard.end(start.generation, 'user-abort')).toBe(true)
    expect(guard.lastContext).toEqual({
      ...start.context,
      terminalReason: 'user-abort',
    })
  })

  test('query metadata from one start does not leak into the next start', () => {
    const guard = new QueryGuard()
    const child = guard.tryStart({
      queryId: 'child-query',
      querySource: 'agent:general-purpose',
      parentQueryId: 'parent-query',
      subagentId: 'agent-1',
    })!
    expect(guard.end(child.generation, 'ok')).toBe(true)

    const parent = guard.tryStart({
      queryId: 'parent-query',
      querySource: 'repl_main_thread',
    })!

    expect(parent.context.parentQueryId).toBeUndefined()
    expect(parent.context.subagentId).toBeUndefined()
    expect(parent.context.queryId).toBe('parent-query')
  })

  test('timeout is cleared when end() is called normally', () => {
    vi.useFakeTimers()
    const guard = new QueryGuard()
    const gen = guard.tryStart()!
    guard.end(gen)

    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(guard.isActive).toBe(false)

    const gen2 = guard.tryStart()
    expect(gen2).not.toBeNull()
    expect(guard.isActive).toBe(true)

    guard.forceEnd()
  })

  describe('beginUserInteraction (human-wait suspension)', () => {
    test('idle timeout does not fire while suspended', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 1_000 })
      guard.tryStart()

      const resume = guard.beginUserInteraction()
      // Well past the idle timeout, but the user is still deciding.
      vi.advanceTimersByTime(100_000)
      expect(guard.isActive).toBe(true)

      resume()
      // Idle window restarts fresh from resume.
      vi.advanceTimersByTime(99)
      expect(guard.isActive).toBe(true)
      vi.advanceTimersByTime(1)
      expect(guard.isActive).toBe(false)
    })

    test('hard-max deadline is shifted forward by the paused duration', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 1_000,
      })
      guard.tryStart()

      vi.advanceTimersByTime(500)
      const resume = guard.beginUserInteraction()
      vi.advanceTimersByTime(5_000) // human think-time, excluded from budget
      resume()

      // 500ms of the 1000ms hard-max was spent before the pause; 500ms remain.
      vi.advanceTimersByTime(499)
      expect(guard.isActive).toBe(true)
      vi.advanceTimersByTime(1)
      expect(guard.isActive).toBe(false)
    })

    test('lease deadlines continue while suspended', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 10_000,
        toolLeaseGraceMs: 1,
      })
      const onTimeout = vi.fn()
      guard.setTimeoutHandler(onTimeout)
      guard.tryStart()
      guard.acquireLease({ owner: 'tool', id: 'slow-read', timeoutMs: 100 })

      guard.beginUserInteraction()
      vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(true)
      vi.advanceTimersByTime(1)

      expect(guard.isActive).toBe(false)
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'lease_expired' }),
      )
    })

    test('lease hard cap acquired during suspension excludes human wait', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({
        idleTimeoutMs: 10_000,
        hardMaxQueryMs: 1_000,
      })
      const onTimeout = vi.fn()
      guard.setTimeoutHandler(onTimeout)
      guard.tryStart()

      vi.advanceTimersByTime(900)
      guard.beginUserInteraction()
      vi.advanceTimersByTime(5_000)
      guard.acquireLease({ owner: 'tool', id: 'during-prompt' })

      vi.advanceTimersByTime(99)
      expect(guard.isActive).toBe(true)
      vi.advanceTimersByTime(1)

      expect(guard.isActive).toBe(false)
      expect(onTimeout).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'lease_expired' }),
      )
    })

    test('reference counts nested interactions', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      guard.tryStart()

      const resumeA = guard.beginUserInteraction()
      const resumeB = guard.beginUserInteraction()
      vi.advanceTimersByTime(1_000)
      resumeA()
      // Still suspended by B — watchdog stays frozen.
      vi.advanceTimersByTime(1_000)
      expect(guard.isActive).toBe(true)

      resumeB()
      vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })

    test('repeated resume calls are ignored', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      guard.tryStart()

      const resume = guard.beginUserInteraction()
      resume()
      resume() // no-op, must not underflow the suspend counter

      const resume2 = guard.beginUserInteraction()
      vi.advanceTimersByTime(1_000)
      expect(guard.isActive).toBe(true)
      resume2()
      vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })

    test('suspending a stale generation is a no-op', () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const guard = new QueryGuard({ idleTimeoutMs: 100, hardMaxQueryMs: 10_000 })
      const gen1 = guard.tryStart()!
      guard.forceEnd()
      guard.tryStart()

      // Resume tied to the old generation must not affect the current query.
      const staleResume = guard.beginUserInteraction(gen1)
      staleResume()

      vi.advanceTimersByTime(100)
      expect(guard.isActive).toBe(false)
    })
  })
})

describe('QueryLifecycleOperationTracker', () => {
  test('tracks and cleans up active API and tool operations', () => {
    const tracker = new QueryLifecycleOperationTracker()
    const apiKey = tracker.startApiCall({
      clientRequestId: 'client-request-1',
      model: 'model-name',
      querySource: 'repl_main_thread',
      startedAt: 100,
    })
    tracker.updateApiCall(apiKey, { requestId: 'server-request-1' })
    tracker.startToolUse({
      toolUseId: 'tool-use-1',
      toolName: 'Bash',
      startedAt: 200,
      isBash: true,
      timeoutMs: 300_000,
    })

    expect(tracker.snapshot()).toEqual({
      apiCalls: [
        {
          clientRequestId: 'client-request-1',
          requestId: 'server-request-1',
          model: 'model-name',
          querySource: 'repl_main_thread',
          startedAt: 100,
        },
      ],
      toolUses: [
        {
          toolUseId: 'tool-use-1',
          toolName: 'Bash',
          startedAt: 200,
          isBash: true,
          timeoutMs: 300_000,
        },
      ],
    })

    tracker.endApiCall(apiKey)
    tracker.endToolUse('tool-use-1')

    expect(tracker.snapshot()).toEqual({ apiCalls: [], toolUses: [] })
  })

  test('snapshots contain only safe operation metadata', () => {
    const tracker = new QueryLifecycleOperationTracker()
    const apiKey = tracker.startApiCall({
      clientRequestId: 'client-request-1',
      model: 'model-name',
      querySource: 'repl_main_thread',
      startedAt: 1,
      prompt: 'tool output',
      apiKey: 'ANTHROPIC_API_KEY=secret',
    } as Parameters<QueryLifecycleOperationTracker['startApiCall']>[0])
    tracker.updateApiCall(apiKey, {
      requestId: 'server-request-1',
      cwd: '/home/user/project',
    } as Partial<Parameters<QueryLifecycleOperationTracker['startApiCall']>[0]>)
    tracker.updateApiCall(apiKey, {
      requestId: undefined,
      model: undefined,
      querySource: undefined,
      startedAt: undefined,
      cwd: '/home/user/project',
    } as Partial<Parameters<QueryLifecycleOperationTracker['startApiCall']>[0]>)
    tracker.startToolUse({
      toolUseId: 'tool-use-1',
      toolName: 'Bash',
      startedAt: 1,
      isBash: true,
      timeoutMs: 300_000,
      command: 'cat /home/user/project/.env',
      output: 'tool output',
    } as Parameters<QueryLifecycleOperationTracker['startToolUse']>[0])

    const snapshot = tracker.snapshot()

    expect(snapshot.apiCalls).toEqual([
      {
        clientRequestId: 'client-request-1',
        requestId: 'server-request-1',
        model: 'model-name',
        querySource: 'repl_main_thread',
        startedAt: 1,
      },
    ])
    expect(Object.keys(snapshot.toolUses[0]!)).toEqual([
      'toolUseId',
      'toolName',
      'startedAt',
      'isBash',
      'timeoutMs',
    ])
    expect(JSON.stringify(snapshot)).not.toContain('/home/')
    expect(JSON.stringify(snapshot)).not.toContain('ANTHROPIC_API_KEY')
    expect(JSON.stringify(snapshot)).not.toContain('tool output')
  })
})
