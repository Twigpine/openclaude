import os from 'node:os'

export const HEAP_SIZE_ENV = 'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB'
export const HEAP_PERCENTAGE_ENV = 'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_PERCENTAGE'
export const DEFAULT_HEAP_SIZE_MB = 8192
export const HEAP_SIZE_FLAG = '--max-old-space-size'
export const HEAP_PERCENTAGE_FLAG = '--max-old-space-size-percentage'
export const MAX_MEMORY_FLAG = '--max-memory'

/** @typedef {{ constrainedMemory?: () => unknown, totalmem?: () => unknown }} MemorySources */

/**
 * @param {string[]} args
 * @param {string} flag
 */
export function hasNodeFlag(args, flag) {
  return args.some(arg => arg === flag || arg.startsWith(`${flag}=`))
}

/**
 * @param {string | undefined} nodeOptions
 */
export function nodeOptionArgs(nodeOptions) {
  return (nodeOptions || '').split(/\s+/).filter(Boolean)
}

/**
 * @param {string[]} args
 */
export function hasHeapLimitFlag(args) {
  return hasNodeFlag(args, HEAP_SIZE_FLAG) || hasNodeFlag(args, HEAP_PERCENTAGE_FLAG)
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePositiveIntegerMb(raw) {
  if (raw == null || raw === '') return null
  const parsed = Number.parseInt(String(raw), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Node accepts a number greater than 0 and up to 100.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePercentage(raw) {
  if (raw == null) return null
  const trimmed = String(raw).trim()
  if (!trimmed) return null
  const withoutPercent = trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed
  if (withoutPercent.trim() === '') return null
  const parsed = Number(withoutPercent)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null
  return parsed
}

/**
 * Prefer cgroup/OS memory constraints so container limits win over host RAM.
 * @param {MemorySources} [sources]
 */
export function getAvailableMemoryBytes(sources = {}) {
  const constrainedMemory =
    sources.constrainedMemory ??
    (() => {
      try {
        return typeof process.constrainedMemory === 'function'
          ? process.constrainedMemory()
          : undefined
      } catch {
        return undefined
      }
    })
  const totalmem = sources.totalmem ?? (() => os.totalmem())

  const constrained = constrainedMemory()
  // Node/libuv reports UINT64_MAX (not a safe integer in JS) when there is no
  // cgroup/OS memory limit. Treat only real byte caps as constraints.
  if (typeof constrained === 'number' && Number.isSafeInteger(constrained) && constrained > 0) {
    return constrained
  }
  const total = totalmem()
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return total
  }
  return 0
}

/**
 * @param {number} percentage
 * @param {number} availableBytes
 * @returns {number | null}
 */
export function heapSizeMbFromPercentage(percentage, availableBytes) {
  if (!(percentage > 0 && percentage <= 100) || !(availableBytes > 0)) return null
  const mb = Math.floor((availableBytes * (percentage / 100)) / (1024 * 1024))
  return Math.max(1, mb)
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | null}
 */
export function findEqualsFlagValue(args, flag) {
  const prefix = `${flag}=`
  for (const arg of args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
  }
  return null
}

/**
 * @param {string[]} args
 * @param {string} flag
 * @returns {string | null}
 */
export function findEqualsOrNextFlagValue(args, flag) {
  const prefix = `${flag}=`
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith(prefix)) return arg.slice(prefix.length)
    if (arg === flag) {
      const next = args[i + 1]
      if (next && !next.startsWith('-')) return next
      return ''
    }
  }
  return null
}

/**
 * Strip launcher-only heap args so Commander does not reject them.
 * `--max-memory` stays equals-only to match the previous launcher contract.
 * @param {string[]} args
 */
export function stripLauncherHeapArgs(args) {
  const stripped = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === MAX_MEMORY_FLAG || arg.startsWith(`${MAX_MEMORY_FLAG}=`)) continue
    if (arg.startsWith(`${HEAP_PERCENTAGE_FLAG}=`)) continue
    if (arg === HEAP_PERCENTAGE_FLAG) {
      const next = args[i + 1]
      if (next && !next.startsWith('-') && parsePercentage(next) != null) i += 1
      continue
    }
    stripped.push(arg)
  }
  return stripped
}

/**
 * @param {{
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   availableBytes?: number,
 *   memorySources?: MemorySources,
 * }} [input]
 */
export function resolveHeapSizeMb(input = {}) {
  const argv = input.argv ?? []
  const env = input.env ?? {}
  const availableBytes =
    input.availableBytes ?? getAvailableMemoryBytes(input.memorySources)

  const maxMem = parsePositiveIntegerMb(findEqualsFlagValue(argv, MAX_MEMORY_FLAG))
  if (maxMem != null) {
    return { mb: maxMem, source: 'max-memory', setMaxMemoryEnv: true }
  }

  const argvPercentage = parsePercentage(
    findEqualsOrNextFlagValue(argv, HEAP_PERCENTAGE_FLAG),
  )
  if (argvPercentage != null) {
    const mb = heapSizeMbFromPercentage(argvPercentage, availableBytes)
    if (mb != null) {
      return { mb, source: 'argv-percentage', percentage: argvPercentage }
    }
    // Valid percentage requested; memory size unknown. Do not treat this as
    // "no percentage" and fall through to an unrelated MB env value.
    return {
      mb: DEFAULT_HEAP_SIZE_MB,
      source: 'percentage-unavailable',
      percentage: argvPercentage,
    }
  }

  const envPercentage = parsePercentage(env[HEAP_PERCENTAGE_ENV])
  if (envPercentage != null) {
    const mb = heapSizeMbFromPercentage(envPercentage, availableBytes)
    if (mb != null) {
      return { mb, source: 'env-percentage', percentage: envPercentage }
    }
    return {
      mb: DEFAULT_HEAP_SIZE_MB,
      source: 'percentage-unavailable',
      percentage: envPercentage,
    }
  }

  const envMb = parsePositiveIntegerMb(env[HEAP_SIZE_ENV])
  if (envMb != null) return { mb: envMb, source: 'env-mb' }

  return { mb: DEFAULT_HEAP_SIZE_MB, source: 'default' }
}

/**
 * One-line operator warning when a valid percentage cannot be converted.
 * @param {number} percentage
 * @param {number} [fallbackMb]
 */
export function formatPercentageUnavailableStderr(
  percentage,
  fallbackMb = DEFAULT_HEAP_SIZE_MB,
) {
  return `openclaude: could not convert heap percentage ${percentage} to megabytes because available memory is unknown; using ${fallbackMb}`
}
