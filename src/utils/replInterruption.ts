import { requestAbort, traceInterruptionEvent } from './interruptionTrace.js'

type AbortControllerRef = { readonly current: AbortController | null }

export function requestBridgeInterrupt(ref: AbortControllerRef): void {
  const controller = ref.current
  const causalEventId = traceInterruptionEvent('input.bridge_interrupt', {
    source: 'bridge_interrupt',
    subsystem: 'repl_bridge',
  })
  if (!controller) return
  requestAbort(controller, 'interrupt', {
    source: 'bridge_interrupt',
    subsystem: 'repl_bridge',
    controllerRole: 'query-root',
    causalEventId,
  })
}

export function requestBackgroundHandoffAbort(
  controller: AbortController | null,
): void {
  if (!controller) return
  requestAbort(controller, 'background', {
    source: 'background_handoff',
    subsystem: 'repl',
    controllerRole: 'query-root',
  })
}

export function requestPriorityNowAbort(ref: AbortControllerRef): void {
  const controller = ref.current
  if (!controller) return
  requestAbort(controller, 'interrupt', {
    source: 'priority_now',
    subsystem: 'repl',
    controllerRole: 'query-root',
  })
}
