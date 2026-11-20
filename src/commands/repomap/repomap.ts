import type {
  LocalCommandCall,
  LocalCommandResult,
} from '../../types/command.js'
import type { CacheStats, RepoMapResult } from '../../context/repoMap/index.js'
import { getCwd } from '../../utils/cwd.js'
import type { ParseEntry } from '../../utils/bash/shellQuote.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'

type ArgPart = string | null

export const REPOMAP_DEFAULT_TOKENS = 2048
export const REPOMAP_MIN_TOKENS = 256
export const REPOMAP_MAX_TOKENS = 16384

export const REPOMAP_USAGE =
  'Usage: /repomap [--tokens <256-16384>] [--focus <path>]... ' +
  '[--focus-symbols <name>]... [--stats] [--invalidate]'

export type RepoMapArgs = {
  tokens: number
  focus: string[]
  focusSymbols: string[]
  invalidate: boolean
  stats: boolean
  /** First argument problem found, or null when every argument was valid. */
  error: string | null
}

/** Split `--flag=value` into its flag and inline value; no `=` means no value. */
function splitFlag(part: string): { flag: string; value: string | null } {
  if (!part.startsWith('--')) {
    return { flag: part, value: null }
  }
  const eq = part.indexOf('=')
  if (eq === -1) {
    return { flag: part, value: null }
  }
  return { flag: part.slice(0, eq), value: part.slice(eq + 1) }
}

/** Parse CLI-style arguments from the command string. */
export function parseArgs(args: string): RepoMapArgs {
  const parsed = tryParseShellCommand(args)
  const parts: ArgPart[] = parsed.success
    ? parsed.tokens.map(normalizeParsedToken)
    : args.trim().split(/\s+/).filter(Boolean)
  const result: RepoMapArgs = {
    tokens: REPOMAP_DEFAULT_TOKENS,
    focus: [],
    focusSymbols: [],
    invalidate: false,
    stats: false,
    error: null,
  }

  const fail = (message: string): void => {
    result.error ??= message
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    // Shell operators and other non-string tokens are separators, not arguments.
    if (typeof part !== 'string') continue

    const { flag, value } = splitFlag(part)

    if (flag === '--invalidate' || flag === '--stats') {
      if (value !== null) {
        fail(`${flag} takes no value (got "${value}")`)
        continue
      }
      if (flag === '--invalidate') result.invalidate = true
      else result.stats = true
      continue
    }

    if (
      flag !== '--tokens' &&
      flag !== '--focus' &&
      flag !== '--focus-symbols'
    ) {
      fail(`Unknown argument "${part}"`)
      continue
    }

    // A separate value is only taken when the next token is not another flag.
    let raw = value
    if (raw === null) {
      const next = parts[i + 1]
      if (typeof next === 'string' && !next.startsWith('--')) {
        raw = next
        i++
      }
    }

    if (raw === null || raw === '') {
      fail(`${flag} expects a value`)
      continue
    }

    if (flag === '--tokens') {
      const tokens = Number(raw)
      if (
        !/^\d+$/.test(raw) ||
        tokens < REPOMAP_MIN_TOKENS ||
        tokens > REPOMAP_MAX_TOKENS
      ) {
        fail(
          `--tokens expects a whole number between ${REPOMAP_MIN_TOKENS} and ` +
            `${REPOMAP_MAX_TOKENS} (got "${raw}")`,
        )
        continue
      }
      result.tokens = tokens
      continue
    }

    if (flag === '--focus') result.focus.push(raw)
    else result.focusSymbols.push(raw)
  }

  return result
}

function normalizeParsedToken(part: ParseEntry): ArgPart {
  if (typeof part === 'string') return part
  if (
    'op' in part &&
    part.op === 'glob' &&
    'pattern' in part &&
    typeof part.pattern === 'string'
  ) {
    return part.pattern
  }
  return null
}

export const call: LocalCommandCall = async (args) => {
  const root = getCwd()
  return runRepoMapCommand(args ?? '', root)
}

type RepoMapCommandDeps = {
  buildRepoMap: (options: {
    root: string
    maxTokens: number
    focusFiles?: string[]
    focusSymbols?: string[]
  }) => Promise<RepoMapResult>
  invalidateCache: (root?: string) => void
  getCacheStats: (root?: string) => CacheStats
}

type RepoMapDepsLoader = () => Promise<RepoMapCommandDeps>

async function loadRepoMapDeps(): Promise<RepoMapCommandDeps> {
  return import('../../context/repoMap/index.js')
}

export async function runRepoMapCommand(
  args: string,
  root: string,
  depsPromise?: Promise<RepoMapCommandDeps>,
  loadDeps: RepoMapDepsLoader = loadRepoMapDeps,
): Promise<LocalCommandResult> {
  const { tokens, focus, focusSymbols, invalidate, stats, error } =
    parseArgs(args)

  // Every argument is validated up front: a mistyped flag should say what it
  // wanted instead of silently building a map with the default budget.
  if (error) {
    return { type: 'text', value: `${error}\n\n${REPOMAP_USAGE}` }
  }

  // Load dependencies only after validation so a bad invocation does not pay
  // for (or fail during) the module import.
  let deps: RepoMapCommandDeps
  try {
    deps = await (depsPromise ?? loadDeps())
  } catch (err) {
    return renderError('Failed to load repo map module', err)
  }

  if (stats) {
    try {
      const cacheStats = deps.getCacheStats(root)
      const lines = [
        `Repository map cache stats:`,
        `  Cache directory: ${cacheStats.cacheDir}`,
        `  Cache file: ${cacheStats.cacheFile ?? '(none)'}`,
        `  Cached entries: ${cacheStats.entryCount}`,
        `  Cache exists: ${cacheStats.exists}`,
      ]
      return { type: 'text', value: lines.join('\n') }
    } catch (err) {
      return renderError('Failed to read repository map cache stats', err)
    }
  }

  if (invalidate) {
    try {
      deps.invalidateCache(root)
    } catch (err) {
      return renderError('Failed to invalidate repository map cache', err)
    }

    try {
      const result = await deps.buildRepoMap({
        root,
        maxTokens: tokens,
        focusFiles: focus.length > 0 ? focus : undefined,
        focusSymbols: focusSymbols.length > 0 ? focusSymbols : undefined,
      })
      return formatRepoMapResult('Cache invalidated and rebuilt.', result)
    } catch (err) {
      return renderError('Cache invalidated, but rebuilding the repository map failed', err)
    }
  }

  try {
    const result = await deps.buildRepoMap({
      root,
      maxTokens: tokens,
      focusFiles: focus.length > 0 ? focus : undefined,
      focusSymbols: focusSymbols.length > 0 ? focusSymbols : undefined,
    })

    return formatRepoMapResult('Repository map:', result)
  } catch (err) {
    return renderError('Failed to build repository map', err)
  }
}

function formatRepoMapResult(prefix: string, result: RepoMapResult) {
  return {
    type: 'text' as const,
    value: [
      `${prefix} ${result.fileCount} files ranked (${result.totalFileCount} total) | Tokens: ${result.tokenCount} | Time: ${result.buildTimeMs}ms | Cache hit: ${result.cacheHit}`,
      '',
      result.map,
    ].join('\n'),
  }
}

function renderError(prefix: string, err: unknown) {
  const detail = err instanceof Error ? err.message : String(err)
  return {
    type: 'text' as const,
    value: `${prefix}: ${detail}`,
  }
}
