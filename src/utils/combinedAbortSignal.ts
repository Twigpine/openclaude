import { createAbortController } from './abortController.js'
import {
  getInterruptionSignalAbortEventId,
  getInterruptionSignalId,
  registerInterruptionSignal,
  requestAbort,
  traceCombinedSignal,
  traceInterruptionEvent,
} from './interruptionTrace.js'

/**
 * Creates a combined AbortSignal that aborts when the input signal aborts,
 * an optional second signal aborts, or an optional timeout elapses.
 * Returns both the signal and a cleanup function that removes event listeners
 * and clears the internal timeout timer.
 *
 * Use `timeoutMs` instead of passing `AbortSignal.timeout(ms)` as a signal —
 * under Bun, `AbortSignal.timeout` timers are finalized lazily and accumulate
 * in native memory until they fire (measured ~2.4KB/call held for the full
 * timeout duration). This implementation uses `setTimeout` + `clearTimeout`
 * so the timer is freed immediately on cleanup.
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: {
    signalB?: AbortSignal
    timeoutMs?: number
    trace?: { subsystem: string; controllerRole?: string }
  },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs, trace } = opts ?? {}
  const combined = createAbortController()
  const traceFields = {
    subsystem: trace?.subsystem ?? 'combined_abort_signal',
    controllerRole: trace?.controllerRole ?? 'combined',
  }
  const parentIds = [signal, signalB]
    .filter((parent): parent is AbortSignal => parent !== undefined)
    .map(parent =>
      registerInterruptionSignal(parent, {
        ...traceFields,
        controllerRole: 'combined-parent',
      }),
    )
    .filter((id): id is string => id !== undefined)
  traceCombinedSignal(combined, [signal, signalB], traceFields)

  if (signal?.aborted) {
    requestAbort(combined, signal.reason, {
      ...traceFields,
      source: 'signal_a_already_aborted',
      parentControllerIds: parentIds,
      winningParentControllerId: getInterruptionSignalId(signal),
      causalEventId: getInterruptionSignalAbortEventId(signal),
    })
    return { signal: combined.signal, cleanup: () => {} }
  }
  if (signalB?.aborted) {
    requestAbort(combined, signalB.reason, {
      ...traceFields,
      source: 'signal_b_already_aborted',
      parentControllerIds: parentIds,
      winningParentControllerId: getInterruptionSignalId(signalB),
      causalEventId: getInterruptionSignalAbortEventId(signalB),
    })
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    signal?.removeEventListener('abort', abortFromSignal)
    signalB?.removeEventListener('abort', abortFromSignalB)
    traceInterruptionEvent('combined_signal.cleanup', traceFields)
  }
  const abortCombined = (
    reason: unknown,
    source: string,
    winningParent?: AbortSignal,
  ) => {
    cleanup()
    requestAbort(combined, reason, {
      ...traceFields,
      source,
      parentControllerIds: parentIds,
      winningParentControllerId: winningParent
        ? getInterruptionSignalId(winningParent)
        : undefined,
      causalEventId: winningParent
        ? getInterruptionSignalAbortEventId(winningParent)
        : undefined,
    })
  }
  const abortFromSignal = () =>
    abortCombined(signal?.reason, 'signal_a', signal)
  const abortFromSignalB = () =>
    abortCombined(signalB?.reason, 'signal_b', signalB)
  const abortFromTimeout = () =>
    abortCombined(
      new DOMException('The operation timed out.', 'TimeoutError'),
      'timeout',
    )

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortFromTimeout, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortFromSignal)
  signalB?.addEventListener('abort', abortFromSignalB)

  return { signal: combined.signal, cleanup }
}
