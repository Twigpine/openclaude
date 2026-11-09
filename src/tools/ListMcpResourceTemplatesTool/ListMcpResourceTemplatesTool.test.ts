import { describe, expect, test, vi } from 'vitest'
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

  test('issues exactly one templates/list request and no SDK reads', async () => {
    // Record every outbound request: the per-server error handling returns
    // [] on failure, so asserting only on the result could pass without
    // the tool ever asking the server. Also spy on the SDK read and
    // completion methods — a template listing must never invoke them.
    const requests: unknown[] = []
    const client = {
      request: async (
        request: { method: string; params?: { cursor?: string } },
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        requests.push(request)
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: 'file:///{path}', name: 'templated-file' },
            ],
          })
        }
        return resultSchema.parse({ resources: [] })
      },
      readResource: vi.fn(),
      complete: vi.fn(),
    }
    const connection = {
      type: 'connected',
      name: 'template-tool-asserted',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const result = await callTool({}, [connection])

    expect(requests).toEqual([{ method: 'resources/templates/list' }])
    expect(client.readResource).not.toHaveBeenCalled()
    expect(client.complete).not.toHaveBeenCalled()
    expect(result.data).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'template-tool-asserted',
      },
    ])
  })

  test('rejects an oversized multi-server result', async () => {
    const makeBigConnection = (name: string): ConnectedMCPServer => {
      const client = {
        request: async (
          request: { method: string; params?: { cursor?: string } },
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          if (request.method === 'resources/templates/list') {
            return resultSchema.parse({
              resourceTemplates: Array.from({ length: 10 }, (_, i) => ({
                uriTemplate: `file:///${name}/${i}/{path}`,
                // Fields cap at 2048 chars each after projection, so ten
                // templates per server is ~62k chars of retained metadata.
                name: 'n'.repeat(3000),
                title: 't'.repeat(3000),
                description: 'd'.repeat(3000),
              })),
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

    // Two servers stay under the per-server byte budget, but the combined
    // payload exceeds the 100,000-character tool result limit.
    await expect(
      callTool({}, [
        makeBigConnection('oversized-first'),
        makeBigConnection('oversized-second'),
      ]),
    ).rejects.toThrow('exceeds 100,000 characters')
  })
})
