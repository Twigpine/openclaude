import { queryInternals, isTextBlock } from './helpers/query-test-doubles.js'
import type { SDKMessage } from '../../src/entrypoints/sdk/shared.js'
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { MockQueryEngine } from './helpers/mock-engine.js'
import {
  createSdkMcpServer,
  query,
  tool,
} from '../../src/entrypoints/sdk/index.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'

// ---------------------------------------------------------------------------
// No mock.module() — avoids module-cache leakage across test files.
// Instead, we replace the engine via setEngine() after query() returns.
// ---------------------------------------------------------------------------

// These tests iterate fully (no interrupt), so init() runs and may check for
// auth credentials. Provide a stub key so init() succeeds without network.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock('tests/sdk/query-happy-path.test.ts')
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) {
    process.env[AUTH_KEY] = 'sk-test-happy-path-stub'
  }
})

afterAll(() => {
  try {
    if (savedApiKey === undefined) {
      delete process.env[AUTH_KEY]
    } else {
      process.env[AUTH_KEY] = savedApiKey
    }
  } finally {
    releaseSharedMutationLock()
  }
})

/**
 * Create a Query with a MockQueryEngine wired in.
 * query() creates a real QueryEngine internally, which we immediately
 * replace with our mock via setEngine(). The real engine is discarded.
 */
function createMockedQuery(prompt: string): ReturnType<typeof query> {
  const mockEngine = new MockQueryEngine()
  const q = query({
    prompt,
    options: { cwd: process.cwd() },
  })
  // Replace the real engine with our mock before any iteration occurs.
  // The real QueryEngine was created synchronously in query() but
  // submitMessage() is only called when the async iterator is consumed.
  ;queryInternals(q).setEngine(mockEngine)
  return q
}

