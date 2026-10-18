import type { Command } from '../types/command.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { memoizeWithLRU } from '../utils/memoize.js'
import { recursivelySanitizeUnicode } from '../utils/sanitization.js'
import { normalizeNameForMCP } from '../services/mcp/normalization.js'
import { listAllMcpResources } from '../services/mcp/pagination.js'
import type { MCPServerConnection, ServerResource } from '../services/mcp/types.js'
import { getMCPSkillBuilders } from './mcpSkillBuilders.js'
import { logForDebugging } from '../utils/debug.js'
import {
  type ReadResourceResult,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/sdk/types.js'

const SKILL_URI_PREFIX = 'skill://'
const MCP_SKILL_CACHE_SIZE = 20

export function isSkillResource(resource: { uri: string; name?: string }): boolean {
  return resource.uri.toLowerCase().startsWith(SKILL_URI_PREFIX)
}

export function deriveMcpSkillName(serverName: string, uri: string): string {
  const lower = uri.toLowerCase()
  const path = lower.startsWith(SKILL_URI_PREFIX)
    ? uri.slice(SKILL_URI_PREFIX.length)
    : uri
  return `mcp__${normalizeNameForMCP(serverName)}__${path}`
}

async function readSkillResource(
  client: Extract<MCPServerConnection, { type: 'connected' }>,
  resource: ServerResource,
): Promise<Command | null> {
  try {
    const result = (await client.client.request(
      { method: 'resources/read', params: { uri: resource.uri } },
      ReadResourceResultSchema,
    )) as ReadResourceResult

    const textContent = result.contents.find(
      (c): c is { uri: string; mimeType?: string; text: string } =>
        typeof (c as { text?: unknown }).text === 'string',
    )
    if (!textContent) {
      logForDebugging(
        `[mcp-skills] resource ${resource.uri} on ${client.name} has no text content; skipping`,
      )
      return null
    }

    const markdown = recursivelySanitizeUnicode(textContent.text) as string
    const { frontmatter, content: markdownContent } = parseFrontmatter(markdown)

    const skillName = deriveMcpSkillName(client.name, resource.uri)
    const { createSkillCommand, parseSkillFrontmatterFields } = getMCPSkillBuilders()
    const parsed = parseSkillFrontmatterFields(frontmatter, markdownContent, skillName)

    return createSkillCommand({
      ...parsed,
      skillName,
      markdownContent,
      source: 'mcp',
      baseDir: undefined,
      skillFilePath: undefined,
      loadedFrom: 'mcp',
      paths: undefined,
      skillTrust: undefined,
      executionContext: parsed.executionContext,
      // Security: MCP skills are remote and untrusted. Discard any `hooks`
      // frontmatter — otherwise the slash-command path would register them as
      // session hooks that run shell in the user's workspace, bypassing the
      // inline-shell guard that already blocks !`…` for loadedFrom === 'mcp'.
      hooks: undefined,
      // Security: likewise discard `allowed-tools`. On the user-typed slash
      // path it is written into alwaysAllowRules (REPL onQueryImpl), so a
      // remote skill could auto-approve tool calls (e.g. Bash) that its own
      // body then drives the model to make — no permission prompt. With it
      // empty, the model still prompts on each tool use. (The model-invoked
      // SkillTool path already gates this via skillHasOnlySafeProperties.)
      allowedTools: [],
    })
  } catch (error) {
    logForDebugging(
      `[mcp-skills] failed to read skill resource ${resource.uri} on ${client.name}: ${String(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

export const fetchMcpSkillsForClient = memoizeWithLRU(
  async (client: MCPServerConnection): Promise<Command[]> => {
    if (client.type !== 'connected') return []
    if (!client.capabilities?.resources) return []

    try {
      const resources = await listAllMcpResources(client)

      const skillResources = resources.filter(isSkillResource)
      if (skillResources.length === 0) return []

      const commands = await Promise.all(
        skillResources.map(r => readSkillResource(client, r)),
      )
      return commands.filter((c): c is Command => c !== null)
    } catch (error) {
      logForDebugging(
        `[mcp-skills] failed to list skills for ${client.name}: ${String(error)}`,
        { level: 'warn' },
      )
      return []
    }
  },
  (client: MCPServerConnection) => client.name,
  MCP_SKILL_CACHE_SIZE,
)
