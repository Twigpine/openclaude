import { TASK_ID_TAG } from '../constants/xml.js'
import type { Message } from '../types/message.js'
import type { QueuedCommand } from '../types/textInputTypes.js'

const TASK_ID_PATTERN = new RegExp(
  `<${TASK_ID_TAG}>([^<]+)</${TASK_ID_TAG}>`,
)

/**
 * Parse the stable task id embedded in a task-notification payload.
 */
export function parseTaskNotificationTaskId(
  content: string,
): string | undefined {
  return content.match(TASK_ID_PATTERN)?.[1]
}

/**
 * Dedup key for task notifications. Prefer the embedded task id so distinct
 * tasks with identical summary text are not collapsed.
 */
export function getTaskNotificationDedupKey(content: string): string {
  return parseTaskNotificationTaskId(content) ?? content
}

function getQueuedCommandNotificationKey(
  command: QueuedCommand,
): string | undefined {
  if (typeof command.value !== 'string') return undefined
  return getTaskNotificationDedupKey(command.value)
}

function collectSettledNotificationKeys(
  settledMessages: readonly Message[],
): Set<string> {
  const existingNotificationKeys = new Set<string>()
  for (const message of settledMessages) {
    if (
      message.type === 'attachment' &&
      message.attachment.type === 'queued_command' &&
      message.attachment.commandMode === 'task-notification' &&
      typeof message.attachment.prompt === 'string'
    ) {
      existingNotificationKeys.add(
        getTaskNotificationDedupKey(message.attachment.prompt),
      )
    }
  }
  return existingNotificationKeys
}

/**
 * Claimed notifications already present in the settled foreground transcript
 * must not be restored to the queue on handoff abort.
 */
export function filterClaimedTaskNotificationsForRestore(
  pendingNotifications: readonly QueuedCommand[],
  settledMessages: readonly Message[],
): QueuedCommand[] {
  const existingNotificationKeys = collectSettledNotificationKeys(settledMessages)
  return pendingNotifications.filter(command => {
    const key = getQueuedCommandNotificationKey(command)
    return key === undefined || !existingNotificationKeys.has(key)
  })
}

/**
 * Map embedded handoff notification attachments back to their claimed queue
 * commands so restore only returns notifications actually woven into the
 * successor batch.
 */
export function pendingCommandsForEmbeddedNotifications(
  pendingNotifications: readonly QueuedCommand[],
  embeddedNotifications: readonly Message[],
): QueuedCommand[] {
  const embeddedKeys = new Set<string>()
  for (const message of embeddedNotifications) {
    if (
      message.type === 'attachment' &&
      message.attachment.type === 'queued_command' &&
      message.attachment.commandMode === 'task-notification' &&
      typeof message.attachment.prompt === 'string'
    ) {
      embeddedKeys.add(getTaskNotificationDedupKey(message.attachment.prompt))
    }
  }
  return pendingNotifications.filter(command => {
    const key = getQueuedCommandNotificationKey(command)
    return key !== undefined && embeddedKeys.has(key)
  })
}

export function dedupeQueuedTaskNotifications(
  settledMessages: readonly Message[],
  notificationMessages: readonly Message[],
): Message[] {
  const existingNotificationKeys = collectSettledNotificationKeys(settledMessages)
  return notificationMessages.filter(message => {
    if (
      message.type !== 'attachment' ||
      message.attachment.type !== 'queued_command' ||
      message.attachment.commandMode !== 'task-notification' ||
      typeof message.attachment.prompt !== 'string'
    ) {
      return true
    }
    const key = getTaskNotificationDedupKey(message.attachment.prompt)
    if (existingNotificationKeys.has(key)) {
      return false
    }
    existingNotificationKeys.add(key)
    return true
  })
}
