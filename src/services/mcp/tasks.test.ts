import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ErrorCode,
  McpError,
  type Task as McpTask,
} from '@modelcontextprotocol/sdk/types.js'
import { snapshotEnv } from '../../test/envSnapshot.js'
import type { AppState } from '../../state/AppState.js'
import type { McpServerTaskState } from '../../tasks/McpServerTask/McpServerTask.js'
import {
  killMcpServerTasksForAgent,
  McpServerTask,
} from '../../tasks/McpServerTask/McpServerTask.js'
import {
  _resetMcpServerTasksForTest,
  failMcpServerTasksForServer,
  handleMcpTaskStatusNotification,
  mcpTaskSupportForTool,
  recordMcpToolTaskSupport,
  trackMcpServerTask,
} from './tasks.js'
import {
  _resetTaskOutputDirForTest,
  getTaskOutputPath,
} from '../../utils/task/diskOutput.js'
import {
  clearCommandQueue,
  getCommandQueue,
} from '../../utils/messageQueueManager.js'
import type { ConnectedMCPServer } from './types.js'

function makeState() {
  let state = { tasks: {} } as AppState
  return {
    get: () => state,
    set: (f: (prev: AppState) => AppState) => {
      state = f(state)
    },
  }
}

function makeMcpTask(overrides: Partial<McpTask> = {}): McpTask {
  return {
    taskId: 'srv-task-1',
    status: 'working',
    ttl: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeClient(overrides: {
  getTask?: (id: string) => Promise<McpTask>
  getTaskResult?: (id: string) => Promise<unknown>
  cancelTask?: (id: string) => Promise<unknown>
}): { client: Client; calls: Record<string, string[]> } {
  const calls: Record<string, string[]> = {
    getTask: [],
    getTaskResult: [],
    cancelTask: [],
  }
  const client = {
    experimental: {
      tasks: {
        getTask: async (id: string) => {
          calls.getTask.push(id)
          return overrides.getTask?.(id) ?? makeMcpTask({ taskId: id })
        },
        getTaskResult: async (id: string) => {
          calls.getTaskResult.push(id)
          return (
            overrides.getTaskResult?.(id) ?? { content: [{ type: 'text', text: 'done' }] }
          )
        },
        cancelTask: async (id: string) => {
          calls.cancelTask.push(id)
          return overrides.cancelTask?.(id) ?? {}
        },
      },
    },
  } as unknown as Client
  return { client, calls }
}

function makeConnection(
  client: Client,
  opts: { capabilities?: Record<string, unknown>; name?: string } = {},
): ConnectedMCPServer {
  return {
    client,
    name: opts.name ?? 'srv',
    type: 'connected',
    capabilities: (opts.capabilities ?? {}) as ConnectedMCPServer['capabilities'],
    config: {} as ConnectedMCPServer['config'],
    cleanup: async () => {},
  }
}

const TASK_CAPS = { tasks: { requests: { tools: { call: {} } } } }

function taskFrom(
  state: { get: () => AppState },
  taskId: string,
): McpServerTaskState {
  const task = state.get().tasks[taskId]
  assert.ok(task, `expected task ${taskId} in AppState`)
  assert.equal(task.type, 'mcp_server')
  return task as McpServerTaskState
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  // The finalize chain does real fs I/O (mkdir + open + appendFile + close),
  // so a fixed setImmediate count cannot settle it reliably.
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out')
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('trackMcpServerTask registers a running mcp_server task', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  const task = taskFrom(state, taskId)
  assert.ok(taskId.startsWith('s'))
  assert.equal(task.status, 'running')
  assert.equal(task.mcpServerName, 'srv')
  assert.equal(task.mcpToolName, 'slow_tool')
  assert.equal(task.mcpTaskId, 'srv-task-1')
  assert.equal(task.notified, false)
  _resetMcpServerTasksForTest()
})

test('completed status notification fetches result and marks notified', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client, calls } = makeClient({
    getTaskResult: async () => ({
      content: [{ type: 'text', text: 'answer: 42' }],
    }),
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'completed' }),
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.notified, true)
  assert.ok(task.endTime)
  assert.deepEqual(calls.getTaskResult, ['srv-task-1'])

  const output = await readFile(getTaskOutputPath(taskId), 'utf8')
  assert.match(output, /answer: 42/)
  _resetMcpServerTasksForTest()
})

