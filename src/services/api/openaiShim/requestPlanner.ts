export function hydrateOpenAIShimCompatibilityEnv(
  processEnv: NodeJS.ProcessEnv,
  dependencies: {
    isEnvTruthy: (value: string | undefined) => boolean
    resolveRouteCredentialValue: (input: {
      processEnv: NodeJS.ProcessEnv
      baseUrl?: string
    }) => string | undefined
  },
): void {
  if (dependencies.isEnvTruthy(processEnv.CLAUDE_CODE_USE_GEMINI)) {
    const key = processEnv.GEMINI_API_KEY ?? processEnv.GOOGLE_API_KEY
    if (key && !processEnv.OPENAI_API_KEY) processEnv.OPENAI_API_KEY = key
    return
  }
  if (dependencies.isEnvTruthy(processEnv.CLAUDE_CODE_USE_MISTRAL)) {
    if (processEnv.MISTRAL_API_KEY && !processEnv.OPENAI_API_KEY)
      processEnv.OPENAI_API_KEY = processEnv.MISTRAL_API_KEY
    return
  }
  if (dependencies.isEnvTruthy(processEnv.CLAUDE_CODE_USE_GITHUB)) {
    processEnv.OPENAI_API_KEY =
      processEnv.GITHUB_COPILOT_KEY ??
      processEnv.OPENAI_API_KEY ??
      processEnv.GITHUB_TOKEN ??
      processEnv.GH_TOKEN ??
      ''
    return
  }
  if (processEnv.BANKR_BASE_URL && !processEnv.OPENAI_BASE_URL)
    processEnv.OPENAI_BASE_URL = processEnv.BANKR_BASE_URL
  if (processEnv.BANKR_MODEL && !processEnv.OPENAI_MODEL)
    processEnv.OPENAI_MODEL = processEnv.BANKR_MODEL
  const credential = dependencies.resolveRouteCredentialValue({
    processEnv,
    baseUrl: processEnv.OPENAI_BASE_URL ?? processEnv.OPENAI_API_BASE,
  })
  if (credential && !processEnv.OPENAI_API_KEY)
    processEnv.OPENAI_API_KEY = credential
}

type RequestTransport =
  | 'responses'
  | 'responses_compat'
  | 'anthropic_messages'
  | 'gemini'
  | (string & {})

type ToolDefinition = {
  name?: string
  description?: string
  input_schema?: Record<string, unknown>
}

type ShimRequestParams = {
  messages: Array<{
    role?: string
    message?: { role?: string; content?: unknown }
    content?: unknown
  }>
  system?: unknown
  max_tokens?: number
  stream?: boolean
  temperature?: number
  top_p?: number
  tools?: ToolDefinition[]
  tool_choice?: unknown
}

type RequestBodyPlannerContext = {
  request: {
    resolvedModel: string
    reasoning?: { effort?: string }
  }
  params: ShimRequestParams
  effectiveTransport: RequestTransport
  shouldStripResponsesStore: boolean
  body: Record<string, unknown>
  reasoningRequestPlan: {
    wireFormat?: string
    reasoningEffort?: string
  }
  shimConfig: { removeBodyFields?: string[] }
  getResponsesInput: () => unknown
  convertSystemPrompt: (system: unknown) => string
  convertToolsToResponsesTools: (
    tools: ToolDefinition[],
  ) => Array<Record<string, unknown>>
  maxTokensValue?: number
  maxCompletionTokensValue?: number
  getOllamaNumCtx: () => number
  normalizeOllamaNativeMessages: (messages: unknown) => unknown
  useNativeOllamaChat: boolean
  fastPath: { skipStableStringify: boolean }
  stableStringifyJson: (value: unknown) => string
  omitTools: {
    responses: boolean
    anthropic: boolean
    gemini: boolean
  }
}

