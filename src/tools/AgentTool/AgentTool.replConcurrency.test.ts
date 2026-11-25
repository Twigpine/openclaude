import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import type { ReplAgentConcurrencyBudget, ToolUseContext } from '../../Tool.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getReplAgentConcurrencyBudget } from './foregroundAgentHandoff.js'
import type { AgentDefinition } from './loadAgentsDir.js'

type PromptsModule = typeof import('../../constants/prompts.js')
type RunAgentModule = typeof import('./runAgent.js')
type AgentToolModule = typeof import('./AgentTool.js')
type SettingsModule = typeof import('../../utils/settings/settings.js')

type RunAgentParams = Parameters<RunAgentModule['runAgent']>[0]

type MockRunAgentCall = {
  params: RunAgentParams
  release: () => void
  fail: (error: Error) => void
}

// Warm up the heavy actual module graphs at file scope: importing them inside
// the first test's beforeEach would blow the per-test timeout budget.
const actualPromptsModule: PromptsModule = await import(
  '../../constants/prompts.js'
)
const actualRunAgentModule: RunAgentModule = await import('./runAgent.js')
const actualSettingsModule: SettingsModule = await import(
  '../../utils/settings/settings.js'
)
let mockRunAgentCalls: MockRunAgentCall[] = []

const originalAgentTeamsEnv = process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS

beforeEach(async () => {
  await acquireSharedMutationLock(
    'tools/AgentTool/AgentTool.replConcurrency.test.ts',
  )
  resetSettingsCache()
  mockRunAgentCalls = []
  mock.module('../../utils/settings/settings.js', () => ({
    ...actualSettingsModule,
    getInitialSettings: () => ({}),
    getSettings_DEPRECATED: () => ({}),
  }))
  mock.module('../../constants/prompts.js', () => ({
    ...actualPromptsModule,
    enhanceSystemPromptWithEnvDetails: mock(async (prompts: string[]) => prompts),
  }))
  mock.module('./runAgent.js', () => ({
    ...actualRunAgentModule,
    runAgent: mock(async function* (params: RunAgentParams) {
      let release!: () => void
      let fail!: (error: Error) => void
      const gate = new Promise<void>((resolve, reject) => {
        release = resolve
        fail = reject
      })
      mockRunAgentCalls.push({ params, release, fail })
      const signal = params.toolUseContext.abortController.signal
      if (signal.aborted) {
        fail(new Error('aborted'))
      } else {
        signal.addEventListener('abort', () => fail(new Error('aborted')), {
          once: true,
        })
      }
      await gate
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          id: 'msg-1',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      } as never
    }),
  }))
})

afterEach(() => {
  try {
    mock.restore()
    mock.module('../../constants/prompts.js', () => actualPromptsModule)
    mock.module('./runAgent.js', () => actualRunAgentModule)
    mock.module('../../utils/settings/settings.js', () => actualSettingsModule)
    resetSettingsCache()
    mockRunAgentCalls = []
    if (originalAgentTeamsEnv === undefined) {
      delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    } else {
      process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = originalAgentTeamsEnv
    }
  } finally {
    releaseSharedMutationLock()
  }
})

async function importAgentTool(): Promise<AgentToolModule['AgentTool']> {
  const { AgentTool } = await import(
    `./AgentTool.js?replConcurrency=${Date.now()}-${Math.random()}`
  )
  return AgentTool
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

function createTracker(): { begin(): void; end(): void } {
  return { begin: () => {}, end: () => {} }
}

function createReplToolUseContext(options: {
  tracker?: { begin(): void; end(): void }
  budget?: ReplAgentConcurrencyBudget
  replInnerExecution?: boolean
  abortController?: AbortController
}): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      mode: 'default',
      additionalWorkingDirectories: new Map<string, string>(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      alwaysAskRules: {},
    },
    mcp: { clients: [], tools: [] as Array<{ name: string }> },
    todos: {},
  }
  const activeAgents = [createAgentDefinition()]
  return {
    options: {
      commands: [],
      debug: false,
      mainLoopModel: 'parent-model',
      tools: [],
      verbose: false,
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents, allAgents: activeAgents },
    },
    abortController: options.abortController ?? new AbortController(),
    replInnerExecution: options.replInnerExecution ?? true,
    replPromptWaitTracker: options.tracker,
    replAgentConcurrencyBudget: options.budget,
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    messages: [],
    getAppState: () => appState,
    setAppState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

const canUseTool = mock(async () => ({ behavior: 'allow' })) as never
const assistantMessage = { requestId: 'req-1' } as never

function spawnAgent(
  AgentTool: AgentToolModule['AgentTool'],
  context: ToolUseContext,
): Promise<{ data: { status?: string } }> {
  return AgentTool.call(
    { description: 'Inspect implementation', prompt: 'Find the bug' },
    context,
    canUseTool,
    assistantMessage,
  ) as unknown as Promise<{ data: { status?: string } }>
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for condition')
}

async function captureRejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error('Expected promise to reject')
}

