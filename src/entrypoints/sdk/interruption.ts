import { requestAbort } from '../../utils/interruptionTrace.js'

export function requestSdkRootAbort(
  controller: AbortController,
  source: string,
  subsystem: 'sdk_query' | 'sdk_session',
): void {
  if (controller.signal.aborted) return
  requestAbort(controller, undefined, {
    source,
    subsystem,
    controllerRole: 'query-root',
  })
}