export function createRequestBodyPlanner(context: RequestBodyPlannerContext) {
  const {
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
  } = context
  const buildResponsesBody = (): Record<string, unknown> => {
    const responsesBody: Record<string, unknown> = {
      model: request.resolvedModel,
      input: getResponsesInput(),
      stream: params.stream ?? false,
      store: false,
    }

    if (shouldStripResponsesStore) {
      delete responsesBody.store
    }

    if (
      !Array.isArray(responsesBody.input) ||
      responsesBody.input.length === 0
    ) {
      responsesBody.input = [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type:
                effectiveTransport === 'responses_compat'
                  ? 'text'
                  : 'input_text',
              text: '',
            },
          ],
        },
      ]
    }

    const systemText = convertSystemPrompt(params.system)
    if (systemText) {
      responsesBody.instructions = systemText
    }

    if (body.max_tokens !== undefined) {
      responsesBody.max_output_tokens = body.max_tokens
    } else if (body.max_completion_tokens !== undefined) {
      responsesBody.max_output_tokens = body.max_completion_tokens
    }

    if (params.temperature !== undefined)
      responsesBody.temperature = params.temperature
    if (params.top_p !== undefined) responsesBody.top_p = params.top_p
    if (
      reasoningRequestPlan.wireFormat === 'reasoning_effort' &&
      reasoningRequestPlan.reasoningEffort
    ) {
      responsesBody.reasoning = {
        effort: reasoningRequestPlan.reasoningEffort,
        summary: 'auto',
      }
      responsesBody.include = ['reasoning.encrypted_content']
    }

    if (!omitTools.responses && params.tools && params.tools.length > 0) {
      const convertedTools = convertToolsToResponsesTools(params.tools)
      if (convertedTools.length > 0) {
        responsesBody.tools = convertedTools
      }
    }

    for (const field of shimConfig.removeBodyFields ?? []) {
      delete responsesBody[field]
    }

    return responsesBody
  }

  // Anthropic Messages API body — used when endpointPath is /messages.
  // params.messages, params.tools, etc. are already in Anthropic format
  // (they originate from the Anthropic SDK). We pass them through directly,
  // only adding the top-level system (as string or content-block array)
  // and max_tokens.
  const buildAnthropicMessagesBody = (): Record<string, unknown> => {
    const anthropicBody: Record<string, unknown> = {
      model: request.resolvedModel,
      messages: params.messages,
      max_tokens: params.max_tokens,
      stream: params.stream ?? false,
    }

    // Pass system through in native format. The Anthropic Messages API
    // accepts either a string or an array of content blocks (with optional
    // cache_control markers). Only filter the billing header block.
    if (Array.isArray(params.system)) {
      const filtered = (
        params.system as Array<{ type?: string; text?: string }>
      ).filter(
        (block) =>
          !(
            block.type === 'text' &&
            (block.text ?? '').startsWith('x-anthropic-billing-header')
          ),
      )
      if (filtered.length > 0) anthropicBody.system = filtered
    } else if (params.system) {
      const text =
        typeof params.system === 'string'
          ? params.system
          : String(params.system)
      if (text && !text.startsWith('x-anthropic-billing-header'))
        anthropicBody.system = text
    }

    if (!omitTools.anthropic && params.tools && params.tools.length > 0) {
      anthropicBody.tools = params.tools
    }
    if (!omitTools.anthropic && params.tool_choice) {
      anthropicBody.tool_choice = params.tool_choice
    }

    if (request.reasoning?.effort) {
      // Shim receives OpenAI effort levels (xhigh) from client.ts, but
      // Anthropic API expects 'max' not 'xhigh'. Convert for the effort field.
      const effort =
        request.reasoning.effort === 'xhigh' ? 'max' : request.reasoning.effort
      const modelLower = request.resolvedModel.toLowerCase()
      const isAdaptive =
        modelLower.includes('opus-4-7') ||
        modelLower.includes('opus-4-6') ||
        modelLower.includes('opus-4-8') ||
        modelLower.includes('opus-4.6') ||
        modelLower.includes('opus-4.7') ||
        modelLower.includes('opus-4.8') ||
        modelLower.includes('sonnet-4-6') ||
        modelLower.includes('sonnet-4.6')
      const isOpus45 =
        modelLower.includes('opus-4-5') || modelLower.includes('opus-4.5')

      if (isAdaptive) {
        anthropicBody.thinking = { type: 'adaptive' }
        anthropicBody.effort = effort
      } else if (isOpus45) {
        anthropicBody.effort = effort
      } else if (effort === 'high' || effort === 'max') {
        anthropicBody.thinking = {
          type: 'enabled',
          budgetTokens: effort === 'max' ? 31_999 : 16_000,
        }
      }
    }

    return anthropicBody
  }

  // Google AI SDK body — used when endpointPath is /models/gemini-*.
  // Converts Anthropic-format params to Google AI SDK format.
  const buildGeminiBody = (): Record<string, unknown> => {
    const contents: Array<{
      role: string
      parts: Array<Record<string, unknown>>
    }> = []

    // Build a lookup from tool_use_id → function name so tool_result
    // blocks can emit the correct functionResponse.name (Gemini requires
    // the function name, not the Anthropic tool_use_id).
    const toolUseIdToName = new Map<string, string>()
    const messages = params.messages as Array<{
      role?: string
      content?: unknown
    }>
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content as Array<{
        type?: string
        id?: string
        name?: string
      }>) {
        if (block.type === 'tool_use' && block.id && block.name) {
          toolUseIdToName.set(block.id, block.name)
        }
      }
    }

    for (const msg of messages) {
      const role = msg.role === 'assistant' ? 'model' : 'user'
      const parts: Array<Record<string, unknown>> = []

      if (typeof msg.content === 'string') {
        parts.push({ text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{
          type?: string
          text?: string
          id?: string
          name?: string
          input?: unknown
          tool_use_id?: string
          content?: unknown
          is_error?: boolean
        }>) {
          if (block.type === 'text' && block.text) {
            parts.push({ text: block.text })
          } else if (block.type === 'tool_use' && block.id && block.name) {
            parts.push({
              functionCall: {
                name: block.name,
                args: block.input ?? {},
              },
            })
          } else if (block.type === 'tool_result' && block.tool_use_id) {
            const funcName =
              toolUseIdToName.get(block.tool_use_id) ?? block.tool_use_id
            let resultContent =
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as Array<{ type?: string; text?: string }>)
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text ?? '')
                      .join('\n')
                  : ''
            if (block.is_error) {
              resultContent = `Error: ${resultContent}`
            }
            parts.push({
              functionResponse: {
                name: funcName,
                response: {
                  name: funcName,
                  content: resultContent,
                },
              },
            })
          }
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts })
      }
    }

    const geminiBody: Record<string, unknown> = { contents }

    // System instruction
    const systemText = convertSystemPrompt(params.system)
    if (systemText) {
      geminiBody.systemInstruction = { parts: [{ text: systemText }] }
    }

    // Generation config
    const genConfig: Record<string, unknown> = {}
    if (params.max_tokens !== undefined) {
      genConfig.maxOutputTokens = params.max_tokens
    } else if (maxTokensValue !== undefined) {
      genConfig.maxOutputTokens = maxTokensValue
    } else if (maxCompletionTokensValue !== undefined) {
      genConfig.maxOutputTokens = maxCompletionTokensValue
    }
    if (params.temperature !== undefined)
      genConfig.temperature = params.temperature
    if (params.top_p !== undefined) genConfig.topP = params.top_p
    if (request.reasoning?.effort) {
      const level =
        request.reasoning.effort === 'xhigh' ? 'high' : request.reasoning.effort
      genConfig.thinkingConfig = {
        includeThoughts: true,
        thinkingLevel: level,
      }
    }
    if (Object.keys(genConfig).length > 0) {
      geminiBody.generationConfig = genConfig
    }

    // Tools — convert Anthropic tool format to Google functionDeclarations
    if (!omitTools.gemini && params.tools && params.tools.length > 0) {
      const functionDeclarations = (
        params.tools as Array<{
          name?: string
          description?: string
          input_schema?: Record<string, unknown>
        }>
      ).map((tool) => ({
        name: tool.name ?? '',
        description: tool.description ?? '',
        ...(tool.input_schema ? { parameters: tool.input_schema } : {}),
      }))
      if (functionDeclarations.length > 0) {
        geminiBody.tools = [{ functionDeclarations }]
      }
    }

    return geminiBody
  }

  const buildOllamaChatBody = (): Record<string, unknown> => {
    const options: Record<string, unknown> = {
      num_ctx: getOllamaNumCtx(),
    }
    if (body.max_tokens !== undefined) {
      options.num_predict = body.max_tokens
    } else if (body.max_completion_tokens !== undefined) {
      options.num_predict = body.max_completion_tokens
    }
    if (params.temperature !== undefined)
      options.temperature = params.temperature
    if (params.top_p !== undefined) options.top_p = params.top_p

    return {
      model: request.resolvedModel,
      messages: normalizeOllamaNativeMessages(body.messages),
      stream: params.stream ?? false,
      options,
      ...(body.tools ? { tools: body.tools } : {}),
    }
  }

  const serializeBody = (): string => {
    const payload = useNativeOllamaChat
      ? buildOllamaChatBody()
      : effectiveTransport === 'responses' ||
          effectiveTransport === 'responses_compat'
        ? buildResponsesBody()
        : effectiveTransport === 'anthropic_messages'
          ? buildAnthropicMessagesBody()
          : effectiveTransport === 'gemini'
            ? buildGeminiBody()
            : body
    // Byte-identical serialization preserves implicit prefix caching for
    // OpenAI/Kimi/DeepSeek. Local backends can opt out of the key sort.
    return fastPath.skipStableStringify
      ? JSON.stringify(payload)
      : stableStringifyJson(payload)
  }
  return {
    buildResponsesBody,
    buildAnthropicMessagesBody,
    buildGeminiBody,
    buildOllamaChatBody,
    serializeBody,
    omitTools,
  }
}
