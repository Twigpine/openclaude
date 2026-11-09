import {
  ErrorCode,
  type ListResourceTemplatesResult,
  ListResourceTemplatesResultSchema,
  type ListResourcesResult,
  ListResourcesResultSchema,
  McpError,
  type ResourceTemplate,
} from '@modelcontextprotocol/sdk/types.js'
import { recursivelySanitizeUnicode } from '../../utils/sanitization.js'
import type {
  MCPServerConnection,
  ServerResource,
  ServerResourceTemplate,
} from './types.js'

/**
 * MCP discovery responses are controlled by external servers. One hundred
 * pages matches the repository's other bounded cursor traversal, while 10,000
 * aggregate items prevents an unbounded server from retaining unlimited tool
 * schemas/resource metadata/prompt definitions in a single cached fetch.
 */
export const MCP_LIST_PAGE_LIMIT = 100
export const MCP_LIST_ITEM_LIMIT = 10_000

/**
 * Descriptive template fields are capped like MCP tool descriptions so one
 * hostile server cannot flood the model's context. The URI template itself
 * is never truncated — it must stay exact for the model to build a URI —
 * and is instead covered by the per-server byte budget below.
 */
export const MCP_RESOURCE_TEMPLATE_FIELD_LIMIT = 2048

/**
 * At most this many UTF-8 bytes of projected template metadata are retained
 * per server. A complete traversal that would exceed the budget fails
 * instead of caching a truncated authoritative list.
 */
export const MCP_RESOURCE_TEMPLATE_BYTE_LIMIT = 1_000_000

/**
 * A complete template traversal must finish within this budget. A server
 * that dribbles pages forever fails the traversal instead of hanging
 * discovery.
 */
export const MCP_RESOURCE_TEMPLATE_TRAVERSAL_TIMEOUT_MS = 60_000

type McpListMethod =
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'prompts/list'

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

/**
 * Project one SDK resource template into the safe, model-facing shape.
 * The SDK object is cloned, never mutated: `_meta` and icons are dropped,
 * unknown fields (including `x-` extensions) are dropped by construction,
 * and only annotation audience, priority, and lastModified survive.
 * Descriptive fields are capped; the URI template is kept exact.
 */
function projectResourceTemplate(
  template: ResourceTemplate,
  server: string,
): ServerResourceTemplate {
  const capField = (value: string): string =>
    value.length > MCP_RESOURCE_TEMPLATE_FIELD_LIMIT
      ? value.slice(0, MCP_RESOURCE_TEMPLATE_FIELD_LIMIT)
      : value
  const capOptional = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : capField(value)
  const sanitized = recursivelySanitizeUnicode(template)
  const title = capOptional(sanitized.title)
  const description = capOptional(sanitized.description)
  const mimeType = capOptional(sanitized.mimeType)
  return {
    uriTemplate: sanitized.uriTemplate,
    name: capField(sanitized.name),
    ...(title !== undefined && { title }),
    ...(description !== undefined && { description }),
    ...(mimeType !== undefined && { mimeType }),
    ...(sanitized.annotations !== undefined && {
      annotations: {
        ...(sanitized.annotations.audience !== undefined && {
          audience: sanitized.annotations.audience,
        }),
        ...(sanitized.annotations.priority !== undefined && {
          priority: sanitized.annotations.priority,
        }),
        ...(sanitized.annotations.lastModified !== undefined && {
          lastModified: sanitized.annotations.lastModified,
        }),
      },
    }),
    server,
  }
}

/**
 * List and annotate every resource template exposed by one connected MCP
 * server, reusing the same bounded cursor traversal as concrete resources.
 * A legacy server that does not implement `resources/templates/list`
 * (JSON-RPC -32601) yields an empty list; every other failure — malformed
 * responses, transport errors, repeated cursors, bound violations — fails
 * the traversal so no partial prefix is ever cached.
 */
export async function listAllMcpResourceTemplates(
  client: Extract<MCPServerConnection, { type: 'connected' }>,
): Promise<ServerResourceTemplate[]> {
  const traversalDeadline =
    performance.now() + MCP_RESOURCE_TEMPLATE_TRAVERSAL_TIMEOUT_MS
  let retainedBytes = 0
  return paginateMcpList({
    method: 'resources/templates/list',
    resultSchema: ListResourceTemplatesResultSchema,
    requestPage: async (request, resultSchema) => {
      if (performance.now() > traversalDeadline) {
        throw new Error(
          `MCP resources/templates/list traversal exceeded time limit (${MCP_RESOURCE_TEMPLATE_TRAVERSAL_TIMEOUT_MS / 1000}s)`,
        )
      }
      try {
        return (await client.client.request(
          request,
          resultSchema,
        )) as ListResourceTemplatesResult
      } catch (error) {
        // Legacy servers predate template listing. Only the first page can
        // report Method Not Found for a method the server never implemented;
        // a later -32601 is a real protocol failure and stays one.
        if (
          !('params' in request) &&
          error instanceof McpError &&
          error.code === ErrorCode.MethodNotFound
        ) {
          return { resourceTemplates: [] }
        }
        throw error
      }
    },
    getItems: result => {
      // Project first so the byte budget counts the safe metadata actually
      // retained, not the raw server payload with its _meta and icons.
      const projected = result.resourceTemplates.map(template =>
        projectResourceTemplate(template, client.name),
      )
      for (const template of projected) {
        retainedBytes += Buffer.byteLength(JSON.stringify(template), 'utf8')
        if (retainedBytes > MCP_RESOURCE_TEMPLATE_BYTE_LIMIT) {
          throw new Error(
            `MCP resources/templates/list exceeded template metadata limit (${MCP_RESOURCE_TEMPLATE_BYTE_LIMIT} bytes)`,
          )
        }
      }
      return projected
    },
    getNextCursor: result => result.nextCursor,
  })
}