test('failed status notification marks failed with statusMessage', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'failed', statusMessage: 'out of memory' }),
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.equal(task.notified, true)
  assert.equal(task.statusMessage, 'out of memory')

  const output = await readFile(getTaskOutputPath(taskId), 'utf8')
  assert.match(output, /out of memory/)
  _resetMcpServerTasksForTest()
})

test('poll loop reaches terminal state via tasks/get', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client, calls } = makeClient({
    getTask: async id => makeMcpTask({ taskId: id, status: 'completed' }),
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 1000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  // The poll floor is 1s; wait for the first tick plus finalization.
  await new Promise(resolve => setTimeout(resolve, 1500))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.notified, true)
  assert.ok(calls.getTask.length >= 1)
  assert.deepEqual(calls.getTaskResult, ['srv-task-1'])
  _resetMcpServerTasksForTest()
})

test('kill sends tasks/cancel and marks killed', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client, calls } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  await McpServerTask.kill(taskId, state.set)
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.deepEqual(calls.cancelTask, ['srv-task-1'])
  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'killed')
  assert.equal(task.notified, true)
  _resetMcpServerTasksForTest()
})

test('a rejected tasks/cancel keeps the task running, reports the error, and can be retried', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  let rejectCancel = true
  const { client, calls } = makeClient({
    cancelTask: async () => {
      if (rejectCancel) throw new Error('Method not found: tasks/cancel')
      return {}
    },
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  await McpServerTask.kill(taskId, state.set)

  // The server may still be running it: stay visible with the reason.
  const afterReject = taskFrom(state, taskId)
  assert.equal(afterReject.status, 'running')
  assert.match(afterReject.cancelError ?? '', /tasks\/cancel/)

  // The stop request is retryable and a successful one finishes the kill.
  rejectCancel = false
  await McpServerTask.kill(taskId, state.set)
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  assert.equal(calls.cancelTask.length, 2)
  assert.equal(taskFrom(state, taskId).status, 'killed')
  _resetMcpServerTasksForTest()
})

test('disconnect fails tracked tasks for that server only', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({})
  const connA = makeConnection(client, { capabilities: TASK_CAPS })
  const connB = { ...makeConnection(client, { capabilities: TASK_CAPS }), name: 'other' }

  const taskA = trackMcpServerTask({
    connection: connA,
    task: makeMcpTask({ taskId: 'a1', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  const taskB = trackMcpServerTask({
    connection: connB,
    task: makeMcpTask({ taskId: 'b1', pollInterval: 60000 }),
    toolName: 't',
    description: 'other: t',
    setAppState: state.set,
  })

  failMcpServerTasksForServer('srv', 'MCP server "srv" disconnected before the task completed')
  await waitFor(() => taskFrom(state, taskA).status !== 'running')

  assert.equal(taskFrom(state, taskA).status, 'failed')
  assert.equal(taskFrom(state, taskA).notified, true)
  assert.equal(taskFrom(state, taskB).status, 'running')
  _resetMcpServerTasksForTest()
})

test('getTask errors fail the task instead of hanging', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({
    getTask: async () => {
      throw new Error('task not found')
    },
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 1000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  await new Promise(resolve => setTimeout(resolve, 1500))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.equal(task.notified, true)
  _resetMcpServerTasksForTest()
})

test('mcpTaskSupportForTool gates on capability, tool metadata, and env', () => {
  _resetMcpServerTasksForTest()
  const restoreEnv = snapshotEnv(['CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND'], {
    clear: true,
  })
  try {
    const { client } = makeClient({})
    const connection = makeConnection(client, { capabilities: TASK_CAPS })

    recordMcpToolTaskSupport(connection, [
      { name: 'slow_tool', execution: { taskSupport: 'optional' } },
      { name: 'required_tool', execution: { taskSupport: 'required' } },
      { name: 'forbidden_tool', execution: { taskSupport: 'forbidden' } },
      { name: 'plain_tool' },
    ])

    assert.equal(mcpTaskSupportForTool(connection, 'slow_tool'), 'optional')
    assert.equal(mcpTaskSupportForTool(connection, 'required_tool'), 'required')
    assert.equal(mcpTaskSupportForTool(connection, 'forbidden_tool'), undefined)
    assert.equal(mcpTaskSupportForTool(connection, 'plain_tool'), undefined)

    // No server capability: never augment, even for task-marked tools.
    const noCaps = makeConnection(client, {})
    assert.equal(mcpTaskSupportForTool(noCaps, 'slow_tool'), undefined)

    // Env opt-out: never augment.
    process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND = '1'
    assert.equal(mcpTaskSupportForTool(connection, 'slow_tool'), undefined)
  } finally {
    restoreEnv()
    _resetMcpServerTasksForTest()
  }
})

test('notifications for unknown or other-server tasks are ignored', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client, calls } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ taskId: 'srv-9', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ taskId: 'untracked', status: 'completed' }),
  })
  handleMcpTaskStatusNotification('other-server', {
    ...makeMcpTask({ taskId: 'srv-9', status: 'completed' }),
  })
  await new Promise(resolve => setTimeout(resolve, 100))

  assert.equal(taskFrom(state, taskId).status, 'running')
  assert.deepEqual(calls.getTaskResult, [])
  _resetMcpServerTasksForTest()
})

