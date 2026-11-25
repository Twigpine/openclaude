import type { Tool, ToolPermissionContext, Tools } from "../../Tool.js"
import { getMainThreadAgentType } from "../../bootstrap/state.js"
import { isEnvTruthy } from "../../utils/envUtils.js"
import { filterDeniedAgents } from "../../utils/permissions/permissions.js"
import { zodToJsonSchema } from "../../utils/zodToJsonSchema.js"
import { AGENT_TOOL_NAME } from "../AgentTool/constants.js"
import {
  filterAgentsByMcpRequirements,
  type AgentDefinition,
} from "../AgentTool/loadAgentsDir.js"
import { formatAgentLine } from "../AgentTool/prompt.js"
import { resolveAgentTools } from "../AgentTool/agentToolUtils.js"
import { BASH_TOOL_NAME } from "../BashTool/toolName.js"
import { POWERSHELL_TOOL_NAME } from "../PowerShellTool/toolName.js"
import { getReplErgonomicAlias } from "./constants.js"
import { isLegalGuestIdentifier } from "./guestIdentifiers.js"
import { DEFAULT_REPL_RESOURCE_CAPS } from "./innerToolRunner.js"
import { getReplPrimitiveTools } from "./primitiveTools.js"
import { buildReplToolInventory, REPL_EXCLUDED_TOOLS } from "./toolWrappers.js"

const NEWLINE = String.fromCharCode(10)
const INPUT_CONTRACT_BUDGET_CHARS = 14_000
const AGENT_CATALOG_BUDGET_CHARS = 5_000
const MAX_AGENT_CATALOG_LINES = 30
const MAX_AGENT_LINE_CHARS = 280

export type ReplToolPromptOptions = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  tools: Tools
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
}

type JsonObject = Record<string, unknown>

type SchemaProfile = {
  maxDepth: number
  maxProperties: number
  maxVariants: number
  maxEnumItems: number
  maxEnumChars: number
  includeDefs: boolean
}

const SCHEMA_PROFILES: readonly SchemaProfile[] = [
  { maxDepth: 5, maxProperties: 40, maxVariants: 10, maxEnumItems: 24, maxEnumChars: 1_200, includeDefs: true },
  { maxDepth: 3, maxProperties: 24, maxVariants: 8, maxEnumItems: 20, maxEnumChars: 900, includeDefs: true },
  { maxDepth: 2, maxProperties: 16, maxVariants: 5, maxEnumItems: 16, maxEnumChars: 700, includeDefs: false },
  { maxDepth: 1, maxProperties: 10, maxVariants: 3, maxEnumItems: 12, maxEnumChars: 500, includeDefs: false },
  { maxDepth: 0, maxProperties: 6, maxVariants: 1, maxEnumItems: 6, maxEnumChars: 200, includeDefs: false },
]

const CONSTRAINT_KEYS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "multipleOf",
  "format",
])

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sortedObjectKeys(value: JsonObject): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right))
}

function copyLiteral(value: unknown): unknown {
  if (value === null) return null
  if (["string", "number", "boolean"].includes(typeof value)) return value
  return undefined
}

function compactEnum(values: unknown, profile: SchemaProfile): { values?: unknown[]; omitted?: true } {
  if (!Array.isArray(values)) return {}
  if (values.length > profile.maxEnumItems) return { omitted: true }
  let size = 0
  for (const value of values) {
    const serialized = JSON.stringify(value)
    size += serialized?.length ?? 20
    if (size > profile.maxEnumChars) return { omitted: true }
  }
  return { values }
}