test('direct fanout inside a REPL script is bounded at 8 concurrent agents', async () => {
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 8; i += 1) {
    running.push(
      spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)

  const ninth = await captureRejection(
    spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
  )
  expect(ninth.message).toMatch(/concurrency limit/)
  expect(mockRunAgentCalls.length).toBe(8)

  // The worker context pins the budget so nested spawns share it.
  expect(
    mockRunAgentCalls[0]?.params.toolUseContext.replAgentConcurrencyBudget,
  ).toBe(getReplAgentConcurrencyBudget(tracker))

  for (const call of mockRunAgentCalls) call.release()
  const results = await Promise.all(running)
  for (const result of results) {
    expect((result as { data: { status: string } }).data.status).toBe('completed')
  }
})

test('nested agents share the budget through tracker identity and pinning', async () => {
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 8; i += 1) {
    running.push(
      spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)

  // A nested spawn carrying only the pinned budget (no tracker) shares the cap.
  const pinnedOnly = await captureRejection(
    spawnAgent(
      AgentTool,
      createReplToolUseContext({
        tracker: undefined,
        budget: getReplAgentConcurrencyBudget(tracker),
      }),
    ),
  )
  expect(pinnedOnly.message).toMatch(/concurrency limit/)

  // A different tracker models a separate script invocation and is uncapped.
  const otherScript = spawnAgent(
    AgentTool,
    createReplToolUseContext({ tracker: createTracker() }),
  )
  await waitFor(() => mockRunAgentCalls.length === 9)

  for (const call of mockRunAgentCalls) call.release()
  await Promise.all(running)
  const result = await otherScript
  expect(result.data.status).toBe('completed')
})

test('releasing a slot allows later agents to acquire', async () => {
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 8; i += 1) {
    running.push(
      spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)

  const first = await captureRejection(
    spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
  )
  expect(first.message).toMatch(/concurrency limit/)

  mockRunAgentCalls[0]?.release()
  const firstResult = (await running[0]) as { data: { status: string } }
  expect(firstResult.data.status).toBe('completed')

  const latecomer = spawnAgent(
    AgentTool,
    createReplToolUseContext({ tracker }),
  )
  await waitFor(() => mockRunAgentCalls.length === 9)

  for (const call of mockRunAgentCalls) call.release()
  const result = await latecomer
  expect(result.data.status).toBe('completed')
  await Promise.all(running.slice(1))
})

test('a failing agent releases its slot', async () => {
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 8; i += 1) {
    running.push(
      spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)

  mockRunAgentCalls[0]?.fail(new Error('boom'))
  const failure = await captureRejection(running[0] as Promise<unknown>)
  expect(failure.message).toMatch(/boom/)

  const latecomer = spawnAgent(
    AgentTool,
    createReplToolUseContext({ tracker }),
  )
  await waitFor(() => mockRunAgentCalls.length === 9)

  for (const call of mockRunAgentCalls) call.release()
  const result = await latecomer
  expect(result.data.status).toBe('completed')
  await Promise.all(running.slice(1))
})

test('an aborted agent releases its slot', async () => {
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const running: Array<Promise<unknown>> = []
  const controllers: AbortController[] = []
  for (let i = 0; i < 8; i += 1) {
    const abortController = new AbortController()
    controllers.push(abortController)
    running.push(
      spawnAgent(
        AgentTool,
        createReplToolUseContext({ tracker, abortController }),
      ),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)

  controllers[0]?.abort('user-cancel')
  const aborted = await captureRejection(running[0] as Promise<unknown>)
  expect(aborted.message).toMatch(/aborted/)

  const latecomer = spawnAgent(
    AgentTool,
    createReplToolUseContext({ tracker }),
  )
  await waitFor(() => mockRunAgentCalls.length === 9)

  for (const call of mockRunAgentCalls) call.release()
  const result = await latecomer
  expect(result.data.status).toBe('completed')
  await Promise.all(running.slice(1))
})

test('agents outside a REPL script are not capped', async () => {
  const AgentTool = await importAgentTool()

  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 10; i += 1) {
    running.push(
      spawnAgent(
        AgentTool,
        createReplToolUseContext({ replInnerExecution: false }),
      ),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 10)

  for (const call of mockRunAgentCalls) call.release()
  const results = await Promise.all(running)
  for (const result of results) {
    expect((result as { data: { status: string } }).data.status).toBe('completed')
  }
  // No budget is pinned outside REPL execution.
  expect(
    mockRunAgentCalls[0]?.params.toolUseContext.replAgentConcurrencyBudget,
  ).toBeUndefined()
})

test('the teammate spawning ban still applies inside a REPL script', async () => {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
  const AgentTool = await importAgentTool()
  const tracker = createTracker()

  const error = await captureRejection(
    AgentTool.call(
      {
        description: 'Inspect implementation',
        prompt: 'Find the bug',
        team_name: 'demo-team',
        name: 'teammate-one',
      },
      createReplToolUseContext({ tracker }),
      canUseTool,
      assistantMessage,
    ) as unknown as Promise<unknown>,
  )
  expect(error.message).toMatch(/Teammate spawning is unavailable/)

  // The ban fires before budget acquisition: no slot was consumed, so a full
  // fanout of 8 ordinary agents can still acquire.
  const running: Array<Promise<unknown>> = []
  for (let i = 0; i < 8; i += 1) {
    running.push(
      spawnAgent(AgentTool, createReplToolUseContext({ tracker })),
    )
  }
  await waitFor(() => mockRunAgentCalls.length === 8)
  for (const call of mockRunAgentCalls) call.release()
  await Promise.all(running)
})
