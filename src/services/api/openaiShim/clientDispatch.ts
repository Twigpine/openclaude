import { APIError } from '@anthropic-ai/sdk'
import { createCombinedAbortSignal } from '../../../utils/combinedAbortSignal.js'
import {
  registerInterruptionController,
  registerInterruptionSignal,
  requestAbort,
} from '../../../utils/interruptionTrace.js'
import type { AnthropicStreamEvent, ShimCreateParams } from '../codexShim.js'
import {
  isLikelyOllamaEndpoint,
  resolveProviderRequest,
  type ResolvedProviderRequest,
} from '../providerConfig.js'

type CreateOptions = {
  signal?: AbortSignal
  headers?: Record<string, string>
}

type ProviderOverride = {
  model: string
  baseURL: string
  apiKey: string
}

type StreamConverter = (
  response: Response,
  model: string,
  signal?: AbortSignal,
) => AsyncGenerator<AnthropicStreamEvent>

type OpenAIStreamConverter = (
  response: Response,
  model: string,
  signal?: AbortSignal,
  isOllama?: boolean,
  requestUrl?: string,
) => AsyncGenerator<AnthropicStreamEvent>

export type ClientDispatchDependencies = {
  processEnv?: NodeJS.ProcessEnv
  providerOverride?: ProviderOverride
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  doRequest(
    request: ResolvedProviderRequest,
    params: ShimCreateParams,
    options?: CreateOptions,
    processEnv?: NodeJS.ProcessEnv,
  ): Promise<Response>
  convertNonStreamingResponse(data: unknown, model: string): unknown
  convertGeminiResponse(data: unknown, model: string): unknown
  codexStreamToAnthropic: typeof import('../codexShim.js').codexStreamToAnthropic
  collectCodexCompletedResponse: typeof import('../codexShim.js').collectCodexCompletedResponse
  convertCodexResponseToAnthropicMessage: typeof import('../codexShim.js').convertCodexResponseToAnthropicMessage
  createStreamAbortError(): DOMException
  anthropicSsePassthrough: StreamConverter
  geminiSseToAnthropic: StreamConverter
  openaiStreamToAnthropic: OpenAIStreamConverter
  isGithubModelsMode(): boolean
  makeMessageId(): string
}

type ShimResponse = {
  data: unknown
  response: Response
  request_id: string
}

export type ShimRequestPromise = Promise<unknown> & {
  withResponse(): Promise<ShimResponse>
}

export function headersWithRequestUrl(
  headers: Headers,
  requestUrl?: string,
): Headers {
  const next = new Headers(headers)
  if (requestUrl) next.set('x-opencode-request-url', requestUrl)
  return next
}

export class OpenAIShimStream implements AsyncIterable<AnthropicStreamEvent> {
  private makeGenerator: (signal: AbortSignal) => AsyncGenerator<AnthropicStreamEvent>
  private parentSignal?: AbortSignal
  private generator?: AsyncGenerator<AnthropicStreamEvent>
  private cleanupCombinedSignal?: () => void
  private cleanupPreIterationAbort?: () => void
  // The controller property is checked by claude.ts to distinguish streams from error messages
  controller = new AbortController()

  constructor(
    makeGenerator: (signal: AbortSignal) => AsyncGenerator<AnthropicStreamEvent>,
    parentSignal?: AbortSignal,
    cancelBeforeIteration?: () => void,
  ) {
    this.makeGenerator = makeGenerator
    this.parentSignal = parentSignal
    const parentId = parentSignal
      ? registerInterruptionSignal(parentSignal, {
          subsystem: 'openai_shim_dispatch',
          controllerRole: 'combined-parent',
        })
      : undefined
    registerInterruptionController(this.controller, {
      subsystem: 'openai_shim_dispatch',
      controllerRole: 'stream-controller',
      ...(parentId && { parentControllerIds: [parentId] }),
    })

    if (cancelBeforeIteration) {
      let cleaned = false
      let cancelled = false
      let onAbort: () => void = () => {}
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        this.controller.signal.removeEventListener('abort', onAbort)
        parentSignal?.removeEventListener('abort', onAbort)
      }
      onAbort = () => {
        if (!this.generator && !cancelled) {
          cancelled = true
          cancelBeforeIteration()
        }
        cleanup()
      }

      this.controller.signal.addEventListener('abort', onAbort, { once: true })
      parentSignal?.addEventListener('abort', onAbort, { once: true })
      this.cleanupPreIterationAbort = cleanup

      if (this.controller.signal.aborted || parentSignal?.aborted) {
        onAbort()
      }
    }
  }

  private getGenerator(): AsyncGenerator<AnthropicStreamEvent> {
    if (this.generator) {
      return this.generator
    }

    this.cleanupPreIterationAbort?.()
    this.cleanupPreIterationAbort = undefined

    const combined = createCombinedAbortSignal(this.parentSignal, {
      signalB: this.controller.signal,
      trace: {
        subsystem: 'openai_shim_dispatch',
        controllerRole: 'stream-combined',
      },
    })
    this.cleanupCombinedSignal = combined.cleanup
    this.generator = this.makeGenerator(combined.signal)
    return this.generator
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AnthropicStreamEvent> {
    const generator = this.getGenerator()
    let completed = false
    let failed = false
    try {
      yield* generator
      completed = true
    } catch (error) {
      failed = true
      throw error
    } finally {
      if (!completed && !failed && !this.controller.signal.aborted) {
        requestAbort(this.controller, undefined, {
          source: 'iterator_closed',
          subsystem: 'openai_shim_dispatch',
          controllerRole: 'stream-controller',
        })
      }
      this.cleanupCombinedSignal?.()
      this.cleanupCombinedSignal = undefined
      this.cleanupPreIterationAbort?.()
      this.cleanupPreIterationAbort = undefined
      if (!completed) {
        void generator.return?.(undefined as never).catch(() => {})
      }
    }
  }
}

