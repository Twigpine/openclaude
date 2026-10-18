import {
  requestAbort,
  traceInterruptionEvent,
} from '../utils/interruptionTrace.js'

export type PrintModeControlAbortSource =
  | 'sdk_control_interrupt'
  | 'sdk_end_session'

export function abortPrintModeControlRequest(
  queryController: AbortController | undefined,
  suggestionController: AbortController | null,
  source: PrintModeControlAbortSource,
  queryReason: unknown,
): string | undefined {
  const causalEventId = traceInterruptionEvent(`input.${source}`, {
    source,
    subsystem: 'print_mode',
  })
  if (queryController && !queryController.signal.aborted) {
    requestAbort(queryController, queryReason, {
      source,
      causalEventId,
      subsystem: 'print_mode',
      controllerRole: 'query-root',
    })
  }
  if (suggestionController && !suggestionController.signal.aborted) {
    requestAbort(suggestionController, undefined, {
      source,
      causalEventId,
      subsystem: 'prompt_suggestion',
      controllerRole: 'speculation',
    })
  }
  return causalEventId
}
