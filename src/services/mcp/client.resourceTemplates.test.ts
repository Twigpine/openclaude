import { afterEach, describe, expect, test, vi } from 'vitest'
import { feature } from 'bun:bundle'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer } from './types.js'
import {
  MCP_RESOURCE_HELPER_TOOLS,
  fetchResourceTemplatesForClient,
  fetchResourcesForClient,
  invalidateMcpFetchCaches,
  refreshMcpResourcesAndTemplates,
  registerMcpResourceListChangedHandler,
  setupSdkMcpClients,
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

type ListChangedGate = { promise: Promise<void> | undefined }

/**
 * Build a connected server with capturable list_changed handlers for the
 * refresh-queue tests. The gate, when armed after warm-up, holds the first
 * post-warm-up resources/list request; resetResourcesListCalls restarts
 * the counter so the gate applies to the refresh, not the warm-up.
 */
function makeListChangedConnection(
  name: string,
  resources: { uri: string; name: string }[],
  templates: { uriTemplate: string; name: string }[],
  gate?: ListChangedGate,
): {
  connection: ConnectedMCPServer
  handlers: Map<string, () => Promise<void>>
  requests: ListRequest[]
  resetResourcesListCalls: () => void
} {
  const handlers = new Map<string, () => Promise<void>>()
  const requests: ListRequest[] = []
  let resourcesListCalls = 0
  const client = {
    request: async (
      request:
        | ListRequest
        | { method: 'resources/read'; params: { uri: string } },
      resultSchema: { parse: (value: unknown) => unknown },
    ) => {
      if (request.method === 'resources/read') {
        return resultSchema.parse({
          contents: [
            {
              uri: (request as { params: { uri: string } }).params.uri,
              mimeType: 'text/markdown',
              text: '---\nname: skill\n---\n# Skill',
            },
          ],
        })
      }
      const listRequest = request as ListRequest
      requests.push(listRequest)
      if (listRequest.method === 'resources/list') {
        resourcesListCalls++
        if (resourcesListCalls === 1 && gate?.promise) {
          await gate.promise
        }
        return resultSchema.parse({ resources })
      }
      if (listRequest.method === 'resources/templates/list') {
        return resultSchema.parse({ resourceTemplates: templates })
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
    name,
    config: { type: 'sdk', scope: 'local' },
    capabilities: {
      tools: { listChanged: true },
      resources: { listChanged: true },
      prompts: { listChanged: true },
    },
    client,
    cleanup: async () => {},
  } as unknown as ConnectedMCPServer

  return {
    connection,
    handlers,
    requests,
    resetResourcesListCalls: () => {
      resourcesListCalls = 0
    },
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
    const { connection, requests } = makeTemplateConnection('legacy-templates', {
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
    // The legitimate -32601 empty result stays cached: the next listing
    // serves it without re-requesting, unlike a transient failure.
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
    expect(
      requests.filter(r => r.method === 'resources/templates/list'),
    ).toHaveLength(1)
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

  test('failed template traversal is retried on the next listing', async () => {
    const { connection } = makeTemplateConnection('flaky-templates', {
      'resources/templates/list': [
        new Error('500 Internal Server Error'),
        {
          resourceTemplates: [
            { uriTemplate: 'file:///{path}', name: 'templated-file' },
          ],
        },
      ],
    })

    // The first listing fails transiently and reports no templates...
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
    // ...but the failure must not be cached: the next listing retries and
    // sees the recovered server.
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'flaky-templates',
      },
    ])
  })

  test('a failed fetch does not evict a replacement fetch installed during its first yield', async () => {
    const { connection, requests } = makeTemplateConnection(
      'yield-race-templates',
      {
        'resources/templates/list': [
          new Error('500 Internal Server Error'),
          {
            resourceTemplates: [
              { uriTemplate: 'file:///{path}', name: 'templated-file' },
            ],
          },
        ],
      },
    )

    // Start the first fetch, then — synchronously, before its first
    // continuation runs — invalidate and start the replacement fetch.
    // The first fetch resumes after the replacement is installed, so a
    // cache-entry check alone would point at the replacement's promise
    // and its failure would evict the replacement's successful templates.
    const failing = fetchResourceTemplatesForClient(connection)
    invalidateMcpFetchCaches(connection.name)
    const replacement = fetchResourceTemplatesForClient(connection)
    expect(await failing).toEqual([])
    expect(await replacement).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'yield-race-templates',
      },
    ])
    // The replacement's templates stay cached: no third traversal runs.
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['templated-file'])
    expect(
      requests.filter(r => r.method === 'resources/templates/list'),
    ).toHaveLength(2)
  })

  test('first-page MethodNotFound arriving after the deadline is rejected', async () => {
    vi.useFakeTimers()
    const connection = {
      type: 'connected',
      name: 'overdue-legacy-templates',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          _resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          // The legacy response arrives 61 seconds in — past the 60s
          // traversal deadline. It must reject like any other overdue
          // page, not be converted into a cached empty list.
          await new Promise(resolve => setTimeout(resolve, 61_000))
          throw new McpError(ErrorCode.MethodNotFound, 'Method not found')
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const pending = listAllMcpResourceTemplates(connection)
    vi.advanceTimersByTime(61_000)
    await flushMicrotasks()
    await expect(pending).rejects.toThrow('Method not found')
  })

  test('overdue first-page MethodNotFound is not cached: the next listing retries after recovery', async () => {
    vi.useFakeTimers()
    let templatesCalls = 0
    const connection = {
      type: 'connected',
      name: 'overdue-recovery-templates',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          templatesCalls++
          if (templatesCalls === 1) {
            await new Promise(resolve => setTimeout(resolve, 61_000))
            throw new McpError(ErrorCode.MethodNotFound, 'Method not found')
          }
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: 'file:///{path}', name: 'templated-file' },
            ],
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    // The first listing reports no templates — the overdue error is a
    // failure, not a legacy empty result...
    const first = fetchResourceTemplatesForClient(connection)
    // Let the traversal issue the first-page request (arming its 61s
    // timer) before moving the clock: the fetch yields once before
    // traversing, so the request is not issued synchronously.
    await flushMicrotasks()
    vi.advanceTimersByTime(61_000)
    await flushMicrotasks()
    expect(await first).toEqual([])
    // ...but the failure must not be cached: the next listing retries and
    // sees the recovered server.
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([
      {
        uriTemplate: 'file:///{path}',
        name: 'templated-file',
        server: 'overdue-recovery-templates',
      },
    ])
    expect(templatesCalls).toBe(2)
  })

  test('traversal rejects while a later page request is still pending', async () => {
    vi.useFakeTimers()
    let page = 0
    const connection = {
      type: 'connected',
      name: 'pending-templates',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
          options?: { timeout?: number },
        ) => {
          page++
          if (page === 1) {
            // Page one takes 55 seconds to arrive.
            await new Promise(resolve => setTimeout(resolve, 55_000))
            return resultSchema.parse({
              resourceTemplates: [
                { uriTemplate: 'file:///{a}', name: 'a' },
              ],
              nextCursor: 'page-2',
            })
          }
          // Page two never resolves on its own: only the per-request
          // timeout (5s of budget left) can fail it. Without the remaining
          // budget applied to each request, this would hang past the
          // traversal deadline instead of rejecting.
          if (options?.timeout === undefined) {
            await new Promise(() => {})
          }
          await new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('Request timed out')),
              options?.timeout,
            )
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const pending = listAllMcpResourceTemplates(connection)
    vi.advanceTimersByTime(55_000)
    await flushMicrotasks()
    // The second request starts with 5s of budget left; its timeout fires.
    vi.advanceTimersByTime(5_000)
    await flushMicrotasks()
    await expect(pending).rejects.toThrow('timed out')
  })

  test('first page that never resolves is cut off by the traversal deadline', async () => {
    vi.useFakeTimers()
    const connection = {
      type: 'connected',
      name: 'hanging-first-page',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          _resultSchema: { parse: (value: unknown) => unknown },
          options?: { timeout?: number },
        ) => {
          // The first page never resolves on its own: only the per-request
          // timeout (the full 60s budget on page one) can fail it. Without
          // the remaining budget applied to each request, this would hang
          // past the traversal deadline instead of rejecting.
          if (options?.timeout === undefined) {
            await new Promise(() => {})
          }
          await new Promise((_resolve, reject) => {
            setTimeout(
              () => reject(new Error('Request timed out')),
              options?.timeout,
            )
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const pending = listAllMcpResourceTemplates(connection)
    vi.advanceTimersByTime(60_000)
    await flushMicrotasks()
    await expect(pending).rejects.toThrow('timed out')
  })

  test('terminal page arriving after the deadline is rejected', async () => {
    vi.useFakeTimers()
    let page = 0
    const connection = {
      type: 'connected',
      name: 'terminal-templates',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          page++
          if (page === 1) {
            return resultSchema.parse({
              resourceTemplates: [
                { uriTemplate: 'file:///{a}', name: 'a' },
              ],
              nextCursor: 'page-2',
            })
          }
          // Page two takes 61 seconds to arrive and is terminal. The old
          // code returned it as a success and cached it; the deadline
          // check after resolution must reject it instead.
          await new Promise(resolve => setTimeout(resolve, 61_000))
          return resultSchema.parse({
            resourceTemplates: [{ uriTemplate: 'file:///{b}', name: 'b' }],
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const pending = listAllMcpResourceTemplates(connection)
    // Let page one resolve so page two's request (and its timer) is issued
    // before moving the clock.
    await flushMicrotasks()
    vi.advanceTimersByTime(61_000)
    await flushMicrotasks()
    await expect(pending).rejects.toThrow('60')
  })

  test('template URI templates keep their exact identifier', async () => {
    const { connection } = makeTemplateConnection('exact-identifiers', {
      'resources/templates/list': [
        {
          resourceTemplates: [
            {
              // Fullwidth A must survive: NFKC would rewrite it to ASCII A
              // and a read built from the listed value would target a
              // different resource.
              uriTemplate: 'file:///Ａ/{path}',
              name: 'fullwidth',
            },
            {
              // A hostile _meta must never reach the sanitizer or the output.
              uriTemplate: 'file:///{meta}',
              name: 'meta-heavy',
              _meta: {
                nested: {
                  deeply: { nested: { value: 'must-not-leak' } },
                },
                junk: 'x'.repeat(10_000),
              },
            },
          ],
        },
      ],
    })

    const [fullwidth, metaHeavy] =
      await fetchResourceTemplatesForClient(connection)

    expect(fullwidth).toEqual({
      uriTemplate: 'file:///Ａ/{path}',
      name: 'fullwidth',
      server: 'exact-identifiers',
    })
    expect(metaHeavy).toEqual({
      uriTemplate: 'file:///{meta}',
      name: 'meta-heavy',
      server: 'exact-identifiers',
    })
  })

  test('refresh superseded by a server replacement reports stale', async () => {
    let generation = 1
    let releaseResources: (() => void) | undefined
    let resourcesGate: Promise<void> | undefined
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/list') {
          // Gate the first resources/list request so the refresh is still
          // in flight when the replacement invalidates the caches.
          if (resourcesGate) {
            await resourcesGate
          }
          return resultSchema.parse({
            resources: [{ uri: `file:///r${generation}`, name: `r${generation}` }],
          })
        }
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: `file:///{t${generation}}`, name: `t${generation}` },
            ],
          })
        }
        throw new Error(`unexpected ${request.method}`)
      },
    }
    const connection = {
      type: 'connected',
      name: 'stale-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    // Warm the cache with generation 1.
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t1'])

    // Arm the gate, start a refresh, then replace the server (which
    // invalidates the caches) while its traversals are still in flight.
    // The refresh must report stale and write nothing back.
    resourcesGate = new Promise<void>(resolve => {
      releaseResources = resolve
    })
    const pending = refreshMcpResourcesAndTemplates(connection)
    await flushMicrotasks()
    generation = 2
    invalidateMcpFetchCaches(connection.name)
    releaseResources!()
    const result = await pending
    expect(result.stale).toBe(true)
    // The stale refresh must not have repopulated the cache: the next
    // listing re-fetches and sees the replacement's templates.
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(
      false,
    )
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t2'])
  })

  test('cache-only list_changed handler refreshes the template cache', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    let generation = 1
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: `file:///{t${generation}}`, name: `t${generation}` },
            ],
          })
        }
        return resultSchema.parse({
          resources: [{ uri: `file:///r${generation}`, name: `r${generation}` }],
        })
      },
      setNotificationHandler: (
        schema: unknown,
        handler: () => Promise<void>,
      ) => {
        if (schema === ResourceListChangedNotificationSchema) {
          handlers.set('resources/list', handler)
        }
      },
    }
    const connection = {
      type: 'connected',
      name: 'headless-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: { listChanged: true } },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    // Warm the cache, then change generation and fire the notification.
    // This is the headless path: no React hook runs, so only the
    // cache-only handler can refresh the templates.
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t1'])
    registerMcpResourceListChangedHandler(connection)
    const handler = handlers.get('resources/list')
    expect(handler).toBeDefined()
    generation = 2
    await handler!()
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t2'])
  })

  test('cache-only list_changed handler skips servers without listChanged', async () => {
    const handlers = new Map<string, () => Promise<void>>()
    const client = {
      request: async () => {
        throw new Error('must not be called')
      },
      setNotificationHandler: (
        schema: unknown,
        handler: () => Promise<void>,
      ) => {
        handlers.set('any', handler)
      },
    }
    const connection = {
      type: 'connected',
      name: 'no-list-changed',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    registerMcpResourceListChangedHandler(connection)
    expect(handlers.size).toBe(0)
  })

  test('burst of list_changed notifications coalesces into one final refresh', async () => {
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
    // first traversal is still in flight when the burst arrives.
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
      name: 'coalesced-refresh',
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

    // Fire three notifications while the first traversal is gated. Only
    // one final refresh may run after it — a traversal per notification
    // would keep consuming resources long after the burst.
    const first = resourcesHandler!()
    await flushMicrotasks()
    generation = 2
    const second = resourcesHandler!()
    generation = 3
    const third = resourcesHandler!()
    releaseFirstResources!()
    await Promise.all([first, second, third])
    await flushMicrotasks()

    const resourceUpdates = updates.filter(u => u.resources !== undefined)
    expect(resourceUpdates.map(u => u.resources?.map(r => r.name))).toEqual([
      ['resource-1'],
      ['resource-3'],
    ])
  })

  test('stale list_changed refresh publishes nothing after replacement', async () => {
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
      name: 'stale-handler-refresh',
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

    // Fire one notification, then replace the server while its traversal
    // is still in flight. The stale refresh must publish nothing and must
    // not repopulate the cache with the old client's data.
    const refresh = resourcesHandler!()
    await flushMicrotasks()
    generation = 2
    invalidateMcpFetchCaches(connection.name)
    releaseFirstResources!()
    await refresh
    await flushMicrotasks()

    expect(updates).toEqual([])
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(
      false,
    )
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['template-2'])
  })

  test('late list_changed notification from a retired connection publishes nothing', async () => {
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
    let listCalls = 0
    const client = {
      request: async (
        request:
          | ListRequest
          | { method: 'resources/read'; params: { uri: string } },
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
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
                  'description: Late notification skill',
                  '---',
                  `# Skill ${observedGeneration}`,
                ].join('\n'),
              },
            ],
          })
        }
        const listRequest = request as ListRequest
        listCalls++
        if (listRequest.method === 'resources/list') {
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
      name: 'late-notification-refresh',
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
    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(connection, update => updates.push(update))
    const resourcesHandler = handlers.get('resources/list')
    expect(resourcesHandler).toBeDefined()

    // The server is replaced — the old connection is retired, but stdio
    // cleanup left it running, so its notification still arrives. The
    // retired connection's handler must discard it instead of queueing a
    // refresh that would republish the old client's data.
    generation = 2
    invalidateMcpFetchCaches(connection.name)
    const callsBefore = listCalls
    await resourcesHandler!()
    await flushMicrotasks()

    expect(updates).toEqual([])
    expect(listCalls).toBe(callsBefore)
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(
      false,
    )
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['template-2'])
  })

  test('late list_changed notification does not refresh the cache-only handler', async () => {
    let generation = 1
    let listCalls = 0
    const handlers = new Map<string, () => Promise<void>>()
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        const observedGeneration = generation
        listCalls++
        if (request.method === 'resources/list') {
          return resultSchema.parse({
            resources: [
              {
                uri: `file:///resource-${observedGeneration}`,
                name: `resource-${observedGeneration}`,
              },
            ],
          })
        }
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              {
                uriTemplate: `file:///{template-${observedGeneration}}`,
                name: `template-${observedGeneration}`,
              },
            ],
          })
        }
        return resultSchema.parse({ prompts: [] })
      },
      setNotificationHandler: (
        schema: unknown,
        handler: () => Promise<void>,
      ) => {
        if (schema === ResourceListChangedNotificationSchema) {
          handlers.set('resources/list', handler)
        }
      },
    }
    const connection = {
      type: 'connected',
      name: 'late-cache-only-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: { listChanged: true } },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['template-1'])
    registerMcpResourceListChangedHandler(connection)
    const resourcesHandler = handlers.get('resources/list')
    expect(resourcesHandler).toBeDefined()

    // Replace the server, then deliver a late notification on the retired
    // connection. The cache-only handler must discard it: no traversal
    // runs and the invalidated cache stays empty.
    generation = 2
    invalidateMcpFetchCaches(connection.name)
    const callsBefore = listCalls
    await resourcesHandler!()
    await flushMicrotasks()

    expect(listCalls).toBe(callsBefore)
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(
      false,
    )
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['template-2'])
  })

  test('a queued refresh recorded for a retired connection does not replay after replacement', async () => {
    const { enqueueResourceRefresh } = await import('./client.js')
    let releaseFirstResources: (() => void) | undefined
    let firstResourcesGate: Promise<void> | undefined
    let resourcesListCalls = 0
    let replayedRefreshRan = false
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/list') {
          resourcesListCalls++
          if (resourcesListCalls === 1 && firstResourcesGate) {
            await firstResourcesGate
          }
          return resultSchema.parse({
            resources: [{ uri: 'file:///r1', name: 'r1' }],
          })
        }
        if (request.method === 'resources/templates/list') {
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: 'file:///{t1}', name: 't1' },
            ],
          })
        }
        return resultSchema.parse({ prompts: [] })
      },
    }
    const connection = {
      type: 'connected',
      name: 'retired-replay-refresh',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: { listChanged: true } },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    // Gate the active refresh's resources traversal.
    firstResourcesGate = new Promise<void>(resolve => {
      releaseFirstResources = resolve
    })
    const active = enqueueResourceRefresh(connection.name, async () => {
      await refreshMcpResourcesAndTemplates(connection)
    })
    await flushMicrotasks()
    expect(resourcesListCalls).toBe(1)

    // The server is replaced while the refresh is in flight. A late
    // notification from the retired connection now queues a refresh: it
    // must record the retired connection's generation, not the
    // replacement's, so the replay fence discards it.
    invalidateMcpFetchCaches(connection.name)
    const queued = enqueueResourceRefresh(
      connection.name,
      async () => {
        replayedRefreshRan = true
        await refreshMcpResourcesAndTemplates(connection)
      },
      0,
    )
    releaseFirstResources!()
    await active
    await queued
    await flushMicrotasks()

    expect(replayedRefreshRan).toBe(false)
    expect(resourcesListCalls).toBe(1)
  })

  test('tool and prompt refresh updates carry the refresh-only guard', async () => {
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const { connection, handlers } = makeListChangedConnection(
      'guard-refresh',
      [{ uri: 'file:///r1', name: 'r1' }],
      [{ uriTemplate: 'file:///{t1}', name: 't1' }],
    )
    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(connection, update => updates.push(update))
    const toolsHandler = handlers.get('tools/list')
    const promptsHandler = handlers.get('prompts/list')
    expect(toolsHandler).toBeDefined()
    expect(promptsHandler).toBeDefined()

    // A refresh queued before its server is removed must not resurrect
    // it: both refresh updates carry the guard the resources handler
    // already had.
    await toolsHandler!()
    await promptsHandler!()
    await flushMicrotasks()

    expect(updates).toHaveLength(2)
    for (const update of updates) {
      expect(update.requireExistingClient).toBe(true)
    }
  })

  test('failed template fetch keeps a newer cache entry installed by a refresh', async () => {
    let templatesCalls = 0
    let releaseFirstTemplates: (() => void) | undefined
    let firstTemplatesGate: Promise<void> | undefined
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/templates/list') {
          templatesCalls++
          if (templatesCalls === 1 && firstTemplatesGate) {
            await firstTemplatesGate
            throw new Error('500 Internal Server Error')
          }
          return resultSchema.parse({
            resourceTemplates: [
              { uriTemplate: 'file:///{t2}', name: 't2' },
            ],
          })
        }
        return resultSchema.parse({
          resources: [{ uri: 'file:///r2', name: 'r2' }],
        })
      },
    }
    const connection = {
      type: 'connected',
      name: 'newer-entry-wins',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    // Arm the gate, then start a template fetch that will fail once released.
    firstTemplatesGate = new Promise<void>(resolve => {
      releaseFirstTemplates = resolve
    })
    const failing = fetchResourceTemplatesForClient(connection)
    await flushMicrotasks()

    // While the fetch is pending, a notification refresh installs a newer entry.
    const refreshed = await refreshMcpResourcesAndTemplates(connection)
    expect(refreshed.resourceTemplates.map(t => t.name)).toEqual(['t2'])

    // The older fetch now fails — it must not evict the refreshed entry.
    releaseFirstTemplates!()
    expect(await failing).toEqual([])
    expect(fetchResourceTemplatesForClient.cache.has(connection.name)).toBe(
      true,
    )
    expect(
      (await fetchResourceTemplatesForClient(connection)).map(t => t.name),
    ).toEqual(['t2'])
    expect(templatesCalls).toBe(2)
  })

  test('failed refresh waits for both traversals to settle before propagating', async () => {
    let resourcesCompleted = false
    let releaseResources: (() => void) | undefined
    let resourcesGate: Promise<void> | undefined
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/list') {
          if (resourcesGate) {
            await resourcesGate
          }
          resourcesCompleted = true
          return resultSchema.parse({
            resources: [{ uri: 'file:///r1', name: 'r1' }],
          })
        }
        if (request.method === 'resources/templates/list') {
          throw new Error('500 Internal Server Error')
        }
        throw new Error(`unexpected ${request.method}`)
      },
    }
    const connection = {
      type: 'connected',
      name: 'both-traversals-settle',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    resourcesGate = new Promise<void>(resolve => {
      releaseResources = resolve
    })
    const pending = refreshMcpResourcesAndTemplates(connection)
    await flushMicrotasks()
    // Templates already failed, but the refresh must still be waiting for
    // resources/list — releasing the queue early would let a follow-up
    // refresh start a duplicate traversal.
    const settled = await Promise.race([
      pending.then(
        () => 'resolved',
        () => 'rejected',
      ),
      flushMicrotasks().then(() => 'pending'),
    ])
    expect(settled).toBe('pending')
    releaseResources!()
    await expect(pending).rejects.toThrow('500 Internal Server Error')
    expect(resourcesCompleted).toBe(true)
  })

  test('template uriTemplate with hidden characters fails the traversal', async () => {
    const { connection, requests } = makeTemplateConnection(
      'hidden-char-template',
      {
        'resources/templates/list': [
          {
            resourceTemplates: [
              { uriTemplate: 'file:///ok\u200B/{path}', name: 'hidden-char' },
            ],
          },
          {
            resourceTemplates: [
              { uriTemplate: 'file:///ok\u200B/{path}', name: 'hidden-char' },
            ],
          },
        ],
        'resources/list': [{ resources: [] }],
      },
    )

    // Sanitization would silently rewrite the identifier, so the traversal
    // fails instead of advertising a template that addresses a different
    // resource than the server declared.
    await expect(
      refreshMcpResourcesAndTemplates(connection),
    ).rejects.toThrow('hidden characters')
    // The listing reports no templates, and the failure is not cached: the
    // next listing retries the server.
    expect(await fetchResourceTemplatesForClient(connection)).toEqual([])
    expect(
      requests.filter(r => r.method === 'resources/templates/list').length,
    ).toBe(2)
  })

  test('coalesced refresh replays the replacement connection\u2019s callback', async () => {
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const mcpSkillsEnabled = feature('MCP_SKILLS') ? true : false
    if (mcpSkillsEnabled) {
      await import('../../skills/loadSkillsDir.js')
    }
    const gate: ListChangedGate = { promise: undefined }
    let releaseFirstResources: (() => void) | undefined

    const oldConn = makeListChangedConnection(
      'replacement-callback',
      [{ uri: 'file:///resource-1', name: 'resource-1' }],
      [{ uriTemplate: 'file:///{template-1}', name: 'template-1' }],
      gate,
    )
    const newConn = makeListChangedConnection(
      'replacement-callback',
      [{ uri: 'file:///resource-2', name: 'resource-2' }],
      [{ uriTemplate: 'file:///{template-2}', name: 'template-2' }],
    )

    // Warm the cache from the old connection.
    await Promise.all([
      fetchResourcesForClient(oldConn.connection),
      fetchResourceTemplatesForClient(oldConn.connection),
    ])
    oldConn.resetResourcesListCalls()
    gate.promise = new Promise<void>(resolve => {
      releaseFirstResources = resolve
    })

    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(oldConn.connection, update =>
      updates.push(update),
    )
    const oldHandler = oldConn.handlers.get('resources/list')
    expect(oldHandler).toBeDefined()

    // Fire the first notification; its traversal gates on resources/list.
    const first = oldHandler!()
    await flushMicrotasks()

    // The server is replaced while the traversal is in flight: the caches
    // are invalidated and the new connection's handler takes over.
    invalidateMcpFetchCaches(oldConn.connection.name)
    registerMcpListChangedHandlers(newConn.connection, update =>
      updates.push(update),
    )
    const newHandler = newConn.handlers.get('resources/list')
    expect(newHandler).toBeDefined()
    const second = newHandler!()
    await flushMicrotasks()

    // The old traversal completes stale and publishes nothing; the queued
    // final refresh must replay the replacement's callback, not the old one.
    releaseFirstResources!()
    await Promise.all([first, second])
    await flushMicrotasks()

    const resourceUpdates = updates.filter(u => u.resources !== undefined)
    expect(resourceUpdates.map(u => u.resources?.map(r => r.name))).toEqual([
      ['resource-2'],
    ])
    expect(
      (await fetchResourceTemplatesForClient(newConn.connection)).map(
        t => t.name,
      ),
    ).toEqual(['template-2'])
  })

  test('pending refresh from a replaced connection does not replay', async () => {
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const mcpSkillsEnabled = feature('MCP_SKILLS') ? true : false
    if (mcpSkillsEnabled) {
      await import('../../skills/loadSkillsDir.js')
    }
    const gate: ListChangedGate = { promise: undefined }
    let releaseFirstResources: (() => void) | undefined

    const oldConn = makeListChangedConnection(
      'replaced-pending-callback',
      [{ uri: 'file:///resource-1', name: 'resource-1' }],
      [{ uriTemplate: 'file:///{template-1}', name: 'template-1' }],
      gate,
    )

    await Promise.all([
      fetchResourcesForClient(oldConn.connection),
      fetchResourceTemplatesForClient(oldConn.connection),
    ])
    oldConn.resetResourcesListCalls()
    gate.promise = new Promise<void>(resolve => {
      releaseFirstResources = resolve
    })

    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(oldConn.connection, update =>
      updates.push(update),
    )
    const handler = oldConn.handlers.get('resources/list')
    expect(handler).toBeDefined()

    // Two notifications arrive while the first traversal is gated; the
    // second one only queues a coalesced refresh.
    const first = handler!()
    await flushMicrotasks()
    const second = handler!()
    await flushMicrotasks()

    // The server is replaced before the queued refresh runs: the queued
    // callback belongs to the old generation and must not replay the
    // retired client's traversal or repopulate the cache.
    invalidateMcpFetchCaches(oldConn.connection.name)
    releaseFirstResources!()
    await Promise.all([first, second])
    await flushMicrotasks()

    expect(updates).toEqual([])
    expect(fetchResourceTemplatesForClient.cache.has(oldConn.connection.name)).toBe(
      false,
    )
  })

  test('SDK server supplying one helper in no-prefix mode keeps the other helpers', async () => {
    const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
    ;(globalThis as { MACRO?: { VERSION?: string } }).MACRO = {
      VERSION: '0.1.7',
    }
    const previousNoPrefix = process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
    process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = '1'
    try {
      const requests: string[] = []
      const sendMcpMessage = async (
        _serverName: string,
        message: JSONRPCMessage,
      ): Promise<JSONRPCMessage> => {
        const msg = message as unknown as {
          id?: unknown
          method?: string
        }
        if (msg.method === undefined) {
          return { jsonrpc: '2.0', result: {} } as unknown as JSONRPCMessage
        }
        requests.push(msg.method)
        if (msg.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: 'noprefix-sdk', version: '1.0' },
            },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              tools: [
                {
                  name: 'ListMcpResourcesTool',
                  inputSchema: { type: 'object' },
                },
              ],
            },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'resources/list') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: { resources: [] },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'resources/templates/list') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              resourceTemplates: [
                { uriTemplate: 'file:///{t}', name: 't' },
              ],
            },
          } as unknown as JSONRPCMessage
        }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        } as unknown as JSONRPCMessage
      }

      const { clients, tools } = await setupSdkMcpClients(
        { 'noprefix-sdk': { type: 'sdk', name: 'noprefix-sdk' } },
        sendMcpMessage,
      )
      expect(clients[0]?.type).toBe('connected')
      // The server's own ListMcpResourcesTool stays, and the two helpers
      // it does not supply are still registered.
      expect(tools.map(t => t.name)).toEqual([
        'ListMcpResourcesTool',
        'ListMcpResourceTemplatesTool',
        'ReadMcpResourceTool',
      ])
      expect(tools[0]).not.toBe(MCP_RESOURCE_HELPER_TOOLS[0])
      expect(tools[1]).toBe(MCP_RESOURCE_HELPER_TOOLS[1])
      expect(tools[2]).toBe(MCP_RESOURCE_HELPER_TOOLS[2])
      expect(requests).toContain('tools/list')
    } finally {
      if (previousNoPrefix === undefined) {
        delete process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX
      } else {
        process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX = previousNoPrefix
      }
      if (originalMacro === undefined) {
        delete (globalThis as { MACRO?: unknown }).MACRO
      } else {
        ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
      }
    }
  })

  test('SDK client is discoverable and refreshes templates on notifications during warm-up', async () => {
    const originalMacro = (globalThis as { MACRO?: unknown }).MACRO
    ;(globalThis as { MACRO?: { VERSION?: string } }).MACRO = {
      VERSION: '0.1.7',
    }
    try {
      let generation = 1
      let releaseTemplates: (() => void) | undefined
      const templatesGate = new Promise<void>(resolve => {
        releaseTemplates = resolve
      })
      const requests: string[] = []
      let templatesCalls = 0
      const sendMcpMessage = async (
        _serverName: string,
        message: JSONRPCMessage,
      ): Promise<JSONRPCMessage> => {
        const msg = message as unknown as { id?: unknown; method?: string }
        if (msg.method === undefined) {
          return { jsonrpc: '2.0', result: {} } as unknown as JSONRPCMessage
        }
        requests.push(msg.method)
        if (msg.method === 'initialize') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: {}, resources: { listChanged: true } },
              serverInfo: { name: 'warmup-sdk', version: '1.0' },
            },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'tools/list') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: { tools: [] },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'resources/list') {
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              resources: [
                { uri: `file:///r${generation}`, name: `r${generation}` },
              ],
            },
          } as unknown as JSONRPCMessage
        }
        if (msg.method === 'resources/templates/list') {
          // Capture the generation when the request is sent, not when its
          // response is built: a delayed older request must answer with
          // the generation it started with, or the test cannot tell a
          // late warm-up overwrite apart from the newer request.
          const requestGeneration = generation
          templatesCalls++
          if (templatesCalls === 1) {
            await templatesGate
          }
          return {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              resourceTemplates: [
                {
                  uriTemplate: `file:///{t${requestGeneration}}`,
                  name: `t${requestGeneration}`,
                },
              ],
            },
          } as unknown as JSONRPCMessage
        }
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: {},
        } as unknown as JSONRPCMessage
      }

      const connectedClients: ConnectedMCPServer[] = []
      let setupDone = false
      const setup = setupSdkMcpClients(
        { 'warmup-sdk': { type: 'sdk', name: 'warmup-sdk' } },
        sendMcpMessage,
        client => {
          connectedClients.push(client)
        },
      )
      void setup.then(() => {
        setupDone = true
      })

      // Wait until warm-up is gated on the templates request.
      for (let i = 0; i < 100 && templatesCalls === 0; i++) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(templatesCalls).toBe(1)
      // The client is already published to the caller while warm-up is
      // still in flight, so the input loop can route notifications to it.
      expect(connectedClients.length).toBe(1)
      expect(setupDone).toBe(false)
      const transport = connectedClients[0].client?.transport
      expect(transport?.onmessage).toBeDefined()

      // A list_changed notification arrives during warm-up: the handler
      // registered before warm-up refreshes the template cache.
      generation = 2
      const warmupEntry =
        fetchResourceTemplatesForClient.cache.get('warmup-sdk')
      transport!.onmessage!({
        jsonrpc: '2.0',
        method: 'notifications/resources/list_changed',
      })
      // Wait until the notification refresh replaces the warm-up entry.
      for (let i = 0; i < 200; i++) {
        if (
          fetchResourceTemplatesForClient.cache.get('warmup-sdk') !==
          warmupEntry
        ) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(
        fetchResourceTemplatesForClient.cache.get('warmup-sdk'),
      ).not.toBe(warmupEntry)

      // Warm-up completes with the older generation; the cache keeps the
      // notification's newer templates.
      releaseTemplates!()
      const { clients, tools } = await setup
      expect(clients[0]?.type).toBe('connected')
      expect(tools.map(t => t.name)).toContain('ListMcpResourceTemplatesTool')
      expect(
        (await fetchResourceTemplatesForClient(
          clients[0] as ConnectedMCPServer,
        )).map(t => t.name),
      ).toEqual(['t2'])
      expect(templatesCalls).toBe(2)
      expect(requests).toContain('resources/templates/list')
    } finally {
      if (originalMacro === undefined) {
        delete (globalThis as { MACRO?: unknown }).MACRO
      } else {
        ;(globalThis as { MACRO?: unknown }).MACRO = originalMacro
      }
    }
  })
})
