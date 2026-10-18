import { APIError } from '@anthropic-ai/sdk'
import { buildAnthropicUsageFromRawUsage } from '../cacheMetrics.js'
import type { AnthropicStreamEvent, AnthropicUsage } from '../codexShim.js'
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
} from '../openaiErrorClassification.js'
import { createThinkTagFilter, stripThinkTags } from '../thinkTagSanitizer.js'
import {
  hasToolFieldMapping,
  normalizeToolArguments,
} from '../toolArgumentNormalization.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  createStreamState,
  getStreamStats,
  processStreamChunk,
} from '../../../utils/streamingOptimizer.js'
import type { createProviderStreamTrace } from './streamControl.js'

type ParsedRawToolCall = { id: string; name: string; argumentsJson: string }
type ParsedTextToolCall = { id: string; name: string; arguments: unknown }
type ParsedToolCalls = {
  calls: ParsedTextToolCall[]
  toolCallRanges: Array<[number, number]>
}
type OpenAIToolCallDelta = {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
  extra_content?: Record<string, unknown>
}
type OpenAIStreamChunk = {
  error?: { message?: string; type?: string; code?: string }
  usage?: Record<string, unknown>
  choices?: Array<{
    delta: {
      reasoning_content?: string | null
      content?: string | null
      tool_calls?: OpenAIToolCallDelta[]
      extra_content?: Record<string, unknown>
    }
    finish_reason?: string | null
  }>
}
type ConvertedAnthropicMessage = {
  content: Array<Record<string, unknown>>
  stop_reason: string | null
  usage: Partial<AnthropicUsage>
}
type ReaderCanceller = {
  cancel(error?: unknown): void
  cleanup(): void
}
type StreamReadResult = Awaited<
  ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
>

export type StreamConversionDependencies = {
  convertNonStreamingResponseToAnthropicMessage(
    data: unknown,
    model: string,
  ): ConvertedAnthropicMessage
  couldBeRawToolCallsRequestedPrefix(text: string): boolean
  createReaderCanceller(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): ReaderCanceller
  createProviderStreamTrace: typeof createProviderStreamTrace
  createStreamAbortError(): DOMException
  findXmlToolCallOpener(text: string, allowHy3: boolean): number
  geminiThoughtSignatureFromExtraContent(extraContent: unknown): string | undefined
  getStreamIdleTimeoutMs(): number
  headersWithRequestUrl(headers: Headers, requestUrl?: string): Headers
  isHy3Model(model: string): boolean
  makeMessageId(): string
  mergeGeminiThoughtSignature(
    extraContent: Record<string, unknown> | undefined,
    signature: string | undefined,
  ): Record<string, unknown> | undefined
  parseRawToolCallsRequestedText(text: string): ParsedRawToolCall[] | null
  parseTextToolCalls(text: string): ParsedToolCalls
  parseXmlToolCalls(text: string, allowHy3?: boolean): ParsedToolCalls
  readWithIdleTimeout(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs: number,
    options?: {
      signal?: AbortSignal
      cancelReader?: (error?: unknown) => void
      onTimeout?: (error: unknown) => void
    },
  ): Promise<StreamReadResult>
  repairPossiblyTruncatedObjectJson(raw: string): string | null
  stripRanges(text: string, ranges: Array<[number, number]>): string
  throwIfStreamAborted(signal?: AbortSignal): void
  trailingXmlOpenerPrefixLen(text: string, allowHy3: boolean): number
}
const JSON_REPAIR_SUFFIXES = [
  '}', '"}', ']}', '"]}', '}}', '"}}', ']}}', '"]}}', '"]}]}', '}]}',
]

export function convertOpenAIStreamUsage(
  usage: Record<string, unknown> | undefined,
): Partial<AnthropicUsage> | undefined {
  if (!usage) return undefined
  return buildAnthropicUsageFromRawUsage(usage)
}

