import { randomUUID } from 'node:crypto'
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { createAssistantMessage, createUserMessage } from '../../utils/messages/factories.js'
import { normalizeMessagesForAPI } from '../../utils/messages.js'
import { runToolUse } from '../tools/toolExecution.js'
import type { AssistantMessage, Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from '../../types/message.js'
import type { Terminal } from '../../query/transitions.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext, Tools } from '../../Tool.js'
import { buildNeedleToolPayload, NeedleClient } from './needleClient.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { query, type QueryParams } from '../../query.js'

type NeedleClientOwner = object

const needleClients = new WeakMap<NeedleClientOwner, NeedleClient>()
const activeNeedleClients = new Set<NeedleClient>()
registerCleanup(() => {
  for (const client of activeNeedleClients) client.close()
  activeNeedleClients.clear()
})

function getNeedleClient(context: NeedleClientOwner): NeedleClient {
  const existing = needleClients.get(context)
  if (existing) return existing
  const client = new NeedleClient()
  needleClients.set(context, client)
  activeNeedleClients.add(client)
  return client
}

export function closeNeedleClient(context: NeedleClientOwner): void {
  const client = needleClients.get(context)
  if (!client) return
  client.close()
  needleClients.delete(context)
  activeNeedleClients.delete(client)
}

export async function* runNeedleWorkerTurn({
  prompt,
  queryParams,
  tools,
  toolUseContext,
  clientOwner = toolUseContext,
  canUseTool,
  signal,
  client,
  continueQuery = query,
}: {
  prompt: string
  queryParams: QueryParams
  tools: Tools
  toolUseContext: ToolUseContext
  clientOwner?: NeedleClientOwner
  canUseTool: CanUseToolFn
  signal?: AbortSignal
  client?: Pick<NeedleClient, 'complete' | 'close'>
  continueQuery?: typeof query
}): AsyncGenerator<StreamEvent | RequestStartEvent | Message | TombstoneMessage | ToolUseSummaryMessage, Terminal> {
  const needleClient = client ?? getNeedleClient(clientOwner)
  try {
    let context = toolUseContext
    const executableTools = tools.filter(tool => tool.isEnabled())
    let response
    try {
      const needleTools = await Promise.all(executableTools.map(async tool => ({
        name: tool.name,
        description: await tool.description({}, {
          isNonInteractiveSession: context.options.isNonInteractiveSession ?? false,
          toolPermissionContext: context.getAppState().toolPermissionContext,
          tools: executableTools,
        }),
        input_schema: tool.inputJSONSchema ?? zodToJsonSchema(tool.inputSchema),
      })))
      response = await needleClient.complete({ prompt, tools: buildNeedleToolPayload(needleTools), signal })
    } catch {
      if (signal?.aborted) return { reason: 'aborted_streaming' }
      return yield* continueQuery({ ...queryParams, toolUseContext: context })
    }
    if (signal?.aborted) return { reason: 'aborted_streaming' }
    if (response.functionCalls.length !== 1) {
      return yield* continueQuery({ ...queryParams, toolUseContext: context })
    }

    const call = response.functionCalls[0]!
    const toolUse = {
      type: 'tool_use' as const,
      id: `toolu_needle_${randomUUID()}`,
      name: call.name,
      input: call.arguments,
      caller: { type: 'direct' as const },
    } satisfies ToolUseBlock
    const assistantMessage = createAssistantMessage({ content: [toolUse] }) as AssistantMessage
    context.setInProgressToolUseIDs(prev => new Set(prev).add(toolUse.id))
    yield assistantMessage
    if (signal?.aborted) {
      context.setInProgressToolUseIDs(prev => {
        const next = new Set(prev)
        next.delete(toolUse.id)
        return next
      })
      yield createUserMessage({
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Cancelled before tool execution.',
          is_error: true,
        }],
      })
      return { reason: 'aborted_streaming' }
    }

    const resultMessages: Message[] = []
    let shouldPreventContinuation = false
    try {
      for await (const update of runToolUse(toolUse, assistantMessage, canUseTool, context)) {
        if (update.contextModifier) context = update.contextModifier.modifyContext(context)
        yield update.message
        if (update.message.type === 'user') resultMessages.push(update.message)
        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }
      }
    } finally {
      context.setInProgressToolUseIDs(prev => {
        const next = new Set(prev)
        next.delete(toolUse.id)
        return next
      })
    }

    if (shouldPreventContinuation) return { reason: 'hook_stopped' }
    if (signal?.aborted) return { reason: 'aborted_streaming' }

    const normalizedResults = normalizeMessagesForAPI(resultMessages, executableTools)
      .filter(message => message.type === 'user')
    return yield* continueQuery({
      ...queryParams,
      messages: [...queryParams.messages, assistantMessage, ...normalizedResults],
      toolUseContext: context,
    })
  } finally {
    client?.close()
  }
}
