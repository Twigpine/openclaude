import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  resetSettingsCache,
} from '../../utils/settings/settingsCache.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('./runAgent.js')
type AgentToolModule = typeof import('./AgentTool.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')

let actualPromptsModule: PromptsModule | undefined
let actualRunAgentModule: RunAgentModule | undefined
let actualSettingsModule: SettingsModule | undefined
let settingsForTest: SettingsJson = {}

beforeEach(async () => {
  await acquireSharedMutationLock('tools/AgentTool/AgentTool.routing.test.ts')
  resetSettingsCache()
  actualSettingsModule ??= await import(
    `../../utils/settings/settings.ts?agentToolRoutingSettingsActual=${Date.now()}-${Math.random()}`
  )
  settingsForTest = {}
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsModule!,
    getInitialSettings: () => settingsForTest,
    getSettings_DEPRECATED: () => settingsForTest,
  }))
})

afterEach(() => {
  try {
    mock.restore()
    if (actualPromptsModule) {
      mock.module('../../constants/prompts.js', () => actualPromptsModule!)
    }
    if (actualRunAgentModule) {
      mock.module('./runAgent.js', () => actualRunAgentModule!)
    }
    if (actualSettingsModule) {
      mock.module('../../utils/settings/settings.js', () => actualSettingsModule!)
    }
    resetSettingsCache()
    settingsForTest = {}
  } finally {
    releaseSharedMutationLock()
  }
})

test('normal subagent prompt metadata uses routed effective model', async () => {
  settingsForTest = {
    agentModels: {
      'deepseek-grunt': {
        base_url: 'https://api.deepseek.com/v1',
        api_key: 'sk-test',
      },
    },
    agentRouting: {
      'general-purpose': 'deepseek-grunt',
    },
  }

  const { AgentTool, promptModels, getRunAgentParams } =
    await importAgentToolWithRoutingMocks()

  await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
    },
    createToolUseContext('parent-model', [createAgentDefinition()]),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-1' } as never,
  )

  expect(promptModels).toContain('deepseek-grunt')
  expect(getRunAgentParams()?.override?.systemPrompt).toContain(
    'enhanced-for:deepseek-grunt',
  )
})

test('plan-mode one-shot agents cannot be forced into background execution', async () => {
  const { AgentTool } = await importAgentToolWithRoutingMocks()
  const exploreAgent = {
    ...createAgentDefinition(),
    agentType: 'Explore',
    background: true,
  }

  const result = await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
      subagent_type: 'Explore',
    },
    createToolUseContext('parent-model', [exploreAgent], 'plan'),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-plan' } as never,
  )

  expect(result.data.status).toBe('completed')
})

test('agent invocation entering plan mode during MCP wait stays synchronous', async () => {
  const { AgentTool } = await importAgentToolWithRoutingMocks()
  const agent = {
    ...createAgentDefinition(),
    background: true,
    requiredMcpServers: ['demo'],
  }

  const result = await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
    },
    createToolUseContext('parent-model', [agent], 'default', 'plan'),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-plan-transition' } as never,
  )

  expect(result.data.status).toBe('completed')
})

test('agent invocation leaving plan mode during MCP wait stays synchronous', async () => {
  const { AgentTool } = await importAgentToolWithRoutingMocks()
  const exploreAgent = {
    ...createAgentDefinition(),
    agentType: 'Explore',
    background: true,
    requiredMcpServers: ['demo'],
  }

  const result = await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
      subagent_type: 'Explore',
    },
    createToolUseContext('parent-model', [exploreAgent], 'plan', 'default'),
    mock(async () => ({ behavior: 'allow' })) as never,
    { requestId: 'req-plan-exit-transition' } as never,
  )

  expect(result.data.status).toBe('completed')
})

test('sync agents forward long-running tool progress to the parent tool call', async () => {
  const mcpProgress = {
    type: 'progress' as const,
    uuid: 'progress-1',
    timestamp: new Date().toISOString(),
    toolUseID: 'toolu_child_mcp',
    parentToolUseID: 'toolu_agent',
    data: {
      type: 'mcp_progress',
      status: 'progress',
      serverName: 'demo',
      toolName: 'slow-tool',
    },
  }
  const taskOutputProgress = {
    type: 'progress' as const,
    uuid: 'progress-2',
    timestamp: new Date().toISOString(),
    toolUseID: 'toolu_child_task_output',
    parentToolUseID: 'toolu_agent',
    data: {
      type: 'waiting_for_task',
      taskDescription: 'long-running task',
      taskType: 'local_bash',
    },
  }
  const { AgentTool } = await importAgentToolWithRoutingMocks([
    mcpProgress,
    taskOutputProgress,
  ])
  const onProgress = mock(() => {})

  await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
    },
    createToolUseContext('parent-model', [createAgentDefinition()]),
    mock(async () => ({ behavior: 'allow' })) as never,
    { message: { id: 'parent-message' } } as never,
    onProgress as never,
  )

  expect(onProgress).toHaveBeenCalledWith({
    toolUseID: 'toolu_child_mcp',
    data: mcpProgress.data,
  })
  expect(onProgress).toHaveBeenCalledWith({
    toolUseID: 'toolu_child_task_output',
    data: taskOutputProgress.data,
  })
})