describe('Query happy-path — full lifecycle', () => {
  test('single-turn query completes with assistant + result messages', async () => {
    const q = createMockedQuery('hello from test')

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    // Should have at least an assistant message and a result message
    expect(messages.length).toBeGreaterThanOrEqual(2)

    const assistantMsgs = messages.filter(
      (m) => m?.type === 'assistant',
    )
    const resultMsgs = messages.filter(
      (m) => m?.type === 'result',
    )

    expect(assistantMsgs.length).toBeGreaterThanOrEqual(1)
    expect(resultMsgs.length).toBeGreaterThanOrEqual(1)
  })

  test('result message has success subtype and session_id', async () => {
    const q = createMockedQuery('check result fields')

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    const result = messages.find((m) => m?.type === 'result')
    expect(result).toBeDefined()
    expect(result!.subtype).toBe('success')
    expect(result!.session_id).toBeDefined()
    expect(typeof result!.session_id).toBe('string')
  })

  test('query sessionId is accessible before iteration', () => {
    const q = createMockedQuery('sessionId check')

    expect(q.sessionId).toBeDefined()
    expect(typeof q.sessionId).toBe('string')
    // Don't need to iterate — just verify the accessor works
    q.interrupt()
  })

  test('collectMessages (no catch) completes without throwing', async () => {
    const q = createMockedQuery('no error collection')

    // This must NOT throw — if it does, the query failed
    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    expect(messages.length).toBeGreaterThan(0)
  })

  test('assistant message contains prompt echo', async () => {
    const prompt = 'unique-test-prompt-12345'
    const q = createMockedQuery(prompt)

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    const assistant = messages.find((m) => m?.type === 'assistant')
    expect(assistant).toBeDefined()
    // Mock engine echoes the prompt in its response
    const textContent = assistant?.message?.content?.find(
      isTextBlock,
    )
    expect(textContent?.text).toContain(prompt)
  })

  test('invalid SDK agent definitions are emitted before engine output', async () => {
    const mockEngine = new MockQueryEngine()
    const q = query({
      prompt: 'agent failure visibility',
      options: {
        cwd: process.cwd(),
        agents: {
          broken: {
            description: 'Use for broken SDK agent coverage',
            prompt: 2 as unknown as string,
          },
          badLimit: {
            description: 'Use for invalid SDK agent step limit coverage',
            prompt: 'bad limit prompt',
            maxSteps: 0,
          },
        },
      },
    })
    ;queryInternals(q).setEngine(mockEngine)

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    expect(messages[0]).toMatchObject({
      type: 'agent_load_failure',
      stage: 'injection',
    })
    expect((messages[0] as Extract<SDKMessage, { type: 'agent_load_failure' }>).error_message).toContain("Invalid SDK agent 'broken'")
    const loadFailures = messages.filter(
      message => message?.type === 'agent_load_failure',
    )
    expect(loadFailures).toHaveLength(2)
    expect(loadFailures[1].error_message).toContain(
      "Invalid SDK agent 'badLimit'",
    )
    expect(loadFailures[1].error_message).toContain('maxSteps')
    const assistantIndex = messages.findIndex(
      message => message?.type === 'assistant',
    )
    expect(assistantIndex).toBeGreaterThan(1)
    expect(
      loadFailures.every(failure => messages.indexOf(failure) < assistantIndex),
    ).toBe(true)
    expect(messages.some(message => message?.type === 'assistant')).toBe(true)
    expect(
      mockEngine.config.agents.some(
        (agent) => agent?.agentType === 'badLimit',
      ),
    ).toBe(false)
  })

  test('valid SDK agents are exposed after successful engine injection', async () => {
    const mockEngine = new MockQueryEngine()
    const q = query({
      prompt: 'agent injection success',
      options: {
        cwd: process.cwd(),
        agents: {
          helper: {
            description: 'Use for successful SDK agent injection coverage',
            prompt: 'Help with SDK agent injection coverage',
            maxSteps: 2,
          },
        },
      },
    })
    ;queryInternals(q).setEngine(mockEngine)

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    expect(messages.some((message) => message?.type === 'assistant')).toBe(
      true,
    )
    expect(
      mockEngine.config.agents.some(
        (agent) => agent?.agentType === 'helper' && agent?.maxSteps === 2,
      ),
    ).toBe(true)
    expect(
      queryInternals(q).appStateStore
        .getState()
        .agentDefinitions.allAgents.some(
          (agent) => agent?.agentType === 'helper',
        ),
    ).toBe(true)
    expect(q.supportedAgents()).toContain('helper')
  })

  test('failed SDK agent injection does not expose uninjected user agents', async () => {
    const mockEngine = new MockQueryEngine()
    mockEngine.injectAgents = () => {
      throw new Error('injection rejected')
    }
    const q = query({
      prompt: 'agent injection failure',
      options: {
        cwd: process.cwd(),
        agents: {
          leaky: {
            description: 'Use for failed SDK agent injection coverage',
            prompt: 'Help with SDK agent injection failure coverage',
            maxSteps: 2,
          },
        },
      },
    })
    ;queryInternals(q).setEngine(mockEngine)

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    const failureIndex = messages.findIndex(
      message =>
        message?.type === 'agent_load_failure' &&
        message?.stage === 'injection' &&
        message?.error_message === 'injection rejected',
    )
    const assistantIndex = messages.findIndex(
      message => message?.type === 'assistant',
    )
    expect(failureIndex).toBeGreaterThanOrEqual(0)
    expect(failureIndex).toBeLessThan(assistantIndex)
    expect(q.supportedAgents()).not.toContain('leaky')
    expect(
      queryInternals(q).appStateStore
        .getState()
        .agentDefinitions.allAgents.some(
          (agent) => agent?.agentType === 'leaky',
        ),
    ).toBe(false)
  })

  test('denied SDK MCP tools are filtered before engine updateTools', async () => {
    const mockEngine = new MockQueryEngine()
    const deniedBash = tool(
      'Bash',
      'Denied MCP duplicate of Bash',
      { type: 'object', properties: {} },
      async () => ({ content: [{ type: 'text', text: 'denied' }] }),
    )
    const allowedSdkTool = tool(
      'sdkAllowed',
      'Allowed SDK MCP tool',
      { type: 'object', properties: {} },
      async () => ({ content: [{ type: 'text', text: 'allowed' }] }),
    )
    const q = query({
      prompt: 'mcp deny filtering',
      options: {
        cwd: process.cwd(),
        disallowedTools: ['Bash'],
        mcpServers: {
          'sdk-tools': createSdkMcpServer({
            type: 'sdk',
            name: 'sdk-tools',
            tools: [deniedBash, allowedSdkTool],
          }),
        },
      },
    })
    const initialToolNames = queryInternals(q).engine.config.tools.map(
      (entry) => entry?.name,
    )
    expect(initialToolNames.length).toBeGreaterThan(0)
    mockEngine.config.tools = [...queryInternals(q).engine.config.tools]
    ;queryInternals(q).setEngine(mockEngine)

    const messages: SDKMessage[] = []
    for await (const msg of q) {
      messages.push(msg)
    }

    const toolNames = mockEngine.config.tools.map((entry) => entry?.name)
    for (const initialToolName of initialToolNames) {
      expect(toolNames).toContain(initialToolName)
    }
    expect(toolNames).toContain('sdkAllowed')
    expect(toolNames).not.toContain('Bash')
    expect(messages.some(message => message?.type === 'assistant')).toBe(true)
  })
})

