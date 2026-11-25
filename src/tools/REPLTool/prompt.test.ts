import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod/v4"
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
  type Tools,
} from "../../Tool.js"
import { getMainThreadAgentType, setMainThreadAgentType } from "../../bootstrap/state.js"
import { acquireSharedMutationLock, releaseSharedMutationLock } from "../../test/sharedMutationLock.js"
import { createToolFixture } from "../../test/toolFixtures.js"
import type { AgentDefinition } from "../AgentTool/loadAgentsDir.js"
import { BASH_TOOL_NAME } from "../BashTool/toolName.js"
import { POWERSHELL_TOOL_NAME } from "../PowerShellTool/toolName.js"
import {
  getReplToolPrompt,
  type ReplToolPromptOptions,
} from "./prompt.js"

const NEWLINE = String.fromCharCode(10)
const SIMPLE_ENV = "CLAUDE_CODE_SIMPLE"

type PromptContract = {
  tools: Array<{ name: string; call: string; alias?: string }>
  inputSchemas: Record<string, unknown>
  inputSchemasOmitted: Record<string, string>
  inputSchemaOmissionCount: number
  nonPrimitiveInputSchemasOmitted: number
  omittedToolCount?: number
}

let originalSimpleMode: string | undefined
let originalMainThreadAgentType: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock("tools/REPLTool/prompt.test.ts")
  originalSimpleMode = process.env[SIMPLE_ENV]
  originalMainThreadAgentType = getMainThreadAgentType()
  delete process.env[SIMPLE_ENV]
  setMainThreadAgentType(undefined)
})

afterEach(() => {
  try {
    if (originalSimpleMode === undefined) {
      delete process.env[SIMPLE_ENV]
    } else {
      process.env[SIMPLE_ENV] = originalSimpleMode
    }
    setMainThreadAgentType(originalMainThreadAgentType)
  } finally {
    releaseSharedMutationLock()
  }
})

function makeAgent(agentType: string, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType,
    whenToUse: `Use ${agentType} for focused work`,
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => "",
    ...overrides,
  } as AgentDefinition
}

function makeOptions(input: {
  tools?: Tools
  agents?: AgentDefinition[]
  allowedAgentTypes?: string[]
  permissionContext?: ToolPermissionContext
} = {}): ReplToolPromptOptions {
  const permissionContext = input.permissionContext ?? getEmptyToolPermissionContext()
  return {
    getToolPermissionContext: async () => permissionContext,
    tools: input.tools ?? [],
    agents: input.agents ?? [],
    ...(input.allowedAgentTypes ? { allowedAgentTypes: input.allowedAgentTypes } : {}),
  }
}

function extractContractJson(prompt: string): string {
  const afterStart = prompt.split("```json" + NEWLINE)[1]
  if (!afterStart) throw new Error("missing JSON contract")
  const json = afterStart.split(NEWLINE + "```")[0]
  if (!json) throw new Error("unterminated JSON contract")
  return json
}

function extractContract(prompt: string): PromptContract {
  return JSON.parse(extractContractJson(prompt)) as PromptContract
}

