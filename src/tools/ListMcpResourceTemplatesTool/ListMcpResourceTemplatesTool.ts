import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourceTemplatesForClient,
} from '../../services/mcp/client.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import {
  DESCRIPTION,
  LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
  PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter resource templates by'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      uriTemplate: z.string().describe('Parameterized resource URI template'),
      name: z.string().describe('Resource template name'),
      title: z.string().optional().describe('Display title of the template'),
      description: z
        .string()
        .optional()
        .describe('Description of the template'),
      mimeType: z.string().optional().describe('MIME type of the resource'),
      annotations: z
        .object({
          audience: z
            .array(z.enum(['user', 'assistant']))
            .optional()
            .describe('Intended audience for the resource'),
          priority: z
            .number()
            .optional()
            .describe('Priority of the resource'),
          lastModified: z
            .string()
            .optional()
            .describe('Last modification time of the resource'),
        })
        .optional()
        .describe('Resource template annotations'),
      server: z.string().describe('Server that provides this template'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ListMcpResourceTemplatesTool = buildTool({
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  shouldDefer: true,
  name: LIST_MCP_RESOURCE_TEMPLATES_TOOL_NAME,
  searchHint: 'list resource templates from connected MCP servers',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  async call(input, { options: { mcpClients } }) {
    const { server: targetServer } = input

    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `Server "${targetServer}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // fetchResourceTemplatesForClient is LRU-cached (by server name) and
    // already warm from startup prefetch. Cache is invalidated on onclose
    // and on resources/list_changed notifications, so results are never
    // stale. ensureConnectedClient is a no-op when healthy (memoize hit),
    // but after onclose it returns a fresh connection so the re-fetch
    // succeeds.
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        if (client.type !== 'connected') return []
        try {
          const fresh = await ensureConnectedClient(client)
          return await fetchResourceTemplatesForClient(fresh)
        } catch (error) {
          // One server's reconnect failure shouldn't sink the whole result.
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    const data = results.flat()
    // Reject oversized results instead of returning them: several servers
    // can each stay under the per-server byte budget while the combined
    // payload still exceeds what the tool may return or persist.
    if (jsonStringify(data).length > 100_000) {
      throw new Error(
        'Resource template result exceeds 100,000 characters',
      )
    }
    return {
      data,
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResourceTemplates',
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'No resource templates found. MCP servers may still provide tools and concrete resources even if they expose no templates.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
