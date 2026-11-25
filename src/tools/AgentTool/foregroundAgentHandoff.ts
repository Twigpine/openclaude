import type { ReplAgentConcurrencyBudget } from '../../Tool.js'
import { createChildAbortController } from '../../utils/abortController.js'
import { logForDebugging } from '../../utils/debug.js'
import { requestAbort } from '../../utils/interruptionTrace.js'
import { sleep } from '../../utils/sleep.js'

/**
 * Cap on concurrent foreground agents inside one REPL script. Applies to
 * direct fanout and nested spawns alike, because nested agents bypass the
 * inner tool runner's per-call Agent() caps.
 */
export const REPL_FOREGROUND_AGENT_CONCURRENCY_CAP = 8

const budgetByPromptWaitTracker = new WeakMap<
  object,
  ReplAgentConcurrencyBudget
>()

/**
 * Returns the budget keyed by the owning REPL script's prompt wait tracker
 * identity. The tracker is shared by every canonical inner tool call of one
 * script execution and propagates into nested subagent contexts, so keying by
 * its identity makes the budget shared across the whole nesting tree without
 * any explicit wiring.
 */
export function getReplAgentConcurrencyBudget(
  promptWaitTracker: object,
): ReplAgentConcurrencyBudget {
  let budget = budgetByPromptWaitTracker.get(promptWaitTracker)
  if (budget) return budget
  let inFlight = 0
  budget = {
    cap: REPL_FOREGROUND_AGENT_CONCURRENCY_CAP,
    tryAcquire() {
      if (inFlight >= REPL_FOREGROUND_AGENT_CONCURRENCY_CAP) {
        throw new Error(
          `REPL foreground agent concurrency limit reached: ${REPL_FOREGROUND_AGENT_CONCURRENCY_CAP} agents are still running. ` +
            `Wait for running agents to complete before spawning more, or parallelize less aggressively.`,
        )
      }
      inFlight += 1
    },
    release() {
      if (inFlight <= 0) {
        logForDebugging(
          'REPL foreground agent concurrency budget release underflow; ignoring',
        )
        return
      }
      inFlight -= 1
    },
  }
  budgetByPromptWaitTracker.set(promptWaitTracker, budget)
  return budget
}

/**
 * Resolves the budget for a tool-use context inside a foreground REPL script.
 * Prefers the budget pinned on the context (propagated through
 * createSubagentContext) and falls back to the tracker-keyed lookup.
 */
export function resolveReplAgentConcurrencyBudget(context: {
  replAgentConcurrencyBudget?: ReplAgentConcurrencyBudget
  replPromptWaitTracker?: object
}): ReplAgentConcurrencyBudget | undefined {
  if (context.replAgentConcurrencyBudget) {
    return context.replAgentConcurrencyBudget
  }
  const tracker = context.replPromptWaitTracker
  return tracker ? getReplAgentConcurrencyBudget(tracker) : undefined
}

export function createForegroundAgentAbortController(
  parent: AbortController,
): AbortController {
  const foreground = createChildAbortController(parent, undefined, {
    subsystem: 'agent_tool',
    controllerRole: 'child',
  })
  foreground.signal.addEventListener(
    'abort',
    () => {
      if (foreground.signal.reason === 'background' || parent.signal.aborted) {
        return
      }
      requestAbort(parent, foreground.signal.reason, {
        source: 'foreground_agent_abort',
        subsystem: 'agent_tool',
        controllerRole: 'query-root',
      })
    },
    { once: true },
  )
  return foreground
}

export async function closeForegroundAgentForBackground(
  abortController: AbortController,
  closeIterator: () => Promise<unknown>,
): Promise<void> {
  requestAbort(abortController, 'background', {
    source: 'agent_background_transition',
    subsystem: 'agent_tool',
    controllerRole: 'child',
  })
  await Promise.race([closeIterator().catch(() => {}), sleep(1000)])
}
