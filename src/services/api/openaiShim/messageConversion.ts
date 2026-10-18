import { stripEchoedToolResultsMarker } from './markerEchoGuard.js'

export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ConvertedOpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | OpenAIContentPart[]
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
    extra_content?: Record<string, unknown>
  }>
  tool_call_id?: string
  name?: string
  reasoning_content?: string
}

export function convertSystemPrompt(system: unknown): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .map((block: { type?: string; text?: string }) =>
        block.type === 'text' ? block.text ?? '' : '',
      )
      .filter(text => !text.startsWith('x-anthropic-billing-header'))
      .join('\n\n')
  }
  return String(system)
}

function ensureTextPartForImageContent(
  parts: OpenAIContentPart[],
): OpenAIContentPart[] {
  if (!parts.some(part => part.type === 'image_url')) return parts
  if (parts.some(part => part.type === 'text' && part.text.trim().length > 0)) return parts
  return [{ type: 'text', text: 'Image attached.' }, ...parts]
}

export function joinTextContentParts(parts: OpenAIContentPart[]): string {
  return parts.map(part => part.type === 'text' ? part.text : '').join('')
}

export function convertToolResultContent(
  content: unknown,
  isError?: boolean,
  options?: { supportsImageInputs?: boolean },
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return isError ? `Error: ${content}` : content
  if (!Array.isArray(content)) {
    const text = JSON.stringify(content ?? '')
    return isError ? `Error: ${text}` : text
  }
  const parts: OpenAIContentPart[] = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    } else if (block?.type === 'tool_reference' && typeof block.tool_name === 'string') {
      parts.push({ type: 'text', text: `Tool "${block.tool_name}" is now loaded and available to call.` })
    } else if (block?.type === 'image') {
      if (options?.supportsImageInputs === false) {
        throw new Error(
          'The active provider accepts text-only messages and does not support image inputs.',
        )
      }
      const source = block.source
      if (source?.type === 'url' && source.url) parts.push({ type: 'image_url', image_url: { url: source.url } })
      else if (source?.type === 'base64' && source.media_type && source.data) {
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${source.media_type};base64,${source.data}` },
        })
      }
    } else if (typeof block?.text === 'string') {
      parts.push({ type: 'text', text: block.text })
    }
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return isError ? `Error: ${parts[0].text}` : parts[0].text
  if (parts.every(part => part.type === 'text')) {
    const text = parts.map(part => part.text).join('\n\n')
    return isError ? `Error: ${text}` : text
  }
  if (isError && parts[0]?.type === 'text') parts[0] = { ...parts[0], text: `Error: ${parts[0].text}` }
  else if (isError) parts.unshift({ type: 'text', text: 'Error:' })
  return ensureTextPartForImageContent(parts)
}

export function convertContentBlocks(
  content: unknown,
  options?: { supportsImageInputs?: boolean },
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  const parts: OpenAIContentPart[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        parts.push({ type: 'text', text: block.text ?? '' })
        break
      case 'image': {
        if (options?.supportsImageInputs === false) {
          throw new Error(
            'The active provider accepts text-only messages and does not support image inputs.',
          )
        }
        const source = block.source
        if (
          source?.type === 'base64' &&
          typeof source.media_type === 'string' &&
          typeof source.data === 'string'
        ) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${source.media_type};base64,${source.data}` },
          })
        } else if (source?.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source.url } })
        }
        break
      }
      case 'tool_use':
      case 'tool_result':
      case 'thinking':
      case 'redacted_thinking':
        break
      default:
        if (typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
        }
    }
  }
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('\n\n')
  return ensureTextPartForImageContent(parts)
}

