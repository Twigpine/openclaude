import { describe, expect, test } from 'bun:test'
import {
  dedupeQueuedTaskNotifications,
  filterClaimedTaskNotificationsForRestore,
  getTaskNotificationDedupKey,
  parseTaskNotificationTaskId,
  pendingCommandsForEmbeddedNotifications,
} from './taskNotificationIdentity.js'
import { createAttachmentMessage } from './attachments.js'

function taskNotification(taskId: string, summary: string): string {
  return `<task-notification>
<task-id>${taskId}</task-id>
<output-file>/tmp/${taskId}.jsonl</output-file>
<status>completed</status>
<summary>${summary}</summary>
</task-notification>`
}

describe('task notification identity', () => {
  test('parses the embedded task id from notification payloads', () => {
    expect(parseTaskNotificationTaskId(taskNotification('sabc1234', 'done'))).toBe(
      'sabc1234',
    )
    expect(parseTaskNotificationTaskId('no task id here')).toBeUndefined()
  })

  test('dedup keys stay distinct when summary text matches', () => {
    const summary = 'Background session "work" completed'
    const first = taskNotification('s1111111', summary)
    const second = taskNotification('s2222222', summary)

    expect(getTaskNotificationDedupKey(first)).toBe('s1111111')
    expect(getTaskNotificationDedupKey(second)).toBe('s2222222')
    expect(getTaskNotificationDedupKey(first)).not.toBe(
      getTaskNotificationDedupKey(second),
    )
  })

  test('falls back to full content when no task id is present', () => {
    const payload = '<task-notification><summary>hook</summary></task-notification>'
    expect(getTaskNotificationDedupKey(payload)).toBe(payload)
  })

  test('dedupes duplicate task ids within a claimed notification batch', () => {
    const summary = 'Background session "work" completed'
    const first = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: taskNotification('s1111111', summary),
    })
    const duplicate = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: taskNotification('s1111111', summary),
    })
    const distinct = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: taskNotification('s2222222', summary),
    })

    expect(
      dedupeQueuedTaskNotifications([], [first, duplicate, distinct]),
    ).toEqual([first, distinct])
  })

  test('restore excludes notifications already present in the settled transcript', () => {
    const summary = 'Background session "work" completed'
    const settledPrompt = taskNotification('s1111111', summary)
    const settled = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: settledPrompt,
    })
    const pending = [
      {
        value: settledPrompt,
        mode: 'task-notification' as const,
        priority: 'later' as const,
      },
      {
        value: taskNotification('s2222222', summary),
        mode: 'task-notification' as const,
        priority: 'later' as const,
      },
    ]

    expect(
      filterClaimedTaskNotificationsForRestore(pending, [settled]),
    ).toEqual([pending[1]])
  })

  test('restore maps embedded successor notifications back to claimed commands', () => {
    const summary = 'Background session "work" completed'
    const first = {
      value: taskNotification('s1111111', summary),
      mode: 'task-notification' as const,
      priority: 'later' as const,
    }
    const second = {
      value: taskNotification('s2222222', summary),
      mode: 'task-notification' as const,
      priority: 'later' as const,
    }
    const embedded = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt: first.value,
    })

    expect(
      pendingCommandsForEmbeddedNotifications([first, second], [embedded]),
    ).toEqual([first])
  })

  test('does not dedupe non-task-notification queued commands in the batch', () => {
    const prompt = taskNotification('s1111111', 'done')
    const taskAttachment = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'task-notification',
      prompt,
    })
    const promptAttachment = createAttachmentMessage({
      type: 'queued_command',
      commandMode: 'prompt',
      prompt,
    })

    expect(dedupeQueuedTaskNotifications([], [taskAttachment, promptAttachment])).toEqual(
      [taskAttachment, promptAttachment],
    )
  })
})
