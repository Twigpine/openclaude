import { afterEach, describe, expect, test, vi } from 'vitest'
import { feature } from 'bun:bundle'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { ConnectedMCPServer } from './types.js'
import {
  fetchCommandsForClient,
  fetchResourcesForClient,
  fetchToolsForClient,
  getDiscoveryCacheKey,
} from './client.js'

type ListMethod = 'tools/list' | 'resources/list' | 'prompts/list'
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

async function advanceRetryTimers(...delays: number[]): Promise<void> {
  await flushMicrotasks()
  for (const delay of delays) {
    vi.advanceTimersByTime(delay)
    await flushMicrotasks()
  }
}

function makePaginatedConnection(
  name: string,
  pages: Record<ListMethod, PageStep[]>,
): { connection: ConnectedMCPServer; requests: ListRequest[] } {
  const requests: ListRequest[] = []
  const offsets = new Map<ListMethod, number>()
  const client = {
    request: async (
      request: ListRequest,
      resultSchema: { parse: (value: unknown) => unknown },
    ) => {
      requests.push(request)
      const offset = offsets.get(request.method) ?? 0
      offsets.set(request.method, offset + 1)
      const page = pages[request.method][offset]
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

describe('MCP list cursor pagination', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('legacy single-page responses omit params for all list methods', async () => {
    const { connection, requests } = makePaginatedConnection('legacy-pages', {
      'tools/list': [
        { tools: [{ name: 'only-tool', inputSchema: { type: 'object' } }] },
      ],
      'resources/list': [
        { resources: [{ uri: 'file:///only-resource', name: 'only-resource' }] },
      ],
      'prompts/list': [{ prompts: [{ name: 'only-prompt' }] }],
    })

    const [tools, resources, prompts] = await Promise.all([
      fetchToolsForClient(connection),
      fetchResourcesForClient(connection),
      fetchCommandsForClient(connection),
    ])

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual(['only-tool'])
    expect(resources.map(resource => resource.name)).toEqual([
      'only-resource',
    ])
    expect(prompts.map(command => command.userFacingName?.())).toEqual([
      'legacy-pages:only-prompt (MCP)',
    ])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'resources/list' },
      { method: 'prompts/list' },
    ])
  })

  test('tools/list follows nextCursor and preserves page order', async () => {
    const { connection, requests } = makePaginatedConnection('pages-tools', {
      'tools/list': [
        {
          tools: [{ name: 'first', inputSchema: { type: 'object' } }],
          nextCursor: 'tools-page-2',
        },
        { tools: [{ name: 'second', inputSchema: { type: 'object' } }] },
      ],
      'resources/list': [],
      'prompts/list': [],
    })

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'first',
      'second',
    ])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'tools/list', params: { cursor: 'tools-page-2' } },
    ])
  })

  test('resources/list follows nextCursor and preserves page order', async () => {
    const { connection, requests } = makePaginatedConnection(
      'pages-resources',
      {
        'tools/list': [],
        'resources/list': [
          {
            resources: [{ uri: 'file:///first', name: 'first' }],
            nextCursor: 'resources-page-2',
          },
          { resources: [{ uri: 'file:///second', name: 'second' }] },
        ],
        'prompts/list': [],
      },
    )

    const resources = await fetchResourcesForClient(connection)

    expect(resources.map(resource => resource.name)).toEqual([
      'first',
      'second',
    ])
    expect(requests).toEqual([
      { method: 'resources/list' },
      { method: 'resources/list', params: { cursor: 'resources-page-2' } },
    ])
  })

  test('prompts/list follows nextCursor and preserves page order', async () => {
    const { connection, requests } = makePaginatedConnection('pages-prompts', {
      'tools/list': [],
      'resources/list': [],
      'prompts/list': [
        { prompts: [{ name: 'first' }], nextCursor: 'prompts-page-2' },
        { prompts: [{ name: 'second' }] },
      ],
    })

    const commands = await fetchCommandsForClient(connection)

    expect(commands.map(command => command.userFacingName?.())).toEqual([
      'pages-prompts:first (MCP)',
      'pages-prompts:second (MCP)',
    ])
    expect(requests).toEqual([
      { method: 'prompts/list' },
      { method: 'prompts/list', params: { cursor: 'prompts-page-2' } },
    ])
  })

  test('all list methods traverse several pages in exact server order', async () => {
    const { connection } = makePaginatedConnection('several-pages', {
      'tools/list': [
        {
          tools: [{ name: 'tool-1', inputSchema: { type: 'object' } }],
          nextCursor: 'tool-2',
        },
        {
          tools: [{ name: 'tool-2', inputSchema: { type: 'object' } }],
          nextCursor: 'tool-3',
        },
        { tools: [{ name: 'tool-3', inputSchema: { type: 'object' } }] },
      ],
      'resources/list': [
        {
          resources: [{ uri: 'file:///resource-1', name: 'resource-1' }],
          nextCursor: 'resource-2',
        },
        {
          resources: [{ uri: 'file:///resource-2', name: 'resource-2' }],
          nextCursor: 'resource-3',
        },
        {
          resources: [{ uri: 'file:///resource-3', name: 'resource-3' }],
        },
      ],
      'prompts/list': [
        { prompts: [{ name: 'prompt-1' }], nextCursor: 'prompt-2' },
        { prompts: [{ name: 'prompt-2' }], nextCursor: 'prompt-3' },
        { prompts: [{ name: 'prompt-3' }] },
      ],
    })

    const [tools, resources, prompts] = await Promise.all([
      fetchToolsForClient(connection),
      fetchResourcesForClient(connection),
      fetchCommandsForClient(connection),
    ])

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'tool-1',
      'tool-2',
      'tool-3',
    ])
    expect(resources.map(resource => resource.name)).toEqual([
      'resource-1',
      'resource-2',
      'resource-3',
    ])
    expect(prompts.map(command => command.userFacingName?.())).toEqual([
      'several-pages:prompt-1 (MCP)',
      'several-pages:prompt-2 (MCP)',
      'several-pages:prompt-3 (MCP)',
    ])
  })

  test('an empty intermediate page still advances to the next cursor', async () => {
    const { connection, requests } = makePaginatedConnection(
      'empty-intermediate',
      {
        'tools/list': [],
        'resources/list': [
          {
            resources: [{ uri: 'file:///first', name: 'first' }],
            nextCursor: 'empty-page',
          },
          { resources: [], nextCursor: 'final-page' },
          { resources: [{ uri: 'file:///last', name: 'last' }] },
        ],
        'prompts/list': [],
      },
    )

    const resources = await fetchResourcesForClient(connection)

    expect(resources.map(resource => resource.name)).toEqual(['first', 'last'])
    expect(requests).toEqual([
      { method: 'resources/list' },
      { method: 'resources/list', params: { cursor: 'empty-page' } },
      { method: 'resources/list', params: { cursor: 'final-page' } },
    ])
  })

  test('an empty-string nextCursor is sent as an opaque cursor', async () => {
    const { connection, requests } = makePaginatedConnection(
      'empty-string-cursor',
      {
        'tools/list': [
          {
            tools: [{ name: 'before', inputSchema: { type: 'object' } }],
            nextCursor: '',
          },
          { tools: [{ name: 'after', inputSchema: { type: 'object' } }] },
        ],
        'resources/list': [],
        'prompts/list': [],
      },
    )

    const tools = await fetchToolsForClient(connection)

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'before',
      'after',
    ])
    expect(requests[1]).toEqual({
      method: 'tools/list',
      params: { cursor: '' },
    })
  })

  test.each(['opaque-secret-123', ''])(
    'rejects a repeated opaque cursor %j without exposing it in the error',
    async repeatedCursor => {
      const { paginateMcpList } = await import('./pagination.js')
      const promise = paginateMcpList({
        method: 'resources/list',
        resultSchema: null,
        requestPage: async () => ({
          items: [],
          nextCursor: repeatedCursor,
        }),
        getItems: page => page.items,
        getNextCursor: page => page.nextCursor,
      })

      try {
        await promise
        throw new Error('expected repeated cursor rejection')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        expect(message).toBe(
          'MCP resources/list pagination repeated a cursor',
        )
        if (repeatedCursor !== '') {
          expect(message).not.toContain(repeatedCursor)
        }
      }
    },
  )

  test('rejects a malformed nextCursor instead of coercing it', async () => {
    const { paginateMcpList } = await import('./pagination.js')
    await expect(
      paginateMcpList({
        method: 'prompts/list',
        resultSchema: null,
        requestPage: async () => ({ items: [], nextCursor: 42 }),
        getItems: page => page.items,
        getNextCursor: page => page.nextCursor,
      }),
    ).rejects.toThrow(
      'MCP prompts/list pagination returned malformed nextCursor',
    )
  })

  test('fails rather than truncating when the page ceiling is exceeded', async () => {
    const { paginateMcpList } = await import('./pagination.js')
    let page = 0
    await expect(
      paginateMcpList({
        method: 'tools/list',
        resultSchema: null,
        requestPage: async () => ({
          items: [`item-${++page}`],
          nextCursor: `cursor-${page}`,
        }),
        getItems: result => result.items,
        getNextCursor: result => result.nextCursor,
        pageLimit: 2,
      }),
    ).rejects.toThrow('MCP tools/list pagination exceeded page limit (2)')
    expect(page).toBe(2)
  })

  test('fails rather than truncating when the aggregate item ceiling is exceeded', async () => {
    const { paginateMcpList } = await import('./pagination.js')
    let page = 0
    await expect(
      paginateMcpList({
        method: 'resources/list',
        resultSchema: null,
        requestPage: async () =>
          ++page === 1
            ? { items: ['first', 'second'], nextCursor: 'more' }
            : { items: ['third'] },
        getItems: result => result.items,
        getNextCursor: result => result.nextCursor,
        itemLimit: 2,
      }),
    ).rejects.toThrow(
      'MCP resources/list pagination exceeded item limit (2)',
    )
  })

  test('production page and item ceilings fail fetchers without caching a prefix', async () => {
    const { MCP_LIST_ITEM_LIMIT, MCP_LIST_PAGE_LIMIT } = await import(
      './pagination.js'
    )
    expect(MCP_LIST_PAGE_LIMIT).toBe(100)
    expect(MCP_LIST_ITEM_LIMIT).toBe(10_000)

    const toolRequests: ListRequest[] = []
    const pageLimitedConnection = {
      type: 'connected',
      name: 'production-page-limit',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          toolRequests.push(request)
          const pageNumber = toolRequests.length
          return resultSchema.parse({
            tools: [
              {
                name: `tool-${pageNumber}`,
                inputSchema: { type: 'object' },
              },
            ],
            nextCursor: `cursor-${pageNumber}`,
          })
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    expect(await fetchToolsForClient(pageLimitedConnection)).toEqual([])
    expect(toolRequests).toHaveLength(MCP_LIST_PAGE_LIMIT)

    const oversizedResources = Array.from(
      { length: MCP_LIST_ITEM_LIMIT + 1 },
      (_, index) => ({
        uri: `test://resource-${index}`,
        name: `resource-${index}`,
      }),
    )
    const itemLimitedConnection = {
      type: 'connected',
      name: 'production-item-limit',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { resources: {} },
      client: {
        request: async (
          _request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => resultSchema.parse({ resources: oversizedResources }),
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    expect(await fetchResourcesForClient(itemLimitedConnection)).toEqual([])
  })

  test('a rejected resources page returns and caches no partial prefix', async () => {
    const { connection, requests } = makePaginatedConnection(
      'atomic-resource-rejection',
      {
        'tools/list': [],
        'resources/list': [
          {
            resources: [{ uri: 'file:///prefix', name: 'prefix' }],
            nextCursor: 'fails',
          },
          new Error('later page rejected'),
        ],
        'prompts/list': [],
      },
    )

    expect(await fetchResourcesForClient(connection)).toEqual([])
    expect(await fetchResourcesForClient(connection)).toEqual([])
    expect(requests).toHaveLength(2)
  })

  test('a schema-invalid prompts page returns no partial prefix and is not retried', async () => {
    const { connection, requests } = makePaginatedConnection(
      'atomic-prompt-schema',
      {
        'tools/list': [],
        'resources/list': [],
        'prompts/list': [
          { prompts: [{ name: 'prefix' }], nextCursor: 'invalid' },
          { prompts: [{ description: 'missing required name' }] },
        ],
      },
    )

    expect(await fetchCommandsForClient(connection)).toEqual([])
    expect(requests).toHaveLength(2)
  })

  test('tools retry only the transient later page and never duplicate page one', async () => {
    vi.useFakeTimers()
    const requests: ListRequest[] = []
    let secondPageAttempts = 0
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        requests.push(request)
        if (!('params' in request)) {
          return resultSchema.parse({
            tools: [{ name: 'first', inputSchema: { type: 'object' } }],
            nextCursor: 'second-page',
          })
        }
        secondPageAttempts++
        if (secondPageAttempts === 1) {
          throw new Error('transient later-page failure')
        }
        return resultSchema.parse({
          tools: [{ name: 'second', inputSchema: { type: 'object' } }],
        })
      },
    }
    const connection = {
      type: 'connected',
      name: 'later-page-tools-retry',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const toolsPromise = fetchToolsForClient(connection)
    await advanceRetryTimers(1_000)
    const tools = await toolsPromise

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'first',
      'second',
    ])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'tools/list', params: { cursor: 'second-page' } },
      { method: 'tools/list', params: { cursor: 'second-page' } },
    ])
  })

  test('a terminal later tools page retries that cursor three times and returns no prefix', async () => {
    vi.useFakeTimers()
    const requests: ListRequest[] = []
    const connection = {
      type: 'connected',
      name: 'terminal-later-page-tools-retry',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          requests.push(request)
          if (!('params' in request)) {
            return resultSchema.parse({
              tools: [{ name: 'prefix', inputSchema: { type: 'object' } }],
              nextCursor: 'terminal-page',
            })
          }
          throw new Error('terminal later-page failure')
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const toolsPromise = fetchToolsForClient(connection)
    await advanceRetryTimers(1_000, 2_000)

    expect(await toolsPromise).toEqual([])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
    ])
  })

  test('tools share one retry deadline across all paginated pages', async () => {
    vi.useFakeTimers()
    const requests: ListRequest[] = []
    let firstPageAttempts = 0
    const connection = {
      type: 'connected',
      name: 'tools-traversal-retry-deadline',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          requests.push(request)
          if (!('params' in request)) {
            firstPageAttempts++
            if (firstPageAttempts === 1) {
              throw new Error('transient first-page failure')
            }
            return resultSchema.parse({
              tools: [{ name: 'prefix', inputSchema: { type: 'object' } }],
              nextCursor: 'terminal-page',
            })
          }
          throw new Error('terminal later-page failure')
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const toolsPromise = fetchToolsForClient(connection)
    await advanceRetryTimers(1_000, 1_000, 1_000)
    const requestsAtTraversalDeadline = [...requests]
    // Let the base implementation's per-page 2s backoff finish too, so the
    // red/green proof never leaves a pending promise or timer behind.
    await advanceRetryTimers(1_000)

    expect(requestsAtTraversalDeadline).toHaveLength(5)
    expect(await toolsPromise).toEqual([])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'tools/list' },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
      { method: 'tools/list', params: { cursor: 'terminal-page' } },
    ])
  })

  test('an overdue retry timer cannot start a post-deadline request', async () => {
    vi.useFakeTimers()
    let nowMs = 0
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs)
    const requests: ListRequest[] = []
    const connection = {
      type: 'connected',
      name: 'tools-overdue-retry-deadline',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
        ) => {
          requests.push(request)
          if (!('params' in request)) {
            return resultSchema.parse({
              tools: [{ name: 'prefix', inputSchema: { type: 'object' } }],
              nextCursor: 'late-page',
            })
          }
          throw new Error('terminal later-page failure')
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const toolsPromise = fetchToolsForClient(connection)
    await flushMicrotasks()
    nowMs = 1_100
    vi.advanceTimersByTime(1_000)
    await flushMicrotasks()
    nowMs = 3_200
    vi.advanceTimersByTime(1_900)
    await flushMicrotasks()
    // Drain the final 100ms that the base implementation still has pending;
    // the corrected implementation has already rejected the traversal.
    await advanceRetryTimers(100)

    expect(await toolsPromise).toEqual([])
    expect(requests).toEqual([
      { method: 'tools/list' },
      { method: 'tools/list', params: { cursor: 'late-page' } },
      { method: 'tools/list', params: { cursor: 'late-page' } },
    ])
  })

  test('a cancelled tools/list backoff issues no further request', async () => {
    vi.useFakeTimers()
    const requests: ListRequest[] = []
    const connection = {
      type: 'connected',
      name: 'cancelled-tools-backoff',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {} },
      client: {
        request: async (
          request: ListRequest,
          resultSchema: { parse: (value: unknown) => unknown },
          options?: { signal?: AbortSignal },
        ) => {
          requests.push(request)
          // A request with an aborted signal fails at once, as the MCP SDK
          // does — so a second request after the abort would be visible here.
          if (options?.signal?.aborted) {
            throw new DOMException('aborted', 'AbortError')
          }
          throw new Error('transient tools/list failure')
        },
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    const controller = new AbortController()
    const toolsPromise = fetchToolsForClient(connection, {
      signal: controller.signal,
    })
    // The first attempt fails and the 1s backoff starts; no timer advances.
    await flushMicrotasks()
    controller.abort()
    await flushMicrotasks()
    // The abort ends the backoff at once: the fetch settles with no tools,
    // and no second request is issued.
    await expect(toolsPromise).resolves.toEqual([])
    expect(requests).toHaveLength(1)
  })

  test('reconnect cache invalidation starts a complete fresh traversal', async () => {
    let generation = 1
    const requests: ListRequest[] = []
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        requests.push(request)
        const suffix = 'params' in request ? 'second' : 'first'
        const nextCursor = 'params' in request ? undefined : 'next'
        const result =
          request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: `tool-${generation}-${suffix}`,
                    inputSchema: { type: 'object' },
                  },
                ],
                nextCursor,
              }
            : request.method === 'resources/list'
              ? {
                  resources: [
                    {
                      uri: `file:///resource-${generation}-${suffix}`,
                      name: `resource-${generation}-${suffix}`,
                    },
                  ],
                  nextCursor,
                }
              : {
                  prompts: [{ name: `prompt-${generation}-${suffix}` }],
                  nextCursor,
                }
        return resultSchema.parse(result)
      },
    }
    const connection = {
      type: 'connected',
      name: 'fresh-after-reconnect',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    await Promise.all([
      fetchToolsForClient(connection),
      fetchResourcesForClient(connection),
      fetchCommandsForClient(connection),
    ])
    generation = 2
    fetchToolsForClient.cache.delete(getDiscoveryCacheKey(connection))
    fetchResourcesForClient.cache.delete(getDiscoveryCacheKey(connection))
    fetchCommandsForClient.cache.delete(getDiscoveryCacheKey(connection))
    requests.length = 0

    const [tools, resources, prompts] = await Promise.all([
      fetchToolsForClient(connection),
      fetchResourcesForClient(connection),
      fetchCommandsForClient(connection),
    ])

    expect(tools.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'tool-2-first',
      'tool-2-second',
    ])
    expect(resources.map(resource => resource.name)).toEqual([
      'resource-2-first',
      'resource-2-second',
    ])
    expect(prompts.map(command => command.userFacingName?.())).toEqual([
      'fresh-after-reconnect:prompt-2-first (MCP)',
      'fresh-after-reconnect:prompt-2-second (MCP)',
    ])
    expect(requests).toHaveLength(6)
  })

  test('each production list-changed handler refetches every page', async () => {
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const mcpSkillsEnabled = feature('MCP_SKILLS') ? true : false
    if (mcpSkillsEnabled) {
      // Production eagerly loads this module before MCP connections start; it
      // registers the builders used when a skill:// resource is read.
      await import('../../skills/loadSkillsDir.js')
    }
    const fetchMcpSkillsForClient = mcpSkillsEnabled
      ? (await import('../../skills/mcpSkills.js')).fetchMcpSkillsForClient
      : null
    const requests: ListRequest[] = []
    const resourceReads: string[] = []
    const handlers = new Map<ListMethod, () => Promise<void>>()
    let generation = 1
    const client = {
      request: async (
        request:
          | ListRequest
          | { method: 'resources/read'; params: { uri: string } },
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method === 'resources/read') {
          resourceReads.push(request.params.uri)
          return resultSchema.parse({
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'text/markdown',
                text: [
                  '---',
                  `name: skill-${generation}`,
                  'description: Paginated notification skill',
                  '---',
                  `# Skill ${generation}`,
                ].join('\n'),
              },
            ],
          })
        }
        requests.push(request)
        const suffix = 'params' in request ? 'second' : 'first'
        const nextCursor = 'params' in request ? undefined : 'next'
        const page =
          request.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: `tool-${generation}-${suffix}`,
                    inputSchema: { type: 'object' },
                  },
                ],
                nextCursor,
              }
            : request.method === 'resources/list'
              ? {
                  resources: [
                    {
                      uri: `file:///resource-${generation}-${suffix}`,
                      name: `resource-${generation}-${suffix}`,
                    },
                    ...(suffix === 'second'
                      ? [
                          {
                            uri: `skill://skill-${generation}`,
                            name: `skill-${generation}`,
                          },
                        ]
                      : []),
                  ],
                  nextCursor,
                }
              : {
                  prompts: [{ name: `prompt-${generation}-${suffix}` }],
                  nextCursor,
                }
        return resultSchema.parse(page)
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
      name: 'list-changed-pagination',
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
      fetchToolsForClient(connection),
      fetchResourcesForClient(connection),
      fetchCommandsForClient(connection),
      fetchMcpSkillsForClient?.(connection) ?? Promise.resolve([]),
    ])
    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(connection, update => updates.push(update))
    expect([...handlers.keys()].sort()).toEqual([
      'prompts/list',
      'resources/list',
      'tools/list',
    ])

    let cachedSkillGeneration = generation
    for (const method of [
      'tools/list',
      'resources/list',
      'prompts/list',
    ] as const) {
      generation++
      requests.length = 0
      resourceReads.length = 0
      updates.length = 0
      await handlers.get(method)?.()

      const expectedTraversal: ListRequest[] = [
        { method },
        { method, params: { cursor: 'next' } },
      ]
      if (method === 'resources/list' && mcpSkillsEnabled) {
        // The production branch refreshes ordinary resources, prompts, and
        // resource-backed skills concurrently. Avoid asserting Promise.all
        // interleaving, but require both resource traversals and every page.
        expect(
          requests.filter(request => request.method === 'resources/list'),
        ).toEqual([
          { method: 'resources/list' },
          { method: 'resources/list' },
          { method: 'resources/list', params: { cursor: 'next' } },
          { method: 'resources/list', params: { cursor: 'next' } },
        ])
        expect(
          requests.filter(request => request.method === 'prompts/list'),
        ).toEqual([
          { method: 'prompts/list' },
          { method: 'prompts/list', params: { cursor: 'next' } },
        ])
        expect(
          requests.filter(request => request.method === 'tools/list'),
        ).toEqual([])
      } else {
        expect(requests).toEqual(expectedTraversal)
      }
      const update = updates[0]
      if (method === 'tools/list') {
        expect(update?.tools?.map(tool => tool.mcpInfo?.toolName)).toEqual([
          `tool-${generation}-first`,
          `tool-${generation}-second`,
        ])
      } else if (method === 'resources/list') {
        expect(update?.resources?.map(resource => resource.name)).toEqual([
          `resource-${generation}-first`,
          `resource-${generation}-second`,
          `skill-${generation}`,
        ])
        if (mcpSkillsEnabled) {
          expect(resourceReads).toEqual([`skill://skill-${generation}`])
          expect(update?.commands?.map(command => command.name)).toEqual([
            `mcp__list-changed-pagination__prompt-${generation}-first`,
            `mcp__list-changed-pagination__prompt-${generation}-second`,
            `mcp__list-changed-pagination__skill-${generation}`,
          ])
          cachedSkillGeneration = generation
        }
      } else {
        expect(resourceReads).toEqual([])
        expect(update?.commands?.map(command => command.name)).toEqual([
          `mcp__list-changed-pagination__prompt-${generation}-first`,
          `mcp__list-changed-pagination__prompt-${generation}-second`,
          ...(mcpSkillsEnabled
            ? [
                `mcp__list-changed-pagination__skill-${cachedSkillGeneration}`,
              ]
            : []),
        ])
        if (!mcpSkillsEnabled) {
          expect(
            update?.commands?.map(command => command.userFacingName?.()),
          ).toEqual([
            `list-changed-pagination:prompt-${generation}-first (MCP)`,
            `list-changed-pagination:prompt-${generation}-second (MCP)`,
          ])
        }
      }
    }
  })

  test('isMcpClientRetired distinguishes the cached generation from a replacement', async () => {
    const { connectToServer, getServerCacheKey, isMcpClientRetired } =
      await import('./client.js')
    const name = 'retired-check'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    const current = {
      type: 'connected',
      name,
      config,
    } as unknown as ConnectedMCPServer
    const replacement = {
      type: 'connected',
      name,
      config,
    } as unknown as ConnectedMCPServer
    try {
      // No entry: an in-process client with no connect-cache involvement
      // is not retired.
      expect(await isMcpClientRetired(name, config, current)).toBe(false)
      // The cached generation is current.
      connectToServer.cache.set(key, Promise.resolve(current))
      expect(await isMcpClientRetired(name, config, current)).toBe(false)
      // A pending replacement in flight retires it.
      let resolveReplacement!: (value: ConnectedMCPServer) => void
      const pending = new Promise<ConnectedMCPServer>(resolve => {
        resolveReplacement = resolve
      })
      connectToServer.cache.set(key, pending)
      expect(await isMcpClientRetired(name, config, current)).toBe(true)
      resolveReplacement(replacement)
      await pending
      // A settled replacement retires it too.
      expect(await isMcpClientRetired(name, config, current)).toBe(true)
      expect(await isMcpClientRetired(name, config, replacement)).toBe(false)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('a list-changed update from a retired transport does not apply', async () => {
    const { connectToServer, getServerCacheKey, isMcpClientRetired } =
      await import('./client.js')
    const { registerMcpListChangedHandlers } = await import(
      './useManageMCPConnections.js'
    )
    const { getCurrentProjectConfig, saveCurrentProjectConfig } =
      await import('../../utils/config.js')
    const handlers = new Map<string, () => Promise<void>>()
    const client = {
      request: async (
        request: ListRequest,
        resultSchema: { parse: (value: unknown) => unknown },
      ) => {
        if (request.method !== 'tools/list') {
          throw new Error(`unexpected ${request.method}`)
        }
        return resultSchema.parse({
          tools: [{ name: 'retired-tool', inputSchema: { type: 'object' } }],
        })
      },
      setNotificationHandler: (
        schema: unknown,
        handler: () => Promise<void>,
      ) => {
        if (schema === ToolListChangedNotificationSchema) {
          handlers.set('tools/list', handler)
        }
      },
    }
    const connection = {
      type: 'connected',
      name: 'retired-list-changed',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: { listChanged: true } },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    type ListChangedUpdate = Parameters<
      Parameters<typeof registerMcpListChangedHandlers>[1]
    >[0]
    const updates: ListChangedUpdate[] = []
    registerMcpListChangedHandlers(connection, update => updates.push(update))
    const toolsHandler = handlers.get('tools/list')
    expect(toolsHandler).toBeDefined()

    // Control: the current generation's notification applies.
    await toolsHandler!()
    expect(updates).toHaveLength(1)
    expect(updates[0]?.tools?.map(tool => tool.mcpInfo?.toolName)).toEqual([
      'retired-tool',
    ])

    // A replacement takes over the cache entry: the retired transport's
    // next notification must not apply — the UI would otherwise restore
    // tools for a server the reconnect already replaced (CodeRabbit
    // #2493 review 5957362782).
    const replacement = {
      type: 'connected',
      name: 'retired-list-changed',
      config: { type: 'sdk', scope: 'local' },
      capabilities: { tools: { listChanged: true } },
      client,
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer
    const key = getServerCacheKey('retired-list-changed', connection.config)
    connectToServer.cache.set(key, Promise.resolve(replacement))
    expect(
      await isMcpClientRetired(
        'retired-list-changed',
        connection.config,
        connection,
      ),
    ).toBe(true)
    try {
      updates.length = 0
      await toolsHandler!()
      expect(updates).toHaveLength(0)
    } finally {
      connectToServer.cache.delete(key)
    }

    // A disabled server's notification must not apply either, even while
    // its transport is still the cached generation.
    expect(
      await isMcpClientRetired(
        'retired-list-changed',
        connection.config,
        connection,
      ),
    ).toBe(false)
    const savedDisabled = getCurrentProjectConfig().disabledMcpServers
    saveCurrentProjectConfig(c => ({
      ...c,
      disabledMcpServers: ['retired-list-changed'],
    }))
    try {
      updates.length = 0
      await toolsHandler!()
      expect(updates).toHaveLength(0)
    } finally {
      saveCurrentProjectConfig(c => ({
        ...c,
        disabledMcpServers: savedDisabled,
      }))
    }
  })

  test('releasing an installed client keeps it open while another session still owns it', async () => {
    const { connectToServer, getServerCacheKey, noteMcpClientInstalled, releaseInstalledMcpClient } =
      await import('./client.js')
    const name = 'installed-release'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    let cachedDuringCleanup: unknown = 'unset'
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
        cachedDuringCleanup = connectToServer.cache.get(key)
      },
    } as unknown as ConnectedMCPServer
    const ownerA = {}
    const ownerB = {}
    try {
      connectToServer.cache.set(key, Promise.resolve(client))
      noteMcpClientInstalled(client, ownerA)
      noteMcpClientInstalled(client, ownerB)
      // One owner leaving leaves the transport open for the other.
      await releaseInstalledMcpClient(name, config, client, ownerA)
      expect(cleanups).toBe(0)
      expect(connectToServer.cache.get(key)).toBeDefined()
      // The last owner leaving closes it — and the generation was
      // evicted before cleanup ran, so a caller joining during cleanup
      // could not receive the closing client.
      await releaseInstalledMcpClient(name, config, client, ownerB)
      expect(cleanups).toBe(1)
      expect(cachedDuringCleanup).toBeUndefined()
      expect(connectToServer.cache.get(key)).toBeUndefined()
      // A second close is a no-op: cleanup never runs twice.
      await releaseInstalledMcpClient(name, config, client, ownerB)
      expect(cleanups).toBe(1)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('a setup reservation keeps a received client alive until it installs or is released', async () => {
    const {
      connectToServer,
      getMcpClientSetupReservationCountForTesting,
      getServerCacheKey,
      noteMcpClientInstalled,
      releaseUnownedMcpClient,
      reserveMcpClientForSetup,
    } = await import('./client.js')
    const name = 'setup-reservation'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
      },
    } as unknown as ConnectedMCPServer
    const owner = {}
    try {
      connectToServer.cache.set(key, Promise.resolve(client))
      reserveMcpClientForSetup(client, owner)
      expect(getMcpClientSetupReservationCountForTesting(client)).toBe(1)
      // A release that runs while setup is still in flight is declined.
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
      // Installing converts the reservation into ownership — and the
      // install record keeps it alive too.
      noteMcpClientInstalled(client, owner)
      expect(getMcpClientSetupReservationCountForTesting(client)).toBe(0)
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('setup abandonment withdraws the adoption claim so a blocked release re-runs', async () => {
    const {
      connectToServer,
      getMcpClientAdoptionClaimCountForTesting,
      getServerCacheKey,
      releaseMcpClientSetupReservation,
      releaseUnownedMcpClient,
      reserveMcpClientForSetup,
    } = await import('./client.js')
    const name = 'setup-abandonment'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
      },
    } as unknown as ConnectedMCPServer
    const owner = {}
    try {
      // Joining the cached connect adopts the client, as a second
      // session's setup join does; the claim consolidates into the
      // owner's token a few ticks out.
      connectToServer.cache.set(key, Promise.resolve(client))
      expect(await connectToServer(name, config, undefined, undefined, owner)).toBe(client)
      // The provisional claim consolidates into the owner's token a
      // few ticks out, and the count is 1 either way — sleep past the
      // consolidation before asserting, or the abandonment below would
      // withdraw a claim that is not in the set yet.
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(getMcpClientAdoptionClaimCountForTesting(client)).toBe(1)
      reserveMcpClientForSetup(client, owner)
      // Another session's cancel declines on the adoption claim.
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
      // Setup abandoned without installing: releasing the reservation
      // must withdraw the abandoning caller's adoption claim too, or
      // the retry declines on it again and the transport stays open
      // with no owner.
      releaseMcpClientSetupReservation(client, owner)
      const releaseDeadline = Date.now() + 1_000
      while (cleanups === 0) {
        if (Date.now() > releaseDeadline) {
          throw new Error('blocked release never re-ran after abandonment')
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(cleanups).toBe(1)
      expect(getMcpClientAdoptionClaimCountForTesting(client)).toBe(0)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('one owner abandoning setup does not strip another owner\'s adoption claim', async () => {
    const {
      connectToServer,
      getMcpClientAdoptionClaimCountForTesting,
      getServerCacheKey,
      isMcpClientAdopted,
      releaseMcpClientSetupReservation,
      releaseUnownedMcpClient,
      reserveMcpClientForSetup,
    } = await import('./client.js')
    const name = 'setup-abandonment-other-owner'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
      },
    } as unknown as ConnectedMCPServer
    const abandoning = {}
    const surviving = {}
    try {
      // Two sessions join the cached connect; each adopts under its own
      // owner token, so the claim count is 2, not the consolidated 1.
      connectToServer.cache.set(key, Promise.resolve(client))
      expect(await connectToServer(name, config, undefined, undefined, abandoning)).toBe(client)
      expect(await connectToServer(name, config, undefined, undefined, surviving)).toBe(client)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(getMcpClientAdoptionClaimCountForTesting(client)).toBe(2)
      reserveMcpClientForSetup(client, abandoning)
      reserveMcpClientForSetup(client, surviving)
      // A cancel from elsewhere declines on the adoption claims.
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
      // The abandoning session's release must withdraw only its own
      // claim: the surviving session still holds the client, so no
      // release re-runs and the transport stays open.
      releaseMcpClientSetupReservation(client, abandoning)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(cleanups).toBe(0)
      expect(getMcpClientAdoptionClaimCountForTesting(client)).toBe(1)
      expect(isMcpClientAdopted(client)).toBe(true)
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
      // The surviving session abandoning too withdraws the last claim,
      // so the blocked release re-runs and the transport closes.
      releaseMcpClientSetupReservation(client, surviving)
      const releaseDeadline = Date.now() + 1_000
      while (cleanups === 0) {
        if (Date.now() > releaseDeadline) {
          throw new Error('blocked release never re-ran after last abandonment')
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(cleanups).toBe(1)
      expect(getMcpClientAdoptionClaimCountForTesting(client)).toBe(0)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('clearing a server cache keeps an installed client its creator never adopted', async () => {
    const {
      clearServerCache,
      connectToServer,
      getServerCacheKey,
      isMcpClientInstalled,
      noteMcpClientInstalled,
      releaseInstalledMcpClient,
    } = await import('./client.js')
    const name = 'installed-no-adoption'
    const config = { type: 'http', url: 'http://localhost:1', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
      },
    } as unknown as ConnectedMCPServer
    const owner = {}
    try {
      // A fresh connect's creator never adopts its own client, but it
      // installs it: installed with zero adoption claims and zero
      // reservations is the normal creator case.
      connectToServer.cache.set(key, Promise.resolve(client))
      noteMcpClientInstalled(client, owner)
      expect(isMcpClientInstalled(client)).toBe(true)
      // A reconnect's clear must detach the cache entry without
      // closing the installed transport.
      await clearServerCache(name, config, undefined, { keepAdoptedClient: true })
      expect(cleanups).toBe(0)
      expect(connectToServer.cache.get(key)).toBeUndefined()
      expect(isMcpClientInstalled(client)).toBe(true)
      // The last installer's release still closes it.
      await releaseInstalledMcpClient(name, config, client, owner)
      expect(cleanups).toBe(1)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('releasing the last setup reservation re-runs a release it had blocked', async () => {
    const {
      connectToServer,
      getServerCacheKey,
      releaseMcpClientSetupReservation,
      releaseUnownedMcpClient,
      reserveMcpClientForSetup,
    } = await import('./client.js')
    const name = 'setup-reservation-release'
    const config = { type: 'sdk', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let cleanups = 0
    const client = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        cleanups++
      },
    } as unknown as ConnectedMCPServer
    const owner = {}
    try {
      connectToServer.cache.set(key, Promise.resolve(client))
      reserveMcpClientForSetup(client, owner)
      await releaseUnownedMcpClient(name, config, client)
      expect(cleanups).toBe(0)
      // Setup failed: releasing the reservation re-runs the release,
      // or the transport stays open with no owner.
      releaseMcpClientSetupReservation(client, owner)
      const deadline = Date.now() + 1_000
      while (cleanups === 0) {
        if (Date.now() > deadline) {
          throw new Error('blocked release never re-ran')
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(cleanups).toBe(1)
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('clearing a server cache clears only the generation the caller failed on', async () => {
    const { clearServerCache, connectToServer, getServerCacheKey } =
      await import('./client.js')
    const name = 'generation-clear'
    const config = { type: 'http', url: 'http://localhost:1', scope: 'local' } as never
    const key = getServerCacheKey(name, config)
    let oldCleanups = 0
    let replacementCleanups = 0
    const oldClient = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        oldCleanups++
      },
    } as unknown as ConnectedMCPServer
    const replacement = {
      type: 'connected',
      name,
      config,
      cleanup: async () => {
        replacementCleanups++
      },
    } as unknown as ConnectedMCPServer
    try {
      // A reauthentication already swapped in a replacement: a late
      // session-expiry error from the old transport must not close it.
      const replacementEntry = Promise.resolve(replacement)
      connectToServer.cache.set(key, replacementEntry)
      await clearServerCache(name, config, undefined, {
        expectedClient: oldClient,
      })
      expect(replacementCleanups).toBe(0)
      expect(oldCleanups).toBe(0)
      expect(connectToServer.cache.get(key)).toBe(replacementEntry)
      // Clearing the generation that is actually cached closes it.
      await clearServerCache(name, config, undefined, {
        expectedClient: replacement,
      })
      expect(replacementCleanups).toBe(1)
      expect(connectToServer.cache.get(key)).toBeUndefined()
      // A pending replacement in flight is left alone, promptly.
      let resolvePending!: (value: ConnectedMCPServer) => void
      const pending = new Promise<ConnectedMCPServer>(resolve => {
        resolvePending = resolve
      })
      connectToServer.cache.set(key, pending)
      await clearServerCache(name, config, undefined, {
        expectedClient: oldClient,
      })
      expect(connectToServer.cache.get(key)).toBe(pending)
      resolvePending(replacement)
      await pending
    } finally {
      connectToServer.cache.delete(key)
    }
  })

  test('isCurrentMcpListUpdateOrigin rejects a refresh from a replaced transport', async () => {
    const { isCurrentMcpListUpdateOrigin } = await import(
      './useManageMCPConnections.js'
    )
    const sdkClientA = {}
    const sdkClientB = {}
    const config = { type: 'http', url: 'http://localhost:1', scope: 'local' }
    const origin = {
      type: 'connected',
      name: 'origin-check',
      config,
      client: sdkClientA,
    } as unknown as ConnectedMCPServer
    const currentSame = {
      type: 'connected',
      name: 'origin-check',
      config,
      client: sdkClientA,
    } as unknown as ConnectedMCPServer
    const currentReplaced = {
      type: 'connected',
      name: 'origin-check',
      config,
      client: sdkClientB,
    } as unknown as ConnectedMCPServer
    const currentReconfigured = {
      type: 'connected',
      name: 'origin-check',
      config: { type: 'http', url: 'http://localhost:2', scope: 'local' },
      client: sdkClientA,
    } as unknown as ConnectedMCPServer
    const failed = {
      type: 'failed',
      name: 'origin-check',
      config,
    } as unknown as ConnectedMCPServer
    // A pending/failed record built by spreading the closed client keeps
    // its `.client` and config, so the transport comparison alone cannot
    // tell it apart from the live record — only the type gate can.
    const pendingSpread = {
      ...origin,
      type: 'pending',
      reconnectAttempt: 1,
      maxReconnectAttempts: 5,
    } as unknown as ConnectedMCPServer
    const failedSpread = {
      ...origin,
      type: 'failed',
    } as unknown as ConnectedMCPServer
    expect(isCurrentMcpListUpdateOrigin(origin, currentSame)).toBe(true)
    expect(isCurrentMcpListUpdateOrigin(origin, currentReplaced)).toBe(false)
    expect(isCurrentMcpListUpdateOrigin(origin, currentReconfigured)).toBe(false)
    expect(isCurrentMcpListUpdateOrigin(origin, undefined)).toBe(false)
    expect(isCurrentMcpListUpdateOrigin(origin, failed)).toBe(false)
    expect(isCurrentMcpListUpdateOrigin(origin, pendingSpread)).toBe(false)
    expect(isCurrentMcpListUpdateOrigin(origin, failedSpread)).toBe(false)
  })
})
