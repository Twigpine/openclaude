import { beforeEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { resumeAgentBackground } from './resumeAgent.js'

let mockTranscript: any = {
  messages: [],
  contentReplacements: [],
}

let mockMetadata: any = {
  agentType: 'code-reviewer',
  source: 'built-in',
}

mock.module('../../utils/sessionStorage.js', () => ({
  getAgentTranscript: async () => mockTranscript,
  readAgentMetadata: async () => mockMetadata,
  writeAgentMetadata: async () => {},
}))

mock.module('../../tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  registerAsyncAgent: () => ({
    agentId: 'test-agent',
    abortController: new AbortController(),
  }),
}))

mock.module('./agentToolUtils.js', () => ({
  runAsyncAgentLifecycle: async () => {},
}))

beforeEach(() => {
  mockTranscript = {
    messages: [],
    contentReplacements: [],
  }
  mockMetadata = {
    agentType: 'code-reviewer',
    source: 'built-in',
  }
})

function makeToolUseContext(activeAgents: AgentDefinition[]): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysDenyRules: {},
    },
    mcp: { tools: [], clients: [] },
  }

  return {
    options: {
      agentDefinitions: { activeAgents, allAgents: activeAgents },
      tools: [],
      mainLoopModel: 'test-model',
      mcpClients: [],
    },
    getAppState: () => appState,
    setAppState: () => {},
    contentReplacementState: { replacements: new Map() },
  } as unknown as ToolUseContext
}

test('fails closed when resuming an unavailable agent instead of falling back', async () => {
  const context = makeToolUseContext([]) // Empty active agents list, so code-reviewer is unavailable

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: type 'code-reviewer' is unavailable or disabled in the current session."
  )
})

test('successfully resumes when agent is available', async () => {
  const codeReviewer = {
    agentType: 'code-reviewer',
    source: 'built-in',
    getSystemPrompt: () => 'review code',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([codeReviewer])

  const result = await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(result.agentId).toBe('test-agent')
})

test('rejects resume when agent definition source does not match metadata', async () => {
  mockMetadata = {
    agentType: 'code-reviewer',
    source: 'built-in', // Originally launched as a built-in
  }

  // A custom agent was added to the project that shadows the built-in name
  const customReviewer = {
    agentType: 'code-reviewer',
    source: 'projectSettings', // Different source
    getSystemPrompt: () => 'review code differently',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([customReviewer])

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: identity mismatch. Expected source 'built-in', found 'projectSettings' for type 'code-reviewer'."
  )
})

test('rejects resume when legacy metadata lacks a source', async () => {
  mockMetadata = {
    agentType: 'code-reviewer',
    // Legacy metadata lacks a source field
  }

  const codeReviewer = {
    agentType: 'code-reviewer',
    source: 'built-in',
    getSystemPrompt: () => 'review code',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([codeReviewer])

  await expect(
    resumeAgentBackground({
      agentId: 'test-agent',
      prompt: 'continue',
      toolUseContext: context,
      canUseTool: async () => ({ behavior: 'allow' } as any),
    }),
  ).rejects.toThrow(
    "Cannot resume agent: identity mismatch. Expected source 'undefined', found 'built-in' for type 'code-reviewer'."
  )
})

test('successfully resumes when legacy metadata lacks a source and agent is not built-in', async () => {
  mockMetadata = {
    agentType: 'custom-agent',
    // Legacy metadata lacks a source field
  }

  const customAgent = {
    agentType: 'custom-agent',
    source: 'projectSettings', // Non-built-in source
    getSystemPrompt: () => 'do custom work',
  } as unknown as AgentDefinition

  const context = makeToolUseContext([customAgent])

  const result = await resumeAgentBackground({
    agentId: 'test-agent',
    prompt: 'continue',
    toolUseContext: context,
    canUseTool: async () => ({ behavior: 'allow' } as any),
  })

  expect(result.agentId).toBe('test-agent')
})