function compactJsonSchema(
  input: unknown,
  profile: SchemaProfile,
  depth = 0,
  state: { nodes: number } = { nodes: 0 },
): unknown {
  if (typeof input === "boolean") return input
  if (!isRecord(input)) return { type: "unknown" }
  if (state.nodes >= 250) return { truncated: true, nodesOmitted: true }
  state.nodes += 1

  const out: JsonObject = {}
  const type = input.type
  if (typeof type === "string") out.type = type
  if (Array.isArray(type) && type.every(item => typeof item === "string")) out.type = [...type]

  const constValue = copyLiteral(input.const)
  if (constValue !== undefined) out.const = constValue

  const enumResult = compactEnum(input.enum, profile)
  if (enumResult.values) out.enum = enumResult.values
  if (enumResult.omitted) out.enumOmitted = true

  for (const key of CONSTRAINT_KEYS) {
    const value = input[key]
    if (["string", "number", "boolean"].includes(typeof value)) out[key] = value
  }

  if (typeof input.$ref === "string") out.$ref = input.$ref

  if (depth > profile.maxDepth) {
    out.truncated = true
    return out
  }

  if (Array.isArray(input.required)) {
    out.required = input.required
      .filter((item): item is string => typeof item === "string")
      .sort((left, right) => left.localeCompare(right))
  }

  if (isRecord(input.properties)) {
    const keys = sortedObjectKeys(input.properties)
    const properties: JsonObject = {}
    for (const key of keys.slice(0, profile.maxProperties)) {
      properties[key] = compactJsonSchema(input.properties[key], profile, depth + 1, state)
    }
    out.properties = properties
    if (keys.length > profile.maxProperties) {
      out.propertiesOmitted = keys.length - profile.maxProperties
    }
  }

  if (isRecord(input.items) || typeof input.items === "boolean") {
    out.items = compactJsonSchema(input.items, profile, depth + 1, state)
  }
  if (Array.isArray(input.prefixItems)) {
    out.prefixItems = input.prefixItems
      .slice(0, profile.maxVariants)
      .map(item => compactJsonSchema(item, profile, depth + 1, state))
    if (input.prefixItems.length > profile.maxVariants) {
      out.prefixItemsOmitted = input.prefixItems.length - profile.maxVariants
    }
  }

  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const value = input[key]
    if (!Array.isArray(value)) continue
    out[key] = value
      .slice(0, profile.maxVariants)
      .map(item => compactJsonSchema(item, profile, depth + 1, state))
    if (value.length > profile.maxVariants) {
      out[`${key}Omitted`] = value.length - profile.maxVariants
    }
  }

  if (isRecord(input.not) || typeof input.not === "boolean") {
    out.not = compactJsonSchema(input.not, profile, depth + 1, state)
  }

  if (typeof input.additionalProperties === "boolean") {
    out.additionalProperties = input.additionalProperties
  } else if (isRecord(input.additionalProperties)) {
    out.additionalProperties = compactJsonSchema(input.additionalProperties, profile, depth + 1, state)
  }

  if (profile.includeDefs) {
    for (const defsKey of ["$defs", "definitions"]) {
      const defs = input[defsKey]
      if (!isRecord(defs)) continue
      const compactDefs: JsonObject = {}
      const keys = sortedObjectKeys(defs)
      for (const key of keys.slice(0, profile.maxProperties)) {
        compactDefs[key] = compactJsonSchema(defs[key], profile, depth + 1, state)
      }
      out[defsKey] = compactDefs
      if (keys.length > profile.maxProperties) {
        out[`${defsKey}Omitted`] = keys.length - profile.maxProperties
      }
    }
  }

  return out
}
type ContractToolEntry = {
  name: string
  alias?: string
  call: "function" | "tool"
  primitive: boolean
  schema:
    | { ok: true; value: unknown }
    | { ok: false }
}

function readInputSchema(tool: Tool): ContractToolEntry["schema"] {
  try {
    return {
      ok: true,
      value: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
    }
  } catch {
    return { ok: false }
  }
}

export function buildReplContractEntries(
  inventory: Tools,
  primitiveNames: readonly string[],
): ContractToolEntry[] {
  const sorted = [...inventory].sort((left, right) => left.name.localeCompare(right.name))
  const directNames = new Set(
    sorted
      .filter(tool => isLegalGuestIdentifier(tool.name))
      .map(tool => tool.name),
  )
  const primitiveSet = new Set(primitiveNames)

  return sorted.map(tool => {
    const alias = getReplErgonomicAlias(tool.name)
    return {
      name: tool.name,
      ...(alias && !directNames.has(alias) ? { alias } : {}),
      call: isLegalGuestIdentifier(tool.name) ? "function" as const : "tool" as const,
      primitive: primitiveSet.has(tool.name),
      schema: readInputSchema(tool),
    }
  })
}

