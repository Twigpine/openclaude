import {
  getInterruptionSignalAbortTrace,
  tracePermissionAbortResolution,
} from '../interruptionTrace.js'

export type InProcessPermissionAbortCompleter = {
  claim(): boolean
  completeAbort(
    source: string | undefined,
    causalEventId: string | undefined,
  ): boolean
  completeSignalAbort(): boolean
  isSettled(): boolean
}

export function createInProcessPermissionAbortCompleter(
  signal: AbortSignal,
  onAbortSettled: () => void,
): InProcessPermissionAbortCompleter {
  let settled = false

  const claim = (): boolean => {
    if (settled) return false
    settled = true
    signal.removeEventListener('abort', onSignalAbort)
    return true
  }

  const completeAbort = (
    source: string | undefined,
    causalEventId: string | undefined,
  ): boolean => {
    if (!claim()) return false
    tracePermissionAbortResolution(
      source,
      causalEventId,
      'in_process_permission_bridge',
    )
    onAbortSettled()
    return true
  }

  const completeSignalAbort = (): boolean => {
    const trace = getInterruptionSignalAbortTrace(signal)
    return completeAbort(trace.source, trace.causalEventId)
  }

  const onSignalAbort = () => {
    completeSignalAbort()
  }

  signal.addEventListener('abort', onSignalAbort, { once: true })
  if (signal.aborted) onSignalAbort()

  return {
    claim,
    completeAbort,
    completeSignalAbort,
    isSettled: () => settled,
  }
}
