import { createHash } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type {
  CacheData,
  CacheStats,
  FileStatFingerprint,
  RenderedCacheEntry,
  Tag,
} from './types.js'

/**
 * Bump whenever extraction semantics change, so persisted per-file tags and
 * rendered maps are discarded instead of serving stale results. Version 3 adds
 * plain call references to the TypeScript query.
 */
export const CACHE_VERSION = 3
const MAX_RENDERED_ENTRIES = 20

function getCacheDir(): string {
  return join(getClaudeConfigHomeDir(), 'repomap-cache')
}

function getCacheFilePath(root: string): string {
  const hash = createHash('sha256').update(root).digest('hex')
  return join(getCacheDir(), `${hash}.json`)
}

function emptyCache(): CacheData {
  return { version: CACHE_VERSION, entries: {}, renderedEntries: {} }
}

function ensureCacheDir(): void {
  const cacheDir = getCacheDir()
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true })
  }
}

/** Load cache from disk. Returns empty cache if not found or invalid. */
export function loadCache(root: string): CacheData {
  const path = getCacheFilePath(root)
  try {
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw) as CacheData
    if (data.version !== CACHE_VERSION) {
      return emptyCache()
    }
    data.renderedEntries ??= {}
    return data
  } catch {
    return emptyCache()
  }
}

/** Save cache to disk. */
export function saveCache(root: string, cache: CacheData): void {
  try {
    ensureCacheDir()
    const path = getCacheFilePath(root)
    writeFileSync(path, JSON.stringify(cache), 'utf-8')
  } catch {
    // Cache persistence is an optimization; repo-map results should still be
    // usable in read-only home directories or sandboxed runtimes.
  }
}

/**
 * Check if a file's cached entry is still valid based on mtime and size.
 * Returns the cached tags if valid, null otherwise.
 */
export function getCachedTags(
  cache: CacheData,
  filePath: string,
  root: string,
  stat?: FileStatFingerprint,
): Tag[] | null {
  const entry = cache.entries[filePath]
  if (!entry) return null

  try {
    const fingerprint = stat ?? statFile(root, filePath)
    if (
      fingerprint &&
      fingerprint.mtimeMs === entry.mtimeMs &&
      fingerprint.size === entry.size
    ) {
      return entry.tags
    }
  } catch {
    // File may have been deleted
  }
  return null
}

/** Update the cache entry for a file. */
export function setCachedTags(
  cache: CacheData,
  filePath: string,
  root: string,
  tags: Tag[],
  stat?: FileStatFingerprint,
): void {
  try {
    const fingerprint = stat ?? statFile(root, filePath)
    if (!fingerprint) return
    cache.entries[filePath] = {
      tags,
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
    }
  } catch {
    // If we can't stat, don't cache
  }
}

/**
 * Compute a hash of the inputs that affect the rendered map.
 * Used to cache the final rendered output.
 *
 * The fingerprint includes per-file mtime+size so that editing a file
 * (without changing the file list) invalidates the rendered cache. Without
 * this, `buildRepoMap` would return a stale rendered map until manual
 * `invalidateCache()`.
 */
export function computeMapHash(
  files: string[],
  maxTokens: number,
  focusFiles: string[],
  focusSymbols: string[],
  root: string,
  fileStats?: Map<string, FileStatFingerprint>,
): string {
  const sorted = [...files].sort()
  const fingerprint = sorted.map(file => {
    const stat = fileStats?.get(file) ?? statFile(root, file)
    return stat ? `${file}:${stat.mtimeMs}:${stat.size}` : `${file}:missing`
  })
  const input = JSON.stringify({
    files: sorted,
    fingerprint,
    maxTokens,
    focusFiles: [...focusFiles].sort(),
    focusSymbols: [...focusSymbols].sort(),
  })
  return createHash('sha256').update(input).digest('hex')
}

export function statFile(
  root: string,
  filePath: string,
): FileStatFingerprint | null {
  try {
    const stat = statSync(join(root, filePath))
    return { mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

export function getRenderedCache(
  cache: CacheData,
  mapHash: string,
): RenderedCacheEntry | null {
  return cache.renderedEntries[mapHash] ?? null
}

export function setRenderedCache(
  cache: CacheData,
  mapHash: string,
  entry: Omit<RenderedCacheEntry, 'createdAt'>,
): void {
  cache.renderedEntries[mapHash] = { ...entry, createdAt: Date.now() }
  pruneRenderedEntries(cache)
}

export function pruneCache(cache: CacheData, currentFiles: string[]): void {
  const current = new Set(currentFiles)
  for (const key of Object.keys(cache.entries)) {
    if (!current.has(key)) {
      delete cache.entries[key]
    }
  }
  pruneRenderedEntries(cache)
}

function pruneRenderedEntries(cache: CacheData): void {
  const entries = Object.entries(cache.renderedEntries)
  if (entries.length <= MAX_RENDERED_ENTRIES) return

  entries
    .sort((a, b) => b[1].createdAt - a[1].createdAt)
    .slice(MAX_RENDERED_ENTRIES)
    .forEach(([key]) => {
      delete cache.renderedEntries[key]
    })
}

/** Get cache statistics. */
export function getCacheStats(root: string): CacheStats {
  const cacheFile = getCacheFilePath(root)
  const exists = existsSync(cacheFile)
  let entryCount = 0

  if (exists) {
    try {
      const data = JSON.parse(readFileSync(cacheFile, 'utf-8')) as CacheData
      entryCount =
        Object.keys(data.entries ?? {}).length +
        Object.keys(data.renderedEntries ?? {}).length
    } catch {
      // corrupted cache
    }
  }

  return {
    cacheDir: getCacheDir(),
    cacheFile: exists ? cacheFile : null,
    entryCount,
    exists,
  }
}

/** Delete the cache for a repo root. */
export function invalidateCache(root: string): void {
  const path = getCacheFilePath(root)
  try {
    rmSync(path, { force: true })
  } catch {
    // File may not exist
  }
}