function limitNonPrimitiveEntries(
  entries: readonly ContractToolEntry[],
  maxNonPrimitive: number,
): ContractToolEntry[] {
  let seen = 0
  return entries.filter(entry => {
    if (entry.primitive) return true
    seen += 1
    return seen <= maxNonPrimitive
  })
}

function renderContractObject(input: {
  entries: readonly ContractToolEntry[]
  primitiveOnlySchemas: boolean
  profile: SchemaProfile
  omittedToolCount?: number
}): string {
  const tools: JsonObject[] = []
  const inputSchemas: JsonObject = {}
  const inputSchemasOmitted: JsonObject = {}
  let budgetOmittedInputSchemas = 0

  for (const entry of input.entries) {
    tools.push({
      name: entry.name,
      call: entry.call,
      ...(entry.alias ? { alias: entry.alias } : {}),
    })

    if (!entry.schema.ok) {
      inputSchemasOmitted[entry.name] = "schema-unavailable"
    } else if (!entry.primitive && input.primitiveOnlySchemas) {
      budgetOmittedInputSchemas += 1
    } else {
      inputSchemas[entry.name] = compactJsonSchema(entry.schema.value, input.profile)
    }
  }

  const contract: JsonObject = {
    version: 1,
    genericCaller: "tool(name, input)",
    tools,
    inputSchemas,
    inputSchemasOmitted,
    inputSchemaOmissionCount: Object.keys(inputSchemasOmitted).length,
    nonPrimitiveInputSchemasOmitted: budgetOmittedInputSchemas,
  }
  if (input.entries.some(entry => entry.name === BASH_TOOL_NAME)) {
    contract.bashShorthand = "$"
  }
  if (input.omittedToolCount) {
    contract.omittedToolCount = input.omittedToolCount
    contract.omittedToolsReason = "contract-size-budget"
  }
  return JSON.stringify(contract)
}