describe('mcpServerStatus() reads from engine.config.mcpClients', () => {
  test('returns empty array when no MCP clients configured', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })
    const status = q.mcpServerStatus()
    expect(status).toEqual([])
    q.interrupt()
  })

  test('maps connected client with serverInfo', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    // Simulate what connectSdkMcpServers does: write to engine.config.mcpClients
    ;queryInternals(q).engine.config.mcpClients = [
      {
        name: 'test-server',
        type: 'connected',
        serverInfo: { name: 'TestServer', version: '1.0' },
        config: { scope: 'project' },
      },
    ] as unknown as import('../../src/services/mcp/types.js').MCPServerConnection[]

    const status = q.mcpServerStatus()
    expect(status).toHaveLength(1)
    expect(status[0].name).toBe('test-server')
    expect(status[0].status).toBe('connected')
    expect(status[0].serverInfo).toEqual({ name: 'TestServer', version: '1.0' })
    expect(status[0].scope).toBe('project')
    q.interrupt()
  })

  test('maps failed client with error', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).engine.config.mcpClients = [
      {
        name: 'broken-server',
        type: 'failed',
        error: 'connection refused',
        config: { scope: 'user' },
      },
    ] as unknown as import('../../src/services/mcp/types.js').MCPServerConnection[]

    const status = q.mcpServerStatus()
    expect(status).toHaveLength(1)
    expect(status[0].name).toBe('broken-server')
    expect(status[0].status).toBe('failed')
    expect(status[0].error).toBe('connection refused')
    expect(status[0].scope).toBe('user')
    q.interrupt()
  })

  test('maps multiple clients of different types', () => {
    const q = query({ prompt: 'test', options: { cwd: process.cwd() } })

    ;queryInternals(q).engine.config.mcpClients = [
      { name: 'srv-connected', type: 'connected' },
      { name: 'srv-failed', type: 'failed', error: 'timeout' },
      { name: 'srv-pending', type: 'pending' },
    ] as unknown as import('../../src/services/mcp/types.js').MCPServerConnection[]

    const status = q.mcpServerStatus()
    expect(status).toHaveLength(3)
    expect(status[0]).toEqual({ name: 'srv-connected', status: 'connected' })
    expect(status[1]).toEqual({ name: 'srv-failed', status: 'failed', error: 'timeout' })
    expect(status[2]).toEqual({ name: 'srv-pending', status: 'pending' })
    q.interrupt()
  })
})
