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
  ErrorCode,
  McpError,
  type Task as McpTask,
  type TaskStatusNotificationParams,
} from '@modelcontextprotocol/sdk/types.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import type { SetAppState } from '../../Task.js'
import {
  markMcpServerTaskTerminal,
  type McpServerTaskCancelOptions,
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
  // Newest server update time accepted so far (ms since epoch); a status
  // observation older than this is a late reply and is ignored.
  lastUpdatedAtMs: number
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
    lastUpdatedAtMs: parseTimeMs(task.lastUpdatedAt) ?? 0,
  }
  trackedByLocalId.set(localTaskId, entry)
  localIdByMcpTaskId.set(mcpTaskKey(connection.name, task.taskId), localTaskId)

  logForDebugging(
    `[MCP] tracking server task ${task.taskId} as local task ${localTaskId} (tool ${toolName} on ${connection.name})`,
  )
  void pollMcpServerTask(localTaskId, task)
  return localTaskId
}

function parseTimeMs(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? undefined : ms
}

function clampPollInterval(interval: number | undefined): number {
  if (interval === undefined || !Number.isFinite(interval)) {
    return DEFAULT_POLL_INTERVAL_MS
  }
  return Math.min(Math.max(interval, MIN_POLL_INTERVAL_MS), MAX_POLL_INTERVAL_MS)
}

// The server may purge a task's result when its TTL ends, so the next poll
// has to land inside the remaining TTL. Aim for half of what is left, with a
// small floor so a nearly expired task is not polled in a tight loop. Tasks
// far from expiry, or already past it, keep the normal interval bounds.
const MIN_TTL_POLL_INTERVAL_MS = 50

function pollDelayWithinTtl(
  interval: number,
  task: Pick<McpTask, 'ttl' | 'createdAt'>,
): number {
  const createdAtMs = parseTimeMs(task.createdAt)
  if (
    task.ttl === null ||
    task.ttl === undefined ||
    !Number.isFinite(task.ttl) ||
    createdAtMs === undefined
  ) {
    return interval
  }
  const remaining = createdAtMs + task.ttl - Date.now()
  // Past the TTL the server may still hold the task; nothing is left to race.
  if (remaining <= 0) return interval
  return Math.min(
    interval,
    Math.max(MIN_TTL_POLL_INTERVAL_MS, Math.floor(remaining / 2)),
  )
}

async function pollMcpServerTask(
  localTaskId: string,
  initialTask: McpTask,
): Promise<void> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry) return

  let delay = pollDelayWithinTtl(
    clampPollInterval(initialTask.pollInterval),
    initialTask,
  )
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

    delay = pollDelayWithinTtl(clampPollInterval(status.pollInterval), status)
    applyMcpTaskStatusMessage(
      localTaskId,
      status.statusMessage,
      status.lastUpdatedAt,
    )

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
  lastUpdatedAt?: string,
): void {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry) return
  // A tasks/get reply and a pushed notification can cross. Keep the newest
  // server observation; an equal timestamp is not older, so it applies.
  const observedAtMs = parseTimeMs(lastUpdatedAt)
  if (observedAtMs !== undefined) {
    if (observedAtMs < entry.lastUpdatedAtMs) return
    entry.lastUpdatedAtMs = observedAtMs
  }
  if (statusMessage === undefined) return
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
  // A JSON-RPC error from tasks/result is the task's own error, as opposed
  // to a timeout or a closed connection, which say nothing about the task.
  let protocolError: string | undefined
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
      if (
        e instanceof McpError &&
        e.code !== ErrorCode.RequestTimeout &&
        e.code !== ErrorCode.ConnectionClosed
      ) {
        protocolError = e.message
      }
    }
  }

  if (status === 'failed') {
    const message =
      statusMessage ?? protocolError ?? 'MCP server reported task failure'
    const diagnostic =
      payload ?? (statusMessage === undefined ? undefined : protocolError)
    appendTaskOutput(
      localTaskId,
      diagnostic === undefined ? message : `${message}\n${diagnostic}`,
    )
    await flushTaskOutput(localTaskId)
    markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
      statusMessage: message,
    })
    return
  }

  // No payload: the server's reason is all there is to read.
  const output = payload ?? protocolError ?? statusMessage
  if (output !== undefined) {
    appendTaskOutput(localTaskId, output)
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

  applyMcpTaskStatusMessage(
    localTaskId,
    params.statusMessage,
    params.lastUpdatedAt,
  )
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
 * McpServerTask kill hook at module load. With releaseOnFailure (agent exit),
 * a rejected cancel ends the local task as failed and stops tracking it,
 * since nothing remains to stop it later or receive its completion.
 */
async function cancelMcpServerTask(
  localTaskId: string,
  opts?: McpServerTaskCancelOptions,
): Promise<boolean> {
  const entry = trackedByLocalId.get(localTaskId)
  if (!entry) return false
  if (entry.finalized) return true
  try {
    await entry.client.experimental.tasks.cancelTask(
      entry.mcpTaskId,
      opts?.timeoutMs === undefined ? undefined : { timeout: opts.timeoutMs },
    )
  } catch (e) {
    if (opts?.releaseOnFailure) {
      if (entry.finalized) return true
      entry.finalized = true
      entry.abort.abort()
      trackedByLocalId.delete(localTaskId)
      localIdByMcpTaskId.delete(mcpTaskKey(entry.serverName, entry.mcpTaskId))
      markMcpServerTaskTerminal(localTaskId, entry.setAppState, 'failed', {
        statusMessage: `Cancel request failed (tasks/cancel): ${e instanceof Error ? e.message : String(e)}; the server may still be running the task`,
      })
      return true
    }
    // The server refused (for example it does not implement tasks/cancel),
    // so the task may still be running there. Keep tracking it, say why the
    // stop did not take, and let the caller leave it running and retryable.
    const reason = `Cancel request failed (tasks/cancel): ${e instanceof Error ? e.message : String(e)}`
    updateTaskState<McpServerTaskState>(localTaskId, entry.setAppState, task => ({
      ...task,
      cancelError: reason,
    }))
    throw e
  }
  await finalizeMcpServerTask(localTaskId, 'cancelled')
  return true
}

/**
 * Connection closed before a tracked task reached a terminal status. The
 * remote task may still run server-side, but nothing can observe or cancel
 * it now, so the local task fails instead of wedging the task list.
 */
export function failMcpServerTasksForServer(
  serverName: string,
  reason: string,
  /**
   * When set, only tasks run on this SDK client fail. A generation's
   * close must not stop another generation's live tasks: reconnect
   * leaves a retired generation open while its replacement takes over
   * the cache, so the closing generation fails only its own tasks
   * (CodeRabbit #2493 review 5968087303). Callers that omit it keep
   * the name-keyed behaviour, as before.
   */
  client?: Client,
): void {
  for (const [localTaskId, entry] of [...trackedByLocalId]) {
    if (entry.serverName !== serverName || entry.finalized) continue
    if (client !== undefined && entry.client !== client) continue
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
