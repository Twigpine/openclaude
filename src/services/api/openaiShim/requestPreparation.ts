import {
  resolveModelReasoningControl,
  resolveOpenAIShimReasoningRequestPlan,
} from '../../../utils/effort.js'
import {
  resolveModelRuntimeLimits,
  resolveOpenAIShimRuntimeContext,
} from '../../../integrations/runtimeMetadata.js'
import { compressToolHistory } from '../compressToolHistory.js'
import {
  convertAnthropicMessagesToResponsesInput,
  convertToolsToResponsesTools,
  type ShimCreateParams,
} from '../codexShim.js'
import {
  baseUrlSupportsResponsesAutoRoute,
  getGithubEndpointType,
  getLocalFastPathConfig,
  isDirectLocalOllamaEndpoint,
  isLikelyOllamaEndpoint,
  isLocalProviderUrl,
  modelRequiresResponsesApi,
  resolveProviderRequest,
} from '../providerConfig.js'
import { stableStringifyJson } from '../../../utils/stableStringify.js'
import {
  hasCerebrasApiHost,
  hasMistralApiHost,
  isGithubModelsMode,
  maybeSetNvidiaNimChatTemplateThinking,
} from './providerCompatibility.js'
import {
  getOllamaNumCtx,
  normalizeOllamaNativeMessages,
} from './ollamaAdapter.js'
import { createRequestBodyPlanner } from './requestPlanner.js'

type RawMessage = {
  role: string
  message?: { role?: string; content?: unknown }
  content?: unknown
}

type Dependencies = {
  convertMessages(
    messages: RawMessage[],
    system: unknown,
    options: {
      preserveReasoningContent?: boolean
      reasoningContentFallback?: '' | 'omit'
      preserveGeminiThoughtSignature?: boolean
      supportsImageInputs?: boolean
    },
  ): unknown
  convertSystemPrompt(system: unknown): string
  convertTools(
    tools: Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>,
    options?: { skipStrict?: boolean },
  ): unknown[]
  hasGeminiApiHost(baseUrl: string | undefined): boolean
  isGeminiMode(): boolean
  shouldPreserveGeminiThoughtSignature(
    model: string | undefined,
    baseUrl?: string,
  ): boolean
}

// Providers documented to do implicit prefix caching on OpenAI-compatible
// endpoints (see the stableStringifyJson rationale in utils/stableStringify.ts:
// OpenAI, Kimi/Moonshot, DeepSeek — plus xAI). For these, a stable request
// prefix is worth more than tool-history compression.
const PREFIX_CACHING_ROUTE_IDS = new Set([
  'openai',
  'xai',
  'deepseek',
  'moonshot',
  'kimi-code',
])
const PREFIX_CACHING_HOSTNAMES = new Set([
  'api.openai.com',
  'api.x.ai',
  'api.deepseek.com',
  'api.moonshot.ai',
  'api.moonshot.cn',
  'api.kimi.com',
])

