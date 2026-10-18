import {
  TOOL_RESULTS_RECEIVED_MARKER,
  stripEchoedToolResultsMarker,
} from './markerEchoGuard.js'

export type NonStreamingOpenAIResponse = {
  id?: string
  model?: string
  choices?: Array<{
    message?: {
      role?: string
      content?: string | null | Array<{ type?: string; text?: string }>
      reasoning_content?: string | null
      extra_content?: Record<string, unknown>
      tool_calls?: Array<{
        id: string
        function: { name: string; arguments: string }
        extra_content?: Record<string, unknown>
      }>
    }
    finish_reason?: string
  }>
  usage?: Record<string, unknown>
}

type Dependencies = {
  makeMessageId: () => string
  buildUsage: (usage: Record<string, unknown> | undefined) => Record<string, unknown>
  stripThinkTags: (text: string) => string
  parseXmlToolCalls: (text: string, allowHy3: boolean) => {
    calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    toolCallRanges: Array<[number, number]>
  }
  isHy3Model: (model: string) => boolean
  stripRanges: (text: string, ranges: Array<[number, number]>) => string
  parseRawToolCalls: (text: string) => Array<{ id: string; name: string; argumentsJson: string }> | null
  normalizeToolArguments: (name: string, argumentsJson: string) => unknown
  getGeminiThoughtSignature: (extraContent: unknown) => string | undefined
  mergeGeminiThoughtSignature: (
    extraContent: Record<string, unknown> | undefined,
    signature: string | undefined,
  ) => Record<string, unknown> | undefined
}

export function convertNonStreamingResponseToAnthropicMessage(
  data: NonStreamingOpenAIResponse,
  model: string,
  deps: Dependencies,
) {
  const choice = data.choices?.[0]
  const content: Array<Record<string, unknown>> = []
  const hasStructuredToolCalls = (choice?.message?.tool_calls?.length ?? 0) > 0
  const reasoning = choice?.message?.reasoning_content
  if (typeof reasoning === 'string' && reasoning) content.push({ type: 'thinking', thinking: reasoning })

  const appendTextOrRecoveredToolCalls = (rawText: string) => {
    const stripped = stripEchoedToolResultsMarker(deps.stripThinkTags(rawText))
    // A reply that only echoes the shim's old tool-results placeholder carries
    // no information — emit nothing rather than an empty terminal message.
    const echoedMarkerOnly =
      rawText.includes(TOOL_RESULTS_RECEIVED_MARKER) && !stripped.trim()
    if (!hasStructuredToolCalls) {
      const { calls, toolCallRanges } = deps.parseXmlToolCalls(stripped, deps.isHy3Model(model))
      if (calls.length) {
        const visibleText = deps.stripRanges(stripped, toolCallRanges).trim()
        if (visibleText) content.push({ type: 'text', text: visibleText })
        for (const call of calls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
        return
      }
    }
    const rawToolCalls = hasStructuredToolCalls ? null : deps.parseRawToolCalls(stripped)
    if (rawToolCalls) {
      for (const call of rawToolCalls) content.push({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.argumentsJson) })
    } else if (!echoedMarkerOnly) content.push({ type: 'text', text: stripped })
  }

  const rawContent = choice?.message?.content !== '' && choice?.message?.content != null
    ? choice.message.content : null
  if (typeof rawContent === 'string' && rawContent) appendTextOrRecoveredToolCalls(rawContent)
  else if (Array.isArray(rawContent)) {
    const text = rawContent
      .filter(
        part =>
          part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string',
      )
      .map(part => part.text!)
      .join('\n')
    if (text) appendTextOrRecoveredToolCalls(text)
  }

  if (hasStructuredToolCalls && choice?.message?.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      const extraContent = toolCall.extra_content ?? choice.message.extra_content
      const signature = deps.getGeminiThoughtSignature(toolCall.extra_content) ??
        deps.getGeminiThoughtSignature(choice.message.extra_content)
      const merged = deps.mergeGeminiThoughtSignature(extraContent, signature)
      content.push({
        type: 'tool_use', id: toolCall.id, name: toolCall.function.name,
        input: deps.normalizeToolArguments(toolCall.function.name, toolCall.function.arguments),
        ...(merged ? { extra_content: merged } : {}),
        ...(signature ? { signature } : {}),
      })
    }
  }

  const stopReason = choice?.finish_reason === 'tool_calls' || content.some(block => block.type === 'tool_use')
    ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn'
  if (choice?.finish_reason === 'content_filter' || choice?.finish_reason === 'safety') {
    content.push({ type: 'text', text: '\n\n[Content blocked by provider safety filter]' })
  }
  return {
    id: data.id ?? deps.makeMessageId(), type: 'message', role: 'assistant', content,
    model: data.model ?? model, stop_reason: stopReason, stop_sequence: null,
    usage: deps.buildUsage(data.usage),
  }
}
