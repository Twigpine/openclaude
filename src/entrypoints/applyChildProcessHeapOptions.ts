import {
  findEqualsOrNextFlagValue,
  hasHeapLimitFlag,
  HEAP_SIZE_FLAG,
  parsePositiveIntegerMb,
} from '../../bin/heap-limit.mjs'

const HEAP_SIZE_SUBSTRING = '--max-old-space-size'
const HEAP_SIZE_ENV = 'OPENCLAUDE_NODE_MAX_OLD_SPACE_SIZE_MB'
const DEFAULT_HEAP_SIZE_MB = '8192'

function appendHeapMbToNodeOptions(env: NodeJS.ProcessEnv, heapMb: string): void {
  const existing = env.NODE_OPTIONS || ''
  env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=${heapMb}`
    : `--max-old-space-size=${heapMb}`
}

/**
 * Apply a numeric V8 old-space cap to `NODE_OPTIONS` for subprocesses.
 * Child Node processes do not inherit the parent's `process.execArgv`, so a
 * heap cap applied only there must be copied into `NODE_OPTIONS` for tools
 * spawned after startup. Leaves an existing `NODE_OPTIONS` heap flag unchanged.
 */
export function applyChildProcessHeapOptions(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
): void {
  if (env.NODE_OPTIONS?.includes(HEAP_SIZE_SUBSTRING)) return

  const execArgvList = [...execArgv]
  if (hasHeapLimitFlag(execArgvList)) {
    const execArgvMb = parsePositiveIntegerMb(
      findEqualsOrNextFlagValue(execArgvList, HEAP_SIZE_FLAG),
    )
    if (execArgvMb == null) {
      // Percentage or other non-MB heap flag already applies to this process.
      return
    }
    appendHeapMbToNodeOptions(env, String(execArgvMb))
    return
  }

  const heapMb = env[HEAP_SIZE_ENV] || DEFAULT_HEAP_SIZE_MB
  appendHeapMbToNodeOptions(env, heapMb)
}