function providerUsesImplicitPrefixCaching(
  routeId: string | null | undefined,
  baseUrl: string | undefined,
): boolean {
  if (routeId && PREFIX_CACHING_ROUTE_IDS.has(routeId)) {
    return true
  }
  if (!baseUrl) {
    return false
  }
  // Parse and compare hostnames rather than substring-matching the raw URL —
  // a path-routed gateway like https://proxy.example/api.openai.com/v1 is not
  // the provider itself and gets no implicit caching.
  try {
    return PREFIX_CACHING_HOSTNAMES.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

export function prepareOpenAIRequest({
  request,
  params,
  requestProcessEnv,
  providerOverride,
  dependencies,
}: {
  request: ReturnType<typeof resolveProviderRequest>
  params: ShimCreateParams
  requestProcessEnv: NodeJS.ProcessEnv
  providerOverride?: { model: string; baseURL: string; apiKey: string }
  dependencies: Dependencies
}) {
  const {
    convertMessages,
    convertSystemPrompt,
    convertTools,
    hasGeminiApiHost,
    isGeminiMode,
    shouldPreserveGeminiThoughtSignature,
  } = dependencies
  const fastPath = getLocalFastPathConfig(request.baseUrl)
  const rawMessages = params.messages as RawMessage[]
  const runtimeModel = request.requestedModel
  const runtimeShimContext = resolveOpenAIShimRuntimeContext({
    processEnv: requestProcessEnv,
    baseUrl: request.baseUrl,
    model: runtimeModel,
    treatAsLocal: isLocalProviderUrl(request.baseUrl),
    preferBaseUrlRoute: Boolean(providerOverride),
  })
  const runtimeLimits = resolveModelRuntimeLimits({
    model: runtimeModel,
    baseUrl: request.baseUrl,
    processEnv: requestProcessEnv,
    resolvedRouteId: runtimeShimContext.routeId,
  })
  const shimConfig = runtimeShimContext.openaiShimConfig
  const effectiveTransport = shimConfig.endpointPath === '/responses'
    ? 'responses'
    : shimConfig.endpointPath === '/messages'
      ? 'anthropic_messages'
      : shimConfig.endpointPath?.startsWith('/models/gemini-')
        ? 'gemini'
        : request.transport
  // Mirror the native-transport guard (shouldCompressNativeToolHistory):
  // compressToolHistory's window is measured from the end of the conversation,
  // so each turn rewrites tool results that were already sent verbatim. On
  // providers with implicit prefix caching that mutates the middle of the
  // request prefix and forfeits the entire cache downstream — costing far more
  // than the compression saves.
  const skipCompressionForPrefixCache = providerUsesImplicitPrefixCaching(
    runtimeShimContext.routeId,
    request.baseUrl,
  )
  const compressedMessages =
    effectiveTransport === 'chat_completions' ||
    effectiveTransport === 'responses' ||
    effectiveTransport === 'responses_compat'
      ? fastPath.skipToolHistoryCompression || skipCompressionForPrefixCache
        ? rawMessages
        : compressToolHistory(rawMessages, runtimeModel, {
          textBlockSeparator:
            effectiveTransport === 'chat_completions' ? '\n\n' : '\n',
          runtimeLimits,
        })
      : rawMessages
  const useNativeOllamaChat =
    effectiveTransport === 'chat_completions' &&
    !shimConfig.endpointPath &&
    isDirectLocalOllamaEndpoint(request.baseUrl) &&
    isLikelyOllamaEndpoint(request.baseUrl)
  const openaiMessages = effectiveTransport === 'chat_completions'
    ? convertMessages(compressedMessages, params.system, {
      preserveReasoningContent: shimConfig.preserveReasoningContent,
      reasoningContentFallback: shimConfig.reasoningContentFallback,
      preserveGeminiThoughtSignature: shouldPreserveGeminiThoughtSignature(
        request.resolvedModel,
        request.baseUrl,
      ),
      supportsImageInputs: shimConfig.supportsImageInputs,
    })
    : undefined

  const reasoningControl = resolveModelReasoningControl(runtimeModel, {
    routeId: runtimeShimContext.routeId,
    useRuntimeFallback: false,
    openaiShimConfig: shimConfig,
    baseUrl: request.baseUrl,
    processEnv: requestProcessEnv,
  })
  const suppressReasoningForForcedChat =
    effectiveTransport === 'chat_completions' &&
    Array.isArray(params.tools) &&
    params.tools.length > 0 &&
    modelRequiresResponsesApi(request.resolvedModel) &&
    baseUrlSupportsResponsesAutoRoute(request.baseUrl, requestProcessEnv)
  const reasoningRequestPlan = resolveOpenAIShimReasoningRequestPlan({
    model: runtimeModel,
    requestedEffort: suppressReasoningForForcedChat
      ? undefined
      : request.reasoning?.effort,
    requestThinkingType:
      (params.thinking as { type?: string } | undefined)?.type,
    defaultThinkingType: request.thinking?.type,
    thinkingRequestFormat: shimConfig.thinkingRequestFormat,
    routeId: runtimeShimContext.routeId ?? 'custom',
    useRuntimeFallback: false,
    reasoningControl,
  })

  const body: Record<string, unknown> = {
    model: request.resolvedModel,
    ...(openaiMessages ? { messages: openaiMessages } : {}),
    stream: params.stream ?? false,
    store: false,
  }
  if (
    reasoningRequestPlan.wireFormat === 'reasoning_effort' &&
    reasoningRequestPlan.reasoningEffort
  ) body.reasoning_effort = reasoningRequestPlan.reasoningEffort
  if (
    reasoningRequestPlan.wireFormat === 'reasoning_effort' &&
    reasoningRequestPlan.thinkingType === 'disabled'
  ) {
    body.thinking = { type: 'disabled' }
    delete body.reasoning_effort
  }

  const maxTokensValue =
    typeof params.max_tokens === 'number' && params.max_tokens > 0
      ? params.max_tokens
      : undefined
  const maxCompletionTokensValue =
    typeof (params as Record<string, unknown>).max_completion_tokens === 'number'
      ? (params as Record<string, unknown>).max_completion_tokens as number
      : undefined
  if (maxTokensValue !== undefined) body.max_completion_tokens = maxTokensValue
  else if (maxCompletionTokensValue !== undefined) {
    body.max_completion_tokens = maxCompletionTokensValue
  }
  if (params.stream) {
    body.stream_options = { include_usage: true }
  }

  const isGithub = isGithubModelsMode()
  const isLocal = isLocalProviderUrl(request.baseUrl)
  const githubEndpointType = getGithubEndpointType(request.baseUrl)
  const isGithubCopilot =
    isGithub && (githubEndpointType === 'copilot' || githubEndpointType === 'ghe')
  const isGithubModels =
    isGithub && (githubEndpointType === 'models' || githubEndpointType === 'custom')
  const shouldStripResponsesStore =
    (shimConfig.removeBodyFields ?? []).includes('store') ||
    isGeminiMode() ||
    hasGeminiApiHost(request.baseUrl) ||
    hasCerebrasApiHost(request.baseUrl) ||
    hasMistralApiHost(request.baseUrl) ||
    isLocal

  if (
    (shimConfig.maxTokensField === 'max_tokens' ||
      hasMistralApiHost(request.baseUrl)) &&
    body.max_completion_tokens !== undefined
  ) {
    body.max_tokens = body.max_completion_tokens
    delete body.max_completion_tokens
  }
  for (const field of shimConfig.removeBodyFields ?? []) delete body[field]
  if (shouldStripResponsesStore) delete body.store
  if (params.temperature !== undefined) body.temperature = params.temperature
  if (params.top_p !== undefined) body.top_p = params.top_p

  if (reasoningRequestPlan.wireFormat === 'deepseek_compatible') {
    if (reasoningRequestPlan.thinkingType) {
      body.thinking = { type: reasoningRequestPlan.thinkingType }
    }
    if (reasoningRequestPlan.reasoningEffort) {
      body.reasoning_effort = reasoningRequestPlan.reasoningEffort
    }
    maybeSetNvidiaNimChatTemplateThinking(
      body,
      request.baseUrl,
      reasoningRequestPlan,
    )
  }
  if (reasoningRequestPlan.wireFormat === 'zai_compatible') {
    if (reasoningRequestPlan.thinkingType) {
      body.thinking = { type: reasoningRequestPlan.thinkingType }
    }
    if (reasoningRequestPlan.thinkingType === 'disabled') {
      delete body.reasoning_effort
    } else if (reasoningRequestPlan.reasoningEffort) {
      body.reasoning_effort = reasoningRequestPlan.reasoningEffort
    } else {
      delete body.reasoning_effort
    }
    maybeSetNvidiaNimChatTemplateThinking(
      body,
      request.baseUrl,
      reasoningRequestPlan,
    )
  }
  for (const field of shimConfig.removeBodyFields ?? []) delete body[field]

  if (
    !(shimConfig.removeBodyFields ?? []).includes('tools') &&
    params.tools?.length
  ) {
    const converted = convertTools(params.tools as Array<{
      name: string
      description?: string
      input_schema?: Record<string, unknown>
    }>, { skipStrict: fastPath.skipStrictTools })
    if (converted.length > 0) {
      body.tools = converted
      if (
        effectiveTransport === 'chat_completions' &&
        params.stream &&
        shimConfig.enableToolStreaming === true
      ) body.tool_stream = true
      const toolChoice = params.tool_choice as {
        type?: string
        name?: string
      } | undefined
      if (toolChoice?.type === 'auto') body.tool_choice = 'auto'
      else if (toolChoice?.type === 'tool' && toolChoice.name) {
        body.tool_choice = {
          type: 'function',
          function: { name: toolChoice.name },
        }
      } else if (toolChoice?.type === 'any') body.tool_choice = 'required'
      else if (toolChoice?.type === 'none') body.tool_choice = 'none'
    }
  }

  let responsesInput: ReturnType<
    typeof convertAnthropicMessagesToResponsesInput
  > | undefined
  let responsesMessages: typeof compressedMessages | undefined
  const getResponsesInput = () => {
    responsesMessages ??= effectiveTransport === 'chat_completions'
      ? fastPath.skipToolHistoryCompression || skipCompressionForPrefixCache
        ? rawMessages
        : compressToolHistory(rawMessages, runtimeModel, {
          textBlockSeparator: '\n',
          runtimeLimits,
        })
      : compressedMessages
    responsesInput ??= convertAnthropicMessagesToResponsesInput(
      responsesMessages,
      effectiveTransport === 'responses_compat',
    )
    return responsesInput
  }
  const omitTools = { responses: false, anthropic: false, gemini: false }
  const planner = createRequestBodyPlanner({
    request,
    params,
    effectiveTransport,
    shouldStripResponsesStore,
    body,
    reasoningRequestPlan,
    shimConfig,
    getResponsesInput,
    convertSystemPrompt,
    convertToolsToResponsesTools,
    maxTokensValue,
    maxCompletionTokensValue,
    getOllamaNumCtx,
    normalizeOllamaNativeMessages,
    useNativeOllamaChat,
    fastPath,
    stableStringifyJson,
    omitTools,
  })

  return {
    fastPath,
    runtimeShimContext,
    shimConfig,
    body,
    effectiveTransport,
    useNativeOllamaChat,
    buildResponsesBody: planner.buildResponsesBody,
    serializeBody: planner.serializeBody,
    isLocal,
    isGithub,
    isGithubCopilot,
    isGithubModels,
    omitTools,
  }
}