export async function* openaiStreamToAnthropic(
  response: Response,
  model: string,
  signal: AbortSignal | undefined,
  isOllama: boolean,
  requestUrl: string | undefined,
  dependencies: StreamConversionDependencies,
): AsyncGenerator<AnthropicStreamEvent> {
  const {
    convertNonStreamingResponseToAnthropicMessage,
    couldBeRawToolCallsRequestedPrefix,
    createReaderCanceller,
    createProviderStreamTrace,
    createStreamAbortError,
    findXmlToolCallOpener,
    geminiThoughtSignatureFromExtraContent,
    getStreamIdleTimeoutMs,
    headersWithRequestUrl,
    isHy3Model,
    makeMessageId,
    mergeGeminiThoughtSignature,
    parseRawToolCallsRequestedText,
    parseTextToolCalls,
    parseXmlToolCalls,
    readWithIdleTimeout,
    repairPossiblyTruncatedObjectJson,
    stripRanges,
    throwIfStreamAborted,
    trailingXmlOpenerPrefixLen,
  } = dependencies

  const messageId = makeMessageId()
  const allowHy3ToolCalls = isHy3Model(model)
  let contentBlockIndex = 0
  const activeToolCalls = new Map<
    number,
    {
      id: string
      name: string
      index: number
      jsonBuffer: string
      normalizeAtStop: boolean
    }
  >()
  let hasEmittedContentStart = false
  let hasEmittedThinkingStart = false
  let hasClosedThinking = false
  const thinkFilter = createThinkTagFilter()
  let lastStopReason: 'tool_use' | 'max_tokens' | 'end_turn' | null = null
  let hasEmittedFinalUsage = false
  let protocolComplete = false
  let providerTerminalObserved = false
  let readerFailed = false
  let hasProcessedFinishReason = false
  // Accumulated text for Ollama text-based tool call fallback parsing (#1053)
  let accumulatedText = ''
  // Use the resolved value threaded from the call site (resolveProviderRequest)
  // rather than re-reading env vars inside the generator.
  const isOllamaStream = isOllama
  // Buffer Ollama text deltas so raw tool-call JSON is never emitted as text_delta
  // before extraction at finish_reason=stop (P2 fix for #1053).
  let ollamaTextBuffer = ''
  const streamState = createStreamState()
  let bufferedRawToolCallsText: string | null = null
  // XML tool-call fallback (GLM/Qwen-style `<tool_call><function=…>` emitted as
  // text). Once the opener is seen we stop emitting text and buffer the
  // remainder in xmlToolCallText, converting it to tool_use blocks at finalize.
  // xmlHoldback retains a trailing partial opener split across deltas.
  let xmlToolCallText: string | null = null
  let xmlHoldback = ''

  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const text = await response.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw APIError.generate(
        response.status,
        undefined,
        `Unexpected JSON response from provider: ${text}`,
        response.headers as unknown as Headers,
      )
    }

    const parsedRecord = parsed as { error?: unknown }
    if (parsedRecord.error) {
      const errorMsg =
        typeof parsedRecord.error === 'object' && parsedRecord.error !== null
          ? JSON.stringify(parsedRecord.error)
          : String(parsedRecord.error)
      const failure = classifyOpenAIHttpFailure({
        status: response.status,
        body: text,
        url: requestUrl ?? response.url,
      })
      throw APIError.generate(
        response.status,
        parsedRecord,
        buildOpenAICompatibilityErrorMessage(
          `OpenAI API error ${response.status}: ${errorMsg}`,
          { ...failure, requestUrl: requestUrl ?? response.url },
        ),
        headersWithRequestUrl(response.headers, requestUrl ?? response.url),
      )
    }

    // Some providers ignore `stream: true` and return a normal JSON chat
    // completion. Route it through the shared non-streaming converter so this
    // fallback preserves tool_calls, Anthropic stop-reason mapping, array
    // content normalization, <think>-tag stripping, and raw text tool-call
    // recovery — then re-emit the resulting message as stream events.
    const message = convertNonStreamingResponseToAnthropicMessage(parsed, model)

    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    for (const block of message.content) {
      if (block.type === 'thinking') {
        yield {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        }
        yield {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'thinking_delta', thinking: block.thinking as string },
        }
        yield { type: 'content_block_stop', index: contentBlockIndex }
        contentBlockIndex++
      } else if (block.type === 'tool_use') {
        const { type: _t, input, ...rest } = block
        yield {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'tool_use', input: {}, ...rest },
        }
        yield {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(input ?? {}) },
        }
        yield { type: 'content_block_stop', index: contentBlockIndex }
        contentBlockIndex++
      } else {
        yield {
          type: 'content_block_start',
          index: contentBlockIndex,
          content_block: { type: 'text', text: '' },
        }
        yield {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text: block.text as string },
        }
        yield { type: 'content_block_stop', index: contentBlockIndex }
        contentBlockIndex++
      }
    }

    yield {
      type: 'message_delta',
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: null,
      },
      usage: message.usage,
    }
    yield { type: 'message_stop' }
    return
  }

  const readerOrNull = response.body?.getReader()
  if (!readerOrNull) throw new Error('Response body is not readable')
  const reader: ReadableStreamDefaultReader<Uint8Array> = readerOrNull
  const readerCanceller = createReaderCanceller(reader, signal)

  const decoder = new TextDecoder()
  let buffer = ''
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()
  let lastDataTime = performance.now()
  let streamComplete = false
  const streamTrace = createProviderStreamTrace('openai_chat_completions')

  const closeActiveContentBlock = async function* () {
    if (!hasEmittedContentStart) return

    const tail = thinkFilter.flush()
    if (tail) {
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: tail },
      }
    }

    throwIfStreamAborted(signal)
    yield {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    hasEmittedContentStart = false
  }

  const emitTextDelta = async function* (text: string) {
    if (!text) return
    if (!hasEmittedContentStart) {
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_start',
        index: contentBlockIndex,
        content_block: { type: 'text', text: '' },
      }
      hasEmittedContentStart = true
    }

    const visible = thinkFilter.feed(text)
    if (visible) {
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: visible },
      }
    }
    processStreamChunk(streamState, text)
  }

  const emitParsedRawToolCalls = async function* (
    toolCalls: ParsedRawToolCall[],
  ) {
    if (hasEmittedThinkingStart && !hasClosedThinking) {
      throwIfStreamAborted(signal)
      yield { type: 'content_block_stop', index: contentBlockIndex }
      contentBlockIndex++
      hasClosedThinking = true
    }
    if (hasEmittedContentStart) {
      yield* closeActiveContentBlock()
    }

    for (const toolCall of toolCalls) {
      throwIfStreamAborted(signal)
      const toolBlockIndex = contentBlockIndex
      yield {
        type: 'content_block_start',
        index: toolBlockIndex,
        content_block: {
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: {},
        },
      }
      contentBlockIndex++
      throwIfStreamAborted(signal)
      yield {
        type: 'content_block_delta',
        index: toolBlockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: toolCall.argumentsJson,
        },
      }
      throwIfStreamAborted(signal)
      yield { type: 'content_block_stop', index: toolBlockIndex }
      processStreamChunk(streamState, toolCall.argumentsJson)
    }
  }

  const finalizeIncompleteStream = async function* () {
    if (hasProcessedFinishReason) return
    hasProcessedFinishReason = true

    // A terminal provider reason is required before exposing a tool call as
    // complete. Finishing a transport-truncated tool stream could otherwise
    // hand a partial command to the executor.
    if (
      activeToolCalls.size > 0 ||
      bufferedRawToolCallsText !== null ||
      xmlToolCallText !== null ||
      (isOllamaStream && parseTextToolCalls(accumulatedText).calls.length > 0)
    ) {
      throw new Error('OpenAI-compatible stream ended before a tool call completed')
    }

    if (hasEmittedThinkingStart && !hasClosedThinking) {
      throwIfStreamAborted(signal)
      yield { type: 'content_block_stop', index: contentBlockIndex }
      contentBlockIndex++
      hasClosedThinking = true
    }

    if (xmlToolCallText !== null) {
      yield* emitTextDelta(xmlToolCallText)
      xmlToolCallText = null
    }
    if (xmlHoldback) {
      yield* emitTextDelta(xmlHoldback)
      xmlHoldback = ''
    }
    if (ollamaTextBuffer) {
      yield* emitTextDelta(ollamaTextBuffer)
      ollamaTextBuffer = ''
    }
    if (hasEmittedContentStart) {
      yield* closeActiveContentBlock()
    }
    lastStopReason = 'end_turn'
    throwIfStreamAborted(signal)
    yield {
      type: 'message_delta',
      delta: { stop_reason: lastStopReason, stop_sequence: null },
    }
  }

  try {
    throwIfStreamAborted(signal)

    // Emit message_start
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    }

    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, streamIdleTimeoutMs, {
        signal,
        cancelReader: readerCanceller.cancel,
        onTimeout: error => {
          const elapsed = Math.round((performance.now() - lastDataTime) / 1000)
          logForDebugging(
            `OpenAI-compatible SSE stream idle for ${elapsed}s (limit: ${streamIdleTimeoutMs / 1000}s). Connection likely dropped.`,
            { level: 'error' },
          )
          streamTrace.recordIdleTimeout(error)
        },
      })
      if (done) {
        streamComplete = true
        streamTrace.recordEof()
        break
      }
      if (value) lastDataTime = performance.now()
      streamTrace.recordRaw(value)

      throwIfStreamAborted(signal)
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
      throwIfStreamAborted(signal)
      const trimmed = line.trim()
      if (!trimmed) continue
      if (trimmed === 'data: [DONE]') {
        streamTrace.recordControl()
        // `[DONE]` is protocol completion; do not wait for a transport EOF.
        // Leave streamComplete false so finally cancels an unread response body.
        protocolComplete = true
        break
      }
      if (!trimmed.startsWith('data: ')) {
        if (trimmed.startsWith(':') || trimmed.startsWith('event:')) {
          streamTrace.recordControl()
        } else {
          streamTrace.recordIgnored()
        }
        continue
      }

      let chunk: OpenAIStreamChunk
      try {
        const parsed: unknown = JSON.parse(trimmed.slice(6))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          streamTrace.recordIgnored()
        } else {
          streamTrace.recordParsed()
        }
        chunk = parsed as OpenAIStreamChunk
      } catch {
        streamTrace.recordIgnored()
        continue
      }

      // In-stream error event. Used by OpenAI when a stream fails after
      // headers have been sent, and by intermediaries (e.g. gateways) that
      // want to signal a structured failure without dropping the TCP
      // connection. Surface it as an APIError so callers see a clean
      // message instead of "stream ended without [DONE]".
      const inStreamError = (chunk as unknown as { error?: { message?: string; type?: string; code?: string } }).error
      if (inStreamError && typeof inStreamError === 'object') {
        const message =
          typeof inStreamError.message === 'string'
            ? inStreamError.message
            : 'Provider returned an in-stream error'
        const errorPayload = {
          error: {
            message,
            type: inStreamError.type ?? 'api_error',
            code: inStreamError.code ?? null,
          },
        }
        throw APIError.generate(
          (response.status ?? 200) as number,
          errorPayload,
          message,
          headersWithRequestUrl(response.headers, requestUrl ?? response.url),
        )
      }

      const chunkUsage = convertOpenAIStreamUsage(chunk.usage)

      for (const choice of chunk.choices ?? []) {
        throwIfStreamAborted(signal)
        const delta = choice.delta

        // Reasoning models (e.g. GLM-5, DeepSeek) may stream chain-of-thought
        // in `reasoning_content` before the actual reply appears in `content`.
        // Emit reasoning as a thinking block and content as a text block.
        if (delta.reasoning_content != null && delta.reasoning_content !== '') {
          if (!hasEmittedThinkingStart) {
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' },
            }
            hasEmittedThinkingStart = true
          }
          throwIfStreamAborted(signal)
          yield {
            type: 'content_block_delta',
            index: contentBlockIndex,
            delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
          }
        }

        // Text content — use != null to distinguish absent field from empty string,
        // some providers send "" as first delta to signal streaming start
        if (delta.content != null && delta.content !== '') {
          // Close thinking block if transitioning from reasoning to content
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            throwIfStreamAborted(signal)
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }

          accumulatedText += delta.content
          if (isOllamaStream) {
            const visible = thinkFilter.feed(delta.content)
            if (visible) {
              ollamaTextBuffer += visible
            }
          } else if (xmlToolCallText !== null) {
            // Inside an XML tool-call region — buffer, emit nothing visible.
            xmlToolCallText += delta.content
          } else if (
            !hasEmittedContentStart &&
            bufferedRawToolCallsText === null &&
            couldBeRawToolCallsRequestedPrefix(delta.content)
          ) {
            bufferedRawToolCallsText = delta.content
            processStreamChunk(streamState, delta.content)
          } else if (bufferedRawToolCallsText !== null) {
            bufferedRawToolCallsText += delta.content
            processStreamChunk(streamState, delta.content)
            if (!couldBeRawToolCallsRequestedPrefix(bufferedRawToolCallsText)) {
              yield* emitTextDelta(bufferedRawToolCallsText)
              bufferedRawToolCallsText = null
            }
          } else {
            // Watch for an XML tool-call opener that may be split across deltas.
            // Everything from `<tool_call>` onward is held back (never shown) and
            // converted to tool_use blocks at finalize; prose before it streams
            // normally, minus a trailing partial-opener prefix.
            const combined = xmlHoldback + delta.content
            const openIdx = findXmlToolCallOpener(
              combined,
              allowHy3ToolCalls,
            )
            if (openIdx !== -1) {
              const before = combined.slice(0, openIdx)
              if (before) yield* emitTextDelta(before)
              xmlHoldback = ''
              xmlToolCallText = combined.slice(openIdx)
            } else {
              const keep = trailingXmlOpenerPrefixLen(
                combined,
                allowHy3ToolCalls,
              )
              const emit =
                keep > 0 ? combined.slice(0, combined.length - keep) : combined
              xmlHoldback = keep > 0 ? combined.slice(combined.length - keep) : ''
              if (emit) yield* emitTextDelta(emit)
            }
          }
        }

        // Tool calls
        if (delta.tool_calls) {
          // Structured tool calls arrived — any held-back XML was a false
          // positive (the model uses one mechanism or the other). Flush it
          // as text so nothing is lost.
          if (xmlToolCallText !== null) {
            yield* emitTextDelta(xmlToolCallText)
            xmlToolCallText = null
          }
          if (xmlHoldback) {
            yield* emitTextDelta(xmlHoldback)
            xmlHoldback = ''
          }
          if (bufferedRawToolCallsText !== null) {
            const parsedBufferedToolCalls = parseRawToolCallsRequestedText(
              bufferedRawToolCallsText,
            )
            if (
              !parsedBufferedToolCalls &&
              !couldBeRawToolCallsRequestedPrefix(bufferedRawToolCallsText)
            ) {
              yield* emitTextDelta(bufferedRawToolCallsText)
            }
            bufferedRawToolCallsText = null
          }
          for (const tc of delta.tool_calls) {
            if (tc.id && tc.function?.name) {
              // New tool call starting — close any open thinking block first
              if (hasEmittedThinkingStart && !hasClosedThinking) {
                throwIfStreamAborted(signal)
                yield { type: 'content_block_stop', index: contentBlockIndex }
                contentBlockIndex++
                hasClosedThinking = true
              }
              // Flush buffered Ollama text before processing the tool call.
              // Must run before hasEmittedContentStart check because for Ollama
              // streams the text block may not have been opened yet (we buffer
              // instead of emitting during the streaming phase).
              if (isOllamaStream && ollamaTextBuffer) {
                if (!hasEmittedContentStart) {
                  throwIfStreamAborted(signal)
                  yield {
                    type: 'content_block_start',
                    index: contentBlockIndex,
                    content_block: { type: 'text', text: '' },
                  }
                  hasEmittedContentStart = true
                }
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: ollamaTextBuffer },
                }
                ollamaTextBuffer = ''
              }
              if (hasEmittedContentStart) {
                yield* closeActiveContentBlock()
              }

              const toolBlockIndex = contentBlockIndex
              const initialArguments = tc.function.arguments ?? ''
              const normalizeAtStop = hasToolFieldMapping(tc.function.name)
              const toolExtraContent = tc.extra_content ?? delta.extra_content
              const toolSignature =
                geminiThoughtSignatureFromExtraContent(tc.extra_content) ??
                geminiThoughtSignatureFromExtraContent(delta.extra_content)
              const mergedToolExtraContent = mergeGeminiThoughtSignature(
                toolExtraContent,
                toolSignature,
              )
              processStreamChunk(streamState, tc.function.arguments ?? '')
              activeToolCalls.set(tc.index, {
                id: tc.id,
                name: tc.function.name,
                index: toolBlockIndex,
                jsonBuffer: initialArguments,
                normalizeAtStop,
              })

              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_start',
                index: toolBlockIndex,
                content_block: {
                  type: 'tool_use',
                  id: tc.id,
                  name: tc.function.name,
                  input: {},
                  ...(mergedToolExtraContent ? { extra_content: mergedToolExtraContent } : {}),
                  ...(toolSignature ? { signature: toolSignature } : {}),
                },
              }
              contentBlockIndex++

              // Emit any initial arguments
              if (tc.function.arguments && !normalizeAtStop) {
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            } else if (tc.function?.arguments) {
              // Continuation of existing tool call
              const active = activeToolCalls.get(tc.index)
              if (active) {
                if (tc.function.arguments) {
                  active.jsonBuffer += tc.function.arguments
                }

                if (active.normalizeAtStop) {
                  continue
                }

                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: active.index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: tc.function.arguments,
                  },
                }
              }
            }
          }
        }

        // Finish — guard ensures we only process finish_reason once even if
        // multiple chunks arrive with finish_reason set (some providers do this)
        if (choice.finish_reason && !hasProcessedFinishReason) {
          providerTerminalObserved = true
          hasProcessedFinishReason = true

          // Close any open thinking block that wasn't closed by content transition
          if (hasEmittedThinkingStart && !hasClosedThinking) {
            throwIfStreamAborted(signal)
            yield { type: 'content_block_stop', index: contentBlockIndex }
            contentBlockIndex++
            hasClosedThinking = true
          }
          // Ollama text-based tool call fallback (#1053):
          // Must run before closeActiveContentBlock so the text buffer can be flushed
          // with tool-call JSON stripped (P2). Ollama models emit tool calls as raw
          // JSON text; scan accumulated text on any terminal finish reason with no
          // API tool calls. finish_reason is mutated to 'tool_calls' only for 'stop'
          // so the JSON fallback remains scoped to normal completions.
          const OLLAMA_TERMINAL_REASONS = new Set(['stop', 'length', 'content_filter', 'safety'])
          const isTerminalOllamaFinish =
            OLLAMA_TERMINAL_REASONS.has(choice.finish_reason ?? '') &&
            activeToolCalls.size === 0 &&
            isOllamaStream
          const originalFinishReason = choice.finish_reason
          let ollamaClosedContentBlock = false
          if (isTerminalOllamaFinish) {
            const { calls: textToolCalls, toolCallRanges } = parseTextToolCalls(accumulatedText)
            if (textToolCalls.length > 0) {
              ollamaClosedContentBlock = true
              // Compute visible prose (tool-call JSON stripped, think-tags removed).
              // Use accumulatedText (raw) as source because toolCallRanges are relative to it.
              const stripped = stripRanges(accumulatedText, toolCallRanges).trim()
              const strippedVisible = stripThinkTags(stripped).trim()
              if (hasEmittedContentStart) {
                // Text block was already open — emit stripped prose then close it.
                if (strippedVisible) {
                  throwIfStreamAborted(signal)
                  yield {
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'text_delta', text: strippedVisible },
                  }
                }
                yield* closeActiveContentBlock()
              } else if (strippedVisible) {
                // Text was buffered (Ollama path, hasEmittedContentStart === false).
                // Open a text block, emit the visible prose before the tool call, close it.
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }
                hasEmittedContentStart = true
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: contentBlockIndex,
                  delta: { type: 'text_delta', text: strippedVisible },
                }
                yield* closeActiveContentBlock()
              }
              for (const tc of textToolCalls) {
                throwIfStreamAborted(signal)
                const toolBlockIndex = contentBlockIndex
                yield {
                  type: 'content_block_start',
                  index: toolBlockIndex,
                  content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
                }
                contentBlockIndex++
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) },
                }
                throwIfStreamAborted(signal)
                yield { type: 'content_block_stop', index: toolBlockIndex }
              }
              // Only remap finish_reason to 'tool_calls' for the normal stop case;
              // non-stop terminal reasons keep their original reason.
              if (originalFinishReason === 'stop') {
                choice.finish_reason = 'tool_calls'
              }
            } else if (ollamaTextBuffer) {
              // No tool calls — flush the buffered text before the normal close below.
              // Open a text block first if one is not already open (guards the edge case
              // where hasEmittedContentStart is false but the buffer has content).
              if (!hasEmittedContentStart) {
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }
                hasEmittedContentStart = true
              }
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: ollamaTextBuffer },
              }
            }
          }

          // XML tool-call fallback for non-Ollama OpenAI-compatible providers
          // (GLM/Qwen emit `<tool_call><function=…>` as text). Mirror the Ollama
          // path: convert buffered XML to tool_use blocks and strip the raw XML.
          let xmlClosedContentBlock = false
          if (!isOllamaStream && xmlToolCallText !== null) {
            const buffered = xmlToolCallText
            xmlToolCallText = null
            const { calls, toolCallRanges } = parseXmlToolCalls(
              buffered,
              allowHy3ToolCalls,
            )
            if (calls.length > 0) {
              const stripped = stripRanges(buffered, toolCallRanges).trim()
              const strippedVisible = stripThinkTags(stripped).trim()
              if (strippedVisible) {
                // emitTextDelta opens a text block if one is not already open;
                // when prose preceded the opener the block is still open and we
                // simply append the trailing prose to it.
                yield* emitTextDelta(strippedVisible)
              }
              if (hasEmittedContentStart) {
                yield* closeActiveContentBlock()
                xmlClosedContentBlock = true
              }
              for (const tc of calls) {
                throwIfStreamAborted(signal)
                const toolBlockIndex = contentBlockIndex
                yield {
                  type: 'content_block_start',
                  index: toolBlockIndex,
                  content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} },
                }
                contentBlockIndex++
                throwIfStreamAborted(signal)
                yield {
                  type: 'content_block_delta',
                  index: toolBlockIndex,
                  delta: { type: 'input_json_delta', partial_json: JSON.stringify(tc.arguments) },
                }
                throwIfStreamAborted(signal)
                yield { type: 'content_block_stop', index: toolBlockIndex }
              }
              if (originalFinishReason === 'stop') {
                choice.finish_reason = 'tool_calls'
              }
            } else {
              // No valid tool calls parsed — the buffered text was a false
              // positive (e.g. the model wrote about `<tool_call>` literally).
              // Emit it verbatim so nothing is lost.
              yield* emitTextDelta(buffered)
            }
          } else if (!isOllamaStream && xmlHoldback) {
            // A trailing partial opener that never completed is just text.
            yield* emitTextDelta(xmlHoldback)
            xmlHoldback = ''
          }

          // Flush bufferedRawToolCallsText for non-Ollama providers
          const parsedBufferedToolCalls = bufferedRawToolCallsText
            ? parseRawToolCallsRequestedText(bufferedRawToolCallsText)
            : null
          if (parsedBufferedToolCalls) {
            yield* emitParsedRawToolCalls(parsedBufferedToolCalls)
            bufferedRawToolCallsText = null
          } else if (bufferedRawToolCallsText !== null) {
            yield* emitTextDelta(bufferedRawToolCallsText)
            bufferedRawToolCallsText = null
          }

          // Close any open content blocks (skipped when the Ollama or XML
          // fallback already closed it above)
          if (hasEmittedContentStart && !ollamaClosedContentBlock && !xmlClosedContentBlock) {
            yield* closeActiveContentBlock()
          }
          // Close active tool calls
          for (const [, tc] of activeToolCalls) {
            if (tc.normalizeAtStop) {
              let partialJson: string
              if (choice.finish_reason === 'length') {
                // Truncated by max tokens — preserve raw buffer to avoid
                // turning an incomplete tool call into an executable command
                partialJson = tc.jsonBuffer
              } else {
                const repairedStructuredJson = repairPossiblyTruncatedObjectJson(
                  tc.jsonBuffer,
                )
                if (repairedStructuredJson) {
                  partialJson = repairedStructuredJson
                } else {
                  partialJson = JSON.stringify(
                    normalizeToolArguments(tc.name, tc.jsonBuffer),
                  )
                }
              }

              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: partialJson,
                },
              }
              throwIfStreamAborted(signal)
              yield { type: 'content_block_stop', index: tc.index }
              continue
            }

            let suffixToAdd = ''
            if (tc.jsonBuffer) {
              try {
                JSON.parse(tc.jsonBuffer)
              } catch {
                const str = tc.jsonBuffer.trimEnd()
                for (const combo of JSON_REPAIR_SUFFIXES) {
                  try {
                    JSON.parse(str + combo)
                    suffixToAdd = combo
                    break
                  } catch {}
                }
              }
            }

            if (suffixToAdd) {
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_delta',
                index: tc.index,
                delta: {
                  type: 'input_json_delta',
                  partial_json: suffixToAdd,
                },
              }
            }

            throwIfStreamAborted(signal)
            yield { type: 'content_block_stop', index: tc.index }
          }

          const stopReason =
            parsedBufferedToolCalls || choice.finish_reason === 'tool_calls'
              ? 'tool_use'
              : choice.finish_reason === 'length'
                ? 'max_tokens'
                : 'end_turn'
          if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'safety') {
            // Gemini/Azure content safety filter blocked the response.
            // Emit a visible text block so the user knows why output was truncated.
            if (!hasEmittedContentStart) {
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Content blocked by provider safety filter]' },
            }
          } else if (choice.finish_reason === 'length') {
            // Response was truncated — either the model hit max_tokens, or
            // an upstream/gateway watchdog synthesized a graceful end after
            // detecting a stalled stream. Either way, the user should know
            // the answer they're seeing isn't complete.
            if (!hasEmittedContentStart) {
              throwIfStreamAborted(signal)
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }
            throwIfStreamAborted(signal)
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'text_delta', text: '\n\n[Response truncated — reached length limit or upstream stalled. Ask the model to continue.]' },
            }
          }
          if (
            choice.finish_reason === 'content_filter' ||
            choice.finish_reason === 'safety' ||
            choice.finish_reason === 'length'
          ) {
            throwIfStreamAborted(signal)
            yield { type: 'content_block_stop', index: contentBlockIndex }
            hasEmittedContentStart = false
          }
          lastStopReason = stopReason

          throwIfStreamAborted(signal)
          yield {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            ...(chunkUsage ? { usage: chunkUsage } : {}),
          }
          if (chunkUsage) {
            hasEmittedFinalUsage = true
          }
        }
      }

      // FINAL USAGE, however the provider chooses to deliver it.
      //
      // Two shapes are in the wild. Some providers send one terminal chunk
      // carrying both the finish_reason and the usage — handled in the loop
      // above. Others repeat the finish_reason: one chunk to end the message,
      // then a second, identical but for the usage. OpenRouter does the
      // second, measured on the wire:
      //
      //   chunks carrying a finish_reason: 2
      //   chunks carrying usage:           1   (the later of the two)
      //
      // The loop above deliberately ignores a repeated finish_reason, so that
      // second chunk never produced a message_delta and its usage was
      // dropped. The condition here used to require an EMPTY choices array,
      // which is the third shape, and so it missed this one too.
      //
      // What that cost: every assistant message stored usage of all zeros.
      // Anything reading the size of a conversation reads it from there —
      // `tokenCountWithEstimation` walks back to the newest message carrying
      // usage and trusts it — so automatic compaction on size could not fire,
      // the context warning never warned, and the cost tracker recorded
      // nothing. A real session went to 1 763 messages and recorded
      // `preTokens: 183` at its compaction boundary.
      //
      // `hasEmittedFinalUsage` keeps this from double-emitting for the
      // providers already served by the loop.
      if (!hasEmittedFinalUsage && chunkUsage && lastStopReason !== null) {
        throwIfStreamAborted(signal)
        yield {
          type: 'message_delta',
          delta: { stop_reason: lastStopReason, stop_sequence: null },
          usage: chunkUsage,
        }
        hasEmittedFinalUsage = true
      }
    }
      if (protocolComplete) break
    }
    yield* finalizeIncompleteStream()
  } catch (error) {
    readerFailed = true
    throw error
  } finally {
    streamTrace.recordClosed(
      signal?.aborted
        ? 'root_aborted'
        : readerFailed
          ? 'failed'
          : protocolComplete || providerTerminalObserved
            ? 'complete'
          : streamComplete
            ? 'eof_without_terminal'
            : 'incomplete',
      signal,
    )
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(createStreamAbortError())
    }
    readerCanceller.cleanup()
    reader.releaseLock()
  }

  const stats = getStreamStats(streamState)
  if (stats.totalChunks > 0) {
    logForDebugging(
      JSON.stringify({
        type: 'stream_stats',
        model,
        total_chunks: stats.totalChunks,
        first_token_ms: stats.firstTokenMs,
        duration_ms: stats.durationMs,
      }),
      { level: 'debug' },
    )
  }

  throwIfStreamAborted(signal)
  yield { type: 'message_stop' }
}
