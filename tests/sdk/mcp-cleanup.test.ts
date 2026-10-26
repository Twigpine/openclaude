import { queryInternals, sessionInternals } from './helpers/query-test-doubles.js'
import { describe, test, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { unstable_v2_createSession } from '../../src/entrypoints/sdk/index.js'
import { query } from '../../src/entrypoints/sdk/index.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../src/test/sharedMutationLock.js'

// sendMessage drains trigger init(), which checks auth. Stub it for CI.
const AUTH_KEY = 'ANTHROPIC_API_KEY'
let savedApiKey: string | undefined

beforeAll(async () => {
  await acquireSharedMutationLock('tests/sdk/mcp-cleanup.test.ts')
  savedApiKey = process.env[AUTH_KEY]
  if (!savedApiKey) process.env[AUTH_KEY] = 'sk-test-mcp-cleanup-stub'
})

afterAll(() => {
  try {
    if (savedApiKey === undefined) delete process.env[AUTH_KEY]
    else process.env[AUTH_KEY] = savedApiKey
  } finally {
    releaseSharedMutationLock()
  }
})

async function waitForMockCall(
  mockFn: ReturnType<typeof vi.fn>,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (mockFn.mock.calls.length > 0) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for MCP cleanup mock call')
}

describe('MCP cleanup on session close', () => {
  test('session.close() disconnects MCP clients', async () => {
    // Create a mock MCP client with a cleanup method
    const mockCleanup = vi.fn().mockResolvedValue(undefined)
    const mockMcpClient: MCPServerConnection = {
      type: 'connected',
      name: 'test-server',
      cleanup: mockCleanup,
      serverInfo: { name: 'test', version: '1.0' },
      tools: [],
      config: { scope: 'session' },
    }

    // Create session with mock MCP client injected via engine override
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })

    // Inject mock MCP client into the engine using setMcpClients
    const sessionImpl = sessionInternals(session)
    if (sessionImpl._engine?.setMcpClients) {
      sessionImpl._engine.setMcpClients([mockMcpClient])
    }

    // Close the session
    session.close()

    await waitForMockCall(mockCleanup)
    expect(mockCleanup).toHaveBeenCalled()
  })

  test('session.close() handles MCP cleanup errors gracefully', async () => {
    // Create a mock MCP client that throws on cleanup
    const mockCleanup = vi.fn().mockRejectedValue(new Error('MCP cleanup error'))
    const mockMcpClient: MCPServerConnection = {
      type: 'connected',
      name: 'error-server',
      cleanup: mockCleanup,
      serverInfo: { name: 'test', version: '1.0' },
      tools: [],
      config: { scope: 'session' },
    }

    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })

    // Inject mock MCP client
    const sessionImpl = sessionInternals(session)
    if (sessionImpl._engine?.setMcpClients) {
      sessionImpl._engine.setMcpClients([mockMcpClient])
    }

    // Close should not throw despite MCP cleanup error
    expect(() => session.close()).not.toThrow()

    await waitForMockCall(mockCleanup)
    expect(mockCleanup).toHaveBeenCalled()
  })

  test('session.close() clears engine reference', async () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })

    const sessionImpl = sessionInternals(session)
    expect(sessionImpl._engine).not.toBeNull()

    session.close()

    // Engine reference should be cleared
    expect(sessionImpl._engine).toBeNull()
  })

  test('session.close() handles missing MCP clients gracefully', async () => {
    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })

    // Remove MCP clients to simulate no MCP servers connected
    const sessionImpl = sessionInternals(session)
    if (sessionImpl._engine?.setMcpClients) {
      sessionImpl._engine.setMcpClients([])
    }

    // Close should not throw
    expect(() => session.close()).not.toThrow()
  })

  test('session.close() handles failed MCP clients (no cleanup)', async () => {
    // Failed client has no cleanup property
    const mockMcpClient: MCPServerConnection = {
      type: 'failed',
      name: 'failed-server',
      error: 'Connection refused',
      config: { scope: 'session' },
    }

    const session = unstable_v2_createSession({
      cwd: process.cwd(),
    })

    const sessionImpl = sessionInternals(session)
    if (sessionImpl._engine?.setMcpClients) {
      sessionImpl._engine.setMcpClients([mockMcpClient])
    }

    // Close should not throw - failed clients have no cleanup method
    expect(() => session.close()).not.toThrow()
  })
})

describe('MCP cleanup on query close', () => {
  test('query.close() disconnects MCP clients', async () => {
    const mockCleanup = vi.fn().mockResolvedValue(undefined)
    const mockMcpClient: MCPServerConnection = {
      type: 'connected',
      name: 'test-server',
      cleanup: mockCleanup,
      serverInfo: { name: 'test', version: '1.0' },
      tools: [],
      config: { scope: 'session' },
    }

    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })

    // Inject mock MCP client
    const queryImpl = queryInternals(q)
    if (queryImpl._engine?.setMcpClients) {
      queryImpl._engine.setMcpClients([mockMcpClient])
    }

    q.close()

    await waitForMockCall(mockCleanup)
    expect(mockCleanup).toHaveBeenCalled()
  })

  test('query.close() handles MCP cleanup errors gracefully', async () => {
    const mockCleanup = vi.fn().mockRejectedValue(new Error('MCP cleanup error'))
    const mockMcpClient: MCPServerConnection = {
      type: 'connected',
      name: 'error-server',
      cleanup: mockCleanup,
      serverInfo: { name: 'test', version: '1.0' },
      tools: [],
      config: { scope: 'session' },
    }

    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })

    const queryImpl = queryInternals(q)
    if (queryImpl._engine?.setMcpClients) {
      queryImpl._engine.setMcpClients([mockMcpClient])
    }

    expect(() => q.close()).not.toThrow()
    await waitForMockCall(mockCleanup)
    expect(mockCleanup).toHaveBeenCalled()
  })

  test('query.close() clears engine reference', async () => {
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })

    const queryImpl = queryInternals(q)
    expect(queryImpl._engine).not.toBeNull()

    q.close()

    expect(queryImpl._engine).toBeNull()
  })

  test('query.close() handles missing MCP clients gracefully', async () => {
    const q = query({
      prompt: 'test',
      options: { cwd: process.cwd() },
    })

    const queryImpl = queryInternals(q)
    if (queryImpl._engine?.setMcpClients) {
      queryImpl._engine.setMcpClients([])
    }

    expect(() => q.close()).not.toThrow()
  })
})
