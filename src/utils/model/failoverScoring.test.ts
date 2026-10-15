import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import {
  scoreFailoverCandidates,
  pickBestCandidate,
} from './failoverScoring.js'
import { clearPerformanceMetrics, recordPerformanceMetric } from './performanceMetrics.js'

describe('failoverScoring', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'failover-scoring-'))
    setClaudeConfigHomeDirForTesting(tempDir)
    clearPerformanceMetrics()
  })

  it('ranks available models with metrics above those without', () => {
    recordPerformanceMetric({ model: 'good-model', outcome: 'success', latencyMs: 100 })
    recordPerformanceMetric({ model: 'good-model', outcome: 'success', latencyMs: 100 })

    const scored = scoreFailoverCandidates({
      candidates: ['good-model', 'unknown-model'],
      availability: {
        'good-model': { state: 'available', checkedAt: Date.now() },
        'unknown-model': { state: 'available', checkedAt: Date.now() },
      },
    })

    expect(scored[0].model).toBe('good-model')
    expect(scored[1].model).toBe('unknown-model')
  })

  it('filters out unavailable models', () => {
    const scored = scoreFailoverCandidates({
      candidates: ['bad-model', 'good-model'],
      availability: {
        'bad-model': { state: 'unavailable', checkedAt: Date.now() },
        'good-model': { state: 'available', checkedAt: Date.now() },
      },
    })

    expect(scored).toHaveLength(1)
    expect(scored[0].model).toBe('good-model')
  })

  it('gives neutral score to available models without metrics', () => {
    const scored = scoreFailoverCandidates({
      candidates: ['new-model'],
      availability: {
        'new-model': { state: 'available', checkedAt: Date.now() },
      },
    })

    expect(scored[0].score).toBe(50)
  })

  it('gives lower score to unprobed models', () => {
    const scored = scoreFailoverCandidates({
      candidates: ['unprobed-model'],
      availability: {},
    })

    expect(scored[0].score).toBe(25)
  })

  it('pickBestCandidate returns the top model', () => {
    recordPerformanceMetric({ model: 'best', outcome: 'success', latencyMs: 50 })
    recordPerformanceMetric({ model: 'worst', outcome: 'failure', latencyMs: 1000, errorCategory: 'timeout' })

    const scored = scoreFailoverCandidates({
      candidates: ['worst', 'best'],
    })

    expect(pickBestCandidate(scored)).toBe('best')
  })

  it('pickBestCandidate returns undefined for empty list', () => {
    expect(pickBestCandidate([])).toBeUndefined()
  })

  it('handles empty candidates', () => {
    expect(scoreFailoverCandidates({ candidates: [] })).toEqual([])
  })

  it('excludes a model in rate-limit cooldown', () => {
    recordPerformanceMetric({
      model: 'throttled',
      outcome: 'failure',
      latencyMs: 10,
      errorCategory: 'rate-limit',
    })
    recordPerformanceMetric({
      model: 'healthy',
      outcome: 'success',
      latencyMs: 100,
    })

    const scored = scoreFailoverCandidates({
      candidates: ['throttled', 'healthy'],
      availability: {
        'throttled': { state: 'available', checkedAt: Date.now() },
        'healthy': { state: 'available', checkedAt: Date.now() },
      },
    })

    expect(scored).toHaveLength(1)
    expect(scored[0].model).toBe('healthy')
  })

  it('does not cool down a model with only timeouts', () => {
    recordPerformanceMetric({
      model: 'slow-but-ok',
      outcome: 'failure',
      latencyMs: 900,
      errorCategory: 'timeout',
    })

    const scored = scoreFailoverCandidates({
      candidates: ['slow-but-ok'],
      availability: {
        'slow-but-ok': { state: 'available', checkedAt: Date.now() },
      },
    })

    expect(scored).toHaveLength(1)
    expect(scored[0].model).toBe('slow-but-ok')
  })
})