export function convertMessages(
  messages: Array<{ role: string; message?: { role?: string; content?: unknown }; content?: unknown }>,
  system: unknown,
  options: {
    preserveReasoningContent?: boolean
    reasoningContentFallback?: '' | 'omit'
    preserveGeminiThoughtSignature?: boolean
    supportsImageInputs?: boolean
    getGeminiThoughtSignature?: (extraContent: unknown) => string | undefined
    mergeGeminiThoughtSignature?: (
      extraContent: Record<string, unknown> | undefined,
      signature: string | undefined,
    ) => Record<string, unknown> | undefined
    log?: (message: string) => void
  } = {},
): ConvertedOpenAIMessage[] {
  const result: ConvertedOpenAIMessage[] = []
  const knownToolCallIds = new Set<string>()
  const toolResultIds = new Set<string>()
  for (const msg of messages) {
    const content = (msg.message ?? msg).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_result' && block.tool_use_id) toolResultIds.add(block.tool_use_id)
    }
  }

  const sysText = convertSystemPrompt(system)
  if (sysText) result.push({ role: 'system', content: sysText })

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const isLastInHistory = i === messages.length - 1
    const inner = msg.message ?? msg
    const role = inner.role ?? msg.role
    const content = inner.content
    if (role === 'user') {
      if (!Array.isArray(content)) {
        result.push({ role: 'user', content: convertContentBlocks(content, options) })
        continue
      }
      let otherContent: unknown[] | undefined
      for (const block of content) {
        if (block?.type !== 'tool_result') {
          otherContent ??= []
          otherContent.push(block)
          continue
        }
        const id = block.tool_use_id ?? 'unknown'
        if (knownToolCallIds.has(id)) {
          result.push({
            role: 'tool',
            tool_call_id: id,
            content: convertToolResultContent(block.content, block.is_error, options),
          })
        } else {
          options.log?.(`Dropping orphan tool_result for ID: ${id} to prevent API error`)
        }
      }
      if (otherContent?.length) result.push({ role: 'user', content: convertContentBlocks(otherContent, options) })
      continue
    }
    if (role !== 'assistant') continue
    if (!Array.isArray(content)) {
      const converted = convertContentBlocks(content, options)
      const text = stripEchoedToolResultsMarker(
        typeof converted === 'string' ? converted : joinTextContentParts(converted),
      )
      if (text) result.push({ role: 'assistant', content: text })
      continue
    }
    const toolUses: Array<{
      id?: string
      name?: string
      input?: unknown
      extra_content?: Record<string, unknown>
      signature?: string
    }> = []
    let thinkingBlock: { type?: string; thinking?: string; data?: string; signature?: string } | undefined
    const textContent: unknown[] = []
    for (const block of content) {
      if (block?.type === 'tool_use') toolUses.push(block)
      else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') thinkingBlock ??= block
      else textContent.push(block)
    }
    const converted = convertContentBlocks(textContent, options)
    const assistantMsg: ConvertedOpenAIMessage = {
      role: 'assistant',
      content: stripEchoedToolResultsMarker(
        typeof converted === 'string' ? converted : joinTextContentParts(converted),
      ),
    }
    if (options.preserveReasoningContent) {
      const thinking = thinkingBlock?.type === 'redacted_thinking' ? thinkingBlock.data : thinkingBlock?.thinking
      if (typeof thinking === 'string' && thinking.trim()) assistantMsg.reasoning_content = thinking
      else if (toolUses.length && options.reasoningContentFallback === '') assistantMsg.reasoning_content = ''
    }
    const mappedToolCalls: NonNullable<ConvertedOpenAIMessage['tool_calls']> = []
    for (const toolUse of toolUses) {
      const id = toolUse.id ?? `call_${crypto.randomUUID().replace(/-/g, '')}`
      if (!toolResultIds.has(id) && !isLastInHistory) continue
      knownToolCallIds.add(id)
      const toolCall: NonNullable<ConvertedOpenAIMessage['tool_calls']>[number] = {
        id, type: 'function', function: {
          name: toolUse.name ?? 'unknown',
          arguments: typeof toolUse.input === 'string' ? toolUse.input : JSON.stringify(toolUse.input ?? {}),
        },
      }
      if (toolUse.extra_content) toolCall.extra_content = { ...toolUse.extra_content }
      if (options.preserveGeminiThoughtSignature) {
        const signature =
          toolUse.signature ??
          options.getGeminiThoughtSignature?.(toolUse.extra_content) ??
          thinkingBlock?.signature
        toolCall.extra_content =
          options.mergeGeminiThoughtSignature?.(toolCall.extra_content, signature) ??
          toolCall.extra_content
      }
      mappedToolCalls.push(toolCall)
    }
    if (mappedToolCalls.length) assistantMsg.tool_calls = mappedToolCalls
    if (assistantMsg.content || assistantMsg.tool_calls?.length) result.push(assistantMsg)
  }

  const coalesced: ConvertedOpenAIMessage[] = []
  for (const msg of result) {
    const last = coalesced[coalesced.length - 1]
    if (!last || last.role !== msg.role || msg.role === 'tool' || msg.role === 'system') {
      coalesced.push(msg)
      continue
    }
    const previous = last.content
    const current = msg.content
    if (typeof previous === 'string' && typeof current === 'string') {
      last.content = previous + (previous && current ? '\n' : '') + current
    } else {
      const asParts = (value: typeof previous): OpenAIContentPart[] =>
        !value
          ? []
          : typeof value === 'string'
            ? [{ type: 'text', text: value }]
            : value
      last.content = [...asParts(previous), ...asParts(current)]
    }
    if (msg.tool_calls?.length) last.tool_calls = [...(last.tool_calls ?? []), ...msg.tool_calls]
  }
  return coalesced
}
