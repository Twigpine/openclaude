import type { Tool, Tools } from '../../Tool.js'
import { filterToolsByDenyRules } from '../../tools.js'
import type { ToolPermissionContext } from '../../types/permissions.js'
import { POWERSHELL_TOOL_NAME } from '../PowerShellTool/toolName.js'
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

const JAVASCRIPT_RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
])

export function isLegalGuestIdentifier(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !JAVASCRIPT_RESERVED_WORDS.has(name)
}

function addToolOnce(tools: Tool[], seen: Set<string>, tool: Tool): void {
  if (seen.has(tool.name)) return
  seen.add(tool.name)
  tools.push(tool)
}

/**
 * Build the deliberately constrained guest namespace. Hidden primitives are
 * included independently of the model-facing session list, while nonprimitive
 * built-ins are limited to the reviewed v1 allowlist. MCP tools already in the
 * session pool keep canonical names.
 */
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

export function createReplHostFunctionNames(inventory: Tools): {
  exactNames: Map<string, string>
  genericNames: string[]
} {
  const exactNames = new Map<string, string>()
  const genericNames: string[] = []
  for (const tool of inventory) {
    if (isLegalGuestIdentifier(tool.name)) {
      exactNames.set(tool.name, tool.name)
    } else {
      genericNames.push(tool.name)
    }
  }
  return { exactNames, genericNames }
}
