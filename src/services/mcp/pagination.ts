import {
  type ListResourcesResult,
  ListResourcesResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import type { MCPServerConnection, ServerResource } from './types.js'

/**
 * MCP discovery responses are controlled by external servers. One hundred
 * pages matches the repository's other bounded cursor traversal, while 10,000
 * aggregate items prevents an unbounded server from retaining unlimited tool
 * schemas/resource metadata/prompt definitions in a single cached fetch.
 */
export const MCP_LIST_PAGE_LIMIT = 100
export const MCP_LIST_ITEM_LIMIT = 10_000

type McpListMethod = 'tools/list' | 'resources/list' | 'prompts/list'

export type McpListRequest<TMethod extends McpListMethod> =
  | { method: TMethod }
  | { method: TMethod; params: { cursor: string } }

type McpListPaginationOptions<TMethod extends McpListMethod, TSchema, TPage, TItem> = {
  method: TMethod
  resultSchema: TSchema
  requestPage: (
    request: McpListRequest<TMethod>,
    resultSchema: TSchema,
  ) => Promise<TPage>
  getItems: (page: TPage) => readonly TItem[]
  getNextCursor: (page: TPage) => unknown
  pageLimit?: number
  itemLimit?: number
}

/**
 * Traverse one MCP list operation atomically. The caller owns the page request
 * policy (tools/list retries each page; resources/list and prompts/list do not),
 * while this function owns cursor validation, ordering, and safety bounds.
 */
export async function paginateMcpList<
  TMethod extends McpListMethod,
  TSchema,
  TPage,
  TItem,
>({
  method,
  resultSchema,
  requestPage,
  getItems,
  getNextCursor,
  pageLimit = MCP_LIST_PAGE_LIMIT,
  itemLimit = MCP_LIST_ITEM_LIMIT,
}: McpListPaginationOptions<TMethod, TSchema, TPage, TItem>): Promise<TItem[]> {
  const items: TItem[] = []
  const usedCursors = new Set<string>()
  let cursor: string | undefined

  for (let pageNumber = 1; ; pageNumber++) {
    const request: McpListRequest<TMethod> =
      cursor === undefined
        ? { method }
        : { method, params: { cursor } }
    const page = await requestPage(request, resultSchema)
    const pageItems = getItems(page)

    if (items.length + pageItems.length > itemLimit) {
      throw new Error(
        `MCP ${method} pagination exceeded item limit (${itemLimit})`,
      )
    }
    items.push(...pageItems)

    const nextCursor = getNextCursor(page)
    if (nextCursor === undefined) {
      return items
    }
    if (typeof nextCursor !== 'string') {
      throw new Error(`MCP ${method} pagination returned malformed nextCursor`)
    }
    if (usedCursors.has(nextCursor)) {
      throw new Error(`MCP ${method} pagination repeated a cursor`)
    }
    if (pageNumber >= pageLimit) {
      throw new Error(
        `MCP ${method} pagination exceeded page limit (${pageLimit})`,
      )
    }

    usedCursors.add(nextCursor)
    cursor = nextCursor
  }
}

/**
 * List and annotate every resource exposed by one connected MCP server. Both
 * ordinary resource discovery and resource-backed skills share this exact
 * cursor traversal so their protocol behavior cannot drift.
 */
export async function listAllMcpResources(
  client: Extract<MCPServerConnection, { type: 'connected' }>,
): Promise<ServerResource[]> {
  const resources = await paginateMcpList({
    method: 'resources/list',
    resultSchema: ListResourcesResultSchema,
    requestPage: async (request, resultSchema) =>
      (await client.client.request(request, resultSchema)) as ListResourcesResult,
    getItems: result => result.resources,
    getNextCursor: result => result.nextCursor,
  })

  return resources.map(resource => ({
    ...resource,
    server: client.name,
  }))
}
