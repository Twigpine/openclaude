import { describe, expect, test, vi } from 'vitest'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Task as McpTask } from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from '../../state/AppState.js'
import type { McpServerTaskState } from '../../tasks/McpServerTask/McpServerTask.js'
import {
  callMCPToolWithUrlElicitationRetry,
  fetchToolsForClient,
} from './client.js'
import {
  _resetMcpServerTasksForTest,
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

const SLOW_TOOL_LIST = {
  name: 'slow-tool',
  description: 'runs slowly',
  inputSchema: { type: 'object', properties: {} },
  execution: { taskSupport: 'optional' },
}

function reset(name = 'task-server') {
  _resetMcpServerTasksForTest()
  fetchToolsForClient.cache.delete(name)
}

describe('MCP server tasks', () => {
  test('task-capable tool call is augmented and registered as background task', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(
      async (req: { method: string }, _schema: unknown, opts: { task?: object }) => {
        if (req.method === 'tools/list') {
          return { tools: [SLOW_TOOL_LIST] }
        }
        expect(opts.task).toEqual({})
        return { task: makeMcpTask() }
      },
    )
    const callTool = vi.fn(async () => {
      throw new Error('task-capable tool must not take plain tools/call')
    })
    const connection = makeConnection({ request, callTool })

    const result = await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'slow-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'tools/call',
        params: expect.objectContaining({ name: 'slow-tool' }),
      }),
      expect.anything(),
      expect.objectContaining({ task: {} }),
    )
    expect(callTool).not.toHaveBeenCalled()
    expect(String(result.content)).toContain('background task')

    const tasks = Object.values(state.get().tasks) as McpServerTaskState[]
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.type).toBe('mcp_server')
    expect(tasks[0]!.status).toBe('running')
    expect(tasks[0]!.mcpTaskId).toBe('remote-1')
    reset()
  })

  test('non-task tool still takes the plain tools/call path', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'tools/list') {
        return { tools: [SLOW_TOOL_LIST] }
      }
      return { task: makeMcpTask() }
    })
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })

    const result = await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'unmarked-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(callTool).toHaveBeenCalledTimes(1)
    expect(result.content).toBeTruthy()
    expect(Object.keys(state.get().tasks)).toHaveLength(0)
    reset()
  })

  test('env opt-out takes the plain tools/call path', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'tools/list') {
        return { tools: [SLOW_TOOL_LIST] }
      }
      return { task: makeMcpTask() }
    })
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })

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
    expect(Object.keys(state.get().tasks)).toHaveLength(0)
    reset()
  })

  test('a reconnect refetches tool metadata so a required tool stays augmented', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(
      async (req: { method: string }, _schema: unknown, opts: { task?: object }) => {
        if (req.method === 'tools/list') {
          return {
            tools: [
              {
                name: 'required-tool',
                description: 'must run as a task',
                inputSchema: { type: 'object', properties: {} },
                execution: { taskSupport: 'required' },
              },
            ],
          }
        }
        expect(req.method).toBe('tools/call')
        expect(opts.task).toEqual({})
        return { task: makeMcpTask() }
      },
    )
    const callTool = vi.fn(async () => {
      throw new Error('task-required tool must not take plain tools/call')
    })
    const connection = makeConnection({ request, callTool })

    // Simulate the reconnect path: the onclose handler clears the
    // task-support map and the tools cache, leaving a fresh connection
    // whose metadata has not been fetched yet.
    _resetMcpServerTasksForTest()
    fetchToolsForClient.cache.delete('task-server')

    await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'required-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'tools/list' }),
      expect.anything(),
    )
    expect(callTool).not.toHaveBeenCalled()
    expect(Object.keys(state.get().tasks)).toHaveLength(1)
    reset()
  })
})