function contractNames(contract: PromptContract): string[] {
  return contract.tools.map(tool => tool.name)
}
describe("getReplToolPrompt", () => {
  test("emits callable primitive names, aliases, and compressed input schemas", async () => {
    const prompt = await getReplToolPrompt(makeOptions())
    const contract = extractContract(prompt)
    const names = contractNames(contract)

    expect(names).toContain("Read")
    expect(names).toContain(BASH_TOOL_NAME)
    expect(names).toContain("Agent")
    expect(contract.tools.find(tool => tool.name === "Read")?.alias).toBe("read")
    expect(contract.tools.find(tool => tool.name === "Agent")?.alias).toBe("agent")
    expect(JSON.stringify(contract.inputSchemas.Read)).toContain("file_path")
    expect(JSON.stringify(contract.inputSchemas[BASH_TOOL_NAME])).toContain("command")
    expect(prompt).toContain("Control-plane, interactive, and recursive tools")
    expect(prompt).toContain("tool(name, input)")
    expect(prompt).toContain("The $ function is a shorthand alias for Bash")
  })

  test("reflects simple mode primitive restrictions", async () => {
    process.env[SIMPLE_ENV] = "1"
    const prompt = await getReplToolPrompt(makeOptions())
    const contract = extractContract(prompt)
    const names = contractNames(contract)

    expect(names).toContain("Read")
    expect(names).toContain("Edit")
    expect(names).toContain(BASH_TOOL_NAME)
    expect(names).not.toContain("Write")
    expect(names).not.toContain("Glob")
    expect(names).not.toContain("Agent")
    expect(prompt).toContain("Primitive tools unavailable in this session")
  })

  test("reflects a restricted main agent definition and allowed agent types", async () => {
    const main = makeAgent("restricted-main", {
      tools: ["Read", BASH_TOOL_NAME, "Agent(custom-worker)"],
    })
    const worker = makeAgent("custom-worker")
    const other = makeAgent("other-worker")
    setMainThreadAgentType("restricted-main")

    const prompt = await getReplToolPrompt(makeOptions({
      agents: [main, worker, other],
      allowedAgentTypes: ["custom-worker"],
    }))
    const contract = extractContract(prompt)
    const names = contractNames(contract)

    expect(names).toContain("Read")
    expect(names).toContain(BASH_TOOL_NAME)
    expect(names).toContain("Agent")
    expect(names).not.toContain("Write")
    expect(names).not.toContain("Edit")
    expect(prompt).toContain("- custom-worker:")
    expect(prompt).not.toContain("- other-worker:")
  })

  test("applies deny rules to hidden primitive tools", async () => {
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { session: [BASH_TOOL_NAME] },
    } as ToolPermissionContext
    const prompt = await getReplToolPrompt(makeOptions({ permissionContext }))
    const contract = extractContract(prompt)

    expect(contractNames(contract)).not.toContain(BASH_TOOL_NAME)
    expect(prompt).toContain("Primitive tools unavailable in this session")
  })

  test("marks illegal MCP names for the generic canonical caller", async () => {
    const name = "mcp__server__not-legal"
    const mcpTool = createToolFixture(z.object({ ok: z.string() }), {
      name,
      isMcp: true,
    })
    const prompt = await getReplToolPrompt(makeOptions({ tools: [mcpTool] }))
    const contract = extractContract(prompt)
    const entry = contract.tools.find(tool => tool.name === name)

    expect(entry?.call).toBe("tool")
    expect(entry?.alias).toBeUndefined()
    expect(contract.inputSchemas[name]).toBeDefined()
    expect(prompt).toContain(`await tool("canonical-name", input)`)
  })

  test("filters denied agent types out of the catalog", async () => {
    const permissionContext = {
      ...getEmptyToolPermissionContext(),
      alwaysDenyRules: { session: ["Agent(denied-worker)"] },
    } as ToolPermissionContext
    const prompt = await getReplToolPrompt(makeOptions({
      agents: [makeAgent("denied-worker"), makeAgent("allowed-worker")],
      permissionContext,
    }))

    expect(prompt).not.toContain("- denied-worker:")
    expect(prompt).toContain("- allowed-worker:")
  })

  test("filters the agent catalog by MCP requirements", async () => {
    const slackAgent = makeAgent("slack-worker", { requiredMcpServers: ["slack"] })
    const plainAgent = makeAgent("plain-worker")
    const withoutMcp = await getReplToolPrompt(makeOptions({ agents: [slackAgent, plainAgent] }))
    expect(withoutMcp).not.toContain("- slack-worker:")
    expect(withoutMcp).toContain("- plain-worker:")

    const slackTool = createToolFixture(z.object({}), {
      name: "mcp__slack__search",
      isMcp: true,
    })
    const withMcp = await getReplToolPrompt(makeOptions({
      tools: [slackTool],
      agents: [slackAgent, plainAgent],
    }))
    expect(withMcp).toContain("- slack-worker:")
  })

  test("documents PowerShell only when the session inventory includes it", async () => {
    const powerShell = createToolFixture(z.object({ command: z.string() }), {
      name: POWERSHELL_TOOL_NAME,
    })
    const presentPrompt = await getReplToolPrompt(makeOptions({ tools: [powerShell] }))
    const presentContract = extractContract(presentPrompt)
    expect(presentPrompt).toContain("PowerShell is available in this session")
    expect(presentContract.tools.find(tool => tool.name === POWERSHELL_TOOL_NAME)?.alias).toBe("powerShell")

    if (process.platform !== "win32") {
      const absentPrompt = await getReplToolPrompt(makeOptions())
      const absentContract = extractContract(absentPrompt)
      expect(absentPrompt).not.toContain("PowerShell is available")
      expect(contractNames(absentContract)).not.toContain(POWERSHELL_TOOL_NAME)
    }
  })

  test("bounds the prompt and emits deterministic omission metadata for large MCP inventories", async () => {
    const manyTools = Array.from({ length: 1000 }, (_, index) =>
      createToolFixture(z.object({ value: z.string() }), {
        name: `mcp__bulk__tool-${index}`,
        isMcp: true,
      }),
    )
    const prompt = await getReplToolPrompt(makeOptions({ tools: manyTools }))
    const contractJson = extractContractJson(prompt)
    const contract = JSON.parse(contractJson) as PromptContract

    expect(contractJson.length).toBeLessThanOrEqual(14_000)
    expect(prompt.length).toBeLessThan(24_000)
    expect(contract.omittedToolCount).toBeGreaterThan(0)
    expect(contract.nonPrimitiveInputSchemasOmitted).toBeGreaterThanOrEqual(0)
  })
})