test('terminal transition enqueues exactly one task-notification', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client } = makeClient({
    getTaskResult: async () => ({
      content: [{ type: 'text', text: 'answer: 42' }],
    }),
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    toolUseId: 'toolu_abc',
    agentId: 'agent-1' as never,
    setAppState: state.set,
  })

  // Two concurrent terminal causes - a status notification's finalize and
  // a disconnect - must still produce a single notification.
  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'completed' }),
  })
  failMcpServerTasksForServer('srv', 'connection closed')
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  await new Promise(resolve => setTimeout(resolve, 50))

  const notifications = getCommandQueue().filter(
    c => c.mode === 'task-notification',
  )
  assert.equal(notifications.length, 1)
  const value = String(notifications[0]!.value)
  assert.match(value, new RegExp(`<task-id>${taskId}</task-id>`))
  assert.match(value, /<tool-use-id>toolu_abc<\/tool-use-id>/)
  assert.match(value, /<status>completed<\/status>/)
  assert.match(value, /<output-file>[^<]+<\/output-file>/)
  assert.equal(notifications[0]!.agentId, 'agent-1')
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('isError task result marks the task failed', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({
    getTaskResult: async () => ({
      content: [{ type: 'text', text: 'disk full' }],
      isError: true,
    }),
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'completed' }),
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.equal(task.statusMessage, 'disk full')
  _resetMcpServerTasksForTest()
})

test('rejected tasks/result marks failed and keeps the error', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client } = makeClient({
    getTaskResult: async () => {
      throw new Error('result expired')
    },
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'completed' }),
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.match(task.statusMessage ?? '', /result expired/)

  const notifications = getCommandQueue().filter(
    c => c.mode === 'task-notification',
  )
  assert.equal(notifications.length, 1)
  assert.match(String(notifications[0]!.value), /<status>failed<\/status>/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('cancelled status marks the task killed', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'cancelled' }),
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.equal(taskFrom(state, taskId).status, 'killed')
  _resetMcpServerTasksForTest()
})

