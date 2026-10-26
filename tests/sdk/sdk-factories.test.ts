import { describe, test, expect } from 'bun:test'
import {
  tool,
  createSdkMcpServer,
} from '../../src/entrypoints/sdk/index.js'

describe('tool() factory', () => {
  test('creates SdkMcpToolDefinition with required fields', () => {
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    })
    const def = tool('read_file', 'Read a file', { path: 'string' }, handler)

    expect(def.name).toBe('read_file')
    expect(def.description).toBe('Read a file')
    expect(def.inputSchema).toEqual({ path: 'string' })
    expect(def.handler).toBe(handler)
    expect(def.annotations).toBeUndefined()
    expect(def.searchHint).toBeUndefined()
    expect(def.alwaysLoad).toBeUndefined()
  })

  test('includes optional extras when provided', () => {
    const handler = async () => ({
      content: [{ type: 'text' as const, text: 'ok' }],
    })
    const def = tool('search', 'Search files', { query: 'string' }, handler, {
      annotations: { readOnlyHint: true },
      searchHint: 'file-search',
      alwaysLoad: true,
    })

    expect(def.annotations).toEqual({ readOnlyHint: true })
    expect(def.searchHint).toBe('file-search')
    expect(def.alwaysLoad).toBe(true)
  })

  test('handler can return CallToolResult', async () => {
    const handler = async (args: { path: string }) => ({
      content: [{ type: 'text' as const, text: `File: ${args.path}` }],
    })
    const def = tool('read', 'Read', { path: 'string' }, handler)

    const result = await def.handler({ path: '/tmp/test.txt' }, undefined)
    expect(result.content).toEqual([
      { type: 'text', text: 'File: /tmp/test.txt' },
    ])
  })
})

describe('createSdkMcpServer()', () => {
  test('wraps stdio config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'some-server'],
    })

    expect(config.type).toBe('stdio')
    expect(config.command).toBe('npx')
    expect(config.args).toEqual(['-y', 'some-server'])
    expect(config.scope).toBe('session')
  })

  test('wraps sse config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'sse',
      url: 'http://localhost:3001/sse',
      headers: { Authorization: 'Bearer token' },
    })

    expect(config.type).toBe('sse')
    expect(config.url).toBe('http://localhost:3001/sse')
    expect(config.scope).toBe('session')
  })

  test('wraps http config with session scope', () => {
    const config = createSdkMcpServer({
      type: 'http',
      url: 'http://localhost:3001/mcp',
    })

    expect(config.type).toBe('http')
    expect(config.url).toBe('http://localhost:3001/mcp')
    expect(config.scope).toBe('session')
  })

  test('preserves all original fields', () => {
    const config = createSdkMcpServer({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'test' },
    })

    expect(config.command).toBe('node')
    expect(config.args).toEqual(['server.js'])
    expect('env' in config ? config.env : undefined).toEqual({ API_KEY: 'test' })
  })
})
