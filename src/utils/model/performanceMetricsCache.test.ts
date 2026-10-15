import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { setClaudeConfigHomeDirForTesting } from '../envUtils.js'
import type { ModelMetricRecord } from './performanceMetrics.js'
import {
  PERFORMANCE_METRICS_CACHE_TTL_MS,
  clearPersistedMetrics,
  loadPersistedMetrics,
  persistMetrics,
} from './performanceMetricsCache.js'

function record(
  overrides: Partial<ModelMetricRecord> = {},
): ModelMetricRecord {
  return {
    model: 'gpt-4',
    outcome: 'success',
    latencyMs: 100,
    errorCategory: 'none',
    timestamp: Date.now(),
    ...overrides,
  }
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'perf-metrics-cache-'))
  setClaudeConfigHomeDirForTesting(tempDir)
})

describe('performanceMetricsCache', () => {
  test('an absent cache reads as empty', () => {
    expect(loadPersistedMetrics()).toEqual([])
  })

  test('persisted records round-trip', () => {
    const records = [record(), record({ model: 'claude-3', outcome: 'failure', errorCategory: 'timeout' })]
    persistMetrics(records)
    expect(loadPersistedMetrics()).toEqual(records)
  })

  test('stale records are dropped on load', () => {
    const fresh = record({ timestamp: Date.now() })
    const stale = record({ model: 'old', timestamp: Date.now() - PERFORMANCE_METRICS_CACHE_TTL_MS - 1000 })
    persistMetrics([fresh, stale])
    const loaded = loadPersistedMetrics()
    expect(loaded.map(r => r.model)).toEqual(['gpt-4'])
  })

  test('malformed entries are dropped', () => {
    const path = join(tempDir, 'performance-metrics-cache.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        records: [
          record(),
          { model: 123, outcome: 'success', latencyMs: 10, timestamp: Date.now() },
          { model: 'bad', outcome: 'maybe', latencyMs: 10, timestamp: Date.now() },
          null,
        ],
      }),
    )
    const loaded = loadPersistedMetrics()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].model).toBe('gpt-4')
  })

  test('a different version degrades to empty', () => {
    const path = join(tempDir, 'performance-metrics-cache.json')
    writeFileSync(path, JSON.stringify({ version: 2, records: [record()] }))
    expect(loadPersistedMetrics()).toEqual([])
  })

  test('a corrupt cache file degrades to empty', () => {
    const path = join(tempDir, 'performance-metrics-cache.json')
    writeFileSync(path, '{not json', { mode: 0o600 })
    expect(loadPersistedMetrics()).toEqual([])
  })

  test('persistMetrics bounds history to the last 200 entries', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      record({ model: `m-${i}`, timestamp: Date.now() }),
    )
    persistMetrics(many)
    const loaded = loadPersistedMetrics()
    expect(loaded).toHaveLength(200)
    expect(loaded[0].model).toBe('m-50')
    expect(loaded[199].model).toBe('m-249')
  })

  test('clearPersistedMetrics empties the cache', () => {
    persistMetrics([record()])
    clearPersistedMetrics()
    expect(loadPersistedMetrics()).toEqual([])
  })

  test('the cache file is written with owner-only permissions', () => {
    persistMetrics([record()])
    const path = join(tempDir, 'performance-metrics-cache.json')
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('gpt-4')
  })
})