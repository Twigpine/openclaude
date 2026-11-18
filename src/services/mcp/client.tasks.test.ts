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

  test('a failed tools/list after a reconnect drops the previous support entry', async () => {
    reset()
    const state = makeState()
    let listWorks = true
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'tools/list') {
        if (listWorks) return { tools: [SLOW_TOOL_LIST] }
        throw new Error('tools/list unavailable')
      }
      throw new Error('unknown support must not send a task-augmented call')
    })
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })

    // First connection: discovery succeeds and records support.
    await fetchToolsForClient(connection)
    // Reconnect: caches are cleared (onclose), discovery now fails.
    fetchToolsForClient.cache.delete('task-server')
    listWorks = false

    await callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'slow-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(callTool).toHaveBeenCalledTimes(1)
    expect(
      request.mock.calls.filter(c => c[0].method === 'tools/call'),
    ).toHaveLength(0)
    expect(Object.keys(state.get().tasks)).toHaveLength(0)
    reset()
  }, 15000)

  test('a transient tools/list failure does not pin a task-required tool to the plain path', async () => {
    reset()
    const state = makeState()
    let listWorks = false
    const request = vi.fn(
      async (req: { method: string }, _schema: unknown, opts: { task?: object }) => {
        if (req.method === 'tools/list') {
          if (!listWorks) throw new Error('tools/list unavailable')
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
        expect(opts.task).toEqual({})
        return { task: makeMcpTask() }
      },
    )
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })
    const call = () =>
      callMCPToolWithUrlElicitationRetry({
        client: connection,
        clientConnection: connection,
        tool: 'required-tool',
        args: {},
        signal: new AbortController().signal,
        setAppState: state.set,
      })

    // Discovery fails (all three attempts), so the first call goes plain.
    await call()
    expect(callTool).toHaveBeenCalledTimes(1)

    // Discovery recovers without a reconnect: the next call must re-discover
    // and take the task-augmented path.
    listWorks = true
    await call()
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(Object.keys(state.get().tasks)).toHaveLength(1)
    reset()
  }, 15000)

  test('a superseded connection\'s late discovery failure cannot overwrite the new connection\'s support', async () => {
    reset()
    const state = makeState()
    let releaseOld: () => void = () => {}
    const oldGate = new Promise<void>(resolve => {
      releaseOld = resolve
    })
    const oldRequest = vi.fn(async () => {
      await oldGate
      throw new Error('transport closed')
    })
    const newRequest = vi.fn(
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
        expect(opts.task).toEqual({})
        return { task: makeMcpTask() }
      },
    )
    const newCallTool = vi.fn(async () => {
      throw new Error('task-required tool must not take plain tools/call')
    })
    const oldConnection = makeConnection({ request: oldRequest, callTool: vi.fn() })
    const newConnection = makeConnection({
      request: newRequest,
      callTool: newCallTool,
    })

    // Old connection starts discovery, then disconnects (onclose clears the
    // memo entry) while its tools/list is still retrying.
    const oldDiscovery = fetchToolsForClient(oldConnection)
    fetchToolsForClient.cache.delete('task-server')

    // The reconnected connection finishes discovery first.
    await fetchToolsForClient(newConnection)

    // Now the old run fails and reaches its catch block.
    releaseOld()
    await oldDiscovery

    await callMCPToolWithUrlElicitationRetry({
      client: newConnection,
      clientConnection: newConnection,
      tool: 'required-tool',
      args: {},
      signal: new AbortController().signal,
      setAppState: state.set,
    })

    expect(newCallTool).not.toHaveBeenCalled()
    expect(Object.keys(state.get().tasks)).toHaveLength(1)
    reset()
  }, 15000)

  test('opt-out dispatches without waiting for a pending tool discovery', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(() => new Promise(() => {}))
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = makeConnection({ request, callTool })

    process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND = '1'
    try {
      const result = await Promise.race([
        callMCPToolWithUrlElicitationRetry({
          client: connection,
          clientConnection: connection,
          tool: 'slow-tool',
          args: {},
          signal: new AbortController().signal,
          setAppState: state.set,
        }),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 300)),
      ])
      expect(result).not.toBe('blocked')
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND
    }
    expect(callTool).toHaveBeenCalledTimes(1)
    reset()
  })

  test('a server without task capability dispatches without waiting for discovery', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(() => new Promise(() => {}))
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'plain result' }],
    }))
    const connection = {
      ...makeConnection({ request, callTool }),
      capabilities: { tools: {} } as ConnectedMCPServer['capabilities'],
    }

    const result = await Promise.race([
      callMCPToolWithUrlElicitationRetry({
        client: connection,
        clientConnection: connection,
        tool: 'slow-tool',
        args: {},
        signal: new AbortController().signal,
        setAppState: state.set,
      }),
      new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 300)),
    ])
    expect(result).not.toBe('blocked')
    expect(callTool).toHaveBeenCalledTimes(1)
    reset()
  })

  test('slow tool discovery counts against MCP_TOOL_TIMEOUT', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'tools/list') {
        await new Promise(resolve => setTimeout(resolve, 600))
        return { tools: [] }
      }
      throw new Error('a timed-out call must not dispatch')
    })
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'late result' }],
    }))
    const connection = makeConnection({ request, callTool })

    process.env.MCP_TOOL_TIMEOUT = '50'
    const started = Date.now()
    try {
      await expect(
        callMCPToolWithUrlElicitationRetry({
          client: connection,
          clientConnection: connection,
          tool: 'slow-tool',
          args: {},
          signal: new AbortController().signal,
          setAppState: state.set,
        }),
      ).rejects.toThrow(/timed out/)
    } finally {
      delete process.env.MCP_TOOL_TIMEOUT
    }

    expect(Date.now() - started).toBeLessThan(400)
    // Let the slow discovery finish: the abandoned call must not dispatch.
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(callTool).not.toHaveBeenCalled()
    reset()
  })

  test('cancelling the call interrupts a pending tool discovery', async () => {
    reset()
    const state = makeState()
    const request = vi.fn(async (req: { method: string }) => {
      if (req.method === 'tools/list') {
        await new Promise(resolve => setTimeout(resolve, 600))
        return { tools: [] }
      }
      throw new Error('a cancelled call must not dispatch')
    })
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'late result' }],
    }))
    const connection = makeConnection({ request, callTool })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    const started = Date.now()
    await expect(
      callMCPToolWithUrlElicitationRetry({
        client: connection,
        clientConnection: connection,
        tool: 'slow-tool',
        args: {},
        signal: controller.signal,
        setAppState: state.set,
      }),
    ).rejects.toThrow()

    expect(Date.now() - started).toBeLessThan(400)
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(callTool).not.toHaveBeenCalled()
    reset()
  })
})
