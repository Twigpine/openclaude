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
  markMcpServerTaskTerminal,
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
import type { AgentId } from '../../types/ids.js'
import type { ConnectedMCPServer } from './types.js'

const MIN_POLL_INTERVAL_MS = 1000
const DEFAULT_POLL_INTERVAL_MS = 2000
const MAX_POLL_INTERVAL_MS = 60000
// Bound on a tasks/result fetch after a terminal status. Explicit rather than
// the SDK default so the limit stays ours if that default changes.
const RESULT_FETCH_TIMEOUT_MS = 60000

export function isMcpTaskBackgroundingDisabled(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND)
}

// ---------------------------------------------------------------------------
// Task-capable tool bookkeeping
//
// tools/list entries carry execution.taskSupport ('optional' | 'required' |
// 'forbidden'). fetchToolsForClient records it here per connection (keyed by
// the SDK Client, so a discovery run on a superseded connection cannot touch
// the entry of the connection that replaced it); callMCPTool checks it to
// decide between plain callTool and a task-augmented request.
// ---------------------------------------------------------------------------

type McpToolTaskSupport = 'optional' | 'required'

let taskSupportByClient = new WeakMap<
  Client,
  Map<string, McpToolTaskSupport>
>()

export function recordMcpToolTaskSupport(
  connection: ConnectedMCPServer,
  tools: readonly { name: string; execution?: { taskSupport?: string } }[],
): void {
  const supported = new Map<string, McpToolTaskSupport>()
  for (const tool of tools) {
    const taskSupport = tool.execution?.taskSupport
    if (taskSupport === 'optional' || taskSupport === 'required') {
      supported.set(tool.name, taskSupport)
    }
  }
  taskSupportByClient.set(connection.client, supported)
}

/** Forget a connection's recorded support after a failed discovery. */
export function clearMcpToolTaskSupport(connection: ConnectedMCPServer): void {
  taskSupportByClient.delete(connection.client)
}

/**
 * True when the server advertises task-augmented tools/call and the env
 * opt-out is unset. Only then does a call need tool discovery to decide
 * between the plain and the task-augmented path.
 */
export function mcpServerAdvertisesTaskTools(
  connection: ConnectedMCPServer,
): boolean {
  if (isMcpTaskBackgroundingDisabled()) {
    return false
  }
  const serverTasks = connection.capabilities?.tasks as
    | { requests?: { tools?: { call?: unknown } } }
    | undefined
  return !!serverTasks?.requests?.tools?.call
}

/**
 * True when the server advertises task-augmented tools/call but no successful
 * tools/list has recorded support for this connection, so the answer from
 * mcpTaskSupportForTool is "unknown", not "none".
 */
