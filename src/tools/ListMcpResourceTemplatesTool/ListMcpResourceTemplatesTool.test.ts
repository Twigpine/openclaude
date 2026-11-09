import { describe, expect, test } from 'vitest'
import type { ConnectedMCPServer } from '../../services/mcp/types.js'
import { ListMcpResourceTemplatesTool } from './ListMcpResourceTemplatesTool.js'

function makeConnection(name: string): ConnectedMCPServer {
  const client = {
    request: async (
      request: { method: string; params?: { cursor?: string } },
      resultSchema: { parse: (value: unknown) => unknown },
    ) => {
      if (request.method === 'resources/templates/list') {
        return resultSchema.parse({
          resourceTemplates: [
            { uriTemplate: 'file:///{path}', name: 'templated-file' },
          ],
        })
      }
      return resultSchema.parse({ resources: [] })
    },
  }
  return {
    type: 'connected',
    name,
    config: { type: 'sdk', scope: 'local' },
    capabilities: { tools: {}, resources: {}, prompts: {} },
    client,
    cleanup: async () => {},
  } as unknown as ConnectedMCPServer
}

function callTool(input: { server?: string }, clients: unknown[]) {
  return ListMcpResourceTemplatesTool.call(
    input,
    {
      options: { mcpClients: clients },
    } as Parameters<typeof ListMcpResourceTemplatesTool.call>[1],
  )
}

describe('ListMcpResourceTemplatesTool', () => {
  test('lists templates from a connected server', async () => {
    const connection = makeConnection('template-tool-server')

    const result = await callTool({}, [connection])

    expect(result.data).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'template-tool-server',
      },
    ])
  })

  test('filters by server name', async () => {
    const first = makeConnection('template-tool-first')
    const second = makeConnection('template-tool-second')

    const result = await callTool({ server: 'template-tool-second' }, [
      first,
      second,
    ])

    expect(result.data).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'template-tool-second',
      },
    ])
  })

  test('missing server names the available servers', async () => {
    const connection = makeConnection('template-tool-known')

    await expect(callTool({ server: 'nope' }, [connection])).rejects.toThrow(
      'Server "nope" not found. Available servers: template-tool-known',
    )
  })

  test('is read-only, concurrency-safe, and deferred like ListMcpResourcesTool', () => {
    expect(ListMcpResourceTemplatesTool.name).toBe(
      'ListMcpResourceTemplatesTool',
    )
    expect(ListMcpResourceTemplatesTool.isReadOnly()).toBe(true)
    expect(ListMcpResourceTemplatesTool.isConcurrencySafe()).toBe(true)
    expect(ListMcpResourceTemplatesTool.shouldDefer).toBe(true)
  })
})
