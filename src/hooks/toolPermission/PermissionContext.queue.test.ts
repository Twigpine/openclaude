import { describe, expect, test } from 'bun:test'
import type { Dispatch, SetStateAction } from 'react'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import { asAgentId, asSessionId } from '../../types/ids.js'
import { createPermissionQueueOps } from './PermissionContext.js'

function queueItem(
  permissionSessionId: ReturnType<typeof asSessionId>,
  agentId: ReturnType<typeof asAgentId>,
  label: string,
): ToolUseConfirm {
  return {
    toolUseID: 'shared-tool-id',
    permissionSessionId,
    toolUseContext: { agentId },
    label,
  } as unknown as ToolUseConfirm
}

describe('permission queue identity', () => {
  test('remove and update qualify duplicate tool IDs by owner and agent', () => {
    const sessionA = asSessionId('session-a')
    const sessionB = asSessionId('session-b')
    const agentA = asAgentId('agent-a')
    const agentB = asAgentId('agent-b')
    let queue = [
      queueItem(sessionA, agentA, 'a'),
      queueItem(sessionA, agentB, 'b'),
      queueItem(sessionB, agentA, 'c'),
    ]
    const setQueue: Dispatch<SetStateAction<ToolUseConfirm[]>> = update => {
      queue = typeof update === 'function' ? update(queue) : update
    }
    const ops = createPermissionQueueOps(setQueue)

    ops.update('shared-tool-id', sessionA, agentA, {
      classifierCheckInProgress: true,
    })
    expect(queue[0]?.classifierCheckInProgress).toBe(true)
    expect(queue[1]?.classifierCheckInProgress).toBeUndefined()
    expect(queue[2]?.classifierCheckInProgress).toBeUndefined()

    ops.remove('shared-tool-id', sessionA, agentB)
    expect(queue).toHaveLength(2)
    expect(queue.map(item => item.toolUseContext.agentId)).toEqual([
      agentA,
      agentA,
    ])
  })
})
