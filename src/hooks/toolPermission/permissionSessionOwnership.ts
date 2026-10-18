import { getSessionId } from '../../bootstrap/state.js'
import type { SessionId } from '../../types/ids.js'
import type { PermissionDenyDecision } from '../../types/permissions.js'

export function isPermissionSessionActive(
  permissionSessionId: SessionId | undefined,
  activeSessionId: SessionId = getSessionId(),
): boolean {
  return (
    permissionSessionId === undefined ||
    permissionSessionId === activeSessionId
  )
}

/**
 * Keep reading live state while the owning session is active, then retain the
 * last owner-visible state while another session is displayed. Background
 * agents can continue evaluating terminal permission rules without borrowing
 * the newly active session's policy.
 */
export function createPermissionSessionStateGetter<T>(
  permissionSessionId: SessionId | undefined,
  initialState: T,
  getLiveState: () => T,
  getActiveSessionId: () => SessionId = getSessionId,
): () => T {
  let ownedState = initialState
  return () => {
    if (
      permissionSessionId === undefined ||
      permissionSessionId === getActiveSessionId()
    ) {
      ownedState = getLiveState()
    }
    return ownedState
  }
}

export function buildInactivePermissionSessionDecision(): PermissionDenyDecision {
  return {
    behavior: 'deny',
    message:
      'Permission denied because the agent\'s originating session is not active.',
    decisionReason: {
      type: 'asyncAgent',
      reason: 'originating session is not active',
    },
  }
}
