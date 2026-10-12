/**
 * Pure delete-guard decisions for the resume picker.
 *
 * Extracted so the safety-critical branches (never delete the active
 * session file, never orphan a live background session) are unit-testable
 * without mounting the Ink tree.
 */

/** Message shown when deletion is blocked, or null when deletion may proceed. */
export function getDeleteBlockReason(
  targetSessionId: string | undefined,
  activeSessionId: string,
  bgRunningSessionIds: ReadonlySet<string>,
): string | null {
  if (!targetSessionId) {
    return 'Cannot determine the session id for this entry.'
  }
  if (targetSessionId === activeSessionId) {
    return 'Cannot delete the active session.'
  }
  if (bgRunningSessionIds.has(targetSessionId)) {
    return 'Stop the background session first before deleting.'
  }
  return null
}
