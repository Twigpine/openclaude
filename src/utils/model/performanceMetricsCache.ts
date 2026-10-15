/**
 * Disk-backed cache for per-model performance metrics.
 *
 * Failover scoring needs history that survives a process restart — without it,
 * the first turn after a cold start has no signal and falls back to catalog
 * order. Metrics are tiny ({model, outcome, latencyMs, errorCategory,
 * timestamp}) so the whole history fits in one JSON file under the config home
 * dir, mirroring modelAvailabilityCache.ts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import type { ModelMetricRecord } from './performanceMetrics.js'

const CACHE_FILENAME = 'performance-metrics-cache.json'
/** Records older than this are dropped on load so stale history can't skew scoring. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
/** Bound persisted history; the in-memory ring already caps at 500 live entries. */
const MAX_PERSISTED_ENTRIES = 200

type CacheShape = {
  version: 1
  records: ModelMetricRecord[]
}

function cachePath(): string {
  return join(getClaudeConfigHomeDir(), CACHE_FILENAME)
}

function isFresh(record: ModelMetricRecord, now: number): boolean {
  return (
    typeof record?.timestamp === 'number' &&
    typeof record?.model === 'string' &&
    now - record.timestamp <= CACHE_TTL_MS
  )
}

/**
 * Load persisted metrics from disk, dropping anything malformed or stale.
 * Returns [] when the cache is absent, corrupt, or from a different version.
 */
export function loadPersistedMetrics(): ModelMetricRecord[] {
  try {
    const path = cachePath()
    if (!existsSync(path)) {
      return []
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheShape>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
      return []
    }
    const now = Date.now()
    return parsed.records.filter(r => isFresh(r, now))
  } catch {
    return []
  }
}

/**
 * Persist metrics to disk, best-effort. A failed write only costs cold-start
 * bias on the next invocation, so it must never throw.
 */
export function persistMetrics(records: ModelMetricRecord[]): void {
  try {
    const path = cachePath()
    mkdirSync(dirname(path), { recursive: true })
    const payload: CacheShape = {
      version: 1,
      records: records.slice(-MAX_PERSISTED_ENTRIES),
    }
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 })
  } catch {
    // Advisory data; ignore.
  }
}