test('a user kill during a pending tasks/result wins the terminal race', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  let resolveResult!: (value: unknown) => void
  const { client, calls } = makeClient({
    getTaskResult: () =>
      new Promise(resolve => {
        resolveResult = resolve
      }),
  })
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({ status: 'completed' }),
  })
  await waitFor(() => calls.getTaskResult.length === 1)

  await McpServerTask.kill(taskId, state.set)
  assert.equal(taskFrom(state, taskId).status, 'killed')

  resolveResult({ content: [{ type: 'text', text: 'late answer' }] })
  await waitFor(() => existsSync(getTaskOutputPath(taskId)))
  await new Promise(resolve => setTimeout(resolve, 50))

  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'killed')

  const notifications = getCommandQueue().filter(
    c => c.mode === 'task-notification',
  )
  assert.equal(notifications.length, 1)
  assert.match(String(notifications[0]!.value), /<status>killed<\/status>/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('server disconnect fails the task and notifies', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })

  const taskId = trackMcpServerTask({
    connection,
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 'slow_tool',
    description: 'srv: slow_tool',
    setAppState: state.set,
  })

  failMcpServerTasksForServer('srv', 'connection closed')
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.match(taskFrom(state, taskId).statusMessage ?? '', /connection closed/)
  const notifications = getCommandQueue().filter(
    c => c.mode === 'task-notification',
  )
  assert.equal(notifications.length, 1)
  assert.match(String(notifications[0]!.value), /<status>failed<\/status>/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('identical remote task ids on two servers stay separate', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const a = makeClient({
    getTaskResult: async () => ({ content: [{ type: 'text', text: 'from A' }] }),
  })
  const b = makeClient({
    getTaskResult: async () => ({ content: [{ type: 'text', text: 'from B' }] }),
  })
  const idA = trackMcpServerTask({
    connection: makeConnection(a.client, { capabilities: TASK_CAPS, name: 'A' }),
    task: makeMcpTask({ taskId: '1', pollInterval: 60000 }),
    toolName: 't',
    description: 'A: t',
    setAppState: state.set,
  })
  const idB = trackMcpServerTask({
    connection: makeConnection(b.client, { capabilities: TASK_CAPS, name: 'B' }),
    task: makeMcpTask({ taskId: '1', pollInterval: 60000 }),
    toolName: 't',
    description: 'B: t',
    setAppState: state.set,
  })

  // A's push update must reach A even though B registered the same id later.
  handleMcpTaskStatusNotification('A', makeMcpTask({ taskId: '1', status: 'completed' }))
  await waitFor(() => taskFrom(state, idA).status !== 'running')
  assert.equal(taskFrom(state, idA).status, 'completed')
  assert.deepEqual(a.calls.getTaskResult, ['1'])
  // Finalizing A must not drop B's lookup.
  assert.equal(taskFrom(state, idB).status, 'running')
  handleMcpTaskStatusNotification('B', makeMcpTask({ taskId: '1', status: 'completed' }))
  await waitFor(() => taskFrom(state, idB).status !== 'running')
  assert.equal(taskFrom(state, idB).status, 'completed')
  assert.deepEqual(b.calls.getTaskResult, ['1'])
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('server-reported failed fetches tasks/result and keeps the payload', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client, calls } = makeClient({
    getTaskResult: async () => ({
      isError: true,
      content: [{ type: 'text', text: 'diagnostic: disk full' }],
    }),
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'failed' }))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.deepEqual(calls.getTaskResult, ['srv-task-1'])
  const output = await readFile(getTaskOutputPath(taskId), 'utf8')
  assert.match(output, /diagnostic: disk full/)
  assert.equal(
    getCommandQueue().filter(c => c.mode === 'task-notification').length,
    1,
  )
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('server-reported cancelled fetches tasks/result and stays killed', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client, calls } = makeClient({
    getTaskResult: async () => ({
      content: [{ type: 'text', text: 'partial output' }],
    }),
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'cancelled' }))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.equal(taskFrom(state, taskId).status, 'killed')
  assert.deepEqual(calls.getTaskResult, ['srv-task-1'])
  assert.match(await readFile(getTaskOutputPath(taskId), 'utf8'), /partial output/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('a failed tasks/result fetch falls back to the statusMessage', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client, calls } = makeClient({
    getTaskResult: async () => {
      throw new Error('no result stored')
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification(
    'srv',
    makeMcpTask({ status: 'failed', statusMessage: 'out of quota' }),
  )
  await waitFor(() => taskFrom(state, taskId).status !== 'running')

  assert.equal(calls.getTaskResult.length, 1)
  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.equal(taskFrom(state, taskId).statusMessage, 'out of quota')
  assert.match(await readFile(getTaskOutputPath(taskId), 'utf8'), /out of quota/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('locally generated failures never call tasks/result', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client, calls } = makeClient({
    getTask: async () => {
      throw new Error('transport down')
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 1000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  await waitFor(() => taskFrom(state, taskId).status !== 'running', 5000)
  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.deepEqual(calls.getTaskResult, [])

  const killId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ taskId: 'kill-me', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  await McpServerTask.kill(killId, state.set)
  assert.equal(taskFrom(state, killId).status, 'killed')
  assert.deepEqual(calls.getTaskResult, [])
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('a disconnect during a pending tasks/result fails the task', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new SdkClient({ name: 'c', version: '1' }, { capabilities: {} })
  // A server that initializes, then never answers tasks/result.
  serverSide.onmessage = (m: any) => {
    if (m.method === 'initialize') {
      void serverSide.send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: m.params.protocolVersion,
          capabilities: {},
          serverInfo: { name: 's', version: '1' },
        },
      } as any)
    }
  }
  await serverSide.start()
  await client.connect(clientSide)
  client.onclose = () => failMcpServerTasksForServer('srv', 'connection closed')

  const taskId = trackMcpServerTask({
    connection: makeConnection(client as unknown as Client, {
      capabilities: TASK_CAPS,
    }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'completed' }))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(taskFrom(state, taskId).status, 'running')

  await serverSide.close()
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.equal(
    getCommandQueue().filter(c => c.mode === 'task-notification').length,
    1,
  )
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('tasks/result is requested with an explicit timeout', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  let seenOptions: unknown
  const { client } = makeClient({})
  ;(client as any).experimental.tasks.getTaskResult = async (
    _id: string,
    _schema: unknown,
    options: unknown,
  ) => {
    seenOptions = options
    return { content: [{ type: 'text', text: 'ok' }] }
  }
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'completed' }))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  assert.equal(typeof (seenOptions as { timeout?: number })?.timeout, 'number')
  _resetMcpServerTasksForTest()
})

test('a short task TTL is polled before it can expire', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client, calls } = makeClient({
    getTask: async id => makeMcpTask({ taskId: id, status: 'completed' }),
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    // Server suggests 250 ms but the 1 s floor would land after the 900 ms
    // TTL, when the server may already have purged the result.
    task: makeMcpTask({
      ttl: 900,
      pollInterval: 250,
      createdAt: new Date().toISOString(),
    }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  await waitFor(() => calls.getTask.length > 0, 800)
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  assert.equal(taskFrom(state, taskId).status, 'completed')
  _resetMcpServerTasksForTest()
})

test('a stale tasks/get response does not overwrite a newer pushed status', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const { client, calls } = makeClient({
    getTask: async id => {
      await gate
      return makeMcpTask({
        taskId: id,
        statusMessage: 'Processing',
        lastUpdatedAt: '2026-01-01T00:00:01Z',
      })
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 1000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  // The poll has sampled 'working' and is in flight; a newer push lands first.
  await waitFor(() => calls.getTask.length === 1, 2500)
  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({
      status: 'input_required',
      statusMessage: 'Waiting for input',
      lastUpdatedAt: '2026-01-01T00:00:02Z',
    }),
  })
  assert.equal(taskFrom(state, taskId).statusMessage, 'Waiting for input')
  release()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(taskFrom(state, taskId).statusMessage, 'Waiting for input')

  // An in-order observation still updates the message.
  handleMcpTaskStatusNotification('srv', {
    ...makeMcpTask({
      status: 'working',
      statusMessage: 'Resumed',
      lastUpdatedAt: '2026-01-01T00:00:03Z',
    }),
  })
  assert.equal(taskFrom(state, taskId).statusMessage, 'Resumed')
  _resetMcpServerTasksForTest()
})

test('a protocol error from tasks/result on a failed task is kept as the diagnostic', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  const { client } = makeClient({
    getTaskResult: async () => {
      throw new McpError(ErrorCode.InternalError, 'disk quota exceeded')
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'failed' }))
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.match(task.statusMessage ?? '', /disk quota exceeded/)
  const output = await readFile(getTaskOutputPath(taskId), 'utf8')
  assert.match(output, /disk quota exceeded/)
  _resetMcpServerTasksForTest()
})

test('a timeout or transport error from tasks/result is not reported as the task error', async () => {
  for (const code of [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed]) {
    _resetMcpServerTasksForTest()
    _resetTaskOutputDirForTest()
    const state = makeState()
    const { client } = makeClient({
      getTaskResult: async () => {
        throw new McpError(code, 'transport detail')
      },
    })
    const taskId = trackMcpServerTask({
      connection: makeConnection(client, { capabilities: TASK_CAPS }),
      task: makeMcpTask({ pollInterval: 60000 }),
      toolName: 't',
      description: 'srv: t',
      setAppState: state.set,
    })
    handleMcpTaskStatusNotification('srv', makeMcpTask({ status: 'failed' }))
    await waitFor(() => taskFrom(state, taskId).status !== 'running')
    assert.equal(
      taskFrom(state, taskId).statusMessage,
      'MCP server reported task failure',
    )
    _resetMcpServerTasksForTest()
  }
})

test('a server cancellation reason reaches the output file and the notification', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client } = makeClient({
    getTaskResult: async () => {
      throw new Error('no result for cancelled task')
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  handleMcpTaskStatusNotification(
    'srv',
    makeMcpTask({ status: 'cancelled', statusMessage: 'Revoked by administrator' }),
  )
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(taskFrom(state, taskId).status, 'killed')
  const output = await readFile(getTaskOutputPath(taskId), 'utf8')
  assert.match(output, /Revoked by administrator/)
  const notification = getCommandQueue().find(c => c.mode === 'task-notification')
  assert.match(String(notification?.value), /Revoked by administrator/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('a failed tasks/cancel is kept apart from the server status message', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  let rejectCancel = true
  const { client } = makeClient({
    cancelTask: async () => {
      if (rejectCancel) throw new Error('Method not found: tasks/cancel')
      return {}
    },
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  await McpServerTask.kill(taskId, state.set)
  assert.match(taskFrom(state, taskId).cancelError ?? '', /tasks\/cancel/)

  // A routine working update must not erase why Stop failed.
  handleMcpTaskStatusNotification(
    'srv',
    makeMcpTask({ statusMessage: 'Processing', lastUpdatedAt: '2026-01-01T00:00:05Z' }),
  )
  const during = taskFrom(state, taskId)
  assert.equal(during.statusMessage, 'Processing')
  assert.match(during.cancelError ?? '', /tasks\/cancel/)

  // An acknowledged Stop clears it.
  rejectCancel = false
  await McpServerTask.kill(taskId, state.set)
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  assert.equal(taskFrom(state, taskId).cancelError, undefined)
  _resetMcpServerTasksForTest()
})

test('an exiting agent cancels its own server tasks and leaves no notification behind', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  const { client, calls } = makeClient({})
  const connection = makeConnection(client, { capabilities: TASK_CAPS })
  const owned = trackMcpServerTask({
    connection,
    task: makeMcpTask({ taskId: 'owned', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: owned',
    agentId: 'agent-1' as never,
    setAppState: state.set,
  })
  const other = trackMcpServerTask({
    connection,
    task: makeMcpTask({ taskId: 'other', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: other',
    agentId: 'agent-2' as never,
    setAppState: state.set,
  })

  await killMcpServerTasksForAgent('agent-1' as never, state.get, state.set)
  assert.notEqual(taskFrom(state, owned).status, 'running')
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.deepEqual(calls.cancelTask, ['owned'])
  assert.equal(taskFrom(state, owned).status, 'killed')
  assert.equal(taskFrom(state, other).status, 'running')
  assert.equal(
    getCommandQueue().filter(c => c.agentId === ('agent-1' as never)).length,
    0,
  )
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('an exiting agent whose tasks/cancel is rejected ends the local task instead of leaving it running', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  let pushComplete = false
  const { client, calls } = makeClient({
    cancelTask: async () => {
      throw new McpError(ErrorCode.MethodNotFound, 'tasks/cancel not supported')
    },
    getTask: async id =>
      makeMcpTask({ taskId: id, status: pushComplete ? 'completed' : 'working' }),
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ taskId: 'stuck', pollInterval: 1000 }),
    toolName: 't',
    description: 'srv: stuck',
    agentId: 'agent-1' as never,
    setAppState: state.set,
  })

  await killMcpServerTasksForAgent('agent-1' as never, state.get, state.set)

  assert.deepEqual(calls.cancelTask, ['stuck'])
  const task = taskFrom(state, taskId)
  assert.equal(task.status, 'failed')
  assert.match(task.statusMessage ?? '', /may still be running/)
  // Tracking is released: a later server completion is not observed and no
  // notification for the dead agent is queued.
  pushComplete = true
  handleMcpTaskStatusNotification('srv', {
    taskId: 'stuck',
    status: 'completed',
    ttl: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:01Z',
  })
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(calls.getTask.length, 0)
  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.equal(
    getCommandQueue().filter(c => c.agentId === ('agent-1' as never)).length,
    0,
  )
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})

test('a task past its TTL that the server still holds is polled at the normal interval', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  const state = makeState()
  // Expired a minute ago but still working on the server.
  const expired = makeMcpTask({
    ttl: 1000,
    pollInterval: 1000,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const { client, calls } = makeClient({
    getTask: async id => ({ ...expired, taskId: id }),
  })
  trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: expired,
    toolName: 't',
    description: 'srv: t',
    setAppState: state.set,
  })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(calls.getTask.length, 0)
  await waitFor(() => calls.getTask.length > 0, 1500)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(calls.getTask.length, 1)
  _resetMcpServerTasksForTest()
})

test('a disconnect during agent-exit cancel keeps the task failed, not killed', async () => {
  _resetMcpServerTasksForTest()
  _resetTaskOutputDirForTest()
  clearCommandQueue()
  const state = makeState()
  let rejectCancel!: (e: Error) => void
  const { client } = makeClient({
    cancelTask: () =>
      new Promise((_, reject) => {
        rejectCancel = reject
      }),
  })
  const taskId = trackMcpServerTask({
    connection: makeConnection(client, { capabilities: TASK_CAPS }),
    task: makeMcpTask({ taskId: 'gone', pollInterval: 60000 }),
    toolName: 't',
    description: 'srv: gone',
    agentId: 'agent-1' as never,
    setAppState: state.set,
  })

  const exit = killMcpServerTasksForAgent('agent-1' as never, state.get, state.set)
  await waitFor(() => rejectCancel !== undefined)
  failMcpServerTasksForServer('srv', 'MCP server "srv" disconnected')
  rejectCancel(new McpError(ErrorCode.ConnectionClosed, 'Connection closed'))
  await exit
  await waitFor(() => taskFrom(state, taskId).status !== 'running')
  await new Promise(resolve => setTimeout(resolve, 50))

  assert.equal(taskFrom(state, taskId).status, 'failed')
  assert.match(taskFrom(state, taskId).statusMessage ?? '', /disconnected/)
  clearCommandQueue()
  _resetMcpServerTasksForTest()
})