function renderBoundedInputContract(entries: readonly ContractToolEntry[]): string {
  const attempts: Array<{ primitiveOnlySchemas: boolean; profile: SchemaProfile }> = []
  for (const profile of SCHEMA_PROFILES) {
    attempts.push({ primitiveOnlySchemas: false, profile })
  }
  for (const profile of SCHEMA_PROFILES) {
    attempts.push({ primitiveOnlySchemas: true, profile })
  }

  for (const attempt of attempts) {
    const rendered = renderContractObject({ entries, ...attempt })
    if (rendered.length <= INPUT_CONTRACT_BUDGET_CHARS) return rendered
  }

  const primitiveCount = entries.filter(entry => entry.primitive).length
  const nonPrimitiveCount = entries.length - primitiveCount
  const profile = SCHEMA_PROFILES[SCHEMA_PROFILES.length - 1]
  if (!profile) {
    return renderContractObject({ entries, primitiveOnlySchemas: true, profile: SCHEMA_PROFILES[0] as SchemaProfile })
  }

  let low = 0
  let high = nonPrimitiveCount
  let best = renderContractObject({
    entries: limitNonPrimitiveEntries(entries, 0),
    primitiveOnlySchemas: true,
    profile,
    omittedToolCount: nonPrimitiveCount,
  })

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const rendered = renderContractObject({
      entries: limitNonPrimitiveEntries(entries, middle),
      primitiveOnlySchemas: true,
      profile,
      omittedToolCount: nonPrimitiveCount - middle,
    })
    if (rendered.length <= INPUT_CONTRACT_BUDGET_CHARS) {
      best = rendered
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

export function resolveReplPrimitiveNames(input: {
  primitiveNames: readonly string[]
  availableTools: Tools
  simpleMode: boolean
  mainThreadAgentType?: string
  agents: readonly AgentDefinition[]
}): readonly string[] | undefined {
  if (input.simpleMode) {
    return input.primitiveNames.filter(name =>
      name === BASH_TOOL_NAME || name === "Read" || name === "Edit",
    )
  }

  if (!input.mainThreadAgentType) return undefined
  const mainAgent = input.agents.find(agent => agent.agentType === input.mainThreadAgentType)
  if (!mainAgent) return undefined

  const resolvedNames = new Set(
    resolveAgentTools(mainAgent, input.availableTools, false, true)
      .resolvedTools.map(tool => tool.name),
  )
  return input.primitiveNames.filter(name => resolvedNames.has(name))
}

export function filterReplAgentDefinitions(input: {
  agents: readonly AgentDefinition[]
  tools: Tools
  permissionContext: ToolPermissionContext
  allowedAgentTypes?: readonly string[]
}): AgentDefinition[] {
  const mcpServersWithTools: string[] = []
  for (const tool of input.tools) {
    if (!tool.name.startsWith("mcp__")) continue
    const serverName = tool.name.split("__")[1]
    if (serverName && !mcpServersWithTools.includes(serverName)) {
      mcpServersWithTools.push(serverName)
    }
  }

  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements([...input.agents], mcpServersWithTools),
    input.permissionContext,
    AGENT_TOOL_NAME,
  )
  const allowedAgentTypes = input.allowedAgentTypes
  if (allowedAgentTypes) {
    filtered = filtered.filter(agent => allowedAgentTypes.includes(agent.agentType))
  }
  return filtered.sort((left, right) => left.agentType.localeCompare(right.agentType))
}

function truncatePlain(value: string, maxLength: number): string {
  const flattened = value.replace(/\s+/g, " ")
  if (flattened.length <= maxLength) return flattened
  return `${flattened.slice(0, Math.max(0, maxLength - 3))}...`
}

function renderAgentCatalog(agents: readonly AgentDefinition[]): string[] {
  if (agents.length === 0) {
    return ["No agent types are currently available through Agent/agent."]
  }

  const lines: string[] = []
  let usedChars = 0
  let omitted = 0
  for (const agent of agents) {
    const line = truncatePlain(formatAgentLine(agent), MAX_AGENT_LINE_CHARS)
    const nextSize = usedChars + line.length + 1
    if (lines.length >= MAX_AGENT_CATALOG_LINES || nextSize > AGENT_CATALOG_BUDGET_CHARS) {
      omitted += 1
      continue
    }
    lines.push(line)
    usedChars = nextSize
  }
  if (omitted > 0) {
    let notice = `Agent catalog size limit applied: ${omitted} agent types omitted.`
    while (
      lines.length >= MAX_AGENT_CATALOG_LINES ||
      usedChars + notice.length + 1 > AGENT_CATALOG_BUDGET_CHARS
    ) {
      const removed = lines.pop()
      if (!removed) break
      usedChars -= removed.length + 1
      omitted += 1
      notice = `Agent catalog size limit applied: ${omitted} agent types omitted.`
    }
    lines.push(notice)
  }
  return lines
}

function dedupeSorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right))
}

function formatNameList(names: readonly string[], maxNames = 40): string {
  if (names.length === 0) return "none"
  if (names.length <= maxNames) return names.join(", ")
  const shown = names.slice(0, maxNames).join(", ")
  return `${shown}; ${names.length - maxNames} more omitted`
}
export function getReplToolDescription(): string {
  return "Execute JavaScript that orchestrates available tools in this session"
}

