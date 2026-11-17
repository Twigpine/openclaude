// Server-initiated MCP tasks (the tasks utility from the MCP spec).
//
// A server that advertises capabilities.tasks.requests.tools.call may answer
// a task-augmented tools/call with a CreateTaskResult instead of a tool
// result. This module registers that remote task as a local 'mcp_server'
// background task, polls tasks/get until a terminal status, fetches the
// result through tasks/result, and delivers it through the existing task
// notification machinery.
//
// Experimental surface: the task APIs live under client.experimental.tasks
// in @modelcontextprotocol/sdk and may change across SDK versions.

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CallToolResultSchema,
  type Task as McpTask,
  type TaskStatusNotificationParams,
} from '@modelcontextprotocol/sdk/types.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { SetAppState } from '../../Task.js'
import {
  type McpServerTaskState,
  registerMcpServerTaskCanceler,
} from '../../tasks/McpServerTask/McpServerTask.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { sleep } from '../../utils/sleep.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  appendTaskOutput,
  flushTaskOutput,
} from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import type { ConnectedMCPServer } from './types.js'

const MIN_POLL_INTERVAL_MS = 1000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_POLL_INTERVAL_MS = 60000

export function isMcpTaskBackgroundingDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND)
}

// ---------------------------------------------------------------------------
// Task-capable tool bookkeeping
//
// tools/list entries carry execution.taskSupport ('optional' | 'required' |
// 'forbidden'). fetchToolsForClient records it here per server; callMCPTool
// checks it to decide between plain callTool and a task-augmented request.
// ---------------------------------------------------------------------------

type McpToolTaskSupport = 'optional' | 'required'

const taskSupportByServer = new Map<string, Map<string, McpToolTaskSupport>>()

export function recordMcpToolTaskSupport(
  serverName: string,
  tools: readonly { name: string; execution?: { taskSupport?: string } }[],
): void {
  const supported = new Map<string, McpToolTaskSupport>()
  for (const tool of tools) {
    const taskSupport = tool.execution?.taskSupport
    if (taskSupport === 'optional' || taskSupport === 'required') {
      supported.set(tool.name, taskSupport)
    }
  }
  taskSupportByServer.set(serverName, supported)
}

export function clearMcpToolTaskSupport(serverName: string): void {
  taskSupportByServer.delete(serverName)
}

/**
 * Task support for a tool call, or undefined when the call must take the
 * normal tools/call path. Requires the server to advertise
 * tasks.requests.tools.call, the tool to declare execution.taskSupport, and
 * the env opt-out to be unset.
 */
export function mcpTaskSupportForTool(
  connection: ConnectedMCPServer,
  toolName: string,
): McpToolTaskSupport | undefined {
  if (isMcpTaskBackgroundingDisabled()) {
    return undefined
  }
  const serverTasks = connection.capabilities?.tasks as
    | { requests?: { tools?: { call?: unknown } } }
    | undefined
  if (!serverTasks?.requests?.tools?.call) {
    return undefined
  }
  return taskSupportByServer.get(connection.name)?.get(toolName)
}

// ---------------------------------------------------------------------------
// Tracked tasks
// ---------------------------------------------------------------------------

type TrackedMcpServerTask = {
  client: Client
  serverName: string
  toolName: string
  mcpTaskId: string
  setAppState: SetAppState
  abort: AbortController
  finalized: boolean
}

const trackedByLocalId = new Map<string, TrackedMcpServerTask>()
const localIdByMcpTaskId = new Map<string, string>()

/**
 * Register a server-created MCP task as a local background task and start
 * polling. Returns the local task id for the "task started" tool result.
 */
export function trackMcpServerTask(opts: {
  connection: ConnectedMCPServer
  task: McpTask
  toolName: string
  description: string
  toolUseId?: string
  setAppState: SetAppState
}): string {
  const { connection, task, toolName, description, toolUseId, setAppState } = opts
  const localTaskId = generateTaskId('mcp_server')

  // Register the kill hook lazily: a module-level call races the circular
  // McpServerTask -> framework import chain and hits a TDZ error.
  registerMcpServerTaskCanceler(cancelMcpServerTask)

  const state: McpServerTaskState = {
    ...createTaskStateBase(localTaskId, 'mcp_server', description, toolUseId),
    type: 'mcp_server',
    status: 'running',
    mcpServerName: connection.name,
    mcpToolName: toolName,
    mcpTaskId: task.taskId,
    statusMessage: task.statusMessage,
  }
  registerTask(state, setAppState)

  const entry: TrackedMcpServerTask = {
    client: connection.client,
    serverName: connection.name,
    toolName,
    mcpTaskId: task.taskId,
    setAppState,
    abort: new AbortController(),
    finalized: false,
  }
  trackedByLocalId.set(localTaskId, entry)
  localIdByMcpTaskId.set(task.taskId, localTaskId)

  logForDebugging(
    `[MCP] tracking server task ${task.taskId} as local task ${localTaskId} (tool ${toolName} on ${connection.name})`,
  )
  void pollMcpServerTask(localTaskId, task)
  return localTaskId
}

