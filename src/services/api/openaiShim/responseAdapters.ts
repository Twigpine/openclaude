import { logForDebugging } from '../../../utils/debug.js'
import { buildAnthropicUsageFromRawUsage } from '../cacheMetrics.js'
import {
  type AnthropicStreamEvent,
} from '../codexShim.js'
import { normalizeToolArguments } from '../toolArgumentNormalization.js'
import { stripThinkTags } from '../thinkTagSanitizer.js'
import {
  geminiThoughtSignatureFromExtraContent,
  mergeGeminiThoughtSignature,
} from './providerCompatibility.js'
import {
  couldBeRawToolCallsRequestedPrefix,
  parseRawToolCallsRequestedText,
  parseTextToolCalls as parseTextToolCallsModule,
  repairPossiblyTruncatedObjectJson,
  stripRanges,
  type ParsedTextToolCall,
} from './rawToolCallParsing.js'
import {
  convertNonStreamingResponseToAnthropicMessage as convertResponseToAnthropicMessage,
  type NonStreamingOpenAIResponse,
} from './responseConversion.js'
import { openaiStreamToAnthropic as convertOpenAIStream } from './streamConversion.js'
import { stripMarkerEchoesFromStream } from './markerEchoGuard.js'
import { geminiSseToAnthropic as convertGeminiStream } from './geminiStreamConversion.js'
import {
  anthropicSsePassthrough as parseAnthropicSsePassthrough,
  createProviderStreamTrace,
  createReaderCanceller,
  createStreamAbortError,
  getStreamIdleTimeoutMs,
  readWithIdleTimeout,
  throwIfStreamAborted,
} from './streamControl.js'
import {
  findXmlToolCallOpener as findXmlToolCallOpenerModule,
  isHy3Model as isHy3ModelModule,
  parseXmlToolCalls as parseXmlToolCallsModule,
  trailingXmlOpenerPrefixLen as trailingXmlOpenerPrefixLenModule,
} from './xmlToolCallParsing.js'

export function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

// Raw-text and XML fallbacks share one sequence so their generated IDs cannot
// collide when both syntaxes occur during the same process lifetime.
let textToolCallSequence = 0

function nextTextToolCallSequence(): number {
  return ++textToolCallSequence
}

export function parseTextToolCalls(text: string): {
  calls: ParsedTextToolCall[]
  toolCallRanges: Array<[number, number]>
} {
  return parseTextToolCallsModule(text, nextTextToolCallSequence)
}

function findXmlToolCallOpener(text: string, allowHy3: boolean): number {
  return findXmlToolCallOpenerModule(text, allowHy3)
}

function isHy3Model(model: string): boolean {
  return isHy3ModelModule(model)
}

export function parseXmlToolCalls(text: string, allowHy3 = false) {
  return parseXmlToolCallsModule(text, allowHy3, nextTextToolCallSequence)
}

function trailingXmlOpenerPrefixLen(text: string, allowHy3: boolean): number {
  return trailingXmlOpenerPrefixLenModule(text, allowHy3)
}

export async function* anthropicSsePassthrough(
  response: Response,
  _model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  yield* parseAnthropicSsePassthrough<AnthropicStreamEvent>(
    response,
    signal,
    (message, options) => options?.level
      ? logForDebugging(message, { level: options.level })
      : logForDebugging(message),
  )
}

export async function* geminiSseToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  yield* convertGeminiStream(response, model, signal, {
    createProviderStreamTrace,
    createReaderCanceller,
    createStreamAbortError,
    getStreamIdleTimeoutMs,
    makeMessageId,
    readWithIdleTimeout,
    throwIfStreamAborted,
  })
}

export function convertNonStreamingResponseToAnthropicMessage(
  data: NonStreamingOpenAIResponse,
  model: string,
) {
  return convertResponseToAnthropicMessage(data, model, {
    makeMessageId,
    buildUsage: usage => buildAnthropicUsageFromRawUsage(usage),
    stripThinkTags,
    parseXmlToolCalls,
    isHy3Model,
    stripRanges,
    parseRawToolCalls: parseRawToolCallsRequestedText,
    normalizeToolArguments,
    getGeminiThoughtSignature: geminiThoughtSignatureFromExtraContent,
    mergeGeminiThoughtSignature,
  })
}

export async function* openaiStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
  isOllama = false,
  requestUrl?: string,
  headersWithRequestUrl?: (headers: Headers, requestUrl?: string) => Headers,
): AsyncGenerator<AnthropicStreamEvent> {
  yield* stripMarkerEchoesFromStream(
    convertOpenAIStream(response, model, signal, isOllama, requestUrl, {
      convertNonStreamingResponseToAnthropicMessage: (data, streamModel) =>
        convertNonStreamingResponseToAnthropicMessage(
          data as NonStreamingOpenAIResponse,
          streamModel,
        ),
      couldBeRawToolCallsRequestedPrefix,
      createProviderStreamTrace,
      createReaderCanceller,
      createStreamAbortError,
      findXmlToolCallOpener,
      geminiThoughtSignatureFromExtraContent,
      getStreamIdleTimeoutMs,
      headersWithRequestUrl: headersWithRequestUrl ?? ((headers) => headers),
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
    }),
  )
}

export function convertGeminiToAnthropicResponse(
  data: Record<string, unknown>,
  model: string,
) {
  const content: Array<Record<string, unknown>> = []
  let hasToolUse = false
  const candidates = data.candidates as Array<Record<string, unknown>> | undefined
  const candidate = candidates?.[0]
  const candidateContent = candidate?.content as {
    parts?: Array<Record<string, unknown>>
  } | undefined

  for (const part of candidateContent?.parts ?? []) {
    const text = part.text as string | undefined
    if (text) content.push({ type: 'text', text })
    const functionCall = part.functionCall as {
      name?: string
      args?: unknown
    } | undefined
    if (functionCall?.name) {
      hasToolUse = true
      content.push({
        type: 'tool_use',
        id: `toolu_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
        name: functionCall.name,
        input: functionCall.args ?? {},
      })
    }
  }

  const usageMetadata = data.usageMetadata as Record<string, number> | undefined
  return {
    id: makeMessageId(),
    type: 'message',
    role: 'assistant',
    content,
    model,
    stop_reason: hasToolUse
      ? 'tool_use'
      : candidate?.finishReason === 'MAX_TOKENS'
        ? 'max_tokens'
        : 'end_turn',
    stop_sequence: null,
    usage: buildAnthropicUsageFromRawUsage({
      input_tokens: usageMetadata?.promptTokenCount ?? 0,
      output_tokens:
        (usageMetadata?.candidatesTokenCount ?? 0) +
        (usageMetadata?.thoughtsTokenCount ?? 0),
    } as unknown as Record<string, unknown>),
  }
}
