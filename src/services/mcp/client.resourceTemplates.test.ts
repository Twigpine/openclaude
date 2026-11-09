import { afterEach, describe, expect, test, vi } from 'vitest'
import { feature } from 'bun:bundle'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer } from './types.js'
import {
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  invalidateMcpFetchCaches,
  refreshMcpResourcesAndTemplates,
} from './client.js'
import { listAllMcpResourceTemplates } from './pagination.js'

type ListMethod =
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'prompts/list'
type ListRequest = {
  method: ListMethod
  params?: { cursor?: string }
}
type PageStep = unknown | Error

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve()
  }
}

function makeTemplateConnection(
  name: string,
  pages: Partial<Record<ListMethod, PageStep[]>>,
): { connection: ConnectedMCPServer; requests: ListRequest[] } {
  const requests: ListRequest[] = []
  const offsets = new Map<ListMethod, number>()
  const client = {
    request: async (
      request: ListRequest,
      resultSchema: { parse: (value: unknown) => unknown },
    ) => {
      requests.push(request)
      const steps = pages[request.method]
      if (!steps) {
        throw new Error(`unexpected ${request.method}`)
      }
      const offset = offsets.get(request.method) ?? 0
      offsets.set(request.method, offset + 1)
      const page = steps[offset]
      if (page === undefined) {
        throw new Error(`unexpected ${request.method} page ${offset + 1}`)
      }
      if (page instanceof Error) throw page
      return resultSchema.parse(page)
    },
  }

  return {
    connection: {
      type: 'connected',
      name,
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer,
    requests,
  }
}

describe('MCP resource-template discovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('repro: template-only server exposes its template via cache and tool path', async () => {
    const { connection, requests } = makeTemplateConnection('template-only', {
      'resources/list': [{ resources: [] }],
      'resources/templates/list': [
        {
          resourceTemplates: [
            { uriTemplate: 'file:///{path}', name: 'templated-file' },
          ],
        },
      ],
    })

    const templates = await fetchResourceTemplatesForClient(connection)
    const resources = await fetchResourcesForClient(connection)

    expect(resources).toEqual([])
    expect(templates).toEqual([
      { uriTemplate: 'file:///{path}', name: 'templated-file', server: 'template-only' },
    ])
    expect(
      requests.filter(r => r.method === 'resources/templates/list'),
    ).toEqual([{ method: 'resources/templates/list' }])
    expect(requests.filter(r => r.method === 'resources/list')).toEqual([
      { method: 'resources/list' },
    ])
  })

  test('mixed server populates resources and templates in one refresh', async () => {
    const { connection } = makeTemplateConnection('mixed', {
      'resources/list': [
        { resources: [{ uri: 'file:///concrete', name: 'concrete' }] },
      ],
      'resources/templates/list': [
        {
          resourceTemplates: [
            { uriTemplate: 'file:///{path}', name: 'templated-file' },
          ],
        },
      ],
    })

    const { resources, resourceTemplates } =
      await refreshMcpResourcesAndTemplates(connection)

    expect(resources.map(r => r.name)).toEqual(['concrete'])
    expect(resourceTemplates.map(t => t.name)).toEqual(['templated-file'])
    // Both fetchers now serve the refreshed traversal from cache.
    expect(
      (await fetchResourcesForClient(connection)).map(r => r.name),
    ).toEqual(['concrete'])
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['templated-file'])
  })

  test('legacy server returning -32601 syncs with empty templates', async () => {
    const { connection } = makeTemplateConnection('legacy-templates', {
      'resources/list': [
        { resources: [{ uri: 'file:///concrete', name: 'concrete' }] },
      ],
      'resources/templates/list': [
        new McpError(ErrorCode.MethodNotFound, 'Method not found'),
      ],
    })

    const { resources, resourceTemplates } =
      await refreshMcpResourcesAndTemplates(connection)

    expect(resources.map(r => r.name)).toEqual(['concrete'])
    expect(resourceTemplates).toEqual([])
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
  })

  test('non-32601 template failure is a discovery failure, not an empty list', async () => {
    const { connection } = makeTemplateConnection('failing-templates', {
      'resources/templates/list': [new Error('500 Internal Server Error')],
    })

    await expect(
      listAllMcpResourceTemplates(connection),
    ).rejects.toThrow('500 Internal Server Error')
    // The memoized fetcher mirrors fetchResourcesForClient: log and return [].
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
  })

  test('templates follow nextCursor in exact server order, including empty-string cursors', async () => {
    const { connection, requests } = makeTemplateConnection(
      'paged-templates',
      {
        'resources/templates/list': [
          {
            resourceTemplates: [{ uriTemplate: 'file:///{a}', name: 'a' }],
            nextCursor: 'page-2',
          },
          {
            resourceTemplates: [{ uriTemplate: 'file:///{b}', name: 'b' }],
            nextCursor: '',
          },
          {
            resourceTemplates: [{ uriTemplate: 'file:///{c}', name: 'c' }],
          },
        ],
      },
    )

    const templates = await fetchResourceTemplatesForClient(connection)

    expect(templates.map(t => t.name)).toEqual(['a', 'b', 'c'])
    expect(requests).toEqual([
      { method: 'resources/templates/list' },
      { method: 'resources/templates/list', params: { cursor: 'page-2' } },
      { method: 'resources/templates/list', params: { cursor: '' } },
    ])
  })

  test('repeated cursor aborts the traversal without caching a prefix', async () => {
    const { connection } = makeTemplateConnection('repeated-cursor', {
      'resources/templates/list': [
        {
          resourceTemplates: [{ uriTemplate: 'file:///{a}', name: 'a' }],
          nextCursor: 'again',
        },
        {
          resourceTemplates: [{ uriTemplate: 'file:///{b}', name: 'b' }],
          nextCursor: 'again',
        },
      ],
    })

    await expect(
      listAllMcpResourceTemplates(connection),
    ).rejects.toThrow('repeated a cursor')
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
  })

  test('production page ceiling fails template fetchers without caching a prefix', async () => {
    const { MCP_LIST_PAGE_LIMIT } = await import('./pagination.js')
    const templateRequests: ListRequest[] = []
    const connection = {
      type: 'connected',
      name: 'template-page-limit',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          templateRequests.push(request)
          const pageNumber = templateRequests.length
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: `file:///{p${pageNumber}}`, name: `t-${pageNumber}` },
            ],
            nextCursor: `cursor-${pageNumber}`,
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    await expect(
      listAllMcpResourceTemplates(connection),
    ).rejects.toThrow('page limit')
    expect(templateRequests).toHaveLength(MCP_LIST_PAGE_LIMIT)

    // The memoized fetcher swallows the bound violation like the other
    // fetchers do, and caches no partial prefix.
    const fetcherConnection = {
      type: 'connected',
      name: 'template-page-limit-fetcher',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: 'file:///{p}', name: 't' },
            ],
            nextCursor: 'cursor',
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer
    expect(await fetchResourceTemplatesForClient(fetcherConnection)).toEqual(
      [],
    )
  })

  test('template projection strips _meta and icons, caps fields, keeps uriTemplate exact', async () => {
    const longDescription = 'd'.repeat(3000)
    const { connection } = makeTemplateConnection('untrusted-templates', {
      'resources/templates/list': [
        {
          resourceTemplates: [
            {
              uriTemplate: 'file:///{path}',
              name: 'n'.repeat(3000),
              title: 't'.repeat(3000),
              description: longDescription,
              mimeType: 'text/plain',
              annotations: {
                audience: ['user'],
                priority: 0.5,
                lastModified: '2026-01-02T03:04:05.000Z',
              },
              _meta: { secret: 'must-not-leak' },
              icons: [{ src: 'https://example.invalid/icon.png' }],
              'x-experimental': 'must-not-leak',
            },
          ],
        },
      ],
    })

    const [template] = await fetchResourceTemplatesForClient(connection)

    expect(template).toEqual({
      uriTemplate: 'file:///{path}',
      name: 'n'.repeat(2048),
      title: 't'.repeat(2048),
      description: 'd'.repeat(2048),
      mimeType: 'text/plain',
      annotations: {
        audience: ['user'],
        priority: 0.5,
        lastModified: '2026-01-02T03:04:05.000Z',
      },
      server: 'untrusted-templates',
    })
    expect(JSON.stringify(template)).not.toContain('must-not-leak')
    expect(JSON.stringify(template)).not.toContain('example.invalid')
  })

  test('template metadata over the per-server byte cap fails the traversal', async () => {
    const { connection } = makeTemplateConnection('oversized-templates', {
      'resources/templates/list': [
        {
          resourceTemplates: [
            {
              uriTemplate: `file:///${'p'.repeat(1_100_000)}`,
              name: 'huge',
            },
          ],
        },
      ],
    })

    await expect(
      listAllMcpResourceTemplates(connection),
    ).rejects.toThrow('template metadata limit')
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
  })

  test('traversal running past the 60 second budget fails instead of hanging', async () => {
    vi.useFakeTimers()
    let page = 0
    const connection = {
      type: 'connected',
      name: 'slow-templates',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          page++
          if (page === 1) {
            // Page one takes 61 seconds to arrive. The second page request
            // then starts over the traversal budget and must fail.
            await new Promise(resolve => setTimeout(resolve, 61_000))
            return resultSchema.parse({
              resourceTemplates: [
                { uriTemplate: 'file:///{a}', name: 'a' },
              ],
              nextCursor: 'page-2',
            })
          }
          return resultSchema.parse({
            resourceTemplates: [{ uriTemplate: 'file:///{b}', name: 'b' }],
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const pending = listAllMcpResourceTemplates(connection)
    vi.advanceTimersByTime(61_000)
    await flushMicrotasks()
    await expect(pending).rejects.toThrow('60')
  })

  test('atomic refresh: templates failure retains the previous complete state', async () => {
    let generation = 1
    const requests: ListRequest[] = []
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        requests.push(request)
        if (request.method === 'resources/list') {
          return resultSchema.parse({
            resources: [
              { uri: `file:///r${generation}`, name: `r${generation}` },
            ],
          })
        }
        if (generation === 2) {
          throw new Error('500 Internal Server Error')
        }
        return resultSchema.parse({
          resourceTemplates: [
            { uriTemplate: `file:///{t${generation}}`, name: `t${generation}` },
          ],
        })
      },
    }
    const connection = {
      type: 'connected',
      name: 'atomic-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const first = await refreshMcpResourcesAndTemplates(connection)
    expect(first.resources.map(r => r.name)).toEqual(['r1'])
    expect(first.resourceTemplates.map(t => t.name)).toEqual(['t1'])

    // Generation 2: resources succeed, templates crash. The refresh must
    // fail and the previous complete cache entries must survive it.
    generation = 2
    await expect(
      refreshMcpResourcesAndTemplates(connection),
    ).rejects.toThrow('500 Internal Server Error')
    expect(
      (await fetchResourcesForClient(connection)).map(r => r.name),
    ).toEqual(['r1'])
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t1'])

    // Generation 3: both succeed, the refresh swaps in the new state.
    generation = 3
    const third = await refreshMcpResourcesAndTemplates(connection)
    expect(third.resources.map(r => r.name)).toEqual(['r3'])
    expect(third.resourceTemplates.map(t => t.name)).toEqual(['t3'])
  })

  test('invalidateMcpFetchCaches drops template entries for a replaced server', async () => {
    let generation = 1
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              {
                uriTemplate: `file:///{t${generation}}`,
                name: `t${generation}`,
              },
            ],
          })
        }
        return resultSchema.parse({ resources: [] })
      },
    }
    const connection = {
      type: 'connected',
      name: 'replaced-server',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t1'])
    generation = 2
    // Cached value is still served until the shared caches are invalidated.
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t1'])
    invalidateMcpFetchCaches(connection.name)
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t2'])
  })

  test('serialized list-changed refreshes cannot let an older traversal win', async () => {
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const mcpSkillsEnabled = feature('MCP_SKILLS') ? true : false
    if (mcpSkillsEnabled) {
      await import('../../skills/loadSkillsDir.js')
    }
    const fetchMcpSkillsForClient = mcpSkillsEnabled
      ? (await import('../../skills/mcpSkills.js')).fetchMcpSkillsForClient
      : null
    const handlers = new Map<string, () => Promise<void>>()
    let generation = 1
    // Gate the first resources/list request issued after warm-up so the
    // first traversal is still in flight when the second notification
    // arrives. The gate is armed only after the warm-up below completes.
    let releaseFirstResources: (() => void) | undefined
    let firstResourcesGate: Promise<void> | undefined
    let resourcesListCalls = 0
    const client = {
      request: async (
        request:
          | ListRequest
          | { method: 'resources/read'; params: { uri: string } },
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        // Capture the generation when the request is sent, not when the
        // response is built: a traversal in flight must keep the
        // generation it started with.
        const observedGeneration = generation
        if (request.method === 'resources/read') {
          return resultSchema.parse({
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'text/markdown',
                text: [
                  '---',
                  `name: skill-${observedGeneration}`,
                  'description: Serialized notification skill',
                  '---',
                  `# Skill ${observedGeneration}`,
                ].join('\n'),
              },
            ],
          })
        }
        const listRequest = request as ListRequest
        if (listRequest.method === 'resources/list') {
          resourcesListCalls++
          if (resourcesListCalls === 1 && firstResourcesGate) {
            await firstResourcesGate
          }
          return resultSchema.parse({
            resources: [
              {
                uri: `file:///resource-${observedGeneration}`,
                name: `resource-${observedGeneration}`,
              },
            ],
          })
        }
        if (listRequest.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              {
                uriTemplate: `file:///{template-${observedGeneration}}`,
                name: `template-${observedGeneration}`,
              },
            ],
          })
        }
        if (listRequest.method === 'tools/list') {
          return resultSchema.parse({
            tools: [{ name: 'tool', inputSchema: { type: 'object' } }],
          })
        }
        return resultSchema.parse({ prompts: [] })
      },
      setNotificationHandler: (
        schema: unknown,
        handler: () => Promise<void>,
      ) => {
        const method =
          schema === ToolListChangedNotificationSchema
            ? 'tools/list'
            : schema === ResourceListChangedNotificationSchema
              ? 'resources/list'
              : schema === PromptListChangedNotificationSchema
                ? 'prompts/list'
                : undefined
        if (method) handlers.set(method, handler)
      },
    }
    const connection = {
      type: 'connected',
      name: 'serialized-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    await Promise.all([
      fetchResourcesForClient(connection),
      fetchResourceTemplatesForClient(connection),
      fetchMcpSkillsForClient?.(connection) ?? Promise.resolve([]),
    ])
    // Arm the gate now that warm-up is done: the next resources/list
    // request (the first refresh traversal) waits until the test releases it.
    resourcesListCalls = 0
    firstResourcesGate = new Promise<void>(resolve => {
      releaseFirstResources = resolve
    })
    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(connection, update => updates.push(update))
    const resourcesHandler = handlers.get('resources/list')
    expect(resourcesHandler).toBeDefined()

    // Fire the first notification and let its traversal reach the gate
    // while it still observes generation 1, then fire the second one.
    const first = resourcesHandler!()
    await flushMicrotasks()
    generation = 2
    const second = resourcesHandler!()
    releaseFirstResources!()
    await Promise.all([first, second])
    await flushMicrotasks()

    const resourceUpdates = updates.filter(u => u.resources !== undefined)
    expect(resourceUpdates.map(u => u.resources?.map(r => r.name))).toEqual([
      ['resource-1'],
      ['resource-2'],
    ])
    const last = resourceUpdates[resourceUpdates.length - 1]
    expect(last.resources?.map(r => r.name)).toEqual(['resource-2'])
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['template-2'])
  })
})
