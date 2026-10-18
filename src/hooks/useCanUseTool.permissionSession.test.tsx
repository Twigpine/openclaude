import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, expect, test } from 'bun:test'
import React from 'react'
import { getSessionId, switchSession } from '../bootstrap/state.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { createRoot, Text } from '../ink.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../test/sharedMutationLock.js'
import type { Tool, ToolUseContext } from '../Tool.js'
import { asSessionId } from '../types/ids.js'
import type { AssistantMessage } from '../types/message.js'
import type { PermissionDecision } from '../utils/permissions/PermissionResult.js'
import useCanUseTool, { type CanUseToolFn } from './useCanUseTool.js'

let canUseTool: CanUseToolFn | undefined

function HookProbe({
  setQueue,
}: {
  setQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
}) {
  canUseTool = useCanUseTool(setQueue, () => {})
  return React.createElement(Text, null, 'probe')
}

function createTestStreams() {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
    ref: () => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  ;(stdout as unknown as { columns: number }).columns = 120
  return { stdout, stdin }
}

beforeEach(async () => {
  await acquireSharedMutationLock('hooks/useCanUseTool.permissionSession.test.tsx')
  canUseTool = undefined
})

afterEach(() => {
  releaseSharedMutationLock()
})

test('queues an owner-session ask first reached while another session is active', async () => {
  const ownerSessionId = getSessionId()
  const tool = {
    name: 'DeferredOwnerTool',
    description: async () => 'needs owner approval',
    requiresUserInteraction: () => false,
  } as unknown as Tool
  const appState = getDefaultAppState()
  const abortController = new AbortController()
  const toolUseContext = {
    options: {
      permissionSessionId: ownerSessionId,
      isNonInteractiveSession: false,
      tools: [tool],
    },
    abortController,
    getAppState: () => appState,
  } as unknown as ToolUseContext
  const assistantMessage = {
    message: { id: 'deferred-owner-message' },
  } as unknown as AssistantMessage
  let queue: ToolUseConfirm[] = []
  const setQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>> =
    update => {
      queue = typeof update === 'function' ? update(queue) : update
    }
  const { stdout, stdin } = createTestStreams()
  const root = await createRoot({
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    patchConsole: false,
  })
  root.render(React.createElement(HookProbe, { setQueue }))
  await Bun.sleep(10)

  try {
    switchSession(asSessionId('different-active-session'))
    const decisionPromise = canUseTool?.(
      tool,
      {},
      toolUseContext,
      assistantMessage,
      'deferred-owner-tool-use',
      { behavior: 'ask' } as PermissionDecision,
    )

    await Bun.sleep(10)
    expect(queue).toHaveLength(1)
    expect(queue[0]?.permissionSessionId).toBe(ownerSessionId)

    switchSession(ownerSessionId)
    const approvalPromise = queue[0]?.onAllow({}, [])
    switchSession(asSessionId('switched-during-owner-approval'))
    await approvalPromise
    await expect(decisionPromise).resolves.toMatchObject({ behavior: 'allow' })
  } finally {
    switchSession(ownerSessionId)
    root.unmount()
  }
})