function selectStreamConverter(
  request: ResolvedProviderRequest,
  response: Response,
  dependencies: Pick<
    ClientDispatchDependencies,
    | 'anthropicSsePassthrough'
    | 'codexStreamToAnthropic'
    | 'geminiSseToAnthropic'
    | 'openaiStreamToAnthropic'
  >,
): (signal: AbortSignal) => AsyncGenerator<AnthropicStreamEvent> {
  const isResponsesStream = response.url?.includes('/responses')
  const isMessagesStream = response.url?.includes('/messages')
  const isGeminiStream = response.url?.includes('/models/gemini-')

  if (
    request.transport === 'codex_responses' ||
    request.transport === 'responses' ||
    isResponsesStream
  ) {
    return signal => dependencies.codexStreamToAnthropic(
      response,
      request.resolvedModel,
      signal,
    )
  }
  if (isMessagesStream) {
    return signal => dependencies.anthropicSsePassthrough(
      response,
      request.resolvedModel,
      signal,
    )
  }
  if (isGeminiStream) {
    return signal => dependencies.geminiSseToAnthropic(
      response,
      request.resolvedModel,
      signal,
    )
  }
  return signal => dependencies.openaiStreamToAnthropic(
    response,
    request.resolvedModel,
    signal,
    isLikelyOllamaEndpoint(request.baseUrl),
    response.url || undefined,
  )
}

export function createShimRequest(
  params: ShimCreateParams,
  options: CreateOptions | undefined,
  dependencies: ClientDispatchDependencies,
): ShimRequestPromise {
  const {
    anthropicSsePassthrough,
    codexStreamToAnthropic,
    collectCodexCompletedResponse,
    convertCodexResponseToAnthropicMessage,
    convertGeminiResponse,
    convertNonStreamingResponse,
    createStreamAbortError,
    doRequest,
    geminiSseToAnthropic,
    isGithubModelsMode,
    makeMessageId,
    openaiStreamToAnthropic,
    providerOverride,
    processEnv,
    reasoningEffort,
  } = dependencies

    let httpResponse: Response | undefined

    const promise = (async (): Promise<unknown> => {
      const request = resolveProviderRequest({
        model: providerOverride?.model ?? params.model,
        baseUrl: providerOverride?.baseURL,
        reasoningEffortOverride: reasoningEffort,
        processEnv,
      })
      const response = await doRequest(request, params, options, processEnv)
      httpResponse = response

      if (params.stream) {
        const cancelBeforeIteration = () => {
          void response.body?.cancel(createStreamAbortError()).catch(() => {})
        }
        return new OpenAIShimStream(
          selectStreamConverter(request, response, {
            anthropicSsePassthrough,
            codexStreamToAnthropic,
            geminiSseToAnthropic,
            openaiStreamToAnthropic,
          }),
          options?.signal,
          cancelBeforeIteration,
        )
      }

      if (request.transport === 'codex_responses') {
        const data = await collectCodexCompletedResponse(response, options?.signal)
        return convertCodexResponseToAnthropicMessage(
          data,
          request.resolvedModel,
        )
      }

      const isResponsesNonStream = response.url?.includes('/responses')
      const isMessagesNonStream = response.url?.includes('/messages')
      const isGeminiNonStream = response.url?.includes('/models/gemini-')
      if (
        request.transport === 'responses' ||
        isResponsesNonStream ||
        (request.transport === 'chat_completions' && isGithubModelsMode())
      ) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const parsed = await response.json() as Record<string, unknown>
          if (
            parsed &&
            typeof parsed === 'object' &&
            ('output' in parsed || 'incomplete_details' in parsed)
          ) {
            return convertCodexResponseToAnthropicMessage(
              parsed,
              request.resolvedModel,
            )
          }
          return convertNonStreamingResponse(parsed, request.resolvedModel)
        }
      }

      // Anthropic Messages API response — already in Anthropic format,
      // pass through directly without conversion.
      if (isMessagesNonStream) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          return await response.json() as Record<string, unknown>
        }
      }

      // Google AI SDK response — convert to Anthropic format
      if (isGeminiNonStream) {
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('application/json')) {
          const parsed = await response.json() as Record<string, unknown>
          return convertGeminiResponse(parsed, request.resolvedModel)
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.includes('application/json')) {
        const data = await response.json()
        return convertNonStreamingResponse(data, request.resolvedModel)
      }

      await response.text().catch(() => '')
      throw APIError.generate(
        response.status,
        undefined,
        `OpenAI API error ${response.status}: unexpected response content-type: ${response.headers.get('content-type') ?? 'unknown'}`,
        response.headers as unknown as Headers,
      )
    })() as ShimRequestPromise

      ; (promise as unknown as Record<string, unknown>).withResponse =
        async () => {
          const data = await promise
          return {
            data,
            response: httpResponse ?? new Response(),
            request_id:
              httpResponse?.headers.get('x-request-id') ?? makeMessageId(),
          }
        }

    return promise
}
