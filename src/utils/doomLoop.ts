/**
 * Doom loop detection: prevents wasting tokens on repeated identical tool calls.
 *
 * Tracks consecutive tool calls with the same (name, input) signature.
 * After a configurable threshold (default 3), blocks execution and tells the
 * model to change approach or ask the user.
 *
 * State is keyed per agent (main thread and each subagent track separately).
 * Subagents run runToolUse in the same process as the main loop, so a shared
 * counter would let three parallel agents each legitimately making the same
 * call once trip the block, and any interleaved call would reset it.
 */

import { createHash } from 'crypto'

const DEFAULT_THRESHOLD = 3
const MAX_CONSECUTIVE_BLOCKS = 5

const MAIN_AGENT_KEY = 'main'

type ToolSignature = string

interface DoomLoopState {
  lastSignature: ToolSignature | null
  consecutiveCount: number
  blocked: boolean
  consecutiveBlocks: number
  terminalMessage: string | null
}

const stateByAgent = new Map<string, DoomLoopState>()
let stateByTurn = new WeakMap<object, DoomLoopState>()

function getState(agentKey: string | object): DoomLoopState {
  let state = typeof agentKey === 'string'
    ? stateByAgent.get(agentKey)
    : stateByTurn.get(agentKey)
  if (!state) {
    state = {
      lastSignature: null,
      consecutiveCount: 0,
      blocked: false,
      consecutiveBlocks: 0,
      terminalMessage: null,
    }
    if (typeof agentKey === 'string') stateByAgent.set(agentKey, state)
    else stateByTurn.set(agentKey, state)
  }
  return state
}

function computeSignature(toolName: string, input: unknown): ToolSignature {
  // Hash the FULL serialized input: prefix-truncated comparison treated two
  // genuinely different calls sharing a 2KB prefix (e.g. Write calls to the
  // same file with different trailing content) as identical — a false
  //-positive block on legitimate, distinct work. Serialization of the
  // in-memory input is the unavoidable cost either way; the digest keeps the
  // stored signature fixed-size. The tool name stays readable for
  // getDoomLoopState diagnostics.
  const inputStr = typeof input === 'string'
    ? input
    : JSON.stringify(input) ?? ''
  const digest = createHash('sha256').update(inputStr).digest('hex')
  return `${toolName}::${digest}`
}

/**
 * Record a tool call and check if it's a doom loop.
 * Returns `{ blocked: true }` if the tool should be blocked,
 * or `{ blocked: false }` to proceed normally.
 */
export function checkDoomLoop(
  toolName: string,
  input: unknown,
  options: { threshold?: number; agentKey?: string | object } = {},
): { blocked: boolean; count: number } {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  const state = getState(options.agentKey ?? MAIN_AGENT_KEY)
  const sig = computeSignature(toolName, input)

  if (sig === state.lastSignature) {
    state.consecutiveCount++
  } else {
    state.lastSignature = sig
    state.consecutiveCount = 1
    state.blocked = false
  }

  if (state.consecutiveCount >= threshold && !state.blocked) {
    state.blocked = true
    return { blocked: true, count: state.consecutiveCount }
  }

  return { blocked: state.blocked, count: state.consecutiveCount }
}

/** Count actual guard blocks; latch termination so late parallel results cannot undo it. */
export function recordDoomLoopBlock(
  toolName: string,
  lastError: string,
  agentKey: string | object = MAIN_AGENT_KEY,
): void {
  const state = getState(agentKey)
  if (state.terminalMessage) return
  state.consecutiveBlocks++
  if (state.consecutiveBlocks >= MAX_CONSECUTIVE_BLOCKS) {
    state.terminalMessage =
      `Turn force-terminated: ${toolName} was blocked ${state.consecutiveBlocks} consecutive times by the doom-loop guard. ` +
      `Last error: ${lastError} Ask the user for help before retrying.`
  }
}

/** A non-blocked call or successful result breaks the streak, until termination. */
export function recordDoomLoopProgress(agentKey: string | object = MAIN_AGENT_KEY): void {
  const state = getState(agentKey)
  if (!state.terminalMessage) state.consecutiveBlocks = 0
}

/**
 * Reset doom loop state for one agent (e.g., at the start of its query turn).
 * Defaults to the main thread, matching checkDoomLoop's default key.
 */
export function resetDoomLoop(agentKey: string | object = MAIN_AGENT_KEY): void {
  if (typeof agentKey === 'string') stateByAgent.delete(agentKey)
  else stateByTurn.delete(agentKey)
}

/** Clear every agent's state. Test isolation only. */
export function resetAllDoomLoops(): void {
  stateByAgent.clear()
  stateByTurn = new WeakMap()
}

/**
 * Get current doom loop state for diagnostics.
 */
export function getDoomLoopState(
  agentKey: string | object = MAIN_AGENT_KEY,
): Readonly<DoomLoopState> {
  return { ...getState(agentKey) }
}
