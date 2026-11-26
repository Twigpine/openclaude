import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { z } from "zod/v4"
import {
  getEmptyToolPermissionContext,
  type ToolUseContext,
  type Tools,
} from "../Tool.js"
import { acquireSharedMutationLock, releaseSharedMutationLock } from "../test/sharedMutationLock.js"
import { createToolFixture } from "../test/toolFixtures.js"
import { AGENT_TOOL_NAME } from "../tools/AgentTool/constants.js"
import type { AgentDefinition } from "../tools/AgentTool/loadAgentsDir.js"
import { REPL_TOOL_NAME } from "../tools/REPLTool/constants.js"
import { getAgentListingDeltaAttachment } from "./attachments.js"

const AGENT_LIST_ENV = "CLAUDE_CODE_AGENT_LIST_IN_MESSAGES"
let originalAgentListEnv: string | undefined

beforeEach(async () => {
  await acquireSharedMutationLock("utils/attachments.agentListing.test.ts")
  originalAgentListEnv = process.env[AGENT_LIST_ENV]
  process.env[AGENT_LIST_ENV] = "true"
})

afterEach(() => {
  try {
    if (originalAgentListEnv === undefined) {
      delete process.env[AGENT_LIST_ENV]
    } else {
      process.env[AGENT_LIST_ENV] = originalAgentListEnv
    }
  } finally {
    releaseSharedMutationLock()
  }
})

function makeAgentDefinition(): AgentDefinition {
  return {
    agentType: "test-worker",
    whenToUse: "Use test-worker for focused work",
    source: "built-in",
    baseDir: "built-in",
    getSystemPrompt: () => "",
  } as AgentDefinition
}

function makeContext(tools: Tools): ToolUseContext {
  const agent = makeAgentDefinition()
  return {
    options: {
      tools,
      agentDefinitions: {
        activeAgents: [agent],
        allAgents: [agent],
      },
    },
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  } as unknown as ToolUseContext
}

describe("getAgentListingDeltaAttachment Code Mode ownership", () => {
  test("emits the catalog when Agent is directly actionable without REPL", () => {
    const agentTool = createToolFixture(z.object({}), { name: AGENT_TOOL_NAME })
    const attachments = getAgentListingDeltaAttachment(makeContext([agentTool]), [])

    expect(attachments).toHaveLength(1)
    expect(attachments[0]?.type).toBe("agent_listing_delta")
    expect(JSON.stringify(attachments[0])).toContain("test-worker")
  })

  test("suppresses the attachment catalog when REPL owns the catalog", () => {
    const agentTool = createToolFixture(z.object({}), { name: AGENT_TOOL_NAME })
    const replTool = createToolFixture(z.object({}), { name: REPL_TOOL_NAME })
    const attachments = getAgentListingDeltaAttachment(makeContext([agentTool, replTool]), [])

    expect(attachments).toEqual([])
  })

  test("does not emit an unactionable catalog without Agent or REPL", () => {
    const attachments = getAgentListingDeltaAttachment(makeContext([]), [])
    expect(attachments).toEqual([])
  })
})