export async function getReplToolPrompt(options: ReplToolPromptOptions): Promise<string> {
  const permissionContext = await options.getToolPermissionContext()
  const primitiveTools = getReplPrimitiveTools()
  const primitiveNames = primitiveTools.map(tool => tool.name)
  const allowedPrimitiveNames = resolveReplPrimitiveNames({
    primitiveNames,
    availableTools: [...primitiveTools, ...options.tools],
    simpleMode: isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE),
    mainThreadAgentType: getMainThreadAgentType(),
    agents: options.agents,
  })
  const inventory = buildReplToolInventory({
    sessionTools: options.tools,
    permissionContext,
    allowedPrimitiveNames,
  })
  const entries = buildReplContractEntries(inventory, primitiveNames)
  const inputContract = renderBoundedInputContract(entries)
  const inventoryNames = new Set(inventory.map(tool => tool.name))
  const primitiveNameSet = new Set(primitiveNames)
  const availableNames = entries.map(entry => entry.name)
  const unavailablePrimitiveNames = primitiveNames.filter(name => !inventoryNames.has(name))
  const controlPlaneNames = dedupeSorted([...REPL_EXCLUDED_TOOLS])
  const controlPlaneNameSet = new Set(controlPlaneNames)
  const directOnlyNames = dedupeSorted(
    options.tools
      .map(tool => tool.name)
      .filter(name =>
        !inventoryNames.has(name) &&
        !controlPlaneNameSet.has(name) &&
        !primitiveNameSet.has(name),
      ),
  )

  const lines: string[] = [
    "Use this tool to execute JavaScript in an isolated QuickJS runtime.",
    "",
    "The session tool contract below is authoritative for the current session configuration. Canonical tool names are case-sensitive.",
    `Available canonical tools: ${formatNameList(availableNames, 80)}.`,
    `Entries with call: "function" can be invoked as await Name(input). Entries with call: "tool" are not legal JavaScript identifiers and must be invoked as await tool("canonical-name", input).`,
    "Ergonomic aliases listed in the contract are convenience functions only. The generic tool(name, input) caller accepts canonical names, not aliases.",
    "inputSchemas is keyed by canonical tool name. Fields ending in Omitted or truncated mark deliberate size-bounded compression; absence from inputSchemas means no input schema is included.",
  ]

  const powerShellEntry = entries.find(entry => entry.name === POWERSHELL_TOOL_NAME)
  if (powerShellEntry) {
    lines.push(
      powerShellEntry.alias
        ? `PowerShell is available in this session as canonical ${POWERSHELL_TOOL_NAME} and ergonomic alias ${powerShellEntry.alias}.`
        : `PowerShell is available in this session only under the canonical name ${POWERSHELL_TOOL_NAME}.`,
    )
  }

  if (inventoryNames.has(BASH_TOOL_NAME)) {
    lines.push("The $ function is a shorthand alias for Bash and takes the same input object.")
  }

  if (unavailablePrimitiveNames.length > 0) {
    lines.push(`Primitive tools unavailable in this session: ${formatNameList(unavailablePrimitiveNames)}.`)
  }
  lines.push(`Control-plane, interactive, and recursive tools are never callable inside REPL scripts: ${formatNameList(controlPlaneNames, 24)}.`)
  if (directOnlyNames.length > 0) {
    lines.push(`These session tools are also unavailable inside scripts: ${formatNameList(directOnlyNames)}.`)
  }

  lines.push(
    "",
    "Session tool contract (JSON):",
    "```json",
    inputContract,
    "```",
    "",
  )

  if (inventoryNames.has(AGENT_TOOL_NAME)) {
    const agents = filterReplAgentDefinitions({
      agents: options.agents,
      tools: options.tools,
      permissionContext,
      allowedAgentTypes: options.allowedAgentTypes,
    })
    lines.push(
      "Available agent types for the subagent_type input of Agent/agent inside scripts:",
      ...renderAgentCatalog(agents),
      "",
    )
  }

  lines.push(
    "Write the complete script as the code input. Use return to produce the final value. Use await for every tool call. Use Promise.all for independent calls. Inputs must be plain objects matching the contract for the canonical tool name.",
    `Per-script limits: at most ${DEFAULT_REPL_RESOURCE_CAPS.maxTotalCalls} inner calls, ${DEFAULT_REPL_RESOURCE_CAPS.maxMutationCalls} mutation calls, ${DEFAULT_REPL_RESOURCE_CAPS.maxShellCalls} shell/process calls, and ${DEFAULT_REPL_RESOURCE_CAPS.maxAgentCalls} Agent calls. At most ${DEFAULT_REPL_RESOURCE_CAPS.maxConcurrentCalls} inner calls run concurrently.`,
    "Console output is captured and bounded. The runtime has no require, process, import, host object access, or direct filesystem/network access except through permissioned tool functions.",
    "Foreground execution is limited to ten minutes. Background shell work, background agents, recursive REPL calls, control-plane tools, and unavailable tools fail closed. Inner tool calls keep their normal permission names, hooks, validation, and errors. Prefer one orchestrating script over many small direct tool uses when batching reads, searches, edits, or shell commands.",
  )

  return lines.join(NEWLINE)
}
