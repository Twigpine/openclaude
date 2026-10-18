import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

import {
  createQueryTurnBudget,
  query,
  type QueryParams,
} from '../query.js'
import { buildTool, type Tools } from '../Tool.js'
import type { QueryDeps } from './deps.js'
import { FallbackTriggeredError } from '../services/api/withRetry.js'
import {
  createAssistantMessage,
  createUserMessage,
  normalizeMessagesForAPI,
} from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { countToolUses } from '../tools/AgentTool/agentToolUtils.js'
import { AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX } from './agentStepLimit.js'
import type { Terminal } from './transitions.js'
import type { Message } from '../types/message.js'
import { dequeueAll, enqueue } from '../utils/messageQueueManager.js'

const echoCalls: string[] = []

const echoTool = buildTool({
  name: 'Echo',
  inputSchema: z.object({ text: z.string() }),
  maxResultSizeChars: Infinity,
  async description() {
    return 'Echo input text'
  },
  async prompt() {
    return ''
  },
  async call(input) {
    echoCalls.push(input.text)
    return { data: `echo:${input.text}` }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      content: String(content),
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
})

function makeToolUseContext(tools: Tools = []): QueryParams['toolUseContext'] {
  const abortController = new AbortController()
  let inProgressToolUseIDs = new Set<string>()

  return {
    abortController,
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
      tools,
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
      appendSystemPrompt: undefined,
      providerOverride: undefined,
      mainLoopModel: 'gpt-4o',
    },
    addNotification: () => {},
    messages: [],
    setInProgressToolUseIDs: updater => {
      inProgressToolUseIDs = updater(inProgressToolUseIDs)
    },
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as unknown as QueryParams['toolUseContext']
}

function makeParams(
  callModel: QueryDeps['callModel'],
  tools: Tools = [],
  agentStepLimit?: { maxSteps: number; agentType: string },
): QueryParams {
  const dispatchingCallModel: QueryDeps['callModel'] = async function* (input) {
    if (input.options.onProviderRequestStart?.() === false) return
    yield* callModel(input)
  }
  return {
    messages: [createUserMessage({ content: 'inspect' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext: makeToolUseContext(tools),
    querySource: 'agent:builtin:general-purpose',
    ...(agentStepLimit ? { agentStepLimit } : {}),
    deps: {
      callModel: dispatchingCallModel,
      microcompact: async messages => ({ messages }),
      autocompact: async () => ({
        compactionResult: null,
        consecutiveFailures: undefined,
      }),
      uuid: () => '00000000-0000-4000-8000-000000000000',
    } as unknown as QueryDeps,
  }
}

async function drain(params: QueryParams): Promise<{
  yielded: any[]
  returned: any
}> {
  const yielded: any[] = []
  const generator = query(params)
  while (true) {
    const next = await generator.next()
    if (next.done) return { yielded, returned: next.value }
    yielded.push(next.value)
  }
}

describe('agent step limits', () => {
  test('shares one turn budget across query calls for the same prompt', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'done' })
    }

    await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    const { yielded, returned } = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
    expect(returned).toEqual({ reason: 'max_turns', turnCount: 2 })
    expect(
      yielded.some(
        message =>
          message.type === 'attachment' &&
          message.attachment.type === 'max_turns_reached' &&
          message.attachment.turnCount === 2,
      ),
    ).toBe(true)
  })

  test('provider fallback retries do not consume another shared turn', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const params = makeParams(async function* () {
      modelCalls++
      if (modelCalls === 1) {
        throw new FallbackTriggeredError('primary-model', 'fallback-model')
      }
      yield createAssistantMessage({ content: 'completed on fallback' })
    })
    params.fallbackModel = 'fallback-model'

    const first = await drain({ ...params, turnBudget })
    const second = await drain({
      ...makeParams(async function* () {
        modelCalls++
        yield createAssistantMessage({ content: 'must not run' })
      }),
      turnBudget,
    })

    expect(first.returned).toEqual({ reason: 'completed' })
    expect(second.returned).toEqual({ reason: 'max_turns', turnCount: 2 })
    expect(modelCalls).toBe(2)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('a retry cannot dispatch after foreground ownership is aborted', async () => {
    let providerCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const params = makeParams(async function* () {})
    const abortController = params.toolUseContext.abortController
    params.deps!.callModel = async function* ({ options }) {
      if (options.onProviderRequestStart?.() === false) return
      providerCalls++

      // Simulate an abort during asynchronous retry preparation. The second
      // ownership check must reject even though this turn is already reserved.
      abortController.abort('background')
      if (options.onProviderRequestStart?.() === false) return
      providerCalls++
      yield createAssistantMessage({ content: 'stale retry' })
    }

    const result = await drain({ ...params, turnBudget })

    expect(result.returned).toEqual({ reason: 'aborted_streaming' })
    expect(providerCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('concurrent query calls cannot claim the same shared turn', async () => {
    let modelCalls = 0
    let preparationArrivals = 0
    let releasePreparation!: () => void
    const preparationBarrier = new Promise<void>(resolve => {
      releasePreparation = resolve
    })
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'one claimant' })
    }
    const makeConcurrentParams = (): QueryParams => {
      const params = makeParams(callModel)
      params.deps!.autocompact = async () => {
        preparationArrivals++
        if (preparationArrivals === 2) releasePreparation()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            preparationBarrier,
            new Promise<void>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('preparation barrier timed out')),
                5_000,
              )
              timeout.unref?.()
            }),
          ])
        } finally {
          if (timeout !== undefined) clearTimeout(timeout)
        }
        return {
          wasCompacted: false,
          compactionResult: undefined,
          consecutiveFailures: undefined,
        }
      }
      return { ...params, turnBudget }
    }

    const results = await Promise.all([
      drain(makeConcurrentParams()),
      drain(makeConcurrentParams()),
    ])

    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
    expect(results.map(result => result.returned.reason).sort()).toEqual([
      'aborted_streaming',
      'completed',
    ])
  })

  test('does not charge a handoff aborted before its first request', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'continued in background' })
    }
    const foregroundParams = makeParams(callModel)
    foregroundParams.toolUseContext.abortController.abort('background')

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('does not charge a handoff aborted while preparing its first request', async () => {
    let modelCalls = 0
    const turnBudget = createQueryTurnBudget(1)
    const callModel = async function* () {
      modelCalls++
      yield createAssistantMessage({ content: 'continued in background' })
    }
    const foregroundParams = makeParams(callModel)
    const foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    foregroundParams.deps!.autocompact = async () => {
      foregroundAbortController.abort('background')
      return {
        wasCompacted: false,
        compactionResult: undefined,
        consecutiveFailures: undefined,
      }
    }

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(callModel),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(modelCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('does not charge a handoff aborted during provider preparation', async () => {
    let providerCalls = 0
    let releaseProviderPreparation!: () => void
    let providerPreparationStarted!: () => void
    const providerPreparation = new Promise<void>(resolve => {
      releaseProviderPreparation = resolve
    })
    const providerPreparationEntry = new Promise<void>(resolve => {
      providerPreparationStarted = resolve
    })
    const turnBudget = createQueryTurnBudget(1)
    const foregroundParams = makeParams(async function* () {})
    const foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    foregroundParams.deps!.callModel = async function* (input) {
      providerPreparationStarted()
      await providerPreparation
      if (input.options.onProviderRequestStart?.() === false) return
      providerCalls++
      yield createAssistantMessage({ content: 'stale foreground request' })
    }

    const foregroundPromise = drain({
      ...foregroundParams,
      turnBudget,
    })
    await providerPreparationEntry
    foregroundAbortController.abort('background')
    releaseProviderPreparation()
    const foreground = await foregroundPromise
    const background = await drain({
      ...makeParams(async function* () {
        providerCalls++
        yield createAssistantMessage({ content: 'continued in background' })
      }),
      turnBudget,
    })

    expect(foreground.returned).toEqual({ reason: 'aborted_streaming' })
    expect(background.returned).toEqual({ reason: 'completed' })
    expect(providerCalls).toBe(1)
    expect(turnBudget.turnsStarted).toBe(1)
  })

  test('background handoff emits the final-turn cap only once', async () => {
    let modelCalls = 0
    let foregroundAbortController: AbortController
    const backgroundingTool = buildTool({
      name: 'Background',
      inputSchema: z.object({}),
      maxResultSizeChars: Infinity,
      async description() {
        return 'Background the query'
      },
      async prompt() {
        return ''
      },
      async call() {
        foregroundAbortController.abort('background')
        return { data: 'backgrounded' }
      },
      mapToolResultToToolResultBlockParam(content, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: String(content),
        }
      },
      renderToolUseMessage() {
        return null
      },
      renderToolResultMessage() {
        return null
      },
    })
    const foregroundParams = makeParams(
      async function* () {
        modelCalls++
        yield createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_background_1',
              name: 'Background',
              input: {},
            },
          ],
        })
      },
      [backgroundingTool],
    )
    foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    const turnBudget = createQueryTurnBudget(1)

    const foreground = await drain({
      ...foregroundParams,
      turnBudget,
    })
    const background = await drain({
      ...makeParams(async function* () {
        modelCalls++
        yield createAssistantMessage({ content: 'must not run' })
      }),
      turnBudget,
    })
    const capAttachments = [...foreground.yielded, ...background.yielded].filter(
      message =>
        message.type === 'attachment' &&
        message.attachment.type === 'max_turns_reached',
    )

    expect(foreground.returned).toEqual({ reason: 'aborted_tools' })
    expect(background.returned).toEqual({
      reason: 'max_turns',
      turnCount: 2,
    })
    expect(modelCalls).toBe(1)
    expect(capAttachments).toHaveLength(1)
    expect(background.yielded).toContain(capAttachments[0])
  })

  test('late background handoff after attachments still emits one final-turn cap', async () => {
    dequeueAll()
    let foregroundAbortController: AbortController
    const queueingTool = buildTool({
      name: 'QueuePrompt',
      inputSchema: z.object({}),
      maxResultSizeChars: Infinity,
      async description() {
        return 'Queue a prompt during tool execution'
      },
      async prompt() {
        return ''
      },
      async call() {
        enqueue({ value: 'queued during tool execution', mode: 'prompt' })
        return { data: 'queued' }
      },
      mapToolResultToToolResultBlockParam(content, toolUseID) {
        return {
          type: 'tool_result',
          tool_use_id: toolUseID,
          content: String(content),
        }
      },
      renderToolUseMessage() {
        return null
      },
      renderToolResultMessage() {
        return null
      },
    })
    const foregroundParams = makeParams(
      async function* () {
        yield createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_queue_prompt_1',
              name: 'QueuePrompt',
              input: {},
            },
          ],
        })
      },
      [queueingTool],
    )
    foregroundParams.querySource = 'repl_main_thread'
    foregroundAbortController =
      foregroundParams.toolUseContext.abortController
    const turnBudget = createQueryTurnBudget(1)
    const foregroundGenerator = query({ ...foregroundParams, turnBudget })
    type ForegroundNext = Awaited<
      ReturnType<typeof foregroundGenerator.next>
    >
    type ForegroundYield = ForegroundNext extends IteratorResult<infer Y, unknown>
      ? Y
      : never
    const foregroundYielded: ForegroundYield[] = []

    try {
      let foregroundReturned: Terminal | undefined
      while (true) {
        const next = await foregroundGenerator.next()
        if (next.done) {
          foregroundReturned = next.value
          break
        }
        foregroundYielded.push(next.value)
        if (
          next.value.type === 'attachment' &&
          next.value.attachment.type === 'queued_command'
        ) {
          // This yield is after the post-tool abort check and immediately
          // before the terminal max-turn check that used to double-emit.
          foregroundAbortController.abort('background')
        }
      }

      const background = await drain({
        ...makeParams(async function* () {
          yield createAssistantMessage({ content: 'must not run' })
        }),
        turnBudget,
      })
      const capAttachments = [
        ...foregroundYielded,
        ...background.yielded,
      ].filter(
        message =>
          message.type === 'attachment' &&
          message.attachment.type === 'max_turns_reached',
      )

      expect(foregroundReturned).toEqual({ reason: 'aborted_tools' })
      expect(background.returned).toEqual({
        reason: 'max_turns',
        turnCount: 2,
      })
      expect(capAttachments).toHaveLength(1)
      expect(background.yielded).toContain(capAttachments[0])
    } finally {
      dequeueAll()
    }
  })

  test('without a configured limit, tool use behavior is unchanged', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'second' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({ content: 'done' })
        },
        [echoTool],
      ),
    )

    expect(returned.reason).toBe('completed')
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['first', 'second'])
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          message?.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('configured step limit'),
      ),
    ).toBe(false)
  })

  test('invalid configured limit is ignored safely', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'second' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({ content: 'done' })
        },
        [echoTool],
        { maxSteps: 0, agentType: 'general-purpose' },
      ),
    )

    expect(returned.reason).toBe('completed')
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['first', 'second'])
  })

  test('configured limit stops further tool calls and requests a no-tools summary', async () => {
    echoCalls.length = 0
    let modelCalls = 0
    const requestToolCounts: number[] = []
    const requestMessageNormalizationToolCounts: number[] = []
    const requestMessages: any[][] = []

    const { yielded, returned } = await drain(
      makeParams(
        async function* ({ messages, options, tools }) {
          modelCalls++
          requestToolCounts.push(tools.length)
          requestMessageNormalizationToolCounts.push(
            options.messageNormalizationTools?.length ?? 0,
          )
          requestMessages.push(messages)
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_echo_2',
                  name: 'Echo',
                  input: { text: 'blocked' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed: checked the allowed step. Findings: limit reached. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(requestToolCounts).toEqual([1, 0])
    expect(requestMessageNormalizationToolCounts).toEqual([0, 1])
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)
    expect(
      yielded.some(
        message =>
          message?.type === 'assistant' &&
          message.message.content.some(
            part =>
              part.type === 'text' &&
              part.text.includes('Completed: checked the allowed step') &&
              part.text.includes('Another run needed: yes'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_echo_2' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          message?.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('completed work') &&
          message.message.content.includes('remaining tasks') &&
          message.message.content.includes('another run is needed'),
      ),
    ).toBe(true)
    expect(
      requestMessages[1]?.some(
        message =>
          message.type === 'user' &&
          message.isMeta &&
          typeof message.message.content === 'string' &&
          message.message.content.includes('configured step limit'),
      ),
    ).toBe(true)

    const normalizedSecondRequest = normalizeMessagesForAPI(
      requestMessages[1] as any,
      [echoTool],
    )
    const summaryUser = normalizedSecondRequest.find(
      message =>
        message.type === 'user' &&
        Array.isArray(message.message.content) &&
        message.message.content.some(
          part =>
            part.type === 'text' &&
            part.text.includes('completed work') &&
            part.text.includes('another run is needed'),
        ),
    )
    expect(summaryUser).toBeDefined()
    if (
      summaryUser?.type === 'user' &&
      Array.isArray(summaryUser.message.content)
    ) {
      const toolResultText = summaryUser.message.content
        .filter(part => part.type === 'tool_result')
        .map(part => String(part.content))
        .join('\n')
      expect(toolResultText).not.toContain('completed work')
    }
  })

  test('step count accumulates across turns before later tool calls are blocked', async () => {
    echoCalls.length = 0
    let modelCalls = 0
    const requestToolCounts: number[] = []
    const requestMessageNormalizationToolCounts: number[] = []

    const { yielded, returned } = await drain(
      makeParams(
        async function* ({ options, tools }) {
          modelCalls++
          requestToolCounts.push(tools.length)
          requestMessageNormalizationToolCounts.push(
            options.messageNormalizationTools?.length ?? 0,
          )
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_turn_1',
                  name: 'Echo',
                  input: { text: 'first' },
                },
              ],
            })
            return
          }
          if (modelCalls === 2) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_turn_2_allowed',
                  name: 'Echo',
                  input: { text: 'second' },
                },
                {
                  type: 'tool_use',
                  id: 'toolu_turn_2_blocked',
                  name: 'Echo',
                  input: { text: 'third' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed work: handled two allowed steps. Findings: a later step was blocked. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 2, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 3,
      stepsUsed: 2,
      maxSteps: 2,
    })
    expect(modelCalls).toBe(3)
    expect(requestToolCounts).toEqual([1, 1, 0])
    expect(requestMessageNormalizationToolCounts).toEqual([0, 0, 1])
    expect(echoCalls).toEqual(['first', 'second'])
    expect(countToolUses(yielded)).toBe(2)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_turn_2_blocked' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)
    expect(
      yielded.some(
        message =>
          message?.type === 'assistant' &&
          message.message.content.some(
            part =>
              part.type === 'text' &&
              part.text.includes('Completed work: handled two allowed steps') &&
              part.text.includes('Another run needed: yes'),
          ),
      ),
    ).toBe(true)
  })

  test('multiple over-limit tool calls do not trip the failure-loop guard', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_allowed',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
                ...[1, 2, 3, 4].map(i => ({
                  type: 'tool_use' as const,
                  id: `toolu_echo_blocked_${i}`,
                  name: 'Echo',
                  input: { text: `blocked-${i}` },
                })),
              ],
            })
            return
          }
          yield createAssistantMessage({
            content:
              'Completed work: one allowed step. Findings: extra calls were blocked. Remaining tasks: continue later. Another run needed: yes.',
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
  })

  test('forced summary turn cannot execute more tools', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content: [
              {
                type: 'text',
                text: 'I should inspect one more thing first.',
                citations: null,
              },
              {
                type: 'tool_use',
                id: 'toolu_echo_summary',
                name: 'Echo',
                input: { text: 'must-not-run' },
              },
            ],
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)
    expect(
      yielded.some(
        message =>
          message?.type === 'user' &&
          Array.isArray(message.message.content) &&
          message.message.content.some(
            (part: any) =>
              part.type === 'tool_result' &&
              part.tool_use_id === 'toolu_echo_summary' &&
              part.is_error === true &&
              String(part.content).includes('Agent step limit reached'),
          ),
      ),
    ).toBe(true)

    const finalAssistantMessage = yielded
      .filter(message => message?.type === 'assistant')
      .at(-1)
    expect(
      finalAssistantMessage?.message.content.some(
        part =>
          part.type === 'text' &&
          part.text.includes('Completed work: Agent') &&
          part.text.includes(
            'Findings: 1 additional tool call was blocked',
          ) &&
          part.text.includes('Another run needed: yes'),
      ),
    ).toBe(true)
  })

  test('forced summary turn does not add a duplicate synthetic summary after a valid model summary', async () => {
    echoCalls.length = 0
    let modelCalls = 0

    const { yielded, returned } = await drain(
      makeParams(
        async function* () {
          modelCalls++
          if (modelCalls === 1) {
            yield createAssistantMessage({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_echo_1',
                  name: 'Echo',
                  input: { text: 'allowed' },
                },
              ],
            })
            return
          }
          yield createAssistantMessage({
            content: [
              {
                type: 'text',
                text: 'Completed work: one step.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Findings: the limit was reached.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Remaining tasks: continue later.',
                citations: null,
              },
              {
                type: 'text',
                text: 'Another run needed: yes.',
                citations: null,
              },
              {
                type: 'tool_use',
                id: 'toolu_echo_summary',
                name: 'Echo',
                input: { text: 'must-not-run' },
              },
            ],
          })
        },
        [echoTool],
        { maxSteps: 1, agentType: 'general-purpose' },
      ),
    )

    expect(returned).toMatchObject({
      reason: 'agent_step_limit',
      turnCount: 2,
      stepsUsed: 1,
      maxSteps: 1,
    })
    expect(modelCalls).toBe(2)
    expect(echoCalls).toEqual(['allowed'])
    expect(countToolUses(yielded)).toBe(1)

    const assistantMessages = yielded.filter(
      message => message?.type === 'assistant',
    )
    expect(assistantMessages).toHaveLength(2)
    const finalAssistantText = assistantMessages
      .at(-1)
      ?.message.content.filter(part => part.type === 'text')
      .map(part => part.text)
      .join('\n')
    expect(finalAssistantText).toContain('Completed work: one step')
    expect(finalAssistantText).toContain('Another run needed: yes')
    expect(
      assistantMessages.some(message =>
        message.message.content.some(
          part =>
            part.type === 'text' &&
            part.text.includes("Agent 'general-purpose' reached"),
        ),
      ),
    ).toBe(false)
  })

  test('real tool output with the readable limit prefix still counts as a tool use', () => {
    const messages = [
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: 'toolu_real_output',
            name: 'Echo',
            input: { text: 'prefix-collision' },
          },
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_real_output',
            content: `${AGENT_STEP_LIMIT_TOOL_RESULT_PREFIX}: this is real tool output, not synthetic`,
          },
        ],
      }),
    ]

    expect(countToolUses(messages)).toBe(1)
  })
})