test('a throwing parent progress consumer does not change the subagent outcome', async () => {
  const mcpProgress = {
    type: 'progress' as const,
    uuid: 'progress-throw-1',
    timestamp: new Date().toISOString(),
    toolUseID: 'toolu_child_mcp',
    parentToolUseID: 'toolu_agent',
    data: {
      type: 'mcp_progress',
      status: 'progress',
      serverName: 'demo',
      toolName: 'slow-tool',
    },
  }
  const { AgentTool } = await importAgentToolWithRoutingMocks([mcpProgress])
  const onProgress = mock(({ data }: { data: { type: string } }) => {
    if (data.type === 'mcp_progress' || data.type === 'waiting_for_task') {
      throw new Error('progress consumer failure')
    }
  })

  const result = await AgentTool.call(
    {
      description: 'Inspect implementation',
      prompt: 'Find the bug',
    },
    createToolUseContext('parent-model', [createAgentDefinition()]),
    mock(async () => ({ behavior: 'allow' })) as never,
    { message: { id: 'parent-message' } } as never,
    onProgress as never,
  )

  expect(onProgress).toHaveBeenCalledWith({
    toolUseID: 'toolu_child_mcp',
    data: mcpProgress.data,
  })
  expect(result.data.status).toBe('completed')
})

async function importAgentToolWithRoutingMocks(
  messages?: Array<Record<string, unknown>>,
): Promise<{
  AgentTool: AgentToolModule['AgentTool']
  promptModels: string[]
  getRunAgentParams: () => Parameters<RunAgentModule['runAgent']>[0] | undefined
}> {
  actualPromptsModule ??= await import(
    `../../constants/prompts.ts?agentToolRoutingActual=${Date.now()}-${Math.random()}`
  )
  actualRunAgentModule ??= await import(
    `./runAgent.ts?agentToolRoutingActual=${Date.now()}-${Math.random()}`
  )

  const promptModels: string[] = []
  let runAgentParams: Parameters<RunAgentModule['runAgent']>[0] | undefined

  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule!,
    enhanceSystemPromptWithEnvDetails: mock(
      async (prompts: string[], model: string) => {
        promptModels.push(model)
        return [...prompts, `enhanced-for:${model}`]
      },
    ),
  }))

  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule!,
    runAgent: mock(async function* (
      params: Parameters<RunAgentModule['runAgent']>[0],
    ) {
      runAgentParams = params
      for (const message of messages ?? []) {
        yield message as never
      }
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }
    }),
  }))

  const { AgentTool } = await import(
    `./AgentTool.js?agentToolRouting=${Date.now()}-${Math.random()}`
  )
  return {
    AgentTool,
    promptModels,
    getRunAgentParams: () => runAgentParams,
  }
}

function createAgentDefinition(): AgentDefinition {
  return {
    agentType: 'general-purpose',
    color: 'blue',
    source: 'built-in',
    whenToUse: 'general work',
    getSystemPrompt: () => 'You are a subagent.',
  } as unknown as AgentDefinition
}

function createToolUseContext(
  mainLoopModel: string,
  activeAgents: AgentDefinition[],
  mode = 'default',
  modeAfterMcpWait?: string,
): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode,
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: {
      clients: modeAfterMcpWait
        ? [{ type: 'pending', name: 'demo' }]
        : [],
      tools: [] as Array<{ name: string }>,
    },
    todos: {},
  }
  let appStateReads = 0

  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel,
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: {
        activeAgents,
        allAgents: activeAgents,
      },
    },
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    messages: [],
    getAppState: () => {
      appStateReads += 1
      if (modeAfterMcpWait && appStateReads > 1) {
        appState.toolPermissionContext.mode = modeAfterMcpWait
        appState.mcp.clients = []
        appState.mcp.tools = [{ name: 'mcp__demo__inspect' }]
      }
      return appState
    },
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}
