export interface Tag {
  /** 'def' for definitions, 'ref' for references */
  kind: 'def' | 'ref'
  /** Symbol name (e.g. function name, class name) */
  name: string
  /** 1-based line number in the source file */
  line: number
  /** The full line of source code at this position (used as signature for defs) */
  signature: string
  /** Sub-kind from the query (e.g. 'function', 'class', 'method', 'type') */
  subKind?: string
}

export interface FileTags {
  /** Relative path from the repo root */
  path: string
  /** All tags extracted from this file */
  tags: Tag[]
}

export interface RepoMapOptions {
  /** Root directory of the repo (defaults to cwd) */
  root?: string
  /** Maximum token budget for the rendered map */
  maxTokens?: number
  /** Files to boost in PageRank (relative paths) */
  focusFiles?: string[]
  /** Symbol names whose defining files should be boosted in PageRank */
  focusSymbols?: string[]
  /** Override the list of files to process (relative paths) */
  files?: string[]
  /** Optional cancellation hook checked between expensive build steps */
  shouldContinue?: () => void
}

export interface RepoMapResult {
  /** The rendered repo map string */
  map: string
  /** Whether the result came from cache */
  cacheHit: boolean
  /** Time in milliseconds to build the map */
  buildTimeMs: number
  /** Number of files included in the rendered map */
  fileCount: number
  /** Total number of files processed */
  totalFileCount: number
  /** Actual token count of the rendered map */
  tokenCount: number
}

export interface CacheEntry {
  tags: Tag[]
  mtimeMs: number
  size: number
}

export interface FileStatFingerprint {
  mtimeMs: number
  size: number
}

export interface RenderedCacheEntry {
  map: string
  fileCount: number
  tokenCount: number
  createdAt: number
}

export interface CacheData {
  version: number
  entries: Record<string, CacheEntry>
  renderedEntries: Record<string, RenderedCacheEntry>
}

export interface CacheStats {
  cacheDir: string
  cacheFile: string | null
  entryCount: number
  exists: boolean
}

export type SupportedLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
