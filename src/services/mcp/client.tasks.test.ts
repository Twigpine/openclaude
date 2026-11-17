import { describe, expect, test, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Task as McpTask } from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/AppState.js'
import type { McpServerTaskState } from '../../tasks/McpServerTask/McpServerTask.js'
import { callMCPToolWithUrlElicitationRetry } from './client.js'
import {
  _resetMcpServerTasksForTest,
  recordMcpToolTaskSupport,
} from './tasks.js'
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

const SERVER_TASK_CAPS = {
  tasks: { requests: { tools: { call: {} } } },
}

function makeConnection(client: Record<string, unknown>): ConnectedMCPServer {
  return {
    client: client as unknown as Client,
    name: 'task-server',
    type: 'connected',
    capabilities: { tools: {}, ...SERVER_TASK_CAPS } as ConnectedMCPServer['capabilities'],
    config: { type: 'stdio' } as ConnectedMCPServer['config'],
    cleanup: async () => {},
  }
}

function makeMcpTask(overrides: Partial<McpTask> = {}): McpTask {
  return {
    taskId: 'remote-1',
    status: 'working',
    ttl: null,
    createdAt: '2026-01-01T00:00:00Z',
    lastUpdatedAt: '2026-01-01T00:00:00Z',
    pollInterval: 60000,
    ...overrides,
  }
}

describe('MCP server tasks', () => {
  test('task-capable tool call is augmented and registered as background task', async () => {
    _resetMcpServerTasksForTest()
    const state = makeState()
    const request = vi.fn(async (_req: unknown, _schema: unknown, opts: { task?: object }) => {
      expect(opts.task).toEqual({})
      return { task: makeMcpTask() }
    })
    const callTool = vi.fn(async () => {
      throw new Error('task-capable tool must not take plain tools/call')
    })
    const connection = makeConnection({ request, callTool })
    recordMcpToolTaskSupport('task-server', [
      { name: 'slow-tool', execution: { taskSupport: 'optional' } },
    ])

    const result = await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'slow-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(request).toHaveBeenCalledTimes(1)
    expect(callTool).not.toHaveBeenCalled()
    expect(String(result.content)).toContain('background task')

    const tasks = Object.values(state.get().tasks) as McpServerTaskState[]
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.type).toBe('mcp_server')
    expect(tasks[0]!.status).toBe('running')
    expect(tasks[0]!.mcpTaskId).toBe('remote-1')
    _resetMcpServerTasksForTest()
  })

  test('non-task tool still takes the plain tools/call path', async () => {
    _resetMcpServerTasksForTest()
    const state = makeState()
    const request = vi.fn(async () => ({ task: makeMcpTask() }))
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })
    recordMcpToolTaskSupport('task-server', [
      { name: 'slow-tool', execution: { taskSupport: 'optional' } },
    ])

    const result = await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'unmarked-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(callTool).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(result.content).toBeTruthy()
    expect(Object.keys(state.get().tasks)).toHaveLength(0)
    _resetMcpServerTasksForTest()
  })

  test('env opt-out takes the plain tools/call path', async () => {
    _resetMcpServerTasksForTest()
    const state = makeState()
    const request = vi.fn(async () => ({ task: makeMcpTask() }))
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })
    recordMcpToolTaskSupport('task-server', [
      { name: 'slow-tool', execution: { taskSupport: 'optional' } },
    ])

    process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND = '1'
    try {
      await callMCPToolWithUrlElicitationRetry({
        client: connection,
        clientConnection: connection,
        tool: 'slow-tool',
        args: {},
        signal: new AbortController().signal,
        setAppState: state.set,
      })
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND
    }

    expect(callTool).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
    expect(Object.keys(state.get().tasks)).toHaveLength(0)
    _resetMcpServerTasksForTest()
  })
})