export function isMcpToolTaskSupportUnknown(
  connection: ConnectedMCPServer,
): boolean {
  return (
    mcpServerAdvertisesTaskTools(connection) &&
    !taskSupportByClient.has(connection.client)
  )
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
  if (!mcpServerAdvertisesTaskTools(connection)) {
    return undefined
  }
  return taskSupportByClient.get(connection.client)?.get(toolName)
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
// Remote task ids are unique per server, not across servers, so the lookup
// is keyed by both.
const localIdByMcpTaskId = new Map<string, string>()

function mcpTaskKey(serverName: string, mcpTaskId: string): string {
  return JSON.stringify([serverName, mcpTaskId])
}

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
  agentId?: AgentId
  setAppState: SetAppState
}): string {
  const { connection, task, toolName, description, toolUseId, agentId, setAppState } = opts
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
    agentId,
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
  localIdByMcpTaskId.set(mcpTaskKey(connection.name, task.taskId), localTaskId)

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
      await finalizeMcpServerTask(
        localTaskId,
        status.status,
        status.statusMessage,
        true,
      )
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


/**
 * Terminal transition, single-flight across the poll loop, status
 * notifications, kill, and disconnect paths. Deleting the tracked entry
 * before the awaits makes repeat calls no-ops.
 */
async function finalizeMcpServerTask(
  localTaskId: string,
  status: 'completed' | 'failed' | 'cancelled',
  statusMessage?: string,
  // True when the server itself reported the terminal status, so a stored
  // tasks/result may exist. Locally generated terminals (poll errors, kill)
  // never ask the server for one.
  serverReported = false,
): Promise<void> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry || entry.finalized) return
  entry.finalized = true
  entry.abort.abort()
  trackedByLocalId.delete(localTaskId)
  localIdByMcpTaskId.delete(mcpTaskKey(entry.serverName, entry.mcpTaskId))

  if (status === 'completed') {
    try {
      const result = await entry.client.experimental.tasks.getTaskResult(
        entry.mcpTaskId,
        CallToolResultSchema,
        { timeout: RESULT_FETCH_TIMEOUT_MS },
      )
      appendTaskOutput(localTaskId, jsonStringify(result, null, 2) ?? '')
      await flushTaskOutput(localTaskId)
      // CallToolResult.isError marks a tool execution error reported as a
      // successful task completion; it is a failure for the UI and the
      // notification, same as the synchronous path treats it.
      if (result.isError) {
        const errorText = result.content?.find(
          block => block.type === 'text' && 'text' in block,
        )
        markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
          statusMessage:
            errorText && 'text' in errorText
              ? errorText.text
              : 'MCP tool reported an error',
        })
      } else {
        markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'completed')
      }
    } catch (e) {
      const message = `Task completed but tasks/result failed: ${e instanceof Error ? e.message : String(e)}`
      logForDebugging(`[MCP] ${message}`)
      appendTaskOutput(localTaskId, message)
      await flushTaskOutput(localTaskId)
      markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
        statusMessage: message,
      })
    }
    return
  }

  // Server-reported failed or cancelled: the server may keep diagnostic
  // content under tasks/result. Fetch it best-effort; the statusMessage
  // stays the fallback, and the local terminal state does not depend on it.
  let payload: string | undefined
  if (serverReported) {
    try {
      const result = await entry.client.experimental.tasks.getTaskResult(
        entry.mcpTaskId,
        CallToolResultSchema,
        { timeout: RESULT_FETCH_TIMEOUT_MS },
      )
      payload = jsonStringify(result, null, 2) || undefined
    } catch (e) {
      logForDebugging(
        `[MCP] tasks/result for ${status} task ${entry.mcpTaskId} unavailable: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  if (status === 'failed') {
    const message = statusMessage ?? 'MCP server reported task failure'
    appendTaskOutput(
      localTaskId,
      payload === undefined ? message : `${message}\n${payload}`,
    )
    await flushTaskOutput(localTaskId)
    markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
      statusMessage: message,
    })
    return
  }

  if (payload !== undefined) {
    appendTaskOutput(localTaskId, payload)
    await flushTaskOutput(localTaskId)
  }
  markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'killed', {
    statusMessage,
  })
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
  const localTaskId = localIdByMcpTaskId.get(
    mcpTaskKey(serverName, params.taskId),
  )
  if (!localTaskId) return
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry || entry.serverName !== serverName || entry.finalized) return

  applyMcpTaskStatusMessage(localTaskId, params.statusMessage)
  if (
    params.status === 'completed' ||
    params.status === 'failed' ||
    params.status === 'cancelled'
  ) {
    void finalizeMcpServerTask(
      localTaskId,
      params.status,
      params.statusMessage,
      true,
    )
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
  } catch (e) {
    // The server refused (for example it does not implement tasks/cancel),
    // so the task may still be running there. Keep tracking it, say why the
    // stop did not take, and let the caller leave it running and retryable.
    const reason = `Cancel request failed (tasks/cancel): ${e instanceof Error ? e.message : String(e)}`
    applyMcpTaskStatusMessage(localTaskId, reason)
    throw e
  }
  await finalizeMcpServerTask(localTaskId, 'cancelled')
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
    localIdByMcpTaskId.delete(mcpTaskKey(entry.serverName, entry.mcpTaskId))
    appendTaskOutput(localTaskId, reason)
    // Flush before the terminal mark so the notification's output-file is
    // readable by the time the model can consume it.
    void (async () => {
      try {
        await flushTaskOutput(localTaskId)
      } catch (e) {
        logForDebugging(`[MCP] task output flush failed: ${e}`)
      }
      markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
        statusMessage: reason,
      })
    })()
  }
}

/** Test hook: drop all tracking state. */
export function _resetMcpServerTasksForTest(): void {
  for (const entry of trackedByLocalId.values()) {
    entry.abort.abort()
  }
  trackedByLocalId.clear()
  localIdByMcpTaskId.clear()
  taskSupportByClient = new WeakMap()
}
