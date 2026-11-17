import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Task as McpTask } from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/AppState.js'
import type { McpServerTaskState } from '../../tasks/McpServerTask/McpServerTask.js'
import { McpServerTask } from '../../tasks/McpServerTask/McpServerTask.js'
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
  opts: { capabilities?: Record<string, unknown> } = {},
): ConnectedMCPServer {
  return {
    client,
    name: 'srv',
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
  try {
    assert.equal(mcpTaskSupportForTool(connection, 'slow_tool'), undefined)
  } finally {
    delete process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND
  }
  _resetMcpServerTasksForTest()
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
