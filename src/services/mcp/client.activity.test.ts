import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { AbortError } from '../../utils/errors.js'
import { createAssistantMessage } from '../../utils/messages.js'
import {
  callMCPToolWithUrlElicitationRetry,
  fetchToolsForClient,
} from './client.js'
import type { ConnectedMCPServer } from './types.js'

describe('MCP tool activity', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('URL elicitation cancellation uses the shared AbortError type', async () => {
    const abortController = new AbortController()
    abortController.abort()
    const callToolFn = vi.fn(async () => ({ content: [] }))

    await expect(
      callMCPToolWithUrlElicitationRetry({
        client: {} as never,
        clientConnection: {
          type: 'connected',
          name: 'elicitation-cancel-test',
        } as never,
        tool: 'slow-tool',
        args: {},
        signal: abortController.signal,
        setAppState: vi.fn(),
        callToolFn,
      }),
    ).rejects.toBeInstanceOf(AbortError)
    expect(callToolFn).not.toHaveBeenCalled()
  })

  test('emits progress heartbeats while a tool call remains pending', async () => {
    vi.useFakeTimers()
    let resolveToolCall: ((result: unknown) => void) | undefined
    let reportServerProgress:
      | ((progress: {
          progress: number
          total?: number
          message?: string
        }) => void)
      | undefined
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        (
          _request: unknown,
          _schema: unknown,
          options: {
            onprogress?: typeof reportServerProgress
          },
        ) => {
          reportServerProgress = options.onprogress
          return new Promise(resolve => {
            resolveToolCall = resolve
          })
        },
      ),
    }
    const connection = {
      type: 'connected',
      name: 'heartbeat-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn()
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_heartbeat',
          name: tool!.name,
          input: {},
        },
      ],
    })

    const callPromise = tool!.call(
      {},
      {
        abortController: new AbortController(),
        setAppState: vi.fn(),
      } as never,
      undefined as never,
      parentMessage,
      onProgress,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(reportServerProgress).toBeDefined()

    // Silent server: no progress notifications at all. The wrapper's own
    // heartbeat must still fire so QueryGuard sees activity.
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(onProgress).toHaveBeenLastCalledWith({
      toolUseID: 'toolu_heartbeat',
      data: expect.objectContaining({
        type: 'mcp_progress',
        status: 'progress',
        serverName: 'heartbeat-test',
        toolName: 'slow-tool',
        elapsedTimeMs: expect.any(Number),
      }),
    })

    reportServerProgress?.({
      progress: 4,
      total: 10,
      message: 'Indexing files',
    })
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()

    // The next heartbeat carries the cached server progress values.
    expect(onProgress).toHaveBeenLastCalledWith({
      toolUseID: 'toolu_heartbeat',
      data: expect.objectContaining({
        type: 'mcp_progress',
        status: 'progress',
        serverName: 'heartbeat-test',
        toolName: 'slow-tool',
        progress: 4,
        total: 10,
        progressMessage: 'Indexing files',
        elapsedTimeMs: expect.any(Number),
      }),
    })

    // A later notification carrying only progress must not drop the
    // previously reported total/progressMessage, either in the forwarded
    // event or in subsequent heartbeats.
    reportServerProgress?.({ progress: 7 })
    await Promise.resolve()
    expect(onProgress).toHaveBeenLastCalledWith({
      toolUseID: 'toolu_heartbeat',
      data: expect.objectContaining({
        type: 'mcp_progress',
        status: 'progress',
        progress: 7,
        total: 10,
        progressMessage: 'Indexing files',
      }),
    })
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(onProgress).toHaveBeenLastCalledWith({
      toolUseID: 'toolu_heartbeat',
      data: expect.objectContaining({
        type: 'mcp_progress',
        status: 'progress',
        progress: 7,
        total: 10,
        progressMessage: 'Indexing files',
        elapsedTimeMs: expect.any(Number),
      }),
    })

    resolveToolCall?.({ content: [{ type: 'text', text: 'done' }] })
    await callPromise
    const progressCountAfterCompletion = onProgress.mock.calls.length
    vi.advanceTimersByTime(30_000)
    expect(onProgress).toHaveBeenCalledTimes(progressCountAfterCompletion)
  })

  test('aborts the MCP request when the tool-call timeout expires', async () => {
    vi.useFakeTimers()
    const originalTimeout = process.env.MCP_TOOL_TIMEOUT
    process.env.MCP_TOOL_TIMEOUT = '1000'
    let requestSignal: AbortSignal | undefined
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        (
          _request: unknown,
          _schema: unknown,
          options: { signal?: AbortSignal },
        ) => {
          requestSignal = options.signal
          return new Promise(() => {})
        },
      ),
    }
    const connection = {
      type: 'connected',
      name: 'timeout-abort-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer

    try {
      const [tool] = await fetchToolsForClient(connection)
      expect(tool).toBeDefined()
      const parentMessage = createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_timeout_abort',
            name: tool!.name,
            input: {},
          },
        ],
      })
      const callPromise = tool!.call(
        {},
        {
          abortController: new AbortController(),
          setAppState: vi.fn(),
        } as never,
        undefined as never,
        parentMessage,
      )

      await Promise.resolve()
      await Promise.resolve()
      expect(requestSignal).toBeDefined()
      expect(requestSignal?.aborted).toBe(false)

      vi.advanceTimersByTime(1000)
      await expect(callPromise).rejects.toThrow('timed out after 1s')
      expect(requestSignal?.aborted).toBe(true)
    } finally {
      if (originalTimeout === undefined) {
        delete process.env.MCP_TOOL_TIMEOUT
      } else {
        process.env.MCP_TOOL_TIMEOUT = originalTimeout
      }
    }
  })

  test('a throwing started callback does not prevent the tool call', async () => {
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'done' }],
      })),
    }
    const connection = {
      type: 'connected',
      name: 'started-throw-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn(({ data }: { data: { status: string } }) => {
      if (data.status === 'started') {
        throw new Error('progress consumer failure')
      }
    })
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_started_throw',
          name: tool!.name,
          input: {},
        },
      ],
    })

    await expect(
      tool!.call(
        {},
        {
          abortController: new AbortController(),
          setAppState: vi.fn(),
        } as never,
        undefined as never,
        parentMessage,
        onProgress,
      ),
    ).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
    expect(sdkClient.callTool).toHaveBeenCalledTimes(1)
  })

  test('a throwing progress callback does not break the tool call', async () => {
    vi.useFakeTimers()
    let resolveToolCall: ((result: unknown) => void) | undefined
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        () =>
          new Promise(resolve => {
            resolveToolCall = resolve
          }),
      ),
    }
    const connection = {
      type: 'connected',
      name: 'heartbeat-throw-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn(({ data }: { data: { status: string } }) => {
      if (data.status === 'progress') {
        throw new Error('progress consumer failure')
      }
    })
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_heartbeat_throw',
          name: tool!.name,
          input: {},
        },
      ],
    })

    const callPromise = tool!.call(
      {},
      {
        abortController: new AbortController(),
        setAppState: vi.fn(),
      } as never,
      undefined as never,
      parentMessage,
      onProgress,
    )
    await Promise.resolve()
    await Promise.resolve()

    // Heartbeat throws inside the timer callback; it must be contained
    // instead of surfacing as an uncaught exception.
    expect(() => vi.advanceTimersByTime(30_000)).not.toThrow()

    resolveToolCall?.({ content: [{ type: 'text', text: 'done' }] })
    await expect(callPromise).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
  })

  test('a throwing completed callback does not turn success into failure', async () => {
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'done' }],
      })),
    }
    const connection = {
      type: 'connected',
      name: 'completed-throw-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn(({ data }: { data: { status: string } }) => {
      if (data.status === 'completed') {
        throw new Error('progress consumer failure')
      }
    })
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_completed_throw',
          name: tool!.name,
          input: {},
        },
      ],
    })

    await expect(
      tool!.call(
        {},
        {
          abortController: new AbortController(),
          setAppState: vi.fn(),
        } as never,
        undefined as never,
        parentMessage,
        onProgress,
      ),
    ).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
    expect(sdkClient.callTool).toHaveBeenCalledTimes(1)
  })

  test('a throwing failed callback preserves the original tool error', async () => {
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(async () => {
        throw new Error('original tool failure')
      }),
    }
    const connection = {
      type: 'connected',
      name: 'failed-throw-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn(({ data }: { data: { status: string } }) => {
      if (data.status === 'failed') {
        throw new Error('progress consumer failure')
      }
    })
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_failed_throw',
          name: tool!.name,
          input: {},
        },
      ],
    })

    await expect(
      tool!.call(
        {},
        {
          abortController: new AbortController(),
          setAppState: vi.fn(),
        } as never,
        undefined as never,
        parentMessage,
        onProgress,
      ),
    ).rejects.toThrow('original tool failure')
  })

  test('a consumer throwing on forwarded server progress does not break the call', async () => {
    let resolveToolCall: ((result: unknown) => void) | undefined
    let reportServerProgress:
      | ((progress: { progress: number }) => void)
      | undefined
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        (
          _request: unknown,
          _schema: unknown,
          options: { onprogress?: typeof reportServerProgress },
        ) => {
          reportServerProgress = options.onprogress
          return new Promise(resolve => {
            resolveToolCall = resolve
          })
        },
      ),
    }
    const connection = {
      type: 'connected',
      name: 'forward-throw-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn(({ data }: { data: { status: string } }) => {
      if (data.status === 'progress') {
        throw new Error('progress consumer failure')
      }
    })
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_forward_throw',
          name: tool!.name,
          input: {},
        },
      ],
    })

    const callPromise = tool!.call(
      {},
      {
        abortController: new AbortController(),
        setAppState: vi.fn(),
      } as never,
      undefined as never,
      parentMessage,
      onProgress,
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(reportServerProgress).toBeDefined()

    // The consumer throws when a real server notification is forwarded; the
    // exception must not propagate into the MCP SDK notification handler.
    expect(() => reportServerProgress?.({ progress: 3 })).not.toThrow()

    resolveToolCall?.({ content: [{ type: 'text', text: 'done' }] })
    await expect(callPromise).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
  })

  test('session-expired retry resets cached server progress', async () => {
    vi.useFakeTimers()
    let callCount = 0
    let resolveToolCall: ((result: unknown) => void) | undefined
    let reportServerProgress:
      | ((progress: {
          progress: number
          total?: number
          message?: string
        }) => void)
      | undefined
    const sessionExpiredError = Object.assign(
      new Error('{"error":{"code":-32001,"message":"Session not found"}}'),
      { code: 404 },
    )
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        (
          _request: unknown,
          _schema: unknown,
          options: { onprogress?: typeof reportServerProgress },
        ) => {
          reportServerProgress = options.onprogress
          callCount++
          if (callCount === 1) {
            return new Promise((_resolve, reject) => {
              reportServerProgress?.({
                progress: 7,
                total: 10,
                message: 'Indexing files',
              })
              reject(sessionExpiredError)
            })
          }
          return new Promise(resolve => {
            resolveToolCall = resolve
          })
        },
      ),
    }
    const connection = {
      type: 'connected',
      name: 'session-retry-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn()
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_session_retry',
          name: tool!.name,
          input: {},
        },
      ],
    })

    const callPromise = tool!.call(
      {},
      {
        abortController: new AbortController(),
        setAppState: vi.fn(),
      } as never,
      undefined as never,
      parentMessage,
      onProgress,
    )
    // Let the first attempt fail with session expiry and the retry start.
    for (let i = 0; i < 50 && callCount < 2; i++) {
      await Promise.resolve()
    }
    expect(sdkClient.callTool).toHaveBeenCalledTimes(2)

    // Heartbeats during the retried attempt must not report the previous
    // attempt's cached progress, since the retried call starts over.
    onProgress.mockClear()
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(onProgress).toHaveBeenCalled()
    const lastCall = onProgress.mock.calls.at(-1)?.[0]
    expect(lastCall.data).toMatchObject({
      type: 'mcp_progress',
      status: 'progress',
    })
    expect(lastCall.data.progress).toBeUndefined()
    expect(lastCall.data.total).toBeUndefined()
    expect(lastCall.data.progressMessage).toBeUndefined()

    resolveToolCall?.({ content: [{ type: 'text', text: 'done' }] })
    await expect(callPromise).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
  })

  test('url-elicitation wait and retry reset cached server progress', async () => {
    vi.useFakeTimers()
    let callCount = 0
    let resolveToolCall: ((result: unknown) => void) | undefined
    let resolveElicitation:
      | ((result: { action: 'accept' }) => void)
      | undefined
    let reportServerProgress:
      | ((progress: {
          progress: number
          total?: number
          message?: string
        }) => void)
      | undefined
    const elicitationError = new McpError(
      ErrorCode.UrlElicitationRequired,
      'URL elicitation required',
      {
        elicitations: [
          {
            mode: 'url',
            url: 'https://example.com/auth',
            elicitationId: 'elicit-1',
            message: 'Open this URL to continue',
          },
        ],
      },
    )
    const sdkClient = {
      request: vi.fn(async () => ({
        tools: [
          {
            name: 'slow-tool',
            inputSchema: { type: 'object' },
          },
        ],
      })),
      callTool: vi.fn(
        (
          _request: unknown,
          _schema: unknown,
          options: { onprogress?: typeof reportServerProgress },
        ) => {
          reportServerProgress = options.onprogress
          callCount++
          if (callCount === 1) {
            return new Promise((_resolve, reject) => {
              reportServerProgress?.({
                progress: 7,
                total: 10,
                message: 'Indexing files',
              })
              reject(elicitationError)
            })
          }
          return new Promise(resolve => {
            resolveToolCall = resolve
          })
        },
      ),
    }
    const connection = {
      type: 'connected',
      name: 'url-elicitation-retry-test',
      config: { type: 'sdk' },
      capabilities: { tools: {} },
      client: sdkClient,
    } as unknown as ConnectedMCPServer
    const [tool] = await fetchToolsForClient(connection)
    expect(tool).toBeDefined()
    const onProgress = vi.fn()
    const parentMessage = createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_url_elicit_retry',
          name: tool!.name,
          input: {},
        },
      ],
    })

    const callPromise = tool!.call(
      {},
      {
        abortController: new AbortController(),
        setAppState: vi.fn(),
        handleElicitation: vi.fn(
          () =>
            new Promise<{ action: 'accept' }>(resolve => {
              resolveElicitation = resolve
            }),
        ),
      } as never,
      undefined as never,
      parentMessage,
      onProgress,
    )
    // Let the first attempt fail and block while the user handles the URL.
    for (let i = 0; i < 200 && !resolveElicitation; i++) {
      await Promise.resolve()
    }
    expect(resolveElicitation).toBeDefined()
    expect(sdkClient.callTool).toHaveBeenCalledTimes(1)

    // Heartbeats while waiting for elicitation must not report progress from
    // the abandoned protocol attempt.
    onProgress.mockClear()
    vi.advanceTimersByTime(30_000)
    await Promise.resolve()
    expect(onProgress).toHaveBeenCalled()
    const lastHeartbeat = onProgress.mock.calls.at(-1)?.[0]
    expect(lastHeartbeat.data).toMatchObject({
      type: 'mcp_progress',
      status: 'progress',
    })
    expect(lastHeartbeat.data.progress).toBeUndefined()
    expect(lastHeartbeat.data.total).toBeUndefined()
    expect(lastHeartbeat.data.progressMessage).toBeUndefined()

    resolveElicitation?.({ action: 'accept' })
    for (let i = 0; i < 200 && callCount < 2; i++) {
      await Promise.resolve()
    }
    expect(sdkClient.callTool).toHaveBeenCalledTimes(2)

    resolveToolCall?.({ content: [{ type: 'text', text: 'done' }] })
    await expect(callPromise).resolves.toMatchObject({
      data: [{ type: 'text', text: 'done' }],
    })
  })
})
