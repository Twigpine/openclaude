import {
  requestAbort,
  traceInterruptionEvent,
} from '../../utils/interruptionTrace.js'

export function abortApprovedInProcessTeammate(
  controller: AbortController,
  identity: { agentId: string },
): void {
  const causalEventId = traceInterruptionEvent('teammate.shutdown_approved', {
    source: 'shutdown_approved',
    subsystem: 'in_process_teammate',
    controllerRole: 'subagent-lifecycle',
    subagentId: identity.agentId,
  })
  requestAbort(controller, undefined, {
    source: 'shutdown_approved',
    subsystem: 'in_process_teammate',
    controllerRole: 'subagent-lifecycle',
    subagentId: identity.agentId,
    causalEventId,
  })
}
