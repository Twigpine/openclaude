/**
 * Persisted cache for per-model availability probes.
 *
 * Probing a large catalog is a real inference cost per model, so results are
 * cached on disk and reused until they age out. The cache is keyed by the
 * credential-scoped discovery identity (same shape as the model catalog cache)
 * so two accounts against the same gateway do not share verdicts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import {
  pruneStaleAvailability,
  type ModelAvailability,
} from './modelAvailability.js'

const CACHE_FILENAME = 'model-availability-cache.json'
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

type CacheShape = {
  version: 1
  entries: Record<string, Record<string, ModelAvailability>>
}

type LoadedCache = {
  entries: Record<string, Record<string, ModelAvailability>>
  /** Present when the cache was unreadable rather than merely absent. */
  error?: string
}

function cachePath(): string {
  return join(getClaudeConfigHomeDir(), CACHE_FILENAME)
}

function emptyCache(): CacheShape {
  return { version: 1, entries: {} }
}

function readCache(): LoadedCache {
  try {
    const path = cachePath()
    if (!existsSync(path)) {
      return { entries: {} }
    }
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CacheShape>
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return { entries: {} }
    }
    return { entries: parsed.entries as Record<string, Record<string, ModelAvailability>> }
  } catch (error) {
    return {
      entries: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function writeCache(cache: CacheShape): void {
  try {
    const path = cachePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 })
  } catch {
    // A cache miss only costs a re-probe; never fail the command over it.
  }
}

export function getCachedAvailability(
  scopeKey: string,
): Record<string, ModelAvailability> {
  const { entries } = readCache()
  return pruneStaleAvailability(entries[scopeKey] ?? {}, DEFAULT_TTL_MS)
}

export function hasCachedAvailability(scopeKey: string): boolean {
  return Object.keys(getCachedAvailability(scopeKey)).length > 0
}

export function setCachedAvailability(
  scopeKey: string,
  results: Record<string, ModelAvailability>,
): void {
  const { entries } = readCache()
  entries[scopeKey] = {
    ...pruneStaleAvailability(results, DEFAULT_TTL_MS),
  }
  writeCache({ version: 1, entries })
}

export function clearCachedAvailability(scopeKey?: string): void {
  const cache = readCache()
  if (scopeKey === undefined) {
    writeCache(emptyCache())
    return
  }
  delete cache.entries[scopeKey]
  writeCache({ version: 1, entries: cache.entries })
}

export const AVAILABILITY_CACHE_TTL_MS = DEFAULT_TTL_MS
