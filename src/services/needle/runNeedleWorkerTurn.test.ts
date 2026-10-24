import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import type { QueryParams } from '../../query.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../../utils/messages.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { createToolFixture } from '../../test/toolFixtures.js'
import { runNeedleWorkerTurn } from './runNeedleWorkerTurn.js'
import type { NeedleFunctionCall, NeedleResponse } from './needleClient.js'

function makeContext(tools: QueryParams['toolUseContext']['options']['tools']) {
  let inProgress = new Set<string>()
  const context = {
    abortController: new AbortController(),
    getAppState: () => ({ toolPermissionContext: { mode: 'default' } }),
    options: {
      tools,
      commands: [],
      debug: false,
      thinkingConfig: { type: 'disabled' },
      verbose: false,
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: false,
      agentDefinitions: { activeAgents: [], allowedAgentTypes: undefined },
      mainLoopModel: 'provider-model',
    },
    setInProgressToolUseIDs: (update: (previous: Set<string>) => Set<string>) => {
      inProgress = update(inProgress)
    },
  } as unknown as QueryParams['toolUseContext']
  return { context, getInProgress: () => inProgress }
}

function makeParams(toolUseContext: QueryParams['toolUseContext']): QueryParams {
  return {
    messages: [createUserMessage({ content: 'original prompt' })],
    systemPrompt: asSystemPrompt([]),
    userContext: {},
    systemContext: {},
    canUseTool: async () => ({ behavior: 'allow' }),
    toolUseContext,
    querySource: 'agent:builtin:general-purpose',
  }
}

function fakeClient(response: NeedleResponse) {
  return {
    complete: async () => response,
    close: () => {},
  }
}

async function collect(generator: AsyncGenerator<Message | object, unknown>) {
  const yielded: Array<Message | object> = []
  while (true) {
    const next = await generator.next()
    if (next.done) return yielded
    yielded.push(next.value)
  }
}

describe('runNeedleWorkerTurn', () => {
  test.each<{ functionCalls: NeedleFunctionCall[] }>([
    { functionCalls: [] },
    { functionCalls: [
      { name: 'Read', arguments: {} },
      { name: 'Write', arguments: {} },
    ] },
  ])('delegates unchanged when Needle returns zero or multiple calls', async ({ functionCalls }) => {
    const { context } = makeContext([])
    const params = makeParams(context)
    let continuedWith: QueryParams | undefined
    const continueQuery = async function* (next: QueryParams) {
      continuedWith = next
      return { reason: 'completed' as const }
    }

    await collect(runNeedleWorkerTurn({
      prompt: 'plan',
      queryParams: params,
      tools: [],
      toolUseContext: context,
      canUseTool: params.canUseTool,
      client: fakeClient({ functionCalls }),
      continueQuery,
    }))

    expect(continuedWith?.messages).toBe(params.messages)
    expect(continuedWith?.toolUseContext).toBe(context)
  })

  test('falls back to the provider when the Needle runtime fails', async () => {
    const { context } = makeContext([])
    const params = makeParams(context)
    let continued = false
    const continueQuery = async function* () {
      continued = true
      return { reason: 'completed' as const }
    }
    const client = {
      complete: async () => { throw new Error('missing runtime') },
      close: () => {},
    }

    await collect(runNeedleWorkerTurn({
      prompt: 'plan',
      queryParams: params,
      tools: [],
      toolUseContext: context,
      canUseTool: params.canUseTool,
      client,
      continueQuery,
    }))

    expect(continued).toBe(true)
  })

  test('does not execute or continue after aborting after the planner prelude', async () => {
    const tool = createToolFixture(z.object({ path: z.string() }), {
      name: 'Read',
      async call() {
        throw new Error('tool should not execute')
      },
    })
    const { context, getInProgress } = makeContext([tool])
    const params = makeParams(context)
    const controller = new AbortController()
    let continued = false
    const continueQuery = async function* () {
      continued = true
      return { reason: 'completed' as const }
    }
    const generator = runNeedleWorkerTurn({
      prompt: 'plan',
      queryParams: params,
      tools: [tool],
      toolUseContext: context,
      canUseTool: params.canUseTool,
      signal: controller.signal,
      client: fakeClient({ functionCalls: [{ name: 'Read', arguments: { path: '/tmp/a' } }] }),
      continueQuery,
    })
    const prelude = (await generator.next()).value
    expect(prelude).toMatchObject({ type: 'assistant' })
    controller.abort()
    const result = await generator.next()
    expect(result.done).toBe(false)
    expect(result.value).toMatchObject({ type: 'user' })
    const cancellation = result.value as Message
    const cancellationContent = cancellation.type === 'user' ? cancellation.message.content : []
    expect(cancellationContent).toContainEqual(expect.objectContaining({
      type: 'tool_result',
      content: 'Cancelled before tool execution.',
      is_error: true,
    }))
    const cancellationResult = Array.isArray(cancellationContent)
      ? cancellationContent.find(block => block.type === 'tool_result')
      : undefined
    const preludeContent = prelude && 'type' in prelude && prelude.type === 'assistant' ? prelude.message.content : []
    const preludeToolUse = Array.isArray(preludeContent) ? preludeContent.find(block => block.type === 'tool_use') : undefined
    expect(cancellationResult?.tool_use_id).toBe(preludeToolUse?.id)
    const terminal = await generator.next()
    expect(terminal.done).toBe(true)
    expect(terminal.value).toEqual({ reason: 'aborted_streaming' })
    expect(continued).toBe(false)
    expect(getInProgress().size).toBe(0)
  })

  test('yields a paired prelude and continues the provider with normalized results', async () => {
    const tool = createToolFixture(z.object({ path: z.string() }), {
      name: 'Read',
      async call({ path }) {
        return { data: `contents:${path}` }
      },
      mapToolResultToToolResultBlockParam(content, toolUseID) {
        return { type: 'tool_result', tool_use_id: toolUseID, content: String(content) }
      },
    })
    const { context, getInProgress } = makeContext([tool])
    const params = makeParams(context)
    let providerMessages: Message[] = []
    const continueQuery = async function* (next: QueryParams) {
      providerMessages = next.messages
      return { reason: 'completed' as const }
    }

    const yielded = await collect(runNeedleWorkerTurn({
      prompt: 'plan',
      queryParams: params,
      tools: [tool],
      toolUseContext: context,
      canUseTool: params.canUseTool,
      client: fakeClient({ functionCalls: [{ name: 'Read', arguments: { path: '/tmp/a' } }] }),
      continueQuery,
    }))

    expect(yielded[0]).toMatchObject({ type: 'assistant' })
    expect(yielded.some(message => 'type' in message && message.type === 'user')).toBe(true)
    expect(providerMessages[0]).toBe(params.messages[0])
    expect(providerMessages[1]).toMatchObject({ type: 'assistant' })
    expect(providerMessages).toHaveLength(3)
    expect(providerMessages[2]).toMatchObject({ type: 'user' })
    const assistantContent = providerMessages[1]?.type === 'assistant' ? providerMessages[1].message.content : []
    const userContent = providerMessages[2]?.type === 'user' ? providerMessages[2].message.content : []
    const toolUse = Array.isArray(assistantContent) ? assistantContent.find(block => block.type === 'tool_use') : undefined
    const toolResult = Array.isArray(userContent) ? userContent.find(block => block.type === 'tool_result') : undefined
    expect(toolResult?.tool_use_id).toBe(toolUse?.id)
    expect(getInProgress().size).toBe(0)
  })
})
