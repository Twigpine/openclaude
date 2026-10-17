import { afterEach, describe, expect, spyOn, test } from 'bun:test'

import type { Command } from '../commands.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import * as queryEngineModule from '../QueryEngine.js'
import * as queryModule from '../query.js'
import { type QueryParams } from '../query.js'
import type { QueryDeps } from '../query/deps.js'
import { getDefaultAppState, type AppState } from '../state/AppStateStore.js'
import type { Tools } from '../Tool.js'
import {
  createAssistantMessage,
  createUserMessage,
} from '../utils/messages.js'
import * as processModule from '../utils/process.js'
import * as shutdownModule from '../utils/gracefulShutdown.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { parseMaxTurnsCli, resolveReplMaxTurns } from '../utils/replMaxTurns.js'
import { runHeadless } from './print.js'

function makeHeadlessQueryParams(maxTurns: number | undefined): QueryParams {
  return {
    messages: [createUserMessage({ content: 'headless prompt' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    maxTurns,
    querySource: 'sdk',
    toolUseContext: {
      abortController: new AbortController(),
      agentId: 'agent-test',
      getAppState: () => ({
        fastMode: false,
        mcp: { tools: [], clients: [] },
        toolPermissionContext: {
          mode: 'default',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        },
        sessionHooks: new Map(),
        mainLoopModel: 'gpt-4o',
        effortValue: undefined,
        advisorModel: undefined,
      }),
      options: {
        commands: [],
        debug: false,
        thinkingConfig: { type: 'disabled' },
        tools: [],
        verbose: false,
        mcpClients: [],
        mcpResources: {},
        isNonInteractiveSession: true,
        agentDefinitions: { activeAgents: [], allAgents: [] },
        appendSystemPrompt: undefined,
        providerOverride: undefined,
        mainLoopModel: 'gpt-4o',
      },
      addNotification: () => {},
      messages: [],
      setInProgressToolUseIDs: () => {},
      setResponseLength: () => {},
      updateAttributionState: () => {},
    } as unknown as QueryParams['toolUseContext'],
    deps: {
      callModel: async function* () {
        yield createAssistantMessage({ content: 'done' })
      },
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        compactionResult: null,
        consecutiveFailures: undefined,
      }),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as unknown as QueryDeps,
  }
}

function createHeadlessSuccessResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-4000-8000-000000000001',
    session_id: 'test-session',
  }
}

function createHeadlessRunOptions(maxTurns: number | undefined) {
  return {
    continue: undefined,
    resume: undefined,
    fromPr: undefined,
    resumeSessionAt: undefined,
    verbose: false,
    outputFormat: 'text',
    jsonSchema: undefined,
    permissionPromptToolName: undefined,
    allowedTools: undefined,
    thinkingConfig: { type: 'disabled' as const },
    maxTurns,
    maxBudgetUsd: undefined,
    taskBudget: undefined,
    systemPrompt: undefined,
    appendSystemPrompt: undefined,
    userSpecifiedModel: undefined,
    fallbackModel: undefined,
    teleport: undefined,
    sdkUrl: undefined,
    replayUserMessages: undefined,
    includePartialMessages: undefined,
    forkSession: undefined,
    rewindFiles: undefined,
    enableAuthStatus: undefined,
    agent: undefined,
    workload: undefined,
  }
}

async function waitForAskCall(
  askSpy: ReturnType<typeof spyOn<typeof queryEngineModule, 'ask'>>,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (askSpy.mock.calls.length === 0) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for runHeadless to call ask()')
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

describe('headless --print max-turns', () => {
  const savedSimple = process.env.CLAUDE_CODE_SIMPLE

  afterEach(() => {
    if (savedSimple === undefined) {
      delete process.env.CLAUDE_CODE_SIMPLE
    } else {
      process.env.CLAUDE_CODE_SIMPLE = savedSimple
    }
  })

  test('forwards parsed --max-turns 0 into query params without interactive resolution', async () => {
    const headlessMaxTurns = parseMaxTurnsCli('0')
    expect(headlessMaxTurns).toBe(0)
    expect(resolveReplMaxTurns(headlessMaxTurns)).toBeUndefined()

    const querySpy = spyOn(queryModule, 'query')
    const params = makeHeadlessQueryParams(headlessMaxTurns)

    const generator = queryModule.query(params)
    let terminal
    while (true) {
      const next = await generator.next()
      if (next.done) {
        terminal = next.value
        break
      }
    }

    expect(querySpy.mock.calls[0]?.[0]?.maxTurns).toBe(0)
    expect(terminal?.reason).toBe('completed')
    querySpy.mockRestore()
  })

  test('forwards maxTurns 0 through runHeadless into ask()', async () => {
    process.env.CLAUDE_CODE_SIMPLE = '1'

    const shutdownSpy = spyOn(shutdownModule, 'gracefulShutdownSync').mockImplementation(() => {})
    const stdoutSpy = spyOn(processModule, 'writeToStdout').mockImplementation(
      () => {},
    )
    const askSpy = spyOn(queryEngineModule, 'ask').mockImplementation(
      async function* () {
        yield createHeadlessSuccessResult()
      },
    )

    let state = getDefaultAppState()
    const getAppState = () => state
    const setAppState = (update: (previous: AppState) => AppState) => {
      state = update(state)
    }

    let runPromise: Promise<void> | undefined
    try {
      runPromise = runHeadless(
        'headless prompt',
        getAppState,
        setAppState,
        [] as Command[],
        [] as Tools,
        {},
        [],
        createHeadlessRunOptions(0),
      )

      await waitForAskCall(askSpy)
      expect(askSpy.mock.calls[0]?.[0]?.maxTurns).toBe(0)
      await runPromise
      expect(shutdownSpy).toHaveBeenCalledWith(0)
    } finally {
      await runPromise?.catch(() => {})
      askSpy.mockRestore()
      stdoutSpy.mockRestore()
      shutdownSpy.mockRestore()
    }
  })
})
