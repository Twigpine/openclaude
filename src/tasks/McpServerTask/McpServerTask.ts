// McpServerTask — task registry entry for the 'mcp_server' type.
//
// An MCP server may run a tools/call as a durable task (the tasks utility
// from the MCP spec). When it does, services/mcp/tasks.ts registers one of
// these in AppState and polls tasks/get until a terminal status. The model
// gets a "task started" tool result immediately and the real result arrives
// through the same task-notification machinery as local background tasks.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { logForDebugging } from '../../utils/debug.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'

export type McpServerTaskState = TaskStateBase & {
  type: 'mcp_server'
  /** MCP server config name that owns the remote task. */
  mcpServerName: string
  /** Tool name as the server knows it (without the mcp__ prefix). */
  mcpToolName: string
  /** Task id assigned by the MCP server, used for tasks/get/result/cancel. */
  mcpTaskId: string
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
    updateTaskState<McpServerTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running' && task.status !== 'pending') {
        return task
      }
      return {
        ...task,
        status: 'killed',
        notified: true,
        endTime: Date.now(),
      }
    })
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