function clampPollInterval(interval: number | undefined): number {
  if (interval === undefined || !Number.isFinite(interval)) {
    return DEFAULT_POLL_INTERVAL_MS
  }
  return Math.min(Math.max(interval, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS)
}

async function pollMcpServerTask(
  localTaskId: string,
  initialTask: McpTask,
): Promise<void> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry) return

  let delay = clampPollInterval(initialTask.pollInterval)
  while (!entry.abort.signal.aborted && !entry.finalized) {
    await sleep(delay, entry.abort.signal)
    if (entry.abort.signal.aborted || entry.finalized) {
      return
    }

    let status: McpTask
    try {
      status = (await entry.client.experimental.tasks.getTask(
        entry.mcpTaskId,
        { signal: entry.abort.signal },
      )) as McpTask
    } catch (e) {
      if (entry.abort.signal.aborted) {
        return
      }
      logForDebugging(
        `[MCP] tasks/get for ${entry.mcpTaskId} failed: ${e instanceof Error ? e.message : String(e)}`,
      )
      await finalizeMcpServerTask(
        localTaskId,
        'failed',
        `Lost contact with MCP server task: ${e instanceof Error ? e.message : String(e)}`,
      )
      return
    }

    delay = clampPollInterval(status.pollInterval)
    applyMcpTaskStatusMessage(localTaskId, status.statusMessage)

    if (
      status.status === 'completed' ||
      status.status === 'failed' ||
      status.status === 'cancelled'
    ) {
      await finalizeMcpServerTask(localTaskId, status.status, status.statusMessage)
      return
    }
  }
}

function applyMcpTaskStatusMessage(
  localTaskId: string,
  statusMessage: string | undefined,
): void {
  if (statusMessage === undefined) return
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry) return
  updateTaskState<McpServerTaskState>(localTaskId, entry.setAppState, task =>
    task.statusMessage === statusMessage ? task : { ...task, statusMessage },
  )
}

function markMcpTaskTerminal(
  localTaskId: string,
  entry: TrackedMcpServerTask,
  status: McpServerTaskState['status'],
  statusMessage?: string,
): void {
  updateTaskState<McpServerTaskState>(localTaskId, entry.setAppState, task => ({
    ...task,
    status,
    statusMessage: statusMessage ?? task.statusMessage,
    notified: true,
    endTime: Date.now(),
  }))
}

/**
 * Terminal transition, single-flight across the poll loop, status
 * notifications, kill, and disconnect paths. Deleting the tracked entry
 * before the awaits makes repeat calls no-ops.
 */
async function finalizeMcpServerTask(
  localTaskId: string,
  status: 'completed' | 'failed' | 'cancelled',
  statusMessage?: string,
): Promise<void> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry || entry.finalized) return
  entry.finalized = true
  entry.abort.abort()
  trackedByLocalId.delete(localTaskId)
  localIdByMcpTaskId.delete(entry.mcpTaskId)

  if (status === 'completed') {
    try {
      const result = await entry.client.experimental.tasks.getTaskResult(
        entry.mcpTaskId,
        CallToolResultSchema,
      )
      appendTaskOutput(localTaskId, jsonStringify(result, null, 2) ?? '')
      await flushTaskOutput(localTaskId)
      markMcpTaskTerminal(localTaskId, entry, 'completed')
    } catch (e) {
      const message = `Task completed but tasks/result failed: ${e instanceof Error ? e.message : String(e)}`
      logForDebugging(`[MCP] ${message}`)
      appendTaskOutput(localTaskId, message)
      await flushTaskOutput(localTaskId)
      markMcpTaskTerminal(localTaskId, entry, 'failed', message)
    }
    return
  }

  if (status === 'failed') {
    const message = statusMessage ?? 'MCP server reported task failure'
    appendTaskOutput(localTaskId, message)
    await flushTaskOutput(localTaskId)
    markMcpTaskTerminal(localTaskId, entry, 'failed', message)
    return
  }

  markMcpTaskTerminal(localTaskId, entry, 'killed', statusMessage)
}

/**
 * Eager update from a notifications/tasks/status message. The poll loop
 * stays the reliable path; this just shortens the latency when the server
 * pushes updates.
 */
export function handleMcpTaskStatusNotification(
  serverName: string,
  params: TaskStatusNotificationParams,
): void {
  const localTaskId = localIdByMcpTaskId.get(params.taskId)
  if (!localTaskId) return
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry || entry.serverName !== serverName || entry.finalized) return

  applyMcpTaskStatusMessage(localTaskId, params.statusMessage)
  if (
    params.status === 'completed' ||
    params.status === 'failed' ||
    params.status === 'cancelled'
  ) {
    void finalizeMcpServerTask(localTaskId, params.status, params.statusMessage)
  }
}

/**
 * Kill path: tasks/cancel on the live connection. Registered as the
 * McpServerTask kill hook at module load.
 */
async function cancelMcpServerTask(localTaskId: string): Promise<void> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry || entry.finalized) return
  try {
    await entry.client.experimental.tasks.cancelTask(entry.mcpTaskId)
  } finally {
    await finalizeMcpServerTask(localTaskId, 'cancelled')
  }
}

/**
 * Connection closed before a tracked task reached a terminal status. The
 * remote task may still run server-side, but nothing can observe or cancel
 * it now, so the local task fails instead of wedging the task list.
 */
export function failMcpServerTasksForServer(
  serverName: string,
  reason: string,
): void {
  for (const [localTaskId, entry] of [...trackedByLocalId]) {
    if (entry.serverName !== serverName || entry.finalized) continue
    entry.finalized = true
    entry.abort.abort()
    trackedByLocalId.delete(localTaskId)
    localIdByMcpTaskId.delete(entry.mcpTaskId)
    appendTaskOutput(localTaskId, reason)
    void flushTaskOutput(localTaskId)
    markMcpTaskTerminal(localTaskId, entry, 'failed', reason)
  }
}

/** Test hook: drop all tracking state. */
export function _resetMcpServerTasksForTest(): void {
  for (const entry of trackedByLocalId.values()) {
    entry.abort.abort()
  }
  trackedByLocalId.clear()
  localIdByMcpTaskId.clear()
  taskSupportByServer.clear()
}
