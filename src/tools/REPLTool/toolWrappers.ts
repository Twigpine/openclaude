import type { Tool, Tools } from '../../Tool.js'
import { filterToolsByDenyRules } from '../../tools.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
import { isLegalGuestIdentifier } from './guestIdentifiers.js'
import { getReplPrimitiveTools } from './primitiveTools.js'

export const REPL_NON_PRIMITIVE_ALLOWLIST = new Set([
  'WebFetch',
  'WebSearch',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'LSP',
  'RepoMap',
])

const REPL_EXCLUDED_TOOLS = new Set([
  'REPL',
  'Skill',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'EnterWorktree',
  'ExitWorktree',
  'AskUserQuestion',
])

function addToolOnce(tools: Tool[], seen: Set<string>, tool: Tool): void {
  if (seen.has(tool.name)) return
  seen.add(tool.name)
  tools.push(tool)
}

export function buildReplToolInventory(input: {
  sessionTools: Tools
  permissionContext?: ToolPermissionContext
}): Tools {
  const inventory: Tool[] = []
  const seen = new Set<string>()
  const primitives = input.permissionContext
    ? filterToolsByDenyRules([...getReplPrimitiveTools()], input.permissionContext)
    : [...getReplPrimitiveTools()]

  for (const tool of primitives) {
    if (tool.isEnabled()) addToolOnce(inventory, seen, tool)
  }

  const sessionTools = input.permissionContext
    ? filterToolsByDenyRules([...input.sessionTools], input.permissionContext)
    : [...input.sessionTools]

  for (const tool of sessionTools) {
    if (!tool.isEnabled() || REPL_EXCLUDED_TOOLS.has(tool.name)) continue
    if (
      REPL_NON_PRIMITIVE_ALLOWLIST.has(tool.name) ||
      tool.name === POWERSHELL_TOOL_NAME ||
      tool.isMcp === true
    ) {
      addToolOnce(inventory, seen, tool)
    }
  }
  return inventory
}
