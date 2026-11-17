// McpServerTask — task registry entry for the 'mcp_server' type.
//
// An MCP server may run a tools/call as a durable task (the tasks utility
// from the MCP spec). When it does, services/mcp/tasks.ts registers one of
// these in AppState and polls tasks/get until a terminal status. The model
// gets a "task started" tool result immediately and the real result arrives
// through the same task-notification machinery as local background tasks.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TOOL_USE_ID_TAG,
} from '../../constants/xml.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import {
  evictTaskOutput,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'

export type McpServerTaskState = TaskStateBase & {
  type: 'mcp_server'
  /** MCP server config name that owns the remote task. */
  mcpServerName: string
  /** Tool name as the server knows it (without the mcp__ prefix). */
  mcpToolName: string
  /** Task id assigned by the MCP server, used for tasks/get/result/cancel. */
  mcpTaskId: string
  /** Agent that initiated the tool call, for addressed notifications. */
  agentId?: AgentId
  /** Last statusMessage reported by the server, if any. */
  statusMessage?: string
}

export function isMcpServerTask(task: unknown): task is McpServerTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'mcp_server'
  )
}

/**
 * tasks/cancel goes through the live MCP connection, which only the
 * services/mcp layer can reach. It registers this hook when tracking
 * starts; before that there is nothing server-side to cancel.
 */
let cancelHook: ((localTaskId: string) => Promise<void>) | undefined

export function registerMcpServerTaskCanceler(
  fn: (localTaskId: string) => Promise<void>,
): void {
  cancelHook = fn
}

function mcpTerminalSummary(
  description: string,
  status: 'completed' | 'failed' | 'killed',
  statusMessage?: string,
): string {
  switch (status) {
    case 'completed':
      return `MCP server task "${description}" completed`
    case 'failed':
      return `MCP server task "${description}" failed${statusMessage ? `: ${statusMessage}` : ''}`
    case 'killed':
      return `MCP server task "${description}" was stopped`
  }
}

/**
 * Terminal transition plus model notification, in one step. The status
 * update only applies from a non-terminal state, so a user kill landing
 * while a tasks/result fetch is in flight is not overwritten by the late
 * result. The notified flag is claimed inside the same update, so exactly
 * one task-notification is enqueued across the poll loop, status
 * notifications, kill, and disconnect paths.
 */
export function markMcpServerTaskTerminal(
  taskId: string,
  setAppState: SetAppState,
  status: 'completed' | 'failed' | 'killed',
  opts?: { statusMessage?: string; summary?: string },
): void {
  let notify:
    | { description: string; toolUseId?: string; agentId?: AgentId }
    | undefined
  updateTaskState<McpServerTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' && task.status !== 'pending') {
      return task
    }
    if (!task.notified) {
      notify = {
        description: task.description,
        toolUseId: task.toolUseId,
        agentId: task.agentId,
      }
    }
    return {
      ...task,
      status,
      statusMessage: opts?.statusMessage ?? task.statusMessage,
      notified: true,
      endTime: Date.now(),
    }
  })
  if (!notify) return
  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = notify.toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${notify.toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const summary =
    opts?.summary ??
    mcpTerminalSummary(notify.description, status, opts?.statusMessage)
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'later',
    agentId: notify.agentId,
  })
}

export const McpServerTask: Task = {
  name: 'McpServerTask',
  type: 'mcp_server',
  async kill(taskId, setAppState) {
    try {
      await cancelHook?.(taskId)
    } catch (e) {
      logForDebugging(
        `mcp_server task ${taskId} cancel request failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    markMcpServerTaskTerminal(taskId, setAppState, 'killed')
    void evictTaskOutput(taskId)
  },
}

/**
 * Stop a running mcp_server task. Used by the background tasks dialog
 * ('x' shortcut and detail-view kill button).
 */
export function killMcpServerTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  void McpServerTask.kill(taskId, setAppState)
}
