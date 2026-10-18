import {
  createQueryTurnBudget,
  type QueryTurnBudget,
} from '../query.js'
import type { Terminal as QueryTerminal } from '../query/transitions.js'
import { normalizeAbortReason } from '../utils/abortReasons.js'
import { getReplMaxTurnsWarning, resolveReplMaxTurns } from '../utils/replMaxTurns.js'

export {
  DEFAULT_REPL_MAX_TURNS,
  getReplMaxTurnsWarning,
  MAX_TURNS_CLI_DESCRIPTION,
  REPL_MAX_TURNS_OPTIONS,
  normalizeReplMaxTurns,
  resolveReplMaxTurns,
} from '../utils/replMaxTurns.js'

export function isLocalInteractiveMaxTurnsSession(session: {
  isRemoteSession: boolean
  directConnectConfig: unknown
  sshSession: unknown
}): boolean {
  return (
    !session.isRemoteSession &&
    !session.directConnectConfig &&
    !session.sshSession
  )
}

export function shouldShowReplMaxTurnsUnlimitedWarning(
  maxTurns: number | undefined,
  session: {
    isRemoteSession: boolean
    directConnectConfig: unknown
    sshSession: unknown
  },
): boolean {
  const warning = getReplMaxTurnsWarning(maxTurns)
  return warning !== undefined && isLocalInteractiveMaxTurnsSession(session)
}

export function shouldContinueBackgroundAfterForegroundQuery({
  didThrow,
  preflightVetoed,
  abortReason,
  queryTerminal,
}: {
  didThrow: boolean
  preflightVetoed: boolean
  abortReason: unknown
  queryTerminal: QueryTerminal | undefined
}): boolean {
  return (
    !didThrow &&
    !preflightVetoed &&
    abortReason === 'background' &&
    (queryTerminal?.reason === 'aborted_streaming' ||
      queryTerminal?.reason === 'aborted_tools')
  )
}

type MutableRef<T> = { current: T }

export type DeferredMaxTurnsCap = {
  maxTurns: number
  turnCount: number
}

export type ForegroundTurnBudgetHandoff = {
  budget: QueryTurnBudget
  settled: Promise<boolean>
  settle: (shouldContinue: boolean) => void
  /** Cap suppressed on foreground `background` abort; restore if handoff is cancelled. */
  deferredMaxTurnsCap?: DeferredMaxTurnsCap
  /**
   * Last settled transcript message before a cancelled handoff may restore a
   * deferred cap. When the live tail uuid differs, a newer prompt owns the view.
   */
  settledTranscriptTailUuid?: string | null
}

export function canRestoreDeferredMaxTurnsCap(
  handoff: ForegroundTurnBudgetHandoff,
  currentMessages: readonly { uuid: string }[],
): boolean {
  if (!handoff.deferredMaxTurnsCap) return false
  const anchor = handoff.settledTranscriptTailUuid
  if (anchor === undefined) return true
  if (anchor === null) return currentMessages.length === 0
  return currentMessages.at(-1)?.uuid === anchor
}

export function resolveReplMaxTurnsForSession(
  maxTurns: number | undefined,
  session: {
    isRemoteSession: boolean
    directConnectConfig: unknown
    sshSession: unknown
  },
): number | undefined {
  if (!isLocalInteractiveMaxTurnsSession(session)) {
    return undefined
  }
  return resolveReplMaxTurns(maxTurns)
}

export function computeDeferredMaxTurnsCapForBackgroundHandoff(
  abortReason: unknown,
  queryTerminal: QueryTerminal | undefined,
  maxTurns: number | undefined,
  turnsStarted: number,
): DeferredMaxTurnsCap | undefined {
  if (
    normalizeAbortReason(abortReason) !== 'background' ||
    queryTerminal?.reason !== 'aborted_tools' ||
    maxTurns === undefined
  ) {
    return undefined
  }
  const turnCount = turnsStarted + 1
  if (turnCount <= maxTurns) {
    return undefined
  }
  return { maxTurns, turnCount }
}

export function createForegroundTurnBudgetHandoff(
  maxTurns?: number,
): ForegroundTurnBudgetHandoff {
  let resolveSettled!: (shouldContinue: boolean) => void
  let isSettled = false
  const settled = new Promise<boolean>(resolve => {
    resolveSettled = resolve
  })
  return {
    budget: createQueryTurnBudget(maxTurns),
    settled,
    settle: shouldContinue => {
      if (isSettled) return
      isSettled = true
      resolveSettled(shouldContinue)
    },
  }
}

export async function waitForForegroundTurnBudgetSettlement(
  handoff: ForegroundTurnBudgetHandoff,
  signal: AbortSignal,
): Promise<boolean | null> {
  if (signal.aborted) return null

  let resolveAborted!: () => void
  const aborted = new Promise<void>(resolve => {
    resolveAborted = resolve
  })
  const onAbort = () => resolveAborted()
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([
      handoff.settled,
      aborted.then(() => null),
    ])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function claimBackgroundTurnBudget(
  budgetRef: MutableRef<ForegroundTurnBudgetHandoff | null>,
  handoffStartedRef: MutableRef<boolean>,
): ForegroundTurnBudgetHandoff | null {
  if (!budgetRef.current || handoffStartedRef.current) return null
  handoffStartedRef.current = true
  return budgetRef.current
}

export function releaseForegroundTurnBudget(
  budgetRef: MutableRef<ForegroundTurnBudgetHandoff | null>,
  handoffStartedRef: MutableRef<boolean>,
  ownedHandoff: ForegroundTurnBudgetHandoff,
  shouldContinue: boolean,
): void {
  // Always release waiters for this prompt, even if a newer prompt replaced
  // the foreground ref before the stale finally ran.
  ownedHandoff.settle(shouldContinue)
  if (budgetRef.current !== ownedHandoff) return
  budgetRef.current = null
  handoffStartedRef.current = false
}
