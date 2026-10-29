import { describe, test, expect } from 'bun:test'
import { tool, createSdkMcpServer, query } from '../../src/entrypoints/sdk/index.js'
import { connectSdkMcpServers } from '../../src/entrypoints/sdk/permissions.js'

// Type-level test: SdkMcpSdkConfig accepts tools field
type AssertToolsField = {
  type: 'sdk'
  name: string
  tools?: import('../../src/entrypoints/sdk/index.js').SdkMcpToolDefinition[]
}

describe('SDK MCP type:sdk tools wiring', () => {
  test('createSdkMcpServer with type:sdk and tools compiles and works', () => {
    // This is primarily a type-level test — ensuring the API accepts tools
    const myTool = tool(
      'echo',
      'Echo back the input',
      { type: 'object', properties: { message: { type: 'string' } } },
      async (args: { message: string }) => ({
        content: [{ type: 'text', text: args.message }],
      }),
    )

    const sdkServer = createSdkMcpServer({
      type: 'sdk',
      name: 'my-sdk-tools',
      tools: [myTool],
    })

    // Verify scope is set
    expect(sdkServer.scope).toBe('session')
    expect(sdkServer.type).toBe('sdk')
    expect(sdkServer.name).toBe('my-sdk-tools')
    expect(sdkServer.tools).toBeDefined()
    expect(sdkServer.tools!.length).toBe(1)
    expect(sdkServer.tools![0].name).toBe('echo')
  })

  test('tool() helper produces SdkMcpToolDefinition with handler', () => {
    const myTool = tool(
      'add',
      'Add two numbers',
      { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
      async (args: { a: number; b: number }) => ({
        content: [{ type: 'text', text: String(args.a + args.b) }],
      }),
    )

    expect(myTool.name).toBe('add')
    expect(myTool.description).toBe('Add two numbers')
    expect(myTool.handler).toBeDefined()
    expect(typeof myTool.handler).toBe('function')
  })

  test('query with mcpServers containing type:sdk tools validates', async () => {
    // This test ensures the query() function accepts mcpServers with SDK-type configs
    const myTool = tool(
      'greet',
      'Greet someone',
      { type: 'object', properties: { name: { type: 'string' } } },
      async (args: { name: string }) => ({
        content: [{ type: 'text', text: `Hello, ${args.name}!` }],
      }),
    )

    const q = query({
      prompt: 'test',
      options: {
        cwd: process.cwd(),
        mcpServers: {
          'sdk-tools': createSdkMcpServer({
            type: 'sdk',
            name: 'sdk-tools',
            tools: [myTool],
          }),
        },
      },
    })

    // Query was created successfully — that's the validation
    expect(q.sessionId).toBeDefined()
    q.close()
  })

  test('connectSdkMcpServers() with type:sdk returns empty clients, tools with handler', async () => {
    // Direct test of connectSdkMcpServers function
    const echoTool = tool(
      'echo',
      'Echo input',
      { type: 'object', properties: { text: { type: 'string' } } },
      async (args: { text: string }) => ({
        content: [{ type: 'text', text: args.text }],
      }),
    )

    const mcpServers = {
      'test-sdk': createSdkMcpServer({
        type: 'sdk',
        name: 'test-sdk',
        tools: [echoTool],
      }),
    }

    const { clients, tools } = await connectSdkMcpServers(mcpServers)

    // SDK-type servers create NO MCP clients (in-process only)
    expect(clients.length).toBe(0)

    // But they DO create Tool objects with proper shape
    expect(tools.length).toBe(1)
    expect(tools[0].name).toBe('echo')
    // description is an async function in Tool interface
    expect(await tools[0].description()).toBe('Echo input')
    expect(tools[0].call).toBeDefined()
    expect(typeof tools[0].call).toBe('function')

    // Verify tool handler works - test via handler directly
    // call() needs full QueryContext, so test handler directly
    const handlerResult = await echoTool.handler({ text: 'hello' }, {})
    expect(handlerResult).toBeDefined()
    expect(handlerResult.content).toBeDefined()
    expect(Array.isArray(handlerResult.content)).toBe(true)
    expect(handlerResult.content[0].type).toBe('text')
    expect(handlerResult.content[0].text).toBe('hello')
  })
})