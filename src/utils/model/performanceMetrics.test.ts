import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import {
  recordPerformanceMetric,
  computeModelScores,
  getModelScore,
  getRateLimitCooldownUntil,
  clearPerformanceMetrics,
} from './performanceMetrics.js'

describe('performanceMetrics', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'perf-metrics-'))
    setClaudeConfigHomeDirForTesting(tempDir)
    clearPerformanceMetrics()
  })

  it('records metrics and computes scores', () => {
    recordPerformanceMetric({ model: 'gpt-4', outcome: 'success', latencyMs: 200 })
    recordPerformanceMetric({ model: 'gpt-4', outcome: 'success', latencyMs: 300 })
    recordPerformanceMetric({ model: 'gpt-4', outcome: 'failure', latencyMs: 500, errorCategory: 'timeout' })

    const scores = computeModelScores()
    expect(scores['gpt-4']).toBeDefined()
    expect(scores['gpt-4'].totalCalls).toBe(3)
    expect(scores['gpt-4'].successCount).toBe(2)
    expect(scores['gpt-4'].failureCount).toBe(1)
    expect(scores['gpt-4'].successRate).toBeCloseTo(0.667, 2)
    expect(scores['gpt-4'].avgLatencyMs).toBeCloseTo(333.33, 1)
  })

  it('returns 0 for unknown models', () => {
    expect(getModelScore('unknown-model')).toBe(0)
  })

  it('higher success rate yields higher score', () => {
    recordPerformanceMetric({ model: 'good-model', outcome: 'success', latencyMs: 100 })
    recordPerformanceMetric({ model: 'good-model', outcome: 'success', latencyMs: 100 })
    recordPerformanceMetric({ model: 'bad-model', outcome: 'failure', latencyMs: 1000, errorCategory: 'timeout' })

    const scores = computeModelScores()
    expect(scores['good-model'].score).toBeGreaterThan(scores['bad-model'].score)
  })

  it('clears all metrics', () => {
    recordPerformanceMetric({ model: 'test', outcome: 'success', latencyMs: 100 })
    clearPerformanceMetrics()
    expect(computeModelScores()).toEqual({})
  })

  it('returns cooldown for a rate-limited model', () => {
    const now = Date.now()
    recordPerformanceMetric({
      model: 'throttled',
      outcome: 'failure',
      latencyMs: 10,
      errorCategory: 'rate-limit',
      timestamp: now,
    })
    const cooldown = getRateLimitCooldownUntil('throttled', now)
    expect(cooldown).toBeDefined()
    expect(cooldown!).toBeGreaterThan(now)
  })

  it('resets cooldown after a success', () => {
    const now = Date.now()
    recordPerformanceMetric({
      model: 'recovered',
      outcome: 'failure',
      latencyMs: 10,
      errorCategory: 'rate-limit',
      timestamp: now - 5000,
    })
    recordPerformanceMetric({
      model: 'recovered',
      outcome: 'success',
      latencyMs: 100,
      timestamp: now,
    })
    const cooldown = getRateLimitCooldownUntil('recovered', now)
    expect(cooldown).toBeUndefined()
  })

  it('returns undefined when no rate-limit record exists', () => {
    recordPerformanceMetric({
      model: 'clean',
      outcome: 'success',
      latencyMs: 100,
    })
    expect(getRateLimitCooldownUntil('clean')).toBeUndefined()
  })
})
