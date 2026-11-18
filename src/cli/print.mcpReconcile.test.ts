import { describe, expect, test } from 'bun:test'
import type { McpServerConfigForProcessTransport } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { Tool, Tools } from '../Tool.js'
import { MCP_RESOURCE_HELPER_TOOLS } from '../services/mcp/client.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import {
  handleMcpSetServers,
  reconcileMcpServers,
  type DynamicMcpState,
  type SdkMcpState,
} from './print.js'

const [listResourcesTool, listTemplatesTool, readResourceTool] =
  MCP_RESOURCE_HELPER_TOOLS

function makeConnectedClient(
  name: string,
  supportsResources: boolean,
): MCPServerConnection {
  return {
    type: 'connected',
    name,
    config: { type: 'stdio', command: 'x', args: [], scope: 'dynamic' },
    capabilities: supportsResources ? { resources: {} } : {},
    client: {},
    cleanup: async () => {},
  } as unknown as MCPServerConnection
}

function makeAppState(
  tools: Tools,
  clients: MCPServerConnection[],
): AppState {
  return {
    mcp: { tools, clients, commands: [], resources: {} },
  } as unknown as AppState
}

describe('reconcileMcpServers — resource helper dedup', () => {
  test('merging dynamic tools does not duplicate helpers already in AppState', async () => {
    const dynClient = makeConnectedClient('dyn', true)
    const dynTool = {
      name: 'mcp__dyn__someTool',
    } as unknown as Tool
    const currentState: DynamicMcpState = {
      configs: {
        dyn: {
          type: 'stdio',
          command: 'x',
          args: [],
          scope: 'dynamic',
        } as unknown as DynamicMcpState['configs'][string],
      },
      clients: [dynClient],
      tools: [listResourcesTool, listTemplatesTool, dynTool],
    }
    let state = makeAppState(
      [listResourcesTool, listTemplatesTool, readResourceTool],
      [dynClient],
    )
    const setAppState = (fn: (prev: AppState) => AppState) => {
      state = fn(state)
    }

    const { newState } = await reconcileMcpServers(
      { dyn: { type: 'stdio', command: 'x', args: [] } } as unknown as Record<
        string,
        McpServerConfigForProcessTransport
      >,
      currentState,
      setAppState,
      [],
    )

    expect(newState.tools).toEqual(currentState.tools)
    const names = state.mcp.tools.map(t => t.name)
    for (const helper of MCP_RESOURCE_HELPER_TOOLS) {
      expect(names.filter(n => n === helper.name).length).toBe(1)
    }
  })
})

describe('handleMcpSetServers — SDK resource helper removal', () => {
  test('removing the last resource-capable SDK server drops the helpers from the SDK tool list', async () => {
    const sdkClient = makeConnectedClient('sdk-one', true)
    const sdkState: SdkMcpState = {
      configs: { 'sdk-one': { type: 'sdk', name: 'sdk-one' } },
      clients: [sdkClient],
      tools: [
        listResourcesTool,
        listTemplatesTool,
        readResourceTool,
        { name: 'mcp__sdk-one__someTool' } as unknown as Tool,
      ],
    }
    let state = makeAppState([], [])
    const setAppState = (fn: (prev: AppState) => AppState) => {
      state = fn(state)
    }

    const result = await handleMcpSetServers(
      {},
      sdkState,
      { configs: {}, clients: [], tools: [] },
      setAppState,
    )

    expect(result.response.removed).toEqual(['sdk-one'])
    for (const helper of MCP_RESOURCE_HELPER_TOOLS) {
      expect(
        result.newSdkState.tools.map(t => t.name),
      ).not.toContain(helper.name)
    }
    // The SDK server's own prefixed tool is gone too.
    expect(result.newSdkState.tools).toEqual([])
  })

  test('removing the last resource-capable SDK server keeps a still-connected server-owned tool with a helper name', async () => {
    const sdkA = makeConnectedClient('sdk-a', true)
    const sdkB = makeConnectedClient('sdk-b', false)
    // Server B is not resource-capable, but in no-prefix mode it supplies
    // its own tool named ReadMcpResourceTool. A name-only helper filter
    // would drop it together with the built-in helpers.
    const serverOwnedHelper = {
      name: 'ReadMcpResourceTool',
      mcpInfo: { serverName: 'sdk-b', toolName: 'ReadMcpResourceTool' },
    } as unknown as Tool
    const sdkState: SdkMcpState = {
      configs: {
        'sdk-a': { type: 'sdk', name: 'sdk-a' },
        'sdk-b': { type: 'sdk', name: 'sdk-b' },
      },
      clients: [sdkA, sdkB],
      tools: [
        listResourcesTool,
        listTemplatesTool,
        readResourceTool,
        serverOwnedHelper,
        { name: 'mcp__sdk-a__someTool' } as unknown as Tool,
      ],
    }
    let state = makeAppState(
      [serverOwnedHelper, listResourcesTool],
      [sdkB],
    )
    const setAppState = (fn: (prev: AppState) => AppState) => {
      state = fn(state)
    }

    const result = await handleMcpSetServers(
      { 'sdk-b': { type: 'sdk', name: 'sdk-b' } },
      sdkState,
      { configs: {}, clients: [], tools: [] },
      setAppState,
    )

    expect(result.response.removed).toEqual(['sdk-a'])
    // The built-in helpers are gone from the SDK tool list...
    for (const helper of MCP_RESOURCE_HELPER_TOOLS) {
      if (helper.name === 'ReadMcpResourceTool') continue
      expect(
        result.newSdkState.tools.map(t => t.name),
      ).not.toContain(helper.name)
    }
    // ...but server B's own tool with the helper name stays, here and in
    // AppState — while the built-in helper copy in AppState is dropped,
    // since no remaining server supports resources.
    expect(result.newSdkState.tools).toContain(serverOwnedHelper)
    expect(state.mcp.tools).toEqual([serverOwnedHelper])
  })
})
